import { test, expect, describe, jest } from 'bun:test'
import { graph, SuspenseError } from '../src/graph'
import { InMemoryStorage } from '../src/storage'

async function runGraph(stream: ReadableStream) {
  const reader = stream.getReader()
  while (true) {
    const { done } = await reader.read()
    if (done) break
  }
}

describe('Graph - Basic Execution', () => {
  test('executes a simple linear graph', async () => {
    const executionOrder: string[] = []

    const g = graph<{ value: number }>()
      .node('a', () => {
        executionOrder.push('a')
      })
      .node('b', () => {
        executionOrder.push('b')
      })
      .node('c', () => {
        executionOrder.push('c')
      })
      .edge('START', 'a')
      .edge('a', 'b')
      .edge('b', 'c')
      .edge('c', 'END')

    await runGraph(g.execute('run-1', { value: 0 }))

    expect(executionOrder).toEqual(['a', 'b', 'c'])
  })

  test('executes empty graph (START → END)', async () => {
    const g = graph<{ value: number }>()
      .edge('START', 'END')

    await runGraph(g.execute('run-1', { value: 0 }))
  })

})

describe('Graph - State Management', () => {
  test('updates state with partial object', async () => {
    let finalState: { a: number; b: number } | undefined

    const g = graph<{ a: number; b: number }>()
      .node('updateA', ({ update }) => {
        update({ a: 10 })
      })
      .node('updateB', ({ update }) => {
        update({ b: 20 })
      })
      .node('readState', ({ state }) => {
        finalState = state()
      })
      .edge('START', 'updateA')
      .edge('updateA', 'updateB')
      .edge('updateB', 'readState')
      .edge('readState', 'END')

    await runGraph(g.execute('run-1', { a: 0, b: 0 }))

    expect(finalState).toEqual({ a: 10, b: 20 })
  })

  test('updates state with function', async () => {
    let finalState: { count: number } | undefined

    const g = graph<{ count: number }>()
      .node('increment', ({ update }) => {
        update((state) => ({ count: state.count + 1 }))
      })
      .node('double', ({ update }) => {
        update((state) => ({ count: state.count * 2 }))
      })
      .node('readState', ({ state }) => {
        finalState = state()
      })
      .edge('START', 'increment')
      .edge('increment', 'double')
      .edge('double', 'readState')
      .edge('readState', 'END')

    await runGraph(g.execute('run-1', { count: 5 }))

    expect(finalState).toEqual({ count: 12 })
  })

  test('state is readable during execution', async () => {
    const stateSnapshots: number[] = []

    const g = graph<{ value: number }>()
      .node('a', ({ state, update }) => {
        stateSnapshots.push(state().value)
        update({ value: 10 })
        stateSnapshots.push(state().value)
      })
      .node('b', ({ state }) => {
        stateSnapshots.push(state().value)
      })
      .edge('START', 'a')
      .edge('a', 'b')
      .edge('b', 'END')

    await runGraph(g.execute('run-1', { value: 0 }))

    expect(stateSnapshots).toEqual([0, 10, 10])
  })
})

