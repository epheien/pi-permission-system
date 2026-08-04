---
issue: 45
issue_title: "Add \"approve for this session\" option to permission prompts"
---

# Session-scoped approvals for permission prompts

## Problem Statement

When the `external_directory` gate is set to `ask`, every file access outside CWD prompts the user individually.
Investigating a sibling project can trigger dozens of identical approval dialogs in a single session.
There is no way to say "yes, allow this class of access for the rest of the session" without changing the on-disk policy to `allow`.

## Goals

- Add a third dialog option ("Allow for session") alongside "Yes" and "No" in the permission confirmation UI.
- Introduce an in-memory `SessionApprovalCache` that records directory-prefix approvals.
- Before prompting, check the cache; if a matching session approval exists, skip the dialog and log `resolution: "session_approved"`.
- Scope session approvals to the **external-directory** surface only (both file-tool and bash variants).
- Clear the cache on `session_shutdown`.
- Do **not** persist approvals to disk — they are ephemeral by design.
- Record session-approved decisions in the review log with a distinct resolution value.

## Non-Goals

- Extending session approvals to tool/bash-pattern/MCP/skill surfaces (future work noted in the issue).
- Per-agent scoping of session approvals (use the same flat cache regardless of active agent).
- Persisting approvals across sessions — that is what policy config is for.
- Changing the on-disk schema, example config, or `defaultPolicy` values.
- Changing the `/permission-system` slash command.

## Background

### Permission surfaces involved

`special.external_directory` — evaluated before normal tool/bash checks for path-bearing file tools and bash commands referencing external paths.

### Existing modules

| Module                      | Role                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/permission-dialog.ts`  | `requestPermissionDecisionFromUi()` presents Yes/No/No-with-reason via `PermissionDecisionUi.select()`.                                             |
| `src/permission-gate.ts`    | `applyPermissionGate()` — pure deny/ask/allow branching. Receives a `promptForApproval` callback.                                                   |
| `src/external-directory.ts` | Path normalization, outside-CWD detection, message formatting.                                                                                      |
| `src/index.ts`              | Wires the gate for file-tool and bash external-directory checks. Calls `promptPermission()` which delegates to `requestPermissionDecisionFromUi()`. |
| `src/types.ts`              | `PermissionPromptDecision`, `PermissionDecisionState` types.                                                                                        |

### Flow today

1. `tool_call` handler detects external path.
2. Calls `applyPermissionGate({ state: extCheck.state, ... })`.
3. If `state === "ask"`, gate calls `promptForApproval()` → `promptPermission()` → `requestPermissionDecisionFromUi()`.
4. User sees Yes / No / No-with-reason.
5. Decision is logged and returned.

### Flow after this change

1. `tool_call` handler detects external path.
2. **New**: before calling the gate, check `SessionApprovalCache` for a matching directory prefix.
   If found → log `session_approved`, return `{ action: "allow" }` without prompting.
3. If not cached → call `applyPermissionGate()` as today, but with the new three-option dialog.
4. If user selects "Allow for session" → record the directory prefix in the cache, return approved.
5. `session_shutdown` clears the cache.

## Design Overview

### `SessionApprovalCache`

A small class with a `Map<string, Set<string>>` keyed by surface type (initially only `"external_directory"`).
Values are normalized directory prefixes.

```typescript
export class SessionApprovalCache {
  private approvals = new Map<string, Set<string>>();

