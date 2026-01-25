---
"ai-sdk-graph": minor
---

Separate Graph and CompiledGraph classes for better separation of concerns

**Breaking Change:** The `graph()` function no longer accepts options. Instead, use `graph().compile(options)` to get an executable graph.

Before:
```typescript
const g = graph<MyState>({ storage, onFinish, onStart })
  .node('a', ...)
  .edge('START', 'a')

const stream = g.execute('run-1', initialState)
```

After:
```typescript
const g = graph<MyState>()
  .node('a', ...)
  .edge('START', 'a')

const compiled = g.compile({ storage, onFinish, onStart })
const stream = compiled.execute('run-1', initialState)
```

This change provides:
- **Clear separation of concerns**: Graph definition is separate from execution configuration
- **Reusability**: Same graph definition can be compiled with different configurations
- **Better testability**: Test graph structure without execution, test execution with mock definitions
