import { InMemoryStorage } from './storage'
import type { GraphSDK } from './types'
import { createUIMessageStream } from 'ai'

class SuspenseError extends Error {
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
  private readonly storage: GraphSDK.GraphStorage<State, NodeKeys>

  constructor(storage: GraphSDK.GraphStorage<State, NodeKeys> = new InMemoryStorage()) {
    this.storage = storage
    this.registerBuiltInNodes()
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

  get nodes(): ReadonlyMap<NodeKeys, GraphSDK.Node<State, NodeKeys>> {
    return this.nodeRegistry
  }

  get edges(): ReadonlyMap<NodeKeys, GraphSDK.Edge<State, NodeKeys>[]> {
    return this.edgeRegistry
  }

  execute(
    runId: string,
    initialState: State | ((state: State | undefined) => State)
  ) {
    return createUIMessageStream({
      execute: async ({ writer }) => {
        const context = await this.createExecutionContext(runId, initialState, writer)
        await this.runExecutionLoop(context)
      }
    })
  }

  private registerBuiltInNodes(): void {
    this.node('START' as NodeKeys & string, () => {})
    this.node('END' as NodeKeys & string, () => {})
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
    if (this.hasSuspendedNodes(context)) {
      const shouldContinue = await this.resumeSuspendedNodes(context)
      if (!shouldContinue) return
    }

    await this.executeUntilComplete(context)
  }

  private hasSuspendedNodes(context: GraphSDK.ExecutionContext<State, NodeKeys>): boolean {
    return context.suspendedNodes.length > 0
  }

  private async resumeSuspendedNodes(context: GraphSDK.ExecutionContext<State, NodeKeys>): Promise<boolean> {
    const suspenses = await this.executeBatch(context.suspendedNodes, context)

    if (suspenses.length > 0) {
      context.suspendedNodes = suspenses.map((s) => s.node)
      await this.persistCheckpoint(context)
      return false
    }

    context.currentNodes = this.computeNextNodes(context.currentNodes, context.state)
    context.suspendedNodes = []
    await this.persistCheckpoint(context)
    return true
  }

  private async executeUntilComplete(context: GraphSDK.ExecutionContext<State, NodeKeys>): Promise<void> {
    while (this.hasNodesToExecute(context)) {
      const suspenses = await this.executeBatch(context.currentNodes, context)

      if (suspenses.length > 0) {
        context.suspendedNodes = suspenses.map((s) => s.node)
        await this.persistCheckpoint(context)
        return
      }

      context.currentNodes = this.computeNextNodes(context.currentNodes, context.state)
      context.suspendedNodes = []
      await this.persistCheckpoint(context)
    }

    this.storage.delete(context.runId)
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
    return checkpoint?.nodeIds?.length != null && checkpoint.nodeIds.length > 0
  }

  private restoreFromCheckpoint(
    checkpoint: GraphSDK.Checkpoint<State, NodeKeys>,
    initialState: State | ((state: State | undefined) => State)
  ): Omit<GraphSDK.ExecutionContext<State, NodeKeys>, 'runId' | 'writer'> {
    const state = this.resolveInitialState(initialState, checkpoint.state)
    return {
      state,
      currentNodes: this.resolveNodeIds(checkpoint.nodeIds),
      suspendedNodes: this.resolveNodeIds(checkpoint.suspendedNodes)
    }
  }

  private createFreshExecution(
    initialState: State | ((state: State | undefined) => State)
  ): Omit<GraphSDK.ExecutionContext<State, NodeKeys>, 'runId' | 'writer'> {
    const state = this.resolveInitialState(initialState, undefined)
    const startNode = this.nodeRegistry.get('START' as NodeKeys)!
    return {
      state,
      currentNodes: [startNode],
      suspendedNodes: []
    }
  }

  private resolveInitialState(
    initialState: State | ((state: State | undefined) => State),
    existingState: State | undefined
  ): State {
    return typeof initialState === 'function' ? initialState(existingState) : existingState ?? initialState
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
    this.emitNodeStart(context.writer, node.id)

    try {
      await node.execute({
        state: () => context.state,
        writer: context.writer,
        suspense: this.createSuspenseFunction(),
        update: (update: GraphSDK.StateUpdate<State>) => {
          context.state = this.applyStateUpdate(context.state, update)
        }
      })
      this.emitNodeEnd(context.writer, node.id)
      return null
    } catch (error) {
      if (error instanceof SuspenseError) {
        this.emitNodeSuspense(context.writer, node.id, error.data)
        return { node, error }
      }
      throw error
    }
  }

  private createSuspenseFunction(): (data?: unknown) => never {
    return (data?: unknown): never => {
      throw new SuspenseError(data)
    }
  }

  private applyStateUpdate(state: State, update: GraphSDK.StateUpdate<State>): State {
    return {
      ...state,
      ...(typeof update === 'function' ? update(state) : update)
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
    return nodes.filter((node) => node.id !== 'END')
  }

  private emitNodeStart(writer: Writer, nodeId: NodeKeys): void {
    writer.write({ type: 'data-node-start', data: nodeId })
  }

  private emitNodeEnd(writer: Writer, nodeId: NodeKeys): void {
    writer.write({ type: 'data-node-end', data: nodeId })
  }

  private emitNodeSuspense(writer: Writer, nodeId: NodeKeys, data: unknown): void {
    writer.write({ type: 'data-node-suspense', data: { nodeId, data } })
  }
}

export function graph<
  State extends Record<string, unknown>,
  NodeKeys extends string = 'START' | 'END'
>(storage?: GraphSDK.GraphStorage<State, NodeKeys>) {
  return new Graph<State, NodeKeys>(storage)
}
