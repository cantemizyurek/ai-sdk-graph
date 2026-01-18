import { InMemoryStorage } from './storage'
import type { GraphSDK } from './types'
import { createUIMessageStream } from 'ai'

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

type Writer = Parameters<
  Parameters<typeof createUIMessageStream>[0]['execute']
>[0]['writer']

export class Graph<
  State extends Record<string, unknown>,
  NodeKeys extends string = 'START' | 'END'
> {
  private readonly nodeRegistry: Map<NodeKeys, GraphSDK.Node<State, NodeKeys>> = new Map()
  private readonly edgeRegistry: Map<NodeKeys, GraphSDK.Edge<State, NodeKeys>[]> = new Map()
  private readonly subgraphRegistry: Map<
    NodeKeys,
    {
      subgraph: Graph<any, any>
      options: GraphSDK.SubgraphOptions<State, any>
    }
  > = new Map()
  private readonly storage: GraphSDK.GraphStorage<State, NodeKeys>
  private readonly emitter = new NodeEventEmitter<NodeKeys>()
  private readonly stateManager = new StateManager<State>()
  private readonly onFinish: (state: State) => Promise<void> | void

  constructor(options: { storage?: GraphSDK.GraphStorage<State, NodeKeys>, onFinish?: (state: State) => Promise<void> | void } = {}) {
    this.storage = options.storage ?? new InMemoryStorage()
    this.registerBuiltInNodes()
    this.onFinish = options.onFinish ?? ((state) => {})
  }

  node<NewKey extends string>(
    id: NewKey,
    execute: ({
      state,
      writer,
      suspense,
      update
    }: {
      state: () => Readonly<State>
      writer: Writer
      suspense: (data?: unknown) => never
      update: (update: GraphSDK.StateUpdate<State>) => void
    }) => Promise<void> | void
  ): Graph<State, NodeKeys | NewKey> {
    const node: GraphSDK.Node<State, NewKey> = { id, execute }
    this.nodeRegistry.set(
      node.id as unknown as NodeKeys,
      node as unknown as GraphSDK.Node<State, NodeKeys>
    )
    return this as unknown as Graph<State, NodeKeys | NewKey>
  }

  edge(
    from: NodeKeys,
    to: NodeKeys | ((state: State) => NodeKeys)
  ): Graph<State, NodeKeys> {
    const edge: GraphSDK.Edge<State, NodeKeys> = { from, to }
    this.addEdgeToRegistry(edge)
    return this
  }

  graph<
    NewKey extends string,
    ChildState extends Record<string, unknown>,
    ChildNodeKeys extends string = 'START' | 'END'
  >(
    id: NewKey,
    subgraph: Graph<ChildState, ChildNodeKeys>,
    options: GraphSDK.SubgraphOptions<State, ChildState>
  ): Graph<State, NodeKeys | NewKey> {
    this.subgraphRegistry.set(id as unknown as NodeKeys, { subgraph, options })

    const node: GraphSDK.Node<State, NewKey> = {
      id,
      execute: async () => {}
    }
    this.nodeRegistry.set(
      node.id as unknown as NodeKeys,
      node as unknown as GraphSDK.Node<State, NodeKeys>
    )

    return this as unknown as Graph<State, NodeKeys | NewKey>
  }

  get nodes(): ReadonlyMap<NodeKeys, GraphSDK.Node<State, NodeKeys>> {
    return this.nodeRegistry
  }

  get edges(): ReadonlyMap<NodeKeys, GraphSDK.Edge<State, NodeKeys>[]> {
    return this.edgeRegistry
  }

  get subgraphs(): ReadonlyMap<
    NodeKeys,
    { subgraph: Graph<any, any>; options: GraphSDK.SubgraphOptions<State, any> }
  > {
    return this.subgraphRegistry
  }

  toMermaid(options?: { direction?: 'TB' | 'LR' }): string {
    const direction = options?.direction ?? 'TB'
    return this.generateMermaid(direction, '')
  }

  private generateMermaid(direction: 'TB' | 'LR', prefix: string): string {
    const lines: string[] = []
    const indent = prefix ? '        ' : '    '

    if (!prefix) {
      lines.push(`flowchart ${direction}`)
    }

    for (const [nodeId] of this.nodeRegistry) {
      const prefixedId = prefix ? `${prefix}_${nodeId}` : nodeId
      const subgraphEntry = this.subgraphRegistry.get(nodeId)

      if (subgraphEntry) {
        lines.push(`${indent}subgraph ${prefixedId}[${nodeId}]`)
        lines.push(`${indent}    direction ${direction}`)
        const subgraphContent = subgraphEntry.subgraph.generateMermaid(direction, prefixedId)
        const subgraphLines = subgraphContent.split('\n')
        lines.push(...subgraphLines.map(line => `${indent}${line}`))
        lines.push(`${indent}end`)
      } else if (nodeId === 'START' || nodeId === 'END') {
        lines.push(`${indent}${prefixedId}([${nodeId}])`)
      } else {
        lines.push(`${indent}${prefixedId}[${nodeId}]`)
      }
    }

    for (const [fromId, edges] of this.edgeRegistry) {
      for (const edge of edges) {
        const prefixedFrom = prefix ? `${prefix}_${fromId}` : fromId

        if (typeof edge.to === 'function') {
          const possibleTargets = this.extractPossibleTargets(edge.to)
          for (const targetId of possibleTargets) {
            const prefixedTo = prefix ? `${prefix}_${targetId}` : targetId
            lines.push(`${indent}${prefixedFrom} -.-> ${prefixedTo}`)
          }
        } else {
          const prefixedTo = prefix ? `${prefix}_${edge.to}` : edge.to
          lines.push(`${indent}${prefixedFrom} --> ${prefixedTo}`)
        }
      }
    }

    return lines.join('\n')
  }

  private extractPossibleTargets(
    edgeFn: (state: State) => NodeKeys
  ): NodeKeys[] {
    const fnString = edgeFn.toString()
    const nodeIds = Array.from(this.nodeRegistry.keys())
    return nodeIds.filter(nodeId => {
      const patterns = [
        `'${nodeId}'`,
        `"${nodeId}"`,
        `\`${nodeId}\``
      ]
      return patterns.some(pattern => fnString.includes(pattern))
    })
  }

  execute(
    runId: string,
    initialState: State | ((state: State | undefined) => State)
  ) {
    let context: GraphSDK.ExecutionContext<State, NodeKeys> | undefined
    return createUIMessageStream({
      execute: async ({ writer }) => {
        context = await this.createExecutionContext(runId, initialState, writer)
        await this.runExecutionLoop(context)
      },
      onFinish: async () => {
        if (context) {
          await this.onFinish(context.state)
        }
      }
    })
  }

  async executeInternal(
    runId: string,
    initialState: State,
    writer: Writer
  ): Promise<State> {
    const context = await this.createExecutionContext(runId, initialState, writer)
    await this.runExecutionLoopInternal(context)
    return context.state
  }

  private registerBuiltInNodes(): void {
    this.node(BUILT_IN_NODES.START as NodeKeys & string, () => {})
    this.node(BUILT_IN_NODES.END as NodeKeys & string, () => {})
  }

  private addEdgeToRegistry(edge: GraphSDK.Edge<State, NodeKeys>): void {
    const existingEdges = this.edgeRegistry.get(edge.from) ?? []
    existingEdges.push(edge)
    this.edgeRegistry.set(edge.from, existingEdges)
  }

  private async createExecutionContext(
    runId: string,
    initialState: State | ((state: State | undefined) => State),
    writer: Writer
  ): Promise<GraphSDK.ExecutionContext<State, NodeKeys>> {
    const restored = await this.restoreCheckpoint(runId, initialState)
    return { runId, writer, ...restored }
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
    initialState: State | ((state: State | undefined) => State)
  ): Promise<Omit<GraphSDK.ExecutionContext<State, NodeKeys>, 'runId' | 'writer'>> {
    const checkpoint = await this.storage.load(runId)

    if (this.isValidCheckpoint(checkpoint)) {
      return this.restoreFromCheckpoint(checkpoint, initialState)
    }

    return this.createFreshExecution(initialState)
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
    initialState: State | ((state: State | undefined) => State)
  ): Omit<GraphSDK.ExecutionContext<State, NodeKeys>, 'runId' | 'writer'> {
    const state = this.stateManager.resolve(initialState, checkpoint.state)
    return {
      state,
      currentNodes: this.resolveNodeIds(checkpoint.nodeIds),
      suspendedNodes: this.resolveNodeIds(checkpoint.suspendedNodes)
    }
  }

  private createFreshExecution(
    initialState: State | ((state: State | undefined) => State)
  ): Omit<GraphSDK.ExecutionContext<State, NodeKeys>, 'runId' | 'writer'> {
    const state = this.stateManager.resolve(initialState, undefined)
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
        context.state = this.stateManager.apply(context.state, update)
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
      const childFinalState = await subgraph.executeInternal(
        subgraphRunId,
        options.input(context.state),
        context.writer
      )

      const parentUpdate = options.output(childFinalState, context.state)
      context.state = this.stateManager.apply(context.state, parentUpdate)

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

export function graph<
  State extends Record<string, unknown>,
  NodeKeys extends string = 'START' | 'END'
>(options: { storage?: GraphSDK.GraphStorage<State, NodeKeys>, onFinish?: (state: State) => Promise<void> | void } = {}) {
  return new Graph<State, NodeKeys>({
    storage: options.storage,
    onFinish: options.onFinish
  })
}
class NodeEventEmitter<NodeKeys extends string> {
  emitStart(writer: Writer, nodeId: NodeKeys): void {
    writer.write({ type: 'data-node-start', data: nodeId })
  }

  emitEnd(writer: Writer, nodeId: NodeKeys): void {
    writer.write({ type: 'data-node-end', data: nodeId })
  }

  emitSuspense(writer: Writer, nodeId: NodeKeys, data: unknown): void {
    writer.write({ type: 'data-node-suspense', data: { nodeId, data } })
  }
}

class StateManager<State extends Record<string, unknown>> {
  apply(state: State, update: GraphSDK.StateUpdate<State>): State {
    return {
      ...state,
      ...(typeof update === 'function' ? update(state) : update)
    }
  }

  resolve(
    initialState: State | ((state: State | undefined) => State),
    existingState: State | undefined
  ): State {
    if (this.isStateFactory(initialState)) {
      return initialState(existingState)
    }
    return existingState ?? initialState
  }

  private isStateFactory(
    initialState: State | ((state: State | undefined) => State)
  ): initialState is (state: State | undefined) => State {
    return typeof initialState === 'function'
  }
}