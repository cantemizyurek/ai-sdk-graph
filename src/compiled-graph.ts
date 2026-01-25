import { InMemoryStorage } from './storage'
import type { GraphSDK } from './types'
import { createUIMessageStream } from 'ai'
import type { Graph } from './graph'

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
  private readonly emitter = new NodeEventEmitter<NodeKeys>()
  private readonly stateManager = new StateManager<State>()
  private readonly onFinish: ({ state }: { state: State }) => Promise<void> | void
  private readonly onStart: ({ state, writer }: { state: State, writer: GraphSDK.Writer }) => Promise<void> | void

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
    options: GraphSDK.CompileOptions<State, NodeKeys> = {}
  ) {
    this.nodeRegistry = nodeRegistry
    this.edgeRegistry = edgeRegistry
    this.subgraphRegistry = subgraphRegistry
    this.storage = options.storage ?? new InMemoryStorage()
    this.onFinish = options.onFinish ?? (() => { })
    this.onStart = options.onStart ?? (() => { })
  }

  execute(
    runId: string,
    initialState: State | ((state: State | undefined) => State)
  ) {
    let context: GraphSDK.ExecutionContext<State, NodeKeys> | undefined
    return createUIMessageStream({
      execute: async ({ writer }) => {
        const result = await this.createExecutionContext(runId, initialState, writer)
        context = result.context
        const firstTime = result.firstTime
        if (firstTime) {
          await this.onStart({ state: context.state, writer })
        }
        await this.runExecutionLoop(context)
      },
      onFinish: async () => {
        if (context) {
          await this.onFinish({ state: context.state })
        }
      }
    })
  }

  async executeInternal(
    runId: string,
    initialState: State,
    writer: GraphSDK.Writer
  ): Promise<State> {
    const { context } = await this.createExecutionContext(runId, initialState, writer)
    await this.runExecutionLoopInternal(context)
    return context.state
  }

  private async createExecutionContext(
    runId: string,
    initialState: State | ((state: State | undefined) => State),
    writer: GraphSDK.Writer
  ): Promise<{ context: GraphSDK.ExecutionContext<State, NodeKeys>, firstTime: boolean }> {
    const { context, firstTime } = await this.restoreCheckpoint(runId, initialState, writer)
    return { context: { ...context, runId, writer }, firstTime }
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
    writer: GraphSDK.Writer
  ): Promise<{ context: Omit<GraphSDK.ExecutionContext<State, NodeKeys>, 'runId' | 'writer'>, firstTime: boolean }> {
    const checkpoint = await this.storage.load(runId)

    if (this.isValidCheckpoint(checkpoint)) {
      return { context: this.restoreFromCheckpoint(checkpoint, initialState, writer), firstTime: false }
    }

    return { context: this.createFreshExecution(initialState, writer), firstTime: true }
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
    writer: GraphSDK.Writer
  ): Omit<GraphSDK.ExecutionContext<State, NodeKeys>, 'runId' | 'writer'> {
    const state = this.stateManager.resolve(initialState, checkpoint.state, writer)
    return {
      state,
      currentNodes: this.resolveNodeIds(checkpoint.nodeIds),
      suspendedNodes: this.resolveNodeIds(checkpoint.suspendedNodes)
    }
  }

  private createFreshExecution(
    initialState: State | ((state: State | undefined) => State),
    writer: GraphSDK.Writer
  ): Omit<GraphSDK.ExecutionContext<State, NodeKeys>, 'runId' | 'writer'> {
    const state = this.stateManager.resolve(initialState, undefined, writer)
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

    this.emitter.emitStart(context.writer, node.id)

    try {
      await node.execute(this.createNodeExecutionParams(context))
      this.emitter.emitEnd(context.writer, node.id)
      return null
    } catch (error) {
      if (error instanceof SuspenseError) {
        this.emitter.emitSuspense(context.writer, node.id, error.data)
        return { node, error }
      }
      throw error
    }
  }

  private createNodeExecutionParams(
    context: GraphSDK.ExecutionContext<State, NodeKeys>
  ): Parameters<GraphSDK.Node<State, NodeKeys>['execute']>[0] {
    return {
      state: () => context.state,
      writer: context.writer,
      suspense: this.createSuspenseFunction(),
      update: (update: GraphSDK.StateUpdate<State>) => {
        context.state = this.stateManager.apply(context.state, update, context.writer)
      }
    }
  }

  private async executeSubgraphNode(
    node: GraphSDK.Node<State, NodeKeys>,
    context: GraphSDK.ExecutionContext<State, NodeKeys>,
    entry: { subgraph: Graph<any, any>; options: GraphSDK.SubgraphOptions<State, any> }
  ): Promise<{ node: GraphSDK.Node<State, NodeKeys>; error: SuspenseError } | null> {
    const { subgraph, options } = entry

    this.emitter.emitStart(context.writer, node.id)

    const subgraphRunId = this.generateSubgraphRunId(context.runId, node.id)

    try {
      // Create a child CompiledGraph from the subgraph's registries
      const childRunner = new CompiledGraph(
        subgraph.nodes,
        subgraph.edges,
        subgraph.subgraphs,
        { storage: this.storage }
      )

      const childFinalState = await childRunner.executeInternal(
        subgraphRunId,
        options.input(context.state),
        context.writer
      )

      const parentUpdate = options.output(childFinalState, context.state)
      context.state = this.stateManager.apply(context.state, parentUpdate, context.writer)

      this.emitter.emitEnd(context.writer, node.id)
      return null
    } catch (error) {
      if (error instanceof SuspenseError) {
        this.emitter.emitSuspense(context.writer, node.id, error.data)
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

class NodeEventEmitter<NodeKeys extends string> {
  emitStart(writer: GraphSDK.Writer, nodeId: NodeKeys): void {
    writer.write({ type: 'data-node-start', data: nodeId })
  }

  emitEnd(writer: GraphSDK.Writer, nodeId: NodeKeys): void {
    writer.write({ type: 'data-node-end', data: nodeId })
  }

  emitSuspense(writer: GraphSDK.Writer, nodeId: NodeKeys, data: unknown): void {
    writer.write({ type: 'data-node-suspense', data: { nodeId, data } })
  }
}

class StateManager<State extends Record<string, unknown>> {
  apply(state: State, update: GraphSDK.StateUpdate<State>, writer: GraphSDK.Writer): State {
    const newState = {
      ...state,
      ...(typeof update === 'function' ? update(state) : update)
    }
    writer.write({ type: 'data-state', data: newState })
    return newState
  }

  resolve(
    initialState: State | ((state: State | undefined) => State),
    existingState: State | undefined,
    writer: GraphSDK.Writer
  ): State {
    if (this.isStateFactory(initialState)) {
      const newState = initialState(existingState)
      writer.write({ type: 'data-state', data: newState })
      return newState
    }
    const newState = existingState ?? initialState
    writer.write({ type: 'data-state', data: newState })
    return newState
  }

  private isStateFactory(
    initialState: State | ((state: State | undefined) => State)
  ): initialState is (state: State | undefined) => State {
    return typeof initialState === 'function'
  }
}
