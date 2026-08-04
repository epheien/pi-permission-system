---
issue: 44
issue_title: "Auto-allow /dev/null in external directory checks"
---

# Auto-allow `/dev/null` in external directory checks

## Problem Statement

Agents frequently redirect stderr to `/dev/null` (e.g., `command 2>/dev/null`).
The external-directory guard treats `/dev/null` as a path outside the working directory and prompts for permission.
This is noisy and pointless — `/dev/null` is universally safe (read returns EOF, write discards data).
The same applies to `/dev/stdin`, `/dev/stdout`, and `/dev/stderr`, which are OS primitives that cannot leak data or modify the filesystem.

## Goals

- Add a hardcoded `SAFE_SYSTEM_PATHS` set in `src/external-directory.ts` containing `/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`.
- Filter these paths out in `extractExternalPathsFromBashCommand` before returning.
- Filter them out in `isPathOutsideWorkingDirectory` (or at its call site in `getPathBearingToolPath` / file-tool check) for the unlikely case a file tool targets `/dev/null`.
- No config changes — this is a universal safety judgment, not policy.

## Non-Goals

- Making the allowlist configurable (these are OS primitives).
- Allowing arbitrary paths without prompting.
- Windows `NUL` device — defer until there is a Windows user request.

## Background

### Permission surface involved

- **special / external_directory** — the gate this change affects.

### Existing modules

| File                        | Role                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `src/external-directory.ts` | `isPathOutsideWorkingDirectory`, `extractExternalPathsFromBashCommand`, `getPathBearingToolPath`, format helpers |
| `src/index.ts`              | Tool-call interceptor; file-tool external-directory gate (~line 828), bash external-directory gate (~line 904)   |

### Flow today (file tools)

```text
tool_call event → getPathBearingToolPath → isPathOutsideWorkingDirectory
  → checkPermission("external_directory") → deny/ask/allow
```

### Flow today (bash)

```text
tool_call event → extractExternalPathsFromBashCommand
  → if externalPaths.length > 0 → checkPermission("external_directory")
```

Both flows currently fire on `/dev/null` because it resolves outside CWD.

## Design Overview

### `SAFE_SYSTEM_PATHS` constant

```typescript
/**
 * Paths that are universally safe and should never trigger external-directory checks.
 * These are OS device files: read returns EOF or process streams, write discards or goes to process streams.
 */
export const SAFE_SYSTEM_PATHS: ReadonlySet<string> = new Set([
  "/dev/null",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
]);
```

### `isSafeSystemPath` helper

A small pure function that checks whether a normalized path is in the safe set:

```typescript
export function isSafeSystemPath(normalizedPath: string): boolean {
  return SAFE_SYSTEM_PATHS.has(normalizedPath);
}
```

Normalization is already handled by `normalizePathForComparison` — these paths are absolute and resolve to themselves.

### Changes to `isPathOutsideWorkingDirectory`

After resolving and normalizing the path, check `isSafeSystemPath` before the CWD comparison.
If the normalized path is a safe system path, return `false` (not outside working directory).

### Changes to `extractExternalPathsFromBashCommand`

After resolving each candidate token but before adding it to the external paths list, check `isSafeSystemPath`.
If the candidate's normalized path is a safe system path, skip it.

### No changes to `src/index.ts`

Both the file-tool gate and the bash gate rely on `isPathOutsideWorkingDirectory` and `extractExternalPathsFromBashCommand` respectively.
Filtering at the source means no call-site changes are needed.

### Merge precedence

No change — no new policy fields.

## Module-Level Changes

| File                               | Change                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/external-directory.ts`        | Add `SAFE_SYSTEM_PATHS` constant, `isSafeSystemPath` helper. Update `isPathOutsideWorkingDirectory` and `extractExternalPathsFromBashCommand` to skip safe paths. |
| `tests/external-directory.test.ts` | Add unit tests for `isSafeSystemPath`, and tests confirming `/dev/null` et al. are excluded from external-directory checks in both file-tool and bash paths.      |

## TDD Order

1. **Red**: Unit tests for `isSafeSystemPath` — each safe path returns true, arbitrary paths return false, paths like `/dev/null/subdir` return false.
   Commit: `test: cover isSafeSystemPath for safe system device paths`

2. **Green**: Implement `SAFE_SYSTEM_PATHS` and `isSafeSystemPath` in `src/external-directory.ts`.
   Commit: `feat: add SAFE_SYSTEM_PATHS allowlist and isSafeSystemPath helper (#44)`

3. **Red**: Tests for `isPathOutsideWorkingDirectory` confirming `/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr` return `false` (not outside CWD) regardless of CWD.
   Commit: `test: isPathOutsideWorkingDirectory skips safe system paths`

4. **Green**: Update `isPathOutsideWorkingDirectory` to return `false` for safe system paths.
   Commit: `feat: skip safe system paths in isPathOutsideWorkingDirectory (#44)`

5. **Red**: Tests for `extractExternalPathsFromBashCommand` confirming commands like `command 2>/dev/null`, `cat /dev/stdin`, and mixed commands with both `/dev/null` and a real external path produce the correct filtered list.
   Commit: `test: extractExternalPathsFromBashCommand filters safe system paths`

6. **Green**: Update `extractExternalPathsFromBashCommand` to skip safe system paths.
   Commit: `feat: filter safe system paths from bash external path extraction (#44)`

7. **Docs**: No config or schema changes needed.
   Add a brief note in README if the external-directory section mentions the allowlist.
   Commit: `docs: note safe system path allowlist in external-directory section (#44)`

## Risks and Mitigations

| Risk                                                         | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Could this silently weaken a permission?                     | No — the allowlisted paths are OS device files that cannot leak or modify user data. `/dev/null` discards writes and returns EOF on read. The others map to the process's own stdio streams.                                                                                                                                                                                                                                                                                                                                                                                            |
| `cat /dev/null > important_file` truncates a file inside CWD | The destructive action is the `>` redirect to `important_file`, not the read from `/dev/null`. `extractExternalPathsFromBashCommand` splits on `>` (it is in the metacharacter regex `[\|;&><\s]+`), so`important_file` and `/dev/null` become separate tokens. `important_file` is a bare relative name — `classifyTokenAsPathCandidate` skips it (no leading `/`,`~/`, or`..`). The external-directory gate was never designed to catch in-CWD truncation via bash redirects; that is the bash pattern filter's responsibility. Filtering`/dev/null` changes nothing about this path. |
| `cat /dev/null > /etc/passwd` truncates an out-of-CWD file   | `/dev/null` is filtered by the allowlist, but `/etc/passwd` is a separate token, is an absolute path outside CWD, and still triggers the external-directory check normally. No protection is lost.                                                                                                                                                                                                                                                                                                                                                                                      |
| Path traversal via `/dev/null/../etc/passwd`                 | `normalizePathForComparison` resolves `..` before comparison, so this normalizes to `/etc/passwd` which is not in `SAFE_SYSTEM_PATHS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Symlink to real file at `/dev/null`                          | On any POSIX system `/dev/null` is a kernel device node, not a symlink. If an attacker can replace `/dev/null` they already have root. Out of scope.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Windows `NUL` device not covered                             | Deferred — no Windows user request yet. The `SAFE_SYSTEM_PATHS` set can be extended later.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Open Questions

- Should `/dev/zero`, `/dev/random`, `/dev/urandom` be included?
  They are read-only device files but less commonly used by agents.
  Suggest: defer and add if agents trigger false positives on them.
