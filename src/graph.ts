import type { GraphSDK } from './types'
import { CompiledGraph } from './compiled-graph'

export { SuspenseError } from './compiled-graph'

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
  private readonly middlewares: GraphSDK.Middleware<State, NodeKeys>[] = []

  constructor() {
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
      writer: GraphSDK.Writer
      suspense: (data?: unknown) => never
      update: (update: GraphSDK.StateUpdate<State>) => Promise<void>
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
      execute: async () => { }
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

  use(middleware: GraphSDK.Middleware<State, NodeKeys>): Graph<State, NodeKeys> {
    this.middlewares.push(middleware)
    return this
  }

  compile(options: GraphSDK.CompileOptions<State, NodeKeys> = {}): CompiledGraph<State, NodeKeys> {
    const graphMiddleware: GraphSDK.GraphMiddleware<State, NodeKeys>[] = []
    const nodeMiddleware: GraphSDK.NodeMiddleware<State, NodeKeys>[] = []
    const stateMiddleware: GraphSDK.StateMiddleware<State, NodeKeys>[] = []
    const eventMiddleware: GraphSDK.EventMiddleware<State, NodeKeys>[] = []

    for (const mw of this.middlewares) {
      if (mw.graph) graphMiddleware.push(mw.graph)
      if (mw.node) nodeMiddleware.push(mw.node)
      if (mw.state) stateMiddleware.push(mw.state)
      if (mw.event) eventMiddleware.push(mw.event)
    }

    return new CompiledGraph(
      this.nodeRegistry,
      this.edgeRegistry,
      this.subgraphRegistry,
      options,
      graphMiddleware,
      nodeMiddleware,
      stateMiddleware,
      eventMiddleware
    )
  }

  toMermaid(options?: { direction?: 'TB' | 'LR' }): string {
    const generator = new MermaidGenerator(
      this.nodeRegistry,
      this.edgeRegistry,
      this.subgraphRegistry
    )
    return generator.generate(options)
  }

  private registerBuiltInNodes(): void {
    this.node('START' as NodeKeys & string, () => { })
    this.node('END' as NodeKeys & string, () => { })
  }

  private addEdgeToRegistry(edge: GraphSDK.Edge<State, NodeKeys>): void {
    const existingEdges = this.edgeRegistry.get(edge.from) ?? []
    existingEdges.push(edge)
    this.edgeRegistry.set(edge.from, existingEdges)
  }
}

export function graph<
  State extends Record<string, unknown>,
  NodeKeys extends string = 'START' | 'END'
>() {
  return new Graph<State, NodeKeys>()
}

class MermaidGenerator<
  State extends Record<string, unknown>,
  NodeKeys extends string
> {
  constructor(
    private readonly nodeRegistry: ReadonlyMap<NodeKeys, GraphSDK.Node<State, NodeKeys>>,
    private readonly edgeRegistry: ReadonlyMap<NodeKeys, GraphSDK.Edge<State, NodeKeys>[]>,
    private readonly subgraphRegistry: ReadonlyMap<
      NodeKeys,
      { subgraph: Graph<any, any>; options: GraphSDK.SubgraphOptions<State, any> }
    >
  ) { }

  generate(options?: { direction?: 'TB' | 'LR' }): string {
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
        const subgraphGenerator = new MermaidGenerator(
          subgraphEntry.subgraph.nodes,
          subgraphEntry.subgraph.edges,
          subgraphEntry.subgraph.subgraphs
        )
        const subgraphContent = subgraphGenerator.generateMermaid(direction, prefixedId)
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
}
