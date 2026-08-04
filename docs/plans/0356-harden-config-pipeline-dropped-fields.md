---
issue: 356
issue_title: "Harden config pipeline against silently-dropped fields (follow-up to #332)"
---

# Harden the config pipeline against silently-dropped fields

## Problem Statement

Issue [#332] fixed a specific bug — `toolInputPreviewMaxLength` / `toolTextSummaryMaxLength` were declared on `PermissionSystemExtensionConfig` and read by `ToolPreviewFormatter`, but silently dropped by the `UnifiedPermissionConfig` intermediate in `config-loader.ts`.
The fix wired those two fields through the loader, but it did not close the *class* of bug that let the omission ship undetected.

Two structural gaps remain:

1. `normalizePermissionSystemConfig` accepts `unknown` and re-parses its argument through `toRecord(raw)`.
   Its sole production caller (`ConfigStore.refresh`) feeds it `mergeResult.merged`, a `UnifiedPermissionConfig`.
   Because the parameter is `unknown`, TypeScript never objected that the merged object lacked the two fields.
   A field declared on the runtime type but missing from the merge intermediate is a silent runtime drop, not a compile error.
2. Every existing test injects config at a single layer in isolation.
   Nothing exercises the full seam — temp `config.json` → `loadAndMergeConfigs` → `normalizePermissionSystemConfig` — so a field dropped in the middle is never observed end to end.

This plan attacks the class of bug rather than the single instance.

## Goals

- Retype `normalizePermissionSystemConfig`'s parameter from `unknown` to `UnifiedPermissionConfig` and read fields directly, so a future field declared on the runtime type but absent from the merge intermediate becomes a compile error.
- Drop the now-redundant defensive coercion (`toRecord`, `normalizeOptionalPositiveInt`, `normalizeOptionalStringArray`) from `normalizePermissionSystemConfig` — that work already happens at the JSON boundary in `normalizeUnifiedConfig`.
- Add one full-pipeline seam test in a new `test/config-pipeline.test.ts` that writes a temp `config.json`, runs it through `loadAndMergeConfigs` → `normalizePermissionSystemConfig`, and asserts a runtime knob and a preview-length field both survive end to end.

This change is **not breaking**: observable runtime behavior is unchanged.
The two production call sites already feed typed objects through `normalizeUnifiedConfig` first, so the removed coercion is dead code for production; only test-only garbage injection is affected.

## Non-Goals

- The secondary `saveExtensionConfig` behavior from [#332] (length fields not written back) is out of scope — `ConfigStore.save` already preserves existing file fields via `...existing.config`, and the modal only edits the three booleans.
  `config-store.ts` is not modified by this plan.
- No changes to `normalizeUnifiedConfig`, `mergeUnifiedConfigs`, or the boundary parsing — they already do the defensive work correctly.
- No new config fields, schema entries, or example-config changes.
- No narrowing of the parameter to `Omit<UnifiedPermissionConfig, "permission">` (see Design Overview — accepted minor ISP slack).

## Background

Relevant modules:

- `src/extension-config.ts` — declares `PermissionSystemExtensionConfig`, `DEFAULT_EXTENSION_CONFIG`, and `normalizePermissionSystemConfig`.
  The function currently does `toRecord(raw)` then reads each field defensively (`record.debugLog === true`, `normalizeOptionalPositiveInt(record.toolInputPreviewMaxLength)`, etc.).
- `src/config-loader.ts` — declares `UnifiedPermissionConfig` (all-optional intermediate) and `normalizeUnifiedConfig`, which already does the full defensive parse at the JSON boundary: `normalizeOptionalBoolean` for the three booleans, `normalizeOptionalPositiveInt` for the two length fields, `normalizeOptionalStringArray` for `piInfrastructureReadPaths`.
- `src/config-store.ts` — the two production call sites.
  `refresh` passes `mergeResult.merged` (a `UnifiedPermissionConfig`); `save` passes `next` (a `PermissionSystemExtensionConfig`).
- `src/common.ts` — exports `toRecord`, `normalizeOptionalPositiveInt`, `normalizeOptionalStringArray`.

Applicable constraint from the package skill (`package-pi-permission-system`): "Treat any declared config field not read at runtime as a maintenance trap" and "A field on the runtime type but not the merge intermediate is silently dropped before runtime (the [#332] / [#347] bug class)."
This plan makes that trap a compile error.

Existing boundary coverage in `test/config-loader.test.ts` already exercises the defensive parse the retype removes from `normalizePermissionSystemConfig`:

- Lines 188–199 — non-boolean values (`debugLog: "yes"`, `permissionReviewLog: 1`, `yoloMode: null`) are dropped to `undefined`.
- Lines 156–172 — `debugLog` present/false/missing.
- Lines 262–325 — both length fields: valid positive integer parsed, absent omitted, and invalid values (`0`, `-1`, fractional, string, boolean) dropped.

This is why the redundant cases in `test/extension-config.test.ts` can be deleted rather than relocated.

## Design Overview

### Type model

After the change, `normalizePermissionSystemConfig` converts a typed `UnifiedPermissionConfig` into a `PermissionSystemExtensionConfig` by applying defaults to the three required booleans and passing through the optional fields:

```typescript
export function normalizePermissionSystemConfig(
  raw: UnifiedPermissionConfig,
): PermissionSystemExtensionConfig {
  const result: PermissionSystemExtensionConfig = {
    debugLog: raw.debugLog === true,
    permissionReviewLog: raw.permissionReviewLog !== false,
    yoloMode: raw.yoloMode === true,
  };
  if (raw.piInfrastructureReadPaths !== undefined) {
    result.piInfrastructureReadPaths = raw.piInfrastructureReadPaths;
  }
  if (raw.toolInputPreviewMaxLength !== undefined) {
    result.toolInputPreviewMaxLength = raw.toolInputPreviewMaxLength;
  }
  if (raw.toolTextSummaryMaxLength !== undefined) {
    result.toolTextSummaryMaxLength = raw.toolTextSummaryMaxLength;
  }
  return result;
}
```

Behavior is preserved exactly: undefined booleans default the same way (`=== true` → `false`, `!== false` → `true`), and the optional fields are passed through unchanged.
The function no longer imports `toRecord`, `normalizeOptionalPositiveInt`, or `normalizeOptionalStringArray` — those imports become unused and are removed.

### Why this achieves the safety goal

The point of the retype is the omission-becomes-compile-error property.
Keeping `toRecord` would defeat it: `toRecord` returns `Record<string, unknown>`, so `record.toolInputPreviewMaxLength` is `unknown` and the type checker cannot see a missing field on the input.
Reading `raw.toolInputPreviewMaxLength` directly against a typed `UnifiedPermissionConfig` means that if a future field is declared on `PermissionSystemExtensionConfig`, read here, but never added to `UnifiedPermissionConfig`, the field access is a compile error.

### Call-site compatibility

Both production call sites already feed assignable types — no `config-store.ts` change is needed:

```typescript
// ConfigStore.refresh — mergeResult.merged is already UnifiedPermissionConfig
const runtimeConfig = normalizePermissionSystemConfig(mergeResult.merged);

// ConfigStore.save — next is PermissionSystemExtensionConfig, structurally
// assignable to UnifiedPermissionConfig (every field present, all optional there)
const normalized = normalizePermissionSystemConfig(next);
```

`PermissionSystemExtensionConfig` (required booleans + optional extras) is assignable to `UnifiedPermissionConfig` (all-optional superset including `permission?`), so `save` compiles unchanged.

### ISP note (accepted slack)

`normalizePermissionSystemConfig` reads 6 of `UnifiedPermissionConfig`'s 7 fields — it never reads `permission`.
A strict ISP reading would narrow the parameter to `Omit<UnifiedPermissionConfig, "permission">`.
We accept the single unused optional field instead: `UnifiedPermissionConfig` is the natural merged-config domain object and the exact type of `mergeResult.merged`, the issue prescribes typing the parameter as `UnifiedPermissionConfig`, and the compile-error safety property holds either way.
Adding a narrowing alias would be speculative surface for negligible benefit.

### Design-review checklist result

| Check            | Finding                                                                            |
| ---------------- | ---------------------------------------------------------------------------------- |
| Dependency width | Param reads 6/7 fields; one unused optional (`permission`) accepted (see ISP note) |
| Law of Demeter   | No chained access introduced                                                       |
| Output arguments | None — function returns a fresh object                                             |
| Scattered resets | N/A                                                                                |
| Parameter relay  | N/A                                                                                |
| Test mock depth  | Removes test-only `as unknown` casts in `config-modal.test.ts` (improvement)       |

No structural smells introduced; the change removes redundant code and a test-only cast.

## Module-Level Changes

- `src/extension-config.ts`
  - Change `normalizePermissionSystemConfig(raw: unknown)` to `(raw: UnifiedPermissionConfig)`; read fields directly; drop the `toRecord` call and the `normalizeOptionalPositiveInt` / `normalizeOptionalStringArray` coercion.
  - Add `import type { UnifiedPermissionConfig } from "./config-loader";`.
  - Remove the now-unused imports `normalizeOptionalPositiveInt`, `normalizeOptionalStringArray`, `toRecord` from the `./common` import (verify `toRecord` has no other use in the file — `detectMisplacedPermissionKeys` takes a `Record` directly, so it does not).
- `test/extension-config.test.ts`
  - Delete the four redundant garbage-input cases (now uncompilable against the typed parameter and already covered at the boundary in `config-loader.test.ts`): "coerces non-boolean values to their defaults", "handles null/undefined input gracefully", "omits toolInputPreviewMaxLength for invalid values", "omits toolTextSummaryMaxLength for invalid values".
  - Keep the valid-input cases (valid config, the three boolean defaults via `{}`, includes/omits for both length fields) — they pass typed objects and still compile.
- `test/config-modal.test.ts`
  - Fix the two call sites that pass `JSON.parse(readFileSync(configPath, "utf-8")) as unknown` to `normalizePermissionSystemConfig` (lines ~147 and ~156): route them through `loadUnifiedConfig(configPath).config` (reads + normalizes the file into a `UnifiedPermissionConfig`, mirroring production) and import `loadUnifiedConfig` from `#src/config-loader`.
  - The other two call sites pass typed values (`config`, `next`) and need no change.
- `test/config-pipeline.test.ts` (new)
  - Add the full-pipeline seam test (change 2).

No `docs/architecture/`, schema, example-config, README, or `docs/configuration.md` updates — no config surface changes.
The package skill's bug-class note already describes this trap; no skill edit required.

## Test Impact Analysis

What the change enables and affects:

1. New coverage enabled — the seam test in `test/config-pipeline.test.ts` is the first test that runs config through the real `loadAndMergeConfigs` → `normalizePermissionSystemConfig` path on disk, catching any future mid-pipeline drop (not just the two length fields).
2. Tests that become redundant — the four garbage-input cases in `test/extension-config.test.ts` duplicate boundary coverage already present in `test/config-loader.test.ts` (lines 188–199 for booleans, 296–325 for invalid length values).
   They are deleted, not relocated, because the boundary already tests the identical behavior.
3. Tests that must stay as-is — the valid-input cases in `test/extension-config.test.ts` (default application, length-field passthrough) genuinely exercise `normalizePermissionSystemConfig`'s remaining responsibility (defaults + passthrough) and are kept.
   All of `test/config-loader.test.ts` stays — it owns the boundary defensive-parse contract.

## TDD Order

1. Add the full-pipeline seam test (change 2).
   Surface: new `test/config-pipeline.test.ts`.
   Covers: write a temp `config.json` with a runtime knob (e.g. `debugLog: true`) and a preview-length field (e.g. `toolInputPreviewMaxLength: 1000`); run `loadAndMergeConfigs(agentDir, cwd, extensionRoot)`; pass `.merged` to `normalizePermissionSystemConfig`; assert both values survive end to end.
   This passes immediately (the [#332] loader fix is already in place) — it is a regression guard documenting the seam, established before the refactor as a safety net.
   Commit: `test: add full-pipeline config seam regression test (#356)`.
2. Retype `normalizePermissionSystemConfig` and migrate its tests (change 1).
   Surface: `src/extension-config.ts`, `test/extension-config.test.ts`, `test/config-modal.test.ts`.
   This is a single atomic commit: changing the parameter type breaks the four garbage-input test cases and the two `as unknown` call sites at the type level, so the production change, the test deletions, and the `config-modal.test.ts` call-site updates must land together.
   Run `pnpm run check` immediately after — the retype is the one interface-shape change in this plan, and `pnpm --filter @gotgenes/pi-permission-system exec vitest run` to confirm the seam test (step 1) and the surviving unit tests stay green.
   Commit: `refactor: type normalizePermissionSystemConfig parameter as UnifiedPermissionConfig (#356)`.

## Risks and Mitigations

- Risk: a hidden production caller passes genuinely untrusted `unknown` to `normalizePermissionSystemConfig`, relying on the defensive coercion.
  Mitigation: confirmed via grep — only two production call sites (`ConfigStore.refresh`, `ConfigStore.save`), both feeding typed objects already normalized upstream; no untrusted path exists.
- Risk: deleting the garbage-input tests loses coverage of invalid-value handling.
  Mitigation: that behavior is fully covered at the JSON boundary in `test/config-loader.test.ts` (booleans lines 188–199, length fields 296–325); the deletions are duplicates, not unique coverage.
- Risk: `config-modal.test.ts` call-site rewrite changes what the test asserts.
  Mitigation: `loadUnifiedConfig(configPath).config` reads and normalizes the same file the test wrote, mirroring the production load path more faithfully than the previous `JSON.parse(...) as unknown` cast — the asserted round-trip is preserved.

## Open Questions

None blocking.
A future follow-up could narrow the parameter to `Omit<UnifiedPermissionConfig, "permission">` if more unused fields accumulate, but that is not warranted now.

[#332]: https://github.com/gotgenes/pi-packages/issues/332
[#347]: https://github.com/gotgenes/pi-packages/issues/347
