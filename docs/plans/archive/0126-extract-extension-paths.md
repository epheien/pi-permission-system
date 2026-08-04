---
issue: 126
issue_title: "refactor: extract ExtensionPaths value object from ExtensionRuntime"
---

# Extract ExtensionPaths value object

## Problem statement

`ExtensionRuntime` holds six path fields (`agentDir`, `sessionsDir`, `subagentSessionsDir`, `forwardingDir`, `globalLogsDir`, `piInfrastructureDirs`) that are computed once at startup from `agentDir` and never mutate.
These fields are threaded individually through `HandlerDeps`, `PermissionPrompter`, `PermissionForwardingDeps`, and `isSubagentExecutionContext` calls, widening the dependency surface unnecessarily.

Extracting an `ExtensionPaths` value object is the simplest step in the handler decomposition series (see `docs/plans/0126-handler-decomposition.md`).
It has zero behavioral risk and sets up later refactorings (#127–#130) to consume a single dep instead of individual fields.

## Goals

- Extract an `ExtensionPaths` interface and `computeExtensionPaths()` factory into a new `src/extension-paths.ts`.
- Make `ExtensionRuntime` embed `ExtensionPaths` (extends or inline fields) so existing field access continues to work.
- Update `createExtensionRuntime` to delegate path computation to the new factory.
- Add focused unit tests for `computeExtensionPaths()`.
- No behavioral change — same permission decisions, same event emissions, same config loading.

## Non-goals

- Replacing individual path references in `HandlerDeps`, `PermissionPrompter`, or `PermissionForwardingDeps` with a single `paths: ExtensionPaths` field.
  That is a follow-up refactoring for #129 (PermissionSession) or a later narrowing pass.
- Extracting `SessionLogger` (#127) or `ForwardingManager` (#128).
- Changing the `/permission-system` slash command or any config format.

## Background

### Permission surface

This change does not touch any permission surface.
It is a pure structural extraction of immutable path constants.

### Relevant modules

| File                            | Role in this change                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/runtime.ts`                | Defines `ExtensionRuntime` interface and `createExtensionRuntime()`. Path fields are computed inline in the factory.                                             |
| `src/index.ts`                  | Composition root — reads `runtime.agentDir`, `runtime.subagentSessionsDir`, `runtime.forwardingDir` to wire `PermissionPrompter` and `PermissionForwardingDeps`. |
| `src/handlers/types.ts`         | `HandlerDeps` carries `piInfrastructureDirs` as a top-level field.                                                                                               |
| `src/node-modules-discovery.ts` | Provides `discoverGlobalNodeModulesRoot()` used to build `piInfrastructureDirs`.                                                                                 |
| `tests/runtime.test.ts`         | Tests path derivation in `createExtensionRuntime` — these cover the exact logic being extracted.                                                                 |

### Current path computation (in `createExtensionRuntime`)

```typescript
const agentDir = options?.agentDir ?? getAgentDir();
const sessionsDir = join(agentDir, "sessions");
const subagentSessionsDir = join(agentDir, "subagent-sessions");
const forwardingDir = join(sessionsDir, "permission-forwarding");
const globalLogsDir = getGlobalLogsDir(agentDir);
const globalNodeModulesRoot = discoverGlobalNodeModulesRoot();
const piInfrastructureDirs = [
  agentDir,
  join(agentDir, "git"),
  ...(globalNodeModulesRoot ? [globalNodeModulesRoot] : []),
];
```

## Design overview

### New type and factory

```typescript
// src/extension-paths.ts

export interface ExtensionPaths {
  readonly agentDir: string;
  readonly sessionsDir: string;
  readonly subagentSessionsDir: string;
  readonly forwardingDir: string;
  readonly globalLogsDir: string;
  readonly piInfrastructureDirs: readonly string[];
}

export function computeExtensionPaths(agentDir: string): ExtensionPaths;
```

`piInfrastructureDirs` uses `readonly string[]` to reflect immutability.
The factory calls `getGlobalLogsDir(agentDir)` and `discoverGlobalNodeModulesRoot()` internally — same call sites as today, just relocated.

### ExtensionRuntime integration

`ExtensionRuntime` extends `ExtensionPaths` (it already declares each field individually as `readonly`).
After the extraction, the interface declaration drops the six individual `readonly` field declarations and replaces them with `extends ExtensionPaths`.

`SessionState` is unchanged — it does not carry path fields.

### No downstream signature changes

Callers that read `runtime.agentDir` or `runtime.piInfrastructureDirs` continue to work unchanged because `ExtensionRuntime extends ExtensionPaths` preserves all the same fields.
`HandlerDeps.piInfrastructureDirs` and the wiring in `index.ts` are untouched in this issue.

## Module-level changes

### Added

- `src/extension-paths.ts` — `ExtensionPaths` interface + `computeExtensionPaths()` factory.
- `tests/extension-paths.test.ts` — focused unit tests for the factory.

### Changed

- `src/runtime.ts`:
  1. Import `ExtensionPaths` and `computeExtensionPaths` from `./extension-paths`.
  2. Change `ExtensionRuntime` to `extends ExtensionPaths` instead of declaring the six path fields inline.
  3. In `createExtensionRuntime`, replace the inline path computation with a `computeExtensionPaths(agentDir)` call and spread the result into the runtime object.
- `tests/runtime.test.ts`:
  1. Path-derivation tests for `createExtensionRuntime` remain as-is (they verify that the runtime object exposes the correct paths).
  2. Add a mock for `../src/extension-paths` if needed, or leave the real implementation since `computeExtensionPaths` is a pure function with one side-effecting dep (`discoverGlobalNodeModulesRoot`) that is already mocked.

### Unchanged

- `src/index.ts` — continues to read `runtime.agentDir`, `runtime.subagentSessionsDir`, etc.
  No change needed.
- `src/handlers/types.ts` — `HandlerDeps.piInfrastructureDirs` stays as-is.
- All handler test files — `makeDeps()` factories are unaffected.
- `schemas/`, `config/`, `docs/architecture/` — no changes needed.

## Test impact analysis

1. **New unit tests enabled**: `computeExtensionPaths()` can be tested independently of `createExtensionRuntime`.
   Tests cover: path derivation from `agentDir`, `piInfrastructureDirs` composition with/without `globalNodeModulesRoot`, and `readonly` semantics.
2. **Existing tests that become partially redundant**: The path-derivation block in `tests/runtime.test.ts` (`"sets agentDir"`, `"derives sessionsDir"`, etc.) now duplicates coverage with the new `extension-paths.test.ts`.
   These tests should stay — they verify that `createExtensionRuntime` correctly delegates to `computeExtensionPaths` and surfaces the fields on the runtime object.
   They can be simplified in a follow-up if desired (assert `runtime.agentDir === "/test/agent"` is sufficient; the detailed derivation is covered by the lower-level test).
3. **Existing tests that must stay**: All handler tests (`tool-call.test.ts`, `lifecycle.test.ts`, etc.) and `runtime.test.ts` tests for mutable state, logging, config refresh, and agent name resolution are unchanged.

## TDD order

### Cycle 1: Add ExtensionPaths interface and computeExtensionPaths factory with tests

1. Create `tests/extension-paths.test.ts` with red tests:
   - `computeExtensionPaths` sets `agentDir` from argument.
   - Derives `sessionsDir` as `join(agentDir, "sessions")`.
   - Derives `subagentSessionsDir` as `join(agentDir, "subagent-sessions")`.
   - Derives `forwardingDir` as `join(sessionsDir, "permission-forwarding")`.
   - Derives `globalLogsDir` via `getGlobalLogsDir(agentDir)`.
   - Includes `agentDir` and `agentDir/git` in `piInfrastructureDirs`.
   - Includes discovered global `node_modules` root when present.
   - Omits global `node_modules` when discovery returns `null`.
   - All entries in `piInfrastructureDirs` are strings (no `null`).
2. Create `src/extension-paths.ts` with the `ExtensionPaths` interface and `computeExtensionPaths()` factory to make tests green.
3. Commit: `test: add ExtensionPaths unit tests` and `feat: extract ExtensionPaths value object (#126)` (or squash into one `feat:` commit).

### Cycle 2: Integrate into ExtensionRuntime

1. Update `src/runtime.ts`:
   - `ExtensionRuntime extends ExtensionPaths`.
   - `createExtensionRuntime` calls `computeExtensionPaths(agentDir)` and spreads into the runtime literal.
   - Remove the now-redundant inline path computation and the direct import of `discoverGlobalNodeModulesRoot`.
2. Run existing `tests/runtime.test.ts` — all path tests should stay green because the runtime object still exposes the same fields.
   The `discoverGlobalNodeModulesRoot` mock in `runtime.test.ts` may need to be replaced with a mock on `../src/extension-paths` (or left as-is if the real `computeExtensionPaths` is called through and the existing mock of `../src/node-modules-discovery` still intercepts correctly).
3. Run `pnpm run build` to verify type-checking.
4. Run full test suite.
5. Commit: `refactor: use computeExtensionPaths in createExtensionRuntime (#126)`.

## Risks and mitigations

| Risk                                                                                     | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Could this silently weaken a permission?                                                 | No. Pure structural extraction — same path values computed from the same inputs. No gate logic, no policy evaluation, no config loading changes.                                                                                                                                                                                                                                                           |
| `piInfrastructureDirs` type narrows from `string[]` to `readonly string[]`               | `readonly string[]` is assignable to `string[]` consumers. If any caller mutates the array (none do today), the compiler will flag it. This is a safety improvement.                                                                                                                                                                                                                                       |
| `discoverGlobalNodeModulesRoot` mock in `runtime.test.ts` stops working after extraction | If `createExtensionRuntime` no longer calls `discoverGlobalNodeModulesRoot` directly (it delegates to `computeExtensionPaths`), the mock target shifts. Either mock `../src/extension-paths` in `runtime.test.ts`, or let the real `computeExtensionPaths` run and keep the existing mock on `../src/node-modules-discovery` which it transitively calls. The latter is simpler and tests the integration. |
| Re-export needed for downstream consumers                                                | `ExtensionPaths` should be re-exported from `src/runtime.ts` (or the package barrel if one exists) so `index.ts` and future consumers can import it without knowing the internal module.                                                                                                                                                                                                                   |

## Open questions

- Should `computeExtensionPaths` also accept an optional `globalNodeModulesRoot` parameter (for testability) or always call `discoverGlobalNodeModulesRoot()` internally?
  Recommendation: accept it as an optional parameter defaulting to the discovery call, matching the pattern used by `createExtensionRuntime`'s `agentDir` option.
  Decide at implementation time based on test ergonomics.
