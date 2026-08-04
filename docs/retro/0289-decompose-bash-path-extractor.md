---
issue: 289
issue_title: "Decompose bash-path-extractor.ts: shared token rejection + collect* complexity"
---

# Retro: #289 — Decompose `bash-path-extractor.ts`

## Stage: Planning (2026-05-31T13:44:10Z)

### Session summary

Produced a 4-cycle TDD plan for Phase 2 Step 4: extract the shared token-rejection prelude and pure classifiers into a new `bash-token-classification.ts` module, then reduce the two `collect*` walker hotspots.
The plan is behavior-preserving — existing `bash-external-directory.test.ts` integration suites stay unmodified — with new unit tests added only for the extracted classifiers.

### Observations

- The file has exactly two exports (`extractExternalPathsFromBashCommand`, `extractTokensForPathRules`); every other symbol is private, and a grep across `src/`, `test/`, and the package SKILL confirmed no external consumer of the internals.
  This gave the extraction zero external blast radius.
- Two design forks were surfaced via `ask_user`.
  Chosen: (1) a new `bash-token-classification.ts` module with public API + dedicated unit tests (over keeping helpers private in-file), and (2) converting `collect*` to return-based `string[]` (over preserving the mutated `tokens` accumulator).
- Validated each extraction against the `code-design` "returns a value / owns state / gives behavior to data" test: `rejectNonPathToken` returns a boolean and removes a genuine clone; `classifyPatternCommandFlag` returns a discriminated-union directive (moves the flag decision onto data); the return-based conversion removes an output-argument pattern rather than relocating statements.
- Kept `rejectNonPathToken` and `classifyPatternCommandFlag` private to avoid a `fallow` dead-export flag — only the two classifiers (consumed by the walker) are exported.
- Flagged the Biome/ESLint assertion conflict up front: the `consume-arg` directive variant carries a non-optional `nextArgAction` so the `switch` narrows without `!` or `as`.
- The `collect*` return-based conversion must land in a single commit (Step 3) because the mutual recursion and shared accumulator break at the type level if split.

## Stage: Implementation — TDD (2026-05-31T14:40:31Z)

### Session summary

All 4 TDD cycles completed: new `bash-token-classification.ts` module with 43 unit tests (Step 1), clone removal by importing classifiers from the new module (Step 2), walker refactor to return-based `string[]` with four extracted helpers (Step 3), and architecture doc update marking Phase 2 Step 4 complete (Step 4).
A post-reviewer `style:` commit addressed two WARNs: removed an unreachable `token.startsWith("~/")` branch in `classifyTokenAsRuleCandidate` (covered by the earlier `includes("/")` check) and reordered the module to put exports first per the stepdown rule.
Test count: 1571 → 1614 (+43).

### Observations

- Pre-completion reviewer returned **PASS** with two WARNs: (1) the unreachable `~/` branch copied verbatim from the original classifier; (2) private `rejectNonPathToken` preceding the exported classifiers against the "Public API first" convention.
  Both were addressed in a `style:` commit before shipping.
- Step 3 required exactly one atomic commit as planned — the mutual recursion between `collectPathCandidateTokens` and `collectPatternCommandTokens` meant their signatures had to change together.
  The `PatternCommandFlagDirective` discriminated union worked cleanly: the `switch` on `directive.kind` narrows `nextArgAction` without any `!` or `as` casts, avoiding the Biome/ESLint assertion conflict flagged in the plan.
- `collectRedirectTokens` was simplified to use `ARG_NODE_TYPES.has(child.type)` (replacing the inline four-way `||` check), confirmed identical after comparing the original set literal to `ARG_NODE_TYPES`.
- `fallow dead-code` passed cleanly: both exported classifiers are consumed by `bash-path-extractor.ts`; private helpers (`rejectNonPathToken`, `classifyPatternCommandFlag`) carry no export risk.

## Stage: Final Retrospective (2026-05-31T15:01:56Z)

### Session summary

Shipped issue #289 across three stages (plan → TDD → ship) with no logic rework: a behavior-preserving decomposition of `bash-path-extractor.ts` that removed a 31-line classifier clone, extracted four walker helpers, and added 43 unit tests (1571 → 1614).
CI passed first try; no release-please PR (all commits were `refactor:`/`test:`/`style:`/`docs:`).
The single follow-up was a self-identified `style:` commit prompted by the pre-completion reviewer's two WARNs.

### Observations

#### What went well

1. The plan did real predictive work.
   All three pre-identified risks materialized exactly and their mitigations worked first-try: the Biome/ESLint assertion conflict was avoided by the `PatternCommandFlagDirective` discriminated union (no `!`/`as`), Step 3 needed exactly one atomic commit because of the mutual-recursion signature change, and `fallow dead-code` passed because only the consumed classifiers were exported.
2. Verification ran incrementally, not just at the end.
   A green baseline (`check`/`lint`/`test`) was confirmed before any TDD cycle, each cycle ran the affected file red-then-green, and the full suite plus `check`/`lint`/`fallow dead-code` ran after the last step — no end-loaded verification gap.
3. The pre-completion reviewer earned its keep on a behavior-preserving refactor.
   It caught latent dead code (`token.startsWith("~/")`) that the plan had deliberately copied verbatim, demonstrating that "behavior-preserving verbatim copy" is exactly the situation where a fresh-context review pays off.

#### What caused friction (agent side)

1. `missing-context` (minor) — the unreachable `token.startsWith("~/")` branch in `classifyTokenAsRuleCandidate` (subsumed by the earlier `token.includes("/")` check) existed in the original code, was not noticed during planning or Step 1 test-writing, and was copied verbatim into the new module.
   The plan explicitly prescribed line-for-line copying for behavior preservation, so the dead branch rode along and the Step 1 tests pinned current behavior without a distinct case for it.
   Impact: one follow-up `style:` commit (`55d2774a`), self-identified via the pre-completion reviewer's WARN — no logic rework, no user intervention.

#### What caused friction (user side)

1. None.
   The only user decision point — the two design forks (new module vs. in-file; return-based vs. accumulator) — was surfaced proactively via `ask_user` during planning, and the answers shaped the plan cleanly with no later reversal.

### Diagnostic details

- Model-performance correlation — the only subagent dispatch was the `pre-completion-reviewer`, pinned to `anthropic/claude-sonnet-4-6` (a valid registry alias, confirmed against `.pi/agents/pre-completion-reviewer.md`), so no silent fallback to the parent model occurred.
  A judgment-heavy review on an appropriate model; no mismatch.
- Feedback-loop gap analysis — verification was incremental throughout (baseline before TDD, red/green per cycle, full gate after the last step); no end-loaded-verification flag.
- Escalation-delay and unused-tool lenses found nothing notable (no rabbit-holes, no missing-context beyond the one minor item above).

### Changes made

1. Appended this Final Retrospective stage entry to `packages/pi-permission-system/docs/retro/0289-decompose-bash-path-extractor.md`.
   No `AGENTS.md` or prompt changes — the session's single minor friction was self-corrected and already covered by the pre-completion reviewer, so no rule was warranted.
