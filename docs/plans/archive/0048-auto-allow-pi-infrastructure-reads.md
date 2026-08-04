---
issue: 48
issue_title: "Auto-allow reads from Pi package and agent directories in external_directory checks"
---

# Auto-allow reads from Pi infrastructure directories

## Problem Statement

When `external_directory` is set to `ask` or `deny`, the agent is prompted (or blocked) when reading skill files, prompt templates, and other resources from Pi package directories (e.g. `/opt/homebrew/lib/node_modules/pi-ask-user/skills/ask-user/SKILL.md`).
These are read-only infrastructure paths — the agent should be able to read them without prompting.

## Goals

- Auto-allow **reads** (tools: `read`, `find`, `grep`, `ls`) from Pi infrastructure directories without triggering external-directory prompts.
- Discover infrastructure paths reliably across all package managers (npm, pnpm, bun, Homebrew) using self-discovery from `import.meta.url`.
- Cover all four path categories: agent config dir, project-local Pi packages, git-cloned global packages, and the global npm root.
- Provide an optional config field for users to add additional trusted read paths.
- Continue enforcing external-directory checks for **writes** (`write`, `edit`) to infrastructure paths.
- Continue enforcing external-directory checks for reads from non-infrastructure external paths.

## Non-Goals

- Upstream API request to Pi for exposing package paths (deferred — file separately if needed).
- Auto-allowing writes to infrastructure directories (explicitly out of scope).
- Changing the bash external-directory gate for infrastructure paths (deferred to a follow-up; bash commands that reference infrastructure paths are rare and complex to classify as read-only).

## Background

### Relevant modules

- `src/external-directory.ts` — contains `isPathOutsideWorkingDirectory()`, `isSafeSystemPath()`, `SAFE_SYSTEM_PATHS`, path normalization, and the tree-sitter bash path extractor.
- `src/handlers/tool-call.ts` — the file-tool external-directory gate (lines ~160–250) and bash external-directory gate (lines ~252–350).
  Both call `isPathOutsideWorkingDirectory()` and then check permissions.
- `src/runtime.ts` — `ExtensionRuntime` holds `agentDir` and is constructed once at startup.
- `src/extension-config.ts` — config loading and validation.
- `src/types.ts` — TypeScript types for config.

### Permission surface

`external_directory` (under `special`).

### Existing precedent

Issue #44 added `SAFE_SYSTEM_PATHS` — a static set of OS device paths (`/dev/null`, `/dev/stdin`, etc.) that bypass the external-directory check entirely.
The infrastructure paths here are similar in spirit (always safe to read) but differ in that they are environment-dependent, not constant.

## Design Overview

### Infrastructure path discovery

Build a set of "Pi infrastructure directories" at extension startup (inside `createExtensionRuntime`):

