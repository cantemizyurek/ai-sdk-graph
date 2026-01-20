---
"ai-sdk-graph": patch
---

Fix `onFinish` callback not being called due to shadowed context variable

The execution context was being shadowed by a destructuring assignment, preventing the outer `context` variable from being set. This caused `onFinish` to never run since it relies on the context being defined. The fix properly assigns the context to the outer scope variable.
