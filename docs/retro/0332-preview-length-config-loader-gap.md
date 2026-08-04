---
issue: 332
issue_title: "`toolInputPreviewMaxLength` (and `toolTextSummaryMaxLength`) in `config.json` are silently ignored — preview is always truncated at the hardcoded default"
---

# Retro: #332 — Fix `toolInputPreviewMaxLength` / `toolTextSummaryMaxLength` loader gap

## Stage: Planning (2026-06-08T00:00:00Z)

### Session summary

Planned the fix for the loader-pipeline gap that drops `toolInputPreviewMaxLength` and `toolTextSummaryMaxLength`.
Confirmed the downstream machinery (`normalizePermissionSystemConfig`, `resolveToolPreviewLimits`, `ToolPreviewFormatter`) is already correct and the break is confined to `UnifiedPermissionConfig` / `normalizeUnifiedConfig` / `mergeUnifiedConfigs` in `src/config-loader.ts`.
Plan committed at `docs/plans/0332-preview-length-config-loader-gap.md`.

### Observations

- The issue body references `src/runtime.ts`, which no longer exists — the relevant save/refresh logic now lives in `src/config-store.ts` (`ConfigStore.save()` / `ConfigStore.refresh()`).
- Schema (`schemas/permissions.schema.json`), example (`config/config.example.json`), and `docs/configuration.md` already document both fields, so the kuba follow-up comment about the docs schema is stale — no doc edits are needed.
- The "secondary" `save()` bug fixes itself once the loader is fixed: `save()` merges via `{ ...existing.config, … }` and `existing.config` is loaded through the same loader, so the spread carries the parsed fields through unchanged.
- Decision (confirmed with user): rely on the `...existing.config` spread in `save()` rather than the issue's proposed explicit write of `normalized.toolInputPreviewMaxLength`.
  The in-memory `normalized` value is the *merged* value; writing it into the global file would bake a project/per-agent override into global.
  The two preview-length fields are not modal-editable, so leaving the on-disk global value untouched is correct.
- The issue's circular-dependency concern about `normalizeOptionalPositiveInt` is not literal (neither `config-loader.ts` nor `extension-config.ts` imports the other today), but the cleanest home is the dependency-light `src/common.ts` that both already import — avoids the loader depending on the higher-level config-shape module.
- `normalizeOptionalPositiveInt` has only two references: `extension-config.ts` (use) and `test/extension-config.test.ts` (direct tests).
  The package skill does not reference it.
  Relocation is low-risk.

## Stage: Implementation — TDD (2026-06-08T20:37:00Z)

### Session summary

All four TDD steps completed in a single session.
Four commits landed: relocation of `normalizeOptionalPositiveInt` to `common`, parse fix in `normalizeUnifiedConfig`, merge fix in `mergeUnifiedConfigs`, and a save-preservation regression guard in `config-store.test.ts`.
Test count went from 1837 to 1858 (+21 tests across `common.test.ts`, `config-loader.test.ts`, and `config-store.test.ts`).

### Observations

- The plan's single combined scalar loop in `mergeUnifiedConfigs` required splitting into two type-separated loops (boolean scalars, number scalars) because TypeScript rejected assigning `boolean | number` to the narrowed per-property type.
  The type fix was applied during the post-step cleanup and committed as part of the step-3 commit.
- Step 4 (save-preservation test) passed immediately on the first run — confirming the spread approach does the right thing once the loader is fixed.
  No production code change was needed for `config-store.ts`.
- A mid-step rebase (mixed reset + re-commit) was required to correct a commit where the type-safety fix accidentally landed in the step-4 test commit rather than the step-3 production commit.
  Resolved before push with `git reset HEAD~2` and clean re-commits.
- Pre-completion reviewer verdict: **WARN** — the only finding was the missing implementation stage note in this retro file (now addressed).

## Stage: Final Retrospective (2026-06-08T21:05:43Z)

### Session summary

Shipped the loader-gap fix end to end (plan → TDD → ship → release `pi-permission-system` v10.5.3), then ran a post-mortem on why the original feature (#266) shipped the bug undetected and filed follow-up issue #356.
The fix was four commits (+21 tests); the post-mortem traced the root cause to a hidden intermediate type (`UnifiedPermissionConfig`) plus an `unknown`-typed `normalizePermissionSystemConfig` parameter that erased the type safety that would have caught the omission.

### Observations

#### What went well

- Planning treated the issue's proposed `save()` fix (explicit write of `normalized.toolInputPreviewMaxLength`) as a hypothesis and rejected it in favor of the `...existing.config` spread, confirmed via `ask_user`.
  TDD validated the call: step 4 passed on first run with **no** production change to `config-store.ts`, and the spread approach avoided baking project/per-agent overrides into the global file.
  This is the `plan-issue` "proposed change is a hypothesis, not a spec" rule paying off concretely.
- The post-mortem used targeted git archaeology at specific SHAs (`git show 3a7dafbb --stat`, `git cat-file -e <sha>:<path>`, `git grep … <sha>`) to prove the bug shipped with #266 rather than guessing, then produced a well-scoped follow-up (#356) with two concrete hardening ideas.

#### What caused friction (agent side)

- `instruction-violation` (self-identified) — committed the step-4 test before running `pnpm run check`, so a type error introduced in step 3 (the `boolean | number` narrowing in `mergeUnifiedConfigs`) surfaced only at the end-of-cycle check.
  The `testing` skill already says to run `pnpm run check` immediately after a step that changes a shared interface; it was not applied after the interface-touching steps.
  Impact: the fix then had to land in the step-3 commit, but `git commit --amend` hit HEAD (step 4); recovery required a `git reset HEAD~2` + two clean re-commits (~6 extra tool calls).
- `other` — reached for `git rebase -i` in a non-interactive environment; it aborted because `$EDITOR` is Neovim.
  Impact: two failed attempts and a user hint (`EDITOR=true`) before abandoning it for `git reset` + recommit.
- `other` (trivial) — left `/tmp/issue-body.md` behind after filing #356 via `gh issue create --body-file`.
  Impact: stray temp file, no rework.

#### What caused friction (user side)

- The user proactively supplied the `EDITOR=true` hint when the rebase aborted — mechanical oversight the agent could have pre-empted by not reaching for interactive rebase in a known non-interactive environment.

### Diagnostic details

- **Model-performance correlation** — session spanned `anthropic/claude-opus-4-8` → `claude-sonnet-4-6` → `claude-opus-4-8` model changes; the `pre-completion-reviewer` subagent ran on `anthropic/claude-sonnet-4-6` (per its frontmatter), appropriate for judgment-heavy review.
  No mismatch.
- **Escalation-delay tracking** — no rabbit hole exceeded 5 consecutive tool calls on one error; the type error was a single-edit fix and the commit-reorder was a deliberate recovery, not flailing.
- **Unused-tool detection** — none missed; the post-mortem git archaeology was done directly with targeted commands, which was faster than dispatching a subagent.
- **Feedback-loop gap analysis** — per-step `vitest` verification ran incrementally (good), but `pnpm run check` ran only at end-of-cycle rather than after the interface-changing steps.
  This specific gap is the root of the commit-reorder friction and is the actionable finding.

### Changes made

1. `.pi/prompts/tdd-plan.md` — added a note to the Green step: run `pnpm run check` before committing a step that adds or changes a shared type/interface (or a consumer over one), since Vitest does not typecheck.
2. `AGENTS.md` (§ Commits) — added guidance to avoid `git rebase -i` in this environment and to reorder/fix unpushed commits with `git reset` + re-commit or `GIT_SEQUENCE_EDITOR`/`EDITOR=true`.
