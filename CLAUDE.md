# CLAUDE.md

TypeScript library for building resumable, type-safe graph-based workflows on top of the Vercel AI SDK.

## Commands

- **Build:** `bun run build`
- **Test:** `bun test` (single file: `bun test tests/<file>.test.ts`)
- **Format:** `bunx prettier --write .`
- **Release:** `bun run release`
- **Version bump:** `bun run changeset` then `bun run version`

## Plan Mode

- Make the plan extremely concise. Sacrifice grammar for the sake of concision.
- At the end of each plan, give me a list of unresolved questions to answer, if any.

## Docs

- [Architecture](.claude/docs/architecture.md) — two-phase design, execution model, streaming, suspense, storage
