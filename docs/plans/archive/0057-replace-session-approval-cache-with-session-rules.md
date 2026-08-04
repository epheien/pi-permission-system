---
issue: 57
issue_title: "Replace SessionApprovalCache with session Ruleset"
---

# Replace SessionApprovalCache with session Ruleset

## Problem Statement

`SessionApprovalCache` is a standalone data structure with its own matching engine (directory-prefix matching via `isPathWithinDirectory()`), separate from the unified `Rule` / `Ruleset` / `evaluate()` system established by #55 and #56.
This duplication blocks #51 (generalize session approvals to all permission surfaces), because the prefix-based matcher only works for `external_directory`.

## Goals

- Replace `SessionApprovalCache` with a `SessionRules` class that wraps a plain `Ruleset`.
- Replace `deriveApprovalPrefix()` with `deriveApprovalPattern()` that returns a wildcard glob (`/path/to/dir/*`).
- Pass session rules into `evaluate()` as the highest-priority ruleset (appended after config rules).
- Move session-approval lookup out of the `tool_call` handler and into the unified `evaluate()` path.
- Preserve identical external_directory approval behavior (directory-scoped, session-ephemeral, cleared on shutdown).

## Non-Goals

- Generalizing session approvals to non-external_directory surfaces (#51 — follow-up).
- Changing the permission dialog options or adding pattern suggestions (#51).
- Persisting session approvals to disk.
- Changing the on-disk config format or `/permission-system` slash command name.

## Background

### Relevant modules

| File                            | Role                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/session-approval-cache.ts` | Current `SessionApprovalCache` class + `deriveApprovalPrefix()`                          |
| `src/rule.ts`                   | `Rule`, `Ruleset`, `evaluate()` — the unified permission engine                          |
| `src/wildcard-matcher.ts`       | `wildcardMatch()` used by `evaluate()`                                                   |
| `src/normalize.ts`              | Config → Ruleset normalization                                                           |
| `src/runtime.ts`                | Creates `sessionApprovalCache` on the `ExtensionRuntime`                                 |
| `src/handlers/tool-call.ts`     | Consumes `sessionApprovalCache` in 5 places for external_directory gates                 |
| `src/handlers/lifecycle.ts`     | Calls `sessionApprovalCache.clear()` on shutdown                                         |
| `src/permission-manager.ts`     | `resolvePermissions()` builds the config Ruleset; `checkPermission()` calls `evaluate()` |

### Permission surface

`external_directory` (special surface).
Session approvals currently only apply to this surface; the refactor preserves that scope.

### How session approvals are used today

1. **File-tool external_directory gate** — before prompting, `findMatchingPrefix("external_directory", normalizedPath)` checks if the path was previously approved.
   If yes, logs `session_approved` and falls through.
   If no, runs the normal `applyPermissionGate()` flow.
   On `approved_for_session`, calls `deriveApprovalPrefix()` and `approve()`.

2. **Bash external_directory gate** — filters `externalPaths` against `has("external_directory", p)`.
   Uncovered paths go through the prompt; on `approved_for_session`, each is approved.

3. **Lifecycle** — `clear()` on `session_shutdown`.

## Design Overview

### New `SessionRules` class

```typescript
// src/session-rules.ts
import type { Ruleset } from "./rule";

export class SessionRules {
  private rules: Ruleset = [];

  approve(surface: string, pattern: string): void {
    this.rules.push({ surface, pattern, action: "allow" });
  }

  getRuleset(): Ruleset {
    return [...this.rules]; // defensive copy
  }

  clear(): void {
    this.rules = [];
  }
}
```

### Pattern derivation

```typescript
// src/session-rules.ts
export function deriveApprovalPattern(normalizedPath: string): string {
  // If the path already ends with separator, it's a directory — glob its contents.
  if (normalizedPath.endsWith(sep)) {
    return `${normalizedPath}*`;
  }
  const dir = dirname(normalizedPath);
  if (dir === normalizedPath) {
    return `${dir}*`; // root
  }
  const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  return `${prefix}*`;
}
```

The trailing `*` turns the directory prefix into a wildcard glob that `wildcardMatch()` already handles — `wildcardMatch("/other/project/src/*", "/other/project/src/foo.ts")` returns true.

### Integration with `evaluate()`

Session rules are the highest-priority layer.
In the tool_call handler, instead of checking the session cache separately, we concatenate session rules after config rules:

```typescript
const configRules = resolvedPermissions.rules;
const sessionRuleset = deps.runtime.sessionRules.getRuleset();
const allRules = [...configRules, ...sessionRuleset];
```

However, this issue **does not** change `checkPermission()` or `resolvePermissions()` to accept session rules — that is #51's job (requires threading session rules through the full permission pipeline).

For this issue, the tool_call handler continues to check session approvals in the same position (before prompting), but uses `evaluate("external_directory", normalizedPath, sessionRuleset)` instead of `cache.findMatchingPrefix()`.
This replaces the custom prefix-matcher with the unified wildcard engine while keeping the handler structure unchanged.

### Edge case: sibling directory false positive

Current prefix matching (`/other/project/` does NOT match `/other/project-b/foo.ts`) is preserved because the glob `/other/project/*` does not match `/other/project-b/foo.ts` — `wildcardMatch` anchors at `^` and `$`.

### Edge case: exact directory match

`wildcardMatch("/other/project/src/*", "/other/project/src/")` returns false because `*` requires at least one character after the `/`.
To match the directory itself, we also store a rule for the exact directory path.
Alternatively, `deriveApprovalPattern()` returns two rules or uses `**` — but the simplest approach is: when checking, evaluate both the path and the path-with-trailing-content.
Actually, `wildcardMatch("X/*", "X/")` — the `*` maps to `.*` in regex, which matches zero characters too.
So `/other/project/src/*` matches `/other/project/src/` (the `*` matches empty string after the final `/`).
This preserves the current behavior.

## Module-Level Changes

### `src/session-rules.ts` (new)

- `SessionRules` class with `approve(surface, pattern)`, `getRuleset()`, `clear()`.
- `deriveApprovalPattern(normalizedPath)` — returns a glob string.
- Imports: `node:path` (dirname, sep), `./rule` (types only).

### `src/session-approval-cache.ts` (removed)

- Entire file deleted.

### `src/runtime.ts`

- Replace `SessionApprovalCache` import with `SessionRules`.
- Replace `sessionApprovalCache: SessionApprovalCache` with `sessionRules: SessionRules` on `ExtensionRuntime`.
- Construction: `sessionRules: new SessionRules()`.

### `src/handlers/tool-call.ts`

- Replace `deriveApprovalPrefix` import with `deriveApprovalPattern` from `../session-rules`.
- Replace `sessionApprovalCache.findMatchingPrefix("external_directory", path)` with an `evaluate("external_directory", path, sessionRuleset)` call — if the returned rule is in the session ruleset, it's a session approval.
- Replace `sessionApprovalCache.has("external_directory", p)` filter with equivalent `evaluate()` calls.
- Replace `sessionApprovalCache.approve(...)` calls with `sessionRules.approve("external_directory", deriveApprovalPattern(...))`.
- Log entries remain the same; `sessionApprovalPrefix` log field becomes `sessionApprovalPattern`.

### `src/handlers/lifecycle.ts`

- Replace `sessionApprovalCache.clear()` with `sessionRules.clear()`.

### `tests/session-approval-cache.test.ts` → `tests/session-rules.test.ts` (renamed)

- Rewrite to test `SessionRules` and `deriveApprovalPattern`.
- Test via `evaluate()` integration: approve a pattern, verify `evaluate("external_directory", path, rules)` returns `allow`.
- Preserve all edge cases: sibling directory, exact prefix, multiple approvals, surface isolation, clear.

### `tests/handlers/tool-call.test.ts`

- Update mocks: `sessionApprovalCache` → `sessionRules`.
- Adjust assertions for `deriveApprovalPattern` (glob) instead of `deriveApprovalPrefix` (prefix).

## TDD Order

1. **test: add SessionRules unit tests with evaluate() integration**
   - Red: write tests for `SessionRules.approve()`, `getRuleset()`, `clear()`, and `deriveApprovalPattern()`.
   - Green: implement `src/session-rules.ts`.
   - Commit: `test: add SessionRules and deriveApprovalPattern tests`

2. **feat: replace SessionApprovalCache with SessionRules in runtime**
   - Update `src/runtime.ts` to use `SessionRules`.
   - Update `src/handlers/lifecycle.ts` to call `sessionRules.clear()`.
   - Update existing runtime tests.
   - Commit: `feat: replace SessionApprovalCache with SessionRules in runtime`

3. **feat: migrate tool_call handler to use SessionRules + evaluate()**
   - Replace all `sessionApprovalCache` usage in `src/handlers/tool-call.ts`.
   - Replace `deriveApprovalPrefix` with `deriveApprovalPattern`.
   - Update `tests/handlers/tool-call.test.ts` mocks and assertions.
   - Commit: `feat: migrate tool_call external_directory to SessionRules`

4. **feat: remove SessionApprovalCache**
   - Delete `src/session-approval-cache.ts`.
   - Delete or rename `tests/session-approval-cache.test.ts`.
   - Verify no remaining imports.
   - Commit: `feat: remove SessionApprovalCache`

5. **docs: update references to SessionApprovalCache**
   - Update any docs or comments referencing the old class.
   - Commit: `docs: update session approval references (#57)`

## Risks and Mitigations

| Risk                                                                                            | Mitigation                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wildcard semantics differ from prefix semantics, silently widening approval scope               | `wildcardMatch` is anchored (`^...$`); `/dir/*` cannot match `/dir-sibling/file`. Explicit test for sibling directory false positive.                                                                                                                                        |
| `*` in `wildcardMatch` matches empty string, so `/dir/*` matches `/dir/` — is this intended?    | Yes, this preserves current behavior where approving `/dir/` covers `isPathWithinDirectory(path, "/dir/")`.                                                                                                                                                                  |
| Changing `runtime.sessionApprovalCache` to `runtime.sessionRules` breaks any external consumers | `ExtensionRuntime` is internal; no public API contract. Only our own handlers consume it.                                                                                                                                                                                    |
| Could this silently weaken a permission?                                                        | No — session rules are `allow`-only and only apply to paths the user has already explicitly approved via the dialog. The `evaluate()` last-match-wins semantics mean session rules override config rules, which is the intended behavior (user said "yes for this session"). |

## Open Questions

- Should `SessionRules` deduplicate patterns on `approve()`?
  Current `SessionApprovalCache` uses a `Set` which deduplicates.
  A `Ruleset` array does not.
  Deduplication is a minor optimization — defer unless profiling shows repeated approvals cause slowdown.
  Decision: skip deduplication for now; `evaluate()` handles duplicates correctly (last match wins, all are `allow`).
