---
issue: 109
issue_title: "refactor: deduplicate mergeFlatPermissions and path normalization helpers"
---

# Retro: #109 — deduplicate shared helpers

## Final Retrospective (2026-05-07T13:35:00Z)

### Session summary

Planned and executed a pure extraction refactoring that moved `mergeFlatPermissions()` into `src/permission-merge.ts` and `normalizePathForComparison()`/`isPathWithinDirectory()` into `src/path-utils.ts`.
Both `src/config-loader.ts` and `src/permission-manager.ts` now import from the shared merge module; `src/external-directory.ts` barrel-re-exports the path helpers for backward compatibility.
Released as v5.6.2 with zero behavioral change and 8 net-new unit tests for `mergeFlatPermissions`.

### Observations

#### What went well

- **TDD cycle was clean**: 5 plan steps mapped to 4 commits with no unexpected breakage.
  The full 1224-test suite stayed green at every commit.
- **Barrel re-export strategy worked**: keeping `export { ... } from "./path-utils"` in `external-directory.ts` meant the 39 existing `external-directory.test.ts` tests passed without import changes, validating backward compatibility.
- **New test coverage surfaced**: `mergeFlatPermissions()` previously had zero direct unit tests.
  The extraction enabled 8 focused tests covering all merge branches (string×string, object×object, cross-type, empty inputs).

#### What caused friction (agent side)

- `missing-context` — In step 4, added `import { isPathWithinDirectory, normalizePathForComparison } from "./path-utils"` alongside `export { ... } from "./path-utils"` *before* removing the local function definitions in `src/external-directory.ts`.
  Biome flagged `noRedeclare` (local functions shadowed the imports) and `noUnusedImports` (the import was dead while locals existed).
  Impact: one extra edit cycle to remove the local definitions, then the import was needed again for internal callers.
  Self-identified via biome autoformat hook output.

#### What caused friction (user side)

- None observed — the user's involvement was the standard plan/TDD/ship command sequence with no corrections needed.
