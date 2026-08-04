---
issue: 54
issue_title: "Verify doom_loop detection fires end-to-end"
---

# Deprecate `doom_loop` special permission key

## Problem Statement

The `doom_loop` key is declared as a `SpecialPermissionName`, accepted in config under `special.doom_loop`, and resolved through `checkPermission()`.
However, nothing in this extension or in Pi's core ever calls `checkPermission("doom_loop", ...)` at runtime.

Investigation of Pi's source (`~/development/pi/pi-mono/packages/coding-agent/src/`) confirms: Pi has **no doom_loop detection**.
The `tool_call` event only fires for actual tool names (`bash`, `read`, `edit`, etc.) — there is no repeated-tool-call tracking or synthetic `doom_loop` event.

In OpenCode, doom_loop detection lives in the **session processor** (core runtime), not in the permission extension.
The permission system only resolves the policy gate when the core fires the check.
Implementing detection inside a permission extension would be a layering violation — mixing condition detection with policy enforcement.

Per AGENTS.md: "Treat any declared config field not read at runtime as a maintenance trap."
The key is dead code and should be deprecated.

## Goals

- Deprecate `special.doom_loop` with a config-issue warning (same pattern as `tool_call_limit`).
- Remove `doom_loop` from the TypeScript types, JSON schema allowed properties, example config, and README.
- Keep the config loader tolerant: accept the legacy key, emit a single non-fatal warning, discard the value.
- File a Pi upstream issue requesting core-level doom_loop detection (out of scope for this change, tracked as a follow-up).

## Non-Goals

- Implementing doom_loop detection in this extension (layering violation — detection belongs in Pi core).
- Changing `external_directory` or any other special key.
- Touching the `SpecialPermissionName` union beyond removing `doom_loop` (if `external_directory` is the only remaining member, keep the type for extensibility).

## Background

### Permission surface

`special` — reserved permission checks for runtime behaviors that are not tied to a specific tool.

### Relevant modules

| File                              | Role                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                    | `SpecialPermissionName` type union includes `"doom_loop"`                                                  |
| `src/permission-manager.ts`       | `SPECIAL_PERMISSION_KEYS` set includes `"doom_loop"`; `checkPermission()` routes it to the special surface |
| `src/config-loader.ts`            | `SPECIAL_PERMISSION_KEYS` set (duplicate) includes `"doom_loop"`                                           |
| `src/extension-config.ts`         | `PERMISSION_POLICY_KEYS` set includes `"doom_loop"` for misplaced-key detection                            |
| `schemas/permissions.schema.json` | `special.doom_loop` property definition                                                                    |
| `config/config.example.json`      | `"doom_loop": "deny"` example entry                                                                        |
| `README.md`                       | Documents `doom_loop` in the special permissions table                                                     |

### Precedent

`tool_call_limit` was deprecated in the same pattern: added to `DEPRECATED_SPECIAL_KEYS` in `permission-manager.ts`, stripped from normalized output, config issue emitted, removed from schema/types/docs.

## Design Overview

Follow the exact `tool_call_limit` deprecation pattern:

1. Add `"doom_loop"` to `DEPRECATED_SPECIAL_KEYS` in `src/permission-manager.ts`.
2. Remove `"doom_loop"` from `SPECIAL_PERMISSION_KEYS` in both `src/permission-manager.ts` and `src/config-loader.ts`.
3. Remove `"doom_loop"` from the `SpecialPermissionName` type union in `src/types.ts`.
4. Remove `"doom_loop"` from `PERMISSION_POLICY_KEYS` in `src/extension-config.ts` (it is no longer a valid policy key to detect as misplaced).
5. Remove the `doom_loop` property from `special` in the JSON schema.
6. Remove `doom_loop` from the example config and README.
7. Existing configs with `doom_loop` get a deprecation warning and the value is silently discarded — no crash, no behavior change.

### Type change

```typescript
// Before
export type SpecialPermissionName = "doom_loop" | "external_directory";

// After
export type SpecialPermissionName = "external_directory";
```

### Schema change

