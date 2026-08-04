---
issue: 266
issue_title: "Configurable input preview length + smart formatters for known MCP tools"
---

# Configurable tool-input preview-length limits

## Problem Statement

Permission prompts exist so the user can make an informed decision about a tool call.
Today the prompt preview truncates tool input at two hardcoded limits — `TOOL_INPUT_PREVIEW_MAX_LENGTH` (200, for inline JSON) and `TOOL_TEXT_SUMMARY_MAX_LENGTH` (80, for grep/find/ls patterns) — with no escape hatch.
The 80-char pattern limit is aggressive for long regexes or deep paths, and the 200-char JSON limit is hit immediately for any multi-command MCP tool call.
Silently truncating the input the user is being asked to approve defeats the purpose of the prompt.

This plan makes both limits configurable via the extension config so users can widen (or narrow) the preview to suit their tools.

## Goals

- Add two optional numeric fields to `PermissionSystemExtensionConfig`: `toolInputPreviewMaxLength` and `toolTextSummaryMaxLength`.
- Parse and validate them in `normalizePermissionSystemConfig` (positive integers; fall back to the existing constants when absent or invalid).
- Wire the configured limits into `ToolPreviewFormatter` construction inside `handleToolCall`, so user-configured limits take effect at runtime (including after a config reload).
- Keep the schema, example config, and `docs/configuration.md` aligned with the new fields.

This is a non-breaking, additive change — both fields are optional and default to today's hardcoded behavior.

## Non-Goals