  approve(surface: string, prefix: string): void;
  has(surface: string, path: string): boolean; // prefix match
  clear(): void;
}
```

`has()` checks whether any stored prefix for the surface is an ancestor of (or equal to) the given path using `isPathWithinDirectory()` from `external-directory.ts`.

### Extended dialog

`PermissionDecisionState` gains a fourth value: `"approved_for_session"`.
`PermissionPromptDecision` already carries `state`; callers inspect it to decide whether to cache.

The dialog options become:

```text
Yes | Yes, for this session | No | No, provide reason
```

`requestPermissionDecisionFromUi()` returns `{ approved: true, state: "approved_for_session" }` for the session option.

### Deriving the approval prefix

For file-tool external-directory checks, the prefix is the **parent directory** of the target path (so approving access to `~/other-project/src/foo.ts` covers `~/other-project/src/`).
For bash external-directory checks, each extracted external path's parent directory is recorded.

A helper `deriveApprovalPrefix(normalizedPath: string): string` returns `dirname(normalizedPath)` with a trailing separator, ensuring prefix matching works correctly.

### Review log

When a request is satisfied from the cache:

```jsonc
{
  "event": "permission_request.session_approved",
  "resolution": "session_approved",
  "sessionApprovalPrefix": "/Users/.../other-project/src/"
  // ... standard log context
}
```

### Integration in `src/index.ts`

- Instantiate `SessionApprovalCache` alongside `permissionManager` at the top of `piPermissionSystemExtension()`.
- Clear it in `session_shutdown`.
- In both external-directory gate sites (file-tool and bash), insert a cache check **before** `applyPermissionGate()`.
- After a successful prompt where `decision.state === "approved_for_session"`, call `cache.approve(...)`.

## Module-Level Changes

### New file: `src/session-approval-cache.ts`

- `SessionApprovalCache` class.
- `deriveApprovalPrefix(normalizedPath: string): string` helper.
- Exports only pure logic; no IO.

### Modified: `src/permission-dialog.ts`

- Add `"approved_for_session"` to `PermissionDecisionState`.
- Add a fourth option constant `APPROVE_FOR_SESSION_OPTION = "Yes, for this session"`.
- Update `PERMISSION_DECISION_OPTIONS` array.
- Handle the new option in `requestPermissionDecisionFromUi()`.
- Update `isPermissionDecisionState()` guard.

### Modified: `src/types.ts`

No changes needed — `PermissionDecisionState` lives in `permission-dialog.ts`.

### Modified: `src/index.ts`

- Import `SessionApprovalCache` and `deriveApprovalPrefix`.
- Instantiate cache in `piPermissionSystemExtension()`.
- Clear cache in `session_shutdown` handler.
- File-tool external-directory block: add cache-check before gate, cache-write after session-approved decision.
- Bash external-directory block: same pattern, iterating over each extracted external path.

### New file: `tests/session-approval-cache.test.ts`

- Unit tests for `SessionApprovalCache` (approve, has, prefix matching, clear, cross-surface isolation).

### Modified: `tests/permission-dialog.test.ts`

- Test the new "Yes, for this session" option returns `approved_for_session`.
- Test `isPermissionDecisionState` includes the new value.

### Modified: `tests/index.test.ts` (or integration-level test)

- Test that a session-approved external-directory decision skips subsequent prompts for paths under the same prefix.
- Test that `session_shutdown` clears session approvals.
- Test that session approvals do not leak across surfaces.

## TDD Order

1. **Red → Green**: `SessionApprovalCache` — approve, has (prefix match), clear, surface isolation.
   `test: cover SessionApprovalCache approve/has/clear`

2. **Red → Green**: `deriveApprovalPrefix` — returns parent dir with trailing separator, handles root paths.
   `test: cover deriveApprovalPrefix edge cases`

3. **Feat**: implement `SessionApprovalCache` and `deriveApprovalPrefix` in `src/session-approval-cache.ts`.
   `feat: add SessionApprovalCache for ephemeral session approvals`

4. **Red → Green**: permission dialog returns `approved_for_session` for session option.
   `test: cover "Yes, for this session" dialog option`

5. **Feat**: extend `requestPermissionDecisionFromUi()` with the session option.
   `feat: add "approve for session" option to permission dialog`

6. **Red → Green**: integration — file-tool external-directory cache check skips prompt; bash variant likewise; shutdown clears cache.
   `test: cover session-approved external-directory flow`

7. **Feat**: wire `SessionApprovalCache` into `src/index.ts` external-directory gates.
   `feat: wire session approvals into external-directory gates`

8. **Docs**: update README permission-dialog section if it documents the Yes/No options.
   `docs: document session-scoped approval option`

## Risks and Mitigations

| Risk                                                                                 | Mitigation                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session approval silently weakens a permission by covering more paths than intended. | Prefix is derived from `dirname()` of the specific path, not the top-level external directory. Approving `~/other/src/foo.ts` covers `~/other/src/` but not `~/other/`. Users must approve broader prefixes explicitly via repeated prompts or policy config. |
| `approved_for_session` state breaks callers that only expect three states.           | `isPermissionDecisionState()` is updated in the same commit. Only `src/index.ts` inspects `decision.state` for caching; all other callers check `decision.approved` (boolean).                                                                                |
| Cache grows without bound during long sessions.                                      | External-directory prefixes are short strings; even hundreds of approvals are negligible. No eviction needed.                                                                                                                                                 |
| Bash external-directory extracts multiple paths — unclear which to cache.            | Cache each extracted path's parent individually. This is consistent: each path that was flagged gets its prefix recorded.                                                                                                                                     |
| Yolo mode interaction — session approval is redundant when yolo auto-approves.       | No conflict: yolo mode short-circuits before the dialog is shown, so the cache is never consulted. No special handling needed.                                                                                                                                |

## Open Questions

- Should the dialog show the resolved prefix being approved (e.g., "Allow all access to ~/other-project/src/ for this session")?
  Leaning yes for transparency, but can be deferred to a follow-up polish pass.
- Should the session approval cover the exact directory of the path or its parent?
  Current design uses `dirname()` (parent of the file).
  If the user is accessing `~/other-project/README.md`, the prefix is `~/other-project/` which seems right.
  For directory-bearing tools like `find` and `ls` where the path *is* a directory, using the path itself as the prefix may be more appropriate — worth validating in tests.
