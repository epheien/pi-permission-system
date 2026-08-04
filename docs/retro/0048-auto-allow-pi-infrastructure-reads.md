---
issue: 48
issue_title: "Auto-allow reads from Pi package and agent directories in external_directory checks"
---

# Retro: #48 — Auto-allow reads from Pi package and agent directories in external_directory checks

## Final Retrospective (2026-05-05T04:42:00Z)

### Session summary

Implemented Pi infrastructure read auto-allow for the `external_directory` gate.
Read-only tools (`read`, `find`, `grep`, `ls`) targeting Pi infrastructure directories now bypass the gate entirely.
Shipped as v4.9.0 with full test coverage (43 new tests), schema/docs updates, and an optional `piInfrastructureReadPaths` config field for user-configured extras.

### Observations

#### What went well

- The user's early intervention ("Is `npm root -g` safe?
  What about Homebrew/pnpm/bun?") redirected the design toward `import.meta.url` self-discovery before any code was written — avoiding a fragile subprocess-based approach that would have required package-manager detection logic.
- The `isPiInfrastructureRead` pure function design made testing straightforward — no mocks needed for the core logic, just pass in directories and tool names.
- The plan's separation of "static infra dirs at construction" vs "config extras at call time" resolved the timing issue cleanly without requiring runtime rebuilds on config reload.

#### What caused friction (agent side)

- `other` — Adding `piInfrastructureReadPaths: undefined` to `DEFAULT_EXTENSION_CONFIG` broke 3 existing tests that used `assert.deepEqual` against inline objects without the new key.
  Required reading the test failures, understanding `deepEqual` semantics for explicit-undefined-vs-missing-key, then restructuring `normalizePermissionSystemConfig` to conditionally set the field.
  Impact: one extra fix cycle and a commit that combined the fix with the feat.
- `other` — Inserting an `else` branch into the external-directory gate in `src/handlers/tool-call.ts` opened a brace but didn't close it, causing a parse error.
  The structural edit required both the opening and closing to be in one edit, but the closing point was ~80 lines away from the opening.
  Impact: autoformat failure, required reading the affected region and fixing the brace in a follow-up edit.
- `premature-convergence` — First attempt at the test file edit (step 3) produced a mangled duplicate test declaration (`test("...", () => {  // eslint-disable-next-line\n  test("...", () => {`).
  The edit tried to insert a comment before a test but duplicated the test header instead.
  Impact: biome parse error, required full file rewrite.

#### What caused friction (user side)

- No significant friction from the user side.
  The early design question about `npm root -g` safety was well-timed and prevented wasted work.

### Changes made

1. Added rule to `AGENTS.md` § Configuration about optional config fields and `undefined` in `DEFAULT_EXTENSION_CONFIG`.
