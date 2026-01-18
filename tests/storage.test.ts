import { test, expect, describe, jest, mock } from 'bun:test'
import { InMemoryStorage } from '../src/storage'

mock.module('ioredis', () => ({
  default: class MockRedis {
    set = jest.fn().mockResolvedValue('OK')
    get = jest.fn().mockResolvedValue(null)
    del = jest.fn().mockResolvedValue(1)
  }
}))

const { RedisStorage } = await import('../src/storage')

describe('InMemoryStorage', () => {
  test('save and load checkpoint', async () => {
    const storage = new InMemoryStorage<{ value: number }, 'a' | 'b'>()
    const checkpoint = {
      state: { value: 42 },
      nodeIds: ['a' as const],
      suspendedNodes: ['b' as const]
    }

    await storage.save('run-1', checkpoint)
    const loaded = await storage.load('run-1')

    expect(loaded).toEqual(checkpoint)
  })

  test('load returns null for non-existent runId', async () => {
    const storage = new InMemoryStorage<{ value: number }, string>()

    const result = await storage.load('non-existent')

    expect(result).toBeNull()
  })

  test('delete removes checkpoint', async () => {
    const storage = new InMemoryStorage<{ value: number }, string>()
    await storage.save('run-1', { state: { value: 1 }, nodeIds: [], suspendedNodes: [] })

    await storage.delete('run-1')
    const result = await storage.load('run-1')

    expect(result).toBeNull()
  })

  test('delete on non-existent runId does not throw', async () => {
    const storage = new InMemoryStorage<{ value: number }, string>()

    await storage.delete('non-existent')
  })

  test('overwrite existing checkpoint', async () => {
    const storage = new InMemoryStorage<{ value: number }, string>()
    await storage.save('run-1', { state: { value: 1 }, nodeIds: ['a'], suspendedNodes: [] })
    await storage.save('run-1', { state: { value: 2 }, nodeIds: ['b'], suspendedNodes: [] })

    const result = await storage.load('run-1')

    expect(result?.state.value).toBe(2)
    expect(result?.nodeIds).toEqual(['b'])
  })
})

describe('RedisStorage', () => {
  test('save stores checkpoint as JSON', async () => {
    const mockSet = jest.fn().mockResolvedValue('OK')
    const mockGet = jest.fn()
    const mockDel = jest.fn()

    const storage = new RedisStorage<{ value: number }, 'a' | 'b'>('redis://localhost')
    ;(storage as any).redis = {
      set: mockSet,
      get: mockGet,
      del: mockDel
    }

    const checkpoint = {
      state: { value: 42 },
      nodeIds: ['a' as const],
      suspendedNodes: ['b' as const]
    }

    await storage.save('run-1', checkpoint)

    expect(mockSet).toHaveBeenCalledWith('run-1', JSON.stringify(checkpoint))
  })

  test('load returns parsed checkpoint', async () => {
    const checkpoint = {
      state: { value: 42 },
      nodeIds: ['a' as const],
      suspendedNodes: ['b' as const]
    }
    const mockGet = jest.fn().mockResolvedValue(JSON.stringify(checkpoint))

    const storage = new RedisStorage<{ value: number }, 'a' | 'b'>('redis://localhost')
    ;(storage as any).redis = {
      get: mockGet,
      set: jest.fn(),
      del: jest.fn()
    }

    const result = await storage.load('run-1')

    expect(mockGet).toHaveBeenCalledWith('run-1')
    expect(result).toEqual(checkpoint)
  })

  test('load returns null when key does not exist', async () => {
    const mockGet = jest.fn().mockResolvedValue(null)

    const storage = new RedisStorage<{ value: number }, string>('redis://localhost')
    ;(storage as any).redis = {
      get: mockGet,
      set: jest.fn(),
      del: jest.fn()
    }

    const result = await storage.load('non-existent')

    expect(result).toBeNull()
  })

  test('delete removes checkpoint', async () => {
    const mockDel = jest.fn().mockResolvedValue(1)

    const storage = new RedisStorage<{ value: number }, string>('redis://localhost')
    ;(storage as any).redis = {
      get: jest.fn(),
      set: jest.fn(),
      del: mockDel
    }

    await storage.delete('run-1')

    expect(mockDel).toHaveBeenCalledWith('run-1')
  })
})
