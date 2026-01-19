# ai-sdk-graph

## 0.1.3

### Patch Changes

- a9d4557: Add `onStart` callback and improve `onFinish` callback signature
  - Added new optional `onStart` callback to Graph constructor for pre-execution handling, receives `{ state, writer }`
  - Changed `onFinish` callback signature to accept `{ state }` object instead of `state` directly for improved clarity and consistency

## 0.1.2

### Patch Changes

- Add onFinish hook to graph
