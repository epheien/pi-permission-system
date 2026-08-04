---
issue: 547
issue_title: "Include a JSON Schema definition in pi-permissions.jsonc for completions and easier configuration"
---

# Adopt zod as the single source of truth for config schema and validation

## Release Recommendation

**Release:** ship independently

Issue #547 is not referenced by any step in `docs/architecture/architecture.md`, so it carries no batch tag and releases on its own.
It is a self-contained change to the config-loading surface with a breaking validation-behavior shift, so it warrants its own version bump and changelog entry rather than batching.

## Problem Statement

The issue author (a third party) asks for a `$schema` field and a hosted JSON Schema so editors give completions and flag typos in the permission-system config.
Investigation shows the schema **already exists** (`schemas/permissions.schema.json`), the config **already accepts** `$schema`, and the example config already sets it — so completions technically work today.
Two real defects remain underneath the request:

1. Every hosted URL (`$id` in the schema, `$schema` in the example config, and doc references) points to `raw.githubusercontent.com/gotgenes/pi-permission-system/...` — the pre-monorepo upstream fork repo, not the monorepo `gotgenes/pi-packages/packages/pi-permission-system/...`.
   The old repo is a stale mirror, not the source of truth.
2. The JSON Schema is **hand-maintained** separately from the TypeScript types and the hand-rolled loader guards — the exact drift trap the package skill warns about ("keep schema, example config, docs, types, and loaders aligned").

The operator (repo owner) elected to fix the root cause rather than just the request: adopt a runtime schema library as the single source of truth, derive the JSON Schema from it, and route the config loader's runtime validation through it — with **zod** (operator preference over the issue's TypeBox suggestion), and with **strict** validation that rejects a malformed config field and reports a clear, actionable description of the problem.

## Goals

- Make a composable set of **zod** schemas (zod `4.4.3`, the current production `latest`) the single source of truth for the permission-system config file shape.
- Derive `schemas/permissions.schema.json` (Draft 2020-12) from the zod schemas at build time, preserving the rich editor metadata (`title`, `description`, `markdownDescription`, `$defs`, `examples`, `additionalProperties: false`, `propertyNames`) the hand-maintained schema carries today.
- Route the runtime config loader's validation through the same zod schema (`safeParse`), replacing the per-field hand-rolled normalization.
- **Breaking:** an invalid config field now causes the loader to **reject that scope's config** (fail-closed to the universal `ask` default) instead of silently discarding the field, and to report a clear, per-issue description naming the field, its JSON path, and the problem.
  Suggested commit: `feat(pi-permission-system)!: …` with a `BREAKING CHANGE:` footer.
- Repoint every hosted schema URL from the stale `gotgenes/pi-permission-system` fork to the monorepo `gotgenes/pi-packages/…/pi-permission-system/…` raw path.
- Add a freshness gate (a parity test) so the checked-in JSON Schema cannot drift from the zod source.
- Remove the config-only hand-rolled guards that zod supersedes.

## Non-Goals

