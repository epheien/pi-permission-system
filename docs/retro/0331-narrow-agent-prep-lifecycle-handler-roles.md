---
issue: 331
issue_title: "Narrow AgentPrepHandler and SessionLifecycleHandler against role interfaces"
---

# Retro: #331 — Narrow AgentPrepHandler and SessionLifecycleHandler against role interfaces

## Stage: Planning (2026-06-03T22:30:12Z)

### Session summary

Produced a four-step plan to retype `AgentPrepHandler` and `SessionLifecycleHandler` against narrow per-handler session role interfaces (`AgentPrepSession`, `SessionLifecycleSession`) instead of the concrete `PermissionSession`, completing the handler-narrowing arc started by [#325].
The plan reuses the existing two-method `GateHandlerSession` context role for `AgentPrepHandler` and drops the last two `as unknown as PermissionSession` casts in the handler test tree.

### Observations

- `AgentPrepHandler` calls `resolveAgentName(ctx, systemPrompt)` (two args), but `GateHandlerSession.resolveAgentName` is declared single-arg.
  Resolved by widening the role method to an optional `systemPrompt` parameter — behavior-neutral for the gate handler and already present on the concrete method.
  Alternative (a separate `AgentPrepSession.resolveAgentName` declaration) was rejected because the issue directs reusing the context role rather than redefining it.
- `SessionLifecycleHandler` uses `resolveAgentName` but never calls `activate`, so it deliberately does **not** reuse `GateHandlerSession` (that would carry an unused method — an ISP violation).
  Its role declares `resolveAgentName` independently; the signature overlap with `GateHandlerSession` is accepted as normal for role interfaces.
- `AgentPrepHandler` passes `this.session` to `resolveSkillPromptEntries`, so `AgentPrepSession` extends the existing `SkillPermissionChecker` role (`checkPermission`) in addition to `GateHandlerSession`.
- The current `before-agent-start.test.ts` mock carries vestigial `logger` and `getActiveSkillEntries` fields the handler never reads; the retyped literal must drop both or TypeScript's excess-property check rejects them once the cast is gone.
- No `index.ts` wiring change is needed — `PermissionSession` implements the new roles, so it stays assignable to the narrowed constructor parameters.
- Architecture doc already lists this as Phase 3 Step 14; the plan only needs to mark it ✅ and record the role names plus the `resolveAgentName` widening.
- Decided against extracting a shared `refreshConfig` micro-role (single shared method does not clear design-review check 7); declaring it on each role is cheaper than the wrong abstraction.

## Stage: Implementation — TDD (2026-06-03T22:40:34Z)

### Session summary

Implemented all four TDD steps: introduced `AgentPrepSession` and `SessionLifecycleSession` role interfaces, widened `GateHandlerSession.resolveAgentName` to accept an optional `systemPrompt`, added both roles to `PermissionSession`'s `implements` list, retyped both handler constructors, and dropped the last two `as unknown as PermissionSession` casts in the handler test tree using the `vi.fn<T>()` per-field pattern.
No new tests were added (behavior-preserving refactor; existing suite plus `pnpm run check` was the safety net).
Test count held at 84 files / 1817 tests.

### Observations

- Plan deviation: the `before-agent-start.test.ts` mock's `checkPermission` default used `{ state: "allow" }` in the original, but `PermissionCheckResult` requires `toolName`, `source`, and `origin` too.
  Fixed by importing `makeCheckResult` from the shared `handler-fixtures.ts` to build a complete default result — cleaner than duplicating the full shape inline.
- The `vi.fn<AgentPrepSession["method"]>()` pattern worked cleanly for all 11 methods across the two mocks; no union-type erasure issues because the `??`-per-field approach (not spread) was used throughout.
- Pre-completion reviewer: PASS.
  Reviewer WARN: `SessionLifecycleHandler` accesses `session.logger.warn/debug` — a two-hop Law of Demeter reach-through — noted as a pre-existing pattern intentionally carried forward (the `SessionLifecycleSession` role exposes `readonly logger` by design).
  No action required before `/ship-issue`.

## Stage: Final Retrospective (2026-06-03T22:55:00Z)

### Session summary

Completed issue #331 end-to-end across planning and TDD stages: introduced two narrow per-handler session role interfaces, widened `GateHandlerSession.resolveAgentName`, and dropped the last two `as unknown as PermissionSession` casts in the handler test tree.
Seven commits, zero rework beyond one type-checker-caught mock-payload fix, and a PASS from the pre-completion reviewer.
The session leaned heavily on the [#325] precedent (a nearly identical handler-narrowing refactor) as a template.

### Observations

#### What went well

- Incremental verification was textbook: `pnpm run check` plus the per-file `vitest run` after every TDD step, then the full suite + `pnpm run lint` + `pnpm fallow dead-code` once at the end.
  The mock-payload deviation surfaced at the `pnpm run check` immediately after the step-2 edit, not at the end — the feedback loop did exactly its job.
- The [#325] precedent made planning fast and accurate: the plan reused the established `vi.fn<T>()` per-field mock pattern and the `MockGateHandlerSession` intersection idea verbatim, so the TDD stage hit no surprises in mock construction.
- ISP judgment was applied deliberately rather than mechanically: `SessionLifecycleSession` omits `activate` (the handler never calls it) instead of reflexively reusing the full `GateHandlerSession` context role, and a one-method `refreshConfig` micro-role was explicitly rejected against design-review check 7.

#### What caused friction (agent side)

- `missing-context` (minor, self-identified) — the plan's mock sketch and the original test both used `checkPermission: …mockReturnValue({ state: "allow" })`.
  The `as unknown as PermissionSession` cast had masked that `{ state: "allow" }` is an incomplete `PermissionCheckResult` (missing `toolName`, `source`, `origin`); dropping the cast in step 2 surfaced it.
  Impact: ~2 extra tool calls (one `Edit` to import `makeCheckResult`, one re-run of `pnpm run check`); no rework beyond that, caught instantly by the type checker.
  Root: the plan's risk note anticipated a missing mock *method* ("a member the mock lacks") but the de-cast actually surfaced an incomplete *return-value payload* — a subtly different failure mode that the same fix (shared `make*` builder) addresses.

#### What caused friction (user side)

- None.
  The user ran `/plan-issue`, `/tdd-plan`, and `/retro` in sequence with no corrections.
  For a well-scoped refactor with a strong sibling precedent, mechanical oversight was appropriate — there was no strategic-judgment gap to surface earlier.

### Diagnostic details

- **Model-performance correlation** — the `pre-completion-reviewer` subagent ran on `anthropic/claude-sonnet-4-6` (judgment-heavy code review — appropriate).
  The parent session ran mostly on `claude-opus-4-8`; a transient `model_change` to `deepseek-v4-flash` appeared in the log, but the implementation completed cleanly and passed review, so no quality mismatch was observed.
- **Escalation-delay tracking** — no rabbit-holes; the single deviation resolved in ~2 consecutive tool calls, well under the 5-call escalation threshold.
- **Unused-tool detection** — none warranted; `grep` was the right tool for exact-symbol matching during exploration, and the planning read-through was complete (handlers, role files, tests, `index.ts`, architecture doc).
- **Feedback-loop gap analysis** — no gap; verification ran incrementally after each change rather than only at the end.

### Changes made

1. `.pi/skills/testing/SKILL.md` — added a bullet under "Vitest mock patterns": dropping an `as unknown as X` cast makes the type checker verify `mockReturnValue` payloads, not just method presence; build incomplete return-value literals with the shared `make*` fixture builder.
