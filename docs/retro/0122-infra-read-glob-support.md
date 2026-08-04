---
issue: 122
issue_title: "piInfrastructureReadPaths doesn't support glob patterns (**), causing confusing fallback to external_directory"
---

# Retro: #122 — Glob support for `piInfrastructureReadPaths`

## Final Retrospective (2026-05-22T17:00:00Z)

### Session summary

Added `*` and `?` wildcard support to `piInfrastructureReadPaths` by routing glob-containing entries through the existing `wildcardMatch()` in `isPiInfrastructureRead()`.
Also fixed a pre-existing silent bug where `~` expansion never worked for plain directory entries.
Shipped as `pi-permission-system` v7.1.0.

### Observations

#### What went well

- The feature was a 4-line logic change in one function (`isPiInfrastructureRead` in `src/path-utils.ts`), reusing `wildcardMatch()` and `expandHomePath()` with zero new dependencies.
  This is a direct payoff from prior refactorings (#48, #110) that extracted `isPiInfrastructureRead` as a pure function and kept wildcard matching in a single composable module.
- The `~` expansion bug was discovered during planning (grepping for `expandHomePath` in `path-utils.ts` found no import) and fixed as a natural side effect of the implementation — no extra step needed.
- TDD cycle was zero-rework: 5 expected failures in the red phase, all green on first implementation, no unexpected downstream breakage across 1467 tests.

#### What caused friction (agent side)

- `missing-context` — The docs commit (`94fa688`) used `**` in the `piInfrastructureReadPaths` example pattern, copying the reporter's original syntax without noting that `**` and `*` are identical in this system's wildcard matcher.
  The user caught this and made a corrective commit (`00563dc`).
  Impact: one follow-up commit to fix misleading examples; no rework to code or tests.
  User-caught.
- `instruction-violation` — The `/ship-issue` prompt template wrapped commit SHAs in backticks (`` `<sha>` ``), which prevents GitHub's auto-linking in issue comments.
  The user noticed the SHAs in a prior closed issue weren't clickable and traced it to the template.
  Impact: one fix commit (`5f7665b`) to `.pi/prompts/ship-issue.md`; added friction but no code rework.
  User-caught.

#### What caused friction (user side)

- No significant friction.
  The user's mid-session redirect about `**` vs `*` semantics was well-timed and led to cleaner documentation.

### Changes made

1. Retro file created at `packages/pi-permission-system/docs/retro/0122-infra-read-glob-support.md`.
