---
"ai-sdk-graph": minor
---

Add React integration with `useGraphChat` hook

- New `ai-sdk-graph/react` export with `useGraphChat` hook that wraps `@ai-sdk/react`'s `useChat`
- Automatically handles graph-specific data parts: state changes, node start/end, and suspense events
- Exposes `state` and `activeNodes` from the hook for tracking graph execution
- Added utility functions `isGraphDataPart` and `stripGraphDataParts` to filter graph data parts from messages
- Added optional peer dependencies for `react` and `@ai-sdk/react`
