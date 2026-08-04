---
issue: 532
issue_title: "pi-permission-system: split value-guards.ts by cohesion"
---

# Split `value-guards.ts` by cohesion

## Release Recommendation

**Release:** ship independently

Phase 8 Step 8 is tagged `Release: independent` in the architecture roadmap (Track D — health) and has no dependencies.
It is a `refactor:` commit — a `hidden: true` changelog type — so it does not cut a release on its own; it lands on `main` and auto-batches into the next `feat:`/`fix:`/unhidden-`docs:` release.

## Problem Statement

`value-guards.ts` mixes two unrelated concerns: generic value-parsing guards that many modules use, and domain-specific permission-state guards that belong with the types they narrow.
`fallow` reports `value-guards.ts` as the package's only refactoring target — it inherited the high fan-in of the former `common.ts` grab-bag ([#479]) without shedding the mixed cohesion.
Splitting it by cohesion co-locates the domain guards with their types and clears the last refactoring target for Phase 8.

## Goals

- Keep the generic parsing guards (`toRecord`, `getNonEmptyString`) in `src/value-guards.ts`.
- Move the two domain guards (`isPermissionState`, `isDenyWithReason`) to `src/types.ts`, next to the `PermissionState` / `DenyWithReason` types they narrow.
- Repoint every consumer of the two domain guards from `./value-guards` to `./types`.
- Non-breaking: no observable behavior, output shape, or config default changes — the guards move verbatim.

## Non-Goals