- **Not** re-plumbing the flat-permission-to-`Rule` translation (`normalize.ts`, `policy-loader.ts`).
  Those consume already-validated config and keep using `isPermissionState` / `isDenyWithReason`; tightening them now that inputs are typed overlaps with roadmap Step 8 ([#532], open) and is deferred there (see Open Questions).
- **Not** completing [#532] (split `value-guards.ts` by cohesion).
  This plan removes the two config-only guards ([`normalizeOptionalStringArray`, `normalizeOptionalPositiveInt`]) that [#532] intended to keep, shrinking but not eliminating `value-guards.ts`; the domain-guard move [#532] describes stays its own work.
- **Not** validating per-agent frontmatter `permission:` blocks through the zod schema — this plan scopes to the global/project config **files** (see Open Questions).
- **Not** changing the permission model, merge precedence, legacy-file detection, or the permissive-bash-fallback detector — those behaviors are preserved.
- **Not** adding a bundler/`dist` build; the package still ships `src` directly.

## Background

Relevant modules:

- `src/config-loader.ts` (432 LOC) — `loadUnifiedConfig` reads a file, strips JSONC comments (`stripJsonComments`), `JSON.parse`s, then `normalizeUnifiedConfig(parsed)` hand-normalizes each field (via `value-guards`) and `normalizeFlatPermissionValue` narrows the permission map.
  `mergeUnifiedConfigs` deep-shallow merges scopes; `loadAndMergeConfigs` orchestrates legacy detection + merge; `detectPermissiveBashFallback` warns on an ungated bash surface.
  Exposes `UnifiedPermissionConfig` (the raw file shape, all-optional).
- `src/value-guards.ts` — `toRecord`, `getNonEmptyString` (used widely across tool-input formatters and gates), plus the config-only `normalizeOptionalStringArray`, `normalizeOptionalPositiveInt`, and the domain guards `isPermissionState`, `isDenyWithReason`.
- `src/types.ts` — `PermissionState`, `DenyWithReason`, `PatternValue`, `FlatPermissionConfig` (config-shape types), alongside non-config domain types (`PermissionCheckResult`, `BashCommandContext`, etc.).
- `src/extension-config.ts` — `normalizePermissionSystemConfig` applies runtime **defaults** post-merge (`debugLog: false`, `permissionReviewLog: true`, `yoloMode: false`) to produce `PermissionSystemExtensionConfig`.
- `schemas/permissions.schema.json` — the hand-maintained Draft 2020-12 schema (already in the `files` allowlist, already shipped).
- `config/config.example.json`, `docs/configuration.md`, `docs/opencode-compatibility.md` — reference the schema URL.

Constraints from AGENTS.md / package skill that apply:

- Least privilege / fail-closed: "when in doubt, prompt (`ask`), do not silently allow."
  A rejected config must fall back to the safe `ask` default, never `allow`.
- Keep schema, example config, `docs/configuration.md`, `README.md`, and TS types/loaders aligned — this plan collapses that alignment into a single generated artifact.
- `docs/architecture/architecture.md` names `value-guards.ts`'s function inventory in prose (line 807) and in the [#532] roadmap step (line 906); removing two functions must update that prose.
- When changing a `package.json` dependency, run `pnpm install` and commit `pnpm-lock.yaml` in the same commit; a freshly published version may need a `minimumReleaseAgeExclude` entry (zod `4.4.3` is mature, but verify at implementation time).
- Run `pnpm fallow dead-code` locally before pushing — a new runtime dependency and removed exports both interact with the dead-code gate.

zod facts verified for this plan (zod `4.4.3`, `z.toJSONSchema`):

- Default `target` is `draft-2020-12` (matches the existing schema).
- `reused: "ref"` extracts shared sub-schemas into `$defs` — the composability path to the existing `permissionState` / `permissionMap` / `denyWithReason` `$defs`.
- Metadata is attached via `.meta({ … })`; "all metadata fields get copied into the resulting JSON Schema," which is the mechanism for `title` / `description` / `examples` and, we expect, custom `markdownDescription`.
  There is an open upstream request ([colinhacks/zod#5272]) about native `markdownDescription`, so if `.meta({ markdownDescription })` is not copied verbatim, the `override` callback (which can "directly modify `ctx.jsonSchema`") re-emits it — the parity test (Step 2) decides which path is needed.
- `safeParse` returns `{ success, data | error }` (never throws); `error.issues` carries every issue with `code`, `path`, `message`; `z.treeifyError` / `z.flattenError` format them.

## Design Overview

### Composable zod schemas (single source of truth)

New module `src/config-schema.ts` builds the schema bottom-up, mirroring the existing `$defs`, so each piece is defined once and reused (per the operator's composability directive — reuse where it removes duplication, no abstraction beyond the existing `$defs` grain):

```typescript
import { z } from "zod";

export const permissionStateSchema = z
  .enum(["allow", "deny", "ask"])
  .meta({ id: "permissionState", description: "…", markdownDescription: "…" });

export const denyWithReasonSchema = z
  .strictObject({
    action: z.literal("deny"),
    reason: z.string().max(500).optional(),
  })
  .meta({ id: "denyWithReason", description: "…" });

export const patternValueSchema = z.union([
  permissionStateSchema,
  denyWithReasonSchema,
]);

export const permissionMapSchema = z
  .record(z.string().min(1), patternValueSchema)
  .meta({ id: "permissionMap", description: "…", markdownDescription: "…" });

const surfaceValueSchema = z.union([permissionStateSchema, permissionMapSchema]);

export const permissionSchema = z
  .record(z.string().min(1), surfaceValueSchema)
  .meta({ description: "…", markdownDescription: "…", examples: [/* … */] });

// The on-disk file shape: every field OPTIONAL (partial global/project
// configs merge before defaults are applied). strictObject → editors flag
// unknown keys and the runtime rejects them.
export const unifiedConfigSchema = z
  .strictObject({
    $schema: z.string().optional(),
    debugLog: z.boolean().optional(),
    permissionReviewLog: z.boolean().optional(),
    yoloMode: z.boolean().optional(),
    toolInputPreviewMaxLength: z.int().min(1).optional(),
    toolTextSummaryMaxLength: z.int().min(1).optional(),
    piInfrastructureReadPaths: z.array(z.string().min(1)).optional(),
    permission: permissionSchema.optional(),
  })
  .meta({ id: "PermissionSystemConfig", title: "…", description: "…", markdownDescription: "…" });

export type UnifiedPermissionConfig = z.infer<typeof unifiedConfigSchema>;
```

Design notes:

- **No `.default()` in the parse schema.**
  Defaults are applied later by `normalizePermissionSystemConfig` after the merge, so injecting them at parse time would break global-vs-project override semantics.
  The file schema stays all-optional (the raw shape).
- The `permission` map and surface maps are open `z.record` (arbitrary surface/pattern keys), matching the existing schema's `additionalProperties` union; only the top-level config object and `denyWithReason` are `strictObject`.
- Allowing `$schema` as an explicit optional string is required — `strictObject` would otherwise reject the very `$schema` key the feature adds.

### Deriving the JSON Schema

`buildPermissionsJsonSchema()` (exported from `src/config-schema.ts`):

```typescript
export function buildPermissionsJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(unifiedConfigSchema, {
    target: "draft-2020-12",
    reused: "ref", // extract permissionState/permissionMap/denyWithReason into $defs
    override: (ctx) => {
      // Re-emit markdownDescription from meta if not auto-copied; nothing else.
    },
  });
  // Set the root $id to the monorepo raw path (single, corrected URL).
  return { ...schema, $id: MONOREPO_SCHEMA_URL };
}
```

`scripts/generate-permissions-schema.ts` calls it and writes `schemas/permissions.schema.json` pretty-printed.
A `gen:schema` package script runs it (Node 22 type-strip: `node --experimental-strip-types scripts/generate-permissions-schema.ts`; confirm the flag/behavior at implementation time).

### Runtime validation (breaking)

`normalizeUnifiedConfig(parsed: unknown): UnifiedConfigLoadResult` is rewritten:

```typescript
function normalizeUnifiedConfig(parsed: unknown): UnifiedConfigLoadResult {
  // Legacy top-level keys get the existing migration guidance first,
  // so a legacy config yields a helpful message, not an opaque "unrecognized key".
  const legacyIssues = describeMisplacedPermissionKeys(parsed);

  const result = unifiedConfigSchema.safeParse(parsed);
  if (!result.success) {
    return {
      config: {}, // fail-closed: contributes no rules → universal `ask`
      issues: [...legacyIssues, ...formatConfigIssues(result.error)],
    };
  }
  return { config: result.data, issues: legacyIssues };
}
```

- `formatConfigIssues` maps each `ZodIssue` to a clear string: the field's JSON path (e.g. `permission.bash.git status`), the problem (`expected boolean, received string`), and the offending value where safe to echo.
  This satisfies the operator's requirement for "a clear description of the problems with the configuration."
- **Fail-closed:** an invalid config produces an **empty** `UnifiedPermissionConfig` for that scope, so the missing surfaces fall through to the universal `ask` default — never `allow`.
  This is the security-critical invariant and gets an explicit test.
- Per-scope granularity: each file is validated independently in `loadUnifiedConfig`, so a bad global config does not silently take the project config down with it (and vice versa); each contributes `{}` on failure with its own issues.
- `stripJsonComments`, `mergeUnifiedConfigs`, `loadAndMergeConfigs`, legacy-file detection, and `detectPermissiveBashFallback` are **unchanged** — zod validates the parsed object; it does not parse JSONC or merge or translate to rules.

### Design-review checklist (shared-interface change)

The change is contained to `config-loader.ts` internals and one new module.
`loadUnifiedConfig` keeps its `(path) => { config, issues }` contract; `UnifiedConfigLoadResult` and `UnifiedPermissionConfig` keep their names (the latter now `z.infer`-derived).
No new dependency bag is threaded through layers, no reach-through/LoD chain is introduced, no output-argument mutation, no parameter relay.
Verdict: no structural smells; the fixes are inline in this PR.

### Type de-duplication

`UnifiedPermissionConfig` becomes `z.infer<typeof unifiedConfigSchema>` (defined in `config-schema.ts`, re-exported from `config-loader.ts` for existing importers).
`src/types.ts`'s `PermissionState`, `DenyWithReason`, `PatternValue`, and `FlatPermissionConfig` become `z.infer` re-exports of the corresponding schemas, keeping the same export names so all ~58 consumers compile untouched.
A type-equivalence assertion (Step 1) proves the inferred types match the current hand-written ones before the switch, so the migration is a safe lift-and-shift.
Non-config types in `types.ts` stay hand-written.

## Module-Level Changes

Added:

- `src/config-schema.ts` — composable zod schemas, `z.infer` type aliases, `buildPermissionsJsonSchema()`, `MONOREPO_SCHEMA_URL`.
- `scripts/generate-permissions-schema.ts` — writes `schemas/permissions.schema.json` from `buildPermissionsJsonSchema()`.
- `test/config-schema.test.ts` — valid/invalid parse behavior, clear-message assertions, JSON-Schema parity (deep-equals the committed file), and type-equivalence assertions.
- `docs/decisions/0004-zod-config-schema-single-source.md` — ADR: why zod, why strict/breaking, the fail-closed rejection semantics, and the generated-schema freshness gate.
- `docs/migration/strict-config-validation.md` — short migration note: malformed config fields are now rejected with a clear message; how to read the error and fix the config.

Changed:

- `src/config-loader.ts` — `normalizeUnifiedConfig` rewritten to `safeParse` + issue mapping + fail-closed reject; remove `normalizeFlatPermissionValue`; drop imports of `normalizeOptionalStringArray`, `normalizeOptionalPositiveInt`, `isPermissionState`, `isDenyWithReason`, `toRecord` where the rewrite makes them unused; re-export `UnifiedPermissionConfig` from `config-schema.ts`.
- `src/value-guards.ts` — remove `normalizeOptionalStringArray` and `normalizeOptionalPositiveInt` (sole callers were in `config-loader.ts`); keep `toRecord`, `getNonEmptyString`, `isPermissionState`, `isDenyWithReason` (other consumers remain).
- `src/types.ts` — `PermissionState`, `DenyWithReason`, `PatternValue`, `FlatPermissionConfig` become `z.infer` re-exports from `config-schema.ts`.
- `test/value-guards.test.ts` — remove the tests for the two deleted functions.
- `test/config-loader.test.ts` — update the tolerance tests to the new reject-with-clear-message behavior; add the fail-closed-to-`ask` security test; keep merge / legacy-detection / bash-fallback tests.
- `schemas/permissions.schema.json` — regenerated from zod; `$id` repointed to the monorepo raw URL (content otherwise byte-equivalent in intent to today's).
- `config/config.example.json` — `$schema` repointed to the monorepo raw URL.
- `docs/configuration.md` — `$schema` example URL (line 39), the schema-validation command (line 696), and the editor tip (line 700).
- `docs/opencode-compatibility.md` — `$schema` URL (line 156).
- `docs/architecture/architecture.md` — module-layout: add `config-schema.ts`, update the `value-guards.ts` function list (line 807) to drop the two removed names; update the [#532] step description (line 906) to note the two functions were removed by #547; re-check the fallow-target health rows (lines 845/905) and adjust if the metric shifts (re-run `pnpm fallow` at implementation time).
- `package.json` — add `zod` to `dependencies`; add the `gen:schema` script.
- `pnpm-lock.yaml` — updated by `pnpm install` (commit alongside `package.json`); add a `pnpm-workspace.yaml` `minimumReleaseAgeExclude` entry only if `zod@4.4.3` trips the min-release-age gate.
- `.pi/skills/package-pi-permission-system/SKILL.md` — update the "keep schema, example config, docs, types, loaders aligned" note to reflect that the schema is now **generated** from `config-schema.ts` (edit the zod source + `gen:schema`, never the JSON by hand).

## Test Impact Analysis

1. **New tests the extraction enables** — `config-schema.test.ts` unit-tests validation in isolation (no filesystem): valid configs parse, each malformed field yields a specific clear message, and the derived JSON Schema deep-equals the committed artifact (freshness gate).
   Previously validation was reachable only through `config-loader.ts`'s file-IO path.
2. **Tests that become redundant / reworked** — `config-loader.test.ts`'s "silently discards a bad field" cases are reworked into "rejects with a clear message" cases (behavior change, not deletion); `value-guards.test.ts`'s cases for the two removed functions are deleted.
3. **Tests that must stay** — `config-loader.test.ts`'s merge-precedence, legacy-file-detection, JSONC-comment-stripping, and `detectPermissiveBashFallback` tests genuinely exercise behavior zod does not cover and stay as-is.

## Invariants at risk

This change touches the config-loading surface hardened by prior work:

- **Fail-closed / least privilege** (package skill; #452 bash-gate hardening in spirit) — a malformed or unreadable config must resolve to the universal `ask` default, never `allow`.
  Pinned by a new `config-loader.test.ts` test: a global config with an invalid field yields an empty scope config and every surface resolves to `ask`.
- **Legacy-file migration guidance** (`loadAndMergeConfigs`) — legacy configs still emit the move-the-file message.
  Pinned by the existing legacy-detection tests; extend one to confirm the message survives the zod-reject path.
- **Permissive-bash-fallback warning** (`detectPermissiveBashFallback`) — still fires on `*: allow` with an ungated bash surface.
  Pinned by the existing test.

## TDD Order

1. **Add zod + composable schema module (pure addition).**
   Red: `test/config-schema.test.ts` asserts `unifiedConfigSchema.safeParse(validConfig).success`, that a malformed field fails with a specific message, and type-equivalence assertions (`expectTypeOf<z.infer<typeof …>>().toEqualTypeOf<PermissionState | DenyWithReason | PatternValue | FlatPermissionConfig>()`).
   Green: add `zod` to `dependencies`, `pnpm install` (commit lockfile), implement `src/config-schema.ts`.
   Run `pnpm run check` (new dependency + module).
   Commit: `feat(pi-permission-system): add zod config schema as validation source`.
2. **Derive and pin the JSON Schema; fix the hosted URL.**
   Red: parity test — the committed `schemas/permissions.schema.json` deep-equals `buildPermissionsJsonSchema()` (fails until regenerated).
   Green: add `scripts/generate-permissions-schema.ts` + `gen:schema`, run it, commit the regenerated schema with the corrected monorepo `$id`; adjust `.meta()`/`override` until `markdownDescription`, `$defs`, `examples`, `additionalProperties`, and `propertyNames` match the intent of today's schema.
   Commit: `feat(pi-permission-system): generate JSON Schema from zod and fix hosted $id URL`.
3. **Route the loader through zod (BREAKING).**
   Red: update `test/config-loader.test.ts` — a bad field now rejects the scope config with a clear message; add the fail-closed-to-`ask` security test.
   Green: rewrite `normalizeUnifiedConfig` (`safeParse` + issue mapping + fail-closed), remove `normalizeFlatPermissionValue`, drop now-unused guard imports, re-export `UnifiedPermissionConfig` from `config-schema.ts`.
   Run `pnpm run check` (shared interface).
   Commit: `feat(pi-permission-system)!: validate config with zod and reject invalid fields` + `BREAKING CHANGE:` footer describing the tolerant→strict shift and the clear-error output.
4. **Remove the superseded config-only guards.**
   Red/adjust: delete the two functions from `src/value-guards.ts` and their cases from `test/value-guards.test.ts`.
   Green: `pnpm run check` + full suite; `pnpm fallow dead-code` to confirm no orphan exports.
   Commit: `refactor(pi-permission-system): remove config-only guards superseded by zod`.
5. **De-duplicate the config types (lift-and-shift).**
   Switch `src/types.ts` `PermissionState` / `DenyWithReason` / `PatternValue` / `FlatPermissionConfig` to `z.infer` re-exports from `config-schema.ts` (equivalence already proven in Step 1).
   Green: `pnpm run check` confirms all consumers compile.
   Commit: `refactor(pi-permission-system): derive permission config types from zod schema`.
6. **Docs, example, architecture, ADR, migration, skill.**
   Update the example-config and doc URLs, `architecture.md` (add `config-schema.ts`, fix the `value-guards.ts` inventory and the [#532] step note, re-check fallow rows), add ADR `0004`, the migration note, and the SKILL.md alignment note.
   Commit: `docs(pi-permission-system): document zod config schema and strict validation`.

## Risks and Mitigations

- **`markdownDescription` not auto-copied by zod → editor hover docs regress.**
  Mitigation: the Step 2 parity test asserts `markdownDescription` is present on every field that has it today; use `.meta({ markdownDescription })` and fall back to the `override` callback if needed.
- **`z.infer` types drift from the hand-written types → breaks ~58 consumers.**
  Mitigation: Step 1 type-equivalence assertions prove structural identity before Step 5 switches the exports; `pnpm run check` gates each step.
- **Over-rejection: one bad field rejects a whole scope's config, surprising users.**
  Mitigation: clear per-issue messages (field path + problem), documented in the ADR and migration note; fail-closed lands on `ask` (safe, not `allow`); per-scope granularity keeps a bad global from taking the project config down.
- **Legacy top-level keys now rejected by `strictObject`.**
  Mitigation: run the existing legacy-key detection first so a legacy config gets the migration guidance, then the zod reject; the breaking-change footer covers it.
- **New runtime dependency (`zod`).**
  Mitigation: zod `4.4.3` is the mature production `latest`; commit the lockfile; add a `minimumReleaseAgeExclude` entry only if the age gate trips; `pnpm fallow dead-code` before pushing.
- **Schema drift between the zod source and the committed JSON.**
  Mitigation: the parity test runs in the existing `pnpm -r run test` CI job — no `ci.yml` edit needed — and fails if the source changes without `gen:schema`.

## Open Questions

- **Deeper guard cleanup in `normalize.ts` / `policy-loader.ts`.**
  Now that the loader hands them zod-validated, typed input, the `isPermissionState` / `isDenyWithReason` re-narrowing there may be reducible.
  This overlaps with roadmap Step 8 ([#532], open) and is deferred to it rather than filing a duplicate.
- **Per-agent frontmatter `permission:` validation.**
  Agent-file `permission` blocks flow through a separate path and are not validated by the config-file schema here.
  Unifying them behind `permissionSchema` is a reasonable follow-up but out of scope for this issue; revisit if drift appears.

[#532]: https://github.com/gotgenes/pi-packages/issues/532
[colinhacks/zod#5272]: https://github.com/colinhacks/zod/issues/5272
