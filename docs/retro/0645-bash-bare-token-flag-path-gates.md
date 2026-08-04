---
issue: 645
issue_title: "pi-permission-system: Bash path gates miss bare symlink operands and paths embedded in flags"
---

# Retro: #645 — Bash path gates miss bare symlink operands and paths embedded in flags

## Stage: Planning (2026-07-24T21:04:26Z)

### Session summary

Verified both reported bypasses by tracing tokens through `token-classification.ts` / `bash-path-resolver.ts`: a bare in-project symlink (`cat outside-link`) never reaches canonicalization because [#509] promotion matches only the raw token against specific non-`*` `path` rules, and a `--file=/tmp/x` value is dropped by the leading-`-` prelude.
This is a third-party issue (author `marcoscale98`), so direction was confirmed across three `ask_user` rounds; the operator's meta-question ("what architecture change would make this class of problem easier?") reframed the plan from a targeted patch into a structural redesign.
Plan committed as `docs/plans/0645-bash-bare-token-flag-path-gates.md`.

### Observations

- **Chosen design — existence probe**: token classification is three-valued (definitely-path / definitely-not / unknown); "unknown" bare tokens are resolved by `lstat` (`PathNormalizer.entryExists`) instead of by consulting the ruleset.
  Candidacy from the filesystem, decision from explicit rules or the external boundary — never the universal fallback.
  This deletes the entire [#509] matcher thread (`PathRuleTokenMatcher`, `getPromotablePathTokenMatcher`, five-layer threading) rather than generalizing it.
- **Key discovery**: `describeBashPathGate` already implements the needed decision discipline — the `matchedPattern === undefined` guard (issue #58 in prose) treats universal-default-only matches as unrestricted, and `permission-manager.ts` sets `matchedPattern` only for `config`/`session` layers.
  Promoted tokens therefore need no new flag or manager consult.
- **Decision path across `ask_user` rounds**: round 1 chose bare-symlink-first with "full read-tool parity"; round 2 surfaced that literal parity + default-ask universal would prompt on every bare word, and the operator narrowed to rule-scoped gating; round 3 (after the reframing analysis) switched to the existence probe, added the ADR (0009, completeness contract), folded the flag-value case back in (it is token *preprocessing*, not classification — `--opt=value` split at collection), and required a performance spike using review-log commands before implementation.
- **No follow-up issues filed**: everything (both cases, ADR, spike) folded into #645 per the operator's "make the change easy" note.
- **Breaking**: two `fix(pi-permission-system)!:` commits planned (bare-token gating; flag-value gating), each with its own `BREAKING CHANGE:` footer; remediation via existing `path`/`external_directory` allow patterns was verified against the config surface.
- **Risk noted for implementation**: steps 5–6 are deliberately split (behavior change with the old thread present-but-ignored, then a pure type-level deletion) to bound test churn; the `#509` program-test promotion block migrates to tmpdir-symlink fixtures in step 5.
- **Spike gate**: p95 added cost < 1 ms/command; contingency (config-gated probe) named in the plan if it fails.

## Stage: Implementation — TDD (2026-07-24T22:15:00Z)

### Session summary

Executed all 8 steps of the plan's TDD Order plus one preparatory tidying, landing 8 commits.
The existence probe replaced [#509]'s rule-driven promotion, `--opt=value` values are split at collection, the five-layer matcher thread is deleted, and ADR 0009 records the completeness contract.
Test count 2570 → 2593 (+23); `check`, root `lint`, full `test`, and `fallow dead-code` all green.

### Observations

- **Spike passed with 23× headroom (plan step 1)**: over 2358 deduped real bash commands from the permission review log, 3535 prelude-surviving bare tokens (1.50/command), probe p95 **0.0427 ms/command** against a < 1 ms criterion; total probe cost 19.2% of the already-paid tree-sitter parse.
  The more valuable number was selectivity: only **118 of 3535 (3.3%)** bare tokens named an existing entry, which empirically confirms the design's claim that the probe drops ~97% of bare words and so cannot become a prompt firehose.
  That figure is now cited in ADR 0009.
- **Tidy-First earned its keep**: the assessor found a genuine landmine neither the plan nor the planning session had spotted — `program.test.ts` and `path-normalizer.test.ts` both *fully replaced* `node:fs` with a single `realpathSync` stub, so the first `lstatSync` call would have thrown `TypeError` across dozens of unrelated tests and turned step 5's red into noise.
  Landed as a preparatory `test:` commit (`d955190a`).
  Its rejected-as-scope-creep list was correctly scoped (declined a non-target file, the AST walk, and splitting a large test file), so the boundary held on this dispatch.
- **The same landmine recurred one module over**: `path-normalizer.test.ts` also stubbed `node:os` with only `homedir`, so `tmpdir()` was undefined.
  Caught during step 4 rather than by the assessor (which was scoped to `node:fs`); folded into step 4 since HEAD had moved past the prep commit and `git rebase -i` is off-limits here.
- **Deviation from the assessor (deliberate)**: its second recommendation — extracting `test/helpers/tmp-fixture.ts` as a standalone preparatory commit — was folded into step 4 instead.
  A fixture with no consumer would have been dead code until step 4, and `pnpm fallow dead-code` gates this repo.
- **Design refinement during step 5**: took the assessor's *optional* suggestion and gave both projections a single shared `probeBareToken`, plus extracted `collectIfExternal` from `projectExternalPaths`.
  A promoted token is now identical whether it is matched against `path` rules or tested against the cwd boundary, which is the property that makes the two bypasses one fix rather than two.
- **The `--opt=value` split could not live where first assumed**: post-filtering the collected token list would have missed the reported `grep --file=…` case exactly, because a pattern-first command's collector classifies a flag as `regular-flag` and never emits it.
  The split therefore reads the argument nodes directly in `collectCommandTokens`.
  Worth remembering: `PATTERN_FIRST_COMMANDS` swallows flag tokens.
- **Two composition-root tests failed as designed, not by accident**: the migrated [#509] tests never created `id_rsa`/`key.pem` on disk, so the probe correctly declined to promote them.
  Re-pinned probe-style (create the file, assert deny) and supplemented with a test asserting the *narrowing* itself — a bare token naming nothing is not gated even under a matching deny rule.
- **Both issue repros are now pinned end-to-end** in `composition-root.test.ts` under a permissive `cat *` / `grep *` bash rule, alongside a new test for the [#58] guard (an existing bare file with no explicit rule stays unrestricted), which the plan flagged as covered only via shaped tokens.
- **Hit two AGENTS.md traps**: miscounted a decorative `─` rule in a `token-collection.ts` `oldText` (fixed by restoring the rule to its sibling's 78-char width), and emitted stray `oldText2`/`newText2` keys in one architecture-doc edit — silently ignored, so the block count had to be reconciled against intended edits, exactly as documented.
- **Orphan import caught only by biome's warning level**: deleting the manager matcher tests left `createInMemoryPolicyLoader` unused; `pnpm run lint` still exits 0 on it, so it was found by reading `biome check` output directly.
  The testing skill warns about precisely this.
- **Pre-completion reviewer: WARN** — sole finding was the then-missing TDD stage entry (this one).
  All seven named at-risk invariants verified as pinned or untouched; both `BREAKING CHANGE:` remediations confirmed to exist in the real config surface.

## Stage: Final Retrospective (2026-07-24T23:05:00Z)

### Session summary

One continuous session carried #645 from planning through ship: a third-party bug report of two bash path-gate bypasses became a structural redesign (existence probe replaces [#509]'s rule-driven promotion) plus a flag-value split and ADR 0009.
Shipped as `pi-permission-system-v23.0.0` (major, two `fix!:` commits) with the release-please PR merged and publish CI green.
Execution was notably clean — the friction was a handful of self-caught mechanical slips, no rework or rabbit-holes.

### Observations

#### What went well

- **The performance spike earned its place in the plan, and its real payload was selectivity, not speed.**
  Plan step 1 benchmarked the `lstat` probe over 2358 real logged commands: p95 0.043 ms/command (23× under the 1 ms gate) — but the decisive number was that only 118 of 3535 bare tokens (**3.3%**) named an existing entry.
  That empirically validated the design's central claim (candidacy-from-filesystem cannot become a prompt firehose), and the figure now lives in ADR 0009 rather than a scratch file.
  A spike that gates a design decision *and* leaves a durable artifact is the pattern worth repeating.
- **Tidy-First's first high-value catch.**
  The `tidy-first-assessor` found a landmine neither the plan nor the planning session saw: `program.test.ts` and `path-normalizer.test.ts` fully replaced `node:fs` with a lone `realpathSync` stub, so the probe's first `lstatSync` would have thrown `TypeError` across dozens of unrelated tests — turning step 5's Red into noise.
  Landed as preparatory commit `d955190a`; its rejected-as-scope-creep list stayed correctly scoped (declined a non-target file, the AST walk, a large-file split), so the boundary held on this dispatch.
- **Three `ask_user` rounds genuinely bent the design.**
  Round 2 surfaced that "literal read-tool parity" under a default-`ask` universal would prompt on *every* bare word; round 3 switched to the existence probe.
  The correction happened at planning — in prose, before any code — which is exactly where a third-party issue's "whether/in-what-form" ambiguity should be resolved.
- **Incremental verification throughout (feedback-loop lens: no gap).**
  Every TDD cycle ran its affected file Red→Green, `tsc` after each interface change, and the full suite at cycle boundaries; the deliberate steps 5→6 split (behavior change with the old thread present-but-ignored, then a pure type-level deletion) bounded test churn as planned.

#### What caused friction (agent side)

- `instruction-violation` (self-identified) — hit two **already-documented** `Edit`-tool traps from `AGENTS.md` § "Edit tool batches": miscounted a decorative `─` rule in `token-collection.ts` (biome parse error), and emitted stray `oldText2`/`newText2` keys in an architecture-doc edit (silently ignored).
  Impact: ~2–3 extra tool calls each, no rework beyond the fix.
  Both rules already exist and are crisp; the failure is salience-at-edit-time, not a missing rule — no doc change would help, so none is proposed.
- `missing-context` — the full-replacement mock landmine recurred one module over: `path-normalizer.test.ts` also stubbed `node:os` with only `homedir`, so the fixture's `tmpdir()` was `undefined`.
  The assessor was scoped to `node:fs` and did not generalize to sibling builtins.
  Impact: one extra fix inside step 4, no separate commit.
  This is the one friction point with a reusable lesson (see Changes made).
- `other` (macOS fixture detail) — the two `externalPaths` symlink tests first failed on `/var` → `/private/var`: the *outside* tmpdir was not canonicalized while `boundaryValue()` correctly was.
  Impact: ~2 tool calls, fixed test-side with a `canonicalDir` helper.
- `other` (biome warning-level orphan) — deleting the matcher tests orphaned `createInMemoryPolicyLoader`; `noUnusedImports` is warning-level so `lint` stayed green.
  Caught by reading `biome check` output directly, exactly as the testing skill's existing note advises.
  Impact: one edit.

#### What caused friction (user side)

- None material.
  The division was ideal: strategic judgment concentrated in the three planning `ask_user` rounds, then fully autonomous execution through TDD and ship.
  The one design pivot (round 2 → round 3) was surfaced by the agent as a dedicated question rather than requiring a user catch — the gate working as intended, not friction.

### Diagnostic details

- **Model-performance correlation** — orchestration ran on `claude-opus-4-8` (judgment-heavy: three `ask_user` design rounds, 8-step TDD, ship coordination); both subagents (`tidy-first-assessor`, `pre-completion-reviewer`) ran on `anthropic/claude-sonnet-5` per their frontmatter — appropriate for bounded read-only assessment/review.
  No mismatch.
- **Escalation-delay** — no sequence exceeded 5 consecutive tool calls on one error; every mechanical slip resolved in 1–3 calls.
  No subagent-dispatch or user-ask was warranted-but-skipped.
- **Unused-tool** — none.
  The two subagents that would help (tidy-first, pre-completion) were both dispatched; the codebase was already deeply understood from planning, so `Explore`/`colgrep` were not needed.
- **Feedback-loop** — verification was incremental throughout; no end-only batching.

### Changes made

1. `.pi/skills/testing/SKILL.md` — added a rule to the *vi.mock and hoisting* section: a `vi.mock("node:*")` factory returning an object literal replaces the module, so an omitted sibling export (`lstatSync`, `tmpdir`) becomes `undefined` and throws `TypeError` in unrelated tests; spread `vi.importActual` to stub one export while keeping the rest.
   Complements the existing `node:*` `default`-key rule directly above it.
2. Considered but not landed (recorded above under "Considered but not proposed"): no `AGENTS.md` `Edit`-trap change (rules already exist and are crisp), no macOS-tmpdir package-skill note (marginal; `tmp-fixture.ts` centralizes it), no widening of the `tidy-first-assessor` scope (its change-scoped discipline is a feature).

[#58]: https://github.com/gotgenes/pi-packages/issues/58
[#509]: https://github.com/gotgenes/pi-packages/issues/509
