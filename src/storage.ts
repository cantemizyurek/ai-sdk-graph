import Redis from 'ioredis'
import type { GraphSDK } from './types'

export class InMemoryStorage<
  State extends Record<string, unknown>,
  NodeKeys extends string
> implements GraphSDK.GraphStorage<State, NodeKeys>
{
  private store = new Map<string, GraphSDK.Checkpoint<State, NodeKeys>>()

  async save(runId: string, checkpoint: GraphSDK.Checkpoint<State, NodeKeys>) {
    this.store.set(runId, checkpoint)
  }

  async load(runId: string) {
    return this.store.get(runId) ?? null
  }

  async delete(runId: string) {
    this.store.delete(runId)
  }
}

export class RedisStorage<
  State extends Record<string, unknown>,
  NodeKeys extends string
> implements GraphSDK.GraphStorage<State, NodeKeys>
{
  private redis: Redis

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl)
  }

  async save(runId: string, checkpoint: GraphSDK.Checkpoint<State, NodeKeys>) {
    await this.redis.set(runId, JSON.stringify(checkpoint))
  }

  async load(runId: string) {
    const data = await this.redis.get(runId)
    return data ? (JSON.parse(data) as GraphSDK.Checkpoint<State, NodeKeys>) : null
  }

  async delete(runId: string) {
    await this.redis.del(runId)
  }
}
