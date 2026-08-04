---
issue: 525
issue_title: "pi-permission-system: extract shared fixtures from permission-manager-unified.test.ts"
---

# Retro: #525 — Extract shared config-harness fixtures from `permission-manager-unified.test.ts`

## Stage: Planning (2026-07-05T00:00:00Z)

### Session summary

Planned Phase 8 Step 1: extracting the repeated config-harness scaffolding from the 3,745-line `test/permission-manager-unified.test.ts` into the shared `test/helpers/manager-harness.ts`.
Inventoried the seven file-local factories and their call-site counts (`makeManagerWithConfig` alone has 62), plus 11 inline `sessionRules` literals and the two `platform: "win32"` sites that must keep the in-memory loader factory exported independently.
Produced a 7-step behavior-preserving refactor plan (six `test:` extraction commits, one `docs:` roadmap-completion commit) and committed it as `0525-extract-manager-unified-fixtures.md`.

### Observations

- This planning session's file is deliberately separate from the pre-existing `0525-phase-8-roadmap.md` retro, which belongs to the roadmap-planning session (its frontmatter has no `issue:` field; it is the phase retro that happens to share the number of the first-filed issue).
- Design decision: collapse the two factories that merely re-shape an existing builder's input (`makeManagerWithConfig`, `makeManagerWithScopes`) into thin delegators over `createManager` / `createManagerWithProject`, so the clone disappears rather than relocating; move the three genuinely distinct patterns (missing-config, in-memory, agentDir) as new named builders.
- Rejected extracting the repeated test act/assert bodies (agent-frontmatter blocks at ~2494 / ~2523) — the `testing` skill is explicit that the repeated system-under-test call is the subject, not duplication to remove.
- Scoped out the two single-instance inline blocks (MCP-settings ~2270, `PI_CODING_AGENT_DIR` ~2911): they are not clones and carry test-specific extra setup, so no follow-up issue is warranted.
- Release nuance recorded in the plan: roadmap tag is `Release: independent`, but every commit is `test:` (hidden changelog type), so the plan lands on `main` and auto-batches into the next release-bearing change rather than cutting one itself.
- Current `fallow dupes` shows only 3 clone pairs in the file (fewer than the roadmap's 24 groups — the file has evolved); the plan targets the harness patterns structurally rather than chasing the stale count.
- No `ask_user` gate used: operator-authored issue, unambiguous named target, decisions within normal implementation latitude.

## Stage: Implementation — TDD (2026-07-05T18:30:23Z)

### Session summary

Executed all six extraction steps plus the roadmap doc update as seven commits, each a behavior-preserving refactor verified by the file's suite staying green (180 tests) before commit.
Moved seven config-harness factories and added a `sessionRule` builder to `test/helpers/manager-harness.ts`; the test file dropped from 3,745 to 3,481 LOC.
Test-count delta is zero — no cases added or removed, only setup scaffolding relocated; the full package suite (2283 tests) and workspace (4,538) stayed green throughout.

### Observations

- Deviation: in Step 1 a `perl -0777` non-greedy regex used to collapse the inline `sessionRules` object literals partially corrupted two blocks (a spanning `.*?` match).
  Caught immediately by biome parse errors and fixed inline within the same commit — no behavior impact.
  Lesson: for multi-line structural collapses across many similar blocks, prefer targeted `Edit` calls or a tighter anchored regex over a greedy slurp-mode substitution.
- The two duplicative factories (`makeManagerWithConfig`, `makeManagerWithScopes`) became true thin delegators over the existing `createManager` / `createManagerWithProject`; kept their loose `Record<string, unknown>` permission param with a localized `as ScopeConfig` cast to preserve all 62 + 10 call sites unchanged (the loader accepts loose maps; behavioral equivalence confirmed by the green suite).
- Quantitative target met exactly as planned: the sole remaining in-file clone pair is the agent-frontmatter act/assert body the plan's Non-Goals intentionally excluded (the repeated system-under-test call is the test subject, per the `testing` skill).
- The two single-instance inline blocks (MCP-settings, `PI_CODING_AGENT_DIR`) and the two `getResolvedPolicyPaths` blocks were left in place as planned; only `getProjectConfigPath` became an orphaned import and was pruned in Step 6.
- Pre-completion reviewer: WARN (1 non-blocking finding — the `package-pi-permission-system` skill still listed only `createManager` / `createManagerWithProject` for `manager-harness.ts`).
  Folded the fix into this session (commit `e1cca63e`) rather than deferring to #526, since Step 2 will start importing the new builders.

## Stage: Final Retrospective (2026-07-05T18:48:59Z)

### Session summary

One continuous session carried #525 from planning through TDD, ship, and retro.
Extracted seven config-harness factories plus a `sessionRule` builder from `test/permission-manager-unified.test.ts` into the shared `test/helpers/manager-harness.ts` (file dropped 3,745 → 3,481 LOC), shipped as eight commits with zero test-count delta, closed the issue, and confirmed the work auto-batches (no release cut).
Execution was clean; the only agent-side friction was a scripted-regex corruption in the first extraction step, self-caught by biome and fixed inline.

### Observations

#### What went well

- Plan-to-outcome fidelity was exact: the plan predicted "clone groups drop to near zero," and the sole remaining in-file clone was precisely the agent-frontmatter act/assert pair the plan's Non-Goals had already excluded as the test subject (per the `testing` skill).
  No mid-flight scope re-decision was needed.
- The delegator design (collapsing `makeManagerWithConfig` / `makeManagerWithScopes` into thin wrappers over the existing `createManager` / `createManagerWithProject` rather than relocating duplicate bodies) removed the duplication instead of moving it, and preserved all 62 + 10 call sites via a localized `as ScopeConfig` cast — a clean tidy-first outcome verified entirely by the green suite.
- Incremental verification was exemplary: `vitest` + `tsc` + `biome` ran after every one of the six extraction steps, so each commit landed green and the one corruption surfaced within seconds of the edit that caused it.

#### What caused friction (agent side)

- `wrong-abstraction` (tooling choice) — Step 1 used a `perl -0777` slurp-mode substitution to collapse ~12 similar inline `sessionRules` object literals into `sessionRule(...)` calls; the non-greedy `.*?` group spanned across block boundaries and corrupted two blocks (lines 762 and 2966).
  Self-caught immediately by biome parse errors; fixed with two targeted `Edit` calls plus an unused-import prune, all within the same commit.
  Impact: ~3 extra tool calls, no rework to any deliverable, no behavior impact.
  The `sed` per-symbol renames (`sessionAllow` → `sessionRule`, `makeManager` → `createMissingConfigManager`, etc.) were the right tool and caused no trouble — only the multi-line structural collapse was the wrong fit for a scripted regex.

#### What caused friction (user side)

- None.
  The issue was operator-authored with an unambiguous named target, so no `ask_user` gate or mid-session correction was warranted at any stage.

### Diagnostic details

- **Feedback-loop gap analysis** — no gap; the positive case.
  Verification ran after each extraction step rather than only at session end, which is why the perl corruption was caught within one tool call of the edit rather than surfacing later as a suite failure.
- **Escalation-delay tracking** — no rabbit-hole.
  On hitting the perl corruption the approach switched immediately from scripted regex to targeted `Edit` calls; no sequence of >5 tool calls was spent retrying the failed technique.
- **Model-performance correlation** — the session cycled through several model selections (`claude-opus-4-8`, `claude-sonnet-5`, `deepseek-v4-flash`, `claude-fable-5`); the `pre-completion-reviewer` subagent ran on its own frontmatter-pinned model for the review, appropriate for judgment-heavy work.
  No mismatch observed — mechanical migration and design judgment both landed correctly.

### Changes made

1. `AGENTS.md` ("Edit tool batches" section) — appended a one-sentence rule after the existing `sed` line: a multi-line `perl -0777`/`sed` regex substitution across many similar blocks is a trap (a non-greedy `.*?` group spans block boundaries and corrupts a neighbor); collapse repeated multi-line literals with per-block `Edit` calls and reserve scripted substitution for single-line per-symbol renames.
2. `packages/pi-permission-system/docs/retro/0525-extract-manager-unified-fixtures.md` — added this Final Retrospective stage entry.
3. `.pi/prompts/ship-issue.md` (Step 7 Final report) — named `/retro <N>` as the single next step and instructed against recommending the next issue there; the ship report previously left the "next step" unspecified, so the model improvised a `/plan-issue` recommendation with the wrong timing.
4. `.pi/prompts/retro.md` (new Step 10) — added a closing step that surfaces the next roadmap issue (`/plan-issue #M`) after the retro is committed, moving the next-issue recommendation to the correct point in the workflow.
