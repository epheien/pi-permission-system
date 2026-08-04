---
issue: 51
issue_title: "Generalize session approvals to all permission surfaces with wildcard patterns"
---

# Generalize session approvals to all permission surfaces

## Problem Statement

Session-scoped approvals currently work only for `external_directory`.
When working in a session, the user is still prompted repeatedly for the same class of bash command, MCP tool, or skill load.
There is no way to say "yes, allow `git status*` for the rest of this session" without changing the on-disk policy to `allow`.

The `SessionRules` infrastructure (#57) and unified evaluate path (#65) are both landed.
The remaining work is to wire session approvals into all permission surfaces and add pattern suggestion logic.

## Goals

- Extend session approvals to all permission surfaces: bash, mcp, skills, tools.
- Each surface **suggests an approval pattern** when prompting (e.g., bash suggests `git *`, MCP suggests `server:*`).
- Show the suggested pattern in the dialog "for session" option label.
- Record `resolution: "session_approved"` with the matched pattern in the review log when a future check hits a session rule.
- Handle session-hit detection in `checkPermission()` for all surfaces (not just `external_directory`).

## Non-Goals

- Bash arity table for smarter pattern suggestions (#52 — follow-up).
- `~`/`$HOME` expansion in patterns (#53 — follow-up).
- Persisting session approvals to disk ("Always" across sessions — future work).
- Per-agent scoping of session approvals.
- "Deny for session" option — defer unless demand emerges.

## Background

### Current state

| File                        | Role                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/session-rules.ts`      | `SessionRules` class with `approve(surface, pattern)` + `deriveApprovalPattern()` for paths      |
| `src/rule.ts`               | `Rule`, `Ruleset`, `evaluate()` — pure last-match-wins decision engine                           |
| `src/permission-manager.ts` | `checkPermission()` — accepts `sessionRules` param but only checks them for `external_directory` |
| `src/permission-gate.ts`    | `applyPermissionGate()` — deny/ask/allow branching via callbacks                                 |
| `src/permission-dialog.ts`  | Dialog options including "Yes, for this session" → `approved_for_session` state                  |
| `src/permission-prompts.ts` | User-facing message formatting per surface                                                       |
| `src/handlers/tool-call.ts` | Consumes gates; has session pre-check and approval recording for `external_directory` only       |

### What's already working

- `external_directory` session approvals: pre-check via `checkPermission(..., sessionRules)`, approval recording via `deriveApprovalPattern()`, review log with `session_approved`.
- `SessionRules.approve(surface, pattern)` stores any surface/pattern pair.
- `evaluate()` matches session rules by wildcard — the engine is surface-agnostic.

### What's missing

1. `checkPermission()` doesn't pass `sessionRules` to `evaluate()` for bash/mcp/skill/tool surfaces.
2. No pattern suggestion logic for non-directory surfaces.
3. The "for session" recording in `tool-call.ts` is only wired for `external_directory`.
4. The dialog "for session" label is static — doesn't show what pattern will be approved.

## Design Overview

### 1. Extend `checkPermission()` to check session rules for all surfaces

Currently, the session check is inside the `external_directory` branch only.
Extend it to bash, mcp, skill, and tool branches:

```typescript
// For each surface branch, after building composedRules:
if (sessionRules && sessionRules.length > 0) {
  const sessionRule = evaluate(surface, value, sessionRules);
  if (sessionRules.includes(sessionRule)) {
    return {
      toolName,
      state: "allow",
      matchedPattern: sessionRule.pattern,
      source: "session",
      // surface-specific fields as needed
    };
  }
}
```

This is a uniform pattern already established for `external_directory`.

**Architectural note**: the target architecture (`docs/architecture/target-architecture.md`) envisions session rules composed directly into the main ruleset array (highest priority at the end) so `evaluate()` is called once with no separate pre-check.
The current implementation passes `sessionRules` as a separate parameter.
This plan extends the current pattern to all surfaces (least-risk path); a future refactor can inline session rules into the composed array for a single `evaluate()` call per surface.

### 2. Pattern suggestion module

New file `src/pattern-suggest.ts` — pure functions, no IO:

```typescript
export interface SessionApprovalSuggestion {
  surface: string;
  pattern: string;
  label: string; // Human-readable label for dialog
}

export function suggestSessionPattern(
  surface: string,
  value: string,
  input?: unknown,
): SessionApprovalSuggestion;
```

#### Per-surface heuristics

| Surface                  | Input                | Suggested pattern | Example                       |
| ------------------------ | -------------------- | ----------------- | ----------------------------- |
| bash                     | `git status --short` | `git *`           | First word + `*`              |
| bash (no args)           | `ls`                 | `ls`              | Exact command                 |
| mcp (qualified)          | `exa:search`         | `exa:*`           | Server prefix + `:*`          |
| mcp (munged)             | `exa_search`         | `exa_*`           | Server prefix + `_*`          |
| mcp (bare)               | `mcp`                | `*`               | Wildcard                      |
| skill                    | `librarian`          | `librarian`       | Exact skill name              |
| tool (read, write, etc.) | `read`               | `*`               | All uses of this tool surface |
| external_directory       | `/tmp/foo.txt`       | `/tmp/*`          | `deriveApprovalPattern()`     |

Bash heuristic: split on first space → `<command> *`.
This is intentionally conservative — `git *` is broader than ideal but visible in the dialog.
The arity table (#52) will refine this later.

### 3. Wire session approvals in `tool-call.ts`

The normal tool permission gate section already calls `checkPermission()`.
Changes needed:

1. Pass `sessionRules` to the normal-tool `checkPermission()` call (it's only passed in the `external_directory` branch today).
2. Detect `source === "session"` in the result → log `session_approved`, skip the gate.
3. Compute `suggestSessionPattern()` before calling the gate.
4. After gate returns with `decision.state === "approved_for_session"`, call `sessionRules.approve(surface, pattern)`.

### 4. Dynamic dialog label

Update the "for session" option to show the pattern:

```text
Agent 'default' requested bash command 'git status --short'. Allow?
  ● Yes
  ● Yes, allow "git *" for this session
  ● No
  ● No, provide reason
```

This requires `requestPermissionDecisionFromUi()` to accept a dynamic session label or the suggestion pattern.
Approach: add an optional `sessionLabel?: string` parameter that overrides the default `APPROVE_FOR_SESSION_OPTION` when provided.

### 5. Review log entries

When session rule matches a future check:

```jsonc
{
  "event": "permission_request.session_approved",
  "resolution": "session_approved",
  "surface": "bash",
  "value": "git status --short",
  "sessionApprovalPattern": "git *"
}
```

When user selects "for session":

```jsonc
{
  "event": "permission_request.approved",
  "resolution": "approved_for_session",
  "sessionApprovalPattern": "git *"
}
```

### 6. Gate extension

Add optional `sessionApproval` data to `PermissionGateParams` and `PermissionGateResult`:

```typescript
export interface PermissionGateParams {
  // ... existing ...
  sessionApproval?: { surface: string; pattern: string; label: string };
}

export type PermissionGateResult =
  | { action: "allow"; sessionApproval?: { surface: string; pattern: string } }
  | { action: "block"; reason: string };
```

When the promptForApproval callback returns `approved_for_session` and `sessionApproval` is provided, the gate attaches it to the result.
The caller inspects it and records into `SessionRules`.

## Module-Level Changes

### `src/pattern-suggest.ts` (new)

- `suggestSessionPattern(surface, value, input?)` → `SessionApprovalSuggestion`.
- `suggestBashPattern(command)` — first-word heuristic.
- `suggestMcpPattern(target)` — server-level prefix wildcard.
- Pure functions, fully testable.

### `src/permission-manager.ts` (modified)

- Add session rule evaluation to the bash branch, mcp branch, skill branch, and tool branch — same pattern as `external_directory`.

### `src/permission-gate.ts` (modified)

- Add `sessionApproval?` to `PermissionGateParams`.
- Extend `PermissionGateResult` allow variant with optional `sessionApproval`.
- Gate attaches `sessionApproval` when `decision.state === "approved_for_session"`.

### `src/permission-dialog.ts` (modified)

- `requestPermissionDecisionFromUi()` accepts optional `sessionLabel` to customize the "for session" option.

### `src/handlers/tool-call.ts` (modified)

- Pass `sessionRules` to the normal-tool `checkPermission()` call.
- Detect `source === "session"` → log + skip gate.
- Compute `suggestSessionPattern()` and pass to gate.
- On `sessionApproval` in result → `sessionRules.approve(...)`.

### `src/permission-prompts.ts` (modified)

- Add `formatSessionOptionLabel(pattern)` → `'Yes, allow "<pattern>" for this session'`.

### `tests/pattern-suggest.test.ts` (new)

- Unit tests for all pattern suggestion heuristics.

### `tests/permission-manager.test.ts` (modified)

- Test session rule evaluation for bash, mcp, skill, and tool surfaces.

### `tests/permission-gate.test.ts` (modified)

- Test `sessionApproval` pass-through on `approved_for_session`.

### `tests/handlers/tool-call.test.ts` (modified)

- Test session-hit detection across surfaces.
- Test session recording on "for session" approval.

## TDD Order

1. **test: pattern suggestion unit tests for all surfaces**
   - Red: tests for `suggestBashPattern`, `suggestMcpPattern`, `suggestSessionPattern`.
   - Green: implement `src/pattern-suggest.ts`.
   - Commit: `feat: add pattern-suggest module for session approval patterns`

2. **test: checkPermission returns session hit for bash/mcp/skill/tool**
   - Red: tests that `checkPermission("bash", { command: "git status" }, agent, sessionRules)` returns `{ source: "session" }` when session rules contain a matching bash rule.
   - Green: extend the bash/mcp/skill/tool branches in `checkPermission()`.
   - Commit: `feat: extend checkPermission session evaluation to all surfaces`

3. **test: gate attaches sessionApproval on approved_for_session**
   - Red: test that gate returns `{ action: "allow", sessionApproval: {...} }` when decision is `approved_for_session` and params include `sessionApproval`.
   - Green: extend `PermissionGateParams` and `PermissionGateResult`, wire in gate logic.
   - Commit: `feat: extend permission gate with sessionApproval pass-through`

4. **test: dialog shows dynamic session label**
   - Red: test that `requestPermissionDecisionFromUi()` passes the custom session label to `ui.select()`.
   - Green: add `sessionLabel` param.
   - Commit: `feat: dynamic session approval label in permission dialog`

5. **feat: wire session approvals into tool-call handler for all surfaces**
   - Pass `sessionRules` to the normal `checkPermission()` call.
   - Detect `source === "session"` → log `session_approved`, skip gate.
   - Compute `suggestSessionPattern()` and pass to gate params.
   - Record `sessionRules.approve(...)` when result carries `sessionApproval`.
   - Update existing tests that assert on the gate call to account for new params.
   - Commit: `feat: generalize session approvals to all permission surfaces (#51)`

6. **docs: update README with session approval behavior**
   - Document pattern suggestion behavior per surface.
   - Commit: `docs: document generalized session approvals (#51)`

## Risks and Mitigations

| Risk                                                          | Mitigation                                                                                                                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bash pattern too broad (`git *` allows `git push --force`)    | Pattern is shown in dialog label. User sees what they approve. #52 refines with arity table.                                                                                                           |
| MCP server-level pattern (`exa:*`) allows all tools on server | Shown in dialog. Users can decline for per-tool prompting.                                                                                                                                             |
| Session allow overrides a config deny                         | Session rules use `evaluate()` where last-match-wins. Session rules should NOT override explicit deny. Fix: in `checkPermission()`, only check session rules when config result is `ask` (not `deny`). |
| Could this silently weaken a permission?                      | No. Every session rule requires explicit user approval via dialog. Pattern is visible in the label. No rule added without user action. Deny rules are not overridable by session.                      |
| Tool surface `*` pattern too permissive                       | For tools like `write`/`edit`, approving `*` means "allow all writes." This matches the granularity of the tool-level config. Path-specific patterns are a follow-up.                                  |

## Open Questions

- Should "for session" for write/edit tools suggest a path-based pattern (e.g. `src/*`) instead of blanket `*`?
  Leaning no — the tool permission surface doesn't currently match on file paths, only tool names.
  Path-based session rules would need a new surface or evaluation mode.
- Should session approvals be blocked from overriding explicit `deny` rules?
  Yes — the implementation should only offer "for session" when the config state is `ask`, not `deny`.
  A `deny` bypasses the gate entirely (no prompt shown).
