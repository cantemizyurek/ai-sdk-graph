import { InMemoryStorage } from './storage'
import type { GraphSDK } from './types'
import { createUIMessageStream } from 'ai'
import type { Graph } from './graph'
import { composeMiddleware } from './middleware'

const BUILT_IN_NODES = {
  START: 'START',
  END: 'END',
} as const

type SuspenseStrategy = 'return' | 'throw'

export class SuspenseError extends Error {
  readonly data?: unknown

  constructor(data?: unknown) {
    super('Suspense')
    this.name = 'SuspenseError'
    this.data = data
  }
}

const nullWriter: GraphSDK.Writer = {
  write() { },
  merge() { }
} as unknown as GraphSDK.Writer

function composeEventMiddleware<
  State extends Record<string, unknown>,
  NodeKeys extends string
>(
  middlewares: GraphSDK.EventMiddleware<State, NodeKeys>[],
  terminal: (event: GraphSDK.GraphEvent<State, NodeKeys>) => void
): (event: GraphSDK.GraphEvent<State, NodeKeys>) => void {
  return (event) => {
    function dispatch(i: number): void {
      if (i === middlewares.length) {
        terminal(event)
        return
      }
      middlewares[i]!(event, () => dispatch(i + 1))
    }
    dispatch(0)
  }
}

export class CompiledGraph<
  State extends Record<string, unknown>,
  NodeKeys extends string = 'START' | 'END'
