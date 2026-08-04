---
issue: 325
issue_title: "Depend on session role interfaces in PermissionGateHandler, not the concrete PermissionSession class"
---

# Retro: #325 — Depend on session role interfaces in PermissionGateHandler

## Stage: Planning (2026-06-03T04:47:43Z)

### Session summary

Produced the implementation plan for retyping `PermissionGateHandler` against a narrow `GateHandlerSession` role and dropping the `as unknown as PermissionSession` casts.
The issue body (written before [#326]/[#327] landed) lists 12 session members and an open "residual cluster" question; the current code already shrank that residual to four methods (`activate`, `resolveAgentName`, `checkPermission`, `createPermissionRequestId`), so the plan is a small finishing move.
Stepping back per the maintainer's prompt, I expanded the design to inject the pre-built `GateRunner` (not just the `DecisionReporter`), filed three follow-up issues, and updated the Phase 3 roadmap.

### Observations

- The referenced dependencies [#319]/[#322]/[#323] are still **open** in the tracker but their code (`permission-resolver.ts`, `decision-reporter.ts`, `gate-prompter.ts`, `session-approval-recorder.ts`) is merged, and later phases [#326]/[#327] are done — so [#325] is unblocked despite the open labels.
- Decision (confirmed via `ask_user`): inject the whole `GateRunner` rather than only the `DecisionReporter` the roadmap originally named.
  This narrows the handler's `session` role to exactly four methods (the three runner roles move to the `index.ts` wiring) and removes the `session.logger` reach-through — the same LoD smell [#322] removed from the runner.
  Also drops the `events` constructor param.
- Decision: define a flat four-method `GateHandlerSession` rather than pre-splitting a two-method `SessionContext` base.
  A `SessionContext` abstraction gets a second consumer only with [#329]/[#331], so introducing it now would be a speculative export `fallow` could flag.
- The shared `makeSession` in `handler-fixtures.ts` is used **only** by `PermissionGateHandler` tests; `before-agent-start.test.ts` and `lifecycle.test.ts` have their own local `makeSession` and import only `makeCtx`.
  So narrowing the shared fixture is safe and does not touch the other handlers.
- Cast-removal wrinkle to watch in implementation: the mocks' `resolve`/`canConfirm`/`promptPermission` delegate to `checkPermission`/`canPrompt`/`prompt` and are currently assigned **after** the `as unknown as` cast.
  Without the cast the object literal must satisfy the type at creation; the plan resolves this by defining the delegations inline as closures that read the final `session` object at call time, then spreading `...overrides` last (replacing the `Object.hasOwn` guards).
  `external-directory-session-dedup.test.ts` is the canary because it drives stateful session-approval through these delegations.
- Two vestigial mock members (`getToolPermission`, `config`) exist only to satisfy the concrete class and can be dropped once the type is narrowed.
- Broader findings filed as issues (maintainer approved stepping back): [#329] extract a `SkillInputGatePipeline` (the `handleInput` skill-input assembly is still inline, asymmetric with `ToolCallGatePipeline`); [#330] relocate `createPermissionRequestId` off `PermissionSession` (it touches zero session state — maintainer noted it should land on the request-creation collaborator, not a free function); [#331] narrow `AgentPrepHandler` + `SessionLifecycleHandler` the same way.
- Behavior-preserving constraint kept: the skill-input pre-check stays on raw `checkPermission` (no session rules); switching it to `resolve` is a behavior change deferred to [#329].
- Roadmap integration (second pass, on review feedback): the three follow-ups were first parked in an ad-hoc "Phase 3 follow-ups" table, which deviated from the roadmap convention (one issue per numbered step + a node in the Mermaid graph).
  Reworked them into proper Steps and graph nodes.
- Resequencing (third pass, on review feedback): [#329] (`SkillInputGatePipeline`) introduces a new collaborator that `index.ts` must construct, so it must land **before** [#320] (the composition-root reframe) — otherwise [#320] cools the `index.ts` hotspot only for [#329] to re-touch it.
  Renumbered the Phase 3 tail so reading order matches execution order: Step 12 [#329], Step 13 [#330], Step 14 [#331], Step 15 [#320], Step 16 [#321]; updated the dependency diagram (`S12 --> S15`), the prose, the Tracks table, and the plan's Non-Goals cross-reference.
- Tooling friction: `pi-autoformat` re-pads Mermaid blocks and tables after every `Write`/`Edit`, so batched multi-edit calls against those regions went stale mid-call and failed atomically.
  Splitting into smaller targeted edits (and using length-preserving replacements for padded table cells) landed them cleanly.
  Worth remembering for any future edit touching the architecture doc's diagrams or tables.

[#319]: https://github.com/gotgenes/pi-packages/issues/319
[#322]: https://github.com/gotgenes/pi-packages/issues/322
[#323]: https://github.com/gotgenes/pi-packages/issues/323
[#326]: https://github.com/gotgenes/pi-packages/issues/326
[#327]: https://github.com/gotgenes/pi-packages/issues/327
[#329]: https://github.com/gotgenes/pi-packages/issues/329
[#330]: https://github.com/gotgenes/pi-packages/issues/330
[#331]: https://github.com/gotgenes/pi-packages/issues/331

## Stage: Implementation — TDD (2026-06-03T02:10:00Z)

### Session summary

Completed all three TDD cycles: (1) introduced `GateHandlerSession`, added it to `PermissionSession`'s `implements` list, rewired the handler constructor to accept `runner: GateRunner` and `session: GateHandlerSession`, updated all four call sites (`index.ts` + three test fixtures); (2) dropped the `as unknown as PermissionSession` casts by defining `MockGateHandlerSession` — an intersection of all required roles — and rewriting `makeSession` to use per-field `??` selection with `vi.fn<T>()` typed mocks; (3) updated `architecture.md` module-structure listing and marked Phase 3 Step 11 ✅.
Test count was 1807 before and after (behavior-preserving refactor).

### Observations

- The plan described the cast-removal approach as "spread `...overrides` last" but this pattern caused TypeScript issues when used with a type annotation on the const (spread of `Partial<T>` into `T` makes required fields optional).
  Resolved by switching to the per-field `??` selection pattern already established in `gate-fixtures.ts` (`makeGateInputs`), which lets TypeScript verify each field individually against `MockGateHandlerSession[K]`.
- The `resolve` delegation calls `session.checkPermission(surface, input, agentName, session.getSessionRuleset())` with 4 arguments, but `GateHandlerSession.checkPermission` has only 3 params.
  Resolved by adding a 4-arg `checkPermission` override in the inline type of `MockGateHandlerSession` (which overrides the 3-arg version from `GateHandlerSession` in the intersection); the handler's 3-arg call sites still compile because the 4th param is optional.
- `vi.fn<Signature>()` with the exact method type (e.g., `vi.fn<MockGateHandlerSession["activate"]>()`) ensures TypeScript checks the mock against the interface at creation, eliminating the need for any cast.
- `undefined as unknown as ExtensionContext` replaces the old `undefined as never` hack in the `canConfirm`/`promptPermission` delegations — cleaner and avoids the `never` TDZ issue.
- The `external-directory-integration.test.ts` had an unused `PromptPermissionDetails` import after the refactor (the type is now inferred from the `vi.fn<T>()` generic); removed in the Step 2 commit.
- Pre-completion reviewer verdict: WARN — one minor finding: the S11 Mermaid node in `architecture.md` was missing the ✅ marker carried by the completed S8/S9/S10 nodes.
  Fixed in a follow-up `docs:` commit.

## Stage: Final Retrospective (2026-06-03T02:35:00Z)

### Session summary

Reviewed the full two-stage arc (Planning + TDD) for issue #325.
The TDD session executed all three plan steps cleanly across 90 turns on `claude-sonnet-4-6` with zero user corrections, zero rework, and one pre-completion `WARN` (a missing Mermaid ✅ marker, fixed in the same session).
The one substantive deviation — the plan's prescribed `{ ...defaults, ...overrides }` spread did not typecheck under a precise return annotation — was self-identified and resolved by adopting the existing `gate-fixtures.ts` per-field `??` pattern.

### Observations

#### What went well

- Thorough pre-implementation reconnaissance before Step 2: turns 34–51 ran ~15 targeted `grep` calls to enumerate every `makeHandler({ session: … })` override key across all six handler test files before touching the shared `makeSession` type.
  This confirmed no caller passed the vestigial `getToolPermission` / `config` keys, so dropping them was provably safe — no rework, no broken test surfaced later.
- Incremental verification: `pnpm run check` + package test suite ran after Step 1 (turns 31–32) and again after Step 2 (turns 57–58), with `lint` after each.
  A type regression would have been caught at the step that introduced it, not at the end.
- Self-identified plan deviation handled cleanly: the plan's `{ ...defaults, ...overrides }` spread approach conflicts with the `testing` skill's known mock-typing pitfall.
  The agent recognized this without being told and pivoted to the per-field `?? vi.fn<T>()` pattern already established in `gate-fixtures.ts` (`makeGateInputs` / `makeGateRunner`) — a novel win: the codebase's own convention resolved a plan-prescribed dead end.

#### What caused friction (agent side)

- `missing-context` (planning-side, not TDD) — the plan's Design Overview prescribed defining the delegations inline "then spread `...overrides` last," which does not typecheck once the const is annotated `MockGateHandlerSession` (spread of `Partial<T>` into `T` makes required fields optional).
  Impact: no rework — the deviation was caught at design-read time and resolved in the first Step 2 write; cost was a few minutes of re-derivation.
  The `testing` skill already warns the spread "erases mock methods," but it does not name the constructive alternative (per-field `??` + `vi.fn<T>()` + precise return annotation) nor connect it to the cast-removal use case.
- `other` (minor) — a transient unused `PromptPermissionDetails` import lingered in `external-directory-integration.test.ts` after the `vi.fn<T>()` generics made the explicit annotation unnecessary.
  Impact: caught by `lint` immediately (turn 59), removed in the same step (turn 62); no rework beyond one edit.

#### What caused friction (user side)

- None.
  The session ran end-to-end without user intervention, which is the expected shape for a behavior-preserving refactor with a complete plan.
  No earlier-context opportunity applies.

### Diagnostic details

- **Model-performance correlation** — all 90 TDD turns ran on `claude-sonnet-4-6`, appropriate for mechanical-plus-type-level refactoring.
  The single subagent dispatch (pre-completion-reviewer, turn 80) ran on its agent-frontmatter default model and produced a thorough 39-tool-use report; no model mismatch.
- **Escalation-delay tracking** — no `rabbit-hole` friction; no sequence exceeded 5 consecutive tool calls on the same error.
  The longest same-purpose run (the turn 34–51 grep sweep) was deliberate reconnaissance, not stuck-state thrashing.
- **Unused-tool detection** — the grep sweep used exact-symbol matching (`makeHandler({`, `checkPermission`), which is the correct tool; `colgrep` would not have improved exact-key enumeration.
  No Explore/Plan dispatch was warranted.
- **Feedback-loop gap analysis** — verification was incremental (check/test after each of Steps 1 and 2, full suite + `fallow dead-code` + lockfile check after Step 3); no end-only verification gap.

### Proposed follow-ups

- Refine the `testing` skill to name the per-field `?? vi.fn<T>()` cast-removal pattern and its exception to the "do not annotate the return type" rule (the annotation is correct when callers supply pre-built mocks via overrides, which is what makes the completeness check enforce cast safety).
  Deferred at the maintainer's direction — recorded here rather than applied inline.

### Changes made

1. Appended this Final Retrospective stage entry to `packages/pi-permission-system/docs/retro/0325-narrow-permission-gate-handler-roles.md`.
   No prompt or `AGENTS.md` edits were made; the one proposed `testing`-skill refinement is recorded above as a deferred follow-up per the maintainer's choice.
