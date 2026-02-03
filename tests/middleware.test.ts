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

describe('Middleware - Graph Middleware', () => {
  test('graph middleware wraps entire execution', async () => {
    const order: string[] = []

    const g = graph<{ value: number }>()
      .node('a', () => { order.push('node-a') })
      .edge('START', 'a')
      .edge('a', 'END')
      .use({
        graph: async (ctx, next) => {
          order.push('graph-before')
          await next()
          order.push('graph-after')
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(order).toEqual(['graph-before', 'node-a', 'graph-after'])
  })

  test('graph middleware receives correct context', async () => {
    let receivedCtx: any

    const g = graph<{ value: number }>()
      .node('a', () => { })
      .edge('START', 'a')
      .edge('a', 'END')
      .use({
        graph: async (ctx, next) => {
          receivedCtx = {
            runId: ctx.runId,
            state: ctx.state(),
            hasWriter: !!ctx.writer,
            isResume: ctx.isResume
          }
          await next()
        }
      })

    await runGraph(g.compile().stream('test-run', { value: 42 }))

    expect(receivedCtx.runId).toBe('test-run')
    expect(receivedCtx.state.value).toBe(42)
    expect(receivedCtx.hasWriter).toBe(true)
    expect(receivedCtx.isResume).toBe(false)
  })

  test('graph middleware isResume is true when resuming', async () => {
    const storage = new InMemoryStorage<{ value: number }, 'START' | 'END' | 'suspender'>()
    const isResumeValues: boolean[] = []

    const g = graph<{ value: number }>()
      .node('suspender', ({ state, suspense }) => {
        if (state().value < 10) suspense()
      })
      .edge('START', 'suspender')
      .edge('suspender', 'END')
      .use({
        graph: async (ctx, next) => {
          isResumeValues.push(ctx.isResume)
          await next()
        }
      })

    const compiled = g.compile({ storage })

    await runGraph(compiled.stream('run-1', { value: 5 }))
    await runGraph(compiled.stream('run-1', (s) => ({ ...s, value: 20 })))

    expect(isResumeValues).toEqual([false, true])
  })
})

describe('Middleware - Node Middleware', () => {
  test('node middleware wraps each node execution', async () => {
    const order: string[] = []

    const g = graph<{ value: number }>()
      .node('a', () => { order.push('exec-a') })
      .node('b', () => { order.push('exec-b') })
      .edge('START', 'a')
      .edge('a', 'b')
      .edge('b', 'END')
      .use({
        node: async (ctx, next) => {
          order.push(`before-${ctx.nodeId}`)
          await next()
          order.push(`after-${ctx.nodeId}`)
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(order).toEqual([
      'before-a', 'exec-a', 'after-a',
      'before-b', 'exec-b', 'after-b'
    ])
  })

  test('node middleware receives correct nodeId', async () => {
    const nodeIds: string[] = []

    const g = graph<{ value: number }>()
      .node('first', () => { })
      .node('second', () => { })
      .edge('START', 'first')
      .edge('first', 'second')
      .edge('second', 'END')
      .use({
        node: async (ctx, next) => {
          nodeIds.push(ctx.nodeId)
          await next()
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(nodeIds).toEqual(['first', 'second'])
  })

  test('node middleware skips START and END built-in nodes', async () => {
    const nodeIds: string[] = []

    const g = graph<{ value: number }>()
      .node('a', () => { })
      .edge('START', 'a')
      .edge('a', 'END')
      .use({
        node: async (ctx, next) => {
          nodeIds.push(ctx.nodeId)
          await next()
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(nodeIds).not.toContain('START')
    expect(nodeIds).not.toContain('END')
    expect(nodeIds).toEqual(['a'])
  })

  test('node middleware isSubgraph is false for regular nodes', async () => {
    let isSubgraph: boolean | undefined

    const g = graph<{ value: number }>()
      .node('a', () => { })
      .edge('START', 'a')
      .edge('a', 'END')
      .use({
        node: async (ctx, next) => {
          isSubgraph = ctx.isSubgraph
          await next()
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(isSubgraph).toBe(false)
  })
})

describe('Middleware - State Middleware', () => {
  test('state middleware intercepts state updates', async () => {
    const interceptedUpdates: any[] = []

    const g = graph<{ value: number }>()
      .node('updater', async ({ update }) => {
        await update({ value: 42 })
      })
      .edge('START', 'updater')
      .edge('updater', 'END')
      .use({
        state: async (ctx, next) => {
          interceptedUpdates.push({ ...ctx.resolvedUpdate })
          return next()
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(interceptedUpdates).toEqual([{ value: 42 }])
  })

  test('state middleware can modify the resolved update', async () => {
    let finalState: { value: number } | undefined

    const g = graph<{ value: number }>()
      .node('updater', async ({ update }) => {
        await update({ value: 10 })
      })
      .node('reader', ({ state }) => {
        finalState = state()
      })
      .edge('START', 'updater')
      .edge('updater', 'reader')
      .edge('reader', 'END')
      .use({
        state: async (ctx, next) => {
          const result = await next()
          return { ...result, value: (result.value as number) * 2 }
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(finalState?.value).toBe(20)
  })

  test('state middleware can reject updates by returning empty', async () => {
    let finalState: { value: number } | undefined

    const g = graph<{ value: number }>()
      .node('updater', async ({ update }) => {
        await update({ value: 999 })
      })
      .node('reader', ({ state }) => {
        finalState = state()
      })
      .edge('START', 'updater')
      .edge('updater', 'reader')
      .edge('reader', 'END')
      .use({
        state: async (_ctx, _next) => {
          // Don't call next, return empty partial to block the update
          return {}
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(finalState?.value).toBe(0)
  })

  test('state middleware receives correct context', async () => {
    let receivedCtx: any

    const g = graph<{ value: number }>()
      .node('updater', async ({ update }) => {
        await update({ value: 42 })
      })
      .edge('START', 'updater')
      .edge('updater', 'END')
      .use({
        state: async (ctx, next) => {
          receivedCtx = {
            runId: ctx.runId,
            nodeId: ctx.nodeId,
            currentState: { ...ctx.currentState },
            resolvedUpdate: { ...ctx.resolvedUpdate }
          }
          return next()
        }
      })

    await runGraph(g.compile().stream('test-run', { value: 0 }))

    expect(receivedCtx.runId).toBe('test-run')
    expect(receivedCtx.nodeId).toBe('updater')
    expect(receivedCtx.currentState).toEqual({ value: 0 })
    expect(receivedCtx.resolvedUpdate).toEqual({ value: 42 })
  })
})

describe('Middleware - Composition', () => {
  test('multiple middleware stack correctly (outermost first)', async () => {
    const order: string[] = []

    const g = graph<{ value: number }>()
      .node('a', () => { order.push('exec') })
      .edge('START', 'a')
      .edge('a', 'END')
      .use({
        node: async (ctx, next) => {
          order.push('mw1-before')
          await next()
          order.push('mw1-after')
        }
      })
      .use({
        node: async (ctx, next) => {
          order.push('mw2-before')
          await next()
          order.push('mw2-after')
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(order).toEqual([
      'mw1-before',
      'mw2-before',
      'exec',
      'mw2-after',
      'mw1-after'
    ])
  })

  test('multiple state middleware compose in order', async () => {
    let finalState: { value: number } | undefined

    const g = graph<{ value: number }>()
      .node('updater', async ({ update }) => {
        await update({ value: 10 })
      })
      .node('reader', ({ state }) => {
        finalState = state()
      })
      .edge('START', 'updater')
      .edge('updater', 'reader')
      .edge('reader', 'END')
      .use({
        state: async (ctx, next) => {
          const result = await next()
          return { ...result, value: (result.value as number) + 1 }
        }
      })
      .use({
        state: async (ctx, next) => {
          const result = await next()
          return { ...result, value: (result.value as number) * 2 }
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    // Inner: value=10, mw2 (inner): 10*2=20, mw1 (outer): 20+1=21
    expect(finalState?.value).toBe(21)
  })

  test('graph, node, and state middleware all work together', async () => {
    const order: string[] = []
    let finalState: { value: number } | undefined

    const g = graph<{ value: number }>()
      .node('a', async ({ update }) => {
        order.push('exec-a')
        await update({ value: 100 })
      })
      .node('reader', ({ state }) => {
        finalState = state()
      })
      .edge('START', 'a')
      .edge('a', 'reader')
      .edge('reader', 'END')
      .use({
        graph: async (ctx, next) => {
          order.push('graph-before')
          await next()
          order.push('graph-after')
        },
        node: async (ctx, next) => {
          order.push(`node-before-${ctx.nodeId}`)
          await next()
          order.push(`node-after-${ctx.nodeId}`)
        },
        state: async (ctx, next) => {
          order.push('state-intercept')
          return next()
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(order).toContain('graph-before')
    expect(order).toContain('graph-after')
    expect(order).toContain('node-before-a')
    expect(order).toContain('node-after-a')
    expect(order).toContain('state-intercept')
    expect(order).toContain('exec-a')
    expect(finalState?.value).toBe(100)
  })
})

describe('Middleware - Error Handling', () => {
  test('middleware can catch and rethrow errors', async () => {
    const errors: Error[] = []

    const g = graph<{ value: number }>()
      .node('failing', () => {
        throw new Error('node error')
      })
      .edge('START', 'failing')
      .edge('failing', 'END')
      .use({
        node: async (ctx, next) => {
          try {
            await next()
          } catch (error) {
            errors.push(error as Error)
            throw error
          }
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(errors.length).toBe(1)
    expect(errors[0]!.message).toBe('node error')
  })

  test('middleware retry pattern', async () => {
    let attempts = 0

    const g = graph<{ value: number }>()
      .node('flaky', () => {
        attempts++
        if (attempts < 3) throw new Error('flaky')
      })
      .edge('START', 'flaky')
      .edge('flaky', 'END')
      .use({
        node: async (ctx, next) => {
          for (let i = 0; i < 3; i++) {
            try {
              await next()
              return
            } catch (error) {
              if (i === 2) throw error
            }
          }
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(attempts).toBe(3)
  })
})

describe('Middleware - Suspense', () => {
  test('SuspenseError flows through node middleware', async () => {
    const caughtSuspense: boolean[] = []

    const g = graph<{ value: number }>()
      .node('suspender', ({ suspense }) => {
        suspense({ reason: 'test' })
      })
      .edge('START', 'suspender')
      .edge('suspender', 'END')
      .use({
        node: async (ctx, next) => {
          try {
            await next()
          } catch (error) {
            caughtSuspense.push(error instanceof SuspenseError)
            throw error
          }
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(caughtSuspense).toEqual([true])
  })
})

describe('Middleware - Subgraphs', () => {
  test('node middleware fires for subgraph nodes with isSubgraph=true', async () => {
    const nodeMiddlewareCalls: Array<{ nodeId: string; isSubgraph: boolean }> = []

    type ChildState = { childVal: number }
    type ParentState = { parentVal: number }

    const childGraph = graph<ChildState>()
      .node('childNode', () => { })
      .edge('START', 'childNode')
      .edge('childNode', 'END')

    const parentGraph = graph<ParentState>()
      .node('before', () => { })
      .graph('sub', childGraph, {
        input: () => ({ childVal: 0 }),
        output: () => ({})
      })
      .edge('START', 'before')
      .edge('before', 'sub')
      .edge('sub', 'END')
      .use({
        node: async (ctx, next) => {
          nodeMiddlewareCalls.push({ nodeId: ctx.nodeId, isSubgraph: ctx.isSubgraph })
          await next()
        }
      })

    await runGraph(parentGraph.compile().stream('run-1', { parentVal: 0 }))

    // 'before' with isSubgraph=false, 'sub' with isSubgraph=true, 'childNode' inside subgraph
    const beforeCall = nodeMiddlewareCalls.find(c => c.nodeId === 'before')
    const subCall = nodeMiddlewareCalls.find(c => c.nodeId === 'sub')
    const childCall = nodeMiddlewareCalls.find(c => c.nodeId === 'childNode')

    expect(beforeCall?.isSubgraph).toBe(false)
    expect(subCall?.isSubgraph).toBe(true)
    expect(childCall).toBeDefined() // child node middleware fires because it propagates
  })

  test('state middleware propagates to subgraph child runners', async () => {
    const stateUpdates: Array<{ nodeId: string | null }> = []

    type ChildState = { childVal: number }
    type ParentState = { parentVal: number }

    const childGraph = graph<ChildState>()
      .node('childUpdater', async ({ update }) => {
        await update({ childVal: 42 })
      })
      .edge('START', 'childUpdater')
      .edge('childUpdater', 'END')

    const parentGraph = graph<ParentState>()
      .graph('sub', childGraph, {
        input: () => ({ childVal: 0 }),
        output: (child) => ({ parentVal: child.childVal })
      })
      .edge('START', 'sub')
      .edge('sub', 'END')
      .use({
        state: async (ctx, next) => {
          stateUpdates.push({ nodeId: ctx.nodeId })
          return next()
        }
      })

    await runGraph(parentGraph.compile().stream('run-1', { parentVal: 0 }))

    // State middleware should fire for childUpdater's update inside the subgraph
    expect(stateUpdates.some(u => u.nodeId === 'childUpdater')).toBe(true)
  })

  test('state middleware intercepts and transforms subgraph output update', async () => {
    let finalState: { parentVal: number } | undefined
    const stateUpdates: Array<{ nodeId: string | null; resolvedUpdate: any }> = []

    type ChildState = { childVal: number }
    type ParentState = { parentVal: number }

    const childGraph = graph<ChildState>()
      .node('childNode', async ({ update }) => {
        await update({ childVal: 50 })
      })
      .edge('START', 'childNode')
      .edge('childNode', 'END')

    const parentGraph = graph<ParentState>()
      .graph('sub', childGraph, {
        input: () => ({ childVal: 0 }),
        output: (child) => ({ parentVal: child.childVal })
      })
      .node('reader', ({ state }) => {
        finalState = state()
      })
      .edge('START', 'sub')
      .edge('sub', 'reader')
      .edge('reader', 'END')
      .use({
        state: async (ctx, next) => {
          stateUpdates.push({ nodeId: ctx.nodeId, resolvedUpdate: { ...ctx.resolvedUpdate } })
          const result = await next()
          // Double any parentVal update coming from the subgraph output
          if ('parentVal' in result) {
            return { ...result, parentVal: (result.parentVal as number) * 2 }
          }
          return result
        }
      })

    await runGraph(parentGraph.compile().stream('run-1', { parentVal: 0 }))

    // Middleware should have seen the subgraph output update with nodeId='sub'
    const subUpdate = stateUpdates.find(u => u.nodeId === 'sub')
    expect(subUpdate).toBeDefined()
    expect(subUpdate!.resolvedUpdate).toEqual({ parentVal: 50 })

    // Final state should reflect middleware transformation (50 * 2 = 100)
    expect(finalState?.parentVal).toBe(100)
  })

  test('graph middleware does NOT propagate to subgraphs', async () => {
    let graphMiddlewareCallCount = 0

    type ChildState = { childVal: number }
    type ParentState = { parentVal: number }

    const childGraph = graph<ChildState>()
      .node('childNode', () => { })
      .edge('START', 'childNode')
      .edge('childNode', 'END')

    const parentGraph = graph<ParentState>()
      .graph('sub', childGraph, {
        input: () => ({ childVal: 0 }),
        output: () => ({})
      })
      .edge('START', 'sub')
      .edge('sub', 'END')
      .use({
        graph: async (ctx, next) => {
          graphMiddlewareCallCount++
          await next()
        }
      })

    await runGraph(parentGraph.compile().stream('run-1', { parentVal: 0 }))

    // Graph middleware should only fire once for the parent, not for the child
    expect(graphMiddlewareCallCount).toBe(1)
  })
})

describe('Middleware - update() returns Promise<void>', () => {
  test('update() works without await (backward compat at runtime)', async () => {
    let finalState: { value: number } | undefined

    const g = graph<{ value: number }>()
      .node('updater', ({ update }) => {
        // Not awaiting update - should still work at runtime
        update({ value: 42 })
      })
      .node('reader', ({ state }) => {
        finalState = state()
      })
      .edge('START', 'updater')
      .edge('updater', 'reader')
      .edge('reader', 'END')

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(finalState?.value).toBe(42)
  })

  test('update() can be awaited', async () => {
    let finalState: { value: number } | undefined

    const g = graph<{ value: number }>()
      .node('updater', async ({ update }) => {
        await update({ value: 42 })
      })
      .node('reader', ({ state }) => {
        finalState = state()
      })
      .edge('START', 'updater')
      .edge('updater', 'reader')
      .edge('reader', 'END')

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(finalState?.value).toBe(42)
  })
})

describe('Middleware - Un-awaited update() with async state middleware', () => {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

  test('un-awaited update() + async state middleware → successor reads correct state', async () => {
    let finalState: { value: number } | undefined

    const g = graph<{ value: number }>()
      .node('updater', ({ update }) => {
        // Fire-and-forget: do NOT await
        update({ value: 42 })
      })
      .node('reader', ({ state }) => {
        finalState = state()
      })
      .edge('START', 'updater')
      .edge('updater', 'reader')
      .edge('reader', 'END')
      .use({
        state: async (ctx, next) => {
          await delay(10) // async middleware with small delay
          return next()
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(finalState?.value).toBe(42)
  })

  test('multiple un-awaited update() calls all settle', async () => {
    let finalState: { a: number; b: number } | undefined

    const g = graph<{ a: number; b: number }>()
      .node('updater', ({ update }) => {
        // Fire-and-forget both
        update({ a: 1 })
        update({ b: 2 })
      })
      .node('reader', ({ state }) => {
        finalState = state()
      })
      .edge('START', 'updater')
      .edge('updater', 'reader')
      .edge('reader', 'END')
      .use({
        state: async (ctx, next) => {
          await delay(10)
          return next()
        }
      })

    await runGraph(g.compile().stream('run-1', { a: 0, b: 0 }))

    expect(finalState?.a).toBe(1)
    expect(finalState?.b).toBe(2)
  })

  test('dynamic routing correct with un-awaited update() + async state middleware', async () => {
    const visited: string[] = []

    const g = graph<{ path: string }>()
      .node('setter', ({ update }) => {
        // Fire-and-forget
        update({ path: 'right' })
      })
      .node('left', () => { visited.push('left') })
      .node('right', () => { visited.push('right') })
      .edge('START', 'setter')
      .edge('setter', (s) => s.path as 'left' | 'right')
      .edge('left', 'END')
      .edge('right', 'END')
      .use({
        state: async (ctx, next) => {
          await delay(10)
          return next()
        }
      })

    await runGraph(g.compile().stream('run-1', { path: 'left' }))

    expect(visited).toEqual(['right'])
  })

  test('event ordering: state event emitted before node:end', async () => {
    const events: string[] = []

    const g = graph<{ value: number }>()
      .node('updater', ({ update }) => {
        // Fire-and-forget
        update({ value: 99 })
      })
      .edge('START', 'updater')
      .edge('updater', 'END')
      .use({
        state: async (ctx, next) => {
          await delay(10)
          return next()
        }
      })

    await g.compile().execute('run-1', { value: 0 }, {
      onEvent: (event) => {
        if (event.type === 'state' || (event.type === 'node:end' && event.nodeId === 'updater')) {
          events.push(event.type)
        }
      }
    })

    const stateIdx = events.indexOf('state')
    const nodeEndIdx = events.indexOf('node:end')
    // Filter out the initial state event emitted at context creation
    const stateEvents = events.filter(e => e === 'state')
    const lastStateIdx = events.lastIndexOf('state')

    expect(stateEvents.length).toBeGreaterThanOrEqual(1)
    expect(lastStateIdx).toBeLessThan(nodeEndIdx)
  })
})

describe('Middleware - Event Middleware', () => {
  test('event middleware intercepts all events', async () => {
    const intercepted: any[] = []

    const g = graph<{ value: number }>()
      .node('a', ({ update }) => { update({ value: 42 }) })
      .edge('START', 'a')
      .edge('a', 'END')
      .use({
        event: (event, next) => {
          intercepted.push(event)
          next()
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    const types = intercepted.map(e => e.type)
    expect(types).toContain('state')
    expect(types).toContain('node:start')
    expect(types).toContain('node:end')
  })

  test('event middleware can suppress events', async () => {
    const events: Array<{ type: string; data: unknown }> = []

    const g = graph<{ value: number }>()
      .node('a', () => { })
      .edge('START', 'a')
      .edge('a', 'END')
      .use({
        event: (event, next) => {
          // Suppress node:start events for START built-in
          if (event.type === 'node:start' && event.nodeId === 'START') return
          next()
        }
      })

    const stream = g.compile().stream('run-1', { value: 0 })
    const reader = stream.getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && typeof value === 'object' && 'type' in value) {
        events.push(value as { type: string; data: unknown })
      }
    }

    // The START node-start event should have been suppressed
    const startNodeStarts = events.filter(
      e => e.type === 'data-node-start' && e.data === 'START'
    )
    expect(startNodeStarts.length).toBe(0)
  })

  test('event middleware composes in order', async () => {
    const order: string[] = []

    const g = graph<{ value: number }>()
      .node('a', () => { })
      .edge('START', 'a')
      .edge('a', 'END')
      .use({
        event: (event, next) => {
          if (event.type === 'node:start' && event.nodeId === 'a') {
            order.push('mw1')
          }
          next()
        }
      })
      .use({
        event: (event, next) => {
          if (event.type === 'node:start' && event.nodeId === 'a') {
            order.push('mw2')
          }
          next()
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(order).toEqual(['mw1', 'mw2'])
  })

  test('event middleware works with headless execute()', async () => {
    const intercepted: any[] = []

    const g = graph<{ value: number }>()
      .node('a', ({ update }) => { update({ value: 42 }) })
      .edge('START', 'a')
      .edge('a', 'END')
      .use({
        event: (event, next) => {
          intercepted.push(event)
          next()
        }
      })

    const state = await g.compile().execute('run-1', { value: 0 })

    expect(state.value).toBe(42)
    const types = intercepted.map(e => e.type)
    expect(types).toContain('state')
    expect(types).toContain('node:start')
    expect(types).toContain('node:end')
  })

  test('event middleware + stream() confirms events flow through middleware before reaching stream', async () => {
    const middlewareEvents: any[] = []
    const streamEvents: Array<{ type: string; data: unknown }> = []

    const g = graph<{ value: number }>()
      .node('a', ({ update }) => { update({ value: 10 }) })
      .edge('START', 'a')
      .edge('a', 'END')
      .use({
        event: (event, next) => {
          middlewareEvents.push({ ...event, interceptedAt: 'middleware' })
          next()
        }
      })

    const stream = g.compile().stream('run-1', { value: 0 })
    const reader = stream.getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value && typeof value === 'object' && 'type' in value) {
        streamEvents.push(value as { type: string; data: unknown })
      }
    }

    // Middleware should have seen all events that ended up in the stream
    expect(middlewareEvents.length).toBeGreaterThan(0)
    expect(streamEvents.length).toBeGreaterThan(0)

    // Every stream event should have a corresponding middleware interception
    const nodeStartsInStream = streamEvents.filter(e => e.type === 'data-node-start')
    const nodeStartsInMiddleware = middlewareEvents.filter(e => e.type === 'node:start')
    expect(nodeStartsInMiddleware.length).toBe(nodeStartsInStream.length)
  })

  test('event middleware can observe suspense events', async () => {
    const suspenseEvents: any[] = []

    const g = graph<{ value: number }>()
      .node('suspender', ({ suspense }) => {
        suspense({ reason: 'waiting' })
      })
      .edge('START', 'suspender')
      .edge('suspender', 'END')
      .use({
        event: (event, next) => {
          if (event.type === 'node:suspense') {
            suspenseEvents.push(event)
          }
          next()
        }
      })

    await runGraph(g.compile().stream('run-1', { value: 0 }))

    expect(suspenseEvents.length).toBe(1)
    expect(suspenseEvents[0].nodeId).toBe('suspender')
    expect(suspenseEvents[0].data.reason).toBe('waiting')
  })
})
