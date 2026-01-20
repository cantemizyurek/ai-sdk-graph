---
"ai-sdk-graph": minor
---

Add real-time state streaming via `data-state` events

State changes are now automatically streamed to the writer whenever state is updated. This enables consumers to receive live state updates during graph execution through the `data-state` event type.

- State updates via the `update()` function now emit `{ type: 'data-state', data: newState }`
- Initial state resolution and restoration from checkpoints also emit state events
- Enables building reactive UIs that respond to state changes in real-time
