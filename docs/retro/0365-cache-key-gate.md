---
issue: 365
issue_title: "Encapsulate agent-start cache keys in a `CacheKeyGate` class"
---

# Retro: #365 — Encapsulate agent-start cache keys in a `CacheKeyGate` class

## Stage: Planning (2026-06-09T00:00:00Z)

### Session summary

Produced a four-step plan to extract a `CacheKeyGate` class, replace `PermissionSession`'s four anemic cache methods + two fields with two exposed gate sub-objects, collapse `AgentPrepHandler`'s two ask-then-tell pairs into `runIfChanged` tells, and remove the test-only-alive `shouldApplyCachedAgentStartState`.
Confirmed Track A (`#362`–`#364`) is closed and shipped, so no `permission-session.ts` merge coordination is needed despite the roadmap's note.

### Observations

- Resolved one genuine design ambiguity via `ask_user`: the handler reaches the gates through `readonly` properties on `PermissionSession` (`session.activeToolsGate.runIfChanged(...)`) rather than through two thin delegating methods.
  This matches the roadmap's "0 anemic cache accessors / 2 owned `CacheKeyGate` sub-objects" target.
- Chose run-then-commit ordering for `runIfChanged`, unifying the two paths.
  The prompt path previously committed before its sanitization work; the only observable change is on the throw path (now retried, strictly safer).
  Flagged in Risks.
- Grep confirmed the four session methods and `shouldApplyCachedAgentStartState` are referenced only in `before-agent-start.ts` and three test files — no `SKILL.md` or composition-root references.
- Step 2 is deliberately a single combined commit: removing the four methods breaks the handler and both test files at once, so the extraction + consumer updates + consumer-test updates must land together.
- The key builders (`createActiveToolsCacheKey`, `createBeforeAgentStartPromptStateKey`) stay; only the comparison helper is removed.
- Noted that Track A steps were not individually marked `✓ complete` in `architecture.md`; Step 4 of the plan marks this step complete per the package-skill convention, leaving back-fill out of scope.

## Stage: Implementation — TDD (2026-06-09T23:41:00Z)

### Session summary

Completed all four TDD steps: added `CacheKeyGate` with 7 unit tests; migrated `PermissionSession` and `AgentPrepHandler` to use two `readonly` gate sub-objects; removed the dead-in-production `shouldApplyCachedAgentStartState`; marked Phase 5 Step 4 complete in the architecture doc.
Test count: 1903 → 1902 (net −1: removed the dedupe test and four spy-based handler tests; added 7 `CacheKeyGate` unit tests and 2 behavior-driven handler tests).
All checks pass: `pnpm run check`, `pnpm run lint`, `pnpm run test`, `pnpm fallow dead-code`.

### Observations

- Step 2 was implemented as a single combined commit as planned: removing the four `PermissionSession` methods broke the handler and both test files simultaneously at the type level, so all consumer updates landed together.
  The `pnpm run check` type error list cleanly identified exactly the lines to rewrite.
- The `cache key methods` describe block in `permission-session.test.ts` (5 tests) was removed; the three lifecycle "clears cache keys" tests were rewritten to prime gates via `runIfChanged` and assert re-arming after the lifecycle call.
- The four spy-based handler tests (`vi.spyOn(session, "commitActiveToolsCacheKey")` etc.) were replaced with two behavior-driven tests: one asserting `setActive` is called exactly once across repeated identical calls, and one asserting repeated calls return `{}`.
- Pre-completion reviewer returned WARN (not FAIL): one unused `createActiveToolsCacheKey` import left over in `test/before-agent-start-cache.test.ts` after the dedupe test was removed; fixed by amending the step 3 commit before shipping.

## Stage: Final Retrospective (2026-06-10T03:51:36Z)

### Session summary

Shipped `#365` end-to-end across three stages (Planning, TDD, Ship) with one prescriptive roadmap already in place, one `ask_user` design decision, four clean TDD commits, and a clean release (`pi-permission-system-v10.8.0`).
The only rework was a single amend to drop an orphaned test import flagged by the pre-completion reviewer.
Execution was clean overall; the notable findings are diagnostic (model routing, lint-output truncation) rather than design or scope failures.

### Observations

#### What went well

- The planning stage found the design already prescribed in `docs/architecture/architecture.md` (Phase 5 Track B Step 4) and verified Track A (`#362`–`#364`) was closed before assuming no merge coordination — avoided a speculative concurrency worry the roadmap flagged.
- The `ask_user` gate on the gate-access pattern (`readonly` properties vs. delegating methods) resolved a genuine Law-of-Demeter trade-off up front, so the TDD stage had zero design churn.
- Step 2 was correctly planned and executed as one combined commit: the `pnpm run check` type-error list pinpointed exactly the call sites to migrate when the four `PermissionSession` methods were removed, so the big-bang consumer update landed in one green commit.

#### What caused friction (agent side)

- `missing-context` (feedback-loop) — the TDD stage ran `pnpm run lint 2>&1 | tail -5`, which kept only the `rumdl` (markdown) tail and the `Found 3 infos` summary, truncating away the biome `noUnusedImports` warning for the orphaned `createActiveToolsCacheKey` import left after the dedupe test was deleted.
  Biome reports unused imports at warning level (exit 0), so the lint gate stayed green and the pre-commit hook passed; only the pre-completion reviewer's full-output lint caught it.
  Impact: one `--amend` to the step 3 commit, no rework or follow-up commit.

#### What caused friction (user side)

- None.
  User involvement was a single design decision via `ask_user` (gate-access pattern), which was the right strategic call to surface.

### Diagnostic details

- **Model-performance correlation** — the entire Ship stage (push, CI watch, stacked-release batching judgment, release-PR body verification, `release_pr_merge`) ran on `opencode-go/deepseek-v4-flash`, a reasoning-weak model.
  It executed correctly, including the judgment call that `#365` is an independent track needing no release batching, but release-merge decisions are judgment-bearing; the prescriptive `/ship-issue` prompt and guard-railed `release_pr_*` tools carried most of the safety.
  Planning and TDD ran on stronger models (`claude-opus-4-8` / `claude-sonnet-4-6`).
- **Feedback-loop gap analysis** — `pnpm run check`, `pnpm run test`, and `pnpm run lint` were all run incrementally after each TDD step, not just at the end.
  The only gap was output *truncation* (`tail -5`) on the lint step, not timing — the verification ran at the right moment but its signal was clipped.
- **Escalation-delay / unused-tool lenses** — no `rabbit-hole` or `missing-context`-from-unexplored-code findings; no long error loops; no subagent that should have been dispatched but wasn't (the pre-completion reviewer was dispatched as designed).

### Changes made

1. Added a TDD-planning rule to `.pi/skills/testing/SKILL.md`: when a step deletes a test or test helper, re-check the file's remaining imports for orphans, since biome's `noUnusedImports` is warning-level (exit 0) and the pre-completion reviewer is the only backstop.
2. Recorded a bidirectional observation (no file change): the Ship stage ran on `opencode-go/deepseek-v4-flash`; routing the release-merge stage to a stronger model would harden the batch-vs-release-now judgment in `/ship-issue`.
