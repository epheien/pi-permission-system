---
issue: 286
issue_title: "Decompose resolvePermissions in permission-manager.ts"
---

# Decompose `resolvePermissions` into a linear pipeline

## Problem Statement

`PermissionManager.resolvePermissions` in `src/permission-manager.ts` does three things in one body.
It loads four config scopes, runs a scope-merge loop that simultaneously builds the merged permission object **and** a parallel origin map tracking which scope contributed each `(surface, pattern)` entry, then synthesizes defaults and composes the final ruleset.
The origin-tracking branch — shallow-merge attribution vs. full-replacement attribution — is the densest part of the function and is interleaved with the merge itself.
`fallow health --targets` ranks this function second in the package: cognitive complexity 33 in a 302-LOC file, CRAP risk 97.
This is Phase 2 step 2 of the improvement roadmap in `docs/architecture/architecture.md`.

## Goals

- Extract `mergeScopesWithOrigins(scopes)` returning `{ mergedPermission, origins }`, isolating the origin-map bookkeeping from the rest of the resolve pipeline.
- Leave the remaining `resolvePermissions` body reading as a linear pipeline: load scopes → merge with origins → extract universal fallback → build config rules → compose.
- Behavior-preserving: `permission-manager-unified.test.ts` stays green without modification.
- Drive `resolvePermissions` cognitive complexity from 33 toward the `< 15` target and lower the CRAP-97 hotspot.

## Non-Goals

