---
issue: 91
issue_title: "Bash external-directory guard false-positive on sed regex containing absolute-path-like patterns"
---

# Retro: #91 — Bash external-directory guard false-positive on sed regex containing absolute-path-like patterns

## Final Retrospective (2026-05-05T17:05:00Z)

### Session summary

Planned, implemented, and shipped command-aware path extraction for pattern-first commands (sed, awk, grep, rg, sd) in the bash external-directory guard.
The key design insight — using the tree-sitter command name to guide argument classification rather than adding more character heuristics — came from the user's strategic redirections.
Released as v5.1.0.

### Observations

#### What went well

- User's two redirections ("the command definitely matters" and "unite our approaches") fundamentally improved the design from a heuristic band-aid to a principled command-aware architecture.
  Without them, the plan would have been another `REGEX_METACHAR_PATTERN` extension.
- Studying OpenCode's `shell.ts` (user-directed) revealed a clean reference implementation and clarified the design space: strict allowlist vs. heuristic fallback vs. hybrid.
- Implementation was clean — the feat commit landed all 89 tests green on the first run, and all 5 edge-case tests passed without additional code changes.

#### What caused friction (agent side)

1. `premature-convergence` — Initially designed the plan around character-based heuristics (`{`, `}`, `!`, `;` rejection in `classifyTokenAsPathCandidate`) without questioning whether the command-blind approach was fundamentally flawed.
   The user had to explicitly ask "Step back.
   Examine our overall approach" and point to OpenCode.
   Impact: the first draft plan was discarded and rewritten with the command-aware design.

2. `instruction-violation` (user-caught) — Used `test.todo` in step 6 instead of writing a concrete assertion.
   The plan said "add `test.todo` or comment" which was ambiguous, but the better choice was always a real test.
   The user caught it ("Wait, we have a todo in our tests?") and it was fixed by amending the commit.
   Impact: one extra amend cycle, minor.

#### What caused friction (user side)

- The initial `/plan-issue` invocation produced a plan the user needed to redirect twice before it matched their vision.
  Earlier sharing of the OpenCode reference (or asking "have you seen how X handles this?") could have saved a round of planning.
  The user's interventions were well-timed and specific — each one unblocked progress immediately.

### Changes made

1. `AGENTS.md` § Testing — added rule preferring concrete assertions over `test.todo`.
