---
issue: 323
issue_title: "Replace GateRunnerDeps with a GateRunner class injected with role collaborators"
---

# Retro: #323 — Replace `GateRunnerDeps` with a `GateRunner` class injected with role collaborators

## Stage: Planning (2026-06-03T02:02:27Z)

### Session summary

Planned the final step of the gate-runner collaborator rework: convert the free `runGateCheck` function and its `GateRunnerDeps` bag into a `GateRunner` class constructed with four role collaborators, adding the two missing roles (`GatePrompter`, `SessionApprovalRecorder`).
Confirmed #319 (`PermissionResolver`) and #322 (`DecisionReporter`) have landed in `src/`, so both prerequisites are satisfied.
Produced a five-step lift-and-shift plan (roles + session adapters, `GateRunner` alongside a temporary `runGateCheck` wrapper, handler migration, deletion, architecture doc) and committed it.

### Observations

- Module placement: put `GatePrompter` and `SessionApprovalRecorder` in their own SDK-free files (`src/gate-prompter.ts`, `src/session-approval-recorder.ts`) to mirror the `permission-resolver.ts` / `decision-reporter.ts` precedent; co-locating `SessionApprovalRecorder` inside `session-approval.ts` was considered and rejected for consistency.
  Verified neither `permission-prompter.ts` nor `session-approval.ts` imports from `handlers/gates`, so the role interfaces import cleanly with no cycle.
- The prompter is the crux: `GatePrompter` (`canConfirm()` + `promptPermission(details)`) carries no `ctx`, so `PermissionSession` implements it with stored-context adapters over `this.context` (set by `activate(ctx)` at the top of `handleToolCall`).
  `canConfirm()` returns `false` when inactive, making the `promptPermission` null-guard unreachable in correct use — a defensive invariant only.
- Transition via lift-and-shift: `GateRunnerDeps` already structurally satisfies all four roles, so `runGateCheck` becomes a one-line wrapper (`new GateRunner(deps, deps, deps, deps.reporter).run(...)`) in step 2, letting the handler (step 3) and the large `runner.test.ts` (step 4) migrate independently before the wrapper, interface, and `makeRunnerDeps` are deleted together.
- Applied the #319-retro `missing-context` lesson proactively: grepped all session mocks up front.
  Three (`handler-fixtures.ts` `makeSession`, `external-directory-integration.test.ts`, `external-directory-session-dedup.test.ts`) are `as unknown as PermissionSession`, so the runtime runner calling `session.canConfirm()` / `session.promptPermission()` would fail at runtime, not typecheck.
  Step 3 adds delegating `canConfirm` → `canPrompt` / `promptPermission` → `prompt` adapters (guarded with `Object.hasOwn` like the existing `resolve` delegation) so the `prompt`-override and `session.prompt` call-count assertions in the dedup and tool-call suites keep passing.
