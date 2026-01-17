import type { UIMessageStreamWriter } from 'ai'

export namespace GraphSDK {
  export type StateUpdate<State> = Partial<State> | ((state: State) => Partial<State>)
  export interface Graph<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > {
    nodes: Map<NodeKeys, Node<State, NodeKeys>>
    edges: Map<NodeKeys, Edge<State, NodeKeys>[]>
  }

  export interface Node<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > {
    id: NodeKeys
    execute: ({
      state,
      writer,
      suspense,
      update
    }: {
      state: () => Readonly<State>
      writer: UIMessageStreamWriter
      suspense: (data?: unknown) => never
      update: (update: StateUpdate<State>) => void
    }) => Promise<void> | void
  }

  export interface Edge<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > {
    from: NodeKeys
    to: NodeKeys | ((state: State) => NodeKeys)
  }

  export interface Checkpoint<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > {
    state: State
    nodeIds: NodeKeys[]
    suspendedNodes: NodeKeys[]
  }

  export interface GraphStorage<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > {
    save(runId: string, checkpoint: Checkpoint<State, NodeKeys>): Promise<void>
    load(runId: string): Promise<Checkpoint<State, NodeKeys> | null>
  }

  export interface ExecutionContext<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > {
    runId: string
    state: State
    currentNodes: Node<State, NodeKeys>[]
    suspendedNodes: Node<State, NodeKeys>[]
    writer: UIMessageStreamWriter
  }
}
