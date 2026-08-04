---
issue: 454
issue_title: "Bash external_directory gate: cd-fold projection drops the running directory across a redirect-then-pipe, causing false external-path prompts"
---

# Retro: #454 — Recover bash operator precedence so a `cd` fold persists across a redirect-then-pipe

## Stage: Planning (2026-06-21T00:00:00Z)

### Session summary

Planned the fix for `BashProgram.externalPaths` over-prompting when a leading current-shell `cd` precedes a redirect-then-pipe statement (`pnpm x 2>&1 | tail`).
Confirmed the root cause by dumping the tree-sitter-bash AST and verifying real bash semantics with `bash -c`: the parser mis-groups `cd a/b && pnpm x 2>&1 | tail` as `(cd a/b && pnpm x 2>&1) | tail`, burying the current-shell `cd` inside a `pipeline` node that the walker's `default` case treats as non-folding.
The plan adds a `pipeline` case to `walkForCandidates` that folds the first stage's leading current-shell commands while keeping the terminal piped command and downstream stages as non-folding subshells.

### Observations

- The author is `gotgenes` (the operator), and the expected behavior is dictated by real bash precedence (`|` binds tighter than `&&`), so the `ask-user` gate was skipped — there is no operator-facing ambiguity.
- Verified the fail-closed boundary empirically: `bash -c 'cd a/b && cd c 2>&1 | tail; pwd'` ends in `a/b`, not `a/b/c` — the terminal `cd` is the real pipe stage (subshell) and must **not** fold.
  Folding it would under-flag a later escape (a fail-open regression), so the plan treats the terminal command of the first stage specially (`foldListExceptTerminal`) and pins it with a dedicated test.
- Classified as a non-breaking `fix:` — it removes false-positive external-directory prompts; no default, config, or output shape changes.
- Not part of any architecture-roadmap batch → ship independently.
- The change is internal to `bash-program.ts`: `externalPaths(cwd): string[]` is unchanged, so no consumer, test import, or `SKILL.md` reference moves.
  The design-review checklist found no structural smell (no shared-interface widening, no new threaded parameter); the three new helpers each return an `EffectiveBase` (real behavior, not procedure-splitting).
- The #452 A3 never-weaker invariant pins the bash *command* gate (`commands()`), a different slice than `externalPaths`, so the metamorphic test is untouched; the #307/#418 fail-closed projection invariant is the one at risk and is guarded by the new terminal-`cd` test.

## Stage: Implementation — TDD (2026-06-21T00:00:00Z)

### Session summary

Implemented the redirect-then-pipe cd-fold recovery in two TDD cycles: a `fix:` cycle adding four `externalPaths` projection tests plus `walkPipeline` / `foldPipelineFirstStage` / `foldListExceptTerminal` and a `pipeline` case in `walkForCandidates`, then a `docs:` cycle updating the `bash-program.ts` line in `docs/architecture/architecture.md`.
Test count rose 2065 → 2069 (+4); full suite, `tsc`, root lint, and `pnpm fallow dead-code` all green.

### Observations

- Deviated from the plan on test 4: used `cat ../foo` (escaping under the pre-cd base, inside under the folded base) instead of `cat foo`, so the downstream-stage test is a genuine red test rather than green pre-fix; documented in the commit body.
- Pre-fix failure values matched the traced `path.resolve` predictions exactly (test 1 `/projects/b`, test 3 `/x` → `/projects/x`, test 4 `/projects/foo`), confirming the base-reset diagnosis.
- The fail-closed terminal-`cd` test (`cd a && cd b 2>&1 | tail ; cat ../../x` ⇒ `/projects/x`) is the load-bearing guard: without it, a naive "fold the whole first stage" fix would silently fold the pipe-stage `cd b` and under-flag a later escape (fail-open).
- ESLint's pre-commit auto-fix removed a non-null assertion (`namedChildren[i]!` → `namedChildren[i]`); `tsc` stayed clean, so the assertion was unnecessary — array indexing returns `TSNode` here.
- The architecture tree-listing line uses bare `#N` (parenthesized) for inline issue refs, not `[#N]` reference links; rumdl MD053 does not recognize `[#454]` inside that line, so the doc update uses bare `#454` to match the local convention and avoid the unused-definition error.
- Pre-completion reviewer: PASS — all deterministic checks green, the three at-risk invariants (#452 A3 never-weaker, #307/#418 fail-closed subshell + terminal-pipe-stage) verified, and the test-4 deviation accepted as a quality improvement.

## Stage: Final Retrospective (2026-06-21T00:00:00Z)

### Session summary

Landed the #454 worktree branch onto linear `main` via `/land-worktree`: ff-merged `issue-454-bash-external-directory-gate-cd-fold-pro` (`66351220..98e856bc`), pushed, verified CI (run `27915785330`), closed the issue, released `pi-permission-system@16.0.1`, and tore down the worktree.
The flow ran end-to-end with one friction point — deriving the previous-release tag for the close-comment range.

### Observations

#### What went well

- The `UNSTABLE`-no-checks release-please PR (#458, empty `statusCheckRollup` — the `GITHUB_TOKEN` case) was handled exactly per the documented fallback: `gh pr merge 458 --rebase` then `git pull --ff-only`, no attempt to merge a genuinely blocked PR.
  This is the documented path, not a novel win — noted only to confirm the guardrail held.
- Inspected the **full** PR body (`gh pr view 458 --json body -q .body`) before merging and confirmed it bumped only `pi-permission-system` — no sibling-package bump slipped through.

#### What caused friction (agent side)

- `wrong-abstraction` — to find the previous-release tag for the close-comment range I ran `git tag --sort=-version:refname | head -1`, which sorts lexically across **all** package tags and returned `pi-subagents-worktrees-v0.2.3` (an unrelated package).
  `git log --oneline pi-subagents-worktrees-v0.2.3..HEAD` then dumped ~400 commits instead of the ~5 in the #454 range.
  Impact: added friction (large log to scan) but no rework — the #454 commits sat at the top of `HEAD`, so I filtered them manually.
  The package-scoped tag (`git tag --list 'pi-permission-system-v*' --sort=-creatordate | head -1` ⇒ `pi-permission-system-v16.0.0`) gives the tight, correct range.

#### What caused friction (user side)

- None — the user invoked `/land-worktree 454` and let it run; the flow needed no strategic intervention.

### Diagnostic details

- All four diagnostic lenses found nothing notable: no subagents were dispatched (the land flow is deterministic tool calls), no `rabbit-hole` sequences occurred, no unused tool would have helped, and CI was the verification gate (run correctly on the pushed SHA before the issue was closed or released).

### Changes made

1. `.pi/prompts/land-worktree.md` §5 — replaced the `<previous-tag-or-base>` placeholder with package-scoped tag derivation guidance (`git tag --list '<pkg>-v*' --sort=-creatordate | head -1`), naming the lexical-sort anti-pattern.
2. `.pi/prompts/ship-issue.md` §5 — mirrored the same package-scoped tag derivation on the `git log --oneline` block and the "other issues" range check (two occurrences).
