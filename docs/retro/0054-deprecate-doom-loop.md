---
issue: 54
issue_title: "Verify doom_loop detection fires end-to-end"
---

# Retro: #54 — Verify doom_loop detection fires end-to-end

## Final Retrospective (2026-05-03T17:00:00Z)

### Session summary

Investigated Pi's source and confirmed it has no doom_loop detection — the `special.doom_loop` config key was dead code inherited from OpenCode.
After a user-guided design discussion (implement detection vs. deprecate), deprecated the key following the existing `tool_call_limit` pattern.
Released as v3.5.0 with 7 commits across plan, TDD, docs, and ship.

### Observations

#### What went well

- The user's architectural redirect ("This is sounding outside the bounds of a permission system") prevented a layering violation.
  The agent had converged on "implement detection with configurable threshold" before the user pulled back.
  Providing the OpenCode architecture context (detection in session processor, not permission extension) then made the deprecation decision clear and well-reasoned.
- The `tool_call_limit` deprecation pattern gave a concrete precedent to follow.
  Every module change had a 1:1 parallel in the existing code, reducing ambiguity to zero.
- Ship was fully automated: CI green, release-please PR merged, v3.5.0 tagged with no manual intervention.

#### What caused friction (agent side)

- `wrong-abstraction` — The plan's TDD step ordering placed the existing-test-update step (step 5) after the feat step (step 2) that broke those tests.
  This forced ~5 minutes of deliberation about whether to commit a broken suite or deviate from the plan.
  The `/tdd-plan` prompt already says "fix [downstream breakage] as part of the same commit," so the correct behavior was clear, but the plan should have anticipated the breakage.
  Impact: added friction and internal deliberation but no rework — the deviation was handled correctly per the prompt.
- `missing-context` — During planning, I did not notice that `SPECIAL_PERMISSION_KEYS` and `DEPRECATED_SPECIAL_KEYS` are duplicated across `permission-manager.ts` and `config-loader.ts`.
  This meant the plan's step 2 (update `permission-manager.ts`) was incomplete — the config-loader copy also needed updating, which was deferred to step 4.
  Impact: no rework (the plan already had a step 4 for config-loader), but the duplication was not called out as a risk or noted in Background.

#### What caused friction (user side)

- The initial `ask_user` about "implement vs. deprecate" presented the implementation option first with more detail, which may have biased toward convergence on implementation before the user intervened.
  The user's own domain knowledge ("this sounds outside the bounds of a permission system") was the key input.
  No process change needed — the ask-user flow worked as designed and the user redirected effectively.

### Changes made

1. Added TDD step-ordering guideline to `AGENTS.md` § Testing: feat steps that change behavior must account for existing test breakage in the same step or a preceding step, never a later one.
