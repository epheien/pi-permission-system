---
issue: 316
issue_title: "Fold PermissionPrompter.buildForwardingDeps() into the injected forwarder"
---

# Fold `PermissionPrompter.buildForwardingDeps()` into the injected forwarder

## Problem Statement

`PermissionPrompter` re-synthesizes its own `PermissionForwardingDeps` bag (`buildForwardingDeps()`) solely to call `confirmPermission()`.
This is the second independent construction of the same dependency set — `index.ts` already assembles one for the `PermissionForwarder` introduced in #315.
The prompter's copy diverges subtly (`shouldAutoApprove: () => false`, a no-op `writeDebugLog`) and drags along a cluster of `eslint-disable @typescript-eslint/unbound-method` lines.
It is a relay bag the prompter builds only to hand to a free function — anemic design with no owner.

This is step 2 of 3 in the forwarding lift-and-shift (#315 → #316 → #317).

## 315 has landed: `PermissionForwarder` exists in `src/forwarded-permissions/permission-forwarder.ts` with `requestApproval()` (currently unused by production) and `processInbox()`, plus a narrow `InboxProcessor` seam consumed by `ForwardingManager`

### Goals

- Inject the single `PermissionForwarder` into `PermissionPrompter` through a narrow `ApprovalRequester` interface exposing only `requestApproval`.
- Replace the `confirmPermission(ctx, …, this.buildForwardingDeps(), …)` call with `this.deps.forwarder.requestApproval(ctx, …)`.
- Delete `buildForwardingDeps()`, the second `PermissionForwardingDeps` synthesis, and its `eslint-disable unbound-method` cluster.
- Narrow `PermissionPrompterDeps` by removing the four fields that existed only to feed `buildForwardingDeps()` (`subagentSessionsDir`, `forwardingDir`, `registry`, `requestPermissionDecisionFromUi`).
- Wire `index.ts` to inject the existing single forwarder into the prompter (no second forwarder, no second bag).
- Behavior-preserving: this is a `refactor:`, not a `feat:`.

### Non-Goals

- Inlining the `polling.ts` free-function bodies as methods on `PermissionForwarder` or deleting the `PermissionForwardingDeps` interface — that is #317 (step 3 of 3).
- Changing the forwarding wire protocol, request/response file shapes, or the UI dialog flow.
- Touching `ForwardingManager` or its `InboxProcessor` seam (settled in #315).
- Altering yolo-mode handling — it stays at the prompter level, evaluated before `requestApproval` is reached.

### Background

Relevant modules:

- `src/permission-prompter.ts` — `PermissionPrompter` class, `PermissionPrompterDeps`, and the private `buildForwardingDeps()` being deleted.
- `src/forwarded-permissions/permission-forwarder.ts` — `PermissionForwarder` (already implements `InboxProcessor`); `requestApproval(ctx, message, options?, forwarded?)` already exists and delegates to `confirmPermission`.
  This is where the new `ApprovalRequester` seam belongs, mirroring the `InboxProcessor` convention established in #315.
- `src/index.ts` — composition root; constructs the prompter (line ~52), then the `forwardingDeps` bag and `forwarder` (lines ~64–76), then `PermissionSession`/`ForwardingManager`.
- `src/forwarded-permissions/polling.ts` — `confirmPermission()` and the `PermissionForwardingDeps` interface (untouched this issue).
- `test/permission-prompter.test.ts` — currently `vi.mock`s `polling` and asserts against `mockConfirmPermission`; must migrate to an injected forwarder mock.

Constraints from AGENTS.md / package skill:

- The package is the sole authority for tool policy; this refactor must not alter any allow/deny/ask decision.
- `@typescript-eslint/require-await` is enabled for `src/`; `requestApproval` already returns the delegated promise, so no `async` churn.
- Markdown is enforced by `rumdl` (`pnpm run lint:md`), not `markdownlint` — the `MDxxx` IDs in conventions are for reference only (per #315 retro).
- The seam type must be a **narrow interface**, never the concrete `PermissionForwarder` — concrete class types leak private fields into the structural checker and force test casts (code-design + design-review guidance, confirmed by #315's `InboxProcessor` win).

### Design Overview

#### The `ApprovalRequester` seam

Define a one-method interface alongside `InboxProcessor` in `permission-forwarder.ts` and add it to the class's `implements` clause:

```typescript
/**
 * Narrow seam describing what `PermissionPrompter` needs from the forwarder:
 * resolve a permission decision for the current context (prompt directly when
 * the session has UI, otherwise forward to the parent).
 */
export interface ApprovalRequester {
  requestApproval(
    ctx: ExtensionContext,
    message: string,
    options?: RequestPermissionOptions,
    forwarded?: ForwardedPromptDisplay,
  ): Promise<PermissionPromptDecision>;
}

export class PermissionForwarder implements InboxProcessor, ApprovalRequester {
  // unchanged
}
```

`requestApproval` already has exactly this signature, so the class body is unchanged — only the `implements` clause and the new interface declaration are added.

#### Prompter consumption (Tell-Don't-Ask call site)

`PermissionPrompter` depends on the seam, not the concrete forwarder:

```typescript
export interface PermissionPrompterDeps {
  getConfig(): PermissionSystemExtensionConfig; // yolo-mode check
  writeReviewLog(event: string, details: Record<string, unknown>): void;
  events: PermissionEventBus; // permissions:ui_prompt broadcast
  forwarder: ApprovalRequester; // resolve the decision (UI or forwarded)
}
```

Inside `prompt()`, the `confirmPermission(...)` call becomes a tell:

```typescript
const decision = await this.deps.forwarder.requestApproval(
  ctx,
  details.message,
  details.sessionLabel ? { sessionLabel: details.sessionLabel } : undefined,
  { source: uiPrompt.source, surface: uiPrompt.surface, value: uiPrompt.value },
);
```

The prompter no longer reaches into a bag — it tells the forwarder.
`PermissionPrompterDeps` drops from 7 fields to 4, and every remaining field is read by `prompt()` directly (passes design-review check 1: every consumer uses every field).

#### Behavioral nuance: debug logging on the prompter's forwarding path

The deleted `buildForwardingDeps()` supplied a **no-op** `writeDebugLog` and `shouldAutoApprove: () => false`.
The shared forwarder (built in `index.ts`) supplies the **real** `runtime.writeDebugLog` and the real yolo policy.

- `shouldAutoApprove` — `confirmPermission` never calls it (only `processForwardedPermissionRequests` does, on its own deps), so sharing the real policy is inert on this path.
  Decision is unchanged.
- `writeDebugLog` — `confirmPermission`'s helpers (`writeJsonFileAtomic`, `safeDeleteFile`, etc.) pass `deps.logger` through, so the subagent forwarding path will now emit real debug-level log lines instead of swallowing them.

This is the intended convergence: the #315/#316 plan deferred "trace-level forwarding debug" as an open question, and consolidating onto one forwarder resolves it.
The effect is strictly additive debug output on a path that previously logged nothing; no allow/deny/ask decision, review-log entry, or wire message changes.
Flagged in Risks below.

#### Edge cases

- Yolo-mode short-circuit stays ahead of `requestApproval`; the forwarder is never consulted when `yoloMode` is on (existing test coverage preserved).
- `sessionLabel` and the display fields (`source`/`surface`/`value`) are relayed unchanged through the new call — the four positional arguments map 1:1 to the old `confirmPermission` call.

### Module-Level Changes

- `src/forwarded-permissions/permission-forwarder.ts`
  - Add `export interface ApprovalRequester { requestApproval(...) }` next to `InboxProcessor`.
  - Add `ApprovalRequester` to the `PermissionForwarder` `implements` clause.
  - No method-body changes.
- `src/permission-prompter.ts`
  - Add `forwarder: ApprovalRequester` to `PermissionPrompterDeps`; remove `subagentSessionsDir`, `forwardingDir`, `registry`, `requestPermissionDecisionFromUi`.
  - Replace the `confirmPermission(...)` call in `prompt()` with `this.deps.forwarder.requestApproval(...)`.
  - Delete the private `buildForwardingDeps()` method.
  - Remove now-unused imports: `confirmPermission` and `PermissionForwardingDeps` from `./forwarded-permissions/polling`, `ForwardedPermissionLogger` from `./forwarded-permissions/io`, `SubagentSessionRegistry`, and `RequestPermissionOptions` if no longer referenced (lint will confirm).
  - Add the `ApprovalRequester` type import from `./forwarded-permissions/permission-forwarder`.
  - Update the `PermissionPrompterDeps` doc comment ("synthesises the PermissionForwardingDeps it needs internally" is no longer true).
- `src/index.ts`
  - Construct `forwardingDeps` + `forwarder` **before** the prompter, then pass `forwarder` into `new PermissionPrompter({ … })`.
  - Remove the four dropped fields (`subagentSessionsDir`, `forwardingDir`, `registry`, `requestPermissionDecisionFromUi`) from the prompter's deps literal — TypeScript excess-property checking rejects them once the interface narrows, so this must land in the same commit.
  - `forwardingDeps`/`forwarder` remain (still consumed by `ForwardingManager`); no second forwarder.
- `test/permission-prompter.test.ts`
  - Remove `vi.mock("../src/forwarded-permissions/polling")` and the hoisted `mockConfirmPermission`.
  - Add a hoisted `mockRequestApproval` and inject `forwarder: { requestApproval: mockRequestApproval }` via `makeDeps`.
  - Drop `subagentSessionsDir`/`forwardingDir`/`requestPermissionDecisionFromUi` from the `makeDeps` defaults.
  - Re-point every `mockConfirmPermission` assertion to `mockRequestApproval`; the argument matchers shift by one position (the deps bag argument is gone, so the matchers become `(ctx, message, options, forwarded)`).
  - Reset/seed `mockRequestApproval` in `beforeEach`.
- `packages/pi-permission-system/docs/architecture/permission-prompter.md`
  - Update the `PermissionPrompterDeps` interface block (4 fields, add `forwarder: ApprovalRequester`).
  - Replace the "Relationship to PermissionForwardingDeps" section: the prompter no longer constructs a bag; it depends on the injected `ApprovalRequester`.
  - Refresh the "Wiring" note to show the forwarder injection.
- `packages/pi-permission-system/docs/architecture/architecture.md`
  - Mark Phase 3 Step 3 (#316) `✅` with a past-tense outcome and forward reference to #317 (following the #315 status-convention precedent).
  - Update the Track-B roadmap row / Mermaid status node if it tracks per-step completion.

### Test Impact Analysis

This is a seam swap, not a new extraction, so the test surface shifts rather than expands.

1. **New tests enabled** — the prompter can now be tested against a trivially injected `{ requestApproval: vi.fn() }` with no module mock.
   This removes the `vi.mock("…/polling")` indirection and makes the prompter's collaboration with the forwarder explicit and assertable (design-review check 6: mock depth drops, no casts).
2. **Tests simplified** — all assertions migrate from `mockConfirmPermission` (module mock) to `mockRequestApproval` (injected mock); the deps-bag positional argument disappears, so matchers get simpler.
   No test is deleted — each still exercises a distinct prompter behavior (yolo short-circuit, waiting/approved/denied logging, UI-prompt emission, sessionLabel/display-field relay, forwarding path).
3. **Tests that stay as-is** — `test/permission-forwarder.test.ts` already covers `requestApproval`'s delegation to `confirmPermission` (the layer being depended upon); it is untouched.
   `test/composition-root.test.ts` exercises real wiring and should stay green without edits (verify the forwarder-before-prompter reorder does not perturb it).

### TDD Order

1. **Swap the prompter onto the injected `ApprovalRequester` seam** (`refactor:`)
   - Test surface: `test/permission-prompter.test.ts`.
   - Red: migrate the suite to inject `forwarder: { requestApproval: mockRequestApproval }`, drop the polling module mock and the four removed deps, and re-point assertions to `mockRequestApproval` with the shifted argument positions.
     The suite fails to compile/run until production changes land.
   - Green: add `ApprovalRequester` to `permission-forwarder.ts` (+ `implements`), narrow `PermissionPrompterDeps`, replace the `confirmPermission` call with `this.deps.forwarder.requestApproval`, delete `buildForwardingDeps()` and its `eslint-disable` lines and now-unused imports, and update `index.ts` to construct the forwarder before the prompter and inject it (removing the four stale fields from the deps literal).
   - This is one atomic commit: narrowing the interface and removing `buildForwardingDeps` break `index.ts` (excess properties) and the test (missing `forwarder`) at the type level simultaneously, so production, wiring, and test migration cannot be separated.
   - Suggested message: `refactor: inject forwarder into PermissionPrompter, delete buildForwardingDeps (#316)`
2. **Update architecture docs** (`docs:`)
   - Refresh `docs/architecture/permission-prompter.md` (deps interface, forwarder relationship, wiring) and mark Phase 3 Step 3 `✅` in `docs/architecture/architecture.md`.
   - Suggested message: `docs: record forwarder injection into PermissionPrompter (#316)`

Run after each step: `pnpm --filter @gotgenes/pi-permission-system run check`, `run lint`, `run test`, then `pnpm fallow dead-code` before handoff.

### Risks and Mitigations

- **Debug-log behavior change on the forwarding path** — the prompter's forwarding path gains real `writeDebugLog` output (was no-op).
  Mitigation: intended convergence (resolves the deferred debug open question); strictly additive debug-level output, no decision/log/wire change.
  Documented in Design Overview.
- **Argument-position drift in test assertions** — removing the deps-bag positional argument shifts every `toHaveBeenCalledWith` matcher by one.
  Mitigation: migrate matchers mechanically and rely on `check`/`test` to catch any stale matcher; assert the exact 4-argument shape (`ctx, message, options, forwarded`).
- **`index.ts` ordering regression** — the forwarder must exist before the prompter literal references it.
  Mitigation: reorder construction in the same commit; `composition-root.test.ts` verifies real wiring stays green.
- **Unused-import lint churn** — removing `buildForwardingDeps` orphans several imports.
  Mitigation: `run lint` (eslint auto-detects) catches and the implementer prunes them in the same commit.

### Open Questions

- Whether to keep `RequestPermissionOptions` imported in `permission-prompter.ts` depends on whether the inline `{ sessionLabel }` literal still references the type after the swap — defer to the type checker during implementation; prune if unused.
- #317 will dismantle `PermissionForwardingDeps` and inline the `polling.ts` bodies as forwarder methods; nothing in this plan should pre-empt that (keep the delegation intact).
