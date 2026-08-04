---
issue: 288
issue_title: "Extract shared test fixtures to cut permission-system test duplication"
---

# Retro: #288 — Extract shared test fixtures to cut permission-system test duplication

## Stage: Planning (2026-05-31T00:00:00Z)

### Session summary

Produced a numbered migration plan for extracting duplicated test setup in `pi-permission-system/test/` into focused `test/helpers/` modules.
Grounded the clone families in a live `fallow dupes` run (122 groups, 9.1%) and confirmed the divergent `makeCheckResult` defaults across `gates/runner`, `gates/bash-path`, and `tool-call` copies.
Plan is a pure test refactor (no `src/` changes); next step is `/build-plan` since cycles are migrate → full-suite-green → commit, not red→green.

### Observations

- Three user-confirmed design decisions via `ask_user`: no co-located helper tests (transitive coverage), focused files by concern (mirror `pi-subagents/test/helpers/`), and a single neutral-default `makeCheckResult` with explicit per-call overrides.
- The divergent `makeCheckResult` defaults are the main correctness risk — `bash-path` uses `toolName: "path"`/`source: "special"`/`origin: "global"`; `runner` adds `matchedPattern: "*"`.
  Migration must pass each site's original fields as explicit overrides.
- Watch the testing-skill trap: do not annotate mock-bag factories (`makeHandler`, `makeRunnerDeps`) with the production interface, or `.mockReturnValue` access is erased.
- Keep the regression-guard import in `external-directory-integration.test.ts` — it intentionally fails the load if a message helper is removed.
- `permission-system.test.ts` is 2839 lines; only the targeted intra-file `createManager`/config clones are in scope — leave `withIsolatedSubagentEnv` and env handling untouched.
- Step 5 (lifecycle setup) and the ext-dir block's final home are flagged as open questions to settle during implementation.
- Initial `Write` hit an external-directory denial from a wrong absolute path (`/Users/chris/development/pi/pi-permission-system/...`); the repo root is `pi-packages`.
  Use repo-relative paths.

## Stage: Implementation — TDD (2026-05-31T14:45:00Z)

### Session summary

Completed all 6 migration steps from the plan: handler fixtures (Step 1), external-directory family (Step 2), gate fixtures (Step 3), manager harness (Step 4), lifecycle setup (Step 5), and docs refresh (Step 6).
Test count held steady at 71 files / 1628 tests throughout — pure refactor, no assertions changed.
Pre-completion reviewer returned WARN (resolved before shipping).

### Observations

- **Step 1** `makeCheckResult` signature change required converting positional-`state` calls in `tool-call-events.test.ts` to override-bag form with explicit `matchedPattern: "*"` where the original factory had it as a default.
  All other files used the neutral default safely.
- **Step 2** `makeToolCallEvent` in `external-directory-integration.test.ts` used `input` as a direct second argument (not wrapped); migrated all call sites to `{ input: {...} }` wrapper convention to align with the shared factory.
  No test failures.
- **Step 3** `makeCheckResult` defaults diverged across runner vs bash-path/path files; gate-fixtures introduces `makeGateCheckResult` (path defaults) alongside the neutral `makeCheckResult` from handler-fixtures to avoid verbose per-call overrides in the 20+ bash-path call sites.
- **Step 4** `CreateManagerOptions` was still used in `createManagerWithProject` in `permission-system.test.ts` after removing the local definition — needed an explicit import from the harness.
  The `TS2345` error at line 1170 (pre-existing latent type issue) was resolved as a side effect once `CreateManagerOptions` was properly imported.
- **Step 5** `makeSession` in `before-agent-start.test.ts` and `lifecycle.test.ts` have different method sets (different lifecycle phases), so only `makeCtx` was extracted.
  The 39-line fallow clone was primarily the `makeCtx` body.
- **WARN 1 resolved**: stale `PermissionGateHandler` import in `tool-call.test.ts` removed (biome lint warning, exit 0).
- **WARN 2 resolved**: `package-pi-permission-system` SKILL.md Testing section updated with `test/helpers/` layout and the divergent-default `makeCheckResult` override pattern.
- Pre-completion reviewer verdict: **WARN** (2 findings, both resolved before shipping).

## Stage: Final Retrospective (2026-05-31T18:56:41Z)

### Session summary

