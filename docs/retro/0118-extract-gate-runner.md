---
issue: 118
issue_title: "refactor: extract gate runner so gates become pure descriptor functions"
---

# Retro: #118 — extract gate runner so gates become pure descriptor functions

## Final Retrospective (2026-05-07T03:26:00Z)

### Session summary

Planned and executed a refactoring that converts all four gate functions (`tool`, `skill-read`, `external-directory`, `bash-external-directory`) from side-effectful functions with 7-field dep interfaces into pure descriptor factories.
A single `runGateCheck()` runner now handles the check→log→emit→approve cycle, subsuming #112.
Released as v5.6.0 with zero behavioral change.

### Observations

#### What went well

- **Lift-and-shift migration**: keeping `evaluate*` alongside `describe*` through steps 3–6 meant the full test suite (1216 tests) stayed green at every commit.
  The final removal in step 7 was a clean delete.
- **`preCheck` field deviation**: the plan didn't anticipate that `describeToolGate` needs `PermissionCheckResult` for message formatting.
  Adding `preCheck` to the descriptor type was a pragmatic deviation that preserved purity without a double `checkPermission` call — worked on first try.
- **Runner tested once, gates tested purely**: the runner's 16 tests cover all resolution paths; gate tests became simple input→output assertions with zero mocks.

#### What caused friction (agent side)

- `missing-context` — In step 5, created `runnerDeps` inside the `if (skillDescriptor)` block, then referenced it from the external-directory gate section outside that scope.
  Caused a `ReferenceError` caught by one integration test.
  Impact: one extra edit cycle to hoist the declaration (~30 seconds).
- `missing-context` — After hoisting shared `runnerDeps` in step 5, forgot the tool gate section (from step 3) already had its own `const runnerDeps`.
  Biome caught the redeclaration.
  Impact: one extra edit to remove the duplicate.
- `missing-context` — When removing per-gate dep interfaces in step 7, `ToolGateDeps["emitDecision"]` and `ToolGateDeps["checkPermission"]` type annotations remained in `src/handlers/tool-call.ts`.
  Impact: one additional edit to switch to `GateRunnerDeps` references, caught by build.
- `other` — Autoformat reordered imports in `src/handlers/gates/skill-read.ts` between edits, causing the next `Edit` call's `oldText` to not match.
  Used full file rewrite instead.
  Impact: one extra tool call, no rework.

#### What caused friction (user side)

- None observed — the user's involvement was limited to plan/TDD/ship commands and one clarifying question about terminology ("descriptor factories"), which was reasonable given the plan's jargon.
