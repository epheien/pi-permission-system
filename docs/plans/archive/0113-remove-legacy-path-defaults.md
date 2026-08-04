---
issue: 113
issue_title: "refactor: remove legacy path defaults from logging and extension-config"
---

# Remove legacy path defaults from logging and extension-config

## Problem Statement

`src/extension-config.ts` exports module-scope constants (`CONFIG_PATH`, `LOGS_DIR`, `DEBUG_LOG_PATH`, `PERMISSION_REVIEW_LOG_PATH`) derived from `import.meta.url` that point to the legacy extension-root paths.
The current architecture uses `agentDir`-derived paths via `computeExtensionPaths()` and `runtime.ts` always provides explicit paths to the logger.
The legacy constants only serve as defaults in `createPermissionSystemLogger()` and in the legacy `loadPermissionSystemConfig()` / `savePermissionSystemConfig()` / `getPermissionSystemConfigPath()` / `ensurePermissionSystemConfig()` functions — none of which are imported by any production code in `src/`.

This creates confusing fallback behavior: if a caller omitted a path argument, it would silently use the wrong directory.

## Goals

- Make `debugLogPath`, `reviewLogPath`, and `ensureLogsDirectory` required in `PermissionSystemLoggerOptions`.
- Remove the legacy path constants (`CONFIG_PATH`, `LOGS_DIR`, `DEBUG_LOG_PATH`, `PERMISSION_REVIEW_LOG_PATH`) from `extension-config.ts`.
- Remove the legacy config functions (`loadPermissionSystemConfig`, `savePermissionSystemConfig`, `getPermissionSystemConfigPath`, `ensurePermissionSystemConfig`) that are dead production code.
- Update tests that import removed symbols.

## Non-Goals

- Changing `EXTENSION_ROOT` or `resolveExtensionRoot()` — still used by `runtime.ts`.
- Changing `ensurePermissionSystemLogsDirectory()` — still used by `runtime.ts` (called with an explicit `logsDir` argument).
- Refactoring `runtime.ts` or the config-loader pipeline.

## Background

### Permission surface

None — this is a pure internal cleanup.
No permission surface is involved.

### Relevant modules

- **`src/extension-config.ts`** — defines the legacy constants and functions.
  Also defines `EXTENSION_ID`, `DEFAULT_EXTENSION_CONFIG`, `normalizePermissionSystemConfig`, `detectMisplacedPermissionKeys`, `ensurePermissionSystemLogsDirectory`, and `EXTENSION_ROOT` which remain in use.
- **`src/logging.ts`** — `createPermissionSystemLogger()` imports legacy constants as defaults for its optional parameters.
- **`src/runtime.ts`** — the sole production consumer of both modules; already provides explicit paths and never relies on legacy defaults.

### Test consumers of legacy symbols

- `tests/extension-config.test.ts` — imports `loadPermissionSystemConfig` for integration tests.
- `tests/permission-system.test.ts` — imports `loadPermissionSystemConfig`, `savePermissionSystemConfig`; also creates a logger with all options explicit.
- `tests/config-modal.test.ts` — imports `loadPermissionSystemConfig`, `savePermissionSystemConfig` for config-modal round-trip tests.
- `tests/config-reporter.test.ts` — creates a logger with explicit paths (omits `debugLogPath` but this is benign since it never writes debug logs); needs `ensureLogsDirectory` but not the legacy default.

## Design Overview

### `logging.ts` changes

Make all three optional fields required in `PermissionSystemLoggerOptions`:

```typescript
interface PermissionSystemLoggerOptions {
  getConfig: () => PermissionSystemExtensionConfig;
  debugLogPath: string;
  reviewLogPath: string;
  ensureLogsDirectory: () => string | undefined;
}
```

Remove the `??` fallback expressions and the imports of `DEBUG_LOG_PATH`, `LOGS_DIR`, `PERMISSION_REVIEW_LOG_PATH`, and `ensurePermissionSystemLogsDirectory` from `extension-config`.

### `extension-config.ts` changes

Remove:

- `CONFIG_PATH`
- `LOGS_DIR`
- `DEBUG_LOG_PATH`
- `PERMISSION_REVIEW_LOG_PATH`
- `ensurePermissionSystemConfig()`
- `loadPermissionSystemConfig()`
- `savePermissionSystemConfig()`
- `getPermissionSystemConfigPath()`
- `cloneDefaultConfig()` (private, only used by `loadPermissionSystemConfig`)
- `createDefaultConfigContent()` (private, only used by `ensurePermissionSystemConfig`)
- `ensureConfigDirectory()` (private, only used by `ensurePermissionSystemConfig` and `savePermissionSystemConfig`)
- The `PermissionSystemConfigLoadResult` and `PermissionSystemConfigSaveResult` interfaces (only used by the removed functions)