- Smart per-tool input formatters (e.g. the `ctx_batch_execute` example in the issue body) — deferred to [#283].
- The formatter extension seam / `registerToolInputFormatter()` API — deferred to [#283].
- Making `TOOL_INPUT_LOG_PREVIEW_MAX_LENGTH` (the 1000-char review-log preview limit) configurable — the issue only asks for the two prompt-facing limits.
- Surfacing the numeric fields in the interactive `/permission-system` config modal — the modal handles boolean toggles only, and `piInfrastructureReadPaths` (the existing non-boolean field) is likewise edited directly in `config.json`.
- Extracting `ToolPreviewFormatter` from `tool-input-preview.ts` — already shipped in [#282].

## Background

This work is Phase 1 steps 3–4 of the pi-permission-system improvement roadmap (`packages/pi-permission-system/docs/architecture/architecture.md`).
The prerequisite extraction landed in [#282]: `ToolPreviewFormatter` (`src/tool-preview-formatter.ts`) is now a single injectable collaborator whose constructor accepts `ToolPreviewFormatterOptions`:

```typescript
export interface ToolPreviewFormatterOptions {
  toolInputPreviewMaxLength: number;
  toolTextSummaryMaxLength: number;
  toolInputLogPreviewMaxLength: number;
}
```

`PermissionGateHandler.handleToolCall` (`src/handlers/permission-gate-handler.ts:147`) currently constructs the formatter with the three hardcoded constants and a comment flagging that `#266 will wire config values`.
The formatter is constructed fresh on every `handleToolCall`, so reading config at construction time automatically picks up reloaded config — no explicit "reconstruct on refresh" step is needed.

`PermissionSession` exposes a `config` getter (`src/permission-session.ts:247`) that returns the current merged `PermissionSystemExtensionConfig` at call time and is refreshed on config reload.
`this.session.config` is the wiring point.

Config parsing lives in `normalizePermissionSystemConfig` (`src/extension-config.ts`).
The existing optional field `piInfrastructureReadPaths` shows the established pattern: only add the key to the normalized result when a valid value is present; otherwise omit it entirely.

Constraints from AGENTS.md and the package skill that apply:

- When adding an optional field to `PermissionSystemExtensionConfig`, do **not** add it to `DEFAULT_EXTENSION_CONFIG` with an explicit `undefined` value — tests use `deepEqual` and an explicit `undefined` breaks equality.
- Keep `schemas/permissions.schema.json`, `config/config.example.json`, `docs/configuration.md`, and the TypeScript type/loader aligned — changing one without the others is a bug.
- The schema uses `additionalProperties: false`, so a user config carrying the new fields fails editor validation until the schema is updated.
  The schema update must land in the same commit as the type change.
- Prefer config patterns over new runtime mechanisms.

## Design Overview

### Config shape

Two optional fields, undefined when absent or invalid:

```typescript
export interface PermissionSystemExtensionConfig {
  debugLog: boolean;
  permissionReviewLog: boolean;
  yoloMode: boolean;
  piInfrastructureReadPaths?: string[];
  /** Max length of the inline-JSON input preview shown in permission prompts. */
  toolInputPreviewMaxLength?: number;
  /** Max length of inline pattern/path summaries (grep/find/ls) in permission prompts. */
  toolTextSummaryMaxLength?: number;
}
```

### Validation helper

A small pure helper validates each numeric field:

```typescript
function normalizeOptionalPositiveInt(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0
    ? raw
    : undefined;
}
```

Decision: require a **positive integer**.
Zero, negatives, non-integers (`400.5`), and non-numbers all normalize to `undefined`, which falls back to the existing constant.
No upper cap — a deliberately large value simply means "never truncate", which is the escape-hatch the issue asks for.
`normalizePermissionSystemConfig` adds each field to the result only when the helper returns a defined value (mirroring `piInfrastructureReadPaths`).

### Config → formatter limits

The fallback-to-default logic is a pure function so it can be unit-tested without standing up a handler.
It reads only the two configurable fields (ISP — narrow `Pick` rather than the whole config):

```typescript
type ConfigurablePreviewLimits = Pick<
  PermissionSystemExtensionConfig,
  "toolInputPreviewMaxLength" | "toolTextSummaryMaxLength"
>;

export function resolveToolPreviewLimits(
  config: ConfigurablePreviewLimits,
): ToolPreviewFormatterOptions {
  return {
    toolInputPreviewMaxLength:
      config.toolInputPreviewMaxLength ?? TOOL_INPUT_PREVIEW_MAX_LENGTH,
    toolTextSummaryMaxLength:
      config.toolTextSummaryMaxLength ?? TOOL_TEXT_SUMMARY_MAX_LENGTH,
    toolInputLogPreviewMaxLength: TOOL_INPUT_LOG_PREVIEW_MAX_LENGTH,
  };
}
```

This lives in `tool-preview-formatter.ts` alongside the class and the options interface — it is the mapping from config to that interface, and it keeps the fallback constants colocated with the formatter that consumes them.

### Handler call site

`handleToolCall` replaces the hardcoded construction with:

```typescript
const formatter = new ToolPreviewFormatter(
  resolveToolPreviewLimits(this.session.config),
);
```

`this.session.config` is read at construction time on every tool call, so a config reload between calls takes effect on the next prompt without any extra refresh wiring.
This follows Tell-Don't-Ask at the seam — the handler asks the session for its config (a single getter) and hands the resolved limits to the formatter; it does not reach through the session into config internals.

### Edge cases

- Field absent → `undefined` → formatter uses the existing constant (current behavior preserved).
- Field present but invalid (string, `0`, negative, float) → `undefined` → falls back to the constant.
  No throw, no config issue emitted (consistent with how `piInfrastructureReadPaths` silently drops malformed input).
- Field present and valid → used verbatim, including very large values (no cap).
- Config modal "reset to defaults" (`cloneDefaultConfig`) drops the numeric fields, same as it already drops `piInfrastructureReadPaths` — acceptable and out of scope.

## Module-Level Changes

- `src/extension-config.ts` — add `toolInputPreviewMaxLength?` and `toolTextSummaryMaxLength?` to `PermissionSystemExtensionConfig`; add the `normalizeOptionalPositiveInt` helper; parse both fields in `normalizePermissionSystemConfig` (add to result only when defined).
  Do **not** touch `DEFAULT_EXTENSION_CONFIG`.
- `src/tool-preview-formatter.ts` — add `resolveToolPreviewLimits(config)` and import the three default constants from `tool-input-preview.ts` (which it already neighbors).
  The `TOOL_INPUT_PREVIEW_MAX_LENGTH` / `TOOL_TEXT_SUMMARY_MAX_LENGTH` / `TOOL_INPUT_LOG_PREVIEW_MAX_LENGTH` constants remain in `tool-input-preview.ts` as the fallback defaults.
- `src/handlers/permission-gate-handler.ts` — replace the inline `new ToolPreviewFormatter({ ...constants })` with `new ToolPreviewFormatter(resolveToolPreviewLimits(this.session.config))`; drop the three constant imports if they become unused there; remove the stale `#266 will wire config values` comment.
  Import `resolveToolPreviewLimits` from `#src/tool-preview-formatter`.
- `schemas/permissions.schema.json` — add `toolInputPreviewMaxLength` and `toolTextSummaryMaxLength` properties (`type: "integer"`, `minimum: 1`, with `description`/`markdownDescription`, no `default` so omission stays meaningful).
- `config/config.example.json` — add the two fields under the runtime-knobs block with their default values (`400` and `120` per the issue's suggested example, or the current `200`/`80` defaults — see Open Questions).
- `docs/configuration.md` — add both fields to the Runtime Knobs table and the Full Example block.
- `docs/architecture/architecture.md` — mark Phase 1 steps 3 and 4 complete (the `### Improvement roadmap — Phase 1` checklist).

No exported symbol is removed or renamed, so no broad grep-and-update is required.
The three default constants stay exported and keep their existing tests (`tool-input-preview.test.ts` asserts they equal 200/1000/80 — unchanged).

## Test Impact Analysis

This is an additive feature, not an extraction, so the extraction-specific questions are mostly N/A.

1. New tests enabled:
   - `normalizeOptionalPositiveInt` and the two new config fields in `extension-config.test.ts` (valid, absent, zero, negative, float, non-number).
   - `resolveToolPreviewLimits` in `tool-preview-formatter.test.ts` (configured values used; missing fields fall back to constants; log-preview limit always the constant).
2. Redundant existing tests: none.
   The existing constant assertions in `tool-input-preview.test.ts` still hold (constants are unchanged) and document the fallback defaults.
3. Tests that must stay as-is: `tool-preview-formatter.test.ts` formatting tests, `extension-config.test.ts` existing boolean-field cases, and the constant assertions in `tool-input-preview.test.ts`.

## TDD Order

1. Config schema layer (test → green → commit).
   - Surface: `test/extension-config.test.ts`.
   - Red: add cases for `normalizeOptionalPositiveInt` and for `normalizePermissionSystemConfig` parsing both new fields — valid integer kept, absent → key omitted, `0`/negative/float/string → key omitted, existing boolean behavior preserved.
   - Green: add the two optional fields to `PermissionSystemExtensionConfig`, add the helper, parse both fields in `normalizePermissionSystemConfig`.
   - Same commit: update `schemas/permissions.schema.json` and `config/config.example.json` (the schema's `additionalProperties: false` makes these a hard dependency on the type change).
   - Commit: `feat: add toolInputPreviewMaxLength and toolTextSummaryMaxLength config fields (#266)`.
2. Resolve + wire (test → green → commit).
   - Surface: `test/tool-preview-formatter.test.ts` for `resolveToolPreviewLimits`.
   - Red: assert configured values flow through, missing fields fall back to `TOOL_INPUT_PREVIEW_MAX_LENGTH` / `TOOL_TEXT_SUMMARY_MAX_LENGTH`, and `toolInputLogPreviewMaxLength` is always `TOOL_INPUT_LOG_PREVIEW_MAX_LENGTH`.
   - Green: add `resolveToolPreviewLimits`; update `handleToolCall` to construct the formatter from `resolveToolPreviewLimits(this.session.config)`; remove the stale comment and any now-unused constant imports in the handler.
   - Run `pnpm run check` after this commit — it changes a call site that depends on the config type from step 1.
   - Commit: `feat: use configured preview limits in permission prompts (#266)`.
3. Documentation (build → commit).
   - Update `docs/configuration.md` (Runtime Knobs table + Full Example) and mark Phase 1 steps 3–4 complete in `docs/architecture/architecture.md`.
   - Commit: `docs: document configurable tool-preview length knobs (#266)`.

## Risks and Mitigations

- Risk: a user sets a pathologically large value and the prompt becomes very long.
  Mitigation: this is the intended escape hatch; truncation still applies at the configured length, and the user opted in.
  No cap keeps the behavior predictable.
- Risk: schema `additionalProperties: false` rejects a user config that adds the fields before the schema ships them.
  Mitigation: schema update is folded into the same commit as the type change (step 1).
- Risk: an explicit `undefined` leaks into `DEFAULT_EXTENSION_CONFIG` and breaks `deepEqual` tests.
  Mitigation: the plan explicitly leaves `DEFAULT_EXTENSION_CONFIG` untouched; the fields are only added to the normalized result when defined.
- Risk: forgetting to update `docs/configuration.md` / example, leaving docs and schema out of sync.
  Mitigation: step 1 bundles schema + example with the type; step 3 covers prose docs; the package skill calls out alignment as a bug.

## Open Questions

- Example/doc default values: the issue suggests `400` and `120` as illustrative values, but the code defaults (when the field is omitted) stay at `200` and `80`.
  Decision deferred to implementation: show the issue's `400`/`120` in `config.example.json` as a "here's how to widen it" demonstration, or echo the `200`/`80` code defaults for accuracy.
  Leaning toward documenting the code defaults in the Runtime Knobs table (accurate) while optionally showing a widened value in the example file with a comment.
  Resolve when writing step 1/step 3.

[#282]: https://github.com/gotgenes/pi-packages/issues/282
[#283]: https://github.com/gotgenes/pi-packages/issues/283
