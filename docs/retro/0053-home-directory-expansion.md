---
issue: 53
issue_title: "Support ~/$HOME expansion in permission config patterns"
---

# Retro: #53 — Support ~/$HOME expansion in permission config patterns

## Final Retrospective (2026-05-05T03:09:00Z)

### Session summary

Implemented `~/` and `$HOME/` prefix expansion in wildcard permission patterns, shipping as v4.8.0.
The change adds a single utility (`src/expand-home.ts`) integrated into `compileWildcardPattern()`, making configs portable across machines.
Completed in 4 functional commits + 1 docs commit with zero regressions across 944 tests.

### Observations

#### What went well

- Integration point was surgically minimal — one import + one line in `compileWildcardPattern()` with zero changes to callers.
- The plan's prediction that step 6 ("no code change expected") would pass immediately was correct — the integration tests were green without additional work.
- Using the real `homedir()` in the integration test (`permission-manager-unified.test.ts`) avoided a complex `vi.mock` setup that would have risked breaking the file's `tmpdir()` dependency.

#### What caused friction (agent side)

- `instruction-violation` — First draft of `tests/expand-home.test.ts` used `await import("node:os")` inside a non-async function.
  AGENTS.md explicitly documents the `vi.hoisted()` + `vi.mock()` pattern, and `tests/bash-external-directory.test.ts` demonstrates the correct approach 4 lines in.
  Self-identified after autoformat/vitest failure.
  Impact: one file rewrite (< 30 seconds of rework, no wasted commits).

#### What caused friction (user side)

- None observed.
  The issue spec was detailed and unambiguous, including prior art and exact scope.