- No change to merge precedence, origin semantics, universal-fallback extraction, baseline synthesis, or composed-ruleset ordering — the decision model is frozen.
- No change to `mergeFlatPermissions` in `permission-merge.ts` (its shallow-merge vs. replacement semantics are mirrored, not modified).
- No change to `synthesize.ts`, `normalize.ts`, `rule.ts`, or `types.ts` public surfaces.
- No change to the other Phase 2 targets: `runGateCheck` ([#287]), `bash-path-extractor.ts` ([#289]), `stripJsonComments` ([#290]), test-fixture dedup ([#288]).
- No change to the `v3-architecture.md` data-flow diagram — `resolvePermissions(agentName)` remains a node; only its internals move.

## Background

Relevant existing modules:

- `src/permission-manager.ts` — `PermissionManager`; the private `resolvePermissions(agentName?)` method is the target.
  It is the sole producer of the cached `ResolvedPermissions` consumed by `getComposedConfigRules`, `getToolPermission`, and `checkPermission`.
- `src/permission-merge.ts` — `mergeFlatPermissions(base, override)`: deep-shallow merge of two `FlatPermissionConfig` objects (both objects → shallow-merge pattern maps; otherwise override replaces base).
  The extracted function calls this internally and mirrors its branch shape for attribution.
- `src/rule.ts` — `RuleOrigin` union (`"global" | "project" | "agent" | "project-agent" | "builtin" | "baseline" | "session"`).
  The four config-scope labels are a subset.
- `src/types.ts` — `FlatPermissionConfig` (`Record<string, PermissionState | Record<string, PermissionState>>`) and `ScopeConfig` (`{ permission?: FlatPermissionConfig }`).

The origin-tracking loop today (the part being extracted):

```typescript
type OriginMap = Map<string, Map<string, RuleOrigin>>;
const origins: OriginMap = new Map();
let mergedPermission: FlatPermissionConfig = {};

for (const [scopeName, scope] of [
  ["global", globalConfig],
  ["project", projectConfig],
  ["agent", agentConfig],
  ["project-agent", projectAgentConfig],
] as const) {
  if (!scope.permission) continue;
  for (const [surface, value] of Object.entries(scope.permission)) {
    const baseVal = mergedPermission[surface];
    const bothObjects = /* both are non-null objects */;
    if (bothObjects) {
      // shallow-merge: incoming patterns attributed to this scope;
      // existing patterns keep their earlier origin
    } else {
      // full replacement: this scope takes over the whole surface entry
    }
  }
  mergedPermission = mergeFlatPermissions(mergedPermission, scope.permission);
}
```

Constraints from AGENTS.md / the package skill that apply:

- Enforce permissions deterministically — the same policy + input must always produce the same decision.
  The refactor must not perturb merge order or attribution.
- Keep modules focused (one concern per file).
- Within the package, import sibling modules via `#src/` / `#test/` aliases, not relative paths.
- When a rename or extraction adds exports, verify at least one consumer imports each symbol — fallow flags speculative re-exports as dead code.
- ES2024 target — `Object.entries`, `Object.fromEntries`, `Map` are available.

## Design Overview

### New module: `src/scope-merge.ts`

The user chose a dedicated module (over folding into `permission-merge.ts` or keeping an exported helper in `permission-manager.ts`).
This matches the package's dominant one-concern-per-file convention (`normalize.ts`, `synthesize.ts`, `permission-merge.ts` each have a sibling test) and keeps `permission-merge.ts` purely about config-shape merging.

The function is pure: it receives the already-loaded scopes (loading stays in `resolvePermissions`, preserving the "load scopes" pipeline step) and returns the merged config plus the origin map.

```typescript
import { mergeFlatPermissions } from "#src/permission-merge";
import type { RuleOrigin } from "#src/rule";
import type { FlatPermissionConfig, ScopeConfig } from "#src/types";

/** Surface → (pattern → originating scope). */
type OriginMap = Map<string, Map<string, RuleOrigin>>;

export interface MergedScopes {
  mergedPermission: FlatPermissionConfig;
  origins: OriginMap;
}

/**
 * Merge permission objects across scopes (lowest → highest precedence) while
 * tracking which scope contributed each (surface, pattern) entry.
 *
 * Mirrors mergeFlatPermissions() semantics:
 *  - both values are objects → shallow-merge; each incoming pattern is
 *    attributed to this scope, existing patterns keep their earlier origin.
 *  - otherwise → full replacement; the whole surface entry is re-attributed
 *    to this scope.
 */
export function mergeScopesWithOrigins(
  scopes: readonly (readonly [RuleOrigin, ScopeConfig])[],
): MergedScopes {
  const origins: OriginMap = new Map();
  let mergedPermission: FlatPermissionConfig = {};

  for (const [scopeName, scope] of scopes) {
    if (!scope.permission) continue;
    for (const [surface, value] of Object.entries(scope.permission)) {
      // ... attribution branch moved verbatim, including the
      // eslint-disable comments for the defensive null/type checks
    }
    mergedPermission = mergeFlatPermissions(mergedPermission, scope.permission);
  }

  return { mergedPermission, origins };
}
```

The attribution branch (shallow-merge vs. full-replacement, plus the string-vs-object handling and the `eslint-disable @typescript-eslint/no-unnecessary-condition` comments) moves into the inner loop unchanged.
The `OriginMap` type alias moves out of `resolvePermissions` and into this module; it stays unexported because the consumer reads `origins` via the inferred `MergedScopes` return type and never names it.

### Consumer call site (`resolvePermissions`)

The four loader calls stay; the loop collapses to one call:

```typescript
const { mergedPermission, origins } = mergeScopesWithOrigins([
  ["global", this.loader.loadGlobalConfig()],
  ["project", this.loader.loadProjectConfig()],
  ["agent", this.loader.loadAgentConfig(agentName)],
  ["project-agent", this.loader.loadProjectAgentConfig(agentName)],
]);
```

This follows Tell-Don't-Ask (the manager hands the loaded scopes to the merge function and takes back a value object) and carries no output-argument mutation — `origins` is constructed inside the function and returned, not written into a received bag.
The downstream pipeline (`universalFallback`, `universalFallbackOrigin`, `permissionWithoutUniversal`, `configRules`, `composeRuleset`) is untouched and continues to read `mergedPermission` and `origins`.

ISP check: `mergeScopesWithOrigins` reads only `scope.permission` from each `ScopeConfig`, which is the type's only field — no unused fields are carried.

### Edge cases (all unchanged)

- A scope with no `permission` key is skipped (`continue`), contributing nothing to either map.
- A string surface value attributes `"*"` to the scope; an object value attributes each pattern key.
- Full replacement (string overriding an object, or an object replacing a string) re-attributes the entire surface entry to the replacing scope, discarding lower-scope attribution.
- Shallow-merge keeps lower-scope origins for patterns the higher scope does not redefine.
- An empty `scopes` array returns `{ mergedPermission: {}, origins: new Map() }`.
- The universal `"*"` surface is attributed like any other and read downstream via `origins.get("*")?.get("*")`.

## Module-Level Changes

`src/scope-merge.ts` (new):

- Add exported `mergeScopesWithOrigins` and the exported `MergedScopes` interface.
- Add the unexported `OriginMap` type alias.
- Import `mergeFlatPermissions` from `#src/permission-merge`, `RuleOrigin` from `#src/rule`, `FlatPermissionConfig` + `ScopeConfig` from `#src/types`.

`src/permission-manager.ts`:

- Remove the inline `type OriginMap` declaration, the `origins`/`mergedPermission` initialization, and the scope-merge `for` loop from `resolvePermissions`.
- Replace them with the single `mergeScopesWithOrigins([...])` call shown above.
- Remove the now-unused `import { mergeFlatPermissions } from "./permission-merge";` — after extraction this module no longer calls it directly (it was the sole call site in this file).
- Add `import { mergeScopesWithOrigins } from "#src/scope-merge";` (existing imports already use relative `./` form; match the file's existing convention or `#src/` — eslint will normalize).
- Keep the `RuleOrigin` and `FlatPermissionConfig` imports — both are still used downstream (`universalFallbackOrigin: RuleOrigin`, `permissionWithoutUniversal: FlatPermissionConfig`).

`test/scope-merge.test.ts` (new): direct unit tests for `mergeScopesWithOrigins` (see Test Impact).

`docs/architecture/architecture.md`:

- Add a `scope-merge.ts` entry to the module-tree listing (near `permission-manager.ts`, ~line 483) — e.g. `Cross-scope permission merge + origin-map bookkeeping`.
- Update the source-tree line for `permission-manager.ts` if its one-line description should shed the "Policy merge" framing now that merge lives in `scope-merge.ts` (optional wording tweak).
- Mark Phase 2 step 2 ([#286]) as ✅ completed in the Steps section with the outcome.
- Refresh the "Refactoring targets" and "Worst CRAP risk" health-metric rows and the finding-#2 row after re-running `fallow health --targets` to capture the new `resolvePermissions` complexity / CRAP numbers.

`.pi/skills/package-pi-permission-system/SKILL.md`: no symbol it documents is removed or renamed — no change.

No file in Module-Level Changes is also claimed unchanged in Non-Goals.

## Test Impact Analysis

1. New unit tests enabled by the extraction.
   `mergeScopesWithOrigins` becomes a directly testable pure function, isolating the origin-map bookkeeping that previously could only be exercised end-to-end through `resolvePermissions` → `getComposedConfigRules` → rule-origin assertions.
   New `test/scope-merge.test.ts` covers: empty scopes; a single scope with a string surface value (`origins["surface"]["*"] === scope`); a single scope with an object value (each pattern attributed); shallow-merge across two scopes (existing patterns retain the lower-scope origin, new patterns get the higher scope); full replacement (string-over-object and object-over-string both re-attribute the whole surface); and precedence order across all four scopes.
2. Tests that become redundant.
   None are removed.
   `permission-manager-unified.test.ts` still verifies the end-to-end origin annotations through the composed ruleset; it is the behavior-preservation safety net and stays unmodified.
3. Tests that must stay as-is.
   `permission-manager-unified.test.ts` (origin/source assertions across all surfaces) and `permission-merge.test.ts` (unchanged `mergeFlatPermissions` semantics) genuinely exercise the layers around the extraction and must remain green without modification.

## TDD Order

1. `test:` Add `test/scope-merge.test.ts` covering `mergeScopesWithOrigins`: empty scopes, string-value attribution, object-value attribution, shallow-merge origin retention, full-replacement re-attribution, and four-scope precedence.
   Red: `#src/scope-merge` does not exist yet (compile error in the new test, mirroring the [#285] step-1 pattern).
   Suggested commit: `test: cover mergeScopesWithOrigins extraction`.
2. `refactor:` Create `src/scope-merge.ts` with `mergeScopesWithOrigins` + `MergedScopes`, moving the attribution loop verbatim; rewire `resolvePermissions` to the single call, delete the inline loop and `OriginMap` alias, and drop the now-unused `mergeFlatPermissions` import.
   The new module and its sole production call site land in one commit (the type checker requires the export to exist for `permission-manager.ts` to compile against it).
   Green: new `scope-merge.test.ts` passes and `permission-manager-unified.test.ts` passes unmodified.
   Run `pnpm --filter @gotgenes/pi-permission-system run test` and `pnpm --filter @gotgenes/pi-permission-system run check` before committing.
   Suggested commit: `refactor: extract mergeScopesWithOrigins from resolvePermissions`.
3. `docs:` Update `architecture.md` — add the `scope-merge.ts` module-tree entry, mark Phase 2 step 2 complete, and refresh the health-metric / finding rows after re-running `fallow health --targets` to record the new `resolvePermissions` numbers.
   Suggested commit: `docs: mark Phase 2 step 2 complete in permission-system roadmap`.

All three steps are small and individually reviewable.
No step rewrites a large test file; the extraction is pure and the existing integration suite proves behavior preservation.

## Risks and Mitigations

- Risk: attribution drift — a subtle change in shallow-merge vs. full-replacement origin assignment.
  Mitigation: the inner branch (including the `eslint-disable` comments and string/object handling) moves verbatim; `scope-merge.test.ts` asserts each attribution case directly and `permission-manager-unified.test.ts` verifies the end-to-end origins unchanged.
- Risk: merge order or precedence drift.
  Mitigation: the four scopes are passed in the same lowest→highest order; the precedence test in `scope-merge.test.ts` and the integration suite both depend on ordering.
- Risk: the step-1 commit leaves `pnpm check` red until step 2 (the test imports a not-yet-created module).
  Mitigation: this mirrors the accepted [#285] pattern; steps 1 and 2 ship together in the same session, and step 2 restores green.
- Risk: a leftover `mergeFlatPermissions` reference after removing its import.
  Mitigation: grep confirms `resolvePermissions` is the file's only `mergeFlatPermissions` call site; `pnpm check` in step 2 catches any stray reference.
- Risk: fallow flags `MergedScopes` as a dead export.
  Mitigation: `scope-merge.test.ts` imports `MergedScopes` to type its expected results, giving the export a consumer; `mergeScopesWithOrigins` is consumed by both `permission-manager.ts` and the test.

## Open Questions

- Whether to further extract the universal-fallback / config-rule-building tail of `resolvePermissions` into its own helper — deferred.
  The issue scopes this change to the origin-map extraction; revisit only if `fallow health` still flags `resolvePermissions` above target after step 2.

[#285]: https://github.com/gotgenes/pi-packages/issues/285
[#286]: https://github.com/gotgenes/pi-packages/issues/286
[#287]: https://github.com/gotgenes/pi-packages/issues/287
[#288]: https://github.com/gotgenes/pi-packages/issues/288
[#289]: https://github.com/gotgenes/pi-packages/issues/289
[#290]: https://github.com/gotgenes/pi-packages/issues/290