describe('Graph - Edge Routing', () => {
  test('dynamic edges route based on state', async () => {
    const executionOrder: string[] = []

    const g = graph<{ path: 'left' | 'right' }>()
      .node('router', () => { executionOrder.push('router') })
      .node('left', () => { executionOrder.push('left') })
      .node('right', () => { executionOrder.push('right') })
      .edge('START', 'router')
      .edge('router', (state) => state.path)
      .edge('left', 'END')
      .edge('right', 'END')

    await runGraph(g.execute('run-left', { path: 'left' }))
    expect(executionOrder).toEqual(['router', 'left'])

    executionOrder.length = 0
    await runGraph(g.execute('run-right', { path: 'right' }))
    expect(executionOrder).toEqual(['router', 'right'])
  })

  test('dynamic edges can change based on state updates', async () => {
    const executionOrder: string[] = []

    const g = graph<{ goToB: boolean }>()
      .node('a', ({ update }) => {
        executionOrder.push('a')
        update({ goToB: true })
      })
      .node('b', () => { executionOrder.push('b') })
      .node('c', () => { executionOrder.push('c') })
      .edge('START', 'a')
      .edge('a', (state) => (state.goToB ? 'b' : 'c'))
      .edge('b', 'END')
      .edge('c', 'END')

    await runGraph(g.execute('run-1', { goToB: false }))

    expect(executionOrder).toEqual(['a', 'b'])
  })

  test('multiple outgoing edges execute nodes in parallel', async () => {
    const executionOrder: string[] = []
    const startTimes: Record<string, number> = {}

    const g = graph<{ value: number }>()
      .node('fork', () => {
        executionOrder.push('fork')
      })
      .node('parallel1', async () => {
        startTimes['parallel1'] = Date.now()
        await new Promise((resolve) => setTimeout(resolve, 50))
        executionOrder.push('parallel1')
      })
      .node('parallel2', async () => {
        startTimes['parallel2'] = Date.now()
        await new Promise((resolve) => setTimeout(resolve, 50))
        executionOrder.push('parallel2')
      })
      .node('join', () => {
        executionOrder.push('join')
      })
      .edge('START', 'fork')
      .edge('fork', 'parallel1')
      .edge('fork', 'parallel2')
      .edge('parallel1', 'join')
      .edge('parallel2', 'join')
      .edge('join', 'END')

    await runGraph(g.execute('run-1', { value: 0 }))

    const time1 = startTimes['parallel1'] ?? 0
    const time2 = startTimes['parallel2'] ?? 0
    expect(Math.abs(time1 - time2)).toBeLessThan(20)
    expect(executionOrder[0]).toBe('fork')
    expect(executionOrder).toContain('parallel1')
    expect(executionOrder).toContain('parallel2')
    expect(executionOrder[executionOrder.length - 1]).toBe('join')
  })
})

describe('Graph - Suspense & Resume', () => {
  test('suspends execution and can resume', async () => {
    const executionOrder: string[] = []

    const g = graph<{ shouldSuspend: boolean }>()
      .node('before', () => { executionOrder.push('before') })
      .node('suspendable', ({ state, suspense }) => {
        executionOrder.push('suspendable')
        if (state().shouldSuspend) {
          suspense({ reason: 'waiting for input' })
        }
      })
      .node('after', () => { executionOrder.push('after') })
      .edge('START', 'before')
      .edge('before', 'suspendable')
      .edge('suspendable', 'after')
      .edge('after', 'END')

    await runGraph(g.execute('run-1', { shouldSuspend: true }))
    expect(executionOrder).toEqual(['before', 'suspendable'])

    executionOrder.length = 0
    await runGraph(g.execute('run-1', () => ({ shouldSuspend: false })))
    expect(executionOrder).toEqual(['suspendable', 'after'])
  })

  test('can update state when resuming', async () => {
    let observedValue: number | undefined

    const g = graph<{ value: number }>()
      .node('suspender', ({ state, suspense }) => {
        observedValue = state().value
        if (state().value < 10) {
          suspense()
        }
      })
      .edge('START', 'suspender')
      .edge('suspender', 'END')

    await runGraph(g.execute('run-1', { value: 5 }))
    expect(observedValue).toBe(5)

    await runGraph(g.execute('run-1', (state) => ({ ...state, value: 15 })))
    expect(observedValue).toBe(15)
  })

  test('multiple suspend/resume cycles', async () => {
    let callCount = 0

    const g = graph<{ attempts: number }>()
      .node('retry', ({ state, suspense, update }) => {
        callCount++
        if (state().attempts < 3) {
          suspense({ attempt: state().attempts })
        }
        update({ attempts: state().attempts + 1 })
      })
      .edge('START', 'retry')
      .edge('retry', 'END')

    await runGraph(g.execute('run-1', { attempts: 0 }))
    expect(callCount).toBe(1)

    await runGraph(g.execute('run-1', (s) => ({ ...s, attempts: 1 })))
    expect(callCount).toBe(2)

    await runGraph(g.execute('run-1', (s) => ({ ...s, attempts: 2 })))
    expect(callCount).toBe(3)

    await runGraph(g.execute('run-1', (s) => ({ ...s, attempts: 3 })))
    expect(callCount).toBe(4)
  })
})

