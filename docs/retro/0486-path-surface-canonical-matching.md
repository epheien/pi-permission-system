---
issue: 486
issue_title: "pi-permission-system: should the path surface match the canonical (symlink-resolved) form like external_directory?"
---

# Retro: #486 — Make the `path` surface match the canonical (symlink-resolved) form

## Stage: Planning (2026-06-27T14:43:53Z)

### Session summary

Resolved the decision #486 tracked: the operator chose to make the `path` surface match the canonical (symlink-resolved) form, bringing it to parity with `external_directory`.
A second `ask_user` settled implementation scope as "full" — migrate **both** `path` producers (the tool path gate and the bash-path gate) onto `AccessPath`, pulling the bash-path migration slice forward from [#487].
Produced `docs/plans/0486-path-surface-canonical-matching.md` (5 TDD steps) and committed it.

### Observations

- The change is **breaking**: adding the canonical alias to the `path` match set alters which rules fire on upgrade with no user edit (a symlink slipping past a `path: deny` now matches).
  Plan uses `feat(pi-permission-system)!:` with a `BREAKING CHANGE:` footer for the two behavior steps.
  The operator explicitly asked to confirm this.
- The match set is already single-sourced: `AccessPath.matchValues()` returns exactly `lexical ∪ canonical`, and the resolver already unwraps an `access-path` intent via `matchValues()`.
  So the change is mechanical — both producers emit `access-path`; the manager stays string-based and untouched.
- Key invariant to preserve: the [#393] unknown-base case (a relative bash token after a non-literal `cd` keeps its literal value only — no canonical, no spurious absolute).
  The plan routes that case through a new `AccessPath.forLiteral` (literal-only, empty boundary) rather than `forPath`.
- `forExternalDirectory` is generalized/renamed to a surface-neutral `forPath(pathValue, { cwd, resolveBase? })`; behavior-identical for external-directory callers because `resolveBase` defaults to `cwd`.
- Scope pulled forward from [#487]: the bash-path `AccessPath` migration and the collapse of the now-unproduced emitted `path-values` `AccessIntent` variant.
  No new issue filed — work is pulled forward, not deferred.
  [#487]'s residual scope is config-pattern and prompt-input migration only.
- Release: ship independently (not in any active batch; Phase 6 closed; breaking → own major-bump release).

## Stage: Implementation — TDD (2026-06-27T15:12:45Z)

### Session summary

Implemented all 5 TDD steps across 5 commits: added `AccessPath.forPath`/`forLiteral` factories, migrated the tool path gate (`path.ts`) and the bash-path gate (`bash-path.ts` + `cwd-projection.ts`) to emit `access-path` intents, and collapsed the gate-emitted `path-values` variant.
The `path` surface now matches the lexical aliases ∪ canonical (symlink-resolved) form like `external_directory` (#418 parity).
Test count went from 2145 → 2154 (net +9: added factory/`forLiteral`/canonical-alias tests across steps 1–3, removed one redundant `path-values` passthrough resolver test in step 4).

### Observations

- Two benign deviations from the plan's Module-Level Changes: `src/permission-resolver.ts` needed no source change (its `toResolvedIntent` fallthrough `return intent` already handles the narrowed `tool`-only case; `tsc` passes), and `src/access-intent/bash/program.ts` needed no change (the `BashPathRuleCandidate` shape change flows through the re-export).
  The plan anticipated the latter as a "verify" item.
- The plan's design held exactly: `AccessPath.matchValues()` already computed `lexical ∪ canonical`, and the resolver already unwrapped `access-path`, so the manager stayed string-based and untouched.
  No surprises.
- Test-fixture ripple: removing `path-values` from the emitted `AccessIntent` union surfaced three inline resolver mocks (`bash-external-directory.test.ts`, two in `external-directory-policy.test.ts`) that branched on `intent.kind === "path-values"`; those dead branches became `tsc` no-overlap errors and were simplified.
  `makePathDispatchResolver` (gate-fixtures) was likewise simplified to `tool | access-path`.
  The `makeHandler` adapter on `permissionManager.check` keeps its `path-values` branch (the manager still consumes the resolver-internal `ResolvedAccessIntent`).
- `noUncheckedIndexedAccess` is off in this package: `candidates[0]?.path` tripped `@typescript-eslint/no-unnecessary-condition`; fixed by dropping the `?.` on array-index access (kept it on `.find()` results).
- Removing `getPolicyValuesForRuleCandidate` (dissolved into the new private `buildRuleCandidatePath`) orphaned the `getPathPolicyValues` import in `cwd-projection.ts` — caught by biome `noUnusedImports` (warning-level) at the root lint, removed.
- Pre-completion reviewer: PASS (all deterministic checks green, all four documented invariants — #418/#393/#382/#478 — verified, Mermaid blocks validate, no dead code).

## Stage: Final Retrospective (2026-06-27T15:38:49Z)

### Session summary

Shipped #486 end-to-end across three stages (plan → TDD → ship) in one continuous session: a breaking change making the `path` permission surface match the canonical (symlink-resolved) form like `external_directory`.
Released independently as `pi-permission-system-v17.0.0` (major bump for the two `feat!:` commits); issue closed with an implemented-in summary.
The plan's design held exactly — zero design or code rework across all five TDD steps — so the only friction was minor shell/tooling mechanics.

### Observations

#### What went well

- **Design-during-planning paid off with zero rework.**
  The plan's central insight — that `AccessPath.matchValues()` already computes `lexical ∪ canonical` and the resolver already unwraps `access-path` — meant the implementation was mechanical: both producers emit `access-path`, the manager stayed string-based and untouched.
  All five steps went red→green→commit with no surprises, and two anticipated "verify" items (`permission-resolver.ts`, `program.ts`) needed no source change exactly as predicted.
- **The two `ask_user` gates in planning front-loaded the only real decisions** (direction: match canonical; scope: full migration pulling the bash-path slice forward from #487), so implementation and ship never had to re-litigate scope.
- **Ship flow handled the release-PR's in-progress check correctly.**
  The release-please PR returned `UNSTABLE`/`MERGEABLE` with a CI check still `IN_PROGRESS`; per the prompt's step 6.4, I polled `statusCheckRollup` until it completed rather than falling back to `gh pr merge` mid-run, then merged via `release_pr_merge` (rebase).
  The release tag landed cleanly.

#### What caused friction (agent side)

- `other` (shell) — A polling `for` loop assigned to a variable named `status`, which zsh treats as a read-only special variable (alias for `$?`), so the command aborted with `zsh:1: read-only variable: status`.
  Impact: one retry with a renamed variable (`STATE`/`DONE`); no rework beyond the single re-run.
- `other` (tooling) — One `Edit` batch object carried a stray `"type": "object"` property and was rejected by tool validation, forcing a re-apply of the same 5-edit batch.
  Impact: one wasted `Edit` call; self-caught immediately, no code impact.
- `other` (tooling) — A `sed` rename of `forExternalDirectory` → `forPath` silently matched nothing because the call spanned multiple lines; switched to `Edit` for the multi-line sites.
  Impact: one no-op `sed`, then the correct `Edit`; caught by the follow-up grep, no rework.
- `other` (lint mechanics) — Two lint findings surfaced only at the root `pnpm run lint` after a green test run: an orphaned `getPathPolicyValues` import left by dissolving `getPolicyValuesForRuleCandidate` (biome `noUnusedImports`, warning-level), and an unnecessary `?.` on array-index access (`@typescript-eslint/no-unnecessary-condition`, since `noUncheckedIndexedAccess` is off in this package).
  Impact: two small fixups inside the same step's commits; the existing per-step lint discipline caught both before push.

#### What caused friction (user side)

- None.
  The operator's two planning-stage answers were decisive and the breaking-change confirmation was explicit; no mid-implementation correction was needed.

### Diagnostic details

- **Model-performance correlation** — The only subagent dispatch was the `pre-completion-reviewer`, which ran on its configured `anthropic/claude-sonnet-4-6` (judgment-appropriate for the acceptance/invariant checklist).
  The main session ran on `claude-opus-4-8`; the interleaved `model_change` entries to several `opencode-go/*` models had no assistant turns under them (transient selections, never executed).
  No model/task mismatch.
- **Escalation-delay tracking** — No `rabbit-hole` friction points; no error sequence exceeded one retry.
  No subagent escalation was warranted.
- **Feedback-loop gap analysis** — Verification ran incrementally, not just at the end: `pnpm run check` after each interface-changing step (steps 1, 3, 4), the affected test file after every red/green, and the full package suite plus root `pnpm run lint` / `pnpm fallow dead-code` after the last step.
  This is what caught the two late lint findings before push rather than in CI.

### Changes made

1. `AGENTS.md` (§ Commits, beside the `${PIPESTATUS[0]}` note) — added a one-line rule: do not name a shell loop/script status variable `status` (zsh reserves `$status` as a read-only alias for `$?`); use `state`/`rc`.
   Prevents the `read-only variable: status` abort hit while polling the release PR's check status.
