---
issue: 55
issue_title: "Extract pure evaluate() function from PermissionManager"
---

# Retro: #55 — Extract pure evaluate() function from PermissionManager

## Final Retrospective (2026-05-03T17:15:00Z)

### Session summary

Extracted `Rule`, `Ruleset`, `getDefaultAction()`, and `evaluate()` into `src/rule.ts`, added `wildcardMatch()` to `src/wildcard-matcher.ts`, and refactored all five surface branches of `PermissionManager.checkPermission()` to delegate to `evaluate()`.
Released as v3.6.0 with 23 new tests and zero behavioral change.

### Observations

#### What went well

- **Reference equality pattern for synthetic-vs-explicit detection.**
  `compiledToRuleset()` returns `Rule` objects that `evaluate()` returns by reference when matched.
  `ruleset.includes(rule)` cleanly distinguishes explicit matches from the synthetic default without modifying the `Rule` type.
  This keeps `Rule` minimal for #56.
- **Self-caught semantic drift in skill branch.**
  The initial refactor of the skill branch passed `""` as the pattern when `skillName` was not a string, which would have matched a `"*"` wildcard skill rule — changing behavior.
  Caught before committing and preserved the original guard.
  Impact: no rework, but close to a subtle permission regression.

#### What caused friction (agent side)

- `missing-context` — Used `Array.prototype.findLast` (ES2023) in `evaluate()` despite the tsconfig targeting ES2022.
  Not caught until step 13 (`npm run build`), requiring an extra fix commit (`1911f37`).
  The existing codebase already uses manual backwards loops in `findCompiledWildcardMatch`, which should have been the signal.
  Impact: one extra commit and a wasted typecheck cycle; no rework to tests or other code.
  Self-identified at the typecheck step.
- `scope-drift` — Plan prescribed 6 separate TDD steps (2–7) for `getDefaultAction` and `evaluate()` tests, but these naturally formed a single red-green cycle for a pure function with no side effects.
  Collapsed into one commit without loss.
  Impact: added friction reading the plan but no rework.

#### What caused friction (user side)

- No friction observed — the plan was clear and the issue was well-scoped with explicit "what changes" and "what doesn't change" sections.

### Changes made

1. Added ES2022 target constraint rule to `AGENTS.md` § Code Style.