describe('Graph - Checkpointing', () => {
  test('checkpoint is saved on suspense', async () => {
    const storage = new InMemoryStorage<{ value: number }, string>()

    const g = graph<{ value: number }>(storage as any)
      .node('a', ({ suspense }) => {
        suspense()
      })
      .edge('START', 'a')
      .edge('a', 'END')

    await runGraph(g.execute('run-1', { value: 42 }))

    const checkpoint = await storage.load('run-1')
    expect(checkpoint).not.toBeNull()
    expect(checkpoint?.state.value).toBe(42)
    expect(checkpoint?.suspendedNodes).toContain('a')
  })

  test('checkpoint is deleted on completion', async () => {
    const storage = new InMemoryStorage<{ value: number }, string>()

    const g = graph<{ value: number }>(storage as any)
      .node('a', () => {})
      .edge('START', 'a')
      .edge('a', 'END')

    await runGraph(g.execute('run-1', { value: 42 }))

    const checkpoint = await storage.load('run-1')
    expect(checkpoint).toBeNull()
  })

  test('different runIds have separate checkpoints', async () => {
    const storage = new InMemoryStorage<{ value: number }, string>()

    const g = graph<{ value: number }>(storage as any)
      .node('a', ({ state, suspense }) => {
        if (state().value < 100) suspense()
      })
      .edge('START', 'a')
      .edge('a', 'END')

    await runGraph(g.execute('run-1', { value: 10 }))
    await runGraph(g.execute('run-2', { value: 20 }))

    const checkpoint1 = await storage.load('run-1')
    const checkpoint2 = await storage.load('run-2')

    expect(checkpoint1?.state.value).toBe(10)
    expect(checkpoint2?.state.value).toBe(20)
  })
})


describe('Graph - Error Handling', () => {
  test('errors in nodes stop execution', async () => {
    const executionOrder: string[] = []

    const g = graph<{ value: number }>()
      .node('before', () => { executionOrder.push('before') })
      .node('errorNode', () => {
        executionOrder.push('errorNode')
        throw new Error('Test error')
      })
      .node('after', () => { executionOrder.push('after') })
      .edge('START', 'before')
      .edge('before', 'errorNode')
      .edge('errorNode', 'after')
      .edge('after', 'END')

    await runGraph(g.execute('run-1', { value: 0 }))

    expect(executionOrder).toContain('before')
    expect(executionOrder).toContain('errorNode')
    expect(executionOrder).not.toContain('after')
  })
})

