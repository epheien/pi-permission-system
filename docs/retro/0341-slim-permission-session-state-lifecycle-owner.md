---
issue: 341
issue_title: "Slim PermissionSession to a state/lifecycle owner; unwind the fig-leaf interfaces"
---

# Retro: #341 — Slim PermissionSession to a state/lifecycle owner; unwind the fig-leaf interfaces

## Stage: Planning (2026-06-07T18:39:38Z)

### Session summary

Produced the numbered plan for Phase 4, Step 8 — the final Track C step that slims `PermissionSession` to a state/lifecycle owner.
Confirmed all three prerequisites are CLOSED (Step 1 `#334`, Step 6 `#339`, Step 7 `#340`) and read the session/resolver/runner/handlers/fixtures source plus the `#340` retro to pick up cross-session context.
Surfaced the one genuine design ambiguity via `ask_user`; the user chose Option A (retire the three handler interfaces, depend on the concrete `PermissionSession`, build real instances in tests).

### Observations

- The headline "`GateRunner(session, session, session)` → three different collaborators" was already two-thirds done by Steps 6–7: the runner is `GateRunner(resolver, session, gateway, reporter)`, so only the recorder role is still the session.
  The clean win is moving the recorder to `SessionRules` (rename `record` → `recordSessionApproval`, `implements SessionApprovalRecorder`); the runner call site is unchanged, only the injected object differs.
- Scope is larger than the issue's 3-file headline implies.
  The `#340` retro is explicit that Step 8 also removes the session's transitional query duplicates (`checkPermission`, `getToolPermission`, `getConfigIssues`, `getPolicyCacheStamp`) and rewires `AgentPrepHandler` + `SessionLifecycleHandler` to the resolver.
  `getSessionRuleset` is also dead in production (no caller since `#340` — verified by grep) and is removed.
- `PermissionGateHandler` does **not** gain a resolver dependency — its `GateRunner` already owns the resolver; it only needs the session's `activate` / `resolveAgentName`.
  Only the two non-gate handlers gain a concrete `PermissionResolver` parameter.
- Option A is a conscious trade-off against the package's "narrow interface, not concrete class" convention.
  It is justified because Step 1 made the session/resolver constructible, so tests build real instances (no casts) — the convention's mock-cast smell does not reappear.
  `ScopedPermissionResolver`, `ToolCallGateInputs`, `SkillInputGateInputs`, and `SkillPermissionChecker` stay narrow.
- The 104 `makeHandler` call sites only break if its override-bag keys or return shape change — `handler-fixtures.ts` uses its own `MockGateHandlerSession` mock, not the real class, so removing methods from `PermissionSession` does not touch them.
  The plan preserves `makeHandler`'s override surface to keep Step 5's blast radius to the fixture file itself.
- The existing `createSession` factory in `permission-session.test.ts` is the real-session fixture to promote into `test/helpers/session-fixtures.ts`; the hand-rolled stateful recorder in `external-directory-session-dedup.test.ts` collapses into a real `SessionRules` + real resolver sharing one ruleset.
- RPC (`permission-event-rpc.ts`) uses `permissionManager.checkPermission` directly and only `session.getRuntimeContext()`; `config-modal.ts` only reads `session.lastKnownActiveAgentName` — neither blocks the query-method removals.
- TDD order is lift-and-shift: promote the fixture, move the recorder, then retire one interface per commit (each deletion + handler retype + consumer-test rewrite folded together), then rebuild the gate-handler fixture, then docs.

## Stage: Implementation — TDD (2026-06-07T20:05:00Z)

### Session summary

Executed all six planned TDD steps plus docs: promoted the real-session fixture to `test/helpers/session-fixtures.ts`, moved the recorder role to `SessionRules` (`record` → `recordSessionApproval`, `implements SessionApprovalRecorder`), retired `SessionLifecycleSession` / `AgentPrepSession` / `GateHandlerSession` one per commit (rewiring `AgentPrepHandler` and `SessionLifecycleHandler` to a concrete `PermissionResolver`), rebuilt `makeHandler` on real session + resolver + `SessionRules` recorder, and updated architecture + skill docs.
Test count moved 1828 → 1823 (net −5: removed 6 `PermissionSession` delegation tests + 2 recorder/ruleset delegation tests, added 1 `SessionApprovalRecorder` conformance test on `SessionRules`; the remaining delta is the dedup-test rewrite collapsing onto real collaborators).
Pre-completion reviewer: PASS.

