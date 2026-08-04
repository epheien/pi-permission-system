---
issue: 109
issue_title: "refactor: deduplicate mergeFlatPermissions and path normalization helpers"
---

# Deduplicate shared helpers

## Problem Statement

Two sets of helper functions are copy-pasted across the codebase:

1. `mergeFlatPermissions()` — identical implementations in `src/config-loader.ts` and `src/permission-manager.ts`.
2. `normalizePathForComparison()` and `isPathWithinDirectory()` — identical implementations in `src/external-directory.ts` and `src/skill-prompt-sanitizer.ts`.

If merge or path logic changes, one copy might not get updated, creating a silent divergence bug.

## Goals

- Extract `mergeFlatPermissions()` into `src/permission-merge.ts`; both consumers import from there.
- Extract `normalizePathForComparison()` and `isPathWithinDirectory()` into `src/path-utils.ts`; all consumers import from there.
- No behavioral changes — pure extraction refactoring.
- Existing tests pass without logic changes.

## Non-Goals

- Splitting `external-directory.ts` into focused modules — that is #110's scope.
- Adding new tests for the helpers beyond what already exists (the existing `external-directory.test.ts` coverage for `normalizePathForComparison` and `isPathWithinDirectory` will be moved to a new `path-utils.test.ts`).
- Changing merge semantics or path normalization logic.

## Background

### `mergeFlatPermissions()`

Both copies implement deep-shallow merge: when both base and override values for a key are objects, shallow-merge the objects; otherwise the override replaces the base.
Used by:

- `config-loader.ts` — merging project config over global config (`mergeConfigs()`).
- `permission-manager.ts` — merging per-agent frontmatter over baseline config (`resolvePermissions()`).

### Path helpers

`normalizePathForComparison()` resolves a path string (handling `~`, `@` prefix, quotes, relative paths) to an absolute normalized form.
`isPathWithinDirectory()` checks whether a normalized path is equal to or under a directory.
Used by:

- `external-directory.ts` — `isSafeSystemPath()`, `isPathOutsideWorkingDirectory()`, tree-sitter bash path extraction.
- `skill-prompt-sanitizer.ts` — filtering skill prompt entries to those within a skill's base directory.
- `handlers/gates/external-directory.ts` — normalizing external paths for gate checks.
- `handlers/gates/skill-read.ts` — normalizing skill read paths.

The path helpers touch the `external_directory` and `skills` permission surfaces, but this refactoring changes no permission logic.

### Coordination with #110

Issue #110 plans to split `external-directory.ts` into focused modules and notes that if #109 lands first, `path-utils.ts` becomes the canonical home.
The #110 plan already defers path-helper deduplication to #109.
Landing #109 first is the recommended order.

## Design Overview

Pure mechanical extraction — no new types, no logic changes, no new APIs.

### `src/permission-merge.ts`

```typescript
import type { FlatPermissionConfig, PermissionState } from "./types";

export function mergeFlatPermissions(
  base: FlatPermissionConfig,
  override: FlatPermissionConfig,
): FlatPermissionConfig { /* existing logic */ }
```

### `src/path-utils.ts`

```typescript
export function normalizePathForComparison(
  pathValue: string,
  cwd: string,
): string { /* existing logic */ }

export function isPathWithinDirectory(
  pathValue: string,
  directory: string,
): boolean { /* existing logic */ }
```

Both new modules export only pure functions with no module-scope state.

## Module-Level Changes

