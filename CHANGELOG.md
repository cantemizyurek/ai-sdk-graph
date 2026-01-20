# ai-sdk-graph

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
