# Architecture

## Two-Phase Design: Definition vs Execution

The core architecture separates graph definition from execution:

1. **`Graph`** (`src/graph.ts`) — Builder class. Registers nodes, edges, and subgraphs. Does not execute anything. Calling `.compile(options)` produces a `CompiledGraph`.

2. **`CompiledGraph`** (`src/compiled-graph.ts`) — Execution engine. Takes the registries from `Graph` plus compile options (storage, callbacks). `.execute(runId, initialState)` returns a `ReadableStream` via AI SDK's `createUIMessageStream`.

This separation allows a single graph definition to be compiled multiple times with different storage backends or callbacks.

## Execution Model

- Execution starts at the built-in `START` node and follows edges until reaching `END`.
- Nodes connected to the same source execute **in parallel** (via `Promise.all`).
- Edges can be **static** (string target) or **dynamic** (function of state -> target), enabling conditional routing.
- State updates are partial merges (`Partial<State>` or `(state) => Partial<State>`), broadcast to the stream as `data-state` events.

## Streaming Protocol

The stream emits four custom data part types consumed by the client:
- `data-state` — current state snapshot after each update
- `data-node-start` / `data-node-end` — node lifecycle events
- `data-node-suspense` — signals a node suspended for human input

## Suspense & Resumption

Nodes can call `suspense(data?)` to throw a `SuspenseError`, pausing execution. The graph persists a checkpoint (current nodes + suspended nodes + state) to storage. On the next `.execute()` call with the same `runId`, execution resumes from the checkpoint.

## Subgraphs

Registered via `.graph(id, childGraph, { input, output })`. The `input` function maps parent state to child state; `output` maps child's final state back to parent state. Subgraphs execute internally (not as a separate stream) and share the parent's storage instance.

## Storage

`GraphStorage` interface with two implementations:
- `InMemoryStorage` — default, ephemeral (used in tests and simple cases)
- `RedisStorage` — production persistence via `ioredis`

## React Integration

`src/react.ts` exports `useGraphChat<State>()`, a hook wrapping `@ai-sdk/react`'s `useChat` that parses the custom data parts into `state`, `activeNodes`, and suspense tracking. This is a separate bundle entry point (`ai-sdk-graph/react`).

## Types

All public types live in the `GraphSDK` namespace in `src/types.ts`. Key types: `StateUpdate`, `Node`, `Edge`, `Checkpoint`, `ExecutionContext`, `GraphStorage`, `CompileOptions`.
