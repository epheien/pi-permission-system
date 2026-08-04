---
issue: 122
issue_title: "Support `?` single-character wildcard in permission patterns"
---

# Retro: #122 — Support `?` single-character wildcard in permission patterns

## Final Retrospective (2026-05-08T17:18:00-07:00)

### Session summary

Planned, implemented, shipped, and released (v5.14.0) support for the `?` single-character wildcard in permission patterns.
The implementation was a one-line change in `compileWildcardPattern` (replace escaped `\?` → `.` after `escapeRegExp`), 8 new tests, and doc updates to `configuration.md` and `opencode-compatibility.md`.
Three TDD commits landed exactly as planned with no rework or deviations.

### Observations

#### What went well

- Clean three-phase execution (plan → TDD → ship) with zero rework or user corrections.
- Issue #123 (trailing wildcard optionality) served as a near-identical template — same module, same test structure, same TDD rhythm — confirming `wildcard-matcher.ts` is well-factored for incremental wildcard features.
- The plan correctly identified the change as purely additive with no permission regression risk, which held true throughout implementation.

#### What caused friction (agent side)

- No friction observed.

#### What caused friction (user side)

- No friction observed.
