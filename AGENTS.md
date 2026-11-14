# AGENTS.md

## MCP

- When changing MCP behavior, update tool descriptions and server instructions in `src/server.ts`.
- When logging, use stderr; stdout carries only MCP messages.

## Kimai API

- When changing writes, never retry automatically. Report uncertain outcomes as `UNKNOWN OUTCOME`.
- When resolving names, use collections; detail endpoints can return 403. Lookup failures must not fail successful writes.
- When filtering projects or activities, recheck IDs locally; Kimai can ignore unknown filters.
- When caching, store display labels only; keep entry, timer, and permission reads live.

## Dates and summaries

- When handling dates, use the account timezone. Ranges match entry start times; reject skipped or repeated DST times.
- When changing summaries, fetch every page, verify counts and unique IDs, and exclude running entries from totals.

## Credentials

- When handling credentials, keep secrets out of tracked files and logs.

## Readability

- Separate logical phases with one blank line; keep closely related statements together.
- Always use braces for control flow. Avoid nested ternaries and dense expressions; use clear intermediate names.
- Review readability separately from correctness. Do not introduce helpers or abstractions merely to satisfy size limits.
- Use `npm run lint:fix` for automatic lint fixes, then `npm run format`.

## Tooling

- Build and typecheck scripts select TypeScript 7 explicitly through the `@typescript/native` npm alias.
- Keep the separate `typescript` dependency on 6.0.x for the API required by typescript-eslint.

## Validation

- When validating changes, run relevant offline checks: `npm run typecheck`, `npm test`, `npm run format:check`, `npm run lint`, `npm run build`.
- When running tests, enforce memory, CPU, and time limits for the whole process tree. Live API calls require an explicit request.
