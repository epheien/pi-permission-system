---
issue: 368
issue_title: "Remove the `config-modal` controller reach-through"
---

# Retro: #368 — Remove the `config-modal` controller reach-through

## Stage: Planning (2026-06-12T00:00:00Z)

### Session summary

Planned the removal of the Law-of-Demeter reach-through in the `/permission-system show` handler (Phase 5 Step 7, Track D).
The plan collapses the controller's `permissionManager` + `session` fields into one `getActiveAgentConfigRules(): Ruleset` accessor, wired as a thin adapter closure in `index.ts`, and retires the `fallow` false-positive suppression on `PermissionSession.lastKnownActiveAgentName`.
The change is non-breaking (package-internal type, unchanged `show` output) and lands as one atomic refactor commit plus a separate doc commit marking the roadmap step complete.

### Observations

- Issue author is the operator (`gotgenes`); the proposed change is unambiguous and passes the `code-design` check (the accessor returns a value, so it is real encapsulation, not procedure-splitting) — skipped the `ask-user` gate.
- The retro for plan `0341` was the key prior-context find: `fallow`'s blind spot is object-literal wiring in `index.ts` (config-modal receives `session` as an object-literal property, not a traced positional arg).
  A named-interface attempt there did **not** satisfy `fallow`.
  The plan's premise is that moving the read into a real arrow-function body (`session.lastKnownActiveAgentName` inside the closure) makes it a directly traced property access — the one case `fallow` can follow — which is what makes retiring the suppression safe.
- The only empirical unknown is whether `fallow dead-code` actually stops flagging the getter; the plan carries a documented fallback (restore a single justified suppression) so the unknown does not block.
- The interface change breaks `index.ts` wiring and all four `config-modal.test.ts` controller literals at the type level in the same commit, so they fold into one TDD step per the AGENTS.md rule on constructed call sites.
- `getComposedConfigRules` always returns a `Ruleset` (never `undefined`), so the accessor needs no optionality and the existing empty-ruleset/`summarizeConfig` behavior is preserved.

## Stage: Implementation — TDD (2026-06-12T08:30:00Z)

### Session summary

Executed the single TDD cycle: updated all four controller literals in `test/config-modal.test.ts` to the `getActiveAgentConfigRules` shape (Red — 4 type errors confirmed), then updated `src/config-modal.ts`, `src/index.ts`, and `src/permission-session.ts` (Green).
All 93 test files / 1951 tests stayed green; committed as one atomic `refactor:` commit.
A separate `docs:` commit marked Phase 5 Step 7 complete in `docs/architecture/architecture.md`.

### Observations

- The key risk — `fallow` still flagging `lastKnownActiveAgentName` — did **not** materialise.
  Moving the read into a real arrow-function body in `index.ts` (`session.lastKnownActiveAgentName`) was sufficient for `fallow` to trace it; the `fallow-ignore-next-line` suppression is fully retired.
- All four controller literals in `test/config-modal.test.ts` were updated atomically; TypeScript's excess-property checking at `pnpm run check` caught any that might have been missed.
- The `summarizeConfig` optional `rules?` parameter did not need to change — the accessor always returns a defined `Ruleset`, and the existing behavior (empty ruleset → no rule-suffix) is preserved without optionality.
- Pre-completion reviewer: **PASS** — no WARN findings.

## Stage: Final Retrospective (2026-06-12T09:00:00Z)

### Session summary

Shipped the `config-modal` Law-of-Demeter refactor across four stages (Planning, TDD, Ship, Retro) in one continuous session with zero rework, zero user corrections, and zero deviations from the plan.
The `refactor:` + `docs:` commits landed on `main`, CI passed, issue #368 closed, and no release-please PR was triggered (expected for non-`feat`/`fix` commits).

### Observations

#### What went well

- The cross-session context bridge proved its value concretely.
  The Planning stage read `docs/retro/0341-*.md`, extracted the precise `fallow` blind-spot diagnosis (object-literal wiring is untraceable; a named-interface attempt did not satisfy `fallow`), and built the plan's central hypothesis on it: move the read into a real arrow-function body in `index.ts` so `fallow` traces it directly.
  That hypothesis held in the TDD stage — `fallow dead-code` stopped flagging `lastKnownActiveAgentName` and the suppression was fully retired.
  A prior session's retro directly shaped a later session's design and the prediction came true.
- Model selection matched task type at every stage with no mismatch (see Diagnostic details).
- The TDD Red phase used `pnpm run check` (type errors) as the failing signal rather than a runtime assertion — correct for a pure interface-shape refactor where Vitest does not typecheck and the four controller literals break only at the type level.

#### What caused friction (agent side)

- None.
  No rework, no follow-up fixup commits, no rabbit-holes, no instruction violations across all four stages.

#### What caused friction (user side)

- None.
  The issue was the operator's own, unambiguous, and non-breaking, so the `ask-user` gate was correctly skipped at Planning; no mid-session intervention was needed.

### Diagnostic details

- **Model-performance correlation** — Planning ran on `claude-opus-4-8` (judgment-heavy: design decision, `code-design` heuristic check, cross-retro synthesis); TDD and Ship ran on `claude-sonnet-4-6` (mechanical execution of a well-specified plan and a deterministic ship checklist); Retro ran on `claude-opus-4-8` (synthesis).
  The `pre-completion-reviewer` subagent ran during TDD and returned PASS in ~162 s.
  No mismatch — no reasoning-weak model on judgment work, no high-cost model on pure mechanics.
- **Feedback-loop gap analysis** — verification was incremental, not end-loaded: green baseline confirmed before any edit; Red confirmed via `pnpm run check` immediately after the test edit; `pnpm run check` + single-file Vitest + full-suite Vitest + `pnpm fallow dead-code` all run before the refactor commit; `lint:md` before the docs commit.
  Each gate fired at the transition it guards rather than batched at the end.
- **Escalation-delay / unused-tool lenses** — N/A; no `rabbit-hole` or `missing-context` friction occurred.

### Changes made

1. `.pi/skills/fallow/SKILL.md` (gotcha #6) — added a third remedy for the object-literal-wiring blind spot: move the read into a traced closure body at the composition root (e.g. `getX: () => owner.member`), demoting suppression to last resort.
   Evidence: issues #341 (discovered + suppressed) and #368 (resolved by restructuring) are the same recurring pattern.
