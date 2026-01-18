import { test, expect, describe } from 'bun:test'
import { graph } from '../src/graph'

describe('Graph - Mermaid Visualization', () => {
  test('generates mermaid for simple linear graph', () => {
    const g = graph<{ value: number }>()
      .node('a', () => {})
      .node('b', () => {})
      .edge('START', 'a')
      .edge('a', 'b')
      .edge('b', 'END')

    const mermaid = g.toMermaid()

    expect(mermaid).toContain('flowchart TB')
    expect(mermaid).toContain('START([START])')
    expect(mermaid).toContain('END([END])')
    expect(mermaid).toContain('a[a]')
    expect(mermaid).toContain('b[b]')
    expect(mermaid).toContain('START --> a')
    expect(mermaid).toContain('a --> b')
    expect(mermaid).toContain('b --> END')
  })

  test('generates mermaid with LR direction', () => {
    const g = graph<{ value: number }>()
      .node('a', () => {})
      .edge('START', 'a')
      .edge('a', 'END')

    const mermaid = g.toMermaid({ direction: 'LR' })

    expect(mermaid).toContain('flowchart LR')
  })

  test('generates mermaid for empty graph (START -> END)', () => {
    const g = graph<{ value: number }>()
      .edge('START', 'END')

    const mermaid = g.toMermaid()

    expect(mermaid).toContain('flowchart TB')
    expect(mermaid).toContain('START([START])')
    expect(mermaid).toContain('END([END])')
    expect(mermaid).toContain('START --> END')
  })

  test('generates mermaid for parallel branches (fork/join)', () => {
    const g = graph<{ value: number }>()
      .node('fork', () => {})
      .node('pathA', () => {})
      .node('pathB', () => {})
      .node('join', () => {})
      .edge('START', 'fork')
      .edge('fork', 'pathA')
      .edge('fork', 'pathB')
      .edge('pathA', 'join')
      .edge('pathB', 'join')
      .edge('join', 'END')

    const mermaid = g.toMermaid()

    expect(mermaid).toContain('fork[fork]')
    expect(mermaid).toContain('pathA[pathA]')
    expect(mermaid).toContain('pathB[pathB]')
    expect(mermaid).toContain('join[join]')
    expect(mermaid).toContain('fork --> pathA')
    expect(mermaid).toContain('fork --> pathB')
    expect(mermaid).toContain('pathA --> join')
    expect(mermaid).toContain('pathB --> join')
  })

  test('generates mermaid for conditional/dynamic edges', () => {
    const g = graph<{ goLeft: boolean }>()
      .node('router', () => {})
      .node('left', () => {})
      .node('right', () => {})
      .edge('START', 'router')
      .edge('router', (state) => (state.goLeft ? 'left' : 'right'))
      .edge('left', 'END')
      .edge('right', 'END')

    const mermaid = g.toMermaid()

    expect(mermaid).toContain('router[router]')
    expect(mermaid).toContain('left[left]')
    expect(mermaid).toContain('right[right]')
    expect(mermaid).toContain('router -.->|conditional| left')
    expect(mermaid).toContain('router -.->|conditional| right')
  })

  test('generates mermaid for conditional edge with ternary', () => {
    const g = graph<{ goToB: boolean }>()
      .node('a', () => {})
      .node('b', () => {})
      .node('c', () => {})
      .edge('START', 'a')
      .edge('a', (state) => (state.goToB ? 'b' : 'c'))
      .edge('b', 'END')
      .edge('c', 'END')

    const mermaid = g.toMermaid()

    expect(mermaid).toContain('a -.->|conditional| b')
    expect(mermaid).toContain('a -.->|conditional| c')
  })

  test('generates mermaid with subgraphs', () => {
    type ChildState = { value: number }
    type ParentState = { input: number }

    const childGraph = graph<ChildState>()
      .node('double', () => {})
      .edge('START', 'double')
      .edge('double', 'END')

    const parentGraph = graph<ParentState>()
      .graph('process', childGraph, {
        input: (parentState) => ({ value: parentState.input }),
        output: (childState) => ({ input: childState.value })
      })
      .edge('START', 'process')
      .edge('process', 'END')

    const mermaid = parentGraph.toMermaid()

    expect(mermaid).toContain('flowchart TB')
    expect(mermaid).toContain('subgraph process[process]')
    expect(mermaid).toContain('direction TB')
    expect(mermaid).toContain('process_START([START])')
    expect(mermaid).toContain('process_END([END])')
    expect(mermaid).toContain('process_double[double]')
    expect(mermaid).toContain('end')
    expect(mermaid).toContain('START --> process')
    expect(mermaid).toContain('process --> END')
  })

  test('generates mermaid with nested subgraphs', () => {
    type Level2State = { level: number }
    type Level1State = { level: number }
    type RootState = { level: number }

    const level2Graph = graph<Level2State>()
      .node('increment', () => {})
      .edge('START', 'increment')
      .edge('increment', 'END')

    const level1Graph = graph<Level1State>()
      .graph('nested', level2Graph, {
        input: (state) => ({ level: state.level }),
        output: (childState) => ({ level: childState.level })
      })
      .edge('START', 'nested')
      .edge('nested', 'END')

    const rootGraph = graph<RootState>()
      .graph('child', level1Graph, {
        input: (state) => ({ level: state.level }),
        output: (childState) => ({ level: childState.level })
      })
      .edge('START', 'child')
      .edge('child', 'END')

    const mermaid = rootGraph.toMermaid()

    expect(mermaid).toContain('subgraph child[child]')
    expect(mermaid).toContain('subgraph child_nested[nested]')
    expect(mermaid).toContain('child_nested_increment[increment]')
  })

  test('conditional edge to END is detected', () => {
    const g = graph<{ shouldEnd: boolean }>()
      .node('check', () => {})
      .node('process', () => {})
      .edge('START', 'check')
      .edge('check', (state) => (state.shouldEnd ? 'END' : 'process'))
      .edge('process', 'END')

    const mermaid = g.toMermaid()

    expect(mermaid).toContain('check -.->|conditional| END')
    expect(mermaid).toContain('check -.->|conditional| process')
  })

  test('subgraphs getter returns registered subgraphs', () => {
    type ChildState = { value: number }
    type ParentState = { input: number }

    const childGraph = graph<ChildState>()
      .node('inner', () => {})
      .edge('START', 'inner')
      .edge('inner', 'END')

    const parentGraph = graph<ParentState>()
      .graph('sub', childGraph, {
        input: () => ({ value: 0 }),
        output: () => ({})
      })
      .edge('START', 'sub')
      .edge('sub', 'END')

    const subgraphs = parentGraph.subgraphs

    expect(subgraphs.has('sub' as any)).toBe(true)
    expect(subgraphs.get('sub' as any)?.subgraph).toBe(childGraph)
  })
})
