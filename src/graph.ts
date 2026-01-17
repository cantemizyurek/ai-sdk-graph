import type { GraphSDK } from './types'
import { createUIMessageStream } from 'ai'

export { InMemoryStorage } from './storage'

class SuspenseError extends Error {
  constructor(message: string, data?: unknown) {
    super(message)
    this.name = 'SuspenseError'
    this.data = data
  }

  data?: unknown
}

type Writer = Parameters<
  Parameters<typeof createUIMessageStream>[0]['execute']
>[0]['writer']

export class Graph<
  State extends Record<string, unknown>,
  NodeKeys extends string = 'START' | 'END'
> {
  nodes: Map<NodeKeys, GraphSDK.Node<State, NodeKeys>> = new Map()
  edges: Map<NodeKeys, GraphSDK.Edge<State, NodeKeys>[]> = new Map()

  constructor(private storage?: GraphSDK.GraphStorage<State, NodeKeys>) {
    this.node('START', () => {})
    this.node('END', () => {})
  }

  node<NewKey extends string>(
    id: NewKey,
    execute: ({
      state,
      writer,
      suspense
    }: {
      state: State
      writer: Writer
      suspense: (data?: unknown) => Promise<never> | never
    }) => Promise<Partial<State>> | Partial<State> | void
  ): Graph<State, NodeKeys | NewKey> {
    const node = {
      id,
      edges: [] as GraphSDK.Edge<State, NewKey>[],
      execute
    } as GraphSDK.Node<State, NewKey>
    this.nodes.set(
      node.id as unknown as NodeKeys,
      node as unknown as GraphSDK.Node<State, NodeKeys>
    )
    return this as unknown as Graph<State, NodeKeys | NewKey>
  }

  edge(
    from: NodeKeys,
    to: NodeKeys | ((state: State) => NodeKeys)
  ): Graph<State, NodeKeys> {
    const edge = { from, to } as GraphSDK.Edge<State, NodeKeys>
    const fromEdges = this.edges.get(edge.from) ?? []
    fromEdges.push(edge)
    this.edges.set(edge.from, fromEdges)
    return this as Graph<State, NodeKeys>
  }

  execute(
    runId: string,
    initialState: State | ((state: State | undefined) => State)
  ) {
    return createUIMessageStream({
      execute: async ({ writer }) => {
        let { state, currentNodes } = await this.restoreOrInitialize(
          runId,
          initialState
        )

        while (currentNodes.length > 0) {
          state = await this.executeNodeBatch(currentNodes, state, writer)
          currentNodes = this.resolveNextNodes(currentNodes, state)
          await this.saveCheckpoint(runId, state, currentNodes)
        }
      }
    })
  }

  private async restoreOrInitialize(
    runId: string,
    initialState: State | ((state: State | undefined) => State)
  ) {
    const checkpoint = await this.storage?.load(runId)
    if (checkpoint?.nodeIds?.length) {
      return {
        state:
          typeof initialState === 'function'
            ? initialState(checkpoint.state)
            : checkpoint.state,
        currentNodes: this.resolveNodeIds(checkpoint.nodeIds)
      }
    }
    return {
      state:
        typeof initialState === 'function'
          ? initialState(undefined)
          : initialState,
      currentNodes: [this.nodes.get('START' as NodeKeys)!]
    }
  }

  private resolveNodeIds(nodeIds: NodeKeys[]) {
    return nodeIds
      .map((id) => this.nodes.get(id))
      .filter((n): n is GraphSDK.Node<State, NodeKeys> => n != null)
  }

  private async executeNodeBatch(
    nodes: GraphSDK.Node<State, NodeKeys>[],
    state: State,
    writer: Writer
  ) {
    const results = await Promise.all(
      nodes.map((node) => this.executeNode(node, state, writer))
    )
    return this.mergeStates(state, results)
  }

  private async executeNode(
    node: GraphSDK.Node<State, NodeKeys>,
    state: State,
    writer: Writer
  ) {
    writer.write({ type: 'data-node-start', data: node.id })
    let result: Partial<State> | void

    try {
      result = await node.execute({
        state: structuredClone(state),
        writer,
        suspense: (data?: unknown) => {
          throw new SuspenseError('Suspense', data)
        }
      })
    } catch (error) {
      if (error instanceof SuspenseError) {
        writer.write({
          type: 'data-node-suspense',
          data: { nodeId: node.id, data: error.data }
        })
        return state
      }
      throw error
    }

    writer.write({ type: 'data-node-end', data: node.id })
    return result
  }

  private mergeStates(
    baseState: State,
    nodeResults: (Partial<State> | void)[]
  ) {
    return nodeResults.reduce<State>(
      (acc, curr) => ({ ...acc, ...curr }),
      baseState
    )
  }

  private async saveCheckpoint(
    runId: string,
    state: State,
    currentNodes: GraphSDK.Node<State, NodeKeys>[]
  ) {
    await this.storage?.save(runId, {
      state,
      nodeIds: currentNodes.map((n) => n.id)
    })
  }

  private resolveNextNodes(
    currentNodes: GraphSDK.Node<State, NodeKeys>[],
    state: State
  ) {
    const nextNodes = currentNodes.flatMap((node) =>
      this.getSuccessors(node.id, state)
    )
    return [...new Set(nextNodes)].filter((n) => n.id !== 'END')
  }

  private getSuccessors(nodeId: NodeKeys, state: State) {
    const edges = this.edges.get(nodeId) ?? []
    return edges
      .map((edge) => this.resolveEdgeTarget(edge, state))
      .filter((n): n is GraphSDK.Node<State, NodeKeys> => n != null)
  }

  private resolveEdgeTarget(
    edge: GraphSDK.Edge<State, NodeKeys>,
    state: State
  ) {
    const targetId = typeof edge.to === 'function' ? edge.to(state) : edge.to
    return this.nodes.get(targetId)
  }
}

export function graph<
  State extends Record<string, unknown>,
  NodeKeys extends string = 'START' | 'END'
>(storage?: GraphSDK.GraphStorage<State, NodeKeys>) {
  return new Graph<State, NodeKeys>(storage)
}