Remove the now-unused `import` of `renameSync`, `unlinkSync`, and `writeFileSync` from `node:fs`.
Keep `existsSync` and `mkdirSync` (used by `ensurePermissionSystemLogsDirectory`).

Make the `logsDir` parameter of `ensurePermissionSystemLogsDirectory` required (remove the `= LOGS_DIR` default).

### Test changes

- **`tests/extension-config.test.ts`** — remove the `loadPermissionSystemConfig` describe block and its import.
  The `detectMisplacedPermissionKeys` and `normalizePermissionSystemConfig` tests remain.
- **`tests/permission-system.test.ts`** — remove or replace the `loadPermissionSystemConfig` / `savePermissionSystemConfig` tests.
  These test config round-tripping which is now covered by `config-loader.test.ts` or can be deleted as dead-code tests.
- **`tests/config-modal.test.ts`** — replace `loadPermissionSystemConfig` / `savePermissionSystemConfig` usage with direct `readFileSync` + `JSON.parse` + `normalizePermissionSystemConfig` and `writeFileSync`, or with the `loadUnifiedConfig` function that `runtime.ts` already uses.
- **`tests/config-reporter.test.ts`** — add the missing `debugLogPath` to the logger construction call.

## Test Impact Analysis

1. **New tests enabled** — none; this is a removal, not an extraction.
2. **Redundant tests** — the `loadPermissionSystemConfig` / `savePermissionSystemConfig` tests in `permission-system.test.ts` and `extension-config.test.ts` test functions that no production code calls.
   They should be removed.
3. **Tests that must stay** — `detectMisplacedPermissionKeys` and `normalizePermissionSystemConfig` tests in `extension-config.test.ts`; logger tests in `permission-system.test.ts` that construct the logger with explicit options; config-modal tests (adapted to use direct file I/O or `loadUnifiedConfig`).

## TDD Order

1. **Make logger options required and fix test call-sites.**
   Update `PermissionSystemLoggerOptions` to make `debugLogPath`, `reviewLogPath`, and `ensureLogsDirectory` required.
   Remove legacy-constant imports from `logging.ts`.
   Update `tests/config-reporter.test.ts` to provide `debugLogPath`.
   Run `pnpm vitest run tests/config-reporter.test.ts tests/permission-system.test.ts tests/runtime.test.ts` to confirm.
   Commit: `refactor: make logger path options required (#113)`

2. **Remove legacy config functions and constants from `extension-config.ts`.**
   Delete `CONFIG_PATH`, `LOGS_DIR`, `DEBUG_LOG_PATH`, `PERMISSION_REVIEW_LOG_PATH`, the four legacy config functions, their helper functions, and the two result interfaces.
   Make `ensurePermissionSystemLogsDirectory`'s `logsDir` parameter required.
   Remove unused `node:fs` imports.
   Commit: `refactor: remove legacy path constants and config functions (#113)`

3. **Update `tests/extension-config.test.ts`.**
   Remove the `loadPermissionSystemConfig` describe block and its import.
   Commit: `test: remove dead loadPermissionSystemConfig tests (#113)`

4. **Update `tests/permission-system.test.ts`.**
   Remove the `loadPermissionSystemConfig` / `savePermissionSystemConfig` import and tests.
   Commit: `test: remove dead legacy config round-trip tests (#113)`

5. **Update `tests/config-modal.test.ts`.**
   Replace `loadPermissionSystemConfig` / `savePermissionSystemConfig` with direct file I/O or `loadUnifiedConfig` + `normalizePermissionSystemConfig`.
   Run `pnpm vitest run tests/config-modal.test.ts` to confirm.
   Commit: `test: migrate config-modal tests off legacy config functions (#113)`

6. **Run full suite and type-check.**
   Run `pnpm run build` and `pnpm vitest run`.
   Commit (if any fixes needed): `fix: address build/test issues from legacy removal (#113)`

## Risks and Mitigations

| Risk                                                                      | Mitigation                                                                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Could this silently weaken a permission?                                  | No — this change only affects logging paths and config I/O helpers; no permission evaluation logic is touched. |
| An external consumer imports a removed symbol                             | These are internal modules; the package is not published as a library. Tests are the only consumers.           |
| `config-reporter.test.ts` silently used the legacy `debugLogPath` default | Step 1 makes it required, forcing the test to provide an explicit value and exposing any latent bug.           |
| `config-modal.test.ts` refactoring introduces a subtle behavior change    | The replacement uses the same underlying `normalizePermissionSystemConfig` function, preserving semantics.     |

## Open Questions

- None — the issue is fully scoped and all affected call-sites are identified.
