---
issue: 347
issue_title: "piInfrastructureReadPaths in config.json is silently ignored by config-loader merge pipeline"
---

# Carry `piInfrastructureReadPaths` through the unified config loader

## Problem Statement

A user sets `piInfrastructureReadPaths` in `config.json` to auto-allow reads under a directory, but reads there still hit the `external_directory` gate.
The field is parsed correctly by `normalizePermissionSystemConfig()`, but that function runs on the *output* of `loadAndMergeConfigs()`, which uses `UnifiedPermissionConfig` as its intermediate type.
`UnifiedPermissionConfig` does not declare `piInfrastructureReadPaths`, so `normalizeUnifiedConfig()` never copies it out of the raw JSON and `mergeUnifiedConfigs()` never carries it across layers.
By the time `normalizePermissionSystemConfig(mergeResult.merged)` runs in `ConfigStore.refresh()`, the field is already gone.

This is the same class of bug as [#332] (the `toolInputPreviewMaxLength` / `toolTextSummaryMaxLength` loader gap): a declared config field that is read at runtime but silently dropped by the unified load/merge pipeline.

## Goals

- Carry `piInfrastructureReadPaths` through `normalizeUnifiedConfig()` and `mergeUnifiedConfigs()` so the configured value survives the load/merge pipeline and reaches `PermissionSystemExtensionConfig`.
- Use replace (override-wins) merge semantics across layers, consistent with every other scalar field in `UnifiedPermissionConfig`.
- Preserve a user's existing `piInfrastructureReadPaths` through `ConfigStore.save()` (the config-modal write-back), so saving boolean toggles does not silently delete the array.
- Keep the existing validation behavior: a non-array or a mixed-type array is dropped (treated as absent), matching `normalizePermissionSystemConfig`.

## Non-Goals

- No change to how `piInfrastructureReadPaths` is *matched* at the gate (glob support, `~`/`$HOME` expansion, prefix matching) — that lives in `path-utils.ts` / `isPiInfrastructureRead()` and already works ([#122], [#350]).
- No change to `PermissionSystemExtensionConfig`, `normalizePermissionSystemConfig`, the JSON schema, `config.example.json`, or `docs/configuration.md` — the field is already declared, documented, and validated there.
  This bug is confined to the unified loader.
- No concatenating/union merge across layers — explicitly rejected (see Design Overview).
- No change to the per-agent frontmatter merge path beyond what falls out of the unified-config fix.

## Background

Relevant modules:

- `src/config-loader.ts` — owns the unified pipeline:
  - `UnifiedPermissionConfig` (the intermediate type; currently carries `debugLog`, `permissionReviewLog`, `yoloMode`, `toolInputPreviewMaxLength`, `toolTextSummaryMaxLength`, `permission`).
  - `normalizeUnifiedConfig(raw)` — copies recognized fields out of parsed JSON.
  - `mergeUnifiedConfigs(base, override)` — merges scalars (override-wins) and deep-shallow-merges `permission`.
  - `loadUnifiedConfig(path)` / `loadAndMergeConfigs(...)` — read and layer the configs.
- `src/extension-config.ts` — `normalizePermissionSystemConfig()` already parses `piInfrastructureReadPaths` from a record (array-of-strings guard, omit-when-invalid).
  `PermissionSystemExtensionConfig.piInfrastructureReadPaths?: string[]` is already declared.
- `src/config-store.ts`:
  - `refresh()` — calls `loadAndMergeConfigs(...)` then `normalizePermissionSystemConfig(mergeResult.merged)`.
    This is where the field is lost today.
  - `save()` — spreads `...existing.config` (a `UnifiedPermissionConfig` from `loadUnifiedConfig`) then overrides the three booleans.
    Once `UnifiedPermissionConfig` carries `piInfrastructureReadPaths` and `normalizeUnifiedConfig` parses it, the spread preserves it automatically — same mechanism that fixed save for [#332].
- `src/common.ts` — home of the shared scalar normalizer `normalizeOptionalPositiveInt`.
- `src/permission-session.ts` — `getInfrastructureReadDirs()` reads `this.config.piInfrastructureReadPaths ?? []`; the runtime consumer, unchanged by this fix.

Constraint from AGENTS.md / the package skill that applies: "Treat any declared config field not read at runtime as a maintenance trap." — the field *is* read at runtime, so the fix is to make the pipeline carry it, not to remove it.
Keep schema, example config, loader, and docs aligned — here only the loader is out of alignment, so only the loader changes.

## Design Overview

Decision model: mirror exactly how [#332] closed the gap for the numeric fields, adapted for an array field.

1. Add `piInfrastructureReadPaths?: string[]` to `UnifiedPermissionConfig`.
2. Parse it in `normalizeUnifiedConfig()` using a shared `normalizeOptionalStringArray` helper.
3. Carry it through `mergeUnifiedConfigs()` with override-wins (replace) semantics.

Shared helper (added to `src/common.ts`):

```typescript
/** Returns `raw` if it is an array of strings; otherwise `undefined`. */
export function normalizeOptionalStringArray(
  raw: unknown,
): string[] | undefined {
  return Array.isArray(raw) && raw.every((p): p is string => typeof p === "string")
    ? raw
    : undefined;
}
```

Both layers validate "optional string array" identically; this is one logical concern (the same kind of single-purpose pure validator as `normalizeOptionalPositiveInt`), so a shared helper in `common.ts` is the right home, not duplicated inline guards.
`normalizePermissionSystemConfig()` in `extension-config.ts` currently inlines this exact guard; it will reuse the helper too, removing the duplication rather than adding a third copy.

Updated `UnifiedPermissionConfig`:

```typescript
export interface UnifiedPermissionConfig {
  // Runtime knobs
  debugLog?: boolean;
  permissionReviewLog?: boolean;
  yoloMode?: boolean;
  toolInputPreviewMaxLength?: number;
  toolTextSummaryMaxLength?: number;
  piInfrastructureReadPaths?: string[];

  // Flat permission policy
  permission?: FlatPermissionConfig;
}
```

Merge semantics (decided via `ask_user`): replace, not concatenate.
`mergeUnifiedConfigs` already applies override-wins to every scalar (`override[key] ?? base[key]`); an array field follows the same rule cleanly:

```typescript
// Array fields: override replaces base when defined
const piInfrastructureReadPaths =
  override.piInfrastructureReadPaths ?? base.piInfrastructureReadPaths;
if (piInfrastructureReadPaths !== undefined) {
  merged.piInfrastructureReadPaths = piInfrastructureReadPaths;
}
```

Rationale for replace over concatenate: every other field in `UnifiedPermissionConfig` replaces (scalars) or deep-shallow-merges (`permission` maps); a concatenating array would be the lone divergent merge rule, surprising for users who set the field at one layer expecting it to be the effective value.
The reported bug is a single-layer drop; replace is the minimal, consistent fix.

Edge cases:

- Field absent at all layers → `merged` omits it → `normalizePermissionSystemConfig` omits it → `getInfrastructureReadDirs()` falls back to `?? []` (current behavior preserved).
- Field present but malformed (not an array, or array with non-string entries) → `normalizeOptionalStringArray` returns `undefined` → treated as absent.
  Silent drop, no config issue emitted — consistent with how `normalizePermissionSystemConfig` already handles it and with the numeric fields.
- Empty array `[]` → a valid value → carried through verbatim (distinct from absent; matters for save preservation).
- Save: `ConfigStore.save()` spreads `...existing.config`; once the loader carries the field, the spread preserves it.
  No explicit field-copy is needed in `save()` (same as [#332]).

The `normalizeOptionalStringArray` helper is a pure value-returning function with no upstream dependencies; its only callers are the two normalizers.
No Tell-Don't-Ask, output-argument, or LoD concerns — it is a leaf validator.

## Module-Level Changes

| File                         | Change                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/common.ts`              | Add and export `normalizeOptionalStringArray(raw: unknown): string[] \| undefined`.                                                                                                                                                                                                                           |
| `src/config-loader.ts`       | Add `piInfrastructureReadPaths?: string[]` to `UnifiedPermissionConfig`; import and call `normalizeOptionalStringArray` in `normalizeUnifiedConfig()`; carry the field through `mergeUnifiedConfigs()` with override-wins semantics; update the `mergeUnifiedConfigs` doc comment to mention the array field. |
| `src/extension-config.ts`    | Replace the inline array-of-strings guard in `normalizePermissionSystemConfig()` with a call to `normalizeOptionalStringArray` (dedupe; no behavior change).                                                                                                                                                  |
| `test/config-loader.test.ts` | Add `normalizeUnifiedConfig` cases (parses array, omits when absent, omits when malformed) and `mergeUnifiedConfigs` cases (override replaces base, base survives when override omits, absent when both omit, empty-array preserved).                                                                         |
| `test/common.test.ts`        | Add `normalizeOptionalStringArray` unit tests (valid array, empty array, non-array, mixed-type array, `undefined`).                                                                                                                                                                                           |
| `test/config-store.test.ts`  | Add a `refresh()` integration case (a global `config.json` with `piInfrastructureReadPaths` reaches `store.current()`), and a `save()` preservation case (an existing global array survives a boolean-only save).                                                                                             |

No `docs/architecture/` layout, complexity, or health tables reference these symbols (verified the change adds no module and renames no export — it adds one helper and one interface field).
The JSON schema, `config.example.json`, and `docs/configuration.md` already document `piInfrastructureReadPaths` and stay correct.

Confirm there is no contradiction: the loader files appear in Module-Level Changes and not in Non-Goals; Non-Goals lists only the already-correct surfaces (schema, example, docs, matching logic).

## Test Impact Analysis

This is a bug fix that closes a loader gap, not an extraction/refactor, so the analysis is light:

1. New tests enabled: the shared `normalizeOptionalStringArray` helper is now independently unit-testable in `test/common.test.ts`; previously the array-validation logic only existed inline inside `normalizePermissionSystemConfig` and was exercised indirectly.
2. Redundant tests: none become redundant.
   The existing `normalizePermissionSystemConfig` tests in `test/extension-config.test.ts` that cover `piInfrastructureReadPaths` still pass unchanged (the helper preserves identical behavior) and continue to document the end-to-end contract.
3. Tests that must stay: the `extension-config` tests for `piInfrastructureReadPaths` stay as-is — they verify the public normalizer's behavior, which is the contract callers depend on, independent of the internal helper.

## TDD Order

1. `test: cover normalizeOptionalStringArray helper` Add `test/common.test.ts` cases for: valid string array, empty array (`[]` → `[]`), non-array (`"x"`, `42`, object → `undefined`), mixed-type array (`["a", 1]` → `undefined`), and `undefined` → `undefined`.
   Red (helper does not exist yet).

2. `feat: add normalizeOptionalStringArray to common` Add and export the helper in `src/common.ts`.
   Green for step 1.
   Refactor `normalizePermissionSystemConfig()` in `src/extension-config.ts` to call it in place of the inline guard (existing `extension-config` tests must stay green — run them).
   Run `pnpm run check` (shared module touched).

3. `test: cover piInfrastructureReadPaths in unified config loader` Add `normalizeUnifiedConfig` cases (parses array, omits when absent, omits when malformed) and `mergeUnifiedConfigs` cases (override replaces base, base survives when override omits it, absent when both omit, empty array preserved) to `test/config-loader.test.ts`.
   Red (field not yet carried).

4. `fix: carry piInfrastructureReadPaths through the unified config loader (#347)` Add `piInfrastructureReadPaths?: string[]` to `UnifiedPermissionConfig`; parse it via `normalizeOptionalStringArray` in `normalizeUnifiedConfig()`; carry it override-wins in `mergeUnifiedConfigs()`; update the `mergeUnifiedConfigs` doc comment.
   Green for step 3.
   Run `pnpm run check` immediately (shared interface changed).

5. `test: confirm refresh and save preserve piInfrastructureReadPaths` Add to `test/config-store.test.ts`: a `refresh()` case asserting a global `config.json` carrying `piInfrastructureReadPaths` reaches `store.current().piInfrastructureReadPaths`, and a `save()` case asserting an existing global array is written back when only booleans change (mirrors the [#332] save-preservation test).
   These should pass green against the step-4 production code (no further production change expected); if `save()` does *not* preserve, fold the minimal `save()` fix into this step.

## Risks and Mitigations

| Risk                                                                                                       | Mitigation                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refactoring `normalizePermissionSystemConfig` to use the shared helper subtly changes validation behavior. | Helper is a verbatim extraction of the existing guard; existing `extension-config` tests run in step 2 to confirm no behavior change.                                                    |
| Save path silently drops the array despite the loader fix.                                                 | Step 5 adds an explicit save-preservation test; the `...existing.config` spread is expected to preserve it (proven for [#332]), and the step folds in a `save()` fix if the test is red. |
| Merge-semantics choice (replace) surprises a user who wanted additive paths.                               | Decision recorded via `ask_user`; replace is consistent with every other field. Concatenation can be revisited as a follow-up if requested.                                              |
| `pnpm fallow dead-code` flags the new exported helper if a consumer imports it from the wrong place.       | Both `config-loader.ts` and `extension-config.ts` import it directly from `./common` (the established pattern for `normalizeOptionalPositiveInt`); two live consumers exist immediately. |

## Open Questions

- None blocking.
  Concatenating/union merge across layers is deferred unless a user requests it.

[#122]: https://github.com/gotgenes/pi-packages/issues/122
[#332]: https://github.com/gotgenes/pi-packages/issues/332
[#350]: https://github.com/gotgenes/pi-packages/issues/350