- No behavior change to any guard — the function bodies move byte-for-byte.
- No change to `toRecord` / `getNonEmptyString` or their ~20 consumers beyond what the domain-guard move requires (their imports stay on `./value-guards`).
- Not reducing the re-narrowing in `normalize.ts` / `config-loader.ts` now that zod hands them validated input — that simplification is deferred (see [#547] Open Questions and ADR `docs/decisions/0004-zod-config-schema-single-source.md`).
- Not moving `value-guards.ts` or `types.ts` into `src/authority/` — the Phase 8 directory sketch only reseats the modules it rewrites for the spine, not these.

## Background

- `src/value-guards.ts` (38 LOC) currently exports four functions: `toRecord`, `getNonEmptyString`, `isPermissionState`, `isDenyWithReason`.
  It carries `import type { DenyWithReason, PermissionState } from "./types"` solely for the two domain guards.
- The issue's "Proposed change" lists `normalizeOptionalStringArray` and `normalizeOptionalPositiveInt` among the generic guards to keep, but [#547] already removed both when zod took over config validation (commit `146844aa`).
  The roadmap step note ([#532], `architecture.md:942`) records this; the surviving generic set is just `toRecord` + `getNonEmptyString`.
- `src/types.ts` is currently types-only (interfaces, type aliases, and `export type` re-exports of the config-shape types from `config-schema.ts`).
  It already imports `DenyWithReason` and `PermissionState` from `config-schema.ts` as `import type`, so the moved guards can narrow to them without a new import.
- Domain-guard consumers (from grep):
  - `src/permission-manager.ts` — `isPermissionState` (line 202).
    Already imports types from `./types`.
    An ESLint `no-restricted-imports` rule on this file blocks only `access-intent/access-path`; importing a guard from `./types` is allowed.
  - `src/normalize.ts` — `isDenyWithReason`, `isPermissionState` (lines 22, 28, 36).
    Already imports `FlatPermissionConfig` from `./types` (as `import type`).
  - `src/config-loader.ts` — `isDenyWithReason`, `isPermissionState` (lines 127, 137, 140).
    Already imports types from `./types`.
  - `test/value-guards.test.ts` — imports all four from `#src/value-guards`.
- Generic-guard consumers (`toRecord` / `getNonEmptyString`) across ~18 `src/` files and 2 `test/` files keep importing from `./value-guards` / `#src/value-guards` unchanged.

Constraint from the package skill: `architecture.md` names the `value-guards.ts` / `types.ts` function inventory in prose (a module-move check misses it); the doc-update commit must edit those lines.

## Design Overview

This is a cohesion split — relocating two whole functions to the module that owns the types they guard — not a decomposition of a procedure.
It introduces no new collaborator and changes no behavior; the design value is that `value-guards.ts` becomes purely generic parsing guards and the domain guards live beside `PermissionState` / `DenyWithReason`.

`types.ts` transitions from types-only to types-plus-their-guards.
This is the direction the issue and roadmap prescribe and is a natural home: a type guard is the runtime companion of the type it narrows.
No circular import results — `types.ts` already imports `DenyWithReason` / `PermissionState` from `config-schema.ts`, and the guards depend only on those.
`value-guards.ts` drops its `import type { DenyWithReason, PermissionState } from "./types"` line once the guards leave (it no longer references either type).

Consumer call sites are unchanged in body; only the import source moves.
For example, `normalize.ts`:

```typescript
// before
import type { FlatPermissionConfig } from "./types";
import { isDenyWithReason, isPermissionState } from "./value-guards";

// after
import { isDenyWithReason, isPermissionState } from "./types";
import type { FlatPermissionConfig } from "./types";
```

The autoformatter will merge/reorder the two `./types` imports; author them as it prefers and let `pnpm run lint` settle the final form.

### Guard bodies (moved verbatim)

```typescript
export function isPermissionState(value: unknown): value is PermissionState {
  return value === "allow" || value === "deny" || value === "ask";
}

/**
 * Narrow type guard: a raw value representing a DenyWithReason object.
 * Accepts `{ action: "deny" }` and `{ action: "deny", reason: "…" }`.
 * Rejects a non-string `reason` to keep malformed config out of the rule set.
 */
export function isDenyWithReason(value: unknown): value is DenyWithReason {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.action === "deny" &&
    (record.reason === undefined || typeof record.reason === "string")
  );
}
```

## Module-Level Changes

- `src/value-guards.ts` — remove `isPermissionState` and `isDenyWithReason`; remove the now-unused `import type { DenyWithReason, PermissionState } from "./types"`.
  Keep `toRecord` and `getNonEmptyString`.
- `src/types.ts` — add `isPermissionState` and `isDenyWithReason` (verbatim), narrowing to the already-imported `PermissionState` / `DenyWithReason`.
  Place them below the type declarations they guard, per the stepdown rule.
- `src/permission-manager.ts` — import `isPermissionState` from `./types` instead of `./value-guards`.
- `src/normalize.ts` — import `isDenyWithReason`, `isPermissionState` from `./types` instead of `./value-guards`.
- `src/config-loader.ts` — import `isDenyWithReason`, `isPermissionState` from `./types` instead of `./value-guards`.
- `test/value-guards.test.ts` — remove the `describe("isPermissionState", …)` and `describe("isDenyWithReason", …)` blocks; keep the `toRecord` and `getNonEmptyString` blocks; trim the import to `{ getNonEmptyString, toRecord }`.
- `test/types.test.ts` — new; the two moved `describe` blocks, importing `{ isDenyWithReason, isPermissionState }` from `#src/types`.
- `docs/architecture/architecture.md` — doc updates in the implementation commit:
  - Module-tree listing (line 836): change the `value-guards.ts` description to `Runtime type guards (`toRecord`, `getNonEmptyString`)`; add the two domain guards to the `types.ts` description (line 838).
  - Mark Step 8 complete (line 940 heading ✅ and the `S8` Mermaid node, line 958).
  - Health-metric row "fallow refactoring targets" (line 874): update the achieved value from 1 to 0.
    Re-run `pnpm --filter @gotgenes/pi-permission-system exec fallow` at implementation time to confirm the target clears before editing the row.

No user-facing docs (`README.md`, `docs/configuration.md`), config schema, or example config reference these internal guard symbols — grep confirms hits only in `docs/plans/`, `docs/retro/`, `docs/decisions/`, and `docs/architecture/history/` (all historical records that must not be edited) plus the live `architecture.md` lines above.

## Test Impact Analysis

1. **New unit tests enabled** — none genuinely new; the two guards were already unit-tested.
   The move relocates their existing `describe` blocks into `test/types.test.ts` verbatim, keeping identical assertions.
2. **Tests that become redundant** — none; no assertion is dropped.
   `test/value-guards.test.ts` shrinks to the two generic-guard blocks; `test/types.test.ts` gains the two domain-guard blocks.
3. **Tests that must stay as-is** — the `toRecord` / `getNonEmptyString` blocks stay in `test/value-guards.test.ts` (they exercise the guards that remain there); the domain-guard assertions move unchanged (they pin the byte-for-byte-identical behavior across the move).

## Invariants at risk

- The behavior of all four guards must be identical post-move — pinned by the relocated `test/types.test.ts` blocks and the retained `test/value-guards.test.ts` blocks (the same assertions that pass today).
- `permission-manager.ts`'s `no-restricted-imports` guard must stay green — the new `./types` import is not an `access-path` import, so it is allowed; `pnpm run lint` confirms.

## TDD Order

Single atomic step — removing the two exports from `value-guards.ts` breaks every importer and its tests at the type level in the same commit, so the extraction, all consumer import updates, and all test moves must land together (per the "removing an export breaks importers in that commit" rule; mirrors [#479]'s single-step split).

1. **Move the domain guards to `types.ts` and repoint consumers.**
   - Add `isPermissionState` / `isDenyWithReason` to `src/types.ts`; remove them (and the now-unused type import) from `src/value-guards.ts`.
   - Repoint `src/permission-manager.ts`, `src/normalize.ts`, `src/config-loader.ts` to import the guards from `./types`.
   - Create `test/types.test.ts` with the two moved `describe` blocks (import from `#src/types`); trim `test/value-guards.test.ts` to the two generic-guard blocks and its import.
   - Verify: `pnpm run check`, `pnpm run lint`, `pnpm --filter @gotgenes/pi-permission-system exec vitest run`, and `pnpm fallow dead-code` all green; the relocated guard tests pass unchanged.
   - Commit: `refactor(pi-permission-system): split value-guards.ts by cohesion (#532)`.

2. **Update `docs/architecture/architecture.md`.**
   - Edit the module-tree descriptions for `value-guards.ts` and `types.ts`; mark Step 8 ✅ (heading + `S8` Mermaid node); update the "fallow refactoring targets" health row to 0 after re-running `fallow` to confirm.
   - Verify: `pnpm run lint` (markdown) green; the Mermaid `S8` node renders with the ✅ marker.
   - Commit: `docs(pi-permission-system): mark Phase 8 Step 8 complete (#532)`.

Note: per the package skill, the roadmap-completion marker (✅ on the step heading and Mermaid node) lands in the implementation doc-update commit (step 2 here), not a deferred ship commit.

## Risks and Mitigations

- **Autoformatter reflows the merged `./types` imports** — build `oldText` from a freshly-read region when editing consumer imports, since `pi-autoformat` may reorder the two import lines after the first edit.
- **`fallow` still flags `value-guards.ts`** — the fan-in that made it a target is on `toRecord` / `getNonEmptyString`, which stay.
  If the target does not clear to 0, do not force the health-row edit; record the actual `fallow` count in the row and note the residual in the retro, since the mixed-cohesion smell (not fan-in) is what this step targets.
- **A missed domain-guard consumer** — grep confirms exactly three `src/` importers plus the one test file; `pnpm run check` fails loudly on any import left pointing at the removed `value-guards` exports.

## Open Questions

- None.
  The direction is unambiguous, non-breaking, matches the roadmap, and the operator authored the issue.

[#479]: https://github.com/gotgenes/pi-packages/issues/479
[#532]: https://github.com/gotgenes/pi-packages/issues/532
[#547]: https://github.com/gotgenes/pi-packages/issues/547