describe('Graph - Subgraph', () => {
  test('executes subgraph with input/output state mapping', async () => {
    type ChildState = { value: number }
    type ParentState = { input: number; result?: number }

    const childGraph = graph<ChildState>()
      .node('double', ({ state, update }) => {
        update({ value: state().value * 2 })
      })
      .edge('START', 'double')
      .edge('double', 'END')

    let finalResult: number | undefined

    const parentGraph = graph<ParentState>()
      .graph('process', childGraph, {
        input: (parentState) => ({ value: parentState.input }),
        output: (childState) => ({ result: childState.value })
      })
      .node('verify', ({ state }) => {
        finalResult = state().result
      })
      .edge('START', 'process')
      .edge('process', 'verify')
      .edge('verify', 'END')

    await runGraph(parentGraph.execute('test-1', { input: 5 }))

    expect(finalResult).toBe(10)
  })

  test('subgraph resumes from checkpoint state after suspense', async () => {
    const executionLog: string[] = []

    type ChildState = { step: number; needsInput: boolean }
    type ParentState = { childStep?: number }

    const childGraph = graph<ChildState>()
      .node('step1', ({ state, update }) => {
        executionLog.push(`step1: step=${state().step}`)
        update({ step: 1 })
      })
      .node('step2', ({ state, update, suspense }) => {
        executionLog.push(`step2: step=${state().step}, needsInput=${state().needsInput}`)
        if (state().needsInput) {
          suspense({ reason: 'need input' })
        }
        update({ step: 2 })
      })
      .node('step3', ({ state }) => {
        executionLog.push(`step3: step=${state().step}`)
      })
      .edge('START', 'step1')
      .edge('step1', 'step2')
      .edge('step2', 'step3')
      .edge('step3', 'END')

    const parentGraph = graph<ParentState>()
      .graph('child', childGraph, {
        input: () => ({ step: 0, needsInput: true }),
        output: (childState) => ({ childStep: childState.step })
      })
      .edge('START', 'child')
      .edge('child', 'END')

    await runGraph(parentGraph.execute('test-resume', {}))

    expect(executionLog).toEqual(['step1: step=0', 'step2: step=1, needsInput=true'])

    executionLog.length = 0
    await runGraph(parentGraph.execute('test-resume', (state) => ({ ...state, childStep: undefined })))

    expect(executionLog[0]).toBe('step2: step=1, needsInput=true')
  })

  test('nested subgraphs work correctly', async () => {
    type Level2State = { level: number }
    type Level1State = { level: number }
    type RootState = { level: number }

    const level2Graph = graph<Level2State>()
      .node('increment', ({ state, update }) => {
        update({ level: state().level + 1 })
      })
      .edge('START', 'increment')
      .edge('increment', 'END')

    const level1Graph = graph<Level1State>()
      .graph('nested', level2Graph, {
        input: (state) => ({ level: state.level }),
        output: (childState) => ({ level: childState.level })
      })
      .edge('START', 'nested')
      .edge('nested', 'END')

    let finalLevel: number | undefined

    const rootGraph = graph<RootState>()
      .graph('child', level1Graph, {
        input: (state) => ({ level: state.level }),
        output: (childState) => ({ level: childState.level })
      })
      .node('verify', ({ state }) => {
        finalLevel = state().level
      })
      .edge('START', 'child')
      .edge('child', 'verify')
      .edge('verify', 'END')

    await runGraph(rootGraph.execute('test-nested', { level: 0 }))

    expect(finalLevel).toBe(1)
  })

  test('subgraph output mapper receives both child and parent state', async () => {
    type ChildState = { computed: number }
    type ParentState = { base: number; result?: number }

    const childGraph = graph<ChildState>()
      .node('compute', ({ update }) => {
        update({ computed: 100 })
      })
      .edge('START', 'compute')
      .edge('compute', 'END')

    let outputMapperCalled = false
    let receivedChildState: ChildState | undefined
    let receivedParentState: ParentState | undefined

    const parentGraph = graph<ParentState>()
      .graph('child', childGraph, {
        input: () => ({ computed: 0 }),
        output: (childState, parentState) => {
          outputMapperCalled = true
          receivedChildState = childState
          receivedParentState = parentState
          return { result: childState.computed + parentState.base }
        }
      })
      .edge('START', 'child')
      .edge('child', 'END')

    await runGraph(parentGraph.execute('test-1', { base: 50 }))

    expect(outputMapperCalled).toBe(true)
    expect(receivedChildState).toEqual({ computed: 100 })
    expect(receivedParentState?.base).toBe(50)
  })

  test('subgraph nodes execute in correct order', async () => {
    const executionOrder: string[] = []

    type ChildState = { value: number }
    type ParentState = { value: number }

    const childGraph = graph<ChildState>()
      .node('childNode', () => { executionOrder.push('childNode') })
      .edge('START', 'childNode')
      .edge('childNode', 'END')

    const parentGraph = graph<ParentState>()
      .node('before', () => { executionOrder.push('before') })
      .graph('subgraph', childGraph, {
        input: (s) => ({ value: s.value }),
        output: () => ({})
      })
      .node('after', () => { executionOrder.push('after') })
      .edge('START', 'before')
      .edge('before', 'subgraph')
      .edge('subgraph', 'after')
      .edge('after', 'END')

    await runGraph(parentGraph.execute('test-1', { value: 0 }))

    expect(executionOrder).toEqual(['before', 'childNode', 'after'])
  })
})

describe('Graph - API', () => {
  test('nodes getter returns registered nodes', () => {
    const g = graph<{ value: number }>()
      .node('a', () => {})
      .node('b', () => {})

    const nodes = g.nodes

    expect(nodes.has('START' as any)).toBe(true)
    expect(nodes.has('END' as any)).toBe(true)
    expect(nodes.has('a' as any)).toBe(true)
    expect(nodes.has('b' as any)).toBe(true)
  })

  test('edges getter returns registered edges', () => {
    const g = graph<{ value: number }>()
      .node('a', () => {})
      .node('b', () => {})
      .edge('START', 'a')
      .edge('a', 'b')
      .edge('b', 'END')

    const edges = g.edges

    expect(edges.get('START' as any)?.length).toBe(1)
    expect(edges.get('a' as any)?.length).toBe(1)
    expect(edges.get('b' as any)?.length).toBe(1)
  })

})

