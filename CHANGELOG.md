# ai-sdk-graph

## 0.3.1

### Patch Changes

- aed6eea: Export utils module from the main package entry point

## 0.3.0

### Minor Changes

- edc587c: Add `consumeAndMergeStream` utility function

  A new helper function that simplifies consuming AI SDK streams within graph nodes. It merges the stream into the writer and returns a promise that resolves with the final messages when the stream completes.

  ```ts
  const messages = await consumeAndMergeStream(stream, writer)
  ```

  The function includes proper error handling:
  - Rejects the promise when `onError` is triggered by the stream
  - Catches synchronous exceptions from `toUIMessageStream`
  - Returns appropriate error messages for the stream protocol

## 0.2.0

### Minor Changes

- f674edd: Add real-time state streaming via `data-state` events

  State changes are now automatically streamed to the writer whenever state is updated. This enables consumers to receive live state updates during graph execution through the `data-state` event type.
  - State updates via the `update()` function now emit `{ type: 'data-state', data: newState }`
  - Initial state resolution and restoration from checkpoints also emit state events
  - Enables building reactive UIs that respond to state changes in real-time

## 0.1.4

### Patch Changes

- ef71a11: Fix `onFinish` callback not being called due to shadowed context variable

  The execution context was being shadowed by a destructuring assignment, preventing the outer `context` variable from being set. This caused `onFinish` to never run since it relies on the context being defined. The fix properly assigns the context to the outer scope variable.

- fd46a5c: Fix `onStart` callback to only execute on first run, not when restoring from checkpoint

  The `onStart` hook was incorrectly being called every time execution resumed, including when restoring from a checkpoint. This change ensures `onStart` is only invoked during the initial execution of a graph run, which is the expected behavior for initialization logic.

## 0.1.3

### Patch Changes

- a9d4557: Add `onStart` callback and improve `onFinish` callback signature
  - Added new optional `onStart` callback to Graph constructor for pre-execution handling, receives `{ state, writer }`
  - Changed `onFinish` callback signature to accept `{ state }` object instead of `state` directly for improved clarity and consistency

## 0.1.2

### Patch Changes

- Add onFinish hook to graph
