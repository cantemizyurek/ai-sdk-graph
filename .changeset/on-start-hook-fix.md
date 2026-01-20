---
"ai-sdk-graph": patch
---

Fix `onStart` callback to only execute on first run, not when restoring from checkpoint

The `onStart` hook was incorrectly being called every time execution resumed, including when restoring from a checkpoint. This change ensures `onStart` is only invoked during the initial execution of a graph run, which is the expected behavior for initialization logic.
