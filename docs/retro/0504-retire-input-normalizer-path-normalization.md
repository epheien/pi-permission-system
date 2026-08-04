---
issue: 504
issue_title: "pi-permission-system: retire input-normalizer path normalization (Phase 7 Step 3)"
---

# Retro: #504 — Retire input-normalizer path normalization (Phase 7 Step 3)

## Stage: Planning (2026-06-29T18:30:00Z)

### Session summary

Planned Phase 7 Step 3 (batch "symlink-resistant-path-matching" tail): remove the dead lexical-only path normalization from `input-normalizer.ts` left behind by Steps 1 ([#502]) and 2 ([#503]).
Verified against live code that `normalizePathSurfaceValues`, the special-surface (`path` / `external_directory`) branch, and the `PATH_BEARING_TOOLS` branch of `normalizeInput` have no remaining production caller for a real path value — every path surface now routes through `access-path` → resolver → `path-values`.
Produced a four-step plan (two `test:` steps, one `refactor:`, one `docs:`) at `docs/plans/0504-retire-input-normalizer-path-normalization.md`.

### Observations

- **The change is non-breaking despite riding a breaking batch.**
  The tail commit is a pure `refactor:` (dead-code removal); the missing-path / empty-input case for path-bearing tools falls through to the generic `["*"]` branch with an identical result.
  The release is cut by Steps 1 and 2's already-landed breaking `feat!:` commits, not this refactor — so the `Release Recommendation` is "ship now — batch tail" with a rationale that the refactor itself does not trigger a release (Refs #479).
- **The bulk of the work is a faithful test migration, not the production removal.**
  `test/permission-manager-unified.test.ts` has ~30 `checkTool(manager, <path-surface>, { path })` calls that rely on the doomed `normalizeInput` path branches; they migrate to a new `checkPath` helper routing through the `path-values` intent via `getPathPolicyValues(path, opts, "linux")` — identical values, green against current production (tidy-first preparatory Step 1).
  The ~39 empty-input `checkTool(manager, <surface>, {})` calls produce `["*"]` and are unaffected.
- **Confirmed the migration surface is confined to one test file.**
  All other `kind: "tool"` test usages (`permission-resolver.test.ts`, `permission-event-rpc.test.ts`, `service.test.ts`, `skill-prompt-sanitizer.test.ts`) use `bash`/`skill` surfaces; only `permission-manager-unified.test.ts` drives `tool` intents for path surfaces.
- **`currentCwd` removal is forced by the dead-code gate.**
  Grep confirmed `permission-manager.ts`'s `currentCwd` field is read only by the `normalizeInput` call being changed; `configureForCwd` rebuilds the loader from its `cwd` parameter directly.
  Dropping the field (and the `platform`/`cwd` params from `normalizeInput`) avoids a `pnpm fallow dead-code` failure — the [#502] lesson that the baseline check/lint/test triad does not see dead members or stale suppressions.
- **Signature change cascades to test arity.**
  Dropping `platform`/`cwd` from `normalizeInput` breaks every `normalizeInput(..., "linux")` call at `tsc` time (esbuild skips it), so the arity fix rides in the `refactor:` green commit, with `pnpm run check` immediately after.
- **Doc rewrite needed, not just a `✅`.**
  `architecture.md`'s `### Path-bearing tool normalization` section still attributes per-tool path matching to `normalizeInput`; it must be reworded to the `access-path` mechanism ([#502]) — reworded prose carries no removed symbol, so it would not surface in a `src/`-symbol grep.
  Also flagged SKILL.md line ~130's deferred-follow-up note that names `normalizeInput` as the threading mechanism.
- **Skipped the `ask_user` gate:** operator-authored issue, unambiguous and roadmap-blessed proposal, consistent with the [#502] / [#503] precedent in this batch.

[#502]: https://github.com/gotgenes/pi-packages/issues/502
[#503]: https://github.com/gotgenes/pi-packages/issues/503

## Stage: Implementation — TDD (2026-06-29T21:15:00Z)

### Session summary

Implemented all four planned TDD steps: Step 1 migrated ~50 real-path `checkTool` calls in `permission-manager-unified.test.ts` to a new `checkPath` helper (green against production); Step 2 replaced three dead `describe` blocks in `input-normalizer.test.ts` with 4 red assertions asserting the new `["*"]`-only contract; Step 3 removed the dead branches, dropped `platform`/`cwd` from `normalizeInput` and `currentCwd` from `PermissionManager` (green, `tsc` + full suite + lint + fallow); Step 4 updated `architecture.md` and `SKILL.md` and marked Phase 7 Step 3 `✅`.
Test count 2222 → 2198 (−24 deleted input-normalizer tests, +4 new contract assertions = −20 net from the normalizer, plus 4 extra missed-path corrections).
Pre-completion reviewer returned WARN with two findings, both resolved before the retro commit.

### Observations

- **The plan's ~30 estimate was low — actual migration surface was ~50 calls.**
  Planning identified multi-line `checkTool` calls where the surface name is on the next line, and single-line ones where the surface is inline, but missed four calls where the surface (`external_directory`) was embedded in larger multi-line patterns with session rules or agent names (lines 171, 2676, 2686, 2872 / 3005 in the original file).
  These surfaced as 4 unexpected failures when the full suite ran after Step 3; fixed as part of the same step before committing.
- **A structural repair was needed mid-Step 2.**
  One `Edit` call used `"universal '*': 'deny'"` as an anchor, which split the test's string literal at the embedded `'deny'` quote, corrupting the `describe` block structure.
  Detected immediately by `pnpm exec biome check`; repaired via a targeted Python line-range replacement since the exact bytes (with trailing `})` closure) didn't match any clean `Edit` anchor.
  Lesson: when a test description contains smart quotes or embedded single-quotes, use a wider anchor that includes a few surrounding lines rather than the string literal alone.
- **Step 1 test migration was the largest work unit.**
  The `checkPath` helper matched the plan design exactly; the `getPathPolicyValues(path, cwd ? { cwd } : {}, "linux")` call was faithful to the old `normalizeInput` path branch.
  The two cwd-aware tests (lines 3302–3352) correctly passed both `manager.configureForCwd(cwd)` (for loader) and `{ cwd }` to `checkPath` (for alias derivation).
- **Pre-completion reviewer WARN findings (both fixed before commit):**
  1. `docs/architecture/architecture.md` line ~786: per-tool gate bullet in the Findings "residual ad-hoc path handling" section lacked a "closed by" annotation — added `— closed by Steps 1–3 ([#502], [#504])`.
  2. `test/input-normalizer.test.ts`: `import { join } from "node:path"` was unused after removing the home-expansion test blocks; Biome had auto-fixed it during Step 3 but the fix wasn't staged before commit — removed explicitly and committed.

## Stage: Final Retrospective (2026-06-29T18:38:34Z)

### Session summary

Shipped Phase 7 Step 3 across plan → TDD → ship, completing the three-step "symlink-resistant-path-matching" batch as a single `pi-permission-system v18.0.0` major release.
The ship stage merged release-please PR #515 (UNSTABLE / no-checks `GITHUB_TOKEN` case → `gh pr merge --rebase`) and closed all three batch issues (#504, #502, #503), recognizing #513 was already closed.
A clean run end to end — no rework, no rabbit-holes; the only friction (a low call-site estimate, an `Edit` string-truncation) was self-caught within the same commit.

### Observations

#### What went well

- **The ship prompt is deterministic enough that a weak model executed it flawlessly.**
  The entire ship stage ran on `opencode-go/deepseek-v4-flash` (a low-cost model), yet it correctly read the plan's `**Release:** ship now — batch tail` marker without asking, navigated the nuanced `release_pr_merge` UNSTABLE refusal by checking `statusCheckRollup` (empty → no checks → `gh pr merge 515 --rebase`), and closed three issues with batch-aware summaries.
  This validates the ship prompt's step-by-step protocol: the judgment is encoded in the prompt, not delegated to the model.
- **Batch-tail release coordination worked exactly as designed across three issues.**
  The plan's `**Release:**` marker drove the no-ask release decision; the already-landed breaking `feat!:` commits from Steps 1–2 cut the major bump when this `refactor:`/`docs:`/`fix:` tail landed; and reading the [#502] retro notes prompted closing #502, #503, and verifying #513 — none of which leave a `refactor:` changelog reminder.
- **The plan's risk mitigation caught its own scope miss.**
  The plan under-counted the migration surface (~30 vs. ~50 real calls), but its stated mitigation — "any unmigrated real-path `checkTool` surfaces as a red in Step 3's full-suite run" — fired exactly as written: 4 unexpected failures appeared at the Step 3 full-suite run and were fixed in the same commit, no separate rework.

#### What caused friction (agent side)

- `missing-context` (planning) — the plan's `checkTool` call-site count (~30) was derived from a single-line grep (`grep 'checkTool(manager, "<surface>"'`), which cannot match the 4 multi-line invocations where `checkTool(`, `manager`, and the surface literal sit on separate continuation lines.
  Impact: 4 unexpected test failures at the Step 3 full-suite run; fixed within the same commit (no separate rework), because the plan's full-suite mitigation caught them.
- `other` (Edit-tool string truncation) — one Step 2 `Edit` produced a `newText` that terminated a test description string early (`"universal '*': 'deny'"` from `"universal '*': 'deny' with no path key …"`), corrupting the `describe` block.
  Impact: one structural-repair detour via a Python line-range replacement; caught immediately by `biome check`, no rework beyond the repair.
  Self-identified.

#### What caused friction (user side)

- None.
  The single decision point (batch-tail release) was pre-resolved from the plan's `**Release:**` marker, so the ship ran without an `ask_user` interrupt — the intended handshake for a non-deferred batch tail.

### Diagnostic details

- **Model-performance correlation** — the ship stage ran on `opencode-go/deepseek-v4-flash` and the `pre-completion-reviewer` (TDD stage) on `anthropic/claude-sonnet-4-6` per its frontmatter; both appropriate.
  No reasoning-weak-model-on-judgment-work mismatch: the ship prompt encodes the judgment, so the weak model only had to follow steps.
- **Escalation-delay tracking** — no `rabbit-hole`; the longest same-target sequence was 2 grep retries (entries 4–6) probing `release-please-config.json` exclude-paths, resolved immediately.
- **Unused-tool detection** — no gap warranted an Explore/`colgrep` dispatch; the planning `missing-context` miss was a grep-pattern limitation, not a missing tool.
- **Feedback-loop gap analysis** — verification was incremental in TDD (per-file red→green, `pnpm run check` right after the signature change, full suite + lint + `fallow` after Step 3); the ship stage's CI watch + release watch ran in protocol order.
  No end-loaded verification.

### Changes made

1. `.pi/skills/testing/SKILL.md` — added a rule under `### Interface and type changes`: when estimating the call-site count for a test migration, grep the bare callee (`checkTool(`), not `callee(arg, "literal"`, since a single-line pattern misses multi-line invocations and undercounts scope (the planning `missing-context` miss above).
