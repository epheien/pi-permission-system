---
issue: 96
issue_title: "Subagent permission forwarding broken for all major pi-subagent extensions"
---

# Retro: #96 — Subagent permission forwarding broken for all major pi-subagent extensions

## Final Retrospective (2026-05-05T20:45:00Z)

### Session summary

Planned, implemented, and shipped broadened subagent env-var detection for nicobailon/pi-subagents and HazAT/pi-interactive-subagents, plus a multi-candidate parent-session resolver.
Released as v5.2.0 with 35 new tests.
The implementation was straightforward — the issue was well-specified with a concrete env var inventory.

### Observations

#### What went well

- The issue's env var inventory table made planning and implementation nearly mechanical — no research phase needed.
- TDD cycles were clean: no downstream breakage, no rework, all 5 steps landed on first attempt.
- The deprecated alias pattern (`SUBAGENT_PARENT_SESSION_ENV_KEY` kept as `candidates[0]`) was a low-cost backward-compatibility guard.

#### What caused friction (agent side)

- `instruction-violation` — Plan file committed without an H1 heading after YAML frontmatter, triggering markdownlint MD041 pre-commit failure.
  Every existing plan file has an H1, and MD041 is enabled by default.
  The `/plan-issue` prompt template shows frontmatter followed directly by `## Problem Statement` with no H1, which is the root cause.
  Self-identified after the commit hook failed.
  Impact: one failed commit + fix cycle, minor time waste.

#### What caused friction (user side)

- No meaningful friction from the user side.
  The issue was thorough, the related issues (#29, #97, #98) were already filed, and the "Proposed fix" section was concrete enough to skip the `ask-user` design decision gate entirely.

### Changes made

1. Updated `.pi/prompts/plan-issue.md` — added H1 heading requirement to the "Write the plan" template section.
