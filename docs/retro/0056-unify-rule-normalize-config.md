---
issue: 56
issue_title: "Unify Rule type and normalize config into flat Ruleset"
---

# Retro: #56 — Unify Rule type and normalize config into flat Ruleset

## Final Retrospective (2026-05-03T20:00:00-04:00)

### Session summary

Implemented `normalizeConfig()` in `src/normalize.ts` and `getSurfaceDefault()`/`mergeDefaults()` in `src/defaults.ts`, then refactored `PermissionManager` to store a flat `Ruleset` instead of per-surface compiled pattern arrays.
Removed `BashFilter`, six per-surface type aliases, and `AgentPermissions`/`GlobalPermissionConfig` — replaced by `ScopeConfig`.
Released as v3.9.0 with no user-visible behavior change.

### Observations

#### What went well

- The plan's decision to keep `defaultPolicy` separate from the `Ruleset` was validated by the MCP baseline auto-allow tests — if `defaultPolicy.mcp` had been a catch-all rule, the heuristic would have been bypassed.
  The analysis during planning correctly identified this constraint.
- Combining plan steps 12–14 into a single commit was the right call.
  Attempting separate commits would have introduced intermediate broken states for no reviewability benefit.

#### What caused friction (agent side)

1. `premature-convergence` — The plan confidently stated that `tools.bash: "allow"` normalizes to `{ surface: "bash", pattern: "*", action: "allow" }` and "naturally preserves both tool exposure and command fallback."
   This was wrong: `tools.bash` in the old model was a **fallback default** (consulted only when no bash pattern matches), not a **catch-all rule** (always matches and competes with specific patterns from other scopes).
   Six tests failed on the first run of the refactored `checkPermission()`.
   Impact: required reworking both `src/normalize.ts` (adding `TOOL_SURFACE_OVERRIDE_KEYS` to exclude `tools.bash`/`tools.mcp`) and `src/permission-manager.ts` (adding `bashDefault`/`mcpToolLevel` extraction), plus updating 3 normalize tests.
   The `bashDefault` cascade in the old `resolvePermissions()` was visible during planning but its semantic implications were not fully traced.
   Self-identified during the implementation phase.

2. `wrong-abstraction` — The plan listed steps 12, 13, and 14 as separate refactoring commits, but all three depend on the shared `ResolvedPermissions` type.
   Changing the type in step 12 immediately breaks `checkPermission()` (step 13) and `getToolPermission()` (step 14).
   Impact: added ~5 minutes of re-reading to determine they must be combined.
   No rework — the combination was straightforward — but the plan was misleading about commit granularity.

3. `instruction-violation` — The pre-commit biome hook rejected the type-alias removal commit due to an unused `getSurfaceDefault` import and a formatting inconsistency.
   Running `git commit --amend` after the fix silently folded the type-alias removal into the BashFilter removal commit instead of creating a separate commit.
   Impact: two logically distinct changes (BashFilter removal + type alias removal) landed in one commit.
   Self-identified via `git log` immediately after.

#### What caused friction (user side)

- The biome warnings in `src/index.ts` and `tests/handlers/before-agent-start.test.ts` were pre-existing but only flagged after the user asked to fix them.
  Proactively cleaning lint warnings during the "final verification" step (rather than noting them as pre-existing and moving on) would have avoided the extra round-trip.

### Changes made

1. Added `AGENTS.md` § Implementation Priorities bullet documenting `tools.bash`/`tools.mcp` as fallback overrides excluded from `Ruleset` normalization.
2. Added `AGENTS.md` § Testing bullet about folding tightly coupled TDD steps that share a type definition.
