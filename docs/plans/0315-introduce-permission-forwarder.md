---
issue: 315
issue_title: "Introduce a PermissionForwarder collaborator that owns forwarding state"
---

# Introduce a PermissionForwarder collaborator

## Problem Statement

The forwarding subsystem is half-converted to a class-based design.
The polling *lifecycle* already has an owner (`ForwardingManager`), but the forwarding *behavior* still lives as three free functions in `src/forwarded-permissions/polling.ts` (`confirmPermission`, `waitForForwardedPermissionApproval`, `processForwardedPermissionRequests`).
Each of those functions reaches into an 8-member `PermissionForwardingDeps` bag, and that bag is assembled in two places: once in `index.ts` and again, independently and with divergent values, in `PermissionPrompter.buildForwardingDeps()`.
That is an anemic design — the forwarding state has no owner, so callers thread a bag and reach into it instead of telling an object what to do.

This issue is the first of a three-step lift-and-shift: introduce the class (this issue), fold the prompter's duplicate bag into it ([#316]), then inline the polling logic and delete the interface ([#317]).

## Goals

- Add a `PermissionForwarder` class that owns the forwarding dependency set and exposes two behavior methods: `requestApproval` and `processInbox`.
- Wire `ForwardingManager` to tell a `PermissionForwarder` (`forwarder.processInbox(ctx)` per tick) instead of threading a `PermissionForwardingDeps` bag.
- Construct exactly one forwarder instance in `index.ts` and inject it into `ForwardingManager`.
- Preserve behavior exactly — the methods delegate to the existing `polling.ts` free functions this issue (lift-and-shift, not behavior change).

## Non-Goals

