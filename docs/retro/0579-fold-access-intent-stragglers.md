---
issue: 579
issue_title: "pi-permission-system: fold access-intent stragglers into src/access-intent/"
---

# Retro: #579 — Fold the access-intent stragglers into `src/access-intent/`

## Stage: Planning (2026-07-13T00:00:00Z)

### Session summary

Planned Phase 11 Step 1: relocating the four flat-root access-intent modules (`input-normalizer.ts`, `mcp-targets.ts`, `tool-input-path.ts`, `path-surfaces.ts`) into `src/access-intent/`, a green-preserving `refactor:` move with no behavior change.
Produced a two-step plan at `docs/plans/0579-fold-access-intent-stragglers.md` — one atomic `refactor:` commit for the module + test moves and all import rewrites, then a `docs:` commit for the architecture doc, package skill, and Phase 11 Step 1 completion marker.

### Observations

- Operator confirmed (via `ask_user`) that the four **test** files should move into `test/access-intent/` too, to preserve the test-tree mirror — the issue itself scoped only `src/`, but `test/access-intent/` already exists (`access-path.test.ts`, `tool-kind.test.ts`).
- Enumerated the full import inventory with a bare-name grep across `src/` and `test/` (not `#src/`-only), catching both `#src/` alias importers and `./`-relative flat-root importers per the [#559] lesson — eleven source importers plus five test files.
- Intra-`access-intent/` convention verified against existing modules: same-directory siblings use `./<sibling>`, cross-directory imports use the `#src/` alias.
  The plan follows that for the moved files and keeps each non-moving importer's existing style.
- Both pi-permission-system ESLint guards are unaffected: the `process.platform` `no-restricted-syntax` rule is a `src/**` glob (modules stay under it), and the `no-restricted-imports` ADR-0002 guard is file-scoped to `permission-manager.ts` (the move adds no `access-path` import).
  No `eslint.config.js` / `tsconfig` / `package.json` edit needed — the `#src/*` alias resolves subdirectories.
- Release is `independent` (not in the `shell-tool-aliases` batch); as a `refactor:` it auto-batches into the next release rather than cutting one.
- Next stage is `/build-plan` (code-touching but test-cycle-free — no red cycle, the relocated suites are the regression guard), which brackets with the `tidy-first-assessor` and `pre-completion-reviewer` subagents.

## Stage: Implementation — Build (2026-07-13T12:10:00Z)

### Session summary

Executed both plan steps: Step 1 `git mv`'d the four modules into `src/access-intent/` and their four test files into `test/access-intent/`, rewriting the moved modules' imports, all eleven source importers, and all five test imports in one atomic `refactor:` commit; Step 2 relocated the four entries in the `architecture.md` module-layout tree, updated the two prose lines and the `SKILL.md` path, and marked Phase 11 Step 1 complete (`✅` on the step heading and Mermaid `S1` node) in a `docs:` commit.
All deterministic checks passed: `tsc` clean, `pnpm run lint` clean, full suite green (120 files / 2374 tests), `fallow dead-code` clean, and the flat `src/` root module count dropped 60 → 56 as planned.

### Observations

- The `tidy-first-assessor` returned "no preparatory tidying warranted" — a pure `git mv` + import-specifier rewrite over a fully enumerated, non-cyclic, barrel-free import graph has no structural friction to prepare for; it explicitly rejected internal-cleanup candidates (stepdown reordering, test splitting, shared-helper extraction) as scope creep.
- `git` tracked all eight moves as renames (`R`), preserving history/blame; the plan's exhaustive importer enumeration matched reality exactly — no missed importer, no dynamic/string reference.
- One intentional deviation from the plan (disclosed in the Step 2 commit body): the `access-intent/` directory-header line was also extended to record the four-module relocation for provenance, beyond the plan's literal "descriptions unchanged" tree-relocation scope.
- All three at-risk invariants held: ADR-0002 string boundary (`permission-manager.ts` `AccessPath`-free), `tool-kind.ts` `AccessPath`-free (sole import `PATH_BEARING_TOOLS` now a `./path-surfaces` sibling), and the interior `process.platform` ban — each still lint- and test-pinned.
- Pre-completion reviewer: PASS (ready for `/ship-issue`); no WARN findings.

## Stage: Final Retrospective (2026-07-13T16:17:19Z)

### Session summary

Shipped Phase 11 Step 1 across three clean stages (plan → build → ship) with zero rework: the plan's exhaustive importer enumeration matched reality exactly, both implementation commits landed as specified, CI passed first try, and issue #579 closed.
No release cut — every commit touching the package is a `refactor:`/`docs:` hidden type, so the work auto-batches into the next release.

### Observations

#### What went well

- **First live use of the `tidy-first-assessor` held its scope boundary cleanly.**
  On a pure `git mv` + import-rewrite change it recommended nothing and explicitly rejected four internal-cleanup candidates (stepdown reordering, `input-normalizer.test.ts` splitting, shared-helper extraction, a barrel) as scope creep — exactly the discipline the `tidy-first` skill's first-live-use checkpoint watches for.
  One clean data point toward retiring that checkpoint (not yet "a handful").
- **Plan-time enumeration eliminated build-time discovery.**
  The planning stage's bare-name grep across `src/` and `test/` (catching both `#src/` alias and `./`-relative importers, per the [#559] lesson) produced an importer list that matched the implementation exactly — eleven source importers, five test files, zero missed sites, no `tsc` surprise.
- **`git mv` preserved history on all eight file moves** (tracked as renames), and the atomic single-commit move (plan Edge Cases) avoided any broken intermediate `tsc` state.

#### What caused friction (agent side)

- None warranting a rule change.
  The session was a textbook mechanical relocation: verification ran incrementally (green baseline → full suite after Step 1 → lint after Step 2), no error retries, no rabbit holes, no scope drift.
  The one plan deviation (extending the `access-intent/` directory-header line for move provenance) was intentional and disclosed in the commit body.

#### What caused friction (user side)

- None.
  The single planning `ask_user` (move the test files too?) was the only decision point, and it resolved the one genuine organizational ambiguity up front — mechanical oversight, not strategic intervention.

### Changes made

1. `packages/pi-permission-system/docs/retro/0579-fold-access-intent-stragglers.md` — appended this Final Retrospective stage entry.
   No `AGENTS.md` or prompt changes: the session was frictionless and the operator confirmed landing the retro only.

### Considered but not made

1. Tightening the `tidy-first` skill's applicability gate to skip pure relocations/renames (nothing to prepare) — rejected as premature while the `tidy-first-assessor` is inside its first-live-use validation window, where even a trivial run adds a boundary-held data point.
2. Removing the `tidy-first` first-live-use checkpoint callout — its own text requires the boundary to hold "across a handful of issues"; this is one clean run, not yet a handful.

[#559]: https://github.com/gotgenes/pi-packages/issues/559