describe('Graph - Edge Cases', () => {
  test('dynamic edge can route directly to END', async () => {
    const executionOrder: string[] = []

    const g = graph<{ shouldEnd: boolean }>()
      .node('check', () => { executionOrder.push('check') })
      .node('process', () => { executionOrder.push('process') })
      .edge('START', 'check')
      .edge('check', (state) => (state.shouldEnd ? 'END' : 'process'))
      .edge('process', 'END')

    await runGraph(g.execute('run-1', { shouldEnd: true }))

    expect(executionOrder).toEqual(['check'])
  })

  test('node deduplication when multiple edges converge', async () => {
    let joinExecutionCount = 0

    const g = graph<{ value: number }>()
      .node('fork', () => {})
      .node('pathA', () => {})
      .node('pathB', () => {})
      .node('join', () => { joinExecutionCount++ })
      .edge('START', 'fork')
      .edge('fork', 'pathA')
      .edge('fork', 'pathB')
      .edge('pathA', 'join')
      .edge('pathB', 'join')
      .edge('join', 'END')

    await runGraph(g.execute('run-1', { value: 0 }))

    expect(joinExecutionCount).toBe(1)
  })

  test('parallel nodes can update different state properties', async () => {
    let finalState: { a: number; b: number } | undefined

    const g = graph<{ a: number; b: number }>()
      .node('fork', () => {})
      .node('updateA', ({ update }) => {
        update({ a: 100 })
      })
      .node('updateB', ({ update }) => {
        update({ b: 200 })
      })
      .node('collect', ({ state }) => {
        finalState = state()
      })
      .edge('START', 'fork')
      .edge('fork', 'updateA')
      .edge('fork', 'updateB')
      .edge('updateA', 'collect')
      .edge('updateB', 'collect')
      .edge('collect', 'END')

    await runGraph(g.execute('run-1', { a: 0, b: 0 }))

    expect(finalState?.a).toBe(100)
    expect(finalState?.b).toBe(200)
  })

  test('initial state function is called for fresh execution', async () => {
    let initializerCalled = false
    let receivedState: { value: number } | undefined

    const g = graph<{ value: number }>()
      .node('reader', ({ state }) => {
        receivedState = state()
      })
      .edge('START', 'reader')
      .edge('reader', 'END')

    await runGraph(g.execute('fresh-run', (existing) => {
      initializerCalled = true
      return { value: existing?.value ?? 42 }
    }))

    expect(initializerCalled).toBe(true)
    expect(receivedState?.value).toBe(42)
  })

  test('multiple parallel nodes can suspend', async () => {
    const storage = new InMemoryStorage<{ value: number }, string>()
    const executionOrder: string[] = []

    const g = graph<{ value: number }>(storage as any)
      .node('fork', () => { executionOrder.push('fork') })
      .node('suspendA', ({ suspense }) => {
        executionOrder.push('suspendA')
        suspense({ node: 'A' })
      })
      .node('suspendB', ({ suspense }) => {
        executionOrder.push('suspendB')
        suspense({ node: 'B' })
      })
      .node('join', () => { executionOrder.push('join') })
      .edge('START', 'fork')
      .edge('fork', 'suspendA')
      .edge('fork', 'suspendB')
      .edge('suspendA', 'join')
      .edge('suspendB', 'join')
      .edge('join', 'END')

    await runGraph(g.execute('run-1', { value: 0 }))

    expect(executionOrder).toContain('fork')
    expect(executionOrder).toContain('suspendA')
    expect(executionOrder).toContain('suspendB')
    expect(executionOrder).not.toContain('join')

    const checkpoint = await storage.load('run-1')
    expect(checkpoint?.suspendedNodes.length).toBe(2)
  })

  test('subgraph errors propagate to parent', async () => {
    const executionOrder: string[] = []

    type ChildState = { value: number }
    type ParentState = { value: number }

    const childGraph = graph<ChildState>()
      .node('willFail', () => {
        executionOrder.push('childWillFail')
        throw new Error('Child error')
      })
      .edge('START', 'willFail')
      .edge('willFail', 'END')

    const parentGraph = graph<ParentState>()
      .node('before', () => { executionOrder.push('parentBefore') })
      .graph('child', childGraph, {
        input: (s) => ({ value: s.value }),
        output: () => ({})
      })
      .node('after', () => { executionOrder.push('parentAfter') })
      .edge('START', 'before')
      .edge('before', 'child')
      .edge('child', 'after')
      .edge('after', 'END')

    await runGraph(parentGraph.execute('test-1', { value: 0 }))

    expect(executionOrder).toContain('parentBefore')
    expect(executionOrder).toContain('childWillFail')
    expect(executionOrder).not.toContain('parentAfter')
  })
})