| File                                       | Change                                                                                                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/permission-merge.ts`                  | **New.** Contains `mergeFlatPermissions()`.                                                                                                                                                                                              |
| `src/path-utils.ts`                        | **New.** Contains `normalizePathForComparison()` and `isPathWithinDirectory()`.                                                                                                                                                          |
| `src/config-loader.ts`                     | Remove local `mergeFlatPermissions()`, add `import { mergeFlatPermissions } from "./permission-merge"`.                                                                                                                                  |
| `src/permission-manager.ts`                | Remove local `mergeFlatPermissions()`, add `import { mergeFlatPermissions } from "./permission-merge"`.                                                                                                                                  |
| `src/external-directory.ts`                | Remove local `normalizePathForComparison()` and `isPathWithinDirectory()`, add `import { normalizePathForComparison, isPathWithinDirectory } from "./path-utils"`. Keep re-exporting both so downstream barrel imports continue to work. |
| `src/skill-prompt-sanitizer.ts`            | Remove local `normalizePathForComparison()` and `isPathWithinDirectory()`, add `import { normalizePathForComparison, isPathWithinDirectory } from "./path-utils"`.                                                                       |
| `src/handlers/gates/external-directory.ts` | Update import of `normalizePathForComparison` — can remain importing from `../../external-directory` (barrel) or switch to `../../path-utils`; prefer the direct module.                                                                 |
| `src/handlers/gates/skill-read.ts`         | Update import of `normalizePathForComparison` — same as above.                                                                                                                                                                           |
| `tests/path-utils.test.ts`                 | **New.** Move the `normalizePathForComparison` and `isPathWithinDirectory` describe blocks from `tests/external-directory.test.ts` here, importing from `../src/path-utils`.                                                             |
| `tests/external-directory.test.ts`         | Remove the moved describe blocks. Remaining tests continue importing from `../src/external-directory` (barrel re-export ensures no breakage).                                                                                            |
| `tests/permission-merge.test.ts`           | **New.** Unit tests for `mergeFlatPermissions()` covering: string-replaces-string, both-objects shallow-merge, object-replaces-string, string-replaces-object, empty override.                                                           |
| `docs/architecture/target-architecture.md` | Add `permission-merge.ts` and `path-utils.ts` to the module list if present.                                                                                                                                                             |

## Test Impact Analysis

1. **New unit tests enabled:** `mergeFlatPermissions()` currently has no direct unit tests — it is only exercised indirectly through config-loader and permission-manager integration tests.
   The extraction enables focused unit tests in `tests/permission-merge.test.ts`.
2. **Tests that move:** The `normalizePathForComparison` and `isPathWithinDirectory` describe blocks in `tests/external-directory.test.ts` move to `tests/path-utils.test.ts` with only the import path changing.
3. **Tests that stay as-is:** All other tests in `tests/external-directory.test.ts`, `tests/skill-prompt-sanitizer.test.ts`, `tests/config-loader.test.ts`, and `tests/permission-manager.test.ts` stay unchanged — they exercise higher-level behavior that happens to use these helpers internally.

## TDD Order

1. **test: add unit tests for mergeFlatPermissions** Create `tests/permission-merge.test.ts` importing from `../src/permission-merge`.
   Tests will initially fail (module does not exist).
   Cover: string-replaces-string, both-objects-merge, object-replaces-string, string-replaces-object, empty inputs.
   Commit: `test: add unit tests for mergeFlatPermissions`

2. **feat: extract mergeFlatPermissions to permission-merge.ts** Create `src/permission-merge.ts` with the function.
   Update `src/config-loader.ts` and `src/permission-manager.ts` to import from it, remove local copies.
   All tests pass (new + existing).
   Commit: `refactor: extract mergeFlatPermissions to permission-merge.ts`

3. **test: move path helper tests to path-utils.test.ts** Create `tests/path-utils.test.ts` with the `normalizePathForComparison` and `isPathWithinDirectory` blocks, importing from `../src/path-utils`.
   Remove those blocks from `tests/external-directory.test.ts`.
   New tests initially fail (module does not exist); existing tests still pass.
   Commit: `test: move path helper tests to path-utils.test.ts`

4. **feat: extract path helpers to path-utils.ts** Create `src/path-utils.ts` with both functions.
   Update `src/external-directory.ts` to import + re-export from `./path-utils`, remove local copies.
   Update `src/skill-prompt-sanitizer.ts` to import from `./path-utils`, remove local copies.
   Update `src/handlers/gates/external-directory.ts` and `src/handlers/gates/skill-read.ts` to import from `../../path-utils`.
   All tests pass.
   Commit: `refactor: extract path helpers to path-utils.ts`

5. **docs: update architecture docs** Add the two new modules to `docs/architecture/target-architecture.md`.
   Commit: `docs: update target architecture for extracted helpers`

## Risks and Mitigations

| Risk                                                                                | Mitigation                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Barrel re-export in `external-directory.ts` is missed, breaking downstream imports. | Step 4 explicitly keeps the re-export; the existing `external-directory.test.ts` tests serve as a regression gate.                                                                            |
| Could this silently weaken a permission?                                            | No — pure extraction with zero logic changes. The same functions, same call sites, same behavior.                                                                                             |
| #110 plan references path helpers in `external-directory.ts`.                       | #110's plan already anticipates #109 landing first and notes `path-utils.ts` as the canonical home. No conflict.                                                                              |
| `mergeFlatPermissions` copies have silently diverged.                               | Verified: the two copies are textually identical except for the `PermissionState` import style (inline `import("./types").PermissionState` vs. top-level import). Functionality is identical. |

## Open Questions

None — the issue is unambiguous and the extraction is mechanical.
