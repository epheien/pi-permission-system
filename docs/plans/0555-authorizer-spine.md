---
issue: 555
issue_title: "pi-permission-system: introduce the Authorizer spine — interface, three implementations, once-per-session selection"
---

# Introduce the Authorizer spine

Phase 9 Step 1: give the live-authority path (what happens on `ask`) a single owner — the `Authorizer` interface, its three implementations, and a once-per-activation selection — replacing the three-way `hasUI`/`isSubagent`/deny dispatch that is currently smeared across `PromptingGateway`, `PermissionPrompter`, and `ApprovalEscalator`.

## Release Recommendation

**Release:** ship independently

This is Step 1 of Phase 9's five-step roadmap, tagged `Release: independent` there.
It is a behavior-neutral refactor (`refactor:` — a `hidden` changelog type), so it cuts no release on its own and auto-batches into the next `feat:`/`fix:`/unhidden-`docs:` release.
Phase 9 has no multi-step release batch — every step leaves the package consistent on its own, and the two `feat:` steps ([#557], [#558]) each cut their own release when they land.
No coordination is required at ship time.

## Problem Statement

The deontic question "who may decide this `ask`, and how do we reach them" has no single owner.
It is answered by an accretion of collaborators, each re-deriving the same two context predicates:

- `GateRunner` asks `GatePrompter.canConfirm()`.
- `PromptingGateway.canConfirm()` computes `hasUI || isSubagent(ctx)`.
- `PermissionPrompter.prompt(ctx, details)` reads `ctx.hasUI` again to decide whether to emit the UI-prompt event.
- `ApprovalEscalator.requestApproval(ctx, …)` re-branches on the same predicates a third time: `hasUI` → direct dialog, `!isSubagent` → deny, else → forward.

The result is a relay chain of four role interfaces (`GatePrompter`, `PermissionPrompterApi`, `ApprovalRequester`, plus the gateway lifecycle) to reach one dialog, with `hasUI`/`isSubagent` evaluated 3+ times per prompt and "no authority reachable" represented twice.
The architecture doc's [authority model](../architecture/architecture.md#the-authority-model) names the missing concept: authority, held by an **`Authorizer`** selected once per session.
Phase 8 tidied the ground for exactly this change (yolo into the ruleset, the escalator/server split, the single `SubagentDetection` collaborator).

## Goals

- Introduce `Authorizer` (`authorize(details): Promise<PermissionPromptDecision>`) as the single live-authority role, with three implementations: `LocalUserAuthorizer`, `ParentAuthorizer`, `DenyingAuthorizer`.
- Concentrate the three-way `hasUI`/`isSubagent`/deny dispatch into one pure function, `selectAuthorizer`, evaluated once per session activation.
- Route the ask path through the selected `Authorizer`: `PermissionPrompter` keeps its review-log bracketing but delegates to the selected authorizer and drops per-call `ctx` threading.
- Land the elicitation modules in their `authority/` home as they are rewritten (`authorizer-selection.ts`, `permission-prompter.ts`, the three authorizer files), so [#559] moves only the mechanical remainder.
- Behavior-neutral: existing review-log, decision-event, UI-prompt-event, and forwarding round-trip tests pass unchanged.

## Non-Goals

- Dissolving `canConfirm()` — the `GatePrompter.canConfirm()` surface **survives** this step (answered by the selection) and is dissolved in [#556] (Phase 9 Step 2), which deletes `gate-prompter.ts` and drops the pre-check.
- Rebuilding the serving side (`ForwardedRequestServer.processInbox`) onto `evaluate()` + the serving `Authorizer` — that is [#557] (Step 3); this step leaves `forwarded-request-server.ts` untouched.
- Grant-scope selection on forwarded approvals — [#558] (Step 4).
- Moving the remaining flat modules (`permission-dialog.ts`, `permission-forwarding.ts`, `subagent-registry.ts`, `subagent-lifecycle-events.ts`, `forwarding-manager.ts`) into `authority/` — [#559] (Step 5).
- The `ModelTriageAuthorizer` decorator — deferred to a later phase with its own decision record; the `Authorizer` interface introduced here is its extension point.

## Background

Relevant existing modules (all under `packages/pi-permission-system/src/`):

- `prompting-gateway.ts` — `PromptingGateway implements GatePrompter, PromptingGatewayLifecycle`.
  Stores `ExtensionContext` at `activate`, computes `canConfirm()` from `hasUI || detection.isSubagent(ctx)`, and delegates `prompt(details)` to the injected `PermissionPrompter`.
- `permission-prompter.ts` — `PermissionPrompter implements PermissionPrompterApi`.
  Brackets the flow with review-log `waiting`/`approved`/`denied` entries, builds the UI-prompt event via `buildDirectUiPrompt(details)`, emits it on `permissions:ui_prompt` **only when `ctx.hasUI`**, then calls `forwarder.requestApproval(ctx, message, options, forwarded)`.
  Owns the `PromptPermissionDetails` type.
- `authority/approval-escalator.ts` — `ApprovalEscalator implements ApprovalRequester`.
  `requestApproval(ctx, …)` is the three-way dispatch: `ctx.hasUI` → `requestPermissionDecisionFromUi(ctx.ui, …)`; `!detection.isSubagent(ctx)` → `{ approved: false, state: "denied" }`; else → `waitForForwardedApproval` (build request file, poll for the parent's response).
- `gate-prompter.ts` — the `GatePrompter` interface (`canConfirm()` + `prompt(details)`) that `GateRunner` depends on.
- `authority/subagent-detection.ts` — `SubagentDetection implements SubagentDetector` (`isSubagent(ctx)`); the selection predicate ([#529]).
- `permission-dialog.ts` — `PermissionPromptDecision` type, `requestPermissionDecisionFromUi`, `RequestPermissionOptions`.
- `permission-ui-prompt.ts` — `buildDirectUiPrompt(details)`, source/surface/value derivation.
- `permission-events.ts` — `emitUiPromptEvent`, `PermissionEventBus`.

Wiring (`index.ts`): `escalator = new ApprovalEscalator({ forwardingDir, detection, registry, logger, requestPermissionDecisionFromUi })` → `prompter = new PermissionPrompter({ logger, events, forwarder: escalator })` → `gateway = new PromptingGateway({ detection, prompter })`.
The `gateway` is passed to `PermissionSession` (as `PromptingGatewayLifecycle`) and to `GateRunner` (as `GatePrompter`).
`PermissionSession.activate(ctx)` forwards to `gateway.activate(ctx)`; `activate` runs on **every tool call** (`permission-gate-handler.ts`), not only at `session_start`.

AGENTS.md / skill constraints that apply:

- `docs/architecture/architecture.md` inline-copies module descriptions in a module-structure tree — any move/rename/add must update that tree in the same doc-update commit.
- A dead export or unused module fails `pnpm fallow dead-code` (CI-gated) — new modules must be wired in the same commit that introduces them.
- Import sibling modules via the `#src/` / `#test/` aliases, never relative paths.
- The `session-created` and forwarding constraints ([#296], [#302]) are unaffected — this refactor does not touch registration timing or the process-global registry.

## Design Overview

### The `Authorizer` interface

```typescript
// src/authority/authorizer.ts
import type { PromptPermissionDetails } from "#src/authority/permission-prompter";
import type { PermissionPromptDecision } from "#src/permission-dialog";

/** The live-authority role: rule on a single ask, told the decision. */
export interface Authorizer {
  authorize(details: PromptPermissionDetails): Promise<PermissionPromptDecision>;
}
```

One method, one responsibility (ISP-clean).
The `PromptPermissionDetails` command object is the request descriptor already threaded today; `DenyingAuthorizer` ignores it, `LocalUserAuthorizer` reads `message`/`sessionLabel` and derives the UI event from it, `ParentAuthorizer` reads `message` and derives the forwarded display from it.

### The three implementations

```typescript
// src/authority/local-user-authorizer.ts
export class LocalUserAuthorizer implements Authorizer {
  constructor(private readonly deps: {
    ui: PermissionDecisionUi;
    events: PermissionEventBus;
    requestPermissionDecisionFromUi: typeof requestPermissionDecisionFromUi;
  }) {}

  authorize(details: PromptPermissionDetails): Promise<PermissionPromptDecision> {
    const uiPrompt = buildDirectUiPrompt(details);
    emitUiPromptEvent(this.deps.events, uiPrompt); // moved here from PermissionPrompter's ctx.hasUI arm
    return this.deps.requestPermissionDecisionFromUi(
      this.deps.ui,
      "Permission Required",
      details.message,
      details.sessionLabel ? { sessionLabel: details.sessionLabel } : undefined,
    );
  }
}
```

```typescript
// src/authority/denying-authorizer.ts
export class DenyingAuthorizer implements Authorizer {
  authorize(): Promise<PermissionPromptDecision> {
    return Promise.resolve({ approved: false, state: "denied" });
  }
}
```

`ParentAuthorizer` owns the forwarding machinery currently in `ApprovalEscalator`, with `ctx` bound at construction (dropping the per-call `ctx` param).
Its `authorize(details)` builds the forwarded display via `buildDirectUiPrompt(details)` and runs the existing request-write/poll flow.

`selectAuthorizer` is the pure dispatch, evaluated once per activation:

```typescript
// src/authority/authorizer.ts
export interface AuthorizerSelectionDeps {
  detection: SubagentDetector;
  events: PermissionEventBus;
  requestPermissionDecisionFromUi: typeof requestPermissionDecisionFromUi;
  forwardingDir: string;
  registry?: SubagentSessionRegistry;
  logger: DebugReviewLogger;
}

export function selectAuthorizer(
  ctx: ExtensionContext,
  deps: AuthorizerSelectionDeps,
): Authorizer {
  if (ctx.hasUI) {
    return new LocalUserAuthorizer({
      ui: ctx.ui,
      events: deps.events,
      requestPermissionDecisionFromUi: deps.requestPermissionDecisionFromUi,
    });
  }
  if (deps.detection.isSubagent(ctx)) {
    return new ParentAuthorizer(ctx, {
      forwardingDir: deps.forwardingDir,
      detection: deps.detection,
      registry: deps.registry,
      logger: deps.logger,
    });
  }
  return new DenyingAuthorizer();
}
```

Note: the issue/roadmap write the shorthand `selectAuthorizer(ctx, detection)`.
The real signature is `selectAuthorizer(ctx, deps)` — the leaf authorizers need construction inputs (`events`, `requestPermissionDecisionFromUi`, `forwardingDir`, `registry`, `logger`) beyond `detection`.
`AuthorizerSelectionDeps` is the same composition-root wiring set `ApprovalEscalator` + `PermissionPrompter` already receive today, relocated onto one bag — not a new dependency, and not a widening (the escalator sheds `requestPermissionDecisionFromUi`, which moves to `LocalUserAuthorizer`).

### The selection owner (rewrite of `PromptingGateway`)

```typescript
// src/authority/authorizer-selection.ts
export interface AuthorizerSelectionLifecycle {
  activate(ctx: ExtensionContext): void;
  deactivate(): void;
}

export class AuthorizerSelection
  implements GatePrompter, AuthorizerSelectionLifecycle
{
  private selected: Authorizer | null = null;
  private confirmable = false;

  constructor(private readonly deps: AuthorizerSelectionDeps & {
    prompter: PermissionPrompter;
  }) {}

  activate(ctx: ExtensionContext): void {
    this.selected = selectAuthorizer(ctx, this.deps);
    // Transitional: canConfirm survives Step 1 (dissolved in #556). Recomputing
    // the predicate here duplicates selectAuthorizer's branch, but keeps the
    // ask-path byte-identical until #556 derives it from a DenyingAuthorizer marker.
    this.confirmable = ctx.hasUI || this.deps.detection.isSubagent(ctx);
  }

  deactivate(): void {
    this.selected = null;
    this.confirmable = false;
  }

  canConfirm(): boolean {
    return this.selected !== null && this.confirmable;
  }

  prompt(details: PromptPermissionDetails): Promise<PermissionPromptDecision> {
    if (this.selected === null) {
      return Promise.reject(
        new Error("prompt called before the session was activated"),
      );
    }
    return this.deps.prompter.prompt(this.selected, details);
  }
}
```

### The bracketing prompter (moved, signature changed)

`PermissionPrompter` moves to `src/authority/permission-prompter.ts` and drops per-call `ctx`:

```typescript
export class PermissionPrompter {
  constructor(private readonly deps: { logger: ReviewLogger }) {}

  async prompt(
    authorizer: Authorizer,
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> {
    this.writeReviewEntry("permission_request.waiting", details);
    const decision = await authorizer.authorize(details);
    this.writeReviewEntry(
      decision.approved
        ? "permission_request.approved"
        : "permission_request.denied",
      { ...details, resolution: decision.state, denialReason: decision.denialReason },
    );
    return decision;
  }
  // writeReviewEntry unchanged
}
```

The prompter sheds its `events` and `forwarder` deps (both concerns move into `LocalUserAuthorizer` / `ParentAuthorizer`); only the review logger remains.
`PromptPermissionDetails` moves with this file; `PermissionPrompterApi` and `ApprovalRequester` are removed (no consumer after the rewire).

### Behavior-neutrality trace

The ask path is byte-identical across every branch:

- **UI present** — prompter writes `waiting`; `LocalUserAuthorizer.authorize` emits the UI-prompt event (only here, matching today's `ctx.hasUI` guard) then shows the dialog; prompter writes `approved`/`denied`.
  Event-before-dialog order preserved.
- **Subagent** — prompter writes `waiting`; `ParentAuthorizer.authorize` forwards and polls (no UI event, matching today); prompter writes the outcome.
- **No authority** — prompter writes `waiting`; `DenyingAuthorizer.authorize` denies (no UI event, matching the current `!isSubagent` arm); prompter writes `denied`.
- **yolo** — unchanged: the composition-stage `ask→allow` rewrite ([#526]) means an `ask` never reaches this path, and the runner's yolo fast-path (`check.origin === "yolo"`) is upstream of the prompter.
  Untouched.
- **`canConfirm()`** — same value (`hasUI || isSubagent`, false before activation), consumed by the runner exactly as today.

### Consumer call-site sketch (Law of Demeter)

`GateRunner` is unchanged — it still holds a `GatePrompter` and calls `canConfirm()` / `prompt(details)`.
The selection owner captures `ctx.ui` into `LocalUserAuthorizer` at selection time rather than reaching `ctx.ui` per prompt, and binds `ctx` into `ParentAuthorizer` once — removing the per-call `ctx` relay through the prompter → forwarder chain (a net reduction in parameter relay, not an addition).

## Module-Level Changes

New files under `src/authority/`:

- `authorizer.ts` — `Authorizer` interface, `AuthorizerSelectionDeps`, `selectAuthorizer(ctx, deps)`.
- `local-user-authorizer.ts` — `LocalUserAuthorizer` (owns `ui` + `events` + `requestPermissionDecisionFromUi`; emits the UI-prompt event).
- `denying-authorizer.ts` — `DenyingAuthorizer` (least-privilege deny).
- `authorizer-selection.ts` — `AuthorizerSelection` (`implements GatePrompter`, `AuthorizerSelectionLifecycle`); the rewrite of `prompting-gateway.ts`.
- `permission-prompter.ts` — moved from `src/permission-prompter.ts`; `PermissionPrompter.prompt(authorizer, details)`; owns `PromptPermissionDetails` and `PermissionReviewSource`.

Changed files:

- `src/authority/approval-escalator.ts` — becomes the `ParentAuthorizer`: sheds the `ctx.hasUI` and `!isSubagent` arms and the `ApprovalRequester` seam; `requestApproval(ctx, …)` becomes `authorize(details)` with `ctx` bound at construction; keeps the forwarding request-write/poll machinery.
- `src/index.ts` — rewire: build `AuthorizerSelectionDeps`, construct `PermissionPrompter({ logger })`, construct `AuthorizerSelection`, pass it to `PermissionSession` and `GateRunner` (replacing the `escalator`/`prompter`/`gateway` trio).
- `src/permission-session.ts` — import `AuthorizerSelectionLifecycle` from `#src/authority/authorizer-selection` (was `PromptingGatewayLifecycle` from `#src/prompting-gateway`); constructor param type and the doc comment update; no logic change.
- `src/handlers/gates/descriptor.ts` — `PromptPermissionDetails` import path → `#src/authority/permission-prompter`.
- `src/session-logger.ts` — doc-comment references (`Injected into PermissionPrompter …`, `Injected into ConfigStore, ApprovalEscalator …`) updated to name the new owners.

Removed files:

- `src/prompting-gateway.ts` — replaced by `authority/authorizer-selection.ts`.
- `src/permission-prompter.ts` — moved to `authority/permission-prompter.ts`.

Test files:

- New: `test/authority/authorizer.test.ts` (`selectAuthorizer` 3-way dispatch), `test/authority/local-user-authorizer.test.ts`, `test/authority/denying-authorizer.test.ts`.
- Moved/rewritten: `test/prompting-gateway.test.ts` → `test/authority/authorizer-selection.test.ts`; `test/permission-prompter.test.ts` → `test/authority/permission-prompter.test.ts` (pass a fake `Authorizer` instead of `ctx`; drop the UI-event-emission assertions, which move to `local-user-authorizer.test.ts`).
- Updated: `test/authority/approval-escalator.test.ts` — delete the "UI fast path" and "non-UI, non-subagent" tests (behavior moved to the leaf-authorizer tests); retarget the forwarding tests to `ParentAuthorizer.authorize`.
- Fixtures: `test/helpers/session-fixtures.ts` (`makeGateway` → returns an `AuthorizerSelectionLifecycle`); `test/helpers/forwarding-fixtures.ts` (`makeEscalatorDeps` drops `requestPermissionDecisionFromUi`, builds `ParentAuthorizer` inputs).
  `test/helpers/gate-fixtures.ts`, `handler-fixtures.ts`, `external-directory-fixtures.ts` are **unchanged** — they mock the surviving `GatePrompter` interface (`{ canConfirm, prompt }`), which is stable this step.

Doc updates (in the implementation doc-update commit):

- `docs/architecture/architecture.md` — module-structure tree: relocate `permission-prompter.ts` and `prompting-gateway.ts` entries into the `authority/` block, rewrite the `approval-escalator.ts` entry as `ParentAuthorizer`, add the four new `authority/` entries; update the `authority/` block header; update the `Target: the authority model` note (line ~497: "the `Authorizer` interface itself is still Phase 9" → the interface now exists as of Step 1); mark **Phase 9 Step 1 complete** (✅ on the step heading **and** the `S1` Mermaid node).
  Leave the phase-exit metrics table unchanged — `canConfirm` occurrences and the role-interface count are Phase-9-exit targets not met until [#556].
- `docs/architecture/permission-prompter.md` — update the `PermissionPrompter` responsibility/interface sections: the UI-event branch and the UI/forwarding dispatch move to the authorizers; `prompt(ctx, details)` → `prompt(authorizer, details)`; the `ApprovalRequester` seam is gone.
- `.pi/skills/package-pi-permission-system/SKILL.md` — the forwarding round-trip testing note (`ApprovalEscalator.requestApproval polls …`) → `ParentAuthorizer.authorize`.

`docs/plans/` and `docs/retro/` files that name these symbols are historical per-issue records and are **not** updated.

## Test Impact Analysis

1. **New tests the extraction enables** — each live-authority channel becomes independently testable:
   - `selectAuthorizer` — the 3-way dispatch given `(hasUI, isSubagent)`, previously only reachable through `ApprovalEscalator.requestApproval` + the prompter.
   - `LocalUserAuthorizer` — UI-event emission + dialog call in isolation (was entangled across `PermissionPrompter` and the escalator's `hasUI` arm).
   - `DenyingAuthorizer` — the least-privilege deny as its own unit (was the escalator's `!isSubagent` arm).
2. **Redundant tests to remove/simplify** — `approval-escalator.test.ts`'s "UI fast path" and "non-UI, non-subagent" tests become redundant (behavior owned by the leaf authorizers); delete them.
   `permission-prompter.test.ts`'s UI-event-emission assertions move to `local-user-authorizer.test.ts`; the prompter tests simplify to bracketing (`waiting` → `approved`/`denied` around a fake `Authorizer`).
3. **Tests that must stay** — the forwarding round-trip tests (`permission-forwarding.test.ts`, `composition-root.test.ts`'s "subagent registry sharing") genuinely exercise the forwarding transport; keep them, retargeting only where they construct the escalator directly.
   `permission-ui-prompt.test.ts` (event-shape contract, [#292]) stays as-is.

## Invariants at risk

This surface was refactored by Phase 8 ([#526] yolo-into-ruleset, [#529] `SubagentDetection`, [#530] escalator/server split).
Step 1 must not regress their documented outcomes:

- **Review-log parity** — `waiting` → `approved`/`denied` bracketing, and the yolo single `auto_approved` entry ([#526]).
  Pinned by `test/authority/permission-prompter.test.ts` and `test/handlers/gates/runner.test.ts` (yolo fast-path is in the runner, upstream of the ask path — untouched).
- **UI-prompt-event contract** — event emitted only when `hasUI`, forwarded path carries the display fields ([#292]).
  Pinned by `permission-ui-prompt.test.ts` and the new `local-user-authorizer.test.ts`; add an assertion in the latter that `DenyingAuthorizer`/`ParentAuthorizer` do **not** emit.
- **Forwarding transport** — request-write/poll, target resolution, timeout ([#530], [#398]).
  Pinned by `permission-forwarding.test.ts`, `forwarded-request-server.test.ts` (serving side, untouched here), and the composition-root round-trip.
- **`canConfirm()` value** — `hasUI || isSubagent`, false before activation.
  Pinned by the migrated `authorizer-selection.test.ts`.

## TDD Order

The blast radius is contained: the `GatePrompter` interface survives Step 1, so `GateRunner` and its fixtures (`gate-fixtures`, `handler-fixtures`, `external-directory-fixtures`) are untouched.
Two implementation steps, using a short-lived transitional wrapper so each commit stays green and reviewable, then a docs step.

1. **Introduce the `Authorizer` spine and route the ask path through it.**
   Test surface: new `test/authority/authorizer.test.ts` (`selectAuthorizer` dispatch), `local-user-authorizer.test.ts`, `denying-authorizer.test.ts`; migrated `authorizer-selection.test.ts` and `authority/permission-prompter.test.ts`.
   Covers: the three-way selection, each authorizer's behavior in isolation, the prompter's bracketing around a fake `Authorizer`, and `canConfirm()` parity.
   Implementation: add `authorizer.ts` + `local-user-authorizer.ts` + `denying-authorizer.ts`; add a `ParentAuthorizer` in `approval-escalator.ts` that **wraps** the existing `ApprovalEscalator` instance (ctx bound at construction; `authorize(details)` builds the forwarded display and calls `escalator.requestApproval(ctx, details.message, undefined, forwarded)`) — the escalator class and its `requestApproval`/`ApprovalRequester` seam stay intact this step; rewrite `prompting-gateway.ts` → `authority/authorizer-selection.ts`; move `permission-prompter.ts` → `authority/permission-prompter.ts` with the new signature; rewire `index.ts`; update `permission-session.ts`, `handlers/gates/descriptor.ts`, `session-logger.ts` imports; migrate the two test files and update `session-fixtures.makeGateway`.
   This is the atomic type-break commit (removing `PromptingGateway`, changing `PermissionPrompter.prompt`'s signature, and dropping `PermissionPrompterApi` break every consumer at once); all new modules are wired, so no dead-code failure.
   Run `pnpm run check` immediately after (shared-interface change).
   Commit: `refactor(pi-permission-system): route the ask path through the Authorizer spine`.

2. **Collapse `ApprovalEscalator` into `ParentAuthorizer`; remove the dead dispatch arms.**
   Test surface: `test/authority/approval-escalator.test.ts` (retargeted to `ParentAuthorizer.authorize`), `forwarding-fixtures.ts`.
   Covers: forwarding via `ParentAuthorizer.authorize`; the removed UI/deny arms are already covered by the leaf-authorizer tests from Step 1.
   Implementation: after Step 1 the only caller of `escalator.requestApproval` is the `ParentAuthorizer` wrapper, always with `hasUI=false`/`isSubagent=true`, so the `ctx.hasUI` and `!isSubagent` arms are dead — fold the forwarding machinery directly into `ParentAuthorizer`, remove the wrapper indirection, the two dead arms, `requestApproval`, and the now-unused `ApprovalRequester` interface; drop `requestPermissionDecisionFromUi` from the forwarding deps (it stays consumed by `LocalUserAuthorizer` and `ForwardedRequestServer`).
   Delete the "UI fast path" and "non-UI, non-subagent" tests from `approval-escalator.test.ts`.
   Run `pnpm run check`.
   Commit: `refactor(pi-permission-system): fold ApprovalEscalator into ParentAuthorizer`.

3. **Update architecture docs and mark Phase 9 Step 1 complete.**
   Update `docs/architecture/architecture.md` (module tree, authority-model note, Step 1 ✅ heading + `S1` node), `docs/architecture/permission-prompter.md`, and `.pi/skills/package-pi-permission-system/SKILL.md` per Module-Level Changes.
   Run `pnpm run lint` (markdown).
   Commit: `docs(pi-permission-system): mark Phase 9 Step 1 complete — Authorizer spine`. (A `docs:` commit here is `hidden`-adjacent narrative; it batches with the `refactor:` steps and cuts no release.)

## Risks and Mitigations

- **Risk: a hidden third read of `ctx` or `events` inside the old ask path is dropped in the move.**
  Mitigation: the behavior-neutrality trace enumerates every branch; the migrated `permission-prompter`/`authorizer-selection` tests plus `permission-ui-prompt.test.ts` pin the review-log and event contracts.
- **Risk: `activate` runs per tool call, so `selectAuthorizer` reconstructs an authorizer each call.**
  Mitigation: authorizer construction is a cheap object allocation and the predicates are session-stable, so the selected authorizer is identical each call — behavior-neutral.
  A memoize-by-`ctx` optimization is possible but unnecessary and out of scope.
- **Risk: the transitional `ParentAuthorizer`-wraps-`ApprovalEscalator` seam is mistaken for the final shape.**
  Mitigation: Step 2 removes it in the same session; a prose comment (not `@deprecated`, per the `no-deprecated` lint rule) marks it transitional.
- **Risk: `fallow dead-code` flags a new module if wiring lags introduction.**
  Mitigation: Step 1 introduces and wires in one commit; run `pnpm fallow dead-code` before pushing.

## Open Questions

- None.
  The direction is fully settled in the architecture doc's [authority model](../architecture/architecture.md#the-authority-model) and the Phase 9 roadmap; no follow-up issues are named by this plan beyond the already-filed Phase 9 steps ([#556]–[#559]).

[#292]: https://github.com/gotgenes/pi-packages/issues/292
[#296]: https://github.com/gotgenes/pi-packages/issues/296
[#302]: https://github.com/gotgenes/pi-packages/issues/302
[#398]: https://github.com/gotgenes/pi-packages/issues/398
[#526]: https://github.com/gotgenes/pi-packages/issues/526
[#529]: https://github.com/gotgenes/pi-packages/issues/529
[#530]: https://github.com/gotgenes/pi-packages/issues/530
[#556]: https://github.com/gotgenes/pi-packages/issues/556
[#557]: https://github.com/gotgenes/pi-packages/issues/557
[#558]: https://github.com/gotgenes/pi-packages/issues/558
[#559]: https://github.com/gotgenes/pi-packages/issues/559
