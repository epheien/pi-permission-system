---
issue: 317
issue_title: "Remove PermissionForwardingDeps; inline polling logic as forwarder methods"
---

# Remove `PermissionForwardingDeps`; inline polling logic as `PermissionForwarder` methods

## Problem Statement

After the first two steps of the forwarding lift-and-shift ([#315], [#316]), `ForwardingManager` and `PermissionPrompter` both go through the single `PermissionForwarder` instance, but the actual forwarding behavior still lives as free functions in `src/forwarded-permissions/polling.ts`.
The forwarder is a thin shell: `requestApproval` delegates to `confirmPermission` and `processInbox` delegates to `processForwardedPermissionRequests`, threading a privately-held `PermissionForwardingDeps` bag into each call.
Those two free functions are the package's longest non-test functions — `processForwardedPermissionRequests` (144 lines) inlines the per-request read → validate → auto-approve/prompt → respond → cleanup workflow in one loop body, and `waitForForwardedPermissionApproval` (132 lines) mixes target resolution, request construction, atomic write, and the deadline poll loop.
They are still "functions reaching into a bag" rather than methods reading owned state.
This step inlines those bodies as private `PermissionForwarder` methods reading `this`, decomposes them into focused helpers, and deletes the `PermissionForwardingDeps` interface — completing the conversion of the forwarding subsystem to a class-based design.

## Goals

- Move the bodies of `waitForForwardedPermissionApproval` and `processForwardedPermissionRequests` into `PermissionForwarder` as private methods reading `this` state.
- Decompose them into focused private methods: `processSingleForwardedRequest`, `buildForwardedRequest`, and `pollForForwardedResponse`.
- Keep `confirmPermission`'s UI-present fast path inside `requestApproval`.
- Dissolve the `PermissionForwardingDeps` bag into the forwarder's own constructor-injected fields and delete the interface once no caller threads it.
- Delete `src/forwarded-permissions/polling.ts` entirely (every export moves into the forwarder or is no longer referenced).
- Behavior-preserving: the `io` tests, the forwarder/forwarding behavior tests, and `composition-root.test.ts` (including the file-based forwarding round-trip) stay green.

## Non-Goals

- No change to the file-based forwarding protocol, request/response shapes, timeout, poll interval, or any user-visible behavior — this is a pure structural refactor.
- No change to `io.ts` (the IO helpers stay as-is and are imported by the forwarder instead of by `polling.ts`).
- No change to `permission-forwarding.ts` (constants + `resolvePermissionForwardingTargetSessionId` are a separate module and stay put).
- No change to the `ApprovalRequester` / `InboxProcessor` narrow seams or their consumers (`PermissionPrompter`, `ForwardingManager`) — their call sites are unchanged.
- Reframing `index.ts` as collaborator injection is deferred to [#320] (Phase 3 Step 7).

## Background

Relevant existing modules:

- `src/forwarded-permissions/polling.ts` (411 lines) — exports `PermissionForwardingDeps`, `getSessionId`, `formatForwardedPermissionPrompt`, `waitForForwardedPermissionApproval`, `processForwardedPermissionRequests`, `confirmPermission`, plus the module-private `getContextSystemPrompt`.
- `src/forwarded-permissions/permission-forwarder.ts` — `PermissionForwarder` class implementing `ApprovalRequester` + `InboxProcessor`; today it holds `private readonly deps: PermissionForwardingDeps` and delegates both methods to the polling free functions.
- `src/forwarded-permissions/io.ts` — pure-ish IO helpers (`ensurePermissionForwardingLocation`, `listRequestFiles`, `readForwardedPermissionRequest`, `readForwardedPermissionResponse`, `writeJsonFileAtomic`, `safeDeleteFile`, `cleanupPermissionForwardingLocationIfEmpty`, `sleep`, the `ForwardedPermissionLogger` type, and the `log*` helpers).
  Each helper already takes a `logger` parameter — the forwarder passes `this.logger`.
- `src/index.ts` — assembles the 8-field `forwardingDeps` object and constructs the single `new PermissionForwarder(forwardingDeps)`.
- `src/forwarding-manager.ts` and `src/permission-prompter.ts` — consume the forwarder only through the narrow `InboxProcessor` / `ApprovalRequester` seams; untouched by this change.

Symbol usage audit (grep of `src/` and `test/`):

- `getSessionId` — only called inside `polling.ts` itself; no external consumer.
- `formatForwardedPermissionPrompt` — only called inside `processForwardedPermissionRequests`; no external consumer, no direct test.
- `getContextSystemPrompt` — already module-private to `polling.ts`.
- `confirmPermission` / `processForwardedPermissionRequests` — consumed by the forwarder (`permission-forwarder.ts`) and exercised by `permission-forwarding.test.ts`.
- `waitForForwardedPermissionApproval` — only called by `confirmPermission`.
- `PermissionForwardingDeps` — referenced by `index.ts` (type), `permission-forwarder.ts`, `permission-forwarder.test.ts`, and a stale `vi.mock` in `runtime.test.ts`.

Constraints from AGENTS.md and skills:

- Removing an export breaks every importing module and its tests at the type level in the same commit — fold the inline, all consumer updates, and all consumer-test updates into one step (TDD-order guidance).
- The architecture doc and the package skill (`.pi/skills/package-pi-permission-system/SKILL.md`) document these internals; both reference removed symbols and need updates.
- `@typescript-eslint/require-await` is enabled for `src/` — any method that loses its only `await` must drop `async`.
  (Both public methods retain `await`, so this does not bite here.)
- Default to least privilege and deterministic decisions — preserve every guard (`ctx.hasUI`, `isSubagentExecutionContext`, target resolution, auto-approve) exactly.

## Design Overview

The forwarder gains a constructor-config interface and owns each former bag member as a private readonly field, so the inlined methods read `this.<field>` instead of `deps.<field>`.
The `PermissionForwardingDeps` interface (threaded into free functions) is replaced by `PermissionForwarderDeps` (consumed once, at the `index.ts` construction site).

Decision: dissolve the bag into individual fields rather than keeping `this.deps`.
The architecture doc's Step 2 entry states the forwarder "holds the `PermissionForwardingDeps` bag privately … a later step inlines the polling bodies as methods reading `this` and removes the bag" — "removes the bag" points to owned fields, not a renamed `this.deps`.
The lower-churn `this.deps.<field>` alternative was considered and rejected on that basis.

Constructor config (new, defined in `permission-forwarder.ts`):

```typescript
export interface PermissionForwarderDeps {
  forwardingDir: string;
  subagentSessionsDir: string;
  registry?: SubagentSessionRegistry;
  events?: PermissionEventBus;
  logger: ForwardedPermissionLogger;
  writeReviewLog: (event: string, details: Record<string, unknown>) => void;
  requestPermissionDecisionFromUi: (
    ui: ExtensionContext["ui"],
    title: string,
    message: string,
    options?: RequestPermissionOptions,
  ) => Promise<PermissionPromptDecision>;
  shouldAutoApprove: () => boolean;
}
```

This is identical in shape to today's `PermissionForwardingDeps`, so the `index.ts` object literal is unchanged — only its type annotation changes.
All 8 fields are read by the forwarder's methods (ISP holds — no unused field): `forwardingDir`/`subagentSessionsDir`/`registry` for location + subagent resolution, `events` for the forwarded UI-prompt emit, `logger`/`writeReviewLog` for logging, `requestPermissionDecisionFromUi` for both the direct fast path and the parent prompt, `shouldAutoApprove` for the auto-approve branch.

Method surface after the change:

```typescript
class PermissionForwarder implements ApprovalRequester, InboxProcessor {
  // public seam methods
  requestApproval(ctx, message, options?, forwarded?): Promise<PermissionPromptDecision>;
  processInbox(ctx): Promise<void>;

  // private (inlined from polling.ts)
  private waitForForwardedApproval(ctx, message, forwarded?): Promise<PermissionPromptDecision>;
  private buildForwardedRequest(ctx, message, requesterSessionId, targetSessionId, forwarded?): ForwardedPermissionRequest;
  private pollForForwardedResponse(location, request, requestPath, responsePath): Promise<PermissionPromptDecision>;
  private processSingleForwardedRequest(ctx, request, location, requestPath): Promise<void>;
}
```

Decomposition rationale (each piece clears the "returns a value, owns state, or gives behavior to data" bar — not procedure-splitting):

- `buildForwardedRequest` returns a `ForwardedPermissionRequest` value object (request id, resolved agent name via `getActiveAgentName`/system-prompt fallback, and the optional `source`/`surface`/`value` display fields).
- `pollForForwardedResponse` returns a `PermissionPromptDecision` — it owns the deadline loop, the response read, the success/timeout review-log entries, and the request/response file cleanup.
- `processSingleForwardedRequest` owns the per-request workflow (validate target → auto-approve or prompt-via-UI → write response → delete request file), reading `this.shouldAutoApprove`, `this.events`, `this.requestPermissionDecisionFromUi`, `this.logger`, `this.writeReviewLog`.

`requestApproval` keeps the `confirmPermission` control flow verbatim:

```typescript
requestApproval(ctx, message, options?, forwarded?) {
  if (ctx.hasUI) {
    return this.requestPermissionDecisionFromUi(ctx.ui, "Permission Required", message, options);
  }
  if (!isSubagentExecutionContext(ctx, this.subagentSessionsDir, this.registry)) {
    return Promise.resolve({ approved: false, state: "denied" });
  }
  return this.waitForForwardedApproval(ctx, message, forwarded);
}
```

(`options` is consumed only on the UI fast path, exactly as `confirmPermission` did — `waitForForwardedApproval` does not receive it.)

`getSessionId`, `getContextSystemPrompt`, and `formatForwardedPermissionPrompt` are pure over `ctx`/`request` (they do not read `this`), so they move to `permission-forwarder.ts` as module-private functions, not methods.

Upstream-interaction sketch (extracted code vs. its `io.ts` dependencies):

```typescript
// inside pollForForwardedResponse — reads this state, tells io helpers
const response = readForwardedPermissionResponse(this.logger, responsePath);
this.writeReviewLog("forwarded_permission.response_received", { /* … */ });
safeDeleteFile(this.logger, responsePath, "forwarded permission response");
cleanupPermissionForwardingLocationIfEmpty(this.logger, location);
```

The io helpers already accept an explicit `logger` argument, so no upstream API gap exists — the inlined methods tell the helpers with `this.logger`; there is no Tell-Don't-Ask violation, no output-argument mutation, and no reverse-search pattern carried over from the free functions.

Edge cases preserved (behavior-preserving):

- Unresolvable target session → error log naming the env candidates, return `denied`.
- Location directories not preparable → error log, return `denied`.
- Request-file write failure → error log, return `denied`.
- Timeout → warning + `response_timed_out` review log, delete request, cleanup, return `denied`.
- `processInbox` no-ops when `!ctx.hasUI`, when no location exists, or when the inbox is empty.
- Per-request: invalid/unreadable request → delete and continue; mismatched `targetSessionId` → warn, delete, continue; auto-approve path emits no UI prompt event; response-write failure → error log, `continue` (request file retained for retry, matching current behavior).

## Module-Level Changes

- `src/forwarded-permissions/permission-forwarder.ts` — add `PermissionForwarderDeps`; change the constructor to accept it and store its members as individual `private readonly` fields; add the four private methods plus the three module-private helpers (`getSessionId`, `getContextSystemPrompt`, `formatForwardedPermissionPrompt`); add the imports previously in `polling.ts` (`existsSync`, `join`, `getActiveAgentName`, `getActiveAgentNameFromSystemPrompt`, `toRecord`, `emitUiPromptEvent`/`PermissionEventBus`, the `permission-forwarding` constants + types + `isForwardedPermissionRequestForSession` + `resolvePermissionForwardingTargetSessionId` + `SUBAGENT_PARENT_SESSION_ENV_CANDIDATES`, `buildForwardedUiPrompt`, `isSubagentExecutionContext`, `SubagentSessionRegistry` type, the `io.ts` helpers + `ForwardedPermissionLogger`); drop the `./polling` import; keep the `ApprovalRequester` and `InboxProcessor` seams unchanged.
- `src/forwarded-permissions/polling.ts` — deleted.
- `src/index.ts` — replace `import type { PermissionForwardingDeps } from "./forwarded-permissions/polling"` with `import type { PermissionForwarderDeps } from "./forwarded-permissions/permission-forwarder"` (alongside the existing `PermissionForwarder` value import); retype the `forwardingDeps` literal to `PermissionForwarderDeps` (literal body unchanged).
- `test/permission-forwarder.test.ts` — rewrite: drop the `vi.mock("#src/forwarded-permissions/polling", …)` delegation harness (no free functions left to delegate to); test real behavior by constructing `new PermissionForwarder({ … vi.fn() stubs … })` and asserting `requestApproval`/`processInbox` outcomes (absorbs the migrated behavior cases below).
- `test/permission-forwarding.test.ts` — remove the `describe("processForwardedPermissionRequests")` and `describe("confirmPermission")` blocks and the `confirmPermission`/`processForwardedPermissionRequests` import from `#src/forwarded-permissions/polling`; keep the `SUBAGENT_PARENT_SESSION_ENV_CANDIDATES` and `resolvePermissionForwardingTargetSessionId` blocks (they test `permission-forwarding.ts`, not the forwarder).
- `test/runtime.test.ts` — remove the stale `vi.mock("../src/forwarded-permissions/polling", …)` (runtime.ts does not import polling; the path is about to be deleted, so the mock must go to keep module resolution valid).
- `docs/architecture/architecture.md` — mark Phase 3 Step 4 ([#317]) ✅ done with an outcome note (matching the Step 2/3 entries); the Phase 3 finding table (item 1) is historical and stays as the record of the original state.
- `docs/architecture/permission-prompter.md` — update the stale "It never constructs a `PermissionForwardingDeps` bag internally" sentence (the interface no longer exists) to reference the forwarder's owned dependencies.
- `.pi/skills/package-pi-permission-system/SKILL.md` — update the testing note that names `confirmPermission` ("`confirmPermission` polls for a response with a 10-minute timeout") to reference the forwarder's forwarded path (e.g. `PermissionForwarder.requestApproval`).

Historical plan docs under `docs/plans/` (e.g. `0292-*`, `0296-*`) and `docs/plans/archive/*` record point-in-time states and are not rewritten.

## Test Impact Analysis

1. New tests enabled by the inline:
   - The forwarding behavior is now reachable through the public `PermissionForwarder` API with a plain stub config object, so `permission-forwarder.test.ts` can assert real outcomes (auto-approve emits no UI prompt; rich display fields produce a non-degraded `permissions:ui_prompt`; UI fast path calls `requestPermissionDecisionFromUi` without emitting; no-UI/non-subagent returns `denied`) instead of asserting delegation to mocked free functions.
   - These cases are migrated almost verbatim from the `processForwardedPermissionRequests`/`confirmPermission` blocks in `permission-forwarding.test.ts` — the only harness change is constructing a `PermissionForwarder` with the 8-field config instead of calling a free function with the same-shaped bag.
2. Tests that become redundant:
   - The current `permission-forwarder.test.ts` delegation tests (assert `confirmPermission`/`processForwardedPermissionRequests` were called with the stored deps) describe an implementation that ceases to exist — they are removed, replaced by the behavior tests above.
3. Tests that must stay as-is:
   - `test/composition-root.test.ts` "subagent registry sharing" round-trip exercises the real wiring end-to-end and must stay green unchanged — it is the integration safety net for behavior preservation.
   - `test/forwarded-permissions/io.test.ts` tests `io.ts` directly and is untouched.
   - `test/forwarding-manager.test.ts` (mocks `{ processInbox }`) and `test/permission-prompter.test.ts` (mocks `{ requestApproval }`) depend only on the narrow seams and are untouched.
   - The `resolvePermissionForwardingTargetSessionId` / env-candidate blocks in `permission-forwarding.test.ts` stay (they test a different module).

## TDD Order

This is a behavior-preserving refactor; the existing forwarding/round-trip tests are the safety net, and the type-level coupling (deleting `polling.ts` breaks all importers at once) forces the production change, all consumer updates, and all consumer-test updates into a single commit.

1. refactor — inline the polling logic and delete the bag (one commit; `pnpm run check && pnpm run lint && pnpm run test` must pass before committing):
   - In `permission-forwarder.ts`: add `PermissionForwarderDeps`, store members as private readonly fields, inline the two public method bodies + the three private helpers (`waitForForwardedApproval`, `buildForwardedRequest`, `pollForForwardedResponse`, `processSingleForwardedRequest`) and the three module-private functions, and add the absorbed imports; drop the `./polling` import.
   - Delete `src/forwarded-permissions/polling.ts`.
   - Update `index.ts` (import + type annotation only).
   - Rewrite `test/permission-forwarder.test.ts` to test real behavior; migrate the `processForwardedPermissionRequests`/`confirmPermission` cases into it.
   - Prune the migrated blocks + the polling import from `test/permission-forwarding.test.ts`.
   - Remove the stale polling `vi.mock` from `test/runtime.test.ts`.
   - Verify dead-code cleanliness (`pnpm fallow dead-code`) — `getSessionId`/`formatForwardedPermissionPrompt` are now module-private, so no orphaned exports remain.
   - Commit: `refactor: inline forwarding polling logic as PermissionForwarder methods (#317)`.
2. docs — record the completed step (one commit; no compile impact, so it stands alone):
   - Mark Phase 3 Step 4 ([#317]) ✅ done in `docs/architecture/architecture.md` with an outcome note.
   - Fix the stale `PermissionForwardingDeps` reference in `docs/architecture/permission-prompter.md`.
   - Update the `confirmPermission` testing note in `.pi/skills/package-pi-permission-system/SKILL.md`.
   - Commit: `docs: mark Phase 3 Step 4 (remove PermissionForwardingDeps) done (#317)`.

## Risks and Mitigations

- Risk: a guard, log event name, or error message is dropped or reworded during the move, silently changing forwarding behavior.
  Mitigation: copy bodies verbatim and rename only `deps.<field>` → `this.<field>`; the `composition-root.test.ts` round-trip and the migrated behavior tests assert the externally observable effects (request shape, response, UI-prompt emit, auto-approve suppression).
- Risk: deleting `polling.ts` leaves a dangling `vi.mock` path in `runtime.test.ts`, breaking module resolution.
  Mitigation: remove that mock in the same commit; `runtime.ts` has no polling import, so the mock is provably unused.
- Risk: an inlined method loses its only `await` and trips `@typescript-eslint/require-await`.
  Mitigation: both public methods and `pollForForwardedResponse`/`processSingleForwardedRequest` retain real `await`s; `buildForwardedRequest` is synchronous by design (returns a value).
  Run `pnpm run lint` before committing.
- Risk: storing function-typed fields (`shouldAutoApprove`, `writeReviewLog`, `requestPermissionDecisionFromUi`) reintroduces an unbound-method lint hit.
  Mitigation: they are plain function values already bound/arrow-wrapped at the `index.ts` construction site; assigning them to readonly fields and calling `this.fn(…)` does not rebind `this` and does not trigger `unbound-method` (no method reference is passed around).

## Open Questions

- None blocking.
  The constructor-config-vs-`this.deps` choice is resolved in favor of individual fields (see Design Overview); the test-home choice (behavior tests live in `permission-forwarder.test.ts`) follows from the module under test.

[#315]: https://github.com/gotgenes/pi-packages/issues/315

[#316]: https://github.com/gotgenes/pi-packages/issues/316

[#320]: https://github.com/gotgenes/pi-packages/issues/320
