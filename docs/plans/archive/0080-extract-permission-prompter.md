---
issue: 80
issue_title: "Extract PermissionPrompter class to unify prompt/log/forwarding chain"
---

# Extract PermissionPrompter class

## Problem Statement

Adding a new parameter to the permission prompt flow (e.g. `sessionLabel` from #51) currently requires coordinated signature changes across 4–5 files: `HandlerDeps` (types), `runtime.ts` (yolo-mode + logging), `polling.ts` (UI vs. forwarding branch), and `index.ts` (wiring).
Each layer exists for a valid reason, but the threading cost is disproportionate to the semantic change.

## Goals

- Encapsulate yolo-mode auto-approval, review-log writes, and UI-vs-forwarding branching in a single `PermissionPrompter` class behind a mockable interface.
- Reduce the "add a prompt parameter" surface from 4–5 files to 2 files: the `PromptPermissionDetails` type and the `PermissionPrompter` implementation.
- Eliminate `PermissionForwardingDeps.requestPermissionDecisionFromUi` as a standalone injected function — it becomes an internal detail of the prompter.
- Preserve identical user-visible behavior and test ergonomics (`HandlerDeps` still exposes a mockable `promptPermission` method).

## Non-Goals

- Changing user-facing permission dialog options or wording.
- Altering policy resolution or evaluation logic.
- Modifying the forwarded-permission file protocol.
- Renaming the `/permission-system` slash command.

## Background

### Permission surfaces involved

This is a cross-cutting refactor that touches the **prompt delivery** mechanism used by all permission surfaces (tools, bash, mcp, skills, special, external_directory) — but does not change any surface's evaluation logic.

### Relevant modules

| File                                   | Role today                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/handlers/types.ts`                | Defines `HandlerDeps.promptPermission` and `PromptPermissionDetails`                                   |
| `src/runtime.ts`                       | `promptPermission()` free function: yolo check → review log → `confirmPermission()`                    |
| `src/forwarded-permissions/polling.ts` | `confirmPermission()`: UI-present branch vs. subagent forwarding; `PermissionForwardingDeps` interface |
| `src/index.ts`                         | Wires `forwardingDeps` and binds `promptPermission` into `HandlerDeps`                                 |
| `src/permission-dialog.ts`             | `requestPermissionDecisionFromUi()` — shows the actual select dialog                                   |
| `src/yolo-mode.ts`                     | `shouldAutoApprovePermissionState()` — yolo-mode predicate                                             |

### Current call chain

```text
handler → deps.promptPermission(ctx, details)
       → runtime.ts::promptPermission(runtime, forwardingDeps, ctx, details)
           → yolo check → reviewPermissionDecision (waiting)
           → confirmPermission(ctx, message, forwardingDeps, options)
               → ctx.hasUI? requestPermissionDecisionFromUi(…) : forward
           → reviewPermissionDecision (approved|denied)
```

## Design Overview

### New interface

```typescript
/** Mockable contract exposed to handlers via HandlerDeps. */
export interface PermissionPrompterApi {
  prompt(
    ctx: ExtensionContext,
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision>;
}
```

### New class

```typescript
export class PermissionPrompter implements PermissionPrompterApi {
  constructor(private readonly deps: PermissionPrompterDeps) {}

  async prompt(
    ctx: ExtensionContext,
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> { /* … */ }
}

export interface PermissionPrompterDeps {
  /** Read current config for yolo-mode check. */
  getConfig(): PermissionSystemExtensionConfig;
  /** Write review log entries. */
  writeReviewLog(event: string, details: Record<string, unknown>): void;
  /** Subagent sessions dir for forwarding context check. */
  subagentSessionsDir: string;
  /** Forwarding dir for file-based permission requests. */
  forwardingDir: string;
  /** Show the actual permission dialog UI. */
  requestPermissionDecisionFromUi(
    ui: ExtensionContext["ui"],
    title: string,
    message: string,
    options?: RequestPermissionOptions,
  ): Promise<PermissionPromptDecision>;
}
```

### Wiring change

In `src/index.ts`, replace:

```typescript
const forwardingDeps: PermissionForwardingDeps = { … };
// …
promptPermission: (ctx, details) =>
  promptPermission(runtime, forwardingDeps, ctx, details),
```

With:

```typescript
const prompter = new PermissionPrompter({ … });
// …
promptPermission: (ctx, details) => prompter.prompt(ctx, details),
```

The `PermissionForwardingDeps` interface narrows to only what `processForwardedPermissionRequests` and `waitForForwardedPermissionApproval` need (forwarding-only concerns); the prompter owns the union of yolo + logging + confirm.

### Edge cases

- **Yolo mode**: auto-approval is checked inside `PermissionPrompter.prompt()` exactly as today.
- **Subagent forwarding**: `confirmPermission()` stays in `polling.ts` but is called by the prompter, not by the runtime free function.
- **Review log ordering**: waiting → (auto_approved | decision) is preserved.

## Module-Level Changes

| File                                             | Change                                                                                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/permission-prompter.ts` (new)               | `PermissionPrompterApi` interface, `PermissionPrompterDeps` interface, `PermissionPrompter` class                                                                                            |
| `src/runtime.ts`                                 | Remove `promptPermission()` free function and `reviewPermissionDecision()` helper (moved into class)                                                                                         |
| `src/forwarded-permissions/polling.ts`           | Narrow `PermissionForwardingDeps` — remove `requestPermissionDecisionFromUi` (kept only for `processForwardedPermissionRequests`); export `confirmPermission` as-is for the prompter to call |
| `src/index.ts`                                   | Instantiate `PermissionPrompter`, pass it to `HandlerDeps`; simplify `forwardingDeps` to forwarding-only subset                                                                              |
| `src/handlers/types.ts`                          | No signature change — `promptPermission` remains `(ctx, details) => Promise<PermissionPromptDecision>`                                                                                       |
| `tests/unit/runtime.test.ts`                     | Remove tests for `promptPermission` free function                                                                                                                                            |
| `tests/unit/permission-prompter.test.ts` (new)   | Unit tests for `PermissionPrompter` class                                                                                                                                                    |
| `tests/unit/polling.test.ts`                     | Adjust `PermissionForwardingDeps` mock to match narrowed interface                                                                                                                           |
| `docs/architecture/permission-prompter.md` (new) | Short architectural note explaining the class's responsibilities                                                                                                                             |

## TDD Order

1. **test:** Add unit tests for `PermissionPrompter.prompt()` covering yolo-mode auto-approve, UI-present approval, UI-present denial, and subagent forwarding path.
   Commit: `test: add PermissionPrompter unit tests (#80)`

2. **feat:** Create `src/permission-prompter.ts` with `PermissionPrompterApi`, `PermissionPrompterDeps`, and `PermissionPrompter` class extracting logic from `runtime.ts::promptPermission()`.
   Commit: `feat: extract PermissionPrompter class (#80)`

3. **feat:** Wire `PermissionPrompter` in `src/index.ts`, remove `promptPermission` free function from `runtime.ts`, narrow `PermissionForwardingDeps`.
   Commit: `feat: wire PermissionPrompter and remove runtime promptPermission (#80)`

4. **test:** Update `tests/unit/runtime.test.ts` — remove now-dead `promptPermission` tests.
   Update `tests/unit/polling.test.ts` mock to narrowed `PermissionForwardingDeps`.
   Commit: `test: update runtime and polling tests for PermissionPrompter extraction (#80)`

5. **docs:** Add `docs/architecture/permission-prompter.md` describing responsibility boundaries.
   Commit: `docs: add permission-prompter architecture note (#80)`

## Risks and Mitigations

| Risk                                         | Mitigation                                                                                                                                      |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Could this silently weaken a permission?     | No — the class preserves identical decision logic (yolo check → log → confirm). Integration tests for each permission surface remain unchanged. |
| Forwarding tests break due to narrowed deps  | Step 4 explicitly updates the mock interface; CI catches regressions.                                                                           |
| Circular import between prompter and polling | `PermissionPrompter` imports `confirmPermission` from polling; polling does not import the prompter. One-way dependency, no cycle.              |
| Review log entry format drift                | The class reuses the existing `reviewPermissionDecision` helper (moved into the class as a private method), preserving exact field names.       |

## Open Questions

- Whether `processForwardedPermissionRequests` should also move into the prompter class (deferred — it has its own polling lifecycle unrelated to single-prompt flow).
- Whether `PermissionPrompterDeps` should include a `writeDebugLog` method for trace-level output (can be added later without signature changes to handlers).