Single-session execution of the full lifecycle (plan → TDD → ship → retro) for the test-fixture extraction.
All 6 migration steps landed green, duplication dropped 9.1% → 7.1% (clone groups 122 → 113), and `pi-permission-system-v8.2.1` released cleanly.
The dominant friction was a recurring import-reconciliation slip when removing local factory definitions during migration — three instances, two caught by `tsc`, one that escaped both green-gates to the pre-completion reviewer.

### Observations

#### What went well

- The upfront `ask_user` in planning (three design decisions: no co-located helper tests, focused files by concern, single neutral-default `makeCheckResult`) paid off — zero design churn during implementation across all 6 steps.
- Incremental verification: `pnpm run check` + `vitest run` ran after every step (msgs 58, 65, 76, 79, 89, 96, 101), so each commit left the suite green; no broken-baseline commits.
- The `makeGateCheckResult` decision (Step 3) — introducing a path-surface factory alongside the neutral `makeCheckResult` rather than forcing four explicit overrides at 20+ bash-path call sites — was a sound mid-implementation judgment that stayed within the plan's intent.
- The pre-completion reviewer was the only safety net that caught the stale `PermissionGateHandler` import; the deterministic green-gates (`check`, `lint`) both passed it.

#### What caused friction (agent side)

- `missing-context` — import reconciliation after removing local factory definitions (recurring, 3 instances).
  In `bash-path.test.ts` the removed `PermissionCheckResult` import was still used by the `CheckPermissionFn` type alias (`tsc` caught it, msg 76-78); in `permission-system.test.ts` the removed local `CreateManagerOptions` was still referenced by `createManagerWithProject` (`tsc` caught two errors, msg 89-95); in `tool-call.test.ts` the now-unused `PermissionGateHandler` value import was left behind and escaped to the reviewer.
  Impact: 2 extra edit+recheck cycles (~6 tool calls) plus 1 post-reviewer cleanup commit (67259f66).
- `other` (tooling) — the multi-block `Edit` on `tool-call.test.ts` failed on whitespace matching (msg 41); fell back to full-file `Write`.
  A `cat -A` diagnostic also failed (macOS `cat` lacks `-A`).
  Impact: ~2 extra tool calls; no rework.
- `instruction-violation` (self-identified) — the first plan-file `Write` targeted `/Users/chris/development/pi/pi-permission-system/...`, dropping the `pi-packages` repo segment, and hit an external-directory denial (msg 18-20).
  Self-corrected in one retry with a repo-relative path.
  Impact: 1 wasted `Write` + 1 diagnostic `bash`.

#### What caused friction (user side)

- None substantive.
  The three `Continue.` nudges (msgs 64, 70, 74, 121, 127) were mechanical pacing prompts, not redirections — the work was on-track at each.

### Diagnostic details

- **Model-performance correlation** — no mismatches.
  Planning + retro ran on `claude-opus-4-8` (judgment-heavy synthesis), TDD on `claude-sonnet-4-6` (mechanical migration), the pre-completion reviewer subagent on `anthropic/claude-sonnet-4-6` (judgment-heavy review), and shipping on `opencode-go/deepseek-v4-flash` (deterministic checklist).
  Each model was well-matched to task complexity; the cheap flash model on the mechanical ship checklist is appropriate cost optimization, not a mismatch.
- **Feedback-loop gap analysis** — `check` and `vitest` ran per-step, but `pnpm run lint` ran only at the end (msg 109).
  The decisive gap: `pnpm run lint` exits 0 on biome *warnings*, and an unused value import is a warning — so the stale `PermissionGateHandler` import passed both `pnpm run check` (tsc does not flag unused imports without `noUnusedLocals`) and the `pnpm run lint` exit code.
  Only the reviewer's reading of the biome warning output caught it.
- **Unused-tool detection** — a `grep` for each removed symbol before deleting its import would have pre-empted all three `missing-context` instances; `grep` was available and used elsewhere but not systematically before import removal.

### Follow-up proposal

A `testing`-skill bullet capturing the import-reconciliation step and the biome-warning gotcha was proposed but declined by the user — the observation lives here in the retro only.
If the import-reconciliation slip recurs in a future session, revisit promoting it to the `testing` skill.

### Changes made

1. Appended this Final Retrospective stage entry to `packages/pi-permission-system/docs/retro/0288-extract-shared-test-fixtures.md`.
   No prompt or `AGENTS.md` changes — the user chose to record the import-reconciliation observation in the retro only.
