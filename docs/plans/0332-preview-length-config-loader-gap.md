---
issue: 332
issue_title: "`toolInputPreviewMaxLength` (and `toolTextSummaryMaxLength`) in `config.json` are silently ignored — preview is always truncated at the hardcoded default"
---

# Fix `toolInputPreviewMaxLength` / `toolTextSummaryMaxLength` loader gap

## Problem Statement

Setting `toolInputPreviewMaxLength` or `toolTextSummaryMaxLength` in `config.json` has no effect.
The permission-prompt preview is always truncated at the hardcoded default of 200 (or 80 for text summaries), regardless of the configured value.

The downstream machinery is correct: `normalizePermissionSystemConfig()` parses both fields, `resolveToolPreviewLimits()` reads them, and `ToolPreviewFormatter` applies them.
The break is in the loader pipeline.
`loadAndMergeConfigs()` produces a `UnifiedPermissionConfig` (`src/config-loader.ts`) as its intermediate type, and that type does **not** declare the two fields.
As a result:

- `normalizeUnifiedConfig()` never reads the fields from raw JSON — they are silently dropped.
- `mergeUnifiedConfigs()` iterates only over `["debugLog", "permissionReviewLog", "yoloMode"]` when merging scalars, so even a present value would not survive the merge.
- By the time `ConfigStore.refresh()` calls `normalizePermissionSystemConfig(mergeResult.merged)`, the fields are already gone, so `resolveToolPreviewLimits()` falls back to the hardcoded constants.

A secondary symptom exists in `ConfigStore.save()` (`src/config-store.ts`).
The merge `{ ...existing.config, debugLog, permissionReviewLog, yoloMode }` loads `existing.config` through the same broken loader, so a user-set value is dropped from `existing.config` and therefore deleted from the global file on the next modal save.
This symptom resolves automatically once the loader is fixed: the `...existing.config` spread will carry the parsed fields through unchanged (see Design Overview).

## Goals

- Make `toolInputPreviewMaxLength` and `toolTextSummaryMaxLength` flow through the load/merge pipeline so configured values reach `ToolPreviewFormatter`.
- Ensure `ConfigStore.save()` preserves an existing global value rather than deleting it.
- Keep schema, example config, docs, loader, and TypeScript types aligned.

## Non-Goals

