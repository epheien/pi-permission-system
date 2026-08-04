---
issue: 340
issue_title: "Extract a PermissionResolver collaborator out of PermissionSession"
---

# Retro: #340 — Extract a PermissionResolver collaborator out of PermissionSession

## Stage: Planning (2026-06-07T15:34:44Z)

### Session summary

Produced the numbered plan for Phase 4, Step 7 — promoting `permission-resolver.ts` from a one-method interface into a concrete `PermissionResolver` class that holds `ScopedPermissionManager` + `SessionRules` and owns the resolution surface, then removing the resolve role from `PermissionSession`.
Confirmed dependencies are complete (Step 1 `#334` and Step 6 `#339` both CLOSED) and read the resolver/session/runner/pipeline source plus the affected test fixtures.

### Observations

- Naming was the genuine design choice, surfaced via `ask_user`.
  The user chose: the concrete class takes the canonical name `PermissionResolver`, and the narrow `{ resolve }` role interface is renamed `ScopedPermissionResolver` (symmetric with `ScopedPermissionManager`).
  This forces a dedicated rename step (Step 1) before the class can be introduced.
- Scope decision (not asked — determined by the Step 6 precedent and the issue headline): full removal of the resolve role from the session (Option Y), not transitional delegation.
  This requires restructuring `ToolCallGatePipeline` (split `resolver` out of `ToolCallGateInputs`) — a file the roadmap's 3-file target list omits, but the list is known-approximate (it also omitted `runner.ts`).
- The session keeps `checkPermission` / `getToolPermission` / `getConfigIssues` / `getPolicyCacheStamp` as transitional duplicates (still needed by `AgentPrepSession` / `SessionLifecycleSession` / `SkillPermissionChecker`); their removal + handler rewiring is explicitly Step 8 (`#341`).
  The resolver carries them now to set up Step 8 and match the issue's stated resolution surface.
