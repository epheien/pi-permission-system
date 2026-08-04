---
issue: 41
issue_title: "Extract a reusable permission-gate function to eliminate repeated deny/ask/allow branching"
---

# Extract a reusable permission-gate function

## Problem Statement

`src/index.ts` contains five near-identical deny/ask/allow branching blocks (skill input, skill-read path, external-directory for file tools, external-directory for bash, and normal tool permission).
Each block repeats the same three-branch structure: deny → log + block, ask → check UI availability → prompt → maybe block, allow → fall through.
The only variation is the log context, message formatters, and return shape.
This duplication inflates the tool_call handler by ~170 lines and makes every future permission-surface addition copy-paste-prone.

## Goals

- Extract a single `applyPermissionGate()` function into `src/permission-gate.ts`.
- Replace all five inline deny/ask/allow branches with calls to it.
- Add focused unit tests for the gate function.
- Net-reduce `src/index.ts` by ~150 lines with no change to permission semantics.

## Non-Goals

- Splitting the `tool_call` / `input` handlers into separate files (tracked by #21 phase 2).
- Changing any permission resolution logic, merge precedence, or default policy.
- Refactoring `promptPermission` or `writeReviewLog` internals.

## Background

The repeated pattern lives inside two event handlers registered by `piPermissionSystemExtension()` in `src/index.ts`:

| Handler         | Surface                         | Approx lines |
| --------------- | ------------------------------- | ------------ |
| `input` (skill) | skill input gate                | 676–717      |
| `tool_call`     | skill-read path                 | 762–822      |
| `tool_call`     | external-directory (file tools) | 843–894      |
| `tool_call`     | external-directory (bash)       | 921–978      |
| `tool_call`     | normal tool permission          | 1000–1053    |

Key dependencies consumed inside the branches:

- `writeReviewLog` — closure over the review-log writer.
- `promptPermission` — closure that delegates to the permission dialog or auto-approves in yolo mode.
- `canRequestPermissionConfirmation(ctx)` — pure check for interactive UI.
- Various `format*` helpers from `src/format-messages.ts`.

The skill-input handler returns `{ action: "handled" }` to block, while the tool_call handler returns `{ block: true, reason }`.
The gate function must be agnostic to this — it returns its own result type and each call site maps it to the handler's expected shape.

## Design Overview

### Types

```typescript
/** Result of applying the permission gate. */
export type PermissionGateResult =
  | { action: "allow" }
  | { action: "block"; reason: string };

/** Everything the gate needs — no direct dependency on ExtensionContext. */
export interface PermissionGateParams {
  /** The resolved permission state from checkPermission(). */
  state: "allow" | "deny" | "ask";

  /** Whether the current context supports interactive prompts. */
  canConfirm: boolean;

  /** Prompt the user for approval. Only called when state === "ask" and canConfirm is true. */
  promptForApproval: () => Promise<PermissionPromptDecision>;

  /** Write a review-log entry. Called for deny and ask-but-unavailable paths. */
  writeLog: (event: string, extra: Record<string, unknown>) => void;

  /** Log context fields shared across all log calls for this gate. */
  logContext: Record<string, unknown>;

  /** Message strings/factories for each outcome. */
  messages: {
    denyReason: string;
    unavailableReason: string;
    userDeniedReason: (decision: PermissionPromptDecision) => string;
  };
}
```

### Behaviour (pure decision logic)

1. **deny** → call `writeLog("permission_request.blocked", { ...logContext, resolution: "policy_denied" })`, return `{ action: "block", reason: messages.denyReason }`.
2. **ask + !canConfirm** → call `writeLog("permission_request.blocked", { ...logContext, resolution: "confirmation_unavailable" })`, return `{ action: "block", reason: messages.unavailableReason }`.
3. **ask + canConfirm** → call `promptForApproval()`.
   If `!decision.approved`, return `{ action: "block", reason: messages.userDeniedReason(decision) }`.
   Otherwise fall through.
4. **allow** (or ask + approved) → return `{ action: "allow" }`.

### Call-site mapping

Each handler maps the gate result to its own return shape:

```typescript
// tool_call handler
const result = await applyPermissionGate({ ... });
if (result.action === "block") return { block: true, reason: result.reason };

// input handler (skill)
const result = await applyPermissionGate({ ... });
if (result.action === "block") return { action: "handled" };
```

The skill-input handler currently shows a UI notification on deny before returning.
That notification stays at the call site (before calling the gate or after inspecting its result); the gate itself is UI-agnostic.

### Design decisions

- **`promptForApproval` is a pre-bound closure** rather than passing `ctx` + details into the gate.
  This keeps the gate free of `ExtensionContext` and `promptPermission` signature coupling.
- **`writeLog` is a thin callback** so the gate does not depend on the review-log writer's closure.
- **No `writeLog` call on the allow or user-approved path** — those are logged by `promptPermission` internally (via `reviewPermissionDecision`), not by the gate.
- **The skill-input deny path's UI notification** remains outside the gate at the call site, keeping the gate headless.

## Module-Level Changes

### `src/permission-gate.ts` (new)

- Export `PermissionGateResult`, `PermissionGateParams`, `applyPermissionGate`.
- Pure async function, no imports beyond the `PermissionPromptDecision` type from `src/permission-dialog.ts`.

### `src/index.ts` (modified)

- Import `applyPermissionGate` and its param/result types.
- Replace the five inline deny/ask/allow blocks with calls to `applyPermissionGate`.
- Each call site constructs `PermissionGateParams` from existing local variables and format helpers.
- Net deletion: ~150 lines.

### `tests/permission-gate.test.ts` (new)

- Unit tests exercising each branch of `applyPermissionGate` in isolation with mock callbacks.

### No changes to

- `schemas/permissions.schema.json`, `config/config.example.json`, `README.md` — this is an internal refactor with no config or schema impact.
- `src/permission-manager.ts`, `src/permission-dialog.ts`, `src/format-messages.ts` — consumed but not modified.

## TDD Order

1. **Red**: test `applyPermissionGate` returns `{ action: "block" }` with deny reason when `state === "deny"`, and calls `writeLog` with `resolution: "policy_denied"`.
   **Green**: implement the deny branch in `src/permission-gate.ts`.
   `test: permission-gate deny branch`

2. **Red**: test gate returns block with unavailable reason when `state === "ask"` and `canConfirm === false`, and calls `writeLog` with `resolution: "confirmation_unavailable"`.
   **Green**: implement the ask-unavailable branch.
   `test: permission-gate ask-unavailable branch`

3. **Red**: test gate calls `promptForApproval` and returns block with user-denied reason when the user rejects.
   **Green**: implement the ask-rejected branch.
   `test: permission-gate ask-rejected branch`

4. **Red**: test gate calls `promptForApproval` and returns `{ action: "allow" }` when user approves.
   **Green**: implement the ask-approved branch.
   `test: permission-gate ask-approved path`

5. **Red**: test gate returns `{ action: "allow" }` immediately when `state === "allow"` without calling `writeLog` or `promptForApproval`.
   **Green**: implement the allow fast-path.
   `feat: add permission-gate module`

6. **Refactor**: replace all five inline branches in `src/index.ts` with `applyPermissionGate` calls.
   Run the full existing test suite to confirm no regressions.
   `refactor: replace inline deny/ask/allow branches with applyPermissionGate`

7. **Verify**: run `pnpm run build` to confirm no type errors, then full `npx vitest run`.
   `chore: verify clean build after permission-gate extraction`

## Risks and Mitigations

| Risk                                                                        | Mitigation                                                                                                                                                       |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subtle semantic drift during extraction (e.g. missing a log field)          | Each call site is converted one at a time with the full test suite run after each batch. The gate's own unit tests cover every branch.                           |
| Could this silently weaken a permission?                                    | No — the gate is a strict refactor. The deny and ask branches produce identical block results. The allow path is unchanged. No new `"allow"` path is introduced. |
| Skill-input handler returns `{ action: "handled" }` not `{ block, reason }` | The gate returns its own `PermissionGateResult`; each call site maps it. The skill-input site discards `reason` and returns `{ action: "handled" }` as before.   |
| `promptForApproval` closure captures stale variables                        | Each closure is constructed fresh inside the event handler per invocation — same lifetime as the current inline code.                                            |

## Open Questions

- None — the issue is self-contained and the proposed API is straightforward.
  If #21 phase 2 (handler extraction) lands first, the call sites will move to different files, but the gate function itself is unaffected.