- Do **not** touch `PermissionPrompter.buildForwardingDeps()` or its second `PermissionForwardingDeps` synthesis — that is [#316].
- Do **not** inline the polling-function bodies into the forwarder or delete the `PermissionForwardingDeps` interface — that is [#317].
- Do **not** change the `confirmPermission` / `processForwardedPermissionRequests` signatures; they keep accepting `PermissionForwardingDeps` so the prompter (untouched this issue) still calls them directly.
- Do **not** change the `polling.ts` module or its `permission-forwarding.test.ts` coverage — the free functions are unchanged.

## Background

Relevant modules:

- `src/forwarded-permissions/polling.ts` — declares `PermissionForwardingDeps` (8 members) and the three free functions.
  `confirmPermission(ctx, message, deps, options?, forwarded?)` returns `Promise<PermissionPromptDecision>`; it branches UI-present vs. subagent-forwarding and delegates to `waitForForwardedPermissionApproval`.
  `processForwardedPermissionRequests(ctx, deps)` returns `Promise<void>` and drains the parent's request inbox.
- `src/forwarding-manager.ts` — `ForwardingManager` owns the poll timer, current context, and processing lock.
  Today its constructor takes `(subagentSessionsDir, forwardingDeps: PermissionForwardingDeps, registry?)` and the tick calls `processForwardedPermissionRequests(this.context, this.forwardingDeps)`.
  It already exposes a narrow `ForwardingController` interface (`start`/`stop`) that `PermissionSession` depends on — the package's established convention for collaborator seams.
- `src/index.ts` — the composition root assembles the `forwardingDeps` bag literal and threads it into `new ForwardingManager(...)`.

Constraints from AGENTS.md and the loaded skills:

- ES2024 target; pnpm only.
- Import siblings via `#src/` / `#test/` path aliases, not relative paths.
- When a shared interface references a collaborator, use a **narrow interface type**, not the concrete class — so test mocks need no casts (code-design / design-review).
- Lift-and-shift sequencing: introduce-new-alongside-old, remove-old-last (architecture roadmap, Phase 3, Step 2).

## Design Overview

### The collaborator

`PermissionForwarder` is the missing owner for the forwarding dependency set.
For this lift-and-shift step it holds the existing `PermissionForwardingDeps` bag privately and delegates each method to the matching free function:

```typescript
/** Narrow seam: what ForwardingManager needs from the forwarder. */
export interface InboxProcessor {
  processInbox(ctx: ExtensionContext): Promise<void>;
}

export class PermissionForwarder implements InboxProcessor {
  constructor(private readonly deps: PermissionForwardingDeps) {}

  requestApproval(
    ctx: ExtensionContext,
    message: string,
    options?: RequestPermissionOptions,
    forwarded?: ForwardedPromptDisplay,
  ): Promise<PermissionPromptDecision> {
    return confirmPermission(ctx, message, this.deps, options, forwarded);
  }

  processInbox(ctx: ExtensionContext): Promise<void> {
    return processForwardedPermissionRequests(ctx, this.deps);
  }
}
```

Both methods `return` the delegate promise directly (no `async`/`await`), so `@typescript-eslint/require-await` does not fire.

### Decision: reuse `PermissionForwardingDeps` as the constructor parameter

The issue frames the forwarder as *owning* the individual fields (`forwardingDir`, `subagentSessionsDir`, `registry`, `events`, `logger`, `shouldAutoApprove`).
Those six plus the two the issue omits (`writeReviewLog`, `requestPermissionDecisionFromUi`) are exactly the eight members of `PermissionForwardingDeps`, and the delegated free functions still require the full bag this issue.
Defining a separate `PermissionForwarderDeps` interface now would duplicate `PermissionForwardingDeps` field-for-field with no benefit, then be deleted in [#317].
So the constructor reuses `PermissionForwardingDeps`; `shouldAutoApprove` arrives as a constructor-supplied policy (it is set once at construction, never re-assigned).
The "owns individual fields" end state is realized in [#317], when the bag interface is deleted and the polling bodies are inlined as methods reading `this`.

### The narrow seam

`ForwardingManager` only ever calls `processInbox`, so it depends on the one-method `InboxProcessor` interface, not the concrete `PermissionForwarder`.
This mirrors the existing `ForwardingController` seam the package already uses for `PermissionSession → ForwardingManager`, keeps `forwarding-manager.test.ts` free of `as unknown as` casts (it can inject a plain `{ processInbox: vi.fn() }` mock), and does not constrain [#316]/[#317].
`requestApproval` is not on the seam — it exists for [#316], when the prompter will consume it via a separate narrow `ApprovalRequester` interface.

### ForwardingManager call site

```typescript
constructor(
  private readonly subagentSessionsDir: string,
  private readonly forwarder: InboxProcessor,
  private readonly registry?: SubagentSessionRegistry,
) {}

// inside the tick:
void this.forwarder.processInbox(this.context).finally(() => {
  this.processing = false;
});
```

`subagentSessionsDir` and `registry` stay (still used for `isSubagentExecutionContext`); only the `forwardingDeps` field is replaced by `forwarder`.

### index.ts wiring

The `forwardingDeps` bag literal stays in `index.ts` this issue (it feeds the forwarder constructor); [#317] removes it.
The change is to construct the forwarder and pass it instead of the bag:

```typescript
const forwardingDeps: PermissionForwardingDeps = { /* unchanged */ };
const forwarder = new PermissionForwarder(forwardingDeps);
// ...
new ForwardingManager(runtime.subagentSessionsDir, forwarder, subagentRegistry),
```

`PermissionPrompter` construction is untouched.

### Edge cases

- Behavior is byte-for-byte unchanged: the same `ctx`, `deps`, `options`, and `forwarded` values reach the same free functions.
- `composition-root.test.ts` runs the real `index.ts` through `make-fake-pi.ts`; it constructs the real forwarder and must stay green.
- `runtime.test.ts` mocks `polling` defensively but never constructs `ForwardingManager`; no change expected (verify it still compiles).

## Module-Level Changes

- `src/forwarded-permissions/permission-forwarder.ts` (new) — `InboxProcessor` interface and `PermissionForwarder` class; imports `confirmPermission`, `processForwardedPermissionRequests`, and `PermissionForwardingDeps` from `./polling`, plus the SDK `ExtensionContext` and the `RequestPermissionOptions` / `PermissionPromptDecision` / `ForwardedPromptDisplay` types the method signatures reference.
- `src/forwarding-manager.ts` — replace the `forwardingDeps: PermissionForwardingDeps` constructor field with `forwarder: InboxProcessor`; change the tick to call `this.forwarder.processInbox(this.context)`; drop the now-unused `processForwardedPermissionRequests` / `PermissionForwardingDeps` imports and add the `InboxProcessor` import.
- `src/index.ts` — construct `const forwarder = new PermissionForwarder(forwardingDeps)` and pass `forwarder` to `new ForwardingManager(...)` in place of `forwardingDeps`; add the `PermissionForwarder` import (the `PermissionForwardingDeps` import stays — the bag literal is still built here until [#317]).
- `test/permission-forwarder.test.ts` (new) — unit tests for delegation (see Test Impact Analysis).
- `test/forwarding-manager.test.ts` — replace `makeForwardingDeps()` + the `vi.mock("../src/forwarded-permissions/polling")` setup with an injected `{ processInbox: vi.fn() }` forwarder mock; update tick assertions from `mockProcessForwardedPermissionRequests` to the mock's `processInbox`; drop the `as unknown as PermissionForwardingDeps` cast.

No architecture-doc layout/metric tables reference these specific files by path beyond the Phase 3 roadmap entry (which already names them and predicts this outcome), so no architecture-doc edit is required for this step.

## Test Impact Analysis

1. New tests the extraction enables.
   `test/permission-forwarder.test.ts` can unit-test the forwarder in isolation by mocking `./polling`: assert `requestApproval(ctx, msg, options, forwarded)` calls `confirmPermission(ctx, msg, deps, options, forwarded)` and returns its result; assert `processInbox(ctx)` calls `processForwardedPermissionRequests(ctx, deps)`.
   Previously there was no class to test — the delegation logic did not exist as a unit.
2. Tests that become simpler.
   `forwarding-manager.test.ts` currently fabricates a full `PermissionForwardingDeps` via `makeForwardingDeps()` and casts it with `as unknown as`.
   With the `InboxProcessor` seam it injects a one-method mock and asserts `processInbox` is called with the latest context — the cast and the fake bag disappear.
3. Tests that stay as-is.
   `permission-forwarding.test.ts` exercises the `polling.ts` free functions directly; those functions are unchanged, so its coverage stays exactly as-is.
   `composition-root.test.ts` keeps verifying end-to-end wiring through the real `index.ts`.

## TDD Order

1. Add the `PermissionForwarder` collaborator (red → green → commit).
   Surface: new `test/permission-forwarder.test.ts` with `vi.mock("#src/forwarded-permissions/polling", ...)` (hoisted `vi.fn()` stubs reset in `beforeEach`).
   Covers: `requestApproval` delegates to `confirmPermission` with the stored deps and forwards the return value; `processInbox` delegates to `processForwardedPermissionRequests`.
   Implement `src/forwarded-permissions/permission-forwarder.ts` to pass.
   This step is purely additive — no existing module changes, so the suite stays green.
   Commit: `refactor: add PermissionForwarder collaborator delegating to polling (#315)`.
2. Wire `ForwardingManager` and `index.ts` to the forwarder (red → green → commit).
   This is one atomic step: the constructor signature change forces the `index.ts` call site and the `forwarding-manager.test.ts` mock to update in the same commit (the type checker rejects splitting them).
   Surface: update `test/forwarding-manager.test.ts` to inject a `{ processInbox: vi.fn() }` `InboxProcessor` mock and assert `processInbox` is called per tick / with the latest context / skipped while processing; then change `src/forwarding-manager.ts` to hold `InboxProcessor` and call `forwarder.processInbox`; then update `src/index.ts` to construct and inject the forwarder.
   Run `pnpm run check` immediately after (shared-interface change) and the full `pnpm -r run test` (the wiring touches the composition-root suite).
   Commit: `refactor: wire ForwardingManager and index to PermissionForwarder (#315)`.

## Risks and Mitigations

- Risk: a behavior change sneaks in during the rewire.
  Mitigation: lift-and-shift only — the forwarder passes the identical `deps` straight through; `permission-forwarding.test.ts` and `composition-root.test.ts` (unchanged) guard the round-trip behavior.
- Risk: `forwarding-manager.test.ts` rewrite changes what is actually asserted.
  Mitigation: keep the same test scenarios (idempotent start, context update, processing-lock skip, no-UI/subagent stop) and only swap the polling-module mock for the injected `InboxProcessor` mock.
- Risk: leaving `PermissionForwarder` briefly unconsumed by production after Step 1.
  Mitigation: the test imports it immediately, and Step 2 lands the production consumer in the same PR; `fallow dead-code` (run at pre-completion) evaluates the final state, which has an `index.ts` consumer.
- Risk: a stale `processForwardedPermissionRequests` / `PermissionForwardingDeps` import lingers in `forwarding-manager.ts`.
  Mitigation: remove them in Step 2; `pnpm run lint` (no-unused) catches any miss.

## Open Questions

- None blocking.
  The `requestApproval` method is unused by production until [#316]; it is introduced now because the issue specifies the forwarder's two-method surface up front, and [#316] consumes it via a narrow `ApprovalRequester` interface.

[#316]: https://github.com/gotgenes/pi-packages/issues/316
[#317]: https://github.com/gotgenes/pi-packages/issues/317