Remove the `doom_loop` property from `special.properties`.
Add a deprecated note if desired, or simply remove (the loader tolerance handles on-disk configs).

## Module-Level Changes

| File                                        | Change                                                                                                                                               |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`                              | Remove `"doom_loop"` from `SpecialPermissionName` union                                                                                              |
| `src/permission-manager.ts`                 | Move `"doom_loop"` from `SPECIAL_PERMISSION_KEYS` to `DEPRECATED_SPECIAL_KEYS`                                                                       |
| `src/config-loader.ts`                      | Remove `"doom_loop"` from `SPECIAL_PERMISSION_KEYS`                                                                                                  |
| `src/extension-config.ts`                   | Remove `"doom_loop"` from `PERMISSION_POLICY_KEYS`                                                                                                   |
| `schemas/permissions.schema.json`           | Remove `doom_loop` property from `special`; update `special` description to mention only `external_directory`                                        |
| `config/config.example.json`                | Remove `"doom_loop": "deny"` line                                                                                                                    |
| `README.md`                                 | Remove `doom_loop` row from special permissions table; update description text                                                                       |
| `docs/architecture/current-architecture.md` | Update example config snippet if it references `doom_loop`                                                                                           |
| `tests/permission-system.test.ts`           | Update tests: doom_loop should now emit a deprecation warning and be stripped; existing doom_loop resolution tests become deprecation-behavior tests |
| `tests/config-loader.test.ts`               | Update test that checks `special: { doom_loop: "deny" }` normalization                                                                               |
| `tests/extension-config.test.ts`            | Remove `doom_loop` from misplaced-key test expectations                                                                                              |

## TDD Order

1. **Red**: test that `normalizeRawPermission({ special: { doom_loop: "ask" } })` returns `configIssues` containing a deprecation message and `permissions.special` does not contain `doom_loop`.
   Commit: `test: doom_loop deprecation warning from normalizeRawPermission`

2. **Green**: add `"doom_loop"` to `DEPRECATED_SPECIAL_KEYS`, remove from `SPECIAL_PERMISSION_KEYS` in `permission-manager.ts`.
   Commit: `feat: deprecate doom_loop special permission key`

3. **Red**: test that `checkPermission("doom_loop", {})` falls through to `defaultPolicy.special` (no longer matches as a special key — returns default).
   Commit: `test: doom_loop checkPermission falls through to default`

4. **Green**: remove `"doom_loop"` from `SPECIAL_PERMISSION_KEYS` in `config-loader.ts`, remove from `SpecialPermissionName` type.
   Commit: `feat: remove doom_loop from type union and config-loader`

5. **Update existing tests**: fix tests that assert `doom_loop` resolution, `doom_loop` in normalized output, or `doom_loop` in misplaced-key detection.
   Commit: `test: update doom_loop assertions for deprecation`

6. **Docs + schema + example**: remove `doom_loop` from schema, example config, README, and architecture docs.
   Commit: `docs: remove doom_loop from schema, example, and README`

## Risks and Mitigations

| Risk                                                     | Mitigation                                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Users with `doom_loop` in config see a new warning       | Warning is non-fatal and actionable ("remove it from your policy file"). Same UX as `tool_call_limit` deprecation.                                                        |
| Could this silently weaken a permission?                 | No — the key was already dead code. No runtime check ever fired `checkPermission("doom_loop")`, so removing it changes zero runtime decisions.                            |
| Future Pi core doom_loop detection breaks                | If Pi adds native detection that fires `checkPermission("doom_loop")`, we re-add the key. The deprecation warning tells users to remove it, so re-adding is non-breaking. |
| `defaultPolicy.special` description references doom_loop | Update schema and README description text to mention only `external_directory`.                                                                                           |

## Open Questions

- Should we file a Pi upstream issue requesting core-level doom_loop detection?
  Deferred to a follow-up after this change lands.
- If `external_directory` becomes the only special key, should the `special` surface be reconsidered?
  Deferred to #56 (unify Rule type), which determines the long-term shape of surfaces.
