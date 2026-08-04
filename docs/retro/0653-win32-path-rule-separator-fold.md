---
issue: 653
issue_title: 'Windows: path rule "/dev/null": "allow" never matches due to wildcard separator normalization asymmetry'
---

# Retro: #653 — Windows: path rule "/dev/null": "allow" never matches due to wildcard separator normalization asymmetry

## Stage: Planning (2026-07-25T10:50:00Z)

### Session summary

Confirmed the reported bug end to end by spiking against the real pipeline rather than reasoning from the issue body: `BashProgram.parse("echo hi > /dev/null", win32Normalizer)` yields a `path` rule candidate whose only match value is `/dev/null`, and `PermissionManager.check` under `["*": ask, "/dev/null": allow]` answers `ask` because the rule compiled to `^\dev\null$`.
Applied the proposed fix as a throwaway spike and re-ran the full 2594-test suite green, then spiked the follow-on alias removal and confirmed only the two assertions that spell the alias out fail.
Wrote `docs/plans/0653-win32-path-rule-separator-fold.md` with four cycles (fix, compiled-pattern refactor, alias removal, docs) and filed [#655] for the adjacent `deriveApprovalPattern` design question.

### Observations

- The issue was third-party (`llllllllqq`), so the `ask-user` direction gate applied.
  The operator chose the symmetric fold in `wildcardMatch` over the narrower `AccessPath.forDevice` alias, and asked whether it generalizes enough to retire [#533]'s workaround — it does, verified by spike.
- The root cause generalizes past `/dev/null`: on win32 the `AccessPath` match-value union mixes separator conventions (`win32.resolve`/`win32.relative` aliases carry `\`, the as-typed literal, `forDevice`, and `forLiteral` carry `/`), so *every* forward-slash match value was unmatchable, not just the device.
  [#533] patched one shape of this with a hand-attached backslash match alias; treating the fold as an equivalence relation applied to both operands retires that workaround.
- Added a design step the issue did not propose: move matching onto the compiled pattern (`matches(value)`, drop the exposed `regex`) so the fold cannot be half-applied by a future caller.
  `findCompiledWildcardMatch` already calls `.regex.test(value)` — harmless today only because nothing compiles it with win32 options.
- Tracing the repro surfaced a documentation defect the issue did not mention: `docs/configuration.md` claims the safe device paths "never trigger the gate", but `isSafeSystemPath` exempts them from `external_directory` only — the cross-cutting `path` gate resolves them on both platforms.
  Surfaced via a second `ask_user`; the operator confirmed the behavior is right and the prose over-claims, so the plan corrects the doc and leaves the gate alone.
- Rejected alternative recorded in the plan: normalizing separators when *building* match values (in `AccessPath`).
  It scatters half the relation across three construction sites and misses `isPiInfrastructureRead`, which matches a configured glob against a boundary value rather than an alias union.
- Spiking before writing paid off twice: it killed a suspected `?`-after-separator regex quirk that turned out not to exist, and it converted the "Invariants at risk" table's riskiest row ([#533]'s `/tmp*` guarantee) from an argument into a measured result.

## Stage: Implementation — TDD (2026-07-25T11:05:00Z)

### Session summary

Landed all four planned cycles with no deviations: the symmetric `foldSeparators` fix, the `CompiledWildcardPattern.matches(value)` refactor that removes the raw-`RegExp` escape hatch, removal of the now-redundant [#533] backslash match alias (including the `matchAliases` parameter on `AccessPath.forLiteral` / `PathNormalizer.forLiteral`), and the doc pass.
Test count in `pi-permission-system` went 2593 → 2603; `pnpm run check`, root `pnpm run lint`, `pnpm run test`, and `pnpm fallow dead-code` are all green.
Pre-completion reviewer returned PASS.

### Observations

- The `tidy-first-assessor` recommended nothing and rejected five candidates with specific reasons (notably: the plan's own `foldSeparators` extraction *is* the feature commit, not a preparation for it).
  Its scope boundary held — nothing it considered lay outside the target files.
- Every red was honest and every green landed first try, because the planning session had already spiked the fix and the alias removal against the real suite.
  The only surprise was zero surprises: the spiked prediction (full suite green after the fix; exactly two alias assertions failing after the removal) matched the actual run exactly.
- Added negative controls the plan did not name — `wildcardMatch("/dev/null", "/dev/stdout", { windowsSeparators: true })` is `false`, and the fold stays off by default — so the widening is pinned as separator-only rather than merely asserted in prose.
  For a permission surface that felt worth the two extra assertions.
- Cycle 2's red was a runtime `TypeError` rather than a type error, since Vitest's esbuild does not typecheck; `pnpm run check` after the green was what actually proved the removed `regex` field had no surviving reader.
- One `Edit` call carried stray `oldText2`/`newText2` keys (the failure mode `AGENTS.md` warns about — silently ignored while still reporting success).
  Both intended blocks were separate `edits[]` entries so nothing was dropped, but the reported-blocks-vs-intended-edits count is what caught it.
- Reviewer verdict: PASS, no warnings.
  It independently confirmed the [#533] invariant test still pins its guarantee and that the fold cannot become a bypass (it widens `allow`, `deny`, and `ask` identically, win32-only).

## Stage: Final Retrospective (2026-07-25T17:24:49Z)

### Session summary

Planning, TDD, and ship all ran in one continuous session, releasing `pi-permission-system` v23.0.1 with the symmetric win32 separator fold plus two follow-on refactors and a doc correction.
Four commits landed with zero deviations from the plan, the pre-completion reviewer returned PASS with no warnings, and both CI runs (feature push and release) went green first try.
The dominant pattern was that planning-time measurement — spiking the fix and the alias removal against the real suite before writing the plan — made the implementation stage entirely surprise-free.

### Observations

#### What went well

- **Spiking the plan's riskiest claim converted an argument into a measurement.**
  The plan's "Invariants at risk" table named `test/permission-manager-unified.test.ts` — "win32: a /tmp\* allow rule suppresses a Git Bash /tmp path (#533)" — as the one row at genuine risk, because cycle 3 removes the very alias that test's comment credited.
  Rather than arguing it would hold, planning applied both the fix and the alias removal as throwaway edits and ran the full suite: exactly the two alias assertions failed and the #533 test stayed green.
  The TDD stage then reproduced that prediction exactly.
  This generalizes the existing quantitative-invariant rule ([#640]) to behavioral invariants.
- **The `/ship-issue` `IN_PROGRESS` branch fired correctly on its first real encounter.**
  `release_pr_merge` refused PR #657 with `merge_state: UNSTABLE`; the rollup showed a `check` run still `IN_PROGRESS` rather than the empty-rollup `GITHUB_TOKEN` case.
  The prompt's "neither case — wait, do not fall back to `gh pr merge`" branch is what kept the session from merging past a running check.
  A prior retro's refinement paying off in situ is worth recording.
- **Both operator `ask_user` answers reshaped scope rather than rubber-stamping it.**
  The first ("Does this generalize and thus remove the need for #533 workaround?") directly produced cycle 3; the second ("is there a better design?
  Is there a missing collaborator?") shaped [#655]'s body into a design question with three candidate homes instead of a bug report.
  Neither was mechanical oversight.

#### What caused friction (agent side)

- `other` — **Fabricated ISO timestamps in the stage entries.**
  The Planning and TDD entries were written as `2026-02-13T…` when the actual date was `2026-07-25` — five months off, invented rather than read from a clock.
  Impact: two committed stage entries carried misleading chronology in the cross-session context bridge; corrected in this retro commit.
  A model has no clock, so this recurs by construction unless the timestamp is fetched.
- `wrong-abstraction` — **Backslash escaping through scripted substitution, twice.**
  Turn 16 ran an inline `node -e` whose shell-escaped backslashes produced four wrong `false` results, forcing the same probe to be rewritten as `/tmp/wc-check.mjs`.
  Turns 45–47 then tried `perl -0pi -e` to apply a one-line spike edit containing `\\`, needed a second `perl` to repair its own over-escaping, and finally fell back to `Edit`.
  Impact: three wasted tool calls, no rework in committed output.
  `AGENTS.md` already warns about *multi-line* scripted substitution but explicitly reserves "single-line per-symbol renames" as sanctioned — which is exactly what pointed at `perl` here; the real discriminator is backslashes in the replacement, not line count.
- `instruction-violation` (self-identified) — **Three skill loads skipped or deferred in the planning stage.**
  `/plan-issue` says to load `colgrep` before code exploration and `code-design` for design heuristics; `colgrep` was never loaded and `code-design` only arrived at the TDD stage (turn 64), after the `matches()` collaborator decision was already made.
  Skills were instead loaded reactively at point of need (`markdown-conventions` before writing the plan, `github-voice` before filing [#655]).
  Impact: none demonstrable — exploration was symbol-exact (`wildcardMatch`, `matchAliases`, `forBashToken`), the case where the `colgrep` skill's own decision table prefers grep, and the pre-completion reviewer independently passed the design.
  Recorded because the gate was skipped, not because it cost anything. (`design-review` was judged not to apply: the prompt says to judge from the issue, and #653 reads as a one-line bug fix.)
- `instruction-violation` (self-identified) — **Stray `oldText2`/`newText2` keys on a `configuration.md` edit.**
  Exactly the failure mode `AGENTS.md` documents as silently ignored.
  Impact: none — both replacements were already separate `edits[]` entries, and the reported-blocks-vs-intended-edits count caught it immediately.
  The rule exists and is crisp; this was a compliance lapse, not a content gap.
- `other` — **Over-verification of a `git rev-parse` SHA during ship.**
  Turns 123–125 and 130–131 spent five tool calls confirming that `git rev-parse` returns 40 characters, including a `cat -A` that failed outright because macOS ships BSD `cat` (no `-A`).
  Impact: five wasted tool calls, no rework.
  The `/ship-issue` rule it stems from guards a real past failure (typing a SHA from memory, [#640]) and should not be weakened; the over-application is a judgment artifact.
- `other` — **zsh `=`-expansion aborted a bash call.**
  `echo ===` used as a section separator failed with `zsh:1: == not found`, costing one re-run.
  A leading `=` triggers zsh's command-lookup expansion, the same class as the unquoted-glob trap `AGENTS.md` already documents.

#### What caused friction (user side)

- Nothing substantive.
  Both `ask_user` gates were answered decisively and on first ask, and each answer carried a follow-up note that materially improved the output.
  No context appeared to be withheld and no correction was needed.

### Diagnostic details

- **Model-performance correlation** — Planning and TDD ran on `anthropic/claude-opus-5`; the ship stage ran on `anthropic/claude-sonnet-5`.
  The split matches task shape: the judgment-heavy work (third-party direction gate, the `matches()` design decision, the spike strategy) sat on the stronger model, and the deterministic ship runbook on the cheaper one.
  Both subagents (`tidy-first-assessor`, `pre-completion-reviewer`) ran on `anthropic/claude-sonnet-5` per their frontmatter — appropriate for bounded checklist work, and the reviewer's 29 tool calls produced findings that held up on inspection.
  One mild correlation: the SHA over-verification cluster is the one sequence on the cheaper model, and it took five calls to confirm a tautology.
- **Escalation-delay tracking** — No `rabbit-hole` friction points.
  The longest same-error sequence was three calls (the `perl` escaping fight, turns 45–47), resolved by switching tools rather than persisting.
  No sequence approached the five-call threshold that would warrant dispatching a subagent or asking.
- **Unused-tool detection** — `colgrep` was available and never dispatched despite an explicit prompt instruction.
  In this instance grep was the correct choice by the skill's own decision table (every target was an exact symbol), so the miss cost nothing; flagged only so a repeat on an intent-shaped search is recognizable.
- **Feedback-loop gap analysis** — No gap.
  `pnpm run check` ran immediately after each shared-type change (turns 76, 84, 92), the full package suite after every green, and targeted file runs for every red.
  The three root-level gates (`lint`, `test`, `fallow dead-code`) ran both at the end of TDD and again as ship pre-push checks.

### Changes made

1. `packages/pi-permission-system/docs/retro/0653-win32-path-rule-separator-fold.md` — corrected the fabricated `2026-02-13` timestamps on the Planning and Implementation stage headings to the actual `2026-07-25`.
2. `AGENTS.md` (§ Retro file format) — added the rule to fetch each stage timestamp from `date -u +"%Y-%m-%dT%H:%M:%SZ"` rather than writing one from memory.
3. `AGENTS.md` (§ Edit tool batches) — extended the scripted-substitution warning: a replacement containing backslashes is a trap even as a single-line rename, since shell, perl, and the regex engine each consume an escape level.
4. `.pi/prompts/plan-issue.md` (§ Invariants at risk) — added the rule to spike a removal whose invariant an existing test's comment credits, extending the [#640] quantitative-invariant rule to behavioral ones.

Proposal D (quoting a leading-`=` word against zsh's `=`-expansion) was declined as too small to earn a line.

[#533]: https://github.com/gotgenes/pi-packages/issues/533
[#640]: https://github.com/gotgenes/pi-packages/issues/640
[#655]: https://github.com/gotgenes/pi-packages/issues/655
