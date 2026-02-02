import type { createUIMessageStream, UIMessageStreamWriter } from 'ai'

export namespace GraphSDK {
  export type StateUpdate<State> = Partial<State> | ((state: State) => Partial<State>)

  export interface SubgraphOptions<
    ParentState extends Record<string, unknown>,
    ChildState extends Record<string, unknown>
  > {
    input: (parentState: ParentState) => ChildState
    output: (childState: ChildState, parentState: ParentState) => Partial<ParentState>
  }
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
      update: (update: StateUpdate<State>) => Promise<void>
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
    delete(runId: string): Promise<void>
  }

  export interface ExecutionContext<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > {
    runId: string
    state: State
    currentNodes: Node<State, NodeKeys>[]
    suspendedNodes: Node<State, NodeKeys>[]
    writer: Writer
    emit: (event: GraphEvent<State, NodeKeys>) => void
  }

  export interface GraphOptions<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > {
    storage?: GraphStorage<State, NodeKeys>
  }

  export interface CompileOptions<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > {
    storage?: GraphStorage<State, NodeKeys>
  }

  export type Writer = Parameters<
    Parameters<typeof createUIMessageStream>[0]['execute']
  >[0]['writer']

  export interface GraphMiddlewareContext<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > {
    runId: string
    state: () => Readonly<State>
    writer: Writer
    isResume: boolean
  }

  export interface NodeMiddlewareContext<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > {
    runId: string
    nodeId: NodeKeys
    state: () => Readonly<State>
    writer: Writer
    isSubgraph: boolean
  }

  export interface StateMiddlewareContext<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > {
    runId: string
    nodeId: NodeKeys | null
    currentState: Readonly<State>
    update: StateUpdate<State>
    resolvedUpdate: Partial<State>
  }

  export type GraphMiddleware<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > = (
    ctx: GraphMiddlewareContext<State, NodeKeys>,
    next: () => Promise<void>
  ) => Promise<void>

  export type NodeMiddleware<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > = (
    ctx: NodeMiddlewareContext<State, NodeKeys>,
    next: () => Promise<void>
  ) => Promise<void>

  export type StateMiddleware<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > = (
    ctx: StateMiddlewareContext<State, NodeKeys>,
    next: () => Promise<Partial<State>>
  ) => Promise<Partial<State>>

  export type GraphEvent<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > =
    | { type: 'state'; state: State }
    | { type: 'node:start'; nodeId: NodeKeys }
    | { type: 'node:end'; nodeId: NodeKeys }
    | { type: 'node:suspense'; nodeId: NodeKeys; data: unknown }

  export type EventMiddleware<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > = (
    event: GraphEvent<State, NodeKeys>,
    next: () => void
  ) => void

  export interface Middleware<
    State extends Record<string, unknown>,
    NodeKeys extends string
  > {
    graph?: GraphMiddleware<State, NodeKeys>
    node?: NodeMiddleware<State, NodeKeys>
    state?: StateMiddleware<State, NodeKeys>
    event?: EventMiddleware<State, NodeKeys>
  }
}