> {
  private readonly nodeRegistry: ReadonlyMap<NodeKeys, GraphSDK.Node<State, NodeKeys>>
  private readonly edgeRegistry: ReadonlyMap<NodeKeys, GraphSDK.Edge<State, NodeKeys>[]>
  private readonly subgraphRegistry: ReadonlyMap<
    NodeKeys,
    {
      subgraph: Graph<any, any>
      options: GraphSDK.SubgraphOptions<State, any>
    }
  >
  private readonly storage: GraphSDK.GraphStorage<State, NodeKeys>
  private readonly stateManager = new StateManager<State>()
  private readonly graphMiddleware: GraphSDK.GraphMiddleware<State, NodeKeys>[]
  private readonly nodeMiddleware: GraphSDK.NodeMiddleware<State, NodeKeys>[]
  private readonly stateMiddleware: GraphSDK.StateMiddleware<State, NodeKeys>[]
  private readonly eventMiddleware: GraphSDK.EventMiddleware<State, NodeKeys>[]

  constructor(
    nodeRegistry: ReadonlyMap<NodeKeys, GraphSDK.Node<State, NodeKeys>>,
    edgeRegistry: ReadonlyMap<NodeKeys, GraphSDK.Edge<State, NodeKeys>[]>,
    subgraphRegistry: ReadonlyMap<
      NodeKeys,
      {
        subgraph: Graph<any, any>
        options: GraphSDK.SubgraphOptions<State, any>
      }
    >,
    options: GraphSDK.CompileOptions<State, NodeKeys> = {},
    graphMiddleware: GraphSDK.GraphMiddleware<State, NodeKeys>[] = [],
    nodeMiddleware: GraphSDK.NodeMiddleware<State, NodeKeys>[] = [],
    stateMiddleware: GraphSDK.StateMiddleware<State, NodeKeys>[] = [],
    eventMiddleware: GraphSDK.EventMiddleware<State, NodeKeys>[] = []
  ) {
    this.nodeRegistry = nodeRegistry
    this.edgeRegistry = edgeRegistry
    this.subgraphRegistry = subgraphRegistry
    this.storage = options.storage ?? new InMemoryStorage()
    this.graphMiddleware = graphMiddleware
    this.nodeMiddleware = nodeMiddleware
    this.stateMiddleware = stateMiddleware
    this.eventMiddleware = eventMiddleware
  }

  stream(
    runId: string,
    initialState: State | ((state: State | undefined) => State)
  ) {
    let context: GraphSDK.ExecutionContext<State, NodeKeys> | undefined
    return createUIMessageStream({
      execute: async ({ writer }) => {
        const emit = composeEventMiddleware<State, NodeKeys>(
          this.eventMiddleware,
          (event) => {
            switch (event.type) {
              case 'state':
                writer.write({ type: 'data-state', data: event.state }); break
              case 'node:start':
                writer.write({ type: 'data-node-start', data: event.nodeId }); break
              case 'node:end':
                writer.write({ type: 'data-node-end', data: event.nodeId }); break
              case 'node:suspense':
                writer.write({ type: 'data-node-suspense', data: { nodeId: event.nodeId, data: event.data } }); break
            }
          }
        )

        const result = await this.createExecutionContext(runId, initialState, emit, writer)
        context = result.context
        const firstTime = result.firstTime

        if (this.graphMiddleware.length > 0) {
          const graphCtx: GraphSDK.GraphMiddlewareContext<State, NodeKeys> = {
            runId: context.runId,
            state: () => context!.state,
            writer: context.writer,
            isResume: !firstTime
          }
          await composeMiddleware(
            this.graphMiddleware,
            async () => { await this.runExecutionLoop(context!) }
          )(graphCtx)
        } else {
          await this.runExecutionLoop(context)
        }
      }
    })
  }

  async execute(
    runId: string,
    initialState: State | ((state: State | undefined) => State),
    options?: { onEvent?: (event: GraphSDK.GraphEvent<State, NodeKeys>) => void }
  ): Promise<State> {
    const emit = composeEventMiddleware<State, NodeKeys>(
      this.eventMiddleware,
      options?.onEvent ?? (() => { })
    )
    const { context, firstTime } = await this.createExecutionContext(runId, initialState, emit, nullWriter)

    if (this.graphMiddleware.length > 0) {
      const graphCtx: GraphSDK.GraphMiddlewareContext<State, NodeKeys> = {
        runId: context.runId,
        state: () => context.state,
        writer: context.writer,
        isResume: !firstTime
      }
      await composeMiddleware(
        this.graphMiddleware,
        async () => { await this.runExecutionLoop(context) }
      )(graphCtx)
    } else {
      await this.runExecutionLoop(context)
    }

    return context.state
  }

  async executeInternal(
    runId: string,
    initialState: State,
    writer: GraphSDK.Writer,
    emit: (event: GraphSDK.GraphEvent<State, NodeKeys>) => void
  ): Promise<State> {
    const { context } = await this.createExecutionContext(runId, initialState, emit, writer)
    await this.runExecutionLoopInternal(context)
    return context.state
  }

  private async createExecutionContext(
    runId: string,
    initialState: State | ((state: State | undefined) => State),
    emit: (event: GraphSDK.GraphEvent<State, NodeKeys>) => void,
    writer: GraphSDK.Writer
  ): Promise<{ context: GraphSDK.ExecutionContext<State, NodeKeys>, firstTime: boolean }> {
    const { context, firstTime } = await this.restoreCheckpoint(runId, initialState, emit)
    return { context: { ...context, runId, writer, emit }, firstTime }
  }

  private async runExecutionLoop(context: GraphSDK.ExecutionContext<State, NodeKeys>): Promise<void> {
    await this.executeWithStrategy(context, 'return')
  }

  private async runExecutionLoopInternal(context: GraphSDK.ExecutionContext<State, NodeKeys>): Promise<void> {
    await this.executeWithStrategy(context, 'throw')
  }

  private async executeWithStrategy(
    context: GraphSDK.ExecutionContext<State, NodeKeys>,
    strategy: SuspenseStrategy
  ): Promise<void> {
    if (this.hasSuspendedNodes(context)) {
      const shouldContinue = await this.resumeWithStrategy(context, strategy)
      if (!shouldContinue) return
    }

    await this.executeNodesWithStrategy(context, strategy)
  }

  private async resumeWithStrategy(
    context: GraphSDK.ExecutionContext<State, NodeKeys>,
    strategy: SuspenseStrategy
  ): Promise<boolean> {
    const suspenses = await this.executeBatch(context.suspendedNodes, context)
    return this.handleBatchResultWithStrategy(context, suspenses, strategy)
  }

  private async executeNodesWithStrategy(
    context: GraphSDK.ExecutionContext<State, NodeKeys>,
    strategy: SuspenseStrategy
  ): Promise<void> {
    while (this.hasNodesToExecute(context)) {
      const suspenses = await this.executeBatch(context.currentNodes, context)
      const shouldContinue = await this.handleBatchResultWithStrategy(context, suspenses, strategy)
      if (!shouldContinue) return
    }

    await this.storage.delete(context.runId)
  }

  private async handleBatchResultWithStrategy(
    context: GraphSDK.ExecutionContext<State, NodeKeys>,
    suspenses: Array<{ node: GraphSDK.Node<State, NodeKeys>; error: SuspenseError }>,
    strategy: SuspenseStrategy
  ): Promise<boolean> {
    if (suspenses.length > 0) {
      context.suspendedNodes = suspenses.map((s) => s.node)
      await this.persistCheckpoint(context)

      if (strategy === 'throw') {
        throw new SuspenseError({ type: 'subgraph-suspended' })
      }
      return false
    }

    context.currentNodes = this.computeNextNodes(context.currentNodes, context.state)
    context.suspendedNodes = []
    await this.persistCheckpoint(context)
    return true
  }

  private hasSuspendedNodes(context: GraphSDK.ExecutionContext<State, NodeKeys>): boolean {
    return context.suspendedNodes.length > 0
  }

  private hasNodesToExecute(context: GraphSDK.ExecutionContext<State, NodeKeys>): boolean {
    return context.currentNodes.length > 0
  }

  private async restoreCheckpoint(
    runId: string,
    initialState: State | ((state: State | undefined) => State),
    emit: (event: GraphSDK.GraphEvent<State, NodeKeys>) => void
  ): Promise<{ context: Omit<GraphSDK.ExecutionContext<State, NodeKeys>, 'runId' | 'writer' | 'emit'>, firstTime: boolean }> {
    const checkpoint = await this.storage.load(runId)

    if (this.isValidCheckpoint(checkpoint)) {
      return { context: this.restoreFromCheckpoint(checkpoint, initialState, emit), firstTime: false }
    }

    return { context: this.createFreshExecution(initialState, emit), firstTime: true }
  }

  private isValidCheckpoint(
    checkpoint: GraphSDK.Checkpoint<State, NodeKeys> | null
  ): checkpoint is GraphSDK.Checkpoint<State, NodeKeys> {
    return this.hasNodeIds(checkpoint) && this.hasAtLeastOneNode(checkpoint)
  }

  private hasNodeIds(
    checkpoint: GraphSDK.Checkpoint<State, NodeKeys> | null
  ): checkpoint is GraphSDK.Checkpoint<State, NodeKeys> {
    return checkpoint?.nodeIds != null
  }

  private hasAtLeastOneNode(checkpoint: GraphSDK.Checkpoint<State, NodeKeys>): boolean {
    return checkpoint.nodeIds.length > 0
  }

  private restoreFromCheckpoint(
    checkpoint: GraphSDK.Checkpoint<State, NodeKeys>,
    initialState: State | ((state: State | undefined) => State),
    emit: (event: GraphSDK.GraphEvent<State, NodeKeys>) => void
  ): Omit<GraphSDK.ExecutionContext<State, NodeKeys>, 'runId' | 'writer' | 'emit'> {
    const state = this.stateManager.resolve(initialState, checkpoint.state, emit)
    return {
      state,
      currentNodes: this.resolveNodeIds(checkpoint.nodeIds),
      suspendedNodes: this.resolveNodeIds(checkpoint.suspendedNodes)
    }
  }

  private createFreshExecution(
    initialState: State | ((state: State | undefined) => State),
    emit: (event: GraphSDK.GraphEvent<State, NodeKeys>) => void
  ): Omit<GraphSDK.ExecutionContext<State, NodeKeys>, 'runId' | 'writer' | 'emit'> {
    const state = this.stateManager.resolve(initialState, undefined, emit)
    const startNode = this.nodeRegistry.get(BUILT_IN_NODES.START as NodeKeys)!
    return {
      state,
      currentNodes: [startNode],
      suspendedNodes: []
    }
  }

  private async persistCheckpoint(context: GraphSDK.ExecutionContext<State, NodeKeys>): Promise<void> {
    await this.storage.save(context.runId, {
      state: context.state,
      nodeIds: context.currentNodes.map((n) => n.id),
      suspendedNodes: context.suspendedNodes.map((n) => n.id)
    })
  }

  private async executeBatch(
    nodes: GraphSDK.Node<State, NodeKeys>[],
    context: GraphSDK.ExecutionContext<State, NodeKeys>
  ): Promise<Array<{ node: GraphSDK.Node<State, NodeKeys>; error: SuspenseError }>> {
    const results = await Promise.all(
      nodes.map((node) => this.executeSingleNode(node, context))
    )
    return results.filter((r): r is { node: GraphSDK.Node<State, NodeKeys>; error: SuspenseError } => r !== null)
  }

  private async executeSingleNode(
    node: GraphSDK.Node<State, NodeKeys>,
    context: GraphSDK.ExecutionContext<State, NodeKeys>
  ): Promise<{ node: GraphSDK.Node<State, NodeKeys>; error: SuspenseError } | null> {
    const subgraphEntry = this.subgraphRegistry.get(node.id)

    if (subgraphEntry) {
      return this.executeSubgraphNode(node, context, subgraphEntry)
    }

    const isBuiltIn = node.id === BUILT_IN_NODES.START || node.id === BUILT_IN_NODES.END

    context.emit({ type: 'node:start', nodeId: node.id })

    try {
      const { params, pendingUpdates } = this.createNodeExecutionParams(context, node.id)

      if (!isBuiltIn && this.nodeMiddleware.length > 0) {
        const nodeCtx: GraphSDK.NodeMiddlewareContext<State, NodeKeys> = {
          runId: context.runId,
          nodeId: node.id,
          state: () => context.state,
          writer: context.writer,
          isSubgraph: false
        }
        await composeMiddleware(
          this.nodeMiddleware,
          async () => { await node.execute(params) }
        )(nodeCtx)
      } else {
        await node.execute(params)
      }

      await Promise.all(pendingUpdates)
      context.emit({ type: 'node:end', nodeId: node.id })
      return null
    } catch (error) {
      if (error instanceof SuspenseError) {
        context.emit({ type: 'node:suspense', nodeId: node.id, data: error.data })
        return { node, error }
      }
      throw error
    }
  }

  private createNodeExecutionParams(
    context: GraphSDK.ExecutionContext<State, NodeKeys>,
    nodeId: NodeKeys | null = null
  ): {
    params: Parameters<GraphSDK.Node<State, NodeKeys>['execute']>[0]
    pendingUpdates: Promise<void>[]
  } {
    const pendingUpdates: Promise<void>[] = []
    const params = {
      state: () => context.state,
      writer: context.writer,
      suspense: this.createSuspenseFunction(),
      update: (update: GraphSDK.StateUpdate<State>): Promise<void> => {
        const p = (async () => {
          if (this.stateMiddleware.length > 0) {
            const resolvedUpdate = typeof update === 'function' ? update(context.state) : update
            const stateCtx: GraphSDK.StateMiddlewareContext<State, NodeKeys> = {
              runId: context.runId,
              nodeId,
              currentState: context.state,
              update,
              resolvedUpdate
            }
            const finalPartial = await composeMiddleware<
              GraphSDK.StateMiddlewareContext<State, NodeKeys>,
              Partial<State>
            >(
              this.stateMiddleware,
              async (ctx) => ctx.resolvedUpdate
            )(stateCtx)
            context.state = { ...context.state, ...finalPartial }
            context.emit({ type: 'state', state: context.state })
          } else {
            context.state = this.stateManager.apply(context.state, update)
            context.emit({ type: 'state', state: context.state })
          }
        })()
        pendingUpdates.push(p)
        return p
      }
    }
    return { params, pendingUpdates }
  }

  private async executeSubgraphNode(
    node: GraphSDK.Node<State, NodeKeys>,
    context: GraphSDK.ExecutionContext<State, NodeKeys>,
    entry: { subgraph: Graph<any, any>; options: GraphSDK.SubgraphOptions<State, any> }
  ): Promise<{ node: GraphSDK.Node<State, NodeKeys>; error: SuspenseError } | null> {
    const { subgraph, options } = entry

    context.emit({ type: 'node:start', nodeId: node.id })

    const subgraphRunId = this.generateSubgraphRunId(context.runId, node.id)

    try {
      const executeSubgraph = async () => {
        const childRunner = new CompiledGraph(
          subgraph.nodes,
          subgraph.edges,
          subgraph.subgraphs,
          { storage: this.storage },
          [],
          this.nodeMiddleware as any[],
          this.stateMiddleware as any[],
          this.eventMiddleware as any[]
        )

        const childFinalState = await childRunner.executeInternal(
          subgraphRunId,
          options.input(context.state),
          context.writer,
          context.emit as any
        )

        const parentUpdate = options.output(childFinalState, context.state)

        if (this.stateMiddleware.length > 0) {
          const resolvedUpdate = typeof parentUpdate === 'function'
            ? parentUpdate(context.state)
            : parentUpdate
          const stateCtx: GraphSDK.StateMiddlewareContext<State, NodeKeys> = {
            runId: context.runId,
            nodeId: node.id,
            currentState: context.state,
            update: parentUpdate,
            resolvedUpdate
          }
          const finalPartial = await composeMiddleware<
            GraphSDK.StateMiddlewareContext<State, NodeKeys>,
            Partial<State>
          >(
            this.stateMiddleware,
            async (ctx) => ctx.resolvedUpdate
          )(stateCtx)
          context.state = { ...context.state, ...finalPartial }
        } else {
          context.state = this.stateManager.apply(context.state, parentUpdate)
        }
        context.emit({ type: 'state', state: context.state })
      }

      if (this.nodeMiddleware.length > 0) {
        const nodeCtx: GraphSDK.NodeMiddlewareContext<State, NodeKeys> = {
          runId: context.runId,
          nodeId: node.id,
          state: () => context.state,
          writer: context.writer,
          isSubgraph: true
        }
        await composeMiddleware(
          this.nodeMiddleware,
          async () => { await executeSubgraph() }
        )(nodeCtx)
      } else {
        await executeSubgraph()
      }

      context.emit({ type: 'node:end', nodeId: node.id })
      return null
    } catch (error) {
      if (error instanceof SuspenseError) {
        context.emit({ type: 'node:suspense', nodeId: node.id, data: error.data })
        return { node, error }
      }
      throw error
    }
  }

  private generateSubgraphRunId(parentRunId: string, nodeId: NodeKeys): string {
    return `${parentRunId}:subgraph:${nodeId}`
  }

  private createSuspenseFunction(): (data?: unknown) => never {
    return (data?: unknown): never => {
      throw new SuspenseError(data)
    }
  }

  private resolveNodeIds(nodeIds: NodeKeys[]): GraphSDK.Node<State, NodeKeys>[] {
    return nodeIds
      .map((id) => this.nodeRegistry.get(id))
      .filter((node): node is GraphSDK.Node<State, NodeKeys> => node != null)
  }

  private computeNextNodes(
    currentNodes: GraphSDK.Node<State, NodeKeys>[],
    state: State
  ): GraphSDK.Node<State, NodeKeys>[] {
    const successors = currentNodes.flatMap((node) => this.findSuccessors(node.id, state))
    const uniqueSuccessors = this.deduplicateNodes(successors)
    return this.excludeTerminalNodes(uniqueSuccessors)
  }

  private findSuccessors(
    nodeId: NodeKeys,
    state: State
  ): GraphSDK.Node<State, NodeKeys>[] {
    const outgoingEdges = this.edgeRegistry.get(nodeId) ?? []
    return outgoingEdges
      .map((edge) => this.resolveEdgeTarget(edge, state))
      .filter((node): node is GraphSDK.Node<State, NodeKeys> => node != null)
  }

  private resolveEdgeTarget(
    edge: GraphSDK.Edge<State, NodeKeys>,
    state: State
  ): GraphSDK.Node<State, NodeKeys> | undefined {
    const targetId = typeof edge.to === 'function' ? edge.to(state) : edge.to
    return this.nodeRegistry.get(targetId)
  }

  private deduplicateNodes(
    nodes: GraphSDK.Node<State, NodeKeys>[]
  ): GraphSDK.Node<State, NodeKeys>[] {
    return [...new Set(nodes)]
  }

  private excludeTerminalNodes(
    nodes: GraphSDK.Node<State, NodeKeys>[]
  ): GraphSDK.Node<State, NodeKeys>[] {
    return nodes.filter((node) => node.id !== BUILT_IN_NODES.END)
  }
}

class StateManager<State extends Record<string, unknown>> {
  apply(state: State, update: GraphSDK.StateUpdate<State>): State {
    return {
      ...state,
      ...(typeof update === 'function' ? update(state) : update)
    }
  }

  resolve<NodeKeys extends string>(
    initialState: State | ((state: State | undefined) => State),
    existingState: State | undefined,
    emit: (event: GraphSDK.GraphEvent<State, NodeKeys>) => void
  ): State {
    if (this.isStateFactory(initialState)) {
      const newState = initialState(existingState)
      emit({ type: 'state', state: newState })
      return newState
    }
    const newState = existingState ?? initialState
    emit({ type: 'state', state: newState })
    return newState
  }

  private isStateFactory(
    initialState: State | ((state: State | undefined) => State)
  ): initialState is (state: State | undefined) => State {
    return typeof initialState === 'function'
  }
}
