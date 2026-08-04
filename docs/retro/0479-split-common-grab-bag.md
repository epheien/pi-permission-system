---
issue: 479
issue_title: "pi-permission-system: split the common.ts grab-bag (Phase 6 Step 7)"
---

# Retro: #479 — pi-permission-system: split the `common.ts` grab-bag (Phase 6 Step 7)

## Stage: Planning (2026-06-26T23:45:17Z)

### Session summary

Planned Phase 6 Step 7: split the `common.ts` grab-bag (fallow's only refactoring target, 22 dependents) into `src/value-guards.ts` (six runtime type guards) and `src/yaml-frontmatter.ts` (two YAML/frontmatter parsers).
The plan is a single atomic `refactor:` commit — pure lift-and-shift, no behavior change — landed in `packages/pi-permission-system/docs/plans/0479-split-common-grab-bag.md`.

### Observations

- Non-breaking: `common.ts` is internal-only (not re-exported from `index.ts` or `package.json` `exports`), so the split has no external surface.
- The two concerns are fully independent (no cross-calls, no shared internal helper), so the partition is clean; only `policy-loader.ts` imports from both new modules.
- Verified dependent counts by grep: 17 value-guards-only `src/` importers, 1 dual importer (`policy-loader.ts`), 1 more (`config-loader.ts`) that looked dual but is value-guards-only; 3 test files.
- Chose a single atomic commit (no transitional re-export shim) per the AGENTS.md export-removal rule and to avoid the barrel-sprawl smell the architecture doc flags — `tsc` keeps the repoint honest.
- `Release: independent` per the architecture roadmap's "Release batches" subsection (Steps 6, 7, 8 are independently releasable); confirmed `refactor:` commits trigger a patch release in this repo's release-please config (e.g. #477 released on a refactor-only commit).
- Deferred to ship time (per package SKILL convention): the Step 7 `✅` completion marker, the `S7` Mermaid node marker, and the `common.ts` health-metric row; the module-tree listing update rides with the refactor commit since it is a layout fact, not a completion marker.
- Skipped the `ask-user` gate (issue authored by the operator, proposed change unambiguous) and the `design-review` checklist (no shared-interface or layer-wiring change — only free-function relocation and import repoints).

## Stage: Implementation — TDD (2026-06-27T00:00:00Z)

### Session summary

Executed the single atomic TDD step: created `src/value-guards.ts` and `src/yaml-frontmatter.ts` (verbatim moves from `common.ts`), split `test/common.test.ts` into `test/value-guards.test.ts` and `test/yaml-frontmatter.test.ts`, repointed all 22 dependents (19 `src/`, 3 `test/` including 1 dual-importer), deleted `src/common.ts` and `test/common.test.ts`, and updated the architecture module-tree listing.
Test count held at 2124 (104 files, +1 net from deleting 1 file and adding 2).
Pre-completion reviewer returned PASS.

### Observations

- Deviation from plan's stated outcome: `value-guards.ts` now appears as fallow's top refactoring target (pri 29.0, 22 dependents) rather than zero targets.
  The grab-bag smell is dissolved but the fan-in is preserved — almost all 22 importers needed the type guards, so `value-guards.ts` inherits their dependency edge.
  The plan's verify criterion (`pnpm fallow` no longer lists `common.ts`) IS met; the architecture roadmap's optimistic "drops to zero" metric was not.
  This should update the health-metric row at ship time to reflect reality.
- Import style was preserved per-file: `src/` siblings kept relative `./value-guards` / `./yaml-frontmatter`; `src/handlers/`, `src/forwarded-permissions/`, and `test/` used the `#src/` alias — consistent with the existing mixed style that passes lint (the ESLint rule only flags `../` parent imports, not same-directory `./` ones).
- The `afterEach(vi.restoreAllMocks)` block from `test/common.test.ts` was dropped in both new test files as intended — neither test file uses mocks or spies.
- Pre-completion reviewer: PASS (all deterministic checks green, architecture.md updated, Mermaid diagrams valid, no dead code).

## Stage: Final Retrospective (2026-06-27T00:10:01Z)

### Session summary

Shipped #479 across three clean stages (Planning, TDD, Ship): the `common.ts` grab-bag was split into `value-guards.ts` and `yaml-frontmatter.ts`, all 22 dependents repointed, tests split, and the change landed on `main` with green CI.
The issue is closed; the work auto-batches into the next `pi-permission-system` release because the sole source-touching commit is a `refactor:` (a `hidden: true` changelog type).

### Observations

#### What went well

- The plan's single-atomic-step framing matched reality exactly: the `refactor:` commit touched 26 files and `tsc` caught every repoint, so there was no mid-step breakage and no follow-up fixup commits.
- The TDD stage front-loaded verification correctly for an atomic refactor — `pnpm run check` immediately after the edit batch, then a `grep -rn "common" src test` to confirm zero stray import references, then the full suite, lint, and `fallow dead-code`.
  No feedback-loop gap.
- The Ship stage diagnosed the missing release-please PR correctly and without rework: after the `release_pr_find` timeout it inspected `release-please-config.json` `changelog-sections`, found `refactor:` is `hidden: true`, and concluded the work auto-batches — matching the ship prompt's step 4b.

#### What caused friction (agent side)

- `missing-context` — the Planning stage asserted, as rationale for the `**Release:** ship independently` marker, that "`refactor:` commits trigger a patch release in this repo's release-please config (e.g. #477 released on a refactor-only commit)."
  This is false: `refactor:` is a `hidden: true` changelog section and does not cut a release on its own.
  The cited evidence was misread — v16.1.0 was triggered by #476's `feat: introduce AccessPath value object` (`c00d5c58`), and #477's refactor merely rode along in the same uncut batch.
  Impact: no rework — the `ship independently` decision was correct regardless (the marker governs batching policy, not commit-type release mechanics), and the Ship stage handled the no-PR case gracefully via step 4b.
  The only cost was a wrong sentence in the plan's rationale and a brief ship-time expectation mismatch (one `release_pr_find` 125s timeout that was expected behavior, not a failure).
  Self-identified (caught at ship time by the same operator-agent).

#### What caused friction (user side)

- None — the issue was operator-authored, unambiguous, and required no mid-session redirection.

### Diagnostic details

- **Model-performance correlation** — the only subagent dispatch was the `pre-completion-reviewer` (TDD stage), which runs on its frontmatter model (`anthropic/claude-sonnet-4-6`), appropriate for judgment-heavy review.
  No mismatch.
  Session-level `model_change` entries were mostly transient selections with no attributable assistant turn, so they were not over-counted.
- **Escalation-delay tracking** — no `rabbit-hole` friction; the longest single wait was the deterministic `release_pr_find` backoff (7 retries / 125s), which is expected polling, not a stuck loop.
- **Feedback-loop gap analysis** — verification ran incrementally and appropriately for a single atomic step; no end-only verification gap.

### Changes made

1. `AGENTS.md` — appended a sentence to the line-61 release-batching paragraph: hidden changelog-type commits (`refactor:`/`style:`/`test:`/`build:`/`ci:`) do not cut a release on their own and auto-batch into the next `feat:`/`fix:`/unhidden-`docs:` release, so a refactor-only plan's `Release Recommendation` rationale must not claim it will cut a release (Refs #479).
2. `packages/pi-permission-system/docs/retro/0479-split-common-grab-bag.md` — added this Final Retrospective stage entry.
