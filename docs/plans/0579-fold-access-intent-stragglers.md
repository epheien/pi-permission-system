---
issue: 579
issue_title: "pi-permission-system: fold access-intent stragglers into src/access-intent/"
---

# Fold the access-intent stragglers into `src/access-intent/`

## Release Recommendation

**Release:** ship independently

Phase 11 Step 1 ([roadmap](../architecture/architecture.md)) carries `Release: independent` — it is not a member of the `shell-tool-aliases` batch (Steps 2–3).
It is a `refactor:` module move with no behavior change, so it is a hidden changelog type: it lands on `main` and auto-batches into the next release rather than cutting one on its own.

## Problem Statement

The access-intent domain — turning `(toolName, input)` into "what is being accessed" — is named in the architecture doc's first-principles section and already has a directory (`src/access-intent/`).
But four of its modules never moved out of the flat `src/` root:

- `src/input-normalizer.ts`
- `src/mcp-targets.ts`
- `src/tool-input-path.ts`
- `src/path-surfaces.ts`

That hides the seam the shell-tool-aliasing steps (Phase 11 Step 3, [#574]) extend, and leaves the flat root at 60 top-level modules.
This is a tidy-first move: Phase 11 Step 3 rewrites `input-normalizer.ts` and `tool-input-path.ts` for aliased command/workdir extraction, so relocating them now lets that work land in its final location instead of moving twice.

## Goals

- Relocate the four modules under `src/access-intent/`, rewriting only their import sites.
- Move the four modules' test files into `test/access-intent/` to preserve the test-tree mirror (operator-confirmed during planning).
- Preserve behavior exactly — the existing (relocated) tests are the regression guard; `tsc` + ESLint catch every missed import.
- Update the architecture doc and the package skill to reference the new locations, and mark Phase 11 Step 1 complete.

This change is **not** breaking: no public export, config default, output shape, or observable behavior changes.
The package's only public `exports` surface is `service.ts`; all four modules are internal.

## Non-Goals

- Moving `bash-advisory-check.ts` into `access-intent/`.
  It composes the service with a gate orchestrator, and a domain module must not import from `handlers/` — it deliberately stays in the flat root.
- Adding a barrel (`access-intent/index.ts`).
  The repo treats barrel re-export sprawl as a smell; direct imports stay.
- Any behavior change, new test, signature change, or renamed export.
- The aliased command/workdir extraction that rewrites `input-normalizer.ts` / `tool-input-path.ts` — that is Phase 11 Step 3 ([#574]), landing after these modules reach their final location.

## Background

- The four modules were created in Phase 7 Step 4 ([#505]) when the `path-utils.ts` grab-bag was dissolved into cohesive modules; they landed in the flat root rather than under `access-intent/`.
- The `#src/*` import alias maps to `./src/*` and covers subdirectories, so a `#src/access-intent/<mod>` specifier resolves after the move with no `tsconfig`/`package.json` edit.
- Existing `access-intent/` modules establish the intra-domain import convention: same-directory siblings use a `./<sibling>` relative import (e.g. `access-path.ts` imports `./path-normalization`); cross-directory imports use the `#src/<path>` alias (e.g. `tool-kind.ts` imports `#src/path-surfaces`).
  This plan follows that convention for the moved files and keeps each non-moving importer's existing style (a `./` importer gains `access-intent/` in the path; a `#src/` importer gains `access-intent/`).
- Two ESLint guards touch this area and are **unaffected** by the move:
  - `no-restricted-syntax` forbidding interior `process.platform` reads applies to the `packages/pi-permission-system/src/**/*.ts` glob (`index.ts` exempt); the four modules stay under that glob and none reads `process.platform`.
  - `no-restricted-imports` forbidding `access-path` imports is scoped to `permission-manager.ts` only; the move does not add such an import, and `permission-manager`'s imports of `normalizeInput` / `PATH_SURFACES` stay `AccessPath`-free (the ADR-0002 string boundary, `docs/decisions/0002-path-values-string-boundary.md`).
- `tool-kind.ts` must stay `AccessPath`-free (it imports only `PATH_BEARING_TOOLS` from `path-surfaces`) so `permission-manager.ts` may consume `classifyToolKind` without breaching the boundary; the move keeps that import (as a sibling `./path-surfaces`) and adds nothing.

## Design Overview

A pure relocation.
Each moved module's cross-directory imports switch to the `#src/` alias, its same-directory-sibling imports stay `./`, and every importer's specifier gains the `access-intent/` segment.

### Import rewrites in the moved modules

`src/access-intent/input-normalizer.ts` (from `src/input-normalizer.ts`):

```typescript
import type { AccessIntent } from "./access-intent"; // was ./access-intent/access-intent
import { classifyToolKind } from "./tool-kind"; // was ./access-intent/tool-kind
import { stripBashCommentLines } from "#src/bash-arity"; // was ./bash-arity
import { createMcpPermissionTargets } from "./mcp-targets"; // sibling, unchanged ./
import type { PathNormalizer } from "#src/path-normalizer"; // was ./path-normalizer
import { PATH_SURFACES } from "./path-surfaces"; // sibling, unchanged ./
import { getNonEmptyString, toRecord } from "#src/value-guards"; // was ./value-guards
```

`src/access-intent/mcp-targets.ts` (from `src/mcp-targets.ts`):

```typescript
import { getNonEmptyString, toRecord } from "#src/value-guards"; // was ./value-guards
```

`src/access-intent/tool-input-path.ts` (from `src/tool-input-path.ts`):

```typescript
import { classifyToolKind } from "./tool-kind"; // was ./access-intent/tool-kind
import type { ToolAccessExtractorLookup } from "#src/tool-access-extractor-registry"; // was ./tool-access-extractor-registry
import { getNonEmptyString, toRecord } from "#src/value-guards"; // was ./value-guards
```

`src/access-intent/path-surfaces.ts` (from `src/path-surfaces.ts`): no imports; moved verbatim.

### Import rewrites in the non-moving importers

`#src/` alias importers (gain `access-intent/`):

- `src/path/pi-infrastructure-read.ts` — `#src/path-surfaces` → `#src/access-intent/path-surfaces`
- `src/handlers/gates/path.ts` — `#src/tool-input-path` → `#src/access-intent/tool-input-path`
- `src/handlers/gates/tool.ts` — `#src/path-surfaces` → `#src/access-intent/path-surfaces`; `#src/tool-input-path` → `#src/access-intent/tool-input-path`
- `src/handlers/gates/external-directory.ts` — `#src/tool-input-path` → `#src/access-intent/tool-input-path`
- `src/handlers/gates/tool-call-gate-pipeline.ts` — `#src/tool-input-path` → `#src/access-intent/tool-input-path`

`./` relative importers in the flat root (gain `access-intent/`):

- `src/permissions-service.ts` — `./input-normalizer` → `./access-intent/input-normalizer`
- `src/rule.ts` — `./path-surfaces` → `./access-intent/path-surfaces`
- `src/permission-manager.ts` — `./input-normalizer` → `./access-intent/input-normalizer`; `./path-surfaces` → `./access-intent/path-surfaces`
- `src/pattern-suggest.ts` — `./path-surfaces` → `./access-intent/path-surfaces`
- `src/index.ts` — `./input-normalizer` → `./access-intent/input-normalizer`

Sibling importer already in `access-intent/` (cross-dir alias becomes a `./` sibling):

- `src/access-intent/tool-kind.ts` — `#src/path-surfaces` → `./path-surfaces`

### Test file moves and import rewrites

Moved into `test/access-intent/`, `#src/` specifiers gain `access-intent/`:

- `test/input-normalizer.test.ts` → `test/access-intent/input-normalizer.test.ts` — `#src/input-normalizer` → `#src/access-intent/input-normalizer`; `#src/mcp-targets` → `#src/access-intent/mcp-targets`
- `test/mcp-targets.test.ts` → `test/access-intent/mcp-targets.test.ts` — `#src/mcp-targets` → `#src/access-intent/mcp-targets`
- `test/tool-input-path.test.ts` → `test/access-intent/tool-input-path.test.ts` — `#src/tool-input-path` → `#src/access-intent/tool-input-path`
- `test/path-surfaces.test.ts` → `test/access-intent/path-surfaces.test.ts` — `#src/path-surfaces` → `#src/access-intent/path-surfaces`

Already in `test/access-intent/` (import rewrite only):

- `test/access-intent/tool-kind.test.ts` — `#src/path-surfaces` → `#src/access-intent/path-surfaces`

### Edge cases

- The move breaks every importer at the type level simultaneously (the specifier no longer resolves), so all import rewrites for a given module must land in the same commit as its `git mv` — `tsc` rejects any intermediate half-moved state.
- `git mv` preserves history/blame across the rename; the diff is pure path movement plus one-line import edits.

## Module-Level Changes

Source moves (`git mv`, then rewrite imports as above):

- `src/input-normalizer.ts` → `src/access-intent/input-normalizer.ts`
- `src/mcp-targets.ts` → `src/access-intent/mcp-targets.ts`
- `src/tool-input-path.ts` → `src/access-intent/tool-input-path.ts`
- `src/path-surfaces.ts` → `src/access-intent/path-surfaces.ts`

Source importers edited (import specifier only): `src/permissions-service.ts`, `src/rule.ts`, `src/permission-manager.ts`, `src/pattern-suggest.ts`, `src/index.ts`, `src/access-intent/tool-kind.ts`, `src/path/pi-infrastructure-read.ts`, `src/handlers/gates/path.ts`, `src/handlers/gates/tool.ts`, `src/handlers/gates/external-directory.ts`, `src/handlers/gates/tool-call-gate-pipeline.ts`.

Test moves + import edits: `test/input-normalizer.test.ts`, `test/mcp-targets.test.ts`, `test/tool-input-path.test.ts`, `test/path-surfaces.test.ts` (moved into `test/access-intent/`), and `test/access-intent/tool-kind.test.ts` (edited in place).

Documentation edits:

- `docs/architecture/architecture.md`:
  - Prose (currently lines 291–292): `src/mcp-targets.ts` → `src/access-intent/mcp-targets.ts`; `src/input-normalizer.ts` → `src/access-intent/input-normalizer.ts`.
  - Module-layout tree: remove the four flat-root entries (`mcp-targets.ts`, `input-normalizer.ts`, `tool-input-path.ts`, `path-surfaces.ts`) and add them under the `access-intent/` subtree, descriptions unchanged.
  - Mark Phase 11 Step 1 complete: `✅` on the `#### Step 1` heading and on the Mermaid `S1` node in the step dependency diagram.
  - No health-metric-row edit: the "Flat `src/` root modules" row tracks the phase baseline (60) → phase target (≤ 56); the target is met by this step but the row stays as the phase-level tracker, and the recompute command (`ls .../src | grep -c '\.ts$'`) reports 56 after the move.
- `.pi/skills/package-pi-permission-system/SKILL.md` (line 136): `src/tool-input-path.ts` → `src/access-intent/tool-input-path.ts`.

No edits to historical records (`docs/plans/*`, `docs/retro/*`, `docs/architecture/history/*`): those are point-in-time and name the modules at their then-current paths.
No `eslint.config.js`, `tsconfig.json`, or `package.json` edit (the `#src/*` alias and both ESLint guards are unaffected — see Background).

## Test Impact Analysis

This is a pure relocation, not an extraction:

1. **New tests enabled:** none — no new seam or collaborator is introduced.
2. **Tests made redundant:** none — every existing test moves verbatim (subject and test relocate together) and stays load-bearing.
3. **Tests that must stay as-is:** all four relocated suites (`input-normalizer`, `mcp-targets`, `tool-input-path`, `path-surfaces`) plus `access-intent/tool-kind.test.ts` — they are the behavior-preservation guard; green must stay green across the move.

## Invariants at risk

The move touches modules a prior phase step refactored, but relocates them without changing behavior; the existing suites pin each invariant:

- **ADR-0002 string boundary** (`permission-manager.ts` stays `AccessPath`-free) — pinned by the `no-restricted-imports` ESLint guard (file-scoped, unaffected) and `permission-manager-unified.test.ts`.
  The move keeps `permission-manager`'s imports (`normalizeInput`, `PATH_SURFACES`) `AccessPath`-free.
- **`tool-kind.ts` is `AccessPath`-free** (Phase 10 Step 1, [#568]) — pinned by `test/access-intent/tool-kind.test.ts`; the move keeps its sole import (`PATH_BEARING_TOOLS`) intact as a `./path-surfaces` sibling.
- **Interior `process.platform` ban** ([#510]) — pinned by the `no-restricted-syntax` ESLint guard on the `src/**` glob; the four modules remain under the glob.

## TDD Order

This is a green-preserving `refactor:` move with no red cycle — the relocated tests are the regression guard, and `tsc` + ESLint prove every import was rewritten.
The next stage is `/build-plan` (a code-touching but test-cycle-free change), which dispatches the `tidy-first-assessor` at the start and the `pre-completion-reviewer` at the end.
Establish a green baseline (`pnpm --filter @gotgenes/pi-permission-system run check && pnpm -r run test && pnpm run lint && pnpm fallow dead-code`) before starting.

1. **Move the four modules and their tests; rewrite all imports.**
   `git mv` each of the four `src/` modules into `src/access-intent/` and each of the four test files into `test/access-intent/`.
   Rewrite the moved modules' own imports, all eleven source importers, and all five test imports exactly as listed in Design Overview.
   This is one atomic commit — the specifiers stop resolving the instant the files move, so `tsc` rejects any partial split.
   Verify: `pnpm --filter @gotgenes/pi-permission-system run check` (tsc), `pnpm -r run test` (full suite green — no test content changed), `pnpm run lint`, `pnpm fallow dead-code`, and `ls packages/pi-permission-system/src | grep -c '\.ts$'` reports 56.
   Commit: `refactor(pi-permission-system): fold access-intent stragglers into src/access-intent/ (#579)`.

2. **Update the architecture doc and package skill; mark Phase 11 Step 1 complete.**
   Edit `docs/architecture/architecture.md` (prose lines, module-layout tree relocation, `✅` on the Step 1 heading and Mermaid `S1` node) and `.pi/skills/package-pi-permission-system/SKILL.md` (line 136 path).
   Verify: `pnpm exec rumdl check` on the edited docs; confirm no other current-doc reference to the flat-root paths remains (`grep -rn` over `docs/architecture/architecture.md` and the skill, excluding `history/`).
   Commit: `docs(pi-permission-system): relocate access-intent stragglers in docs; mark Phase 11 Step 1 (#579)`.

## Risks and Mitigations

- **A missed importer.**
  `tsc` fails on any unresolved specifier and ESLint flags stale relative imports, so a miss cannot compile.
  The Design Overview enumerates every importer from an exhaustive `grep` over `src/` and `test/` (bare module names, catching both `#src/` and `./` styles per the [#559] lesson).
- **A dynamic or string reference the grep missed.**
  None exist: the four modules have no `package.json` `exports` entry (only `service.ts` is public) and no dynamic `import()`; the grep covered all `.ts` under `src/`/`test/`.
- **Stale doc reference to a flat-root path.**
  Step 2 greps `architecture.md` and the skill after editing; historical `docs/plans`/`docs/retro`/`docs/architecture/history` are intentionally left as point-in-time records.
- **Intra-domain import-cycle introduction.**
  None — the move changes only specifier paths, not the dependency graph; `input-normalizer` still imports `mcp-targets`/`path-surfaces`/`tool-kind` (now siblings), with no new edge.

## Open Questions

None.

[#505]: https://github.com/gotgenes/pi-packages/issues/505
[#510]: https://github.com/gotgenes/pi-packages/issues/510
[#559]: https://github.com/gotgenes/pi-packages/issues/559
[#568]: https://github.com/gotgenes/pi-packages/issues/568
[#574]: https://github.com/gotgenes/pi-packages/issues/574