1. **Agent config directory** — `getAgentDir()` (already available as `runtime.agentDir`).
2. **Project-local Pi packages** — `<cwd>/.pi/npm/` and `<cwd>/.pi/git/` (derived from `ctx.cwd` at check time, not startup).
3. **Git-cloned global packages** — `<agentDir>/git/`.
4. **Global npm root** — discovered via **self-discovery**: walk up from `import.meta.url` (this extension's own install path) to find the enclosing `node_modules` directory.
   This works regardless of package manager since the extension itself is installed in the global npm root.

```typescript
/**
 * Discover the global node_modules root by walking up from this file's location.
 * Works for npm, pnpm, bun, Homebrew — any install method.
 */
export function discoverGlobalNodeModulesRoot(): string | null {
  const thisFile = fileURLToPath(import.meta.url);
  let dir = dirname(thisFile);
  while (dir !== dirname(dir)) {
    if (basename(dir) === "node_modules") {
      return dir;
    }
    dir = dirname(dir);
  }
  return null;
}
```

### Read-only enforcement

Only auto-allow for **read-only** file tools.
Define a set of read-only path-bearing tools:

```typescript
export const READ_ONLY_PATH_BEARING_TOOLS: ReadonlySet<string> = new Set([
  "read", "find", "grep", "ls",
]);
```

### Check order

In the file-tool external-directory gate (`tool-call.ts`), after confirming a path is outside CWD and before calling `checkPermission`:

1. If the tool is in `READ_ONLY_PATH_BEARING_TOOLS` AND the normalized path is within any Pi infrastructure directory → skip the external-directory gate (log to review log as `permission_request.infrastructure_auto_allowed`).
2. Otherwise → proceed with existing permission check.

### Config override

Add an optional `piInfrastructureReadPaths` field to the extension config:

```typescript
interface PermissionSystemExtensionConfig {
  // ... existing fields ...
  /** Additional directories to treat as Pi infrastructure for read auto-allow. */
  piInfrastructureReadPaths?: string[];
}
```

These are merged with the auto-discovered paths.
Paths support `~` expansion but not globs (they are directory prefixes, not patterns).

### Data flow

```text
startup:
  import.meta.url → walk up → globalNodeModulesRoot
  getAgentDir() → agentDir, agentDir/git/
  config.piInfrastructureReadPaths → user overrides
  → Set<string> of infrastructure directory prefixes (stored on ExtensionRuntime)

per tool-call:
  cwd → <cwd>/.pi/npm/, <cwd>/.pi/git/ (computed fresh each call)
  normalizedPath + toolName → isPiInfrastructureRead() → boolean
```

### Edge cases

- `import.meta.url` not resolvable (e.g. bundled/eval context) → `discoverGlobalNodeModulesRoot()` returns `null`, feature degrades gracefully (only agentDir and project paths are known).
- Symlinked installs (Homebrew) → `realpath` not needed; the normalized path from tool input will match the symlink target since `resolve()` is already used.
- pnpm virtual store (`.pnpm/`) → the `node_modules` walk still finds the root `node_modules` directory.
- Writes to infrastructure paths → NOT auto-allowed; the check only applies when tool is in `READ_ONLY_PATH_BEARING_TOOLS`.

## Module-Level Changes

### `src/external-directory.ts`

- Add `READ_ONLY_PATH_BEARING_TOOLS` set.
- Add `discoverGlobalNodeModulesRoot()` function.
- Add `isPiInfrastructureRead(toolName, normalizedPath, infrastructureDirs, cwd)` — pure function that returns `true` if the tool is read-only AND the path is within any infrastructure directory.

### `src/runtime.ts`

- Add `readonly piInfrastructureDirs: string[]` to `ExtensionRuntime`.
- Compute at construction: `[agentDir, join(agentDir, "git"), globalNodeModulesRoot, ...config.piInfrastructureReadPaths]` (filtered for non-null).

### `src/handlers/tool-call.ts`

- Before the external-directory permission check, call `isPiInfrastructureRead()`.
- If it returns `true`, log and skip the gate.
- Same pattern for bash external-directory gate is **deferred** (non-goal).

### `src/extension-config.ts`

- Add `piInfrastructureReadPaths` to config loading/validation.

### `src/types.ts`

- Add `piInfrastructureReadPaths?: string[]` to `PermissionSystemExtensionConfig`.

### `schemas/permissions.schema.json`

- Add `piInfrastructureReadPaths` property (array of strings, optional).

### `config/config.example.json`

- Add commented example showing `piInfrastructureReadPaths`.

### `docs/architecture/target-architecture.md`

- Update external-directory section to mention infrastructure auto-allow.

### `tests/`

- New file: `tests/pi-infrastructure-read.test.ts` — unit tests for `discoverGlobalNodeModulesRoot()`, `isPiInfrastructureRead()`.
- Update: `tests/external-directory.test.ts` — integration tests for the gate bypass in tool-call flow.

## TDD Order

1. **test:** Add unit tests for `discoverGlobalNodeModulesRoot()` — mock `import.meta.url`, verify walk-up logic, null fallback.
   Commit: `test: cover discoverGlobalNodeModulesRoot path walk`

2. **feat:** Implement `discoverGlobalNodeModulesRoot()` in `src/external-directory.ts`.
   Commit: `feat: add discoverGlobalNodeModulesRoot self-discovery`

3. **test:** Add unit tests for `isPiInfrastructureRead()` — read tool + infra path → true, write tool + infra path → false, read tool + non-infra path → false, project-local `.pi/npm/` and `.pi/git/` paths.
   Commit: `test: cover isPiInfrastructureRead pure function`

4. **feat:** Implement `READ_ONLY_PATH_BEARING_TOOLS` and `isPiInfrastructureRead()` in `src/external-directory.ts`.
   Commit: `feat: add isPiInfrastructureRead check for infrastructure directories`

5. **test:** Add tests for runtime construction — verify `piInfrastructureDirs` is populated from agentDir, globalNodeModulesRoot, and config overrides.
   Commit: `test: cover piInfrastructureDirs computation in runtime`

6. **feat:** Add `piInfrastructureDirs` to `ExtensionRuntime`, compute at construction.
   Update `src/types.ts` with `piInfrastructureReadPaths` config field.
   Update `src/extension-config.ts` to load/validate the new field.
   Commit: `feat: compute piInfrastructureDirs at runtime construction`

7. **test:** Add integration test for tool-call handler — read tool targeting infra path skips gate, write tool targeting same path does not skip.
   Commit: `test: cover infrastructure read bypass in tool-call handler`

8. **feat:** Wire `isPiInfrastructureRead()` into the file-tool external-directory gate in `src/handlers/tool-call.ts`.
   Commit: `feat: bypass external_directory gate for Pi infrastructure reads`

9. **docs:** Update schema, example config, and architecture docs.
   Commit: `docs: document piInfrastructureReadPaths config and infrastructure auto-allow`

## Risks and Mitigations

| Risk                                                                          | Mitigation                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Over-broad node_modules match allows reads from unrelated packages            | The check requires the path to be within a *Pi infrastructure* directory, not arbitrary node_modules paths. The discovered root is the same one Pi itself uses.   |
| Could silently weaken external_directory permission for writes                | The check is gated on `READ_ONLY_PATH_BEARING_TOOLS` — writes are never auto-allowed. Explicit test coverage for this case.                                       |
| `import.meta.url` walk finds wrong node_modules in nested installs            | Walk upward from our own file; the first `node_modules` ancestor is necessarily the one containing us. Nested node_modules deeper in the tree won't be ancestors. |
| Config `piInfrastructureReadPaths` used to bypass security for arbitrary dirs | Document clearly that these are read-only auto-allow paths. The field name includes "Read" to signal intent. Review log entry makes bypasses visible.             |
| Symlinked paths don't match resolved paths                                    | Both sides use `normalizePathForComparison()` which calls `resolve()` — symlinks are handled consistently with existing external-directory logic.                 |

## Open Questions

- Should the bash external-directory gate also auto-allow infrastructure reads?
  Deferred — bash commands are harder to classify as read-only (e.g. `cat /opt/.../SKILL.md` is a read, but detecting "read-only bash commands" reliably is complex).
  Can be added in a follow-up.
- Should `piInfrastructureReadPaths` support glob patterns or only directory prefixes?
  Starting with directory prefixes (simpler, consistent with `isPathWithinDirectory`).
  Globs can be added later if needed.
