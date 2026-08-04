---
issue: 322
issue_title: "Extract a DecisionReporter for permission gate review-log and decision events"
---

# Retro: #322 — Extract a DecisionReporter for permission gate review-log and decision events

## Stage: Planning (2026-06-03T00:47:01Z)

### Session summary

Planned the extraction of a `DecisionReporter` interface + `GateDecisionReporter` class that owns the `SessionLogger` and the event bus, removing the `writeReviewLog`/`emitDecision` closures and the Law-of-Demeter reach-through to `session.logger.review` from `PermissionGateHandler`.
Confirmed #319's `PermissionResolver` work has already landed in `src/`, so the prerequisite is satisfied despite the issue still being open.
Produced a four-step plan (new module + test, atomic runner wiring, `handleInput` adoption, architecture doc) and committed it.

### Observations

- Key design fork surfaced via `ask_user`: how the reporter reaches `runGateCheck`.
  Rejected a 5th positional parameter in favor of carrying `reporter: DecisionReporter` inside the `GateRunnerDeps` bag.
  The user's read — that `runGateCheck` is "hiding a class … instantiated with what they need to act on the extemporaneous data" — confirms the #323 trajectory: the bag's stable role collaborators become `GateRunner` constructor fields while `descriptor`/`agentName`/`toolCallId` stay per-call arguments.
  The bag is the deliberate intermediate, not the destination.
- Second `ask_user` decision: route `handleInput` through the same constructor-built reporter (chosen), removing a second reach-through and `unbound-method` disable.
  Building the reporter once in the constructor (not per `handleToolCall`) is the faithful reading of "build it once" and enables the `handleInput` reuse.
- Test churn is narrow: the four handler integration test files need **no** changes because they assert through the real event bus (`getDecisionEvents` on `events.emit`) and the `session.logger.review` mock — both routed identically by the reporter.
  Churn is concentrated in `gate-fixtures.ts` `makeRunnerDeps` and ~13 `runner.test.ts` assertion sites (`deps.reporter.*`), plus a new `decision-reporter.test.ts`.
- Mid-plan correction from the user: the architecture doc's gate-runner decomposition chain (row 6, Step 6 Outcome, Track C summary, `S6` Mermaid node) stops at #323 and omits #325 — the phase capstone that retypes `PermissionGateHandler` against the role interfaces and drops the `as unknown as PermissionSession` casts.
  Step 4 of the plan now threads #325 into every link in that chain and adds the missing `[#325]` link reference, even though #325's residual-cluster decomposition is still nebulous.
- `step 2` is the single mandated atomic commit: removing the two inline members from `GateRunnerDeps` breaks the descriptor, runner, handler, fixture, and runner test at the type level simultaneously, so they move together.
- Scope held tight: `emitDecisionEvent` and the `permissions:decision` channel are untouched; the reporter wraps the existing primitive.
  No public export is removed or renamed (member swap on an exported interface only).

## Stage: Implementation — TDD (2026-06-03T01:19:36Z)

### Session summary

Executed all four TDD steps: added `GateDecisionReporter` (7 new tests), wired the reporter atomically into `GateRunnerDeps` + runner + handler + fixtures (19 runner tests reshaped), routed `handleInput` through the reporter (25 handler tests stayed green), and updated `architecture.md` with a fully flattened 11-step Phase 3 roadmap including new steps 8–9 for #323 and #325.
Test count: 1763 → 1770 (+7).
Pre-completion reviewer verdict: PASS.

### Observations

- Step 2 required one course-correction: the initial edit dropped `emitDecisionEvent` from the import prematurely, breaking the 14 `handleInput` tests that still called it directly.
  Restored the import to keep step 2 self-contained; step 3 removed it cleanly.
- Step 2 also required a second correction: removing `PermissionDecisionEvent` from `descriptor.ts`'s imports when replacing the inline `emitDecision` member made `GateBypass.decision` implicitly `any`, causing `@typescript-eslint/no-unsafe-argument` at commit time.
  Added the import back; lesson: when removing a named interface member that references an imported type, grep for other uses of that type in the same file before dropping the import.
- Two WARN findings from the pre-completion reviewer, both fixed before shipping:
  1. `private readonly events: PermissionEventBus` on the handler class was vestigial after the reporter extraction (only used in the constructor to build the reporter); Biome flagged it as `noUnusedPrivateClassMembers`.
     Fixed by dropping `private readonly` to make it a plain constructor parameter.
  2. `makeReporter` was missing from the `gate-fixtures.ts` entry in `package-pi-permission-system` SKILL.md.
     Added alongside `makeRunnerDeps`/`makeResolver`.
