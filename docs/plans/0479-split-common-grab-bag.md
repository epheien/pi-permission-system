---
issue: 479
issue_title: "pi-permission-system: split the common.ts grab-bag (Phase 6 Step 7)"
---

# Split the `common.ts` grab-bag into `value-guards` and `yaml-frontmatter`

## Release Recommendation

**Release:** ship independently

This is Phase 6 Step 7 in `docs/architecture/architecture.md`, tagged `Release: independent` (the roadmap's "Release batches" subsection lists Steps 6, 7, 8 as independently releasable).
It has no dependency on the access-intent track and ships on its own as a patch release.

## Problem Statement

`src/common.ts` is fallow's only refactoring target for this package (priority 27.1, 22 dependents).
It is a grab-bag (smell Category E): it mixes two unrelated concerns behind a single high-fan-in module.

- Runtime type guards: `toRecord`, `getNonEmptyString`, `normalizeOptionalStringArray`, `normalizeOptionalPositiveInt`, `isPermissionState`, `isDenyWithReason`.
- Minimal YAML/frontmatter parsing: `parseSimpleYamlMap`, `extractFrontmatter`.

With 22 dependents, the high fan-in amplifies every unrelated change: a touch to the frontmatter parser forces a re-review of every module that only wanted a type guard.

## Goals

- Split `src/common.ts` into `src/value-guards.ts` (the six type guards) and `src/yaml-frontmatter.ts` (the two parsing helpers).
- Repoint each of the 22 dependents (19 `src/` modules, 3 `test/` files) at whichever module it actually uses.
- Dissolve `common.ts` so the fallow refactoring-targets list drops to zero.
- Preserve behavior exactly — this is a pure lift-and-shift with no observable change.

## Non-Goals

- No behavior change to any of the eight functions.
- No signature, type, or return-shape change.
- Not breaking: `common.ts` is internal-only (not re-exported from `src/index.ts` or `package.json` `exports`), so no consumer outside the package can import it.
- No domain-directory move — the two new modules land flat in `src/`, not under a `config/` or `rules/` subdirectory (the forward-looking directory reorg is a separate, later increment per the architecture doc).
- No change to Step 8 (`#480`, external-directory test fixtures), which is independent of this split.

## Background

- `src/common.ts` (121 LOC) holds eight exported free functions plus one local `StackNode` type used only by `parseSimpleYamlMap`.
  The type guards import `DenyWithReason` and `PermissionState` from `./types`; the parsing helpers have no imports.
- The two concerns are fully independent — no function in one group calls a function in the other — so the split is a clean partition with no shared internal helper.
- Dependents and the symbols each imports (verified by grep):
  - Value-guards only (17 importers): `tool-input-prompt-formatters.ts`, `tool-registry.ts`, `forwarded-permissions/permission-forwarder.ts`, `permission-manager.ts`, `path-utils.ts`, `normalize.ts`, `input-normalizer.ts`, `tool-preview-formatter.ts`, `builtin-tool-input-formatters.ts`, `mcp-targets.ts`, `permission-prompts.ts`, `handlers/gates/skill-read.ts`, `handlers/gates/bash-external-directory.ts`, `handlers/gates/tool-call-gate-pipeline.ts`, `handlers/gates/bash-path.ts`, `handlers/tool-call-boundary.ts`, `handlers/permission-gate-handler.ts`.
  - Both modules (2 importers): `policy-loader.ts` (`extractFrontmatter`, `parseSimpleYamlMap`, `toRecord`), `config-loader.ts` (`isDenyWithReason`, `isPermissionState`, `normalizeOptionalPositiveInt`, `normalizeOptionalStringArray`, `toRecord` — all value-guards, so value-guards only) — re-check below.
  - Tests: `test/common.test.ts` (all eight), `test/handlers/gates/bash-external-directory.test.ts` and `test/handlers/gates/bash-path.test.ts` (`getNonEmptyString`, `toRecord` — value-guards only).
- Import-style constraint from AGENTS.md / `code-design`: within a package, prefer `#src/` aliases.
  The existing importers are mixed — `src/` siblings use `./common`, `handlers/` and `test/` use `#src/common`.
  Repoint each file using the alias form `#src/value-guards` / `#src/yaml-frontmatter`; let `pnpm run lint` / the autoformatter settle any residual style.

Correction to the dependent split above: `config-loader.ts` imports only value-guards (`isDenyWithReason`, `isPermissionState`, `normalizeOptionalPositiveInt`, `normalizeOptionalStringArray`, `toRecord`).
Only `policy-loader.ts` imports from both groups (`extractFrontmatter` + `parseSimpleYamlMap` from yaml-frontmatter, `toRecord` from value-guards).

## Design Overview

A grab-bag split is a genuine design improvement here, not procedure-splitting: each new module owns a cohesive, independently-evolving responsibility, and the split removes the fan-in amplification that is the actual cost.
The `design-review` checklist (dependency width, Law of Demeter, output arguments) does not apply — this change adds no parameter, touches no shared interface, and rewires no layer; it only relocates free functions and repoints imports.

### Module partition

`src/value-guards.ts` — the six runtime type guards, plus the `import type { DenyWithReason, PermissionState } from "./types"` they need:

```typescript
export function toRecord(value: unknown): Record<string, unknown> { /* … */ }
export function getNonEmptyString(value: unknown): string | null { /* … */ }
export function normalizeOptionalStringArray(raw: unknown): string[] | undefined { /* … */ }
export function normalizeOptionalPositiveInt(raw: unknown): number | undefined { /* … */ }
export function isPermissionState(value: unknown): value is PermissionState { /* … */ }
export function isDenyWithReason(value: unknown): value is DenyWithReason { /* … */ }
```

`src/yaml-frontmatter.ts` — the two parsing helpers plus the local `StackNode` type (no imports):

```typescript
type StackNode = { indent: number; target: Record<string, unknown> };
export function parseSimpleYamlMap(input: string): Record<string, unknown> { /* … */ }
export function extractFrontmatter(markdown: string): string { /* … */ }
```

### Consumer call site (the only dual importer)

`policy-loader.ts` is the one file that splits its import across both new modules:

```typescript
import { extractFrontmatter, parseSimpleYamlMap } from "#src/yaml-frontmatter";
import { toRecord } from "#src/value-guards";
```

Every other importer's single line resolves to exactly one of the two modules.

### Edge cases

- No re-export shim: `common.ts` is deleted, not left re-exporting, to avoid the barrel-sprawl smell the architecture doc calls out (fallow flags an export with no importer).
  Removing the export breaks all 22 importers at the type level in the same commit — so the extraction, all consumer repoints, and the test-file split land together as one atomic step (per the AGENTS.md export-removal rule).
- The split is verifiable by `tsc`: a missed repoint is a compile error, and a stray symbol in the wrong module is a missing-export error.

## Module-Level Changes

- `src/value-guards.ts` — new; the six type guards moved verbatim from `common.ts`, with `import type { DenyWithReason, PermissionState } from "./types"`.
- `src/yaml-frontmatter.ts` — new; `parseSimpleYamlMap`, `extractFrontmatter`, and the local `StackNode` type moved verbatim from `common.ts`.
- `src/common.ts` — deleted.
- Repoint 17 value-guards-only `src/` importers to `#src/value-guards`: `tool-input-prompt-formatters.ts`, `tool-registry.ts`, `forwarded-permissions/permission-forwarder.ts`, `permission-manager.ts`, `path-utils.ts`, `normalize.ts`, `input-normalizer.ts`, `tool-preview-formatter.ts`, `builtin-tool-input-formatters.ts`, `mcp-targets.ts`, `permission-prompts.ts`, `config-loader.ts`, `handlers/gates/skill-read.ts`, `handlers/gates/bash-external-directory.ts`, `handlers/gates/tool-call-gate-pipeline.ts`, `handlers/gates/bash-path.ts`, `handlers/tool-call-boundary.ts`, `handlers/permission-gate-handler.ts`.
  (`config-loader.ts` and `permission-manager.ts` are value-guards-only despite their multi-symbol imports.)
- Repoint `src/policy-loader.ts` to both `#src/yaml-frontmatter` and `#src/value-guards`.
- `test/value-guards.test.ts` — new; the six guard `describe` blocks moved from `test/common.test.ts` (`toRecord`, `getNonEmptyString`, `isPermissionState`, `isDenyWithReason`, `normalizeOptionalStringArray`, `normalizeOptionalPositiveInt`), importing from `#src/value-guards`.
- `test/yaml-frontmatter.test.ts` — new; the two parser `describe` blocks moved from `test/common.test.ts` (`extractFrontmatter`, `parseSimpleYamlMap`), importing from `#src/yaml-frontmatter`.
- `test/common.test.ts` — deleted; trim the import header to only the symbols each new file uses (the old `afterEach(vi.restoreAllMocks)` is unused by either group — neither uses mocks — and is dropped).
- Repoint `test/handlers/gates/bash-external-directory.test.ts` and `test/handlers/gates/bash-path.test.ts` to `#src/value-guards`.
- `docs/architecture/architecture.md` — update the module-tree listing (line ~750): replace the single `├── common.ts   Shared parsing utilities` entry with `value-guards.ts` (runtime type guards) and `yaml-frontmatter.ts` (minimal YAML/frontmatter parsing).
  Leave the Step 7 completion marker (`✅` on the heading + the `S7` Mermaid node) and the `common.ts` health-metric row (line ~799) for ship time, per the package SKILL convention.

No occurrence of `common` remains in `src/` or `test/` after the change (verify with grep); the only remaining references are in `docs/plans/` (historical plans — left as-is) and the architecture roadmap's Step 7 narrative (updated at ship time).

## Test Impact Analysis

1. New tests enabled: none — the eight functions were already free functions and independently testable; the split only co-locates their tests beside the module each one now lives in.
2. Redundant tests: none — every existing test moves verbatim; no test becomes obsolete.
3. Tests that must stay as-is: all of them — each genuinely exercises a function being relocated, so all `describe` blocks move unchanged (only the import path and file location change).

## Invariants at risk

- Behavior of all eight functions must be byte-for-byte identical post-split — pinned by the relocated `test/value-guards.test.ts` and `test/yaml-frontmatter.test.ts` (the same assertions that pass today against `common.ts`).
- No prior Phase 6 step refactored `common.ts`, so there is no upstream `Outcome:` invariant to regress; the importing modules (resolver, manager, gates) only change their import line, not their behavior, and the full suite plus `tsc` guard against a mis-repoint.

## TDD Order

This is a single atomic refactor (no red→green: the relocated tests stay green throughout, and the export removal forces all repoints into one commit).

1. **Split `common.ts` and repoint every dependent.**
   Create `src/value-guards.ts` and `src/yaml-frontmatter.ts` (verbatim moves); create `test/value-guards.test.ts` and `test/yaml-frontmatter.test.ts` (verbatim `describe`-block moves with trimmed imports); repoint all 19 `src/` importers and the 2 remaining `test/` importers; delete `src/common.ts` and `test/common.test.ts`; update the architecture module-tree listing.
   Verify: `pnpm --filter @gotgenes/pi-permission-system run check`, `... run lint`, `... run test`, and `pnpm fallow dead-code` all pass; `grep -rn "common" src test` returns nothing; `pnpm fallow` no longer lists `common.ts` as a refactoring target.
   Commit: `refactor(pi-permission-system): split common.ts into value-guards and yaml-frontmatter (#479)`.

## Risks and Mitigations

- Risk: a missed importer repoint.
  Mitigation: `tsc` (via `pnpm run check`) fails on any dangling `#src/common` / `./common` import; the final grep confirms zero `common` references in `src/`/`test/`.
- Risk: a guard accidentally placed in the yaml module (or vice versa).
  Mitigation: TypeScript's missing-export error surfaces it immediately; the per-module test files import from the specific module and would fail.
- Risk: lint churn from import-style differences (`./` vs `#src/`).
  Mitigation: repoint everything to the `#src/` alias form and let `pnpm run lint` / the pre-commit formatter normalize the rest.

## Open Questions

None — the partition is unambiguous and the architecture roadmap fixes the module names and the independent-release decision.
