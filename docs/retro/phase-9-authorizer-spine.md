---
package: pi-permission-system
phase: 9
---

# Retro: pi-permission-system — Phase 9 Planning (authorizer-spine)

## Stage: Improvement Planning (2026-07-07T23:46:10Z)

### Session summary

The cause hypothesis: the live-authority path (what happens on `ask`) has no single owner — the deontic question "who may decide, and how do we reach them" is smeared across `GatePrompter.canConfirm()`, `PromptingGateway`, `PermissionPrompter`, `ApprovalEscalator`'s three-way dispatch, and `ForwardedRequestServer`'s bespoke serve flow, with `hasUI`/`isSubagent` re-evaluated 3+ times per prompt.
The architecture doc explicitly staged this phase ("the `Authorizer` interface itself is still Phase 9"), and the user confirmed the focus before deep-tracing.
The phase shape chosen is a full 5-step phase: the `Authorizer` spine ([#555]), `canConfirm()` dissolution ([#556]), serving-is-resolution ([#557]), grant-scope selection ([#558]), and the `authority/` directory-migration tail ([#559]).

### Observations

- **Cause the phase dissolves** — Category C structural fusion: authorizer selection fused with prompting mechanics; "no authority reachable" represented twice (`applyPermissionGate`'s `ask` + `!canConfirm` arm vs. `requestApproval`'s not-a-subagent arm); the serving side enforcing policy without `evaluate()` (the last out-of-ruleset yolo check).
- **Fallow corroboration, not motivation** — health 78 B; the three largest non-test functions after the composition root are exactly the ask-path modules (`runDescriptor` 130 lines, `processSingleForwardedRequest` 117, `waitForForwardedApproval` 77); dead code 0; production duplication 58 lines in 2 clone groups.
- **Deferral-gate outcome** — did not fire: cause-level Category C findings exist, so a full phase is justified without manufacturing steps.
- **Deferrals decided via `ask_user`** — the `ModelTriageAuthorizer` ([#472]) is deferred to a later phase with its own decision record ([#555]'s seam is its extension point); the two production clone groups score polish-tier (Priority ≤ 10) and are deferred; grant-scope selection was included as the tail step and the mechanical `authority/` migration completion was included, both by user choice.
- **Feasibility probes** — `ForwardedPermissionRequest` already carries optional `surface`/`value` (from `ForwardedPromptDisplay`), so serve-time evaluation over the string surface is expressible today with a fall-back-to-ask for requests lacking them; no new SDK surface is needed anywhere (`ctx.hasUI` and `ctx.ui.select`/`ctx.ui.input` are all in current use).
  The child already computes `sessionApproval` suggestions, so [#558] only rides the existing pattern along in the request.
- **Directory placement rides along** — Phase 8's forward-looking sketch names the elicitation modules as `authority/` residents; steps 1–4 name destination paths so files reach their final home as they are rewritten, and [#559] moves only the untouched remainder.
- **Tracker sweep** — open issues [#309], [#490], [#520], [#521], [#519], and [#23] were swept and recorded as out of scope in the roadmap's findings summary; no doc/tracker drift found.

[#23]: https://github.com/gotgenes/pi-packages/issues/23
[#309]: https://github.com/gotgenes/pi-packages/issues/309
[#472]: https://github.com/gotgenes/pi-packages/issues/472
[#490]: https://github.com/gotgenes/pi-packages/issues/490
[#519]: https://github.com/gotgenes/pi-packages/issues/519
[#520]: https://github.com/gotgenes/pi-packages/issues/520
[#521]: https://github.com/gotgenes/pi-packages/issues/521
[#555]: https://github.com/gotgenes/pi-packages/issues/555
[#556]: https://github.com/gotgenes/pi-packages/issues/556
[#557]: https://github.com/gotgenes/pi-packages/issues/557
[#558]: https://github.com/gotgenes/pi-packages/issues/558
[#559]: https://github.com/gotgenes/pi-packages/issues/559
