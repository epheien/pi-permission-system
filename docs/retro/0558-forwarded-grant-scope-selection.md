---
issue: 558
issue_title: "pi-permission-system: grant-scope selection on forwarded approvals"
---

# Retro: #558 — grant-scope selection on forwarded approvals

## Stage: Planning (2026-07-09T00:00:00Z)

### Session summary

Planned Phase 9 Step 4: offering the human at the serving node a scope ("this subagent only" vs "the whole session") when approving a forwarded "for this session" request.
The design rides the child's already-computed `SessionApproval` suggestion into the `ForwardedPermissionRequest`, adds a serving-node-internal `approved_for_serving_session` decision state, and records a whole-session grant into the serving node's shared `SessionRules` so [#557]'s serve-time evaluation suppresses future prompts for the parent and its children.
Committed `docs/plans/0558-forwarded-grant-scope-selection.md` (`ad5403ab`) as three implementation cycles (feat/feat/test) plus a docs cycle.

### Observations

- **Two `ask_user` decisions drove the design** (operator is the issue author, `gotgenes`): (1) a whole-session grant records **only** on the serving node — the child gets a plain `approved`, does not record, and re-forwards its next identical action (single source of truth over child-avoids-re-forward); (2) a **two-step** dialog — the base 4-option prompt is unchanged, and picking "for this session" opens a second scope `select` only for a forwarded ask that carries a suggestion.
  The two-step choice kept `requestPermissionDecisionFromUi`'s local-ask path byte-identical.
- **`approved_for_serving_session` is serving-node-internal**: the dialog produces it, `ForwardedRequestServer.applyGrantScope` records + translates it to `approved` before the response is written, so it never reaches disk or the child.
  Added to the union and `isPermissionDecisionState` (guard completeness) but the on-disk `ForwardedPermissionResponse.state` stays within the four legacy values.
  Grep-verified the only state branch sites are the dialog and `permission-gate.ts` (checks `approved_for_session` only, unaffected) — no `never`-exhaustive switch, so widening the union is low-ripple.
- **Marker vs new-state**: considered a `grantScope` marker (like `autoApproved`/`confirmationUnavailable`) but chose an honest new state; the server's translation to `approved` is the load-bearing part either way, and a marker leaves the state saying "subagent" while meaning "serving."
- **Invariants at risk carried forward from [#557]**: the [#292] non-degraded broadcast (emit fires once before the scope select), the one-emit-site rule, and the `processSingleForwardedRequest < 60 lines` health target (hold by keeping `applyGrantScope` a separate method; the #557 retro's explicit lesson was to run `pnpm fallow health`, not just `fallow dead-code`).
- **Doc surfaces beyond `src/`**: `docs/subagent-integration.md` (README-linked) describes the forwarding approve/deny flow and needs the scope choice; the roadmap step is marked complete in the implementation docs commit (package-skill rule), and a new ADR-0006 records the two decisions.
- **Design-review pass**: the widened interfaces (`PromptPermissionDetails` +1, `ForwardedPermissionRequest` +1, `ForwardedRequestServerDeps` +1 narrow `SessionApprovalRecorder`, `RequestPermissionOptions` +1) each follow an established precedent (Step 3's `forwarding` field, the existing optional display fields) and introduce no LoD/output-argument/scattered-decision smell; `SessionApproval.toForwardedData()` avoids field reach-through in `GateRunner`.
- **No follow-ups filed**: the three-way scope and cross-cwd/cross-surface portability are admitted-not-shipped, already tracked by the roadmap's resolved-direction 4 and [#565] — nothing speculative to file.

## Stage: Implementation — TDD (2026-07-09T14:00:00Z)

### Session summary

Implemented all four planned cycles from a green 2290-test baseline, landing Phase 9 Step 4.
Cycle 1 (`feat`) rides the child's `SessionApproval` into the forwarded request (`toForwardedData`, `PromptPermissionDetails.sessionApproval`, `ForwardedPermissionRequest.sessionApproval`); cycle 2 (`feat`) wires the serving-node scope selection end-to-end (new `approved_for_serving_session` state, two-step dialog, `buildForwardedScopeLabels`, `ForwardedRequestServer.applyGrantScope` + `recorder` dep, `index.ts`); cycle 3 (`test`) adds two composition-root round-trip tests; cycle 4 (`docs`) adds ADR-0006, marks the roadmap step complete, and updates `subagent-integration.md`.
Final suite 2310 tests (+20); pre-completion reviewer returned PASS.

### Observations

- **Pre-completion reviewer: PASS** — all deterministic gates green (`check`, root `lint`, `test` 2310, `fallow dead-code`); every named cross-step invariant held.
  No warnings.
- **Plan deviation (one file):** `src/authority/forwarding-io.ts` was not in the plan's Module-Level Changes but had to change.
  The tolerant request read (`readForwardedPermissionRequest`) reconstructs only known fields, so the new `sessionApproval` was silently stripped on read — the cycle-2 server red test (`records a whole-session grant`) surfaced it (recorder never called).
  Added an `asForwardedSessionApproval` narrowing helper mirroring the file's existing `asNullableDisplayString`/`asUiPromptSource` tolerant parsers.
  Lesson for future plans: when a plan adds an optional field to a serialized contract with a *tolerant* (field-allowlist) reader, list the reader as a touch point — an on-disk round-trip is not free.
- **Step 3 invariant held:** `processSingleForwardedRequest` stayed at ~43 lines (< 60) because `applyGrantScope` was factored as a separate method and the existing `recordForwardedDecision(...)` call site absorbed the one added call — verified with a raw line count, per the #557 retro's `fallow health` lesson.
- **#292 non-degraded broadcast held:** the single `permissions:ui_prompt` emit still fires once in `LocalUserAuthorizer.authorize` before the first `select`; the new second (scope) `select` lives downstream in `requestPermissionDecisionFromUi` and does not perturb it.
- **Two self-corrected lint slips** (both `@typescript-eslint/no-unnecessary-condition`): a test used `details && "sessionApproval" in details` (rewrote to `expect.not.objectContaining`), and `buildRequestOptions` used `pattern ?? "*"` on a `string`-typed element (rewrote to guard `patterns[0]` truthiness — a suggestion with no usable pattern simply offers no scope).
  Both caught by the pre-commit eslint hook, fixed before the commit landed.
- **Round-trip tests are real, not hollow:** they drive two real factory instances on separate buses with real 250ms polling — the parent's serving poll runs the actual two-step dialog via a scope-aware `ui.select`, records into the shared `SessionRules`, and the child re-forwards.
  Whole-session proves no second prompt + parent's own action session-approved; subagent-only proves scope containment (parent still prompts).
- **Serving-node-only recording confirmed end-to-end:** the whole-session choice returns `approved_for_serving_session`, `applyGrantScope` records + translates to plain `approved`, and the round-trip test confirms the child records nothing and re-forwards.

## Stage: Final Retrospective (2026-07-09T18:15:00Z)

### Session summary

Shipped Phase 9 Step 4 end-to-end in one continuous context: planned it (two `ask_user` design decisions), executed four TDD cycles from a green 2290-test baseline to 2310, passed the pre-completion reviewer on the first dispatch, then pushed, closed #558, and merged release-please PR #567 (`pi-permission-system` v20.3.0).
The run was clean — no rework commits and no user-caught errors; the only friction was one under-listed plan touch point (surfaced and fixed in-cycle by a red test) and two self-corrected lint slips the pre-commit hook caught before they landed.

### Observations

#### What went well

- **First-dispatch pre-completion PASS.**
  Unlike #557 (which needed a FAIL→fix→re-dispatch on an unmet LOC target), the reviewer returned PASS on the first run — the plan carried the Step 3 `< 60 lines` invariant forward explicitly and the implementation held it (`applyGrantScope` factored as a separate method, `processSingleForwardedRequest` at 43 lines), so the reviewer verified rather than caught it.
- **Real, non-hollow round-trip tests.**
  The composition-root tests drive two real factory instances on separate event buses with real 250ms polling; the parent's serving poll runs the actual two-step `ui.select` dialog, records into the shared `SessionRules`, and the child re-forwards — proving the whole-session grant suppresses a second prompt and the subagent-only grant stays contained, not just that the units wire up.
- **Clean release handling on an `UNSTABLE` PR.**
  `release_pr_merge` refused with `UNSTABLE`; `statusCheckRollup` showed a genuine `IN_PROGRESS` CI check (not the empty-rollup `GITHUB_TOKEN` case), so the flow waited on the PR's own run via `ci_watch`, then retried and merged by rebase — the ship protocol's distinction held without a force-merge.

#### What caused friction (agent side)

- `missing-context` (plan stage) — the plan's Module-Level Changes omitted `src/authority/forwarding-io.ts`.
  Its tolerant reader (`readForwardedPermissionRequest`) reconstructs only an allowlist of known fields, so the new `sessionApproval` was silently stripped on read.
  Impact: added friction, no rework — the cycle-2 server red test (`records a whole-session grant`, recorder never called) surfaced it immediately, and an `asForwardedSessionApproval` helper (mirroring the file's existing `asX` parsers) fixed it in the same cycle/commit.
  `tsc` could not have caught it (the field is optional), only the cross-consumer round-trip.
- `other` (TDD stage) — two self-corrected lint slips, both `@typescript-eslint/no-unnecessary-condition`, caught by the pre-commit eslint hook before landing.
  The first (`deps.escalate.mock.calls[0]?.[0]` then a truthiness guard) is the exact `fn.mock.calls[0]` anti-pattern the `testing` skill already names — a salience miss, not a missing rule; rewrote to `expect.not.objectContaining`.
  The second (`pattern ?? "*"` on a `string`-typed element) rewrote to guard `patterns[0]` truthiness.
  Impact: two blocked commit attempts, each fixed in one edit; no re-planning.

#### What caused friction (user side)

- None material.
  The two planning `ask_user` decisions (serving-node-only recording; two-step dialog) were answered promptly and decisively, and both shaped the design cleanly — the two-step choice in particular kept the local-ask dialog byte-identical.

### Diagnostic details

- **Model-performance correlation** — the only subagent dispatch was the `pre-completion-reviewer` on `anthropic/claude-sonnet-5` (48 tool uses, ~206s): judgment-heavy verification (invariant cross-checks, LOC measurement, acceptance-criteria tracing) well-matched to the model.
  No mismatch.
- **Escalation-delay tracking** — no `rabbit-hole` points; both lint slips and the plan-touch-point miss resolved in a single corrective edit each, none exceeding one tool call.
- **Unused-tool detection** — nothing missed; the work ran in one context with full prior knowledge, so `colgrep`/`Explore` were unnecessary, and the pre-commit hook + red tests caught the two slips that a pre-emptive tool could have.
- **Feedback-loop gap analysis** — incremental verification was strong (`pnpm run check` after each shared-type change, per-file red/green vitest, full suite + root lint before commits).
  The one small gap: cycles 1 and 2 attempted `git commit` before running `pnpm run lint`, relying on the pre-commit eslint hook to catch the slips — low impact (the hook is exactly that net), but running lint before the commit attempt would avoid the blocked-commit round-trip.

### Changes made

1. Appended this Final Retrospective stage entry to `packages/pi-permission-system/docs/retro/0558-forwarded-grant-scope-selection.md`.
2. Added a tolerant-reader touch-point heuristic to `.pi/prompts/plan-issue.md` (Module-Level Changes section): a plan step that adds a field to a serialized contract whose reader reconstructs only an allowlist of known fields must list that reader, since the field is silently dropped on read and the gap surfaces only in a cross-consumer round-trip test, not `tsc` (Refs #558).

[#292]: https://github.com/gotgenes/pi-packages/issues/292
[#557]: https://github.com/gotgenes/pi-packages/issues/557
[#565]: https://github.com/gotgenes/pi-packages/issues/565