- Architecture doc update expanded beyond the plan: the previous S6 Mermaid node encoded the entire four-step chain in a single label (a holdover from the original coarse planning).
  Flattened to 11 discrete steps (S6–S11) per the user's direction, adding placeholder steps for #323 and #325 alongside the renumbering of the composition-root (#320) and test-fixture (#321) steps.
  Pre-completion reviewer: PASS.

## Stage: Final Retrospective (2026-06-03T01:23:15Z)

### Session summary

One continuous session carried #322 from planning through TDD to ship-ready: an 8-commit arc that extracted a `DecisionReporter` role (interface + `GateDecisionReporter`), rewired the gate runner and `handleInput` through it, and flattened the Phase 3 roadmap in `architecture.md` to 11 discrete steps.
Test count 1763 → 1770 (+7); all gates green; pre-completion reviewer PASS after two WARN fixes.
The dominant theme across stages was local-minimal edits that missed the broader structural picture — both required user redirection.

### Observations

#### What went well

- The plan's narrow test-churn prediction held exactly: the four handler integration test files (`tool-call`, `tool-call-events`, `input`, `input-events`) needed **zero** changes because they assert through the real event bus (`getDecisionEvents` on `events.emit`) and the `session.logger.review` mock — both routed identically by the reporter.
  Accurate test-impact analysis at plan time meant the TDD churn landed precisely where predicted (`gate-fixtures.ts`, `runner.test.ts`, one new file).
- The pre-completion reviewer earned its keep: it flagged the vestigial `private readonly events` field that Biome reports only as a *warning* (exit 0), so the pre-commit hook let it through — the reviewer caught what the deterministic gate did not.

#### What caused friction (agent side)

- `missing-context` — the planning-stage architecture-doc update referenced only #319/#322/#323 in the gate-runner decomposition chain and omitted #325, the phase capstone that depends on #322. #325 was not named in #322's issue body, so following only the issue's own references missed it; a forward search for dependents (`gh issue list --search "#322"`) would have surfaced it.
  Impact: user-caught; plan amended (4 edits) during planning, no code rework.
- `premature-convergence` — asked to thread #325 into the roadmap, the first attempt did the minimal in-place edit: it left the compressed `S6` Mermaid node encoding the whole four-issue chain in one label and added a redundant `S7`, producing an inconsistent hybrid.
  The user redirected ("the cleanest approach is to flatten and renumber the steps, no?
  … it saves us in the end"), and the chain was re-expanded to 11 flat one-issue-per-step nodes.
  Impact: user-caught; one extra round-trip plus a redo of the Mermaid graph, step list, and Tracks table.
- `missing-context` — TDD step 2 dropped two still-needed imports prematurely: `emitDecisionEvent` (still used by `handleInput`, broke 14 tests) and `PermissionDecisionEvent` (still referenced by `GateBypass.decision` in `descriptor.ts`, made it implicitly `any` and tripped `@typescript-eslint/no-unsafe-argument`).
  Impact: self-caught — the affected-file test run and the pre-commit eslint hook each caught one within 1–2 tool calls; near-zero rework.

#### What caused friction (user side)

- Both user redirects (#325 omission, hybrid flatten) were structural-breadth catches the user had to make twice in the same session.
  Opportunity: a forward-dependency check and a "keep the roadmap step list flat" convention, encoded once, would let the user stay in strategic-review mode rather than mechanically catching the same class of local-minimal slip.

### Diagnostic details

- **Model-performance correlation** — the parent session bounced across `anthropic/claude-opus-4-8`, `anthropic/claude-sonnet-4-6`, and `opencode-go/deepseek-v4-flash`.
  Both structural-breadth slips were user-caught rather than self-caught; the timeline cannot be confidently pinned to a specific model from the session data, but the pattern is consistent with a lighter model running during the architecture-doc edits.
  The `pre-completion-reviewer` subagent did judgment-heavy work (261s, 36 tool uses) and returned two accurate WARNs — appropriately capable for the task.
- **Escalation-delay tracking** — no rabbit-holes; the two premature-import errors were each resolved in 1–2 tool calls.
  No sequence exceeded 5 consecutive calls on one error.
- **Unused-tool detection** — `gh issue list --search "#322"` (or `--search "depends 322"`) was available and never run during planning; it would have surfaced #325 before the user did.
  No subagent was needed.
- **Feedback-loop gap analysis** — verification was incremental and healthy: each TDD step ran its affected test file red→green, then the full suite + `check` + `lint` + `fallow dead-code` ran after the last step, with pre-commit hooks catching the eslint slip at commit time.
  No end-only-verification gap.

### Changes made

1. Added a two-sentence rule to `.pi/skills/package-pi-permission-system/SKILL.md` (right after the `docs/plans/` line): the `architecture.md` phase roadmap is a flat one-issue-per-step list (never a chain inside one node label), and a plan touching it must enumerate the whole phase via a dependent search (`gh issue list --search "#N"`), not just the issues the current one references.
