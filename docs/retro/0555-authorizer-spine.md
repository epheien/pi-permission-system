---
issue: 555
issue_title: "pi-permission-system: introduce the Authorizer spine — interface, three implementations, once-per-session selection"
---

# Retro: #555 — Introduce the Authorizer spine

## Stage: Planning (2026-07-07T00:00:00Z)

### Session summary

Planned Phase 9 Step 1: introduce the `Authorizer` interface, its three implementations (`LocalUserAuthorizer`, `ParentAuthorizer`, `DenyingAuthorizer`), and a once-per-activation `selectAuthorizer`, replacing the three-way `hasUI`/`isSubagent`/deny dispatch smeared across `PromptingGateway`, `PermissionPrompter`, and `ApprovalEscalator`.
The direction was fully settled by the architecture doc's authority-model target and the Phase 9 roadmap, and the issue is the operator's own — so no `ask_user` gate was needed.
The plan lands in two behavior-neutral `refactor:` steps plus a docs step, filed as `packages/pi-permission-system/docs/plans/0555-authorizer-spine.md`.

### Observations

- **`GatePrompter` survives Step 1** — the runner and its fixtures (`gate-fixtures`, `handler-fixtures`, `external-directory-fixtures`) mock the stable `{ canConfirm, prompt }` surface, so the blast radius is confined to the ask-path internals + `index.ts` wiring + `permission-session.ts`/`descriptor.ts`/`session-logger.ts` imports + three test files + two fixtures.
  `canConfirm()` is dissolved later in [#556].
- **Split via a transitional wrapper** — Step 1 has `ParentAuthorizer` wrap the intact `ApprovalEscalator` (so all new modules are wired in one commit — no `fallow dead-code` failure — while the escalator's forwarding tests stay green); Step 2 folds the escalator in and removes the now-dead `hasUI`/`!isSubagent` arms plus the `ApprovalRequester` seam.
  This keeps each commit green and reviewable rather than one megacommit.
- **`selectAuthorizer(ctx, detection)` is roadmap shorthand** — the real signature is `selectAuthorizer(ctx, deps)`; the leaf authorizers need construction inputs (`events`, `requestPermissionDecisionFromUi`, `forwardingDir`, `registry`, `logger`) beyond `detection`.
  `AuthorizerSelectionDeps` relocates the composition inputs the escalator + prompter already receive — not a widening (the escalator sheds `requestPermissionDecisionFromUi`, which moves to `LocalUserAuthorizer`).
- **`activate` runs per tool call, not once per session** — confirmed via `permission-gate-handler.ts`.
  Selecting at each `activate` is behavior-neutral (predicates are session-stable, construction is a cheap allocation); the roadmap's "once per session activation" is honored in spirit, and a memoize-by-`ctx` optimization is explicitly out of scope.
- **`canConfirm` recomputed transitionally** — `AuthorizerSelection.activate` recomputes `hasUI || isSubagent` alongside `selectAuthorizer`'s own branch, a deliberate short-lived redundancy that keeps the ask path byte-identical until [#556] derives confirmability from a `DenyingAuthorizer` marker.
- **Invariants pinned** — review-log bracketing + yolo single `auto_approved` ([#526]), UI-prompt-event contract ([#292]), forwarding transport ([#530], [#398]); the plan names the test pinning each and adds a "does-not-emit" assertion for `DenyingAuthorizer`/`ParentAuthorizer`.
- **Doc surface** — a dedicated `docs/architecture/permission-prompter.md` exists and needs updating alongside the module-structure tree and the SKILL.md forwarding-test note; the phase-exit metrics table is left until the phase completes (Step 1 does not meet the `canConfirm`/role-interface targets).

## Stage: Implementation — TDD (2026-07-07T21:35:00Z)

### Session summary

Implemented Phase 9 Step 1 in two behavior-neutral TDD cycles plus a docs step, exactly as planned.
Step 1 added `Authorizer`/`selectAuthorizer`/`LocalUserAuthorizer`/`DenyingAuthorizer`/`AuthorizerSelection` and moved `PermissionPrompter` into `authority/`, with `ParentAuthorizer` wrapping the intact `ApprovalEscalator` as the planned transitional seam.
Step 2 folded `ApprovalEscalator`'s forwarding machinery directly into `ParentAuthorizer` and deleted the dead dispatch arms.
Step 3 updated `architecture.md`, `permission-prompter.md`, and `SKILL.md`.
Test count went from 2272 to 2275 (net +3, after consolidating ~36 old tests across two deleted files into ~39 new tests spread across five files).
Pre-completion reviewer: **PASS** (one non-blocking WARN, see below).

### Observations

- **Two genuine deviations from the plan's design pseudocode**, both flagged in commit bodies and confirmed sound by the reviewer:
  1. `PermissionPrompterApi` was **retained**, not removed as the plan's Module-Level Changes said — it evolved to the new `prompt(authorizer, details)` signature and became `AuthorizerSelection`'s narrow seam onto the concrete `PermissionPrompter` class.
     Needed because `PermissionPrompter`'s private `deps` field creates a TypeScript nominal brand — a structural `{ prompt: vi.fn() }` test mock cannot satisfy a concrete-class field type without a cast (the exact trap the `code-design` skill documents).
  2. `ParentAuthorizerDeps` dropped `detection` beyond what the plan's Design Overview pseudocode showed.
     Once the escalator's forwarding machinery folded into `ParentAuthorizer` (Step 2), the only use of `detection` was re-deriving `isSubagent` inside `waitForForwardedApproval` — but `selectAuthorizer` already guarantees `isSubagent === true` before constructing a `ParentAuthorizer`, so the re-check became a hardcoded `true` with an invariant comment, and the dependency dropped entirely.
- **`test/session-start.test.ts`'s minimal `ExtensionContext` mock surfaced a real timing change** — `AuthorizerSelection.activate` eagerly calls `selectAuthorizer` (and thus `detection.isSubagent(ctx)`, which reads `ctx.sessionManager.getSessionDir()`) on every activation, whereas the old `PromptingGateway.canConfirm()` was lazy and only evaluated when called.
  This is the intended behavior change (the roadmap's "predicates evaluated once per session activation" outcome), not a regression, but it required completing a stale test fixture that had never needed `getSessionId`/`getSessionDir` before.
- **The `ParentAuthorizer` forwarding round trip had no prior isolated unit test** — the pre-#555 `approval-escalator.test.ts` only covered the two now-deleted dead-arm tests (UI fast path, non-UI/non-subagent); the actual request-write/poll mechanics were only ever exercised via `composition-root.test.ts`'s full end-to-end "subagent registry sharing" test.
  Step 2 added a genuine round-trip test (temp forwarding dir, registered child/parent session pair, hand-written response file) — first pass **silently passed for the wrong reason**: an incomplete response payload (missing `responderSessionId`) fails `readForwardedPermissionResponse`'s validation and falls through to the same `{approved: false, state: "denied"}` the deny-path test expected, so the test asserted nothing about the real round trip.
  Completing the response payload's required fields turned it into a real assertion.
- **Reviewer WARN (non-blocking)** — the plan's Invariants section asked for an explicit "does-not-emit the UI-prompt event" test on `DenyingAuthorizer`/`ParentAuthorizer`.
  No such runtime assertion was added; instead neither class's deps bag has an `events` field at all, so non-emission is a compile-time guarantee rather than a tested one.
  The reviewer judged this a stronger guarantee than the plan asked for and did not block, but future `Invariants at risk` sections should note when a design choice structurally obsoletes a planned test rather than silently omitting it.
- **No steps remaining** — all three TDD-order steps landed; ready for `/ship-issue`.

[#292]: https://github.com/gotgenes/pi-packages/issues/292
[#398]: https://github.com/gotgenes/pi-packages/issues/398
[#526]: https://github.com/gotgenes/pi-packages/issues/526
[#530]: https://github.com/gotgenes/pi-packages/issues/530
[#556]: https://github.com/gotgenes/pi-packages/issues/556

## Stage: Final Retrospective (2026-07-07T22:05:00Z)

### Session summary

One continuous session carried #555 from planning through TDD, ship, and this retrospective: a behavior-neutral Phase 9 Step 1 refactor introducing the `Authorizer` spine.
Execution closely tracked a thorough plan — two `refactor:` commits plus a docs commit, pre-completion **PASS**, CI green, issue closed, no release (auto-batched, all commits hidden-type or excluded-path docs).
Friction was minor and self-caught: a false-green forwarding test, a cluster of type-wiring fixups during the big rewire, and a stale test mock surfaced by the intended eager-evaluation timing change.

### Observations

#### What went well

- **False-green caught by a paired positive assertion.**
  Step 2's new `ParentAuthorizer` round-trip test first passed the deny path for the wrong reason: a response fixture missing `responderSessionId` fails `readForwardedPermissionResponse`'s validation and falls back to the exact `{ approved: false, state: "denied" }` the deny test asserted.
  It only surfaced because the *approve*-path test failed identically — the two tests sharing a fixture shape made the invalid fixture loud on the positive path.
  Completing the payload turned both into real assertions.
- **Transitional-wrapper split landed clean.**
  The plan's two-commit lift-and-shift (Step 1 wraps the intact `ApprovalEscalator`; Step 2 folds it in and deletes the dead arms) held exactly as designed — each commit green, no `fallow dead-code` failure from unwired modules, no megacommit.
- **`tsc`/lint as an incremental safety net.**
  Every type-wiring slip during the large rewire (the `DenyingAuthorizer` zero-arg-vs-interface `TS2554`, the `AuthorizerSelectionDeps` import path, the `prompter` intersection type, the unused `DebugReviewLogger` import) was caught by a `pnpm run check` or `pnpm run lint` run immediately after the step, not deferred to the end.

#### What caused friction (agent side)

- `missing-context` — wrote the forwarded-response fixture without first checking `readForwardedPermissionResponse`'s required fields (`responderSessionId`), so the deny-path test false-greened.
  Impact: two extra test iterations in Step 2 (timeout → registry fix → `responderSessionId` fix); no production rework, and the paired positive test caught it before commit.
- `other` (mechanical type-wiring during a wide rewire) — four small fixups in Step 1 (`DenyingAuthorizer` signature, a test import path, a deps intersection type, an unused import).
  Impact: ~4 quick edits, each caught by `tsc`/lint within the same step; no rework.
- `missing-context` (mild) — the `resolvePermissionForwardingTargetSessionId` path needs either a registry entry or an env var, which the first round-trip fixture supplied via neither, so the request file was never written and the test timed out.
  Impact: one iteration; fixed by adding a `makeSubagentRegistry` child→parent mapping.

#### What caused friction (user side)

- None.
  The plan was detailed enough to run unattended through TDD and ship; no mid-session redirection was needed.
  This is the intended payoff of front-loading design into `/plan-issue` — the operator's involvement was confirmation, not steering.

### Diagnostic details

- **Feedback-loop gap analysis** — no gap: `pnpm run check` ran after each of the two implementation steps (both shared-interface changes), the affected test file ran Red-first before each implementation, and the full package suite plus root `lint`/`check`/`fallow` ran before each push.
  Verification was incremental, not end-loaded.
- **Escalation-delay tracking** — the Step 2 forwarding test took three iterations (timeout, denied-mismatch, `toMatchObject` for the live timestamp), but each was a distinct root cause diagnosed in one or two tool calls, never 5+ consecutive calls on the same error.
  No subagent dispatch warranted.
- **Model-performance correlation** — only one subagent ran, the `pre-completion-reviewer` (its own `model:` frontmatter), on judgment-heavy work (design-deviation review, invariant preservation, doc-staleness grep); appropriate match, no mismatch.
- **Unused-tool detection** — none: no `rabbit-hole` deep enough to have wanted an Explore/`colgrep` dispatch that was skipped.

### Follow-up

- None filed.
  The reviewer's one WARN (a design choice — no `events` field on `Denying`/`Parent` deps — structurally obsoleting the plan's requested "does-not-emit" test) is recorded in the TDD stage and needs no code change.
- Next roadmap step: Phase 9 Step 2 ([#556], dissolve `canConfirm()`), unblocked by this issue.

### Changes made

1. `.pi/skills/testing/SKILL.md` — added a bullet under § "Test assertions" on the false-green class where a validation/parse step's invalid-input fallback coincides with a negative-path test's expected value (assert the positive path against the same fixture builder, or assert a discriminating field).