- Shared-instance contract: session and resolver hold the *same* `permissionManager` + `sessionRules` injected from the composition root, so no split-brain (mirrors `#337`'s `ExtensionRuntime` dissolution).
- `SkillInputGatePipeline` needs no interface change — the `PermissionResolver` class satisfies `SkillInputGateInputs` (`{ checkPermission }`) structurally; only its construction site moves from `session` to `resolver`.
- TDD plan uses lift-and-shift: rename interface first, add class + rewire `GateRunner`/`SkillInputGatePipeline`, then `ToolCallGatePipeline`, then drop `session.resolve` last (once it has no consumers).

## Stage: Implementation — TDD (2026-06-07T17:19:30Z)

### Session summary

Completed all 5 TDD steps from the plan: renamed `PermissionResolver` interface to `ScopedPermissionResolver`, added the concrete `PermissionResolver` class, routed `GateRunner` and `SkillInputGatePipeline` through it, injected it into `ToolCallGatePipeline` (splitting the resolver out of `ToolCallGateInputs`), removed the resolve role from `PermissionSession`, and updated architecture and skill docs.
Test count moved from 1823 (baseline) to 1828 (net +5: 9 new resolver tests minus 4 removed session resolve tests).
Pre-completion reviewer: PASS — no warnings.

### Observations

- **Unplanned deviation**: `test/helpers/handler-fixtures.ts` (`makeSession`, `makeHandler`) and `test/handlers/external-directory-session-dedup.test.ts` (`makeStatefulSession`, `makeHandlerForSession`) both had a `resolve` field/closure on the `MockGateHandlerSession` because `ToolCallGateInputs` previously extended `ScopedPermissionResolver`.
  Both needed to drop the `resolve` field and create a local resolver closure (`{ resolve: (s, i, a) => session.checkPermission(s, i, a, session.getSessionRuleset()) }`) to pass to `GateRunner` and `ToolCallGatePipeline`.
  These files were not listed in the plan's Module-Level Changes (an expected gap — the plan noted the 3-file scope was approximate).
- **Fallow suppression**: `getToolPermission`, `getConfigIssues`, and `getPolicyCacheStamp` on `PermissionResolver` are flagged as unused class members by `fallow` because no handler has been rewired to them yet (that is Step 8 `#341`).
  Used `// fallow-ignore-next-line unused-class-member` (singular — fallow parses every space-separated token after the directive as an issue kind, so trailing prose comments create stale-suppression noise; the fix was to use the exact kind only).
- **`makeResolver()` default**: `makeResolver()` with no argument returns a `vi.fn()` that returns `undefined`.
  All pipeline tests that needed an allow result had to call `makeResolver(makeCheckResult())` explicitly — this was missed in the initial test rewrite and caught by the runtime failure (`Cannot read properties of undefined (reading 'command')`) rather than by type-check.

## Stage: Final Retrospective (2026-06-07T18:10:02Z)

### Session summary

Shipped #340 across three sessions (Planning on `claude-opus-4-8`, TDD on `claude-sonnet-4-6`, Ship on `deepseek-v4-flash`): `permission-resolver.ts` became a concrete `PermissionResolver` class holding `ScopedPermissionManager` + `SessionRules`, the narrow `{ resolve }` role interface was renamed `ScopedPermissionResolver`, and the resolve role was removed from `PermissionSession`.
Released as `pi-permission-system-v10.5.0`; net test delta +5 (9 new resolver tests, 4 redundant session resolve tests removed); pre-completion reviewer returned PASS.
Execution was clean overall — the friction was three self-caught fixture/tooling-grammar gaps during TDD, none of which produced an extra commit or any rework after push.

### Observations

#### What went well

- The planning `ask_user` gate (the one genuine ambiguity: should `PermissionResolver` be the class or the role interface?) paid off across stages.
  The user's choice — concrete class takes the canonical name, role interface renamed `ScopedPermissionResolver` — fixed the whole TDD sequence (rename-first lift-and-shift) and there was zero re-litigation later.
- Lift-and-shift sequencing held the suite green at every commit: rename the interface (Step 1) → add the class + rewire `GateRunner`/`SkillInputGatePipeline` (Step 2) → inject into `ToolCallGatePipeline` (Step 3) → drop `session.resolve` last once it had no consumers (Step 4).
  `session.resolve` was deliberately kept alive through Steps 2-3 so each commit compiled.
- Incremental verification was disciplined: `pnpm run check` ran immediately after the rename step (caught the missed `makeGateRunner` reference at turn 46), and the full suite ran after every step.
- Ship handled a `ci_find` tooling miss gracefully — the run existed but `ci_find` could not match the SHA, so the agent fell back to `ci_list` → `ci_watch` rather than stalling.

#### What caused friction (agent side)

- `missing-context` — the plan's grep for `PermissionResolver` type usages enumerated direct references but missed `MockGateHandlerSession` (an intersection type `ToolCallGateInputs & SkillInputGateInputs & …`), which carried `resolve` transitively because `ToolCallGateInputs extends ScopedPermissionResolver`.
  When the resolve role left that `extends` chain, the mock supertype silently lost `resolve` and broke at the construction sites in `handler-fixtures.ts` and `external-directory-session-dedup.test.ts`.
  Impact: ~8 reads/greps of exploration mid-Step-3 (turns 65-72) to rediscover the chain; resolved in the same commit, no extra commit.
  Self-identified.
- `missing-context` — rewriting `tool-call-gate-pipeline.test.ts` swapped `makeGateInputs().resolve` (default: allow result) for `makeResolver()` (default: returns `undefined`); 8 tests failed at the full-suite run with `Cannot read properties of undefined (reading 'command')`.
  This is the documented "diff default values across factories" pitfall, but the existing testing-skill rule is phrased for *consolidating* factories, not *swapping* one for another, so it did not trigger.
  Impact: one diagnose + `sed` fix cycle (turns 87-91), folded into the Step-3 commit.
  Self-identified.
- `missing-context` — the first `fallow` suppression used `// fallow-ignore-next-line unused-class-members` (plural) with trailing prose (`-- Step 8 (#341) rewires …`); `fallow` parses every space-separated token after the directive as an issue kind, so the plural typo + prose produced 30 stale-suppression findings.
  Took ~4 iterations (turns 112-118) to land the exact singular `unused-class-member` with no trailing text.
  The `fallow` skill was not loaded during TDD and does not document the singular-kind / no-trailing-prose rule anyway.
  Self-identified.
- Minor (no proposal): two `Edit` `oldText` mismatches (turns 38, 62) from `pi-autoformat` reflow, each recovered by a re-read — `AGENTS.md` already documents this; one wrong-path read missing the `packages/` prefix (turn 9).

#### What caused friction (user side)

- Two `Continue.` nudges during TDD Step 3 (turns 80, 84) where the agent paused after tool batches mid-step.
  Mechanical oversight rather than strategic input; the agent was making steady progress.
  Opportunity: batch the remaining edits of a single step more aggressively so a multi-file step does not stall waiting for a nudge.

### Diagnostic details

- **Model-performance correlation** — no mismatches.
  Planning ran on `claude-opus-4-8` (judgment-heavy: design ambiguity + naming), TDD on `claude-sonnet-4-6` (implementation), Ship on `deepseek-v4-flash` (mechanical git/CI/release).
  The `pre-completion-reviewer` subagent returned a thorough PASS.
  The model ladder matched task weight at each stage.
- **Escalation-delay tracking** — no `rabbit-hole` sequence exceeded 5 consecutive tool calls on one error.
  The `fallow` suppression dance (~4 iterations) and the transitive-extends discovery (~8 exploration calls) both made steady forward progress rather than repeating a failing approach.
- **Unused-tool detection** — the `fallow` skill was available but not loaded during TDD; loading it would not have fully prevented the suppression dance because the skill lacks the singular-kind / no-prose rule (hence the proposed skill fix).
- **Feedback-loop gap analysis** — verification was incremental and effective.
  One micro-gap: the pipeline test was replaced via a full-file `Write` (turn 83) and the default-value mismatch surfaced at the full-suite run rather than a single-file run first; the full suite caught it anyway, so impact was negligible.

### Changes made

1. `.pi/skills/fallow/SKILL.md` — added the suppression-grammar rule to the "Suppressing findings" section: the kind token must be the exact singular issue kind and the only text after the directive, with rationale on the line above.
2. `.pi/skills/testing/SKILL.md` — added a TDD planning rule to grep `extends <Interface>` / `<Interface> &` composers when removing an interface from a chain, since intersection mock supertypes break at the construction site, not the type definition.
3. Recorded (no rule change): broadening the "diff default values" testing rule to cover factory *swaps*, loading the `fallow` skill in `/tdd-plan`, and the `Continue.`-nudge batching tactic — all judged too marginal for a durable rule.