describe('Graph - SuspenseError', () => {
  test('SuspenseError has correct properties with and without data', () => {
    const withData = new SuspenseError({ reason: 'test' })
    const withoutData = new SuspenseError()

    expect(withData).toBeInstanceOf(Error)
    expect(withoutData).toBeInstanceOf(Error)

    expect(withData.name).toBe('SuspenseError')
    expect(withData.message).toBe('Suspense')

    expect(withData.data).toEqual({ reason: 'test' })
    expect(withoutData.data).toBeUndefined()
  })
})

describe('Graph - Checkpoint Edge Cases', () => {
  test('checkpoint with empty nodeIds starts fresh execution', async () => {
    const storage = new InMemoryStorage<{ value: number }, string>()
    await storage.save('run-1', {
      state: { value: 999 },
      nodeIds: [],
      suspendedNodes: []
    })

    const executionOrder: string[] = []
    const g = graph<{ value: number }>(storage as any)
      .node('a', () => { executionOrder.push('a') })
      .edge('START', 'a')
      .edge('a', 'END')

    await runGraph(g.execute('run-1', { value: 0 }))

    expect(executionOrder).toContain('a')
  })

  test('checkpoint with non-existent node IDs terminates without execution', async () => {
    const storage = new InMemoryStorage<{ value: number }, string>()
    await storage.save('run-1', {
      state: { value: 10 },
      nodeIds: ['nonexistent1', 'nonexistent2'],
      suspendedNodes: []
    })

    const executionOrder: string[] = []
    const g = graph<{ value: number }>(storage as any)
      .node('real', () => { executionOrder.push('real') })
      .edge('START', 'real')
      .edge('real', 'END')

    await runGraph(g.execute('run-1', { value: 0 }))

    expect(executionOrder).toEqual([])
  })

  test('initial state function receives checkpoint state when resuming', async () => {
    const storage = new InMemoryStorage<{ value: number }, string>()
    let callCount = 0
    let receivedExisting: { value: number } | undefined

    const g = graph<{ value: number }>(storage as any)
      .node('suspender', ({ suspense }) => {
        callCount++
        if (callCount === 1) {
          suspense()
        }
      })
      .edge('START', 'suspender')
      .edge('suspender', 'END')

    await runGraph(g.execute('run-1', { value: 100 }))

    await runGraph(g.execute('run-1', (existing) => {
      receivedExisting = existing
      return { value: existing?.value ?? 0 }
    }))

    expect(receivedExisting?.value).toBe(100)
  })
})

describe('Graph - Node Resolution Edge Cases', () => {
  test('edge to non-existent node does not execute', async () => {
    const executionOrder: string[] = []

    const g = graph<{ value: number }>()
      .node('a', () => { executionOrder.push('a') })
      .edge('START', 'a')
      .edge('a', 'nonexistent' as any)
      .edge('nonexistent' as any, 'END')

    await runGraph(g.execute('run-1', { value: 0 }))

    expect(executionOrder).toEqual(['a'])
  })

  test('node with no outgoing edges terminates execution', async () => {
    const executionOrder: string[] = []

    const g = graph<{ value: number }>()
      .node('terminal', () => { executionOrder.push('terminal') })
      .node('unreachable', () => { executionOrder.push('unreachable') })
      .edge('START', 'terminal')

    await runGraph(g.execute('run-1', { value: 0 }))

    expect(executionOrder).toEqual(['terminal'])
    expect(executionOrder).not.toContain('unreachable')
  })

  test('START with no outgoing edges completes immediately', async () => {
    const g = graph<{ value: number }>()
      .node('unreachable', () => {
        throw new Error('Should not reach here')
      })

    await runGraph(g.execute('run-1', { value: 0 }))
  })
})

