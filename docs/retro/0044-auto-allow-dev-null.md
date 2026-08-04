---
issue: 44
issue_title: "Auto-allow /dev/null in external directory checks"
---

# Retro: #44 — Auto-allow /dev/null in external directory checks

## Final Retrospective (2026-05-03T14:30:00Z)

### Session summary

Planned, implemented, shipped, and released (v3.2.0) a hardcoded allowlist of safe OS device paths (`/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`) that are excluded from the `external_directory` permission gate.
The change touched one source file (`src/external-directory.ts`) and two test files, with a docs update to `README.md`.
The user challenged the security model mid-planning ("could agents use `/dev/null` to destroy files?"), which strengthened the plan's Risks section.

### Observations

#### What went well

- The user's security challenge during planning ("should this be a setting?") prompted a thorough analysis of `cat /dev/null > file` scenarios.
  This analysis showed that the external-directory gate never protected against in-CWD truncation (the tokenizer splits on `>`, so the redirect target and `/dev/null` are separate tokens).
  The resulting two new Risks rows made the plan more defensible and the commit history shows the reasoning for future readers.
- TDD steps 5–6 collapsed into one commit because `extractExternalPathsFromBashCommand` delegates to `isPathOutsideWorkingDirectory`.
  Recognizing the transitive coverage during execution avoided an unnecessary implementation commit without losing test coverage.

#### What caused friction (agent side)

- `instruction-violation` — Used a literal `|` inside a backtick span in a markdown table cell in the plan.
  Markdownlint's MD056 does not exempt inline code from column-count validation, so the pre-commit hook rejected the commit.
  Required a follow-up edit to escape as `\|`.
  Impact: one failed commit attempt + one fixup edit.
  Self-identified after the lint failure (not user-caught).

#### What caused friction (user side)

- No friction observed.
  The user's mid-planning challenge was well-timed — it arrived after the initial plan was committed but before implementation, which is the ideal moment for security review.

### Changes made

1. No `AGENTS.md` or prompt changes — the pipe-in-table escape rule was proposed but the user declined it (the lint catches it anyway).
