---
issue: 477
issue_title: "pi-permission-system: collapse the two external-directory gates onto one AccessPath policy check (Phase 6 Step 5)"
---

# Retro: #477 — Collapse the two external-directory gates onto one AccessPath policy check

## Stage: Planning (2026-06-26T00:00:00Z)

### Session summary

Planned Phase 6 Step 5: collapse the duplicated `external_directory` policy logic in `describeExternalDirectoryGate` and `describeBashExternalDirectoryGate` into a shared helper, now that `AccessPath` ([#476], Step 4) exists.
Produced a two-step TDD plan (one atomic refactor commit + one docs commit) at `packages/pi-permission-system/docs/plans/0477-collapse-external-directory-gates.md`.
Confirmed the issue is the release-batch tail — it ships now alongside Step 4's held-open release PR.

### Observations

- **Design fork surfaced via `ask_user`** — the two gates have genuinely different control flow (single-tool: one path, always emits a descriptor, infra-bypass + boundary check; bash: N paths, filters uncovered, early-bypasses, picks worst).
  Asked the operator whether the helper should be one combined function over `AccessPath[]` (literal issue wording) or two focused functions sharing a private per-path core.
  Operator chose **two focused functions** — `resolveExternalDirectoryPolicy` (the single [#418]-prone line, used by the single gate) and `selectUncoveredExternalPaths` (bash gate; delegates to the per-path core and owns `pickMostRestrictive`).
  Rationale: worst-selection is inherently bash-only, and a combined result object would be read only in part by each consumer (dependency-width smell).
- **Not breaking** — pure behavior-preserving internal refactor; no config, output, or default change.
- **`fallow dead-code` forces atomicity** — the helper exports must land with both gate consumers in one commit, mirroring the same coupling [#476] hit; a pure-addition helper commit would fail the CI dead-code gate.
- **Orphaned-import trap flagged** — removing the bash gate's inline loop orphans three imports (`AccessPath`, `PermissionCheckResult`, `pickMostRestrictive`); `tsc` does not error on unused type imports, so the plan calls them out explicitly for the implementer and pre-completion reviewer.
- **Behavior-preserving, so no gate-test rewrites** — existing gate and integration tests stay green unchanged; only a new `external-directory-policy.test.ts` is added.
  Verified no README or package-SKILL symbol references break (both reference user-facing behavior, not the gate internals).

## Stage: Implementation — TDD (2026-06-26T15:25:00Z)

### Session summary

Executed the two-step plan: collapsed the duplicated `external_directory` policy logic into a new `external-directory-policy.ts` (`resolveExternalDirectoryPolicy` + `selectUncoveredExternalPaths`), rewired both gates to delegate, and removed the bash gate's three orphaned imports (step 1, atomic `refactor` commit); then updated `architecture.md` tree entries and applied the Step 5 ✅ markers (step 2, `docs` commit).
Behavior-preserving — test count rose 2111 → 2116 (the 5 new helper unit tests); all existing gate and integration tests stayed green unchanged.

### Observations

- **No deviations from the plan** — the design, the two-step TDD order, and the atomic-commit prediction (`fallow dead-code` forces the helper to land with both consumers) all held exactly.
- **Orphaned-import removal landed cleanly** — the plan's explicit enumeration of `AccessPath`, `PermissionCheckResult`, and `pickMostRestrictive` meant the multi-edit removed all three in the same commit; `grep` confirmed none survived.
- **Architecture narrative left intentionally** — updated the concrete module tree entries (the state-claim risk that caused a #476 WARN) plus the `candidate-check.ts` caller note; left the phase-intent/design-rationale prose (lines 625, 756, 799) untouched since they describe phase scope and the AccessPath design insight, not current code state.
- **Pre-completion reviewer: PASS** — all deterministic checks green (`check`, `lint` exit 0, 2116 tests, `fallow dead-code` clean); all four cross-step invariants (#418 alias matching, #393 worst-uncovered, #476 accessor split, #382 win32 boundary) confirmed preserved and additionally lower-sourced by the new helper tests.
  No WARN findings.

## Stage: Final Retrospective (2026-06-26T17:00:00Z)

### Session summary

Shipped Phase 6 Step 5 across one continuous session spanning plan → TDD → ship → retro: collapsed the duplicated `external_directory` policy logic into a new `external-directory-policy.ts` (two focused functions), rewired both gates, pushed two implementation commits, CI green, and closed both #477 and the stacked #476.
The batched release-please PR #485 (held open from #476's `mid-batch — defer` marker) merged by rebase at the batch tail, cutting `pi-permission-system-v16.1.0`.
The implementation was clean and behavior-preserving (2111 → 2116 tests) with zero deviations from the plan and a PASS pre-completion review.

### Observations

#### What went well

- **The plan's coupling and invariant predictions held exactly** — the atomic-commit prediction (`fallow dead-code` forces the helper to land with both consumers), the explicit three-import orphan enumeration (`AccessPath`, `PermissionCheckResult`, `pickMostRestrictive`), the no-gate-test-rewrite claim, and all four cross-step invariants (#418, #393, #476, #382) landed precisely as written.
  No mid-step surprises, no rework.
- **Batched release coordination worked end-to-end across sessions** — #477 (`refactor`, changelog-hidden) plus #476 (`feat`, visible) shipped together; the release decision was read deterministically from the plan's `**Release:**` marker before any irreversible work, the held-open PR #485 merged cleanly by rebase, and both issues were closed with curated implemented-in comments.
  The cross-session batch discipline (defer at Step 4, ship at the Step 5 tail) required no operator intervention.
- **Incremental verification throughout** — green baseline before TDD, per-file `vitest` after red and after green, `pnpm run check` after the interface-adjacent edit, then full suite + `check` + root `lint` + `fallow dead-code` after the last step.
  No end-of-session verification pile-up.

#### What caused friction (agent side)

- `instruction-violation` (self-identified) — issued `cd ../..` in a TDD-stage bash call, assuming cwd carried over from a prior `cd packages/pi-permission-system && …` call; each bash call actually starts at the repo root, so `cd ../..` left the project tree and tripped the `external_directory` gate (ironically, the very gate being refactored).
  Impact: one denied command, re-run without the `cd` (via `pnpm --filter`); no rework.
  The rule already exists — `AGENTS.md` prescribes `pnpm --filter` / `pnpm -C packages/<pkg>` over `cd`, and the system prompt forbids `cd` into cwd — so this is a salience slip, not a missing rule.
- `missing-context` (self-identified) — one planning-stage `Read` used a malformed absolute path that duplicated the repo segment (`…/pi/pi-permission-system/packages/pi-permission-system/…` instead of `…/pi/pi-packages/…`), confusing the repo name (`pi-packages`) with the package name (`pi-permission-system`).
  Impact: one denied read, immediate re-read with the correct path; no rework.

#### What caused friction (user side)

- None.
  The single `ask_user` design-fork gate in planning was the right and only intervention point; no earlier context would have changed the outcome.

### Diagnostic details

- **Model-performance correlation** — the session ran primarily on `claude-opus-4-8`; the transient `deepseek-v4-flash` / `glm-5.2` / `kimi-k2.6` `model_change` entries carried no attributed assistant turns (the same noise pattern #476's retro flagged).
  The one subagent dispatch (`pre-completion-reviewer`) ran on its frontmatter model and produced a correctly-scoped, judgment-heavy review — appropriate, no mismatch.
- **Escalation-delay / unused-tool lenses** — nothing notable: no `rabbit-hole`, both self-corrected slips resolved in exactly one retry, and no point where an un-dispatched subagent or `colgrep` would have helped (the exact target files were known from the issue body and the architecture roadmap).

### Changes made

1. `packages/pi-permission-system/docs/retro/0477-collapse-external-directory-gates.md` — added this Final Retrospective stage entry.
   No `AGENTS.md` or prompt changes: both friction points were self-identified, single-retry path/cwd slips with no rework, and are already governed by existing rules (the system prompt's shell-command section and `AGENTS.md`'s `pnpm --filter` / `pnpm -C` guidance), so an additional rule would duplicate rather than sharpen.

[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#476]: https://github.com/gotgenes/pi-packages/issues/476
