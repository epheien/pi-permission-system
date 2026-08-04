---
issue: 502
issue_title: "pi-permission-system: migrate the per-tool path-bearing gate onto AccessPath (Phase 7 Step 1)"
---

# Retro: #502 — Migrate the per-tool path-bearing gate onto AccessPath (Phase 7 Step 1)

## Stage: Planning (2026-06-29T00:00:00Z)

### Session summary

Planned Phase 7 Step 1: route the per-tool path-bearing gate (`read`/`write`/`edit`/`grep`/`find`/`ls`) onto `AccessPath` so per-tool rules match lexical ∪ canonical, closing the symlink-evasion asymmetry against the `path` surface.
The change is mechanically parallel to [#486] (the `path`-surface migration): the resolver already unwraps `access-path` → `path-values` and `PATH_SURFACES` already routes the per-tool surfaces through `evaluateAnyValue`, so the only behavior change is the canonical alias joining the match set.
Produced a three-step plan (breaking `feat!:` behavior change, a `refactor:` accessor removal, then docs) at `docs/plans/0502-per-tool-gate-access-path.md`.

### Observations

- **`getPlatform()` removal is forced, not optional, and resolves [#513].**
  [#511] is already merged, so [#502] is the *second* of the two `getPlatform()` consumers to fold.
  Once the per-tool gate stops reading `platform` (it threaded it only to feed `deriveSuggestionValue`'s `normalizePathForComparison`), the pipeline's `getPlatform()` read is dead and the accessor would trip the `pnpm fallow dead-code` CI gate.
  So Step 2 removes `getPlatform()` from `ToolCallGateInputs` + `PermissionSession` + `makeGateInputs`, and [#513] should be closed at ship with a pointer to the [#502] SHA.
- **Scope discriminator:** keyed the `access-path` branch off `getPathBearingToolPath(...) !== null` (built-in six with a present `input.path`).
  This deliberately keeps the missing-path case on the `tool` intent so the `normalizeInput` `["*"]` fallback is preserved, and keeps MCP/extension tools on `tool` (their path is already symlink-resistant via the cross-cutting `path` gate since [#486]).
- **Suggestion value is provably unchanged:** `accessPath.value()` equals the old `normalizePathForComparison(path, tcc.cwd, platform)` because the pipeline normalizer is built from the same session `cwd` + `platform`.
  Flagged the two [#438] cwd-bounding tests as the invariants to keep green (now passing an injected `AccessPath` built via `new PathNormalizer(...)`).
- **Structural win:** the change removes a parameter relay — `platform` threaded session → pipeline → `describeToolGate` solely to feed one derivation the `AccessPath` the gate already builds now owns (Tell-Don't-Ask via `value()`).
- **Release:** Step 1 of batch "symlink-resistant-path-matching" (tail = Step 3, [#504]); mid-batch → defer.
  The breaking `feat!:` lands on `main` and auto-batches; the major-bump release cuts when Step 3 lands.
- Skipped the `ask_user` gate: operator-authored issue, unambiguous proposal, and the only scope addition (`getPlatform()` removal) is forced by the dead-code gate + [#513], not a genuine design choice.

## Stage: Implementation — TDD (2026-06-29T10:15:00Z)

### Session summary

Implemented all three planned TDD steps: the breaking `feat!:` per-tool gate migration to `access-path`, the `refactor:` removal of the dead `getPlatform()` accessor (resolving [#513]), and the `docs:` updates marking Phase 7 Step 1 complete.
Four new tests added (suite 2211 → 2215); full suite, `tsc`, root lint, and `pnpm fallow dead-code` all green.
Pre-completion reviewer returned PASS.

### Observations

- **One unplanned deviation — a stale fallow suppression.**
  Adding the explicit `bashProgram: BashProgram | null` annotation in the new `resolvePerToolCheck` helper gave fallow a resolvable receiver for `BashProgram.commands()`, which retired the long-standing `unused-class-member` false-positive suppression in `program.ts`.
  Removed it as a focused fourth `refactor:` commit (not in the plan; the plan only listed the touched files).
  This is why `fallow dead-code` must be run — the baseline-green checks (check/lint/test) do not catch a now-stale suppression.
- **`describeToolGate` signature change was structurally improved, not just mechanical.**
  Swapping the `platform: NodeJS.Platform` parameter for an optional `accessPath?: AccessPath` removed a three-layer parameter relay (Tell-Don't-Ask via `value()`), exactly as the plan predicted.
- **The `tool.test.ts` red was weak; the pipeline test carried the real red.**
  Passing an `AccessPath` where the old code expected a `platform` string coincidentally behaved like posix (an object `!== "win32"`), so `tool.test.ts` passed against old code.
  The meaningful behavioral red (per-tool gate emits `access-path`; symlink-canonical match blocks) lived in `tool-call-gate-pipeline.test.ts`, which used the established `node:fs` `realpathSync` mock from `path.test.ts`.
- **Pre-completion reviewer: PASS** — no warnings; all cross-step invariants ([#486], [#438], [#510], missing-path fallback) verified preserved by their pinning tests.
- **Remaining for ship:** close [#513] with a pointer to the [#502] SHA (its `getPlatform()` removal is folded into this work); confirm the mid-batch release deferral (batch "symlink-resistant-path-matching", tail = Step 3 [#504]).

## Stage: Final Retrospective (2026-06-29T14:26:40Z)

### Session summary

Shipped Phase 7 Step 1 across plan → TDD → ship in one continuous session: a breaking `feat!:` per-tool gate migration to `access-path`, the folded-in [#513] `getPlatform()` removal, an unplanned stale-suppression cleanup, and docs.
The operator deferred the release (mid-batch); commits landed on `main`, CI passed, and [#513] was closed with a pointer to the [#502] SHA while [#502] stays open until the batch tail (Step 3, [#504]) ships.
A notably clean run — no rework, no rabbit-holes, pre-completion PASS.

### Observations

#### What went well

- **Reading the [#486] plan as a template made planning fast and accurate.**
  [#502] was "mechanically parallel to [#486]", so loading the prior plan and the already-migrated `path.ts` / `path.test.ts` gave a ready-made design (the `access-path` intent shape, the `node:fs` `realpathSync` mock convention) and a correct prediction of every invariant at risk.
- **Verifying related-issue state caught the [#513] fold-in.**
  Checking that [#511] was already `CLOSED` made [#502] the *second* `getPlatform()` consumer to fold, so the dead-code gate forced the accessor removal into this issue — a scope point that would have surfaced as a CI failure if planned around instead.
- **The fallow gate did its job.**
  The post-step `pnpm fallow dead-code` run flagged a now-stale suppression that the baseline check/lint/test triad cannot see; one focused `refactor:` commit cleared it.

#### What caused friction (agent side)

- `other` (weak red) — the Step 1 `tool.test.ts` changes passed against the *old* `describeToolGate`: an `AccessPath` passed where the old signature expected a `platform` string flowed through esbuild untypechecked and coincidentally behaved like posix (an object `!== "win32"`), so the unit test gave a hollow red.
  Impact: no rework — the genuine behavioral red lived in `tool-call-gate-pipeline.test.ts` (access-path emission + symlink-canonical block), which was noticed and relied on at the time.
  But the `tool.test.ts` red phase was not truly validating the change.
- `missing-context` (minor) — the plan's Module-Level Changes did not anticipate that adding the `bashProgram: BashProgram | null` annotation in `resolvePerToolCheck` would give fallow a resolvable receiver and retire the `program.ts` suppression.
  Impact: one extra unplanned `refactor:` commit; self-identified by the gate, no rework.

#### What caused friction (user side)

- None.
  The single decision point (mid-batch release deferral) was surfaced early from the plan's `**Release:**` marker via `ask_user` and answered cleanly — the intended handshake.

### Changes made

1. `.pi/skills/testing/SKILL.md` — added a rule under `### Interface and type changes`: a TDD step that changes a parameter's *type* can produce a hollow red (esbuild does not typecheck, so the new-typed argument may coincidentally satisfy the old runtime path); confirm the red exercises the new *behavior*, not just the new signature.