describe('Graph - Writer Event Emissions', () => {
  test('emits node-start and node-end events for successful execution', async () => {
    const events: Array<{ type: string; data: unknown }> = []

    const g = graph<{ value: number }>()
      .node('a', () => {})
      .node('b', () => {})
      .edge('START', 'a')
      .edge('a', 'b')
      .edge('b', 'END')

    const stream = g.execute('run-1', { value: 0 })
    const reader = stream.getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && typeof value === 'object' && 'type' in value) {
        events.push(value as { type: string; data: unknown })
      }
    }

    const nodeStartEvents = events.filter((e) => e.type === 'data-node-start')
    const nodeEndEvents = events.filter((e) => e.type === 'data-node-end')

    expect(nodeStartEvents.length).toBeGreaterThanOrEqual(2)
    expect(nodeEndEvents.length).toBeGreaterThanOrEqual(2)
  })

  test('emits node-suspense event on suspension', async () => {
    const events: Array<{ type: string; data: unknown }> = []

    const g = graph<{ value: number }>()
      .node('suspender', ({ suspense }) => {
        suspense({ reason: 'test-suspense' })
      })
      .edge('START', 'suspender')
      .edge('suspender', 'END')

    const stream = g.execute('run-1', { value: 0 })
    const reader = stream.getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && typeof value === 'object' && 'type' in value) {
        events.push(value as { type: string; data: unknown })
      }
    }

    const suspenseEvents = events.filter((e) => e.type === 'data-node-suspense')
    expect(suspenseEvents.length).toBe(1)
    expect((suspenseEvents[0]!.data as any).nodeId).toBe('suspender')
    expect((suspenseEvents[0]!.data as any).data.reason).toBe('test-suspense')
  })
})

describe('Graph - Complex State Scenarios', () => {
  test('handles deeply nested state objects', async () => {
    type DeepState = {
      level1: {
        level2: {
          level3: {
            value: number
          }
        }
      }
    }

    let finalState: DeepState | undefined

    const g = graph<DeepState>()
      .node('modifier', ({ state, update }) => {
        const current = state()
        update({
          level1: {
            level2: {
              level3: {
                value: current.level1.level2.level3.value + 100
              }
            }
          }
        })
      })
      .node('reader', ({ state }) => {
        finalState = state()
      })
      .edge('START', 'modifier')
      .edge('modifier', 'reader')
      .edge('reader', 'END')

    await runGraph(g.execute('run-1', {
      level1: { level2: { level3: { value: 1 } } }
    }))

    expect(finalState?.level1.level2.level3.value).toBe(101)
  })

  test('handles array state updates', async () => {
    type ArrayState = { items: number[] }
    let finalItems: number[] | undefined

    const g = graph<ArrayState>()
      .node('appendItem', ({ state, update }) => {
        update({ items: [...state().items, 4] })
      })
      .node('reader', ({ state }) => {
        finalItems = state().items
      })
      .edge('START', 'appendItem')
      .edge('appendItem', 'reader')
      .edge('reader', 'END')

    await runGraph(g.execute('run-1', { items: [1, 2, 3] }))

    expect(finalItems).toEqual([1, 2, 3, 4])
  })

  test('handles empty initial state object', async () => {
    let stateObserved = false

    const g = graph<Record<string, never>>()
      .node('checkEmpty', ({ state }) => {
        const s = state()
        stateObserved = Object.keys(s).length === 0
      })
      .edge('START', 'checkEmpty')
      .edge('checkEmpty', 'END')

    await runGraph(g.execute('run-1', {} as Record<string, never>))

    expect(stateObserved).toBe(true)
  })
})