- The `toolInputFormatters` extension point and smart MCP formatters from the parent enhancement (#266) — already shipped; not touched here.
- Editing the two preview-length fields from the `/permission-system` config modal UI — out of scope.
- Changing the merge semantics of the existing scalar knobs or the `permission` object.
- Schema, `config/config.example.json`, and `docs/configuration.md` field documentation — already present and correct (verified during planning); no edits needed.

## Background

Relevant modules:

- `src/config-loader.ts` — owns `UnifiedPermissionConfig`, `normalizeUnifiedConfig()`, `mergeUnifiedConfigs()`, `loadAndMergeConfigs()`, `loadUnifiedConfig()`.
  This is the loader layer; it currently imports only `./common`, `./config-paths`, `./permission-merge`, and `./types`.
- `src/extension-config.ts` — owns `PermissionSystemExtensionConfig`, `normalizePermissionSystemConfig()`, and `normalizeOptionalPositiveInt()`.
  This is the higher-level config-shape layer.
- `src/common.ts` — shared, dependency-light helpers (`toRecord`, `getNonEmptyString`, `isPermissionState`, …).
  Both `config-loader.ts` and `extension-config.ts` already import from it; it imports nothing from either.
- `src/config-store.ts` — `ConfigStore.refresh()` (load → normalize → store) and `ConfigStore.save()` (load existing → merge → write global).
- `src/tool-preview-formatter.ts` — `resolveToolPreviewLimits()` and `ToolPreviewFormatter` (the correct, already-wired consumer).

Constraint from the package skill: "Keep schema, example config, `docs/configuration.md`, `README.md`, and TypeScript types/loaders aligned."
Verified during planning that the schema (`schemas/permissions.schema.json`), example (`config/config.example.json`), and `docs/configuration.md` all already document both fields — only the loader is out of sync.

Constraint from the package skill: "Treat any declared config field not read at runtime as a maintenance trap."
This plan closes exactly such a trap: the fields are declared on `PermissionSystemExtensionConfig` and documented, but never read from disk.

## Design Overview

### Shared `normalizeOptionalPositiveInt`

The loader needs the same positive-integer normalization that `extension-config.ts` already uses.
`normalizeOptionalPositiveInt` is currently exported from `extension-config.ts`.
Importing it into `config-loader.ts` would not create a literal import cycle today (verified: neither module imports the other), but it would make the low-level loader depend on the higher-level config-shape module — the wrong direction.

Move `normalizeOptionalPositiveInt` to `src/common.ts` (the dependency-light shared module both layers already import) and re-export nothing speculative.
`extension-config.ts` imports it from `common`; `config-loader.ts` imports it from `common`.

### Loader changes (the actual fix)

Add the two fields to `UnifiedPermissionConfig`, parse them in `normalizeUnifiedConfig()`, and include them in the `mergeUnifiedConfigs()` scalar loop:

```typescript
export interface UnifiedPermissionConfig {
  debugLog?: boolean;
  permissionReviewLog?: boolean;
  yoloMode?: boolean;
  toolInputPreviewMaxLength?: number;
  toolTextSummaryMaxLength?: number;
  permission?: FlatPermissionConfig;
}
```

```typescript
// in normalizeUnifiedConfig()
const toolInputPreviewMaxLength = normalizeOptionalPositiveInt(
  record.toolInputPreviewMaxLength,
);
if (toolInputPreviewMaxLength !== undefined)
  config.toolInputPreviewMaxLength = toolInputPreviewMaxLength;

const toolTextSummaryMaxLength = normalizeOptionalPositiveInt(
  record.toolTextSummaryMaxLength,
);
if (toolTextSummaryMaxLength !== undefined)
  config.toolTextSummaryMaxLength = toolTextSummaryMaxLength;
```

```typescript
// in mergeUnifiedConfigs()
for (const key of [
  "debugLog",
  "permissionReviewLog",
  "yoloMode",
  "toolInputPreviewMaxLength",
  "toolTextSummaryMaxLength",
] as const) {
  const value = override[key] ?? base[key];
  if (value !== undefined) {
    merged[key] = value;
  }
}
```

Merge semantics match the existing scalars: override (project / per-agent) replaces base (global) when present; last writer wins.
This matches how `mergeFlatPermissions` treats per-surface overrides and is what users expect from the documented precedence (global → project → per-agent).

### Save path (no code change — relies on the spread)

`ConfigStore.save()` already merges via:

```typescript
const existing = loadUnifiedConfig(globalPath); // now parses both fields
const merged = {
  ...existing.config, // carries toolInputPreviewMaxLength / toolTextSummaryMaxLength through unchanged
  debugLog: normalized.debugLog,
  permissionReviewLog: normalized.permissionReviewLog,
  yoloMode: normalized.yoloMode,
};
```

Once `loadUnifiedConfig()` parses the two fields, `existing.config` carries them, and the spread preserves whatever is in the global file verbatim.
No further change to `save()` is needed.

This is deliberately preferred over explicitly writing `normalized.toolInputPreviewMaxLength` into the merge (the issue's proposed fix).
The in-memory `normalized` config is the *merged* value (global + project + per-agent); writing it into the global file would bake a project-level or per-agent override into global.
The three booleans are editable in the modal, so persisting their merged value to global is the intended save behavior; the two preview-length fields are not modal-editable, so the correct behavior is to leave the on-disk global value untouched — exactly what the spread does. (Decision confirmed with the user during planning.)

### Edge cases

- Invalid values (zero, negative, non-integer, non-number) — `normalizeOptionalPositiveInt` returns `undefined`, so the field is omitted and the default applies.
  Same semantics already enforced by `normalizePermissionSystemConfig`.
- Field present in project but not global — survives the merge as the override; `refresh()` picks it up.
- Field present in global, modal save toggles a boolean — spread preserves the global value; nothing deleted.

## Module-Level Changes

- `src/common.ts` — add `normalizeOptionalPositiveInt` (moved verbatim from `extension-config.ts`).
- `src/extension-config.ts` — remove the local `normalizeOptionalPositiveInt` definition; import it from `./common`.
  `normalizePermissionSystemConfig` keeps using it unchanged.
- `src/config-loader.ts` — add the two optional fields to `UnifiedPermissionConfig`; import `normalizeOptionalPositiveInt` from `./common`; parse both fields in `normalizeUnifiedConfig()`; extend the `mergeUnifiedConfigs()` scalar loop.
- `src/config-store.ts` — no change (the spread in `save()` does the work once the loader is fixed).
- `test/common.test.ts` — receive the migrated `normalizeOptionalPositiveInt` unit tests.
- `test/extension-config.test.ts` — drop the `normalizeOptionalPositiveInt` direct tests (now in `common.test.ts`); keep the `normalizePermissionSystemConfig` tests that exercise the two fields end-to-end through the higher-level normalizer.
- `test/config-loader.test.ts` — add coverage for parsing and merging the two fields.
- `test/config-store.test.ts` — add a regression test that `save()` preserves an existing global preview-length value.

No exports are removed except the relocation of `normalizeOptionalPositiveInt` from `extension-config.ts` to `common.ts`.

### Consumers of the relocated symbol

`normalizeOptionalPositiveInt` is currently imported from `extension-config` by:

- `test/extension-config.test.ts` (direct unit tests) — move these to `test/common.test.ts`.

No `src/` module other than `extension-config.ts` itself imports it today, and the package skill (`.pi/skills/package-pi-permission-system/SKILL.md`) does not reference it.
After the move, both `extension-config.ts` and `config-loader.ts` import it from `common`.

## Test Impact Analysis

This is a bug fix plus a small symbol relocation, not an extraction that unlocks new isolated units.

1. New tests enabled: loader-level tests for the two fields (parse in `normalizeUnifiedConfig`, survive `mergeUnifiedConfigs`) — previously the fields could not be exercised at the loader layer because the type omitted them.
   A `save()` preservation regression test that was meaningless before (the value never reached `existing.config`).
2. Redundant tests: none become redundant.
   The `normalizeOptionalPositiveInt` direct tests are relocated, not deleted — they continue to assert the same contract from `common.test.ts`.
   The `normalizePermissionSystemConfig` field tests in `extension-config.test.ts` stay; they verify the higher-level normalizer, a different layer from the loader.
3. Tests that must stay as-is: the `normalizePermissionSystemConfig` and `resolveToolPreviewLimits` suites genuinely exercise the downstream layers that were always correct; they remain unchanged.

## TDD Order

1. Relocate `normalizeOptionalPositiveInt` to `common`.
   Move the function to `src/common.ts`, import it into `src/extension-config.ts`, and move its direct unit tests from `test/extension-config.test.ts` to `test/common.test.ts`.
   This is a single atomic step: removing the export from `extension-config.ts` and updating its sole test consumer must land together so the type checker stays green.
   Suggested commit: `refactor: move normalizeOptionalPositiveInt to common module`.
2. Parse the two fields in the loader (red → green).
   Add the fields to `UnifiedPermissionConfig`, import `normalizeOptionalPositiveInt` from `common`, parse both in `normalizeUnifiedConfig()`.
   Add `test/config-loader.test.ts` cases: valid positive integers are parsed; invalid values (0, negative, float, string) are omitted; absent fields stay absent.
   Suggested commit: `fix: parse tool preview length fields in unified config loader`.
3. Merge the two fields (red → green).
   Extend the `mergeUnifiedConfigs()` scalar loop.
   Add `test/config-loader.test.ts` cases: override value wins over base; base value survives when override omits it; both absent yields absent.
   Suggested commit: `fix: merge tool preview length fields across config layers`.
4. Regression-test save-path preservation (red → green).
   Add a `test/config-store.test.ts` case under `save()` asserting that when `loadUnifiedConfig` returns a config containing `toolInputPreviewMaxLength`, the written global config retains it.
   With steps 2–3 in place the spread already preserves it, so this test confirms the secondary symptom is closed.
   Suggested commit: `test: confirm save preserves configured tool preview length`.

If step 4 passes immediately on the parse/merge fix (expected), keep it as a guard rather than forcing a separate production change.

## Risks and Mitigations

- Risk: the relocation of `normalizeOptionalPositiveInt` breaks an unseen importer.
  Mitigation: grep `src/` and `test/` for the symbol before finalizing (done during planning — only `extension-config.ts` and `extension-config.test.ts` reference it); the type checker catches any miss in step 1.
- Risk: merge precedence surprises (e.g. project value unexpectedly overriding a global value).
  Mitigation: precedence mirrors the existing booleans and the documented global → project → per-agent order; step 3 tests both directions.
- Risk: baking a merged override into the global file on save.
  Mitigation: rely on the `...existing.config` spread rather than writing the in-memory merged value; step 4 guards the global-preservation behavior.

## Open Questions

None.
The schema, example, and docs already document both fields; the fix is confined to the loader plus a symbol relocation.