### Observations

- The plan held well; the lift-and-shift order kept the suite green at every commit and the predicted "104 `makeHandler` call sites stay put" was correct — only three handler-test assertions needed edits (`session.activate` → `forwarding.start` in `tool-call`/`input`, and `session.checkPermission` → `permissionManager.checkPermission` in `input`), because `makeHandler` preserved its override-bag surface (routing `checkPermission` overrides to the fake manager and session-state overrides to `vi.spyOn`).
- Biggest unplanned discovery (surfaced by the user mid-step): after Step 5 removed the last `implements`, `fallow` flagged four `PermissionSession` members (`getActiveSkillEntries` / `getInfrastructureReadDirs` / `getToolPreviewLimits` / `lastKnownActiveAgentName`).
  Root cause: `fallow` keys member liveness off `implements` clauses, so the structurally-consumed members went dark when the fig-leaf interfaces left.
  Resolved truthfully for the trio by declaring `PermissionSession implements ToolCallGateInputs` (a genuine pipeline-input contract, no import cycle — the pipeline does not import the session); this is now reflected in the plan's design but was not in the original Module-Level Changes.
  For `lastKnownActiveAgentName`, a named-interface attempt (`ActiveAgentNameReader`) did **not** satisfy `fallow` — the blind spot is the object-literal wiring in `index.ts` (config-modal receives `session` as an object-literal property, not a traced positional arg), not the missing contract — so it was reverted and a single justified suppression added (verified false positive; `config-modal.ts` reads it in production).
- Plan-completeness gaps caught at the end and fixed: the `skill-prompt-sanitizer.ts` `SkillPermissionChecker` doc comment still named `PermissionSession` (which no longer has `checkPermission`) — corrected to `PermissionResolver`.
- Marked Steps 5 (`#338`) and 7 (`#340`) `✓ complete` in the roadmap — both were CLOSED but unmarked (the user flagged `#338`).
  Step 8 (`#341`) stays unmarked until `/ship-issue` per convention.
- Reviewer's one WARN is informational: `PermissionResolver.checkPermission` is intentionally dual-role (ruleset-injecting `resolve` vs. raw `SkillPermissionChecker` pre-filter) — deliberate design carried over from `#340`, no change needed.
- `Edit`-tool friction: the Unicode box-drawing comment banners in `permission-session.ts` and the architecture doc twice defeated `oldText` matching (compounded by `pi-autoformat` reflow); fell back to a Python slice for the two block removals.
  Re-reading after autoformat resolved the rest.

## Stage: Final Retrospective (2026-06-07T20:47:46Z)

### Session summary

Shipped `#341` across Planning (`claude-opus-4-8`), TDD (`claude-sonnet-4-6`, with an opus escalation for one design question), and Ship (`deepseek-v4-flash`): `PermissionSession` became a state/lifecycle owner, the recorder role moved to `SessionRules`, the two non-gate handlers were rewired to a concrete `PermissionResolver`, and the three fig-leaf handler interfaces were deleted.
Released as `pi-permission-system-v10.5.1`; behavior-preserving; net test delta −5; pre-completion reviewer returned PASS.
The defining moment was a user "step back" question that converted a `fallow`-suppression band-aid into the truthful `implements ToolCallGateInputs` contract declaration.

### Observations

#### What went well

- The lift-and-shift TDD order held the suite green at every commit, and the planning prediction "the 104 `makeHandler` call sites stay put" was correct — only three handler-test assertions needed edits because `makeHandler` preserved its override-bag surface.
- The model ladder matched task weight at every stage; notably the `sonnet` → `opus` switch coincided with the user's design question and gave the structural reasoning (`implements` vs. suppress) the right model.
- Incremental verification was disciplined: `pnpm run check` plus a targeted `vitest run` after each step, the full suite before each commit, and `fallow` at the end-of-TDD gate.
- The user's "step back" redirect — a question, not a correction — is the standout: it reframed a band-aid into a truthful design fix (`implements ToolCallGateInputs`) and surfaced a generalizable `fallow` insight worth promoting.

