---
"ai-sdk-graph": patch
---

Fix TypeScript type error in `consumeAndMergeStream` when using specific tool definitions. The function now accepts `StreamTextResult` with any tool configuration instead of requiring `ToolSet` compatibility.
