---
issue: 249
issue_title: "Bash external-directory gate ignores config-level allow rules for /tmp/* paths"
---

# Retro: #249 — Bash external-directory gate ignores config-level allow rules for /tmp/* paths

## Stage: Planning (2026-05-28T18:00:00Z)

### Session summary

Planned a two-step TDD fix for the `uncoveredPaths` filter in `describeBashExternalDirectoryGate`.
The core fix changes the filter predicate from `source !== "session"` to `state !== "allow"`, and replaces the path-less `extCheck` call with a worst-check computation over uncovered paths.

### Observations

- The sibling gates (`path.ts`, `bash-path.ts`) already use `check.state` for filtering — `bash-external-directory.ts` is the outlier.
- `deriveSource()` maps `external_directory` to `"special"` for all non-session rules, making source-based filtering unable to distinguish config allow from config ask/deny.
- The path-less `extCheck` call is a secondary bug: it always returns the `"*"` catch-all, potentially downgrading a `"deny"` to `"ask"`.
- One existing test ("uses config-level checkPermission for the policy state") explicitly asserts the buggy behavior and must be rewritten.
- The bypass log event says `"session_approved"` even when the bypass comes from config — noted as cosmetic, deferred.

## Stage: Implementation — TDD (2026-05-28T10:24:00Z)

### Session summary

Completed 2 TDD cycles in one session.
Step 1 fixed the core filter bug (`source !== "session"` → `state !== "allow"`) and replaced the path-less `extCheck` with a worst-check over uncovered paths.
Step 2 added mixed-state path coverage tests (config-allow+ask, config-deny+ask).
Test count: 1494 → 1497 (+3 net; the rewritten test replaced one buggy test and two new tests were added).

### Observations

- The `reduce` initial seed caused the first entry to be evaluated twice; amended to `find(...)?? uncoveredEntries[0].check` per the pre-completion reviewer's suggestion — cleaner and more explicit.
- Pre-completion reviewer: **PASS** (one WARN about the reduce seed, addressed by amending the final commit).
- No architecture docs needed updating — the change is internal to `bash-external-directory.ts`'s filter logic.

## Stage: Final Retrospective (2026-05-28T20:00:00Z)

### Session summary

Issue #249 completed across four stages (planning, TDD, shipping, retro) in a single multi-session context.
The core fix was clean — two TDD cycles, +3 tests, pre-completion reviewer PASS.
Shipping surfaced an unrelated release-please misconfiguration that required a side-quest to resolve.

### Observations

#### What went well

- The issue was well-specified with a clear proposed fix, which made planning and TDD straightforward.
- The pre-completion reviewer caught a minor `reduce` seed redundancy and suggested a cleaner `find(...)` alternative, which was adopted before merging.
- The `ask_user` flow during the release-please side-quest correctly surfaced the `exclude-paths` vs `hidden` vs convention tradeoff, letting the user choose.
- The `web_search` + `fetch_content` → source code inspection chain definitively answered the glob-support question by reading the actual `CommitExclude` implementation.

#### What caused friction (agent side)

- `premature-convergence` — The initial release-please fix set `"hidden": true` on the entire `docs` changelog section without considering that README.md updates are user-facing.
  Impact: user caught it, requiring a revert + new approach via `exclude-paths` (two commits where one would have sufficed).
  The agent should have asked whether all `docs:` commits should be excluded before applying a blanket fix.
- `scope-drift` — The release-please side-quest was necessary but unplanned.
  Impact: added ~20 tool calls to the shipping stage; no rework on the core issue, but the session expanded significantly.

#### What caused friction (user side)

- The release-please misconfiguration (`docs:` commits triggering releases) pre-dated this session.
  Earlier awareness of the `changelog-sections` hidden semantics could have prevented the unexpected `pi-session-tools-v1.0.1` release.
  Opportunity: a CI check or documentation of `exclude-paths` maintenance would catch this proactively.

### Diagnostic details

- **Model-performance correlation** — Four models used across the session: claude-opus-4-6 (planning), claude-sonnet-4-6 (TDD), deepseek-v4-flash (shipping), claude-opus-4-6 (release-please fix + retro).
  The deepseek-v4-flash model on shipping performed the mechanical push/CI/close steps correctly but applied `"hidden": true` without considering downstream impact — a judgment call that needed a stronger model or an `ask_user` gate.
- **Feedback-loop gap analysis** — Verification was incremental during TDD (test after each step, full suite + check + lint + fallow after final step).
  No gap detected in the core issue work.

### Changes made

1. `AGENTS.md` — Added `exclude-paths` maintenance rule to Monorepo Structure section.
2. `.pi/prompts/ship-issue.md` — Added step 3 in § 6 (Merge release-please PR): check which packages the PR bumps before merging; flag unrelated bumps to the user.