#### What caused friction (agent side)

- `premature-convergence` / `wrong-abstraction` — when `fallow` flagged four `PermissionSession` members after Step 5 removed the last `implements`, the agent (on `sonnet`) reached for four `fallow-ignore` suppressions without first asking "why is `fallow` flagging these?".
  The user caught it ("Take a step back.
  Why are we having to tell fallow these methods are used?").
  Impact: ~4 tool calls of suppression work reverted; the root-cause investigation it triggered would have been needed regardless, so net rework was small but the design-quality delta was large (truthful contract vs. four band-aids).
  User-caught.
- `missing-context` — the `fallow` skill was not loaded during TDD (the same gap the `#340` retro noted); loading it is the natural first move when `fallow` flags findings, and its absence reinforced the suppress-first reflex.
  The skill did not yet document the `implements`-liveness behavior anyway — hence the proposal below.
  Impact: contributed to the premature-suppression reflex; recurring across `#340` and `#341`.
- Edit-tool friction (recurring, ~6 occurrences) — Unicode box-drawing banner comments (`// ── … ──`) in `permission-session.ts`, `handler-fixtures.ts`, and `architecture.md` defeated `oldText` matching (variable-length dash runs compounded by `pi-autoformat` reflow); the reliable workaround was a Python `.find()` slice on a short substring.
  Impact: added friction, no rework — each recovered within 1–2 calls.

#### What caused friction (user side)

- Several `Continue.` nudges during multi-file TDD steps where the agent paused after a tool batch.
  Mechanical oversight rather than strategic input; the agent was making steady progress.
  Opportunity: batch the remaining edits of a single step more aggressively so a multi-file step does not stall waiting for a nudge (same observation as the `#340` retro — recurring).
- The `#338` `✓ complete` gap: the user had to point out that a prior CLOSED roadmap step was never marked complete in `architecture.md`.
  Opportunity: the doc-update step could prompt re-checking sibling roadmap steps' completion marks, not just the current issue's.

### Diagnostic details

- **Model-performance correlation** — clean, no mismatches.
  Planning ran on `claude-opus-4-8` (design ambiguity + `ask_user` gate), TDD on `claude-sonnet-4-6` (implementation), the fallow design question escalated `sonnet` → `opus` (correct — structural-design judgment), Ship on `deepseek-v4-flash` (mechanical git/CI/release), and the `pre-completion-reviewer` subagent returned a thorough PASS.
  The escalation landing exactly at the judgment-heavy question is the model ladder working as intended.
- **Escalation-delay tracking** — no long rabbit-hole.
  The suppression episode was ~4 tool calls before the user redirected; the post-redirect investigation (root cause → `implements` fix → named-interface attempt → revert → one justified suppression) made steady forward progress rather than repeating a failing approach.
- **Unused-tool detection** — the `fallow` skill was available but not loaded during TDD; this is the second consecutive issue (`#340`, `#341`) where it would have been the right first reach when dead-code findings appeared.
- **Feedback-loop gap analysis** — verification was incremental and effective; `fallow` correctly ran at the end-of-TDD gate per `/tdd-plan`.
  The gap was design-foresight (not anticipating that removing the last `implements` would blind `fallow` to structurally-consumed members), not a missing verification run.

### Changes made

1. `.pi/skills/fallow/SKILL.md` — added "Key gotchas" item 6: `fallow` keys class-member liveness off `implements` clauses, so a structurally-consumed member reads as dead once the last `implements` is removed; prefer re-declaring the contract over suppressing.
2. `.pi/prompts/tdd-plan.md` — reframed the end-of-TDD `fallow` step to load the `fallow` skill and prefer declaring a real contract / removing dead exports over suppressing (suppress only verified false positives), replacing the prior "add suppressions for false positives" wording that nudged toward the suppress-first reflex.
3. Recorded (no rule change): the Edit-tool `// ── … ──` banner-matching friction (covered by existing minimal-`oldText` guidance), the `#338` `✓ complete` gap (single-occurrence historical hygiene), and the recurring `Continue.`-nudge batching observation (judged too marginal for a crisp rule in the `#340` retro).
