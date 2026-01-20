---
"ai-sdk-graph": minor
---

Add `consumeAndMergeStream` utility function

A new helper function that simplifies consuming AI SDK streams within graph nodes. It merges the stream into the writer and returns a promise that resolves with the final messages when the stream completes.

```ts
const messages = await consumeAndMergeStream(stream, writer)
```