describe('Graph - executeInternal', () => {
  test('executeInternal returns final state', async () => {
    const g = graph<{ value: number }>()
      .node('double', ({ state, update }) => {
        update({ value: state().value * 2 })
      })
      .edge('START', 'double')
      .edge('double', 'END')

    const mockWriter = {
      write: jest.fn()
    }

    const finalState = await g.executeInternal('run-1', { value: 5 }, mockWriter as any)

    expect(finalState.value).toBe(10)
  })

  test('executeInternal throws SuspenseError when node suspends', async () => {
    const g = graph<{ value: number }>()
      .node('suspender', ({ suspense }) => {
        suspense({ reason: 'test' })
      })
      .edge('START', 'suspender')
      .edge('suspender', 'END')

    const mockWriter = { write: jest.fn() }

    let thrown: Error | undefined
    try {
      await g.executeInternal('run-1', { value: 0 }, mockWriter as any)
    } catch (error) {
      thrown = error as Error
    }

    expect(thrown).toBeInstanceOf(SuspenseError)
  })

  test('executeInternal can resume after suspense', async () => {
    const storage = new InMemoryStorage<{ callCount: number }, string>()
    const executionOrder: string[] = []

    const g = graph<{ callCount: number }>(storage as any)
      .node('conditional', ({ state, suspense, update }) => {
        const count = state().callCount
        executionOrder.push(`conditional:${count}`)
        update({ callCount: count + 1 })
        if (count === 0) {
          suspense()
        }
      })
      .node('after', () => {
        executionOrder.push('after')
      })
      .edge('START', 'conditional')
      .edge('conditional', 'after')
      .edge('after', 'END')

    const mockWriter = { write: jest.fn() }

    try {
      await g.executeInternal('run-1', { callCount: 0 }, mockWriter as any)
    } catch (e) {}

    expect(executionOrder).toEqual(['conditional:0'])

    executionOrder.length = 0
    const finalState = await g.executeInternal(
      'run-1',
      { callCount: 0 },
      mockWriter as any
    )

    expect(executionOrder).toEqual(['conditional:1', 'after'])
    expect(finalState.callCount).toBe(2)
  })

})

describe('Graph - Concurrent Executions', () => {
  test('multiple executions with same storage are isolated', async () => {
    const storage = new InMemoryStorage<{ id: string }, string>()

    const g = graph<{ id: string }>(storage as any)
      .node('suspender', ({ state, suspense }) => {
        if (state().id === 'suspend-me') {
          suspense()
        }
      })
      .edge('START', 'suspender')
      .edge('suspender', 'END')

    await Promise.all([
      runGraph(g.execute('run-1', { id: 'suspend-me' })),
      runGraph(g.execute('run-2', { id: 'complete' }))
    ])

    const checkpoint1 = await storage.load('run-1')
    expect(checkpoint1).not.toBeNull()

    const checkpoint2 = await storage.load('run-2')
    expect(checkpoint2).toBeNull()
  })
})


describe('Graph - Writer Usage in Nodes', () => {
  test('node can use writer to write custom data', async () => {
    const events: Array<{ type: string; data: unknown }> = []

    const g = graph<{ value: number }>()
      .node('broadcaster', ({ writer }) => {
        writer.write({ type: 'data-custom', data: { message: 'hello' } })
      })
      .edge('START', 'broadcaster')
      .edge('broadcaster', 'END')

    const stream = g.execute('run-1', { value: 0 })
    const reader = stream.getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && typeof value === 'object' && 'type' in value) {
        events.push(value as { type: string; data: unknown })
      }
    }

    const customEvent = events.find((e) => e.type === 'data-custom')
    expect(customEvent).toBeDefined()
    expect((customEvent?.data as any).message).toBe('hello')
  })
})

describe('Graph - Checkpoint Persistence Across Batches', () => {
  test('state is persisted after each batch execution', async () => {
    const storage = new InMemoryStorage<{ step: number }, string>()

    const g = graph<{ step: number }>(storage as any)
      .node('step1', ({ update }) => {
        update({ step: 1 })
      })
      .node('step2', ({ update, suspense }) => {
        update({ step: 2 })
        suspense()
      })
      .edge('START', 'step1')
      .edge('step1', 'step2')
      .edge('step2', 'END')

    await runGraph(g.execute('run-1', { step: 0 }))

    const finalCheckpoint = await storage.load('run-1')
    expect(finalCheckpoint?.state.step).toBe(2)
  })
})