- The delegating-mock tactic is a known transitional smell (#319 retro); flagged as removed by #325 when the handler is retyped against the role interfaces and the `as unknown as` casts drop.
- Scope held: behavior-preserving, no public npm export change (all `#src` internal), `handleInput` untouched, `as unknown as PermissionSession` deferred to #325.

## Stage: Implementation — TDD (2026-06-03T22:27:00Z)

### Session summary

Executed all five TDD cycles: added `GatePrompter` and `SessionApprovalRecorder` role interfaces with `PermissionSession` stored-context adapters (+5 new tests), introduced the `GateRunner` class alongside a transitional `runGateCheck` wrapper (+6 null/bypass dispatch tests), migrated `PermissionGateHandler` to the injected runner with delegating session mocks in all three integration-test harnesses, migrated `runner.test.ts` off `makeRunnerDeps`/`runGateCheck` to `makeGateRunner`/`runner.run` and deleted the wrapper + `GateRunnerDeps` + `makeRunnerDeps`, and updated the architecture doc.
Test count: 1770 → 1781 (+11).
Pre-completion reviewer verdict: PASS.

### Observations

- Step 1 deviation: `promptPermission`’s null guard used `throw new Error(...)` initially, which is synchronous and not a rejected promise; `expect(...).rejects.toThrow(...)` requires a rejected promise.
  Fixed by changing to `return Promise.reject(new Error(...))` — clean and avoids the `@typescript-eslint/require-await` lint rule that would fire on an `async` function with no `await`.
- Step 2 deviation: marking `runGateCheck` with `@deprecated` JSDoc triggered `@typescript-eslint/no-deprecated` on all 19 call sites in the test file at commit time.
  Removed the JSDoc tag and kept only a prose comment explaining the transitional nature.
- The `#319`-retro `missing-context` lesson applied cleanly: all three `as unknown as PermissionSession` session mocks were identified at plan time and received delegating `canConfirm`/`promptPermission` adapters in step 3 before the handler was migrated.
  The full handler integration suite (359 tests) stayed green throughout.
- Reviewer WARNs (both pre-existing, no action needed):
  1. `toolDescriptor.preCheck = toolCheck` patch-after-construction in the last gate producer — pre-dates this issue, out of scope.
  2. `const resolver = this.session` alias types as `PermissionSession` rather than `PermissionResolver` — explicitly deferred to #325 in the plan’s Non-Goals.

## Stage: Final Retrospective (2026-06-03T02:31:35Z)

### Session summary

One continuous session carried #323 from planning through five TDD cycles to a PASS pre-completion review: the capstone-minus-one of the gate-runner collaborator rework, dissolving the `GateRunnerDeps` bag and the free `runGateCheck` function into an injected `GateRunner` class with four narrow role collaborators.
Execution was unusually clean — 7 commits, +11 tests (1770 → 1781), zero rework of committed code, two self-caught TypeScript/lint deviations each resolved in one or two tool calls.
The dominant theme was a planning investment (proactive mock-grep, structural lift-and-shift design) that pre-empted exactly the friction that bit the earlier #319 step.

### Observations

#### What went well

- The `#319`-retro lesson chain closed the loop: #319 was bitten at TDD time by hand-rolled `as unknown as PermissionSession` session mocks breaking at runtime (not typecheck) when a new session method was routed through the runner.
  For #323, planning grepped all three session mocks up front, named them in the plan's Module-Level Changes, and step 3 added delegating `canConfirm`/`promptPermission` adapters before migrating the handler — the 359-test handler suite stayed green with no surprise.
  A retro observation prevented its own recurrence one issue later.
- The lift-and-shift wrapper exploited a structural coincidence cleanly: because `GateRunnerDeps` already structurally satisfied all four role interfaces, `runGateCheck` collapsed to a one-line wrapper (`new GateRunner(deps, deps, deps, deps.reporter).run(...)`), letting the handler (step 3) and the 440-line `runner.test.ts` (step 4) migrate in independent green commits before the wrapper and interface were deleted together.
- Verification was incremental and load-bearing: the affected test file ran red→green each cycle, `pnpm run check` ran after every interface-touching step (1, 2, 3), and the full suite + `check` + `lint` + `fallow dead-code` + lockfile check ran after the last step.
  No end-only-verification gap.

#### What caused friction (agent side)

1. `other` (TDD step 1) — the `promptPermission` null guard was written as a synchronous `throw` inside a non-`async` method declared `Promise<…>`; `expect(...).rejects.toThrow(...)` cannot catch a synchronous throw.
   Switched to `return Promise.reject(new Error(...))`, which also sidesteps the `@typescript-eslint/require-await` rule that an `async`-with-no-`await` workaround would trip.
   Impact: self-caught on the first test run, ~2 tool calls, no rework of committed code.
2. `other` (TDD step 2) — marking the transitional `runGateCheck` wrapper with `@deprecated` JSDoc triggered `@typescript-eslint/no-deprecated` on all 19 surviving call sites in `runner.test.ts` at commit time.
   Removed the tag, kept a prose comment.
   Impact: self-caught by the pre-commit eslint hook, one edit, no rework.

#### What caused friction (user side)

- None material.
  The user issued the three workflow prompts (`/plan-issue`, `/tdd-plan`, `/retro`) and let the agent run end-to-end; the plan was prescriptive enough that no `ask_user` decision gate was needed and no redirection occurred.

### Diagnostic details

- **Model-performance correlation** — interleaving `model_change` with `message` entries gives the accurate attribution: planning ran on `anthropic/claude-opus-4-8`, the entire TDD execution (all ~90 turns) on `anthropic/claude-sonnet-4-6`, and this retro on `anthropic/claude-opus-4-8`.
  The `opencode-go/deepseek-v4-flash` entry in the model-change log was a transient selection immediately overridden by a switch to opus before the next turn — **zero assistant turns ran under it**.
  The one subagent dispatch (`pre-completion-reviewer`) ran on its default `anthropic/claude-sonnet-4-6` and did judgment-heavy work (217s, 36 tool uses, accurate PASS with two correct pre-existing WARNs) — appropriately capable.
  TDD on sonnet was clean and planning/review on opus/sonnet was sound, so no model-quality mismatch.
  Lens caveat: reading `model_change` entries in isolation over-counts models — a change event does not imply a turn ran under that model; attribution requires interleaving with `message` entries (this mistake produced an initial “bounced across three models” misstatement, corrected here).
- **Escalation-delay tracking** — no rabbit-holes; both deviations resolved in ≤2 consecutive tool calls.
  No sequence approached the 5-call threshold.
- **Unused-tool detection** — none needed; planning's proactive mock-grep removed the one place a missing-context gap could have formed, and no subagent beyond the reviewer was warranted.
- **Feedback-loop gap analysis** — verification ran incrementally after every change, including `pnpm run check` after each of the three interface-touching steps; the proactive handler-suite run after the step-3 mock change is the concrete payoff.

### Changes made

1. Added a `Promise.reject`-vs-`throw` rule to the `Test assertions` section of `.pi/skills/testing/SKILL.md` (a synchronous `throw` escapes `expect(...).rejects.toThrow(...)`; switching to `async` trips `require-await`).
2. Added a transitional-wrapper `@deprecated` rule to the `TDD planning rules` section of `.pi/skills/testing/SKILL.md` (`@typescript-eslint/no-deprecated` fires on every surviving call site).
3. Clarified the `Model-performance correlation` lens in `.pi/prompts/retro.md` to require interleaving `model_change` with `message` entries — a `model_change` with no assistant turn under it never ran.
4. Corrected this retro's `Model-performance correlation` diagnostic: the `opencode-go/deepseek-v4-flash` model-change event ran zero turns (transient selection overridden by opus); TDD ran entirely on `anthropic/claude-sonnet-4-6`, planning and this retro on `anthropic/claude-opus-4-8`.
