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
