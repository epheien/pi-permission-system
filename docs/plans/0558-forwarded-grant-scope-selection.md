---
issue: 558
issue_title: "pi-permission-system: grant-scope selection on forwarded approvals"
---

# Grant-scope selection on forwarded approvals

## Release Recommendation

**Release:** ship independently

This is Phase 9 Step 4, tagged `Release: independent` in the roadmap — a `feat:` that leaves the package consistent on its own (no multi-step batch).
It cuts a release on landing.

## Problem Statement

When a subagent hits an `ask` it cannot answer, it forwards the request up to the serving node (the parent/root), where a human decides.
Today, if that human approves "for this session," the ruling can land only on the **requesting subagent**: the response rides back to the child, whose `GateRunner` records the pattern into the child's own `SessionRules`.
The human has no way to record the ruling at the **serving scope**, so a grant that should cover the parent and all its subagents must be re-approved for each child.

This is [resolved direction](../architecture/architecture.md#resolved-direction) 4 of the authority model and the tail step of Phase 9.
It rides the spine that [#557] finished: serving a forwarded request is already resolution against the serving node's recorded authority, so a whole-session grant recorded into the serving node's `SessionRules` suppresses future prompts for the parent and its children for free (the serving node auto-approves the next forward).

## Goals

- Offer the human at the serving node a scope when approving a forwarded request "for this session": **this subagent only** (the default, least privilege) or **the whole session**.
- Ride the child's already-computed session-approval suggestion (`surface` + patterns) along with the forwarded request so the serving node can record the same pattern the child would.
- Record a whole-session grant into the serving node's own `SessionRules` — the single source of truth for that scope — so the parent and its children resolve it as recorded authority via the [#557] serve-time evaluation.
- Preserve today's behavior exactly for the subagent-only default and for version-skew requests that carry no suggestion.

## Non-Goals

- The three-way scope (root / parent / requesting subagent).
  The tree is depth-2 today (pi-subagents' recursion guard removes the subagent tool from children), so "parent" and "root" coincide and the dialog offers two scopes.
  The three-way split is admitted-not-shipped, the same shape as the escalation chain — deferred with the multi-hop work, not filed as a new issue.
- Recording a whole-session grant on the requesting child as well.
  The operator chose serving-node-only recording (single source of truth); the child re-forwards its next identical action and the serving node auto-approves it.
- Cross-cwd path portability of a recorded pattern.
  A whole-session path grant matches a child's later forward only when they share a cwd — the pre-existing single-surface/cross-cwd limitation documented in `docs/decisions/0005-serving-authorizer-provenance.md` and tracked in [#565].
  No new work here.
- The `authority/` file moves (Phase 9 Step 5, [#559]) — this step touches the modules in place.

## Background

The relevant flow after [#557]:

- **Child (subagent, no UI).**
  `GateRunner.runDescriptor` (`src/handlers/gates/runner.ts`) computes `descriptor.sessionApproval` (a `SessionApproval` value object — surface + one-or-more patterns) and escalates the ask via `AskEscalator.escalate(details)`.
  Selection routes it to `ParentAuthorizer.authorize(details)` (`src/authority/approval-escalator.ts`), which writes a `ForwardedPermissionRequest` file and polls for the response.
  When the response is `approved_for_session`, `applyPermissionGate` (`src/permission-gate.ts`) returns the descriptor's `sessionApproval`, and the runner records it into the **child's** `SessionRules`.
- **Serving node (UI).**
  `ForwardedRequestServer.processInbox` (`src/authority/forwarded-request-server.ts`) resolves each request against recorded authority (`ServingPolicy.check`), and on `ask` escalates through `AskEscalator` to the serving session's `LocalUserAuthorizer`, which shows the dialog via `requestPermissionDecisionFromUi` (`src/permission-dialog.ts`).
  The forwarded provenance rides on `PromptPermissionDetails.forwarding`, so the broadcast stays non-degraded ([#292]).
  The server writes the decision's `state` back to the child and records **nothing** locally.

Key facts:

- The serving node's `SessionRules` is the single shared instance wired in `src/index.ts` — the `PermissionResolver`, the `GateRunner` recorder, and (via the resolver) the `ServingPolicy` all read it.
  Recording into it at serve time is immediately visible to the parent's own gates and to future forwarded resolutions.
- `ForwardedPermissionRequest` (`src/permission-forwarding.ts`) already carries optional display fields (`source`/`surface`/`value`) for version-skew tolerance; the child's session-approval suggestion is a natural sibling.
- `PromptPermissionDetails` (`src/authority/permission-prompter.ts`) is the only data channel from `GateRunner` to `ParentAuthorizer`; the Step 3 `forwarding` field set the precedent for forwarded-only data on it.
- Constraint (AGENTS.md): the `permission-manager.ts` string boundary must not import `AccessPath`; this change touches none of that — it operates on already-suggested patterns.

## Design Overview

### Data flow

The child rides its suggestion along; the serving node reads it, offers the scope, and records at the chosen scope:

```text
child GateRunner
  descriptor.sessionApproval ({surface, patterns})
    → details.sessionApproval  (PromptPermissionDetails)
      → ParentAuthorizer.authorize → ForwardedPermissionRequest.sessionApproval  (on disk)
         → ForwardedRequestServer.buildForwardedAskDetails → details.sessionApproval (serving)
            → LocalUserAuthorizer → two-step dialog scope choice
               ├─ "this subagent only"  → state approved_for_session  → child records (today's path)
               └─ "the whole session"   → state approved_for_serving_session
                     → server records into serving SessionRules, responds `approved`
```

### The new decision state

`PermissionDecisionState` (`src/permission-dialog.ts`) gains one member:

```typescript
export type PermissionDecisionState =
  | "approved"
  | "approved_for_session"
  | "approved_for_serving_session" // new
  | "denied"
  | "denied_with_reason";
```

`approved_for_serving_session` is **serving-node-internal**: it originates in the dialog, is read by `ForwardedRequestServer`, and is translated to `approved` before the response is written — it never reaches disk or the child.
It is added to `isPermissionDecisionState` (the guard is the union's validator; keeping it complete is correct) but the server's translation keeps the on-disk `ForwardedPermissionResponse.state` within the four legacy values.
No `never`-exhaustive `switch` over the state exists (grep-verified), so the only branch sites are the dialog and `permission-gate.ts` (which checks `approved_for_session` only, and is unaffected — the new state never reaches a child gate).

### The two-step dialog

The operator chose a two-step dialog: the base 4-option prompt is unchanged; picking "Yes, for this session" triggers a **second** `select` for scope, but only when the ask was forwarded and carries a suggestion.

`RequestPermissionOptions` (`src/permission-dialog.ts`) gains:

```typescript
export interface RequestPermissionOptions {
  sessionLabel?: string;
  /** Forwarded asks only: a "for this session" choice opens a second scope select. */
  sessionScope?: { subagentLabel: string; servingSessionLabel: string };
}
```

`requestPermissionDecisionFromUi`, after the user selects the session option:

```typescript
if (selected === sessionOption) {
  if (options?.sessionScope) {
    const scope = await ui.select(`${title}\nApply this session grant to:`, [
      options.sessionScope.subagentLabel, // index 0 = least-privilege default
      options.sessionScope.servingSessionLabel,
    ]);
    return {
      approved: true,
      state:
        scope === options.sessionScope.servingSessionLabel
          ? "approved_for_serving_session"
          : "approved_for_session", // default; cancel (undefined) → least privilege
    };
  }
  return { approved: true, state: "approved_for_session" };
}
```

The subagent option is listed first and is the fallback for a cancelled scope select — the least-privilege default the issue requires.
A local (non-forwarded) ask never sets `sessionScope`, so its dialog is byte-identical to today.

### Building the scope labels

`LocalUserAuthorizer.authorize` (`src/authority/local-user-authorizer.ts`) sets `sessionScope` only when `details.forwarding && details.sessionApproval` are both present:

```typescript
const options = buildRequestOptions(details); // sessionScope for forwarded+suggestion, else sessionLabel
return this.deps.requestPermissionDecisionFromUi(
  this.deps.ui,
  details.forwarding ? "Permission Required (Subagent)" : "Permission Required",
  details.message,
  options,
);
```

Labels come from a new `buildForwardedScopeLabels(agentName, surface, pattern)` in `src/pattern-suggest.ts` (the session-approval label home, beside `buildLabel`):

```typescript
// e.g. { subagentLabel: "This subagent ('reviewer') only",
//        servingSessionLabel: "The whole session (parent + all subagents)" }
```

### Riding the suggestion along

`SessionApproval` (`src/session-approval.ts`) gains `toForwardedData()` so `GateRunner` tells the object for its data instead of reaching into `surface`/`patterns`:

```typescript
export interface ForwardedSessionApproval {
  surface: string;
  patterns: readonly string[];
}
// on SessionApproval:
toForwardedData(): ForwardedSessionApproval {
  return { surface: this.surface, patterns: [...this.patterns] };
}
```

`ForwardedSessionApproval` is defined once in `src/permission-forwarding.ts` (beside `ForwardedPromptDisplay`) and imported as a type into `permission-prompter.ts` and `session-approval.ts` (no runtime coupling; `approval-escalator.ts` already type-imports from `permission-forwarding.ts`).

`GateRunner.runDescriptor` populates it on the escalate call:

```typescript
const decision = await this.prompter.escalate({
  requestId: toolCallId,
  ...descriptor.promptDetails,
  ...(descriptor.sessionApproval
    ? { sessionApproval: descriptor.sessionApproval.toForwardedData() }
    : {}),
});
```

`ParentAuthorizer.authorize` reads `details.sessionApproval` and threads it into `buildForwardedRequest`, which persists it onto the request (spread like today's `source`/`surface`/`value`).

### Recording at the serving scope

`ForwardedRequestServer` gains one dependency and one private method:

```typescript
export interface ForwardedRequestServerDeps {
  // …existing: forwardingDir, logger, policy, escalator, registry
  /** Serving node's SessionRules — records a whole-session grant. */
  recorder: SessionApprovalRecorder;
}
```

`buildForwardedAskDetails` sets `details.sessionApproval` from `request.sessionApproval` (so the serving dialog can offer the scope).
`processSingleForwardedRequest` funnels the decision through a new `applyGrantScope` before `recordForwardedDecision` writes the response:

```typescript
private applyGrantScope(
  request: ForwardedPermissionRequest,
  decision: PermissionPromptDecision,
): PermissionPromptDecision {
  if (decision.state !== "approved_for_serving_session") return decision;
  if (request.sessionApproval) {
    this.recorder.recordSessionApproval(
      SessionApproval.multiple(
        request.sessionApproval.surface,
        request.sessionApproval.patterns,
      ),
    );
    this.logger.review("forwarded_permission.session_recorded", { /* … */ });
  }
  // Translate to a plain grant: the child does NOT also record (single source
  // of truth on the serving node); its next identical action re-forwards and
  // resolves as recorded authority.
  return { approved: true, state: "approved" };
}
```

Keeping `applyGrantScope` a separate method preserves the [#557] `processSingleForwardedRequest < 60 lines` health target (one added call).

### Edge cases

- **Legacy/version-skew request** (no `sessionApproval`): the serving dialog offers no scope → single "for this session" → `approved_for_session` → child records, exactly as today.
- **Scope select cancelled** (`undefined`): defaults to `approved_for_session` (subagent only) — least privilege.
- **Whole-session grant, external-directory surface**: the recorded surface (`external_directory`) may differ from a later forward's surface (`read`); per the [#557] single-surface best-effort rule such a forward lands on `ask` → prompt, never a silent grant.
  Not a regression — the whole-session grant is fully effective for the parent's own actions and for forwards whose surface matches.

## Module-Level Changes

- `src/session-approval.ts` — add `toForwardedData(): ForwardedSessionApproval`; import the type.
- `src/permission-forwarding.ts` — add `ForwardedSessionApproval` interface; add optional `sessionApproval?: ForwardedSessionApproval` to `ForwardedPermissionRequest`.
- `src/authority/permission-prompter.ts` — add optional `sessionApproval?: ForwardedSessionApproval` to `PromptPermissionDetails` (type import from `permission-forwarding`).
- `src/handlers/gates/runner.ts` — populate `sessionApproval` on the escalate details from `descriptor.sessionApproval.toForwardedData()`.
- `src/authority/approval-escalator.ts` — `ParentAuthorizer.authorize` threads `details.sessionApproval` into `buildForwardedRequest`, which persists it on the request.
- `src/permission-dialog.ts` — add `approved_for_serving_session` to `PermissionDecisionState` and `isPermissionDecisionState`; add `sessionScope` to `RequestPermissionOptions`; add the second scope `select` in `requestPermissionDecisionFromUi`.
- `src/pattern-suggest.ts` — add `buildForwardedScopeLabels(agentName, surface, pattern)`.
- `src/authority/local-user-authorizer.ts` — build `sessionScope` labels for a forwarded ask carrying a suggestion; pass them to `requestPermissionDecisionFromUi`.
- `src/authority/forwarded-request-server.ts` — add `recorder: SessionApprovalRecorder` dep; set `details.sessionApproval` in `buildForwardedAskDetails`; add `applyGrantScope` (record + translate) called from `processSingleForwardedRequest`; import `SessionApproval`.
- `src/index.ts` — pass `recorder: sessionRules` to the `ForwardedRequestServer` constructor.

Docs (implementation commit, per the package skill — mark the roadmap step complete here, not at ship):

- `docs/decisions/0006-forwarded-grant-scope-selection.md` — new ADR recording the serving-node-only-recording and two-step-dialog decisions and the serving-node-internal `approved_for_serving_session` translation.
- `docs/architecture/architecture.md` — mark Phase 9 Step 4 complete (`✅` on the step heading and the `S4` Mermaid node); add a `Landed:` bullet; update the health-metric row if the flat-`src/` count or any tracked target is affected (it is not — no files added).
- `docs/subagent-integration.md` — extend the `ask`-state-forwarding bullet / Permission Forwarding section with the grant-scope choice.

Tests (see TDD Order):

- `test/session-approval.test.ts`, `test/handlers/gates/runner.test.ts`, `test/authority/approval-escalator.test.ts` — producer path.
- `test/permission-dialog.test.ts`, `test/authority/local-user-authorizer.test.ts`, `test/authority/forwarded-request-server.test.ts` — dialog + serving path.
- `test/helpers/forwarding-fixtures.ts` — `makeServerDeps` gains a default `recorder: { recordSessionApproval: vi.fn() }`.
- `test/composition-root.test.ts` — round-trip tests for both scopes.

Grep-verified no other consumers: `approved_for_session` is read only by `permission-dialog.ts` and `permission-gate.ts`; `isPermissionDecisionState` by `forwarding-io.ts` (guard, unaffected by translation); `PermissionDecisionState` typed on `ForwardedPermissionResponse.state` (stays within legacy values).
No architecture-doc inline type listing names these states.

## Test Impact Analysis

1. **New unit tests enabled.**
   `SessionApproval.toForwardedData()` (round-trips surface + patterns); the two-step dialog scope mapping (subagent → `approved_for_session`, whole → `approved_for_serving_session`, cancel → `approved_for_session`, no-`sessionScope` → single option); `LocalUserAuthorizer` sets `sessionScope` iff forwarded + suggestion; `ForwardedRequestServer.applyGrantScope` records into the recorder on the new state and translates the response, and passes `approved_for_session` through untouched.
2. **Existing tests to update (same step as the change).**
   Runner tests asserting exact `escalate`/`prompt` args (now carry `sessionApproval`); `approval-escalator.test.ts` request-shape assertions; `permission-dialog.test.ts` (new state in the guard + the two-step path); `forwarding-fixtures.ts` `makeServerDeps` default `recorder`.
   No test becomes redundant — the change is additive.
3. **Tests that must stay as-is.**
   The [#292] non-degraded-broadcast tests (`local-user-authorizer` forwarded-render + server-details mapping) — the emit still fires once in `authorize` before the first select; the scope select is added after and must not perturb them.

## Invariants at risk

The change touches surfaces [#557] refactored; each documented outcome and its pinning test:

- **Forwarded `permissions:ui_prompt` broadcast stays non-degraded** ([#292], `docs/cross-extension-api.md`) — pinned by the `LocalUserAuthorizer` forwarded-render test and the server-details mapping test.
  The scope select runs after the single emit; verify these stay green unchanged.
- **One `permissions:ui_prompt` emit site** (Step 3) — no new emit added.
- **`processSingleForwardedRequest < 60 lines`** (Step 3 health target) — hold it by adding `applyGrantScope` as a separate method; run `pnpm fallow health` on `forwarded-request-server.ts` before declaring done (the #557 retro's explicit lesson: `fallow dead-code` does not measure LOC).
- **Uniform escalation / `canConfirm` = 0** (Step 2) — the forwarded ask still flows through `PermissionPrompter` bracketing; the scope choice lives inside `LocalUserAuthorizer`, adding no pre-check.

## TDD Order

1. **Producer: ride the child's suggestion into the forwarded request.**
   Red→green across `test/session-approval.test.ts` (`toForwardedData`), `test/handlers/gates/runner.test.ts` (escalate details carry `sessionApproval`), `test/authority/approval-escalator.test.ts` (request persists `sessionApproval`).
   Adds the `ForwardedSessionApproval` type, `toForwardedData`, the two optional fields, and the runner/authorizer wiring.
   The server still ignores the new field — child records on `approved_for_session` exactly as today (valid intermediate).
   Run `pnpm run check` (shared-type change).
   Commit: `feat(pi-permission-system): forward the child's session-approval suggestion`.
2. **Consumer: serving-node scope selection end-to-end.**
   Red→green across `test/permission-dialog.test.ts` (new state + guard + two-step mapping incl. cancel-defaults-to-subagent and no-`sessionScope`-single-option), `test/authority/local-user-authorizer.test.ts` (sets `sessionScope` iff forwarded + suggestion; label wiring), `test/authority/forwarded-request-server.test.ts` (records into `recorder` + translates on the new state; passes `approved_for_session` through), updating `test/helpers/forwarding-fixtures.ts` (`makeServerDeps` default `recorder`).
   Adds the dialog change, `buildForwardedScopeLabels`, `local-user-authorizer` wiring, the server `recorder` dep + `buildForwardedAskDetails` set + `applyGrantScope`, and the `index.ts` `recorder: sessionRules` wiring (single call site — same commit).
   The feature is fully wired here; leaves the package consistent.
   Run `pnpm run check`.
   Commit: `feat(pi-permission-system): offer whole-session scope on forwarded approvals`.
3. **Composition-root round-trip (cross-consumer).**
   `test/composition-root.test.ts`, two tests: (a) whole-session — child forwards, the serving UI picks "whole session" (two-step), the serving node records, the child gets a plain approve; a second child forward auto-approves with no second human prompt, and the parent's own identical action is `session_approved`; (b) subagent-only — the serving UI picks "this subagent only," the child records locally (its next action needs no forward), and the parent's own identical action still prompts (scope containment).
   Use a plain custom tool (config `demo: ask`) so the forward surface equals the recorded surface (`demo`, pattern `*`) and the best-effort re-resolution matches.
   Commit: `test(pi-permission-system): round-trip forwarded grant-scope selection`.
4. **Docs.**
   Add ADR `0006-forwarded-grant-scope-selection.md`; mark Phase 9 Step 4 `✅` (heading + `S4` node) with a `Landed:` bullet in `architecture.md`; extend `docs/subagent-integration.md` with the scope choice.
   Commit: `docs(pi-permission-system): record forwarded grant-scope selection (Phase 9 Step 4)`.

## Risks and Mitigations

- **Half-wired feature between steps.**
  Step 1 is inert (server ignores the field); Step 2 wires dialog + server together so the new state is never producible without a handler.
  Mitigation: the step boundary is drawn exactly there.
- **Response-state translation missed → grant recorded nowhere.**
  If `applyGrantScope` failed to translate, the child would receive `approved_for_serving_session`, treat it as a plain approve, and record nothing while the serving node also recorded nothing.
  Mitigation: the server unit test asserts both the `recorder` call and the translated `approved` response on the new state.
- **Cross-cwd / cross-surface re-resolution.**
  A whole-session path grant matches a child's later forward only when cwd and surface align (the [#557] best-effort rule).
  Mitigation: documented in the ADR and Non-Goals; the round-trip test uses a surface-stable custom tool; worst case is a fail-safe re-prompt, never a silent grant.
- **`PermissionDecisionState` widening ripples.**
  Mitigation: grep-verified the only branch sites are the dialog and `permission-gate.ts` (unaffected); no exhaustive switch; guard updated.

## Open Questions

- Whether to persist a whole-session grant as durable config ("always," not just this session) is out of scope — the "always" tier is a separate, later concern (principle 8: a future "always" writes config).
- The three-way scope (root / parent / requesting subagent) waits on multi-hop escalation; no follow-up filed (admitted-not-shipped, tracked by the roadmap's resolved-direction 4 and the multi-hop note, not a new issue).

[#292]: https://github.com/gotgenes/pi-packages/issues/292
[#557]: https://github.com/gotgenes/pi-packages/issues/557
[#559]: https://github.com/gotgenes/pi-packages/issues/559
[#565]: https://github.com/gotgenes/pi-packages/issues/565
