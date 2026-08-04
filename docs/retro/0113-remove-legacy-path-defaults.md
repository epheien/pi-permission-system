---
issue: 113
issue_title: "refactor: remove legacy path defaults from logging and extension-config"
---

# Retro: #113 — remove legacy path defaults

## Final Retrospective (2026-05-08T04:15:00Z)

### Session summary

Removed four legacy extension-root path constants (`CONFIG_PATH`, `LOGS_DIR`, `DEBUG_LOG_PATH`, `PERMISSION_REVIEW_LOG_PATH`), four dead config functions (`loadPermissionSystemConfig`, `savePermissionSystemConfig`, `getPermissionSystemConfigPath`, `ensurePermissionSystemConfig`), and made `PermissionSystemLoggerOptions` fields required.
Updated three test files that imported removed symbols.
Released as v5.11.2.

### Observations

#### What went well

- Very clean execution — 4 implementation commits, all green on first attempt, zero rework.
- Parallel context gathering (issue + `AGENTS.md` + plans dir + source files) in the plan phase kept total time low.
- The plan's file-by-file impact analysis correctly identified every consumer of the removed symbols — no surprise breakages during TDD execution.

#### What caused friction (agent side)

- `instruction-violation` — The plan's markdown table separator used `|---|---|` instead of `| --- | --- |`, failing the `markdownlint-cli2` pre-commit hook (MD060).
  Self-identified (caught by pre-commit, fixed before user intervention).
  The markdown-conventions skill mentioned compact table style but lacked a separator example.
  Impact: one failed commit + immediate fix, ~15 seconds.

#### What caused friction (user side)

- No friction observed.
  The issue body was comprehensive with exact file and function names, making plan and execution straightforward.

### Changes made

1. Added table separator example to `.pi/skills/markdown-conventions/SKILL.md` to prevent recurring MD060 pre-commit failures.
