---
issue: 81
issue_title: "Unify checkPermission() surface branching into single evaluate path"
---

# Retro: #81 — Unify checkPermission() surface branching into single evaluate path

## Final Retrospective (2026-05-05T02:00:00Z)

### Session summary

Replaced the ~200-line `if/else if` surface chain in `checkPermission()` with a unified path: `normalizeInput()` → `evaluateFirst()` → `deriveSource()`.
Extracted MCP target derivation to `src/mcp-targets.ts` and surface-specific input normalization to `src/input-normalizer.ts`.
Session rules are now appended to the composed ruleset for last-match-wins evaluation rather than checked in a separate per-branch pre-check.
Released as v4.5.0 with +76 new tests (814 → 890) and no permission decision changes.

### Observations

#### What went well

- The 8-step TDD plan mapped cleanly onto incremental commits — each step was independently testable and committable with no rework needed between steps.
- The `evaluateFirst` / `normalizeInput` / `deriveSource` decomposition kept the unified `checkPermission()` body under 30 lines while preserving all source-field semantics.
- Step 5 (session rules) tests passing immediately confirmed the refactor was behavior-preserving — the tests served as a regression guard rather than driving new behavior.

#### What caused friction (agent side)

1. `wrong-abstraction` — In step 4, wrote a test comment correctly describing "`evaluateFirst` stops at first non-default match" but then wrote assertions expecting the *opposite* result (the second candidate).
The confusion was between `evaluate`'s last-match-wins (scanning rules backwards) and `evaluateFirst`'s first-non-default-wins (scanning candidates forwards) — two different "which wins" semantics over different dimensions.
The user caught this and asked for an explanation.
Impact: one test rewrite, plus the user spent time understanding the error.

2. `missing-context` — In step 3, used `require()` in a test to dynamically import `createMcpPermissionTargets`.
The project uses ESM exclusively and `AGENTS.md` says "Use standard top-level imports only."
Self-identified after the test run failed with a `require` error.
Impact: one small fix, no rework beyond the immediate correction.

3. `premature-convergence` — In step 6, changed `makeManagerWithConfig()` return type from `PermissionManager` to `{ manager, cleanup }` but didn't update the 8 existing call sites in the same edit.
Self-identified when reviewing the test file state.
Impact: added friction but no rework — the callers were updated to use `makeManager()` (which was the correct helper for those tests anyway).

#### What caused friction (user side)

- The session disconnected mid-step-6 while implementing the unified `checkPermission()`.
Recovery was clean — the agent checked `git log` and `git status` to resume — but the user had to re-engage and confirm state.
