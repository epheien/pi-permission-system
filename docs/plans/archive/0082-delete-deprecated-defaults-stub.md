---
issue: 82
issue_title: "Delete deprecated empty defaults.ts stub"
---

# Delete deprecated empty `defaults.ts` stub

## Problem Statement

`src/defaults.ts` was deprecated and emptied in #66 (flat permission config format).
It contains only a deprecation comment and `export {}`.
Nothing imports it — confirmed by grep across `src/` and `tests/`.
The corresponding test file `tests/defaults.test.ts` is a no-op placeholder.
Both files are dead code that adds maintenance noise.

## Goals

- Delete `src/defaults.ts`.
- Delete `tests/defaults.test.ts`.
- Verify no remaining imports or references exist.

## Non-Goals

- Refactoring any other deprecated stubs.
- Changing the permission model or config format.

## Background

Issue #66 replaced the `defaultPolicy` concept with `permission["*"]` in the flat config.
The old `mergeDefaults()` and `getSurfaceDefault()` helpers were removed, and the module was emptied to an `export {}` stub.
No source file imports from `src/defaults.ts`; grep hits for the word "defaults" in other files are natural-language comments or unrelated variable names.

Permission surface involved: none (housekeeping deletion).

## Design Overview

Pure deletion — no logic changes, no API changes, no config changes.

## Module-Level Changes

| File                     | Action |
| ------------------------ | ------ |
| `src/defaults.ts`        | Delete |
| `tests/defaults.test.ts` | Delete |

No schema, config, or architecture doc changes needed.

## TDD Order

1. Delete `src/defaults.ts` and `tests/defaults.test.ts`.
   Run full test suite to confirm nothing breaks.
   Commit: `chore: delete deprecated defaults.ts stub (#82)`

## Risks and Mitigations

| Risk                                     | Mitigation                                                       |
| ---------------------------------------- | ---------------------------------------------------------------- |
| Hidden import we missed                  | Grep confirmed zero imports; CI will catch any missed reference. |
| Could this silently weaken a permission? | No — the file exports nothing and is not imported anywhere.      |

## Open Questions

None.
