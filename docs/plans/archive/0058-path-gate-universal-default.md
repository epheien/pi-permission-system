---
issue: 58
issue_title: "The permission configuration is invalid on the Windows system"
---

# Fix path gate firing for universal default fallback

## Problem Statement

The cross-cutting `path` permission gate (introduced in #148, v5.17.0) fires for every path-bearing tool call when the user configures `"*": "ask"` without an explicit `"path"` surface entry.
This causes tools like `find`, `ls`, `read`, and `grep` to prompt for approval even when the user has explicitly set them to `"allow"`.

The reporter's config:

```json
{
  "permission": {
    "*": "ask",
    "read": "allow",
    "find": "allow",
    "ls": "allow",
    "grep": "allow",
    "skill": { "*": "allow" },
    "external_directory": "ask"
  }
}
```

Expected: `find` and `ls` do not require approval.
Actual: every path-bearing tool call triggers an approval prompt.

Despite being reported as a Windows-specific issue, the bug is platform-independent — it affects any config with `"*": "ask"` and no explicit `"path"` key.

## Goals

- The `path` gate must not fire when no explicit `path` rules are configured.
- The `path` gate for tools must respect session approvals on the `path` surface (secondary bug: the current pre-check excludes session rules).
- Preserve correct behavior when explicit `path` rules ARE configured.
- No breaking changes.

## Non-Goals

- Investigating Windows-specific config-loading issues (no evidence of a path-resolution bug; the behavior reproduces from the code on all platforms).
- Changing `external_directory` gate behavior (it correctly prompts when configured).
- Changing the universal default semantics (it should still fall through to "ask" for surfaces that don't have an explicit cross-cutting gate).

## Background

### Gate chain order

```text
1. Skill-read gate
2. Path gate (tools)        ← BUG HERE
3. External-directory gate
4. Bash external-directory gate
5. Bash path gate           ← SAME BUG
6. Tool permission gate
```

The path gate runs BEFORE the tool gate.
When it fires, the user sees a prompt even though the tool gate would have allowed the call.

### How the bug manifests

1. `describePathGate` calls `checkPermission("path", { path: filePath })`.
2. No explicit `path` rule exists in the config.
3. The universal default rule `{ surface: "*", pattern: "*", action: "ask", layer: "default" }` matches.
4. `check.state` is `"ask"` → the gate returns a descriptor (only `"allow"` causes early return).
5. The runner prompts the user.

### Why `matchedPattern` is the correct discriminator

`PermissionManager.checkPermission()` sets `matchedPattern` only when `rule.layer === "config" || rule.layer === "session"`.
For the `path` surface (no baseline rules exist), `matchedPattern === undefined` uniquely identifies the universal default fallback.
When an explicit `path` config rule matches (e.g., `"path": { "*.env": "deny" }`), `matchedPattern` is set to the pattern string.

### Secondary bug: session rules excluded from tool path gate

`describeBashPathGate` receives `getSessionRuleset()` and includes session rules in its check.
`describePathGate` does NOT — it calls `checkPermission` without session rules, then sets `preCheck` on the descriptor.
The runner uses `preCheck` directly, so session approvals on the `path` surface are never seen by the tool path gate.

## Design Overview

### Fix 1: skip path gate for universal default

In `describePathGate`, after the existing `check.state === "allow"` early return, add:

```typescript
if (check.matchedPattern === undefined) return null;
```

This means: "no explicit `path` config rule matched this file — the path gate has nothing to enforce."

In `describeBashPathGate`, tokens whose check has `matchedPattern === undefined` (and `source !== "session"`) should be treated as unrestricted — skip them without updating `worstCheck`:

```typescript
if (check.matchedPattern === undefined && check.source !== "session") {
  allSessionCovered = false;
  continue;
}
```

### Fix 2: include session rules in tool path gate

Change `describePathGate` to accept a `getSessionRuleset` parameter (matching `describeBashPathGate`'s signature) and pass session rules to `checkPermission`:

```typescript
export function describePathGate(
  tcc: ToolCallContext,
  checkPermission: CheckPermissionFn,
  getSessionRuleset: () => Rule[],
): GateResult {
  // ...
  const sessionRules = getSessionRuleset();
  const check = checkPermission("path", { path: filePath }, tcc.agentName ?? undefined, sessionRules);
  // ...
}
```

The `CheckPermissionFn` type already accepts an optional `sessionRules` parameter.

With session rules included, the pre-check correctly identifies session-approved paths, and the runner's session fast-path works.

### Behavior matrix after fix

| Config has `path` key?                   | Universal default | Path matches rule? | Gate fires?            |
| ---------------------------------------- | ----------------- | ------------------ | ---------------------- |
| No                                       | `"*": "ask"`      | N/A                | No (fix)               |
| No                                       | `"*": "allow"`    | N/A                | No (existing)          |
| Yes: `{ "*.env": "deny" }`               | `"*": "ask"`      | `.env` file        | Yes (deny)             |
| Yes: `{ "*.env": "deny" }`               | `"*": "ask"`      | non-`.env` file    | No (fix)               |
| Yes: `{ "*": "ask" }`                    | any               | any file           | Yes (explicit config)  |
| Yes: `{ "*": "allow", "*.env": "deny" }` | any               | `.env` file        | Yes (deny)             |
| Yes: `{ "*": "allow", "*.env": "deny" }` | any               | non-`.env` file    | No (allow)             |
| Session approval for path                | any               | approved path      | No (session fast-path) |

## Module-Level Changes

### Changed files

| File                                      | Change                                                                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/handlers/gates/path.ts`              | Add `matchedPattern === undefined` early return; add `getSessionRuleset` parameter; pass session rules to `checkPermission`. |
| `src/handlers/gates/bash-path.ts`         | Skip tokens with `matchedPattern === undefined && source !== "session"`.                                                     |
| `src/handlers/permission-gate-handler.ts` | Pass `getSessionRuleset` to `describePathGate`.                                                                              |

### Changed test files

| File                                       | Change                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/handlers/gates/path.test.ts`        | Add test: returns `null` when `matchedPattern` is undefined (universal default). Add test: respects session approvals. Update existing tests to pass `getSessionRuleset`. |
| `tests/handlers/gates/bash-path.test.ts`   | Add test: skips tokens where `matchedPattern` is undefined.                                                                                                               |
| `tests/permission-manager-unified.test.ts` | Add integration test: tool allowed when `"*": "ask"` + `"read": "allow"` + no `path` config.                                                                              |

## Test Impact Analysis

1. New tests enabled by this fix:
   - Unit test confirming `describePathGate` returns `null` for universal default fallback.
   - Unit test confirming `describePathGate` returns descriptor when session rules yield "session" source (session approval works).
   - Unit test confirming `describeBashPathGate` skips tokens matching only the universal default.
   - Integration test confirming end-to-end: `"find": "allow"` works without explicit `"path"` config.

2. Existing tests that must be updated:
   - `tests/handlers/gates/path.test.ts`: all calls to `describePathGate` must pass a third `getSessionRuleset` argument.

3. Existing tests that stay as-is:
   - `tests/handlers/gates/bash-path.test.ts`: existing tests already use `matchedPattern` set (explicit config rules) — they remain valid.
   - `tests/rule.test.ts`, `tests/permission-manager-unified.test.ts` (existing cases) — no change.

## TDD Order

### Step 1 — Red: `describePathGate` skips universal default

1. In `tests/handlers/gates/path.test.ts`:
   - Update all existing `describePathGate` calls to pass a third `getSessionRuleset` argument (returns `[]`).
   - Add test: "returns null when matchedPattern is undefined (universal default)".
     Mock `checkPermission` to return `{ state: "ask", matchedPattern: undefined, source: "special", origin: "builtin" }`.
     Assert `describePathGate(tcc, checkPermission, getSessionRuleset)` returns `null`.
   - Add test: "returns descriptor when matchedPattern is defined (explicit path rule)".
     Mock returns `{ state: "ask", matchedPattern: "*.env", source: "special", origin: "global" }`.
     Assert result is a `GateDescriptor`.
2. Tests fail (signature mismatch + no `matchedPattern` check).

Commit: `test: expect describePathGate to skip universal default fallback (#58)`

### Step 2 — Green: implement path gate fix

1. In `src/handlers/gates/path.ts`:
   - Add `getSessionRuleset: () => Rule[]` parameter.
   - Call `const sessionRules = getSessionRuleset()` and pass to `checkPermission`.
   - After `if (check.state === "allow") return null;`, add `if (check.matchedPattern === undefined) return null;`.
2. In `src/handlers/permission-gate-handler.ts`:
   - Pass `getSessionRuleset` to `describePathGate`.
3. Tests pass.

Commit: `fix: skip path gate when no explicit path rules configured (#58)`

### Step 3 — Red: session approval respected by tool path gate

1. In `tests/handlers/gates/path.test.ts`:
   - Add test: "returns GateDescriptor with session source when session rule matches".
     `getSessionRuleset` returns a session rule for `path`.
     Mock `checkPermission` to return `{ state: "allow", source: "session", matchedPattern: "/project/*", origin: "session" }`.
     Assert the gate returns `null` (state is "allow" → early return).
   - Add test: "passes session rules to checkPermission".
     Assert `checkPermission` was called with the session ruleset as the 4th argument.
2. Tests pass immediately (already green from step 2 changes).

Commit: `test: verify path gate passes session rules to checkPermission (#58)`

### Step 4 — Red: `describeBashPathGate` skips universal default tokens

1. In `tests/handlers/gates/bash-path.test.ts`:
   - Add test: "returns null when all tokens match only the universal default".
     Mock `checkPermission` to return `{ state: "ask", matchedPattern: undefined }` for all tokens.
     Assert `describeBashPathGate` returns `null`.
   - Add test: "ignores tokens matching universal default but fires for explicit rule matches".
     First token returns `{ state: "ask", matchedPattern: undefined }` (skip).
     Second token returns `{ state: "deny", matchedPattern: "*.env" }` (fire).
     Assert result is a `GateDescriptor` for the second token.
2. Tests fail (no `matchedPattern` check in bash path gate).

Commit: `test: expect describeBashPathGate to skip universal default tokens (#58)`

### Step 5 — Green: implement bash path gate fix

1. In `src/handlers/gates/bash-path.ts`:
   - After the `checkPermission` call inside the token loop, add:

     ```typescript
     if (check.matchedPattern === undefined && check.source !== "session") {
       allSessionCovered = false;
       continue;
     }
     ```

2. Tests pass.

Commit: `fix: bash path gate skips tokens matching only universal default (#58)`

### Step 6 — Integration test

1. In `tests/permission-manager-unified.test.ts`:
   - Add test: with config `{ "*": "ask", "read": "allow" }` and no `path` key, `checkPermission("path", { path: "src/main.ts" })` returns `{ state: "ask", matchedPattern: undefined }`.
   - This confirms the underlying evaluation produces the expected shape that the gate uses to skip.
2. Tests pass (already green — verifying existing behavior shape).
3. Run full test suite: `pnpm vitest run`.

Commit: `test: integration test confirms path check returns undefined matchedPattern for universal default (#58)`

## Risks and Mitigations

| Risk                                                                                       | Mitigation                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Could this weaken security for users who expect `path` to inherit the universal default?   | No — the `path` surface was designed as opt-in (#148 plan: "Configs without a `path` key behave identically"). Users who want path-level gating must configure it explicitly. |
| Could `matchedPattern === undefined` trigger for reasons other than the universal default? | For the `path` surface, only the universal default produces undefined `matchedPattern` (no baseline rules exist for `path`). The check is safe.                               |
| Signature change to `describePathGate` breaks callers?                                     | Only one call site exists (`permission-gate-handler.ts`). Updated in step 2.                                                                                                  |
| Session rules change alters prompt frequency?                                              | Only in the beneficial direction — previously-approved paths now correctly bypass the gate instead of re-prompting.                                                           |

## Open Questions

1. Should the fix also emit a debug log entry when the gate skips due to universal default?
   Useful for diagnosing "why wasn't my path rule enforced" but adds noise.
   Recommendation: omit for now; add if users report confusion.
