---
issue: 645
issue_title: "pi-permission-system: Bash path gates miss bare symlink operands and paths embedded in flags"
---

# Close the bash bare-token and flag-embedded path-gate gaps

## Release Recommendation

**Release:** ship independently

This issue is not part of any architecture-roadmap phase, and it is a breaking security fix (`fix!`) that should reach users as its own major release rather than batching behind unrelated work.

## Problem Statement

The bash path projection can miss real filesystem operands in two compositions, letting a broad bash allow rule (`cat *`, `grep *`) bypass `path` and `external_directory` enforcement:

1. A bare operand (`cat outside-link`, where `outside-link` is an in-project symlink to `/tmp/…`) has none of the shapes the token classifiers accept, and rule-driven promotion ([#509]) fires only when the **raw** token matches a specific non-`*` `path` deny/ask rule — so a symlink whose *target* is denied, or any bare token under only-wildcard/`external_directory` policies, never reaches canonicalization or either path gate.
2. A path embedded in an option (`grep --file=/tmp/patterns target`) is rejected by the shared `rejectNonPathToken` prelude (leading `-`) before the embedded `/tmp/patterns` can be classified.

Both are silent fail-open collapses of the same structural gap: token classification is binary (path-candidate / not), while the domain is three-valued (definitely-path / definitely-not / **unknown**), and "unknown" is folded into "not a path".

This is a third-party issue (author `marcoscale98`); the operator confirmed direction across three `ask_user` rounds (see Background).

## Goals

- Close bypass 1: a bare token that names an **existing** filesystem entry is promoted into the path projection, canonicalized (symlink-resolved), and gated — by explicit `path` rules for in-tree targets, and by the `external_directory` surface when the canonical form resolves outside the working tree.
- Close bypass 2: a `--opt=value` token has its value split out at collection time and classified by the existing shape classifiers, so `--file=/tmp/patterns` reaches both path surfaces while `--format=json` stays untouched.
- Delete the [#509] rule-driven promotion machinery (`PathRuleTokenMatcher`, `getPromotablePathTokenMatcher`, and its five-layer thread from manager to resolver) — the existence probe subsumes it and decouples the classifier from the ruleset.
- Land ADR 0009 documenting the bash path projection's **completeness contract**: what it guarantees, what it deliberately omits, and the surfacing-vs-judge layering principle.
- Run a performance spike against real command data from the permission review log before implementation, with a go/no-go criterion.
- **This change is breaking**: on upgrade, bash commands referencing existing bare-named files/symlinks whose resolved form matches a `path` deny/ask rule (or resolves outside the tree), and commands carrying path-shaped `--opt=value` values, are now gated where they were previously allowed by a permissive bash rule.
  Commits use `fix(pi-permission-system)!:` with `BREAKING CHANGE:` footers.

## Non-Goals

- Glued short-option values (`-f/tmp/x`) — genuinely per-command knowledge; out of contract (recorded in ADR 0009).
- Computed paths (`$VAR`, `$(…)`) — already conservatively handled by the unknown-base machinery where visible; resolving them is out of contract.
- Per-command argument-semantics tables (which args of `grep`/`git` are files) — the principled home is the model-judge authorizer link ([#620], already filed and on the roadmap), which reviews surfaced asks with full command context.
- Gating nonexistent bare write targets (`touch newfile`) — the probe cannot see a file that does not exist yet; redirect targets are already collected separately and unaffected.
- No follow-up issues are filed: the operator folded both bypass cases, the ADR, and the spike into this single issue.

## Background

- `src/access-intent/bash/token-classification.ts` — the three pure classifiers plus the shared `rejectNonPathToken` prelude.
  `classifyPromotedRuleCandidate` implements [#509] raw-token promotion and is replaced by this change.
- `src/access-intent/bash/bash-path-resolver.ts` — walks the AST once, projecting `externalPaths` (strict classifier) and `ruleCandidates` (broad classifier + promotion fallback); holds the injected `PathNormalizer` and the [#509] `isPromotablePathToken` predicate.
- `src/access-intent/bash/token-collection.ts` — collects argument/redirect tokens; owns `PATTERN_FIRST_COMMANDS` (embryonic per-command knowledge: `grep`/`sed` pattern args are skipped).
  The `--opt=value` split lands here.
- `src/access-intent/bash/program.ts` — `BashProgram.parse(command, normalizer, isPromotablePathToken?, options?)`; the promotion parameter is deleted.
- `src/permission-manager.ts` — `getPromotablePathTokenMatcher` builds the [#509] matcher; deleted.
  Constraint (AGENTS/ADR-0002): the manager stays string-based and must not import `AccessPath`; this plan only *removes* a manager method, so the lint-guarded boundary is untouched.
- `src/permission-session.ts`, `src/handlers/gates/tool-call-gate-pipeline.ts` — delegate and `ToolCallGateInputs` thread of the matcher; both shrink.
- `src/handlers/gates/bash-path.ts` — the bash `path` gate already implements the decision discipline this design needs: a candidate whose check has `matchedPattern === undefined` (only the synthesized universal default matched — `permission-manager.ts` sets `matchedPattern` only for `config`/`session`-layer rules) is treated as unrestricted ([#58]).
  Promoted tokens inherit this guard with no new flag.
- `src/path/canonicalize-path.ts` — best-effort `realpathSync` canonicalization ([#493]); already makes filesystem state part of the decision input, so an `lstat` probe adds nothing new to the trust model.
- `src/handlers/gates/bash-path-extractor.ts` — secondary `BashProgram.parse` caller (no matcher today); gains probe behavior automatically once the resolver owns it.
- Operator decisions (three `ask_user` rounds): (1) bare-symlink case in scope; (2) rule-scoped rather than literal read-tool parity (no universal-fallback blow-up); (3) final direction — **existence probe** for candidacy + explicit-rules/external-boundary for decision, ADR included, flag-value split folded in, performance spike required.

## Design Overview

### The decision model in one sentence

A bare token is a path candidate iff it names an existing filesystem entry; a promoted candidate is gated only by explicit `path`/`external_directory` rules or by resolving outside the working tree — never by the universal fallback.

### Three-valued classification and the probe

The classifiers already partition tokens into definitely-path (shape), definitely-not (prelude), and unknown (bare words).
Today unknown collapses to not-path (fail-open).
The probe resolves unknown deterministically at decision time via the filesystem:

```typescript
// PathNormalizer gains one method (lives beside canonicalization, the
// package's existing fs edge):
/** True when `absolutePath` names an existing filesystem entry (lstat —
 *  a symlink counts even when its target is dangling). */
entryExists(absolutePath: string): boolean;
```

Consumer sketch (`BashPathResolver.projectRuleCandidates`, promoted branch):

```typescript
const bare = classifyBareTokenCandidate(token); // prelude-only; null for flags/URLs/…
if (bare && base.kind === "known") {
  const path = this.normalizer.forBashToken(bare, { resolveBase });
  if (this.normalizer.entryExists(path.value())) result.push({ token: bare, path });
}
```

- `cat outside-link` → `./outside-link` exists (lstat) → promoted → `AccessPath` canonicalization resolves the symlink → `/tmp/pi-permission-test-secret` → the bash `external_directory` gate and the `path` gate both see it.
  Bypass 1 closed.
- `git status` → `./status` ENOENT → dropped.
  No prompt noise; the [#509] no-blow-up property is preserved and *improved* — even under an explicit `path: {"*": "deny"}`, only bare words naming real files are gated.
- `a_sym → .some.secret` under `path: {".some.secret": "deny"}` → promoted (exists), canonical match value is the target → denied.
  The raw-token matcher could never catch this; the probe + existing canonicalization does.
- A dangling symlink lstats as existing but canonicalizes lexically (its target is gone); it stays internal and unrestricted — harmless, since the read itself fails.

### Decision discipline (no new mechanism)

- **`path` surface**: promoted candidates enter `pathRuleCandidates()` like `./`-prefixed tokens; the existing [#58] guard in `describeBashPathGate` (`matchedPattern === undefined` → unrestricted) already scopes the decision to explicit `config`/`session` rules.
  No `promoted` flag, no manager consult, no new result field.
- **`external_directory` surface**: a promoted candidate whose canonical boundary form resolves outside the tree joins `externalPaths` and is gated exactly like `cat /tmp/x` is today — including the universal fallback (`ask` by default).
  This makes bare symlinks *consistent* with absolute paths: one rule to explain.
- **Unknown effective base** ([#393]): a bare token after a non-literal `cd` cannot be resolved, so it cannot be probed — it stays dropped (conservative, unchanged).

### Flag-value extraction (bypass 2)

Token preprocessing in `token-collection.ts`, not a classifier change: when a collected argument token matches `^-{1,2}[^=\s]+=(.+)$`, additionally emit the value part as its own token (the original flag token is still emitted and still rejected by the prelude — harmless).
The value then flows through the *existing* shape classifiers and the new probe:

- `--file=/tmp/patterns` → `/tmp/patterns` — definitely-path → both surfaces.
- `--format=json` → `json` — bare, `./json` almost never exists → dropped.
- `--file=~/x`, `--file=../x`, `--file=C:\x` → shape-classified as today.

This is command-agnostic — no option tables — and benefits both projections in one place.

### Deletion of the [#509] matcher thread

`PathRuleTokenMatcher` (types.ts), `getPromotablePathTokenMatcher` (manager interface + implementation + session delegate + `ToolCallGateInputs`), the `isPromotablePathToken` parameter of `BashProgram.parse` and the `BashPathResolver` constructor, both `NO_PROMOTION` constants, and `classifyPromotedRuleCandidate`'s matcher parameter all go away.
`classifyPromotedRuleCandidate` is renamed `classifyBareTokenCandidate(token): string | null` — prelude-only, returning the token when it *could* be a path (not a flag/URL/env-assignment/`@scope`/regex).
`BashProgram.parse` shrinks to `(command, normalizer, options?)`.

### Performance spike (pre-implementation gate)

The probe adds one `lstatSync` per bare token that survives the prelude, per parsed command — only bare words (`log`, `status`, `build`), since shaped tokens skip it.

- **Corpus**: extract `command` fields from the permission review log (`<globalLogsDir>/pi-permission-system-permission-review.jsonl`, see `REVIEW_LOG_FILENAME` in `src/config-paths.ts`), deduplicated; fall back to a synthetic corpus of representative commands if the log is sparse.
- **Measure**: per-command added wall time of lstat-probing every prelude-surviving bare token (existing and ENOENT mixes), compared against the already-paid tree-sitter parse cost.
- **Criterion**: added p95 < 1 ms per command (expectation: single-digit µs per lstat, 1–3 bare tokens per command).
- **Contingency** if the criterion fails (not expected): gate the probe behind "any explicit `path`/`external_directory` restriction exists in config" — a pipeline-level config consult, still no classifier↔ruleset coupling.
- The spike is a scratch script; results are recorded in the retro file, not committed as product code.

### ADR 0009 — bash path projection completeness contract

- **Guarantees**: shape-classified tokens (absolute, `~/`, `..`, separator-bearing, drive-letter, win32 backslash-relative), redirect targets, `--opt=value` embedded values, existing bare entries (the probe), literal-`cd` base folding, wrapper flooring for opacity.
- **Deliberate omissions**: nonexistent bare write targets, glued short options, computed paths, per-command argument semantics.
- **Layering principle**: the deterministic layer biases toward *surfacing* (`ask`) and the model-judge chain ([#620]) absorbs false positives — over-suppression is unrecoverable, over-surfacing is recoverable.
- **Determinism note**: filesystem state (existence, symlink targets) is part of the decision input, accepted since canonicalization ([#493]); same policy + same fs state + same input → same decision.
- Future triage rule: a new report is either inside the contract (fix) or outside it (accepted residual / judge's job).

## Module-Level Changes

- `src/path-normalizer.ts` — add `entryExists(absolutePath): boolean` (lstat-based; delegates fs to the same edge as canonicalization).
- `src/access-intent/bash/token-classification.ts` — rename `classifyPromotedRuleCandidate` → `classifyBareTokenCandidate`; drop the `isPromotable` parameter and the `PathRuleTokenMatcher` import; update module JSDoc (three-valued framing, probe pointer).
- `src/access-intent/bash/token-collection.ts` — `--opt=value` split emitting the value token; unit-visible via `collectCommandTokens`/`collectPathCandidateTokens`.
- `src/access-intent/bash/bash-path-resolver.ts` — constructor loses `isPromotablePathToken` and `NO_PROMOTION`; `projectRuleCandidates` promoted branch becomes probe-based; `projectExternalPaths` gains the probe branch for bare tokens (known base only); class JSDoc updated.
- `src/access-intent/bash/program.ts` — `parse` signature shrinks to `(command, normalizer, options?)`; JSDoc updated.
- `src/permission-manager.ts` — delete `getPromotablePathTokenMatcher` (interface + implementation), `NO_PROMOTION`, and now-unused imports (`PathRuleTokenMatcher`; `wildcardMatch`/`pathMatchOptions` if unused after removal).
- `src/permission-session.ts` — delete the delegate method and `PathRuleTokenMatcher` import.
- `src/handlers/gates/tool-call-gate-pipeline.ts` — remove `getPromotablePathTokenMatcher` from `ToolCallGateInputs`; update the `parse` call.
- `src/types.ts` — delete `PathRuleTokenMatcher`.
- `src/handlers/gates/bash-path-extractor.ts` — `parse` call updated (signature only; gains probe behavior automatically).
- `docs/decisions/0009-bash-path-projection-completeness-contract.md` — new ADR (next free number after 0008).
- `docs/architecture/architecture.md` — module-tree entries for `rule.ts` (drop the `getPromotablePathTokenMatcher` reuse note), `permission-manager.ts` (drop the matcher sentence), `bash-path-resolver.ts` (probe-based promotion), `token-classification.ts` (renamed classifier), `tool-call-gate-pipeline.ts` (shrunk `ToolCallGateInputs`), `token-collection.ts` (flag-value split), `path-normalizer` entry if listed; rework the model-judge prose (lines ~590–592) that describes [#509] rule-driven promotion — the promoted-token-emits-the-same-descriptor composition claim survives, the raw-token-matcher description does not; add the completeness-contract pointer.
- `.pi/skills/package-pi-permission-system/SKILL.md` (repo root) — rewrite the bare-filename promotion paragraph in Notes for Agents (probe semantics), and the `getPromotablePathTokenMatcher` mentions in the Testing section fixtures list.
- `docs/configuration.md` — grep hits for promotion/bare-token prose; update to probe semantics.
- `test/helpers/session-fixtures.ts`, `test/helpers/gate-fixtures.ts` — drop the `getPromotablePathTokenMatcher` stubs and `PathRuleTokenMatcher` imports (`makeGateInputs`, `makeFakePermissionManager`).
- `test/access-intent/bash/token-classification.test.ts`, `test/access-intent/bash/program.test.ts` (the `rule-driven bare-token promotion (#509)` describe block migrates to probe semantics with real tmpdir files/symlinks), `test/access-intent/bash/token-collection.test.ts`, `test/permission-manager-unified.test.ts` (matcher tests deleted), `test/permission-resolver.test.ts`, `test/handlers/gates/tool-call-gate-pipeline.test.ts`, `test/composition-root.test.ts` — updated per the TDD order.
- No `package.json` `files` changes (docs/decisions already ships).

## Test Impact Analysis

1. **New tests enabled**: `PathNormalizer.entryExists` unit tests (tmpdir: file, dir, symlink, dangling symlink, ENOENT); probe-promotion resolver/program tests with real symlinks (in-tree → external target, in-tree → in-tree denied target, dangling); flag-value split collection tests; end-to-end gate tests for both repro commands from the issue.
2. **Tests made redundant**: the [#509] matcher-shaped tests (`promotes when the matcher says promotable`, `default no-op matcher`, manager `getPromotablePathTokenMatcher` pattern-filter tests) — deleted with the mechanism; their *behavioral* intent (bare denied filename gated, `git status` silent) is re-pinned probe-style.
3. **Tests that stay**: shape-classifier tests, cd-folding/pipeline-walk tests, [#393] unknown-base tests, [#533] MSYS tests, wrapper-flooring tests — all untouched surfaces.

## Invariants at risk

- **[#509] no-blow-up** (`git status` never prompts under specific path rules) — pinned today by the program-test promotion block; the migrated probe tests must keep an explicit `git status`-shaped case (ENOENT bare token dropped), plus a new case under explicit `path: {"*": "deny"}`.
- **[#58] universal-fallback-unrestricted guard** in `describeBashPathGate` — becomes the decision discipline for promoted tokens; add a test pinning that a promoted existing file with no explicit `path` rule stays unrestricted (currently the guard is exercised only via shaped tokens).
- **[#393] unknown-base conservatism** — bare tokens after a non-literal `cd` stay unpromoted; keep the existing literal-only test and add a probe-era assertion.
- **[#533] win32 literal-only tokens** — non-mount POSIX absolutes are shaped, never bare; probe branch requires `base.kind === "known"` and a resolvable lexical value, so literal-only handling is untouched; existing tests stay.
- **Model-judge composition** (architecture prose, phase 12): "a promoted token emits the same structured descriptor a prefixed path does" — preserved by construction (promoted candidates flow through the same `BashPathRuleCandidate`/gate path); the prose update must keep this claim while replacing the rule-driven mechanism description.
- **ADR-0002 string boundary** — the manager only *loses* a method; no `AccessPath` import is added anywhere near it.
- **[#309] advisory parity** — the advisory bash check is bash-surface only and does not consume the path projection; unaffected.
  `bash-path-extractor` consumers gain probe-consistent external paths (strictly more surfacing, never less).

## TDD Order

1. **Spike (no product commit)** — benchmark `lstatSync` per prelude-surviving bare token over the review-log command corpus; record numbers and go/no-go in the retro file.
   If the criterion fails, stop and re-plan with the config-gated contingency.
2. **`docs(pi-permission-system): add ADR 0009 bash path projection completeness contract`** — the ADR frames the contract the following cycles pin; include the architecture-doc pointer to it.
3. **`refactor(pi-permission-system): expose bare-token prelude classifier`** — red: `token-classification.test.ts` covers `classifyBareTokenCandidate` (prelude-only semantics: flags/URLs/env-assignments/`@scope`/regex rejected, plain words returned); green: rename + drop the matcher parameter *inside the classifier module only* (`bash-path-resolver.ts` adapts at its call site by wrapping the still-injected predicate); no behavior change.
4. **`refactor(pi-permission-system): add entryExists probe to PathNormalizer`** — red: normalizer tests (tmpdir file/dir/symlink/dangling/ENOENT, win32 flavor construction per skill guidance); green: lstat implementation.
   Pure addition, unwired.
5. **`fix(pi-permission-system)!: gate existing bare-named files and symlinks in bash commands`** — red: program/resolver tests for the issue's repro (`cat outside-link` with a real tmpdir symlink → appears in `externalPaths` and `ruleCandidates` with canonical target in `matchValues`), the `a_sym → denied-target` case, `git status` silence, explicit-`*` behavior, unknown-base conservatism; a gate-level test pinning the [#58] guard for a promoted no-rule file; green: probe-based promoted branch in `projectRuleCandidates` + probe branch in `projectExternalPaths`; `BashPathResolver` still accepts (and now ignores) the injected predicate to keep this commit's blast radius inside the resolver.
   Migrate the `#509` program-test block in this step.
   `BREAKING CHANGE:` footer: bash commands referencing existing bare-named files or in-project symlinks are now gated by `path` rules (canonical, symlink-resolved) and by `external_directory` when they resolve outside the working directory; previously a permissive bash rule could bypass both.
   Remediation: add `external_directory`/`path` allow patterns for intended targets (both config surfaces exist today).
6. **`refactor(pi-permission-system): delete the rule-driven promotion thread`** — remove `PathRuleTokenMatcher`, `getPromotablePathTokenMatcher` (manager + session + `ToolCallGateInputs`), the `parse`/resolver parameters, both `NO_PROMOTION`s, fixture stubs, and the manager matcher tests; `pnpm fallow dead-code` clean.
   Type-breaking removal, so all consumers and fixtures move in this one commit.
7. **`fix(pi-permission-system)!: classify path values embedded in --opt=value tokens`** — red: collection tests (`--file=/tmp/x` value emitted, `--format=json` value emitted-but-bare, original flag token preserved, `-o=x` single-dash form, no split without `=`); program-level test for the issue's `grep --file=/tmp/pi-permission-patterns target` repro reaching `externalPaths`; green: the split in `token-collection.ts`.
   `BREAKING CHANGE:` footer: path-shaped values embedded in `--opt=value` bash tokens are now extracted and gated by the `path`/`external_directory` surfaces.
8. **`docs(pi-permission-system): update architecture and skill docs for probe-based path candidacy`** — architecture module-tree entries, model-judge prose rework, `docs/configuration.md`, and the package skill (`.pi/skills/package-pi-permission-system/SKILL.md`) per Module-Level Changes.

## Risks and Mitigations

- **Probe cost on hot bash paths** — mitigated by the spike gate (step 1) with an explicit criterion and a named contingency; lstat runs only for prelude-surviving bare tokens with a known base.
- **Prompt-noise regression** — bounded by design: ENOENT tokens are dropped, in-tree promoted tokens are gated only by explicit rules ([#58] guard), and external promotion matches the existing absolute-path behavior.
  The genuinely new prompts (existing bare file matching a rule; bare symlink escaping the tree) are the fix.
- **Filesystem-state dependence** — already part of the trust model since [#493] canonicalization; stated explicitly in ADR 0009.
- **Large test churn in steps 5–6** — split deliberately: step 5 changes behavior with the old thread still present-but-ignored; step 6 is a pure type-level deletion.
- **Windows semantics** — the probe operates on the resolved lexical absolute from `forBashToken`, which already carries MSYS/drive-mount handling ([#533]); win32 tests construct a `win32PathFlavor` normalizer per the package's testing rule.
- **`--opt=value` false splits** (e.g. a token like `--date=%Y/%m/%d`) — the value still passes the shape classifiers and the regex-metachar/URL prelude; a value like `%Y/%m/%d` is separator-bearing and would be rule-candidate classified, but matches no explicit rule and is dropped by the [#58] guard; external classification requires an absolute/`~`/`..` shape, which format strings lack.

## Open Questions

- Should the probe eventually distinguish file-type (symlink vs regular vs directory) for finer policy (e.g. gate only symlinks)?
  Deferred; the current design needs only existence, and type-based narrowing would weaken the bare-denied-filename parity.
- Whether `PATTERN_FIRST_COMMANDS` should also skip flag-value extraction for pattern-position flags (`grep -e PATTERN`) — today `-e PATTERN` is two tokens and the pattern is skipped positionally; no change needed unless a report shows otherwise.
- The model-judge opaque-bash adjudicator ([#620]) remains the successor for argument-semantics false positives; nothing here blocks it.

[#58]: https://github.com/gotgenes/pi-packages/issues/58
[#309]: https://github.com/gotgenes/pi-packages/issues/309
[#393]: https://github.com/gotgenes/pi-packages/issues/393
[#493]: https://github.com/gotgenes/pi-packages/issues/493
[#509]: https://github.com/gotgenes/pi-packages/issues/509
[#533]: https://github.com/gotgenes/pi-packages/issues/533
[#620]: https://github.com/gotgenes/pi-packages/issues/620
