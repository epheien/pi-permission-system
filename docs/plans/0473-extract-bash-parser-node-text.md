---
issue: 473
issue_title: "pi-permission-system: extract the tree-sitter parser and AST node-text resolver from bash-program.ts (Phase 6 Step 1)"
---

# Extract the tree-sitter parser and AST node-text resolver from `bash-program.ts`

## Release Recommendation

**Release:** mid-batch — defer (batch "bash-program-decomposition"); confirm at ship time

This is Step 1 of three in batch "bash-program-decomposition" (Steps 1 (#473), 2 [#474], 3 [#475]; tail = Step 3).
The roadmap batches the decomposition so it releases once rather than as three internal-only patch releases, so this step lands on `main` but does not cut a release on its own.
A subtle consequence to flag for the Step 3 ship decision: all three steps are pure `refactor:` extractions, and `refactor` is `hidden` / non-version-bumping under `release-please-config.json` — so the batch produces **no** release unless Step 3 carries a `feat:`/`fix:` commit or the maintainer accepts no version bump for the internal decomposition.

## Problem Statement

`src/handlers/gates/bash-program.ts` is 1,143 LOC and the package's #1 churn × complexity hotspot (fallow risk 97.0).
It mixes at least five concerns: tree-sitter parser bootstrap, AST traversal, the `BashProgram` value-object API, token collection, command enumeration, and the `cd`-fold projection.
The decomposition (Phase 6, Track A) starts with the two leaf utilities that have no dependency on the rest of the file: the lazy tree-sitter parser and the quote-aware node-text resolver.
Landing them in a new `src/access-intent/bash/` directory seeds the package's first domain directory, so the extracted modules reach their final home the first time instead of being moved twice.

## Goals

- Move the lazy tree-sitter parser (`getParser`, the `TSNode` / `TSParser` interfaces, `initParser`) from `bash-program.ts` into `src/access-intent/bash/parser.ts`.
- Move the quote-aware node-text resolver (`resolveNodeText`) and `SKIP_SUBTREE_TYPES` into `src/access-intent/bash/node-text.ts`.
- Leave `bash-program.ts` importing both from their new homes — pure lift-and-shift, no behavior change.
- Add the new unit tests the extraction enables: `resolveNodeText` quote-resolution cases and a `getParser` parse/memoization smoke test.
- Keep the seeded directory's final shape (`src/access-intent/bash/`) so Steps 2 and 3 extend it rather than relocate it.

This change is **not** breaking: the moved symbols are file-private (`bash-program.ts` never exported them), no package public API, config field, schema, or observable output changes.

## Non-Goals

- Token collection (`PATTERN_FIRST_COMMANDS`, the flag classifier, the token collectors) — that is Step 2 ([#474]).
- Command enumeration, the `cd`-fold cwd projection, and relocating the slimmed `BashProgram` — that is Step 3 ([#475]).
- Any behavior change to parsing, AST traversal, quote resolution, or path projection.
- The `AccessPath` value object and external-directory gate unification ([#418]; Track B, Steps 4–6).
- Marking Step 2/3 complete or touching their roadmap entries.

## Background

- `bash-program.ts` (`src/handlers/gates/bash-program.ts`) currently defines, top to bottom: the parser block (interfaces `TSNode`/`TSParser`, `initParser`, the memoized `getParser`), the `BashCommand`/`EffectiveBase` types, the `BashProgram` class, the AST-walker helpers (`SKIP_SUBTREE_TYPES`, `resolveNodeText`), the token-collection block, and the command-enumeration / cwd-projection block.
- `getParser` is `memoizeAsyncWithRetry(initParser)` (from `#src/async-cache`); it memoizes a successful parser and drops a rejected init so a transient WASM load failure is retried ([#452]).
  `BashProgram.parse` calls `await getParser()` once.
- `resolveNodeText` is a pure recursive function over a `TSNode`: it returns the shell value of an argument node after quote removal (`word` → text, `raw_string` → strip single quotes, `string`/`concatenation` → concatenate resolved children, expansions → literal text, default → `.text`).
- `SKIP_SUBTREE_TYPES` (a `Set` of `heredoc_body`, `heredoc_end`, `comment`) is **not** used by `resolveNodeText` itself; it is consumed by the path-candidate collectors and the cwd-projection walkers that stay in `bash-program.ts`.
  Per the issue it moves into `node-text.ts` and `bash-program.ts` imports it back.
- `TSNode` is used pervasively across the file (`extractCommandName`, the token collectors, the command/path walkers, `foldCd`, …), so after the move `bash-program.ts` imports the `TSNode` **type** from `parser.ts`.
- `TSParser` is referenced only by `initParser`'s return type, which moves with it — so it stays module-private in `parser.ts` (not exported), avoiding a fallow dead-code flag for an export with no importer.
- `createRequire` (from `node:module`) and `memoizeAsyncWithRetry` (from `#src/async-cache`) are used **only** by the parser block (verified by grep); both imports become dead in `bash-program.ts` after Cycle 1 and must be removed, or `tsc`/eslint fails on the unused import.
- AGENTS.md / package constraints that apply:
  - Within-package imports use the `#src/` / `#test/` aliases, not relative paths — so the new modules and their cross-references use `#src/access-intent/bash/...`.
  - `@typescript-eslint/require-await` is enabled for `src/`: `initParser` keeps its `await import("web-tree-sitter")`, so it stays `async` (no change).
  - The package skill (`.pi/skills/package-pi-permission-system/SKILL.md`) names `getParser = memoizeAsyncWithRetry(...)` as living "in `bash-program.ts`"; this prose reference goes stale and must be updated to `parser.ts`.
  - `docs/architecture/architecture.md` carries a `src/` layout tree and an `async-cache.ts` line that both reference `bash-program.ts` for the parser; both need updating.

## Design Overview

Two new leaf modules under the seeded domain directory, plus rewired imports in `bash-program.ts`.
This is a legitimate SRP decomposition, not metric-gaming procedure-splitting: the parser **owns state** (the memoized, lazily-initialized `Parser` singleton and its retry semantics), and `resolveNodeText` **returns a value** (a pure transformation of an AST node) — both pass the code-design "owns state / returns a value" test and both have zero dependency on the rest of `bash-program.ts`.
The change introduces no new collaborator, threads no new parameter, and touches no shared interface or layer wiring, so the `design-review` checklist triggers (shared-interface parameter, 5+-field dependency bag, cross-layer wiring) do not fire.

### `src/access-intent/bash/parser.ts`

```typescript
import { createRequire } from "node:module";
import { memoizeAsyncWithRetry } from "#src/async-cache";

/** Minimal subset of web-tree-sitter's SyntaxNode used by the AST walker. */
export interface TSNode {
  readonly type: string;
  readonly text: string;
  readonly childCount: number;
  readonly isNamed: boolean;
  child(index: number): TSNode | null;
}

interface TSParser {
  parse(input: string): { rootNode: TSNode; delete(): void } | null;
  delete(): void;
}

async function initParser(): Promise<TSParser> {
  /* unchanged body — web-tree-sitter init + tree-sitter-bash WASM load */
}

/** Memoize on success but drop a rejected result so a transient init failure is retried (#452). */
export const getParser = memoizeAsyncWithRetry(initParser);
```

`TSNode` is exported (consumed by `node-text.ts` and `bash-program.ts`); `TSParser` and `initParser` stay private.

### `src/access-intent/bash/node-text.ts`

```typescript
import type { TSNode } from "#src/access-intent/bash/parser";

/** Node types whose subtrees are never descended for path extraction. */
export const SKIP_SUBTREE_TYPES = new Set(["heredoc_body", "heredoc_end", "comment"]);

/** Resolve the "shell value" of an argument node after quote removal. */
export function resolveNodeText(node: TSNode): string {
  /* unchanged body */
}
```

### `bash-program.ts` rewiring

```typescript
import { getParser, type TSNode } from "#src/access-intent/bash/parser";
import { resolveNodeText, SKIP_SUBTREE_TYPES } from "#src/access-intent/bash/node-text";
```

Remove the parser block (`TSNode`/`TSParser`/`initParser`/`getParser`), `SKIP_SUBTREE_TYPES`, and `resolveNodeText` definitions, plus the now-dead `createRequire` and `memoizeAsyncWithRetry` imports.
Every internal call site (`await getParser()`, the `resolveNodeText(child)` calls, the `SKIP_SUBTREE_TYPES.has(...)` checks, every `TSNode`-typed signature) keeps its exact call shape — only the symbol's origin changes.

### Extracted-module dependency check

`node-text.ts` depends only on `parser.ts` for the `TSNode` **type** (type-only import, no runtime edge).
`parser.ts` depends only on `#src/async-cache` and the dynamically-imported `web-tree-sitter` / `tree-sitter-bash` WASM.
Neither imports `#src/canonicalize-path`, so unit tests for them do **not** need the canonicalize mock that any test transitively importing `bash-program.ts` requires (retro 0345) — a concrete testability win.
No Tell-Don't-Ask violation, output-argument mutation, or reverse-search pattern is carried across: `resolveNodeText` is already a pure function and `getParser` is already a self-contained memoized factory.

## Module-Level Changes

- NEW `src/access-intent/bash/parser.ts` — exports `TSNode` (interface) and `getParser`; keeps `TSParser` and `initParser` private.
- NEW `src/access-intent/bash/node-text.ts` — exports `resolveNodeText` and `SKIP_SUBTREE_TYPES`; type-imports `TSNode` from `parser.ts`.
- CHANGED `src/handlers/gates/bash-program.ts` — remove the parser block (issue lines ~18–58), `SKIP_SUBTREE_TYPES`, and `resolveNodeText` (issue lines ~273–333); add the two new imports; remove the dead `createRequire` (`node:module`) and `memoizeAsyncWithRetry` (`#src/async-cache`) imports.
  (Line numbers shift after Cycle 1 removes ~40 lines — re-grep for `resolveNodeText` / `SKIP_SUBTREE_TYPES` in Cycle 2 rather than trusting the issue's line ranges.)
- NEW `test/access-intent/bash/parser.test.ts` — `getParser` parse + memoization smoke test.
- NEW `test/access-intent/bash/node-text.test.ts` — `resolveNodeText` quote-resolution unit tests.
- CHANGED `docs/architecture/architecture.md` — three edits:
  1. Add an `access-intent/bash/` subtree (`parser.ts`, `node-text.ts`) to the `src/` layout tree.
  2. Update the `bash-program.ts` layout line: it no longer owns the tree-sitter parser bootstrap or the node-text resolver (parser imported from `access-intent/bash/parser.ts`, node-text from `access-intent/bash/node-text.ts`).
  3. Update the `async-cache.ts` line — `memoizeAsyncWithRetry` is now "used by `parser.ts`" (was `bash-program.ts`) for resilient tree-sitter parser init.
  4. Append `✓ complete` to the roadmap "Step 1 … (#473)" heading line (the step's code lands on `main` with this issue).
- CHANGED `.pi/skills/package-pi-permission-system/SKILL.md` — update the jiti-isolation note: `getParser = memoizeAsyncWithRetry(...)` now lives in `parser.ts`, not `bash-program.ts`.

No `README.md`, schema, config example, or `config-loader` change — this step touches no user-facing command, config field, or output.

## Test Impact Analysis

1. **New tests the extraction enables.**
   `resolveNodeText` was a file-private helper reachable only through the full bash gate pipeline (parse → walk → collect); it now has a public seam testable in isolation against hand-built `TSNode` fakes — covering `word`, `raw_string` (single-quote strip), `string` (double-quote strip + child concatenation, skipping `"` delimiters), `concatenation`, `string_content`/`simple_expansion`/`expansion` (literal passthrough), and the `default` fallback, plus a nested `concatenation`-of-`string` case.
   `getParser` gains a smoke test: parsing `echo hi` yields a non-null root node, and two `getParser()` calls return the identical memoized instance.
2. **Existing tests that become redundant.**
   None.
   No current test targets `resolveNodeText` or `getParser` directly — they are exercised only transitively through the bash gate integration suites — so the new lower-level tests duplicate nothing that can be removed.
3. **Existing tests that must stay as-is.**
   All bash integration suites (`bash-arity.test.ts`, `bash-external-directory.test.ts`, `detect-permissive-bash-fallback.test.ts`, `external-directory-*.test.ts`) stay unchanged — they genuinely exercise the end-to-end `BashProgram` behavior the parser and node-text resolver feed, and they are the regression net proving the move is behavior-preserving.

## Invariants at risk

This step touches `bash-program.ts`, a surface prior phase steps already refactored.
Because the change is a pure symbol move with identical call shapes, the existing suite pins every invariant — no new test is required, but the full suite must stay green to prove preservation:

- `cd`-fold cwd projection across redirect-then-pipe (#454) and effective-working-directory projection (#307) — pinned by `bash-external-directory.test.ts` `externalPaths` projection cases.
- Fail-closed on an unparseable bash command → synthetic `ask` with the `<unparseable-bash-command>` sentinel (#452, #301) — pinned by `detect-permissive-bash-fallback.test.ts`.
- cd-aware `pathRuleCandidates` keeping the literal form after a non-literal `cd` ([#393]) — pinned by the bash path-gate suites.
- Quote-resolution behavior (e.g. `$HOME` returned as the literal text of a `simple_expansion`, retro 0350) — now **also** pinned directly by the new `node-text.test.ts`.

## TDD Order

1. **Cycle 1 — extract the parser.**
   Create `src/access-intent/bash/parser.ts` (move `TSNode`, `TSParser`, `initParser`, `getParser`; export `TSNode` + `getParser`, keep `TSParser`/`initParser` private).
   Rewire `bash-program.ts`: add `import { getParser, type TSNode } from "#src/access-intent/bash/parser"`, delete the moved block, and remove the now-dead `createRequire` and `memoizeAsyncWithRetry` imports.
   Add `test/access-intent/bash/parser.test.ts` (parse `echo hi`; assert memoization identity).
   Verify: `pnpm run check`, `pnpm -r run test` (or package-filtered), `pnpm fallow dead-code` all green.
   Commit: `refactor(pi-permission-system): extract tree-sitter parser to access-intent/bash/parser.ts (#473)`.
2. **Cycle 2 — extract the node-text resolver.**
   Re-grep `bash-program.ts` for `resolveNodeText` / `SKIP_SUBTREE_TYPES` (line numbers shifted after Cycle 1).
   Create `src/access-intent/bash/node-text.ts` (move `resolveNodeText` + `SKIP_SUBTREE_TYPES`; type-import `TSNode` from `parser.ts`).
   Rewire `bash-program.ts`: add `import { resolveNodeText, SKIP_SUBTREE_TYPES } from "#src/access-intent/bash/node-text"` and delete the moved definitions.
   Add `test/access-intent/bash/node-text.test.ts` (the quote-resolution cases from Test Impact Analysis #1).
   Verify: same gates green.
   Commit: `refactor(pi-permission-system): extract bash node-text resolver to access-intent/bash/node-text.ts (#473)`.
3. **Cycle 3 — documentation.**
   Apply the four `docs/architecture/architecture.md` edits and the `SKILL.md` update from Module-Level Changes.
   Verify: `pnpm run lint` (rumdl) green.
   Commit: `docs(pi-permission-system): record parser/node-text extraction in architecture and skill (#473)`.

Each cycle leaves the repository compiling and the full suite green — a lift-and-shift has no failing-red phase, so each cycle's "test" step is the new characterization test plus the unchanged regression suite.

## Risks and Mitigations

- **Risk:** a call site keeps a stale local reference and the move silently drops a symbol.
  **Mitigation:** `tsc` (`pnpm run check`) fails on any unresolved `TSNode` / `getParser` / `resolveNodeText` / `SKIP_SUBTREE_TYPES`; the full bash suite proves runtime equivalence.
- **Risk:** the dead `createRequire` / `memoizeAsyncWithRetry` imports linger and fail lint.
  **Mitigation:** Cycle 1 removes them in the same commit; `pnpm run check` + eslint catch a miss immediately.
- **Risk:** exporting `TSParser` with no importer trips fallow dead-code.
  **Mitigation:** keep `TSParser` and `initParser` module-private in `parser.ts`; only `TSNode` and `getParser` are exported (both have importers).
- **Risk:** stale doc/skill prose referencing the parser's old home.
  **Mitigation:** Cycle 3 updates the architecture layout tree, the `async-cache.ts` line, and the `SKILL.md` jiti note; the grep in Module-Level Changes enumerated every reference.
- **Risk:** the batch produces no release because all three steps are `refactor:`.
  **Mitigation:** flagged in Release Recommendation for the Step 3 ship decision — out of scope to resolve here.

## Open Questions

- None blocking.
  The directory seed name (`src/access-intent/bash/`) and the `SKIP_SUBTREE_TYPES` placement (`node-text.ts`) are both fixed by the roadmap and the issue body.

[#393]: https://github.com/gotgenes/pi-packages/issues/393
[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#452]: https://github.com/gotgenes/pi-packages/issues/452
[#474]: https://github.com/gotgenes/pi-packages/issues/474
[#475]: https://github.com/gotgenes/pi-packages/issues/475
