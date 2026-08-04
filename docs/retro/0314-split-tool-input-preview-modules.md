---
issue: 314
issue_title: "Split tool-input-preview.ts into cohesive modules"
---

# Retro: #314 — Split `tool-input-preview.ts` into cohesive modules

## Stage: Planning (2026-06-02T00:00:00Z)

### Session summary

Produced a numbered plan to extract the three prompt formatters (`formatEditInputForPrompt`, `formatWriteInputForPrompt`, `formatReadInputForPrompt`) plus `getPromptPath` into a new `src/tool-input-prompt-formatters.ts`, leaving text utilities, `serializeToolInputPreview`, and the three limit constants in `tool-input-preview.ts`.
Audited every importer of the four moved symbols and confirmed the only production consumer is `tool-preview-formatter.ts`; the remaining importers (`builtin-tool-input-formatters.ts`, three test files) touch only retained symbols.
Confirmed via `fallow health --targets` that `tool-input-preview.ts` is the sole refactoring target (medium, 6 dependents).

### Observations

- The plan folds the extraction, the `tool-preview-formatter.ts` import repoint, and both test-file edits into a single `refactor:` commit, following the [#282] retro lesson: removing exports breaks every importer at the type level in the same commit, so the split is not buildable if staged separately.
- This is a cohesion split by concern, not statement-level procedure-splitting — each moved function is already a complete, independently-tested pure function returning a value, and the four form one cohesive concern (rendering tool input for a permission prompt).
- Dependency direction is strictly one-way: `tool-input-prompt-formatters.ts` imports `countTextLines`/`formatCount` from `tool-input-preview.ts`; no cycle, since the utilities never reference a formatter after the move.
- After the move, `tool-input-preview.ts` loses its `./common` import entirely (`getNonEmptyString`/`toRecord` were used only by the moved functions) — flagged in the plan to avoid an unused-import lint failure.
- No barrel (`src/index.ts`) re-exports these symbols, so no barrel update and no speculative-re-export dead-code risk; all four new exports are consumed by `tool-preview-formatter.ts`.
- Behavior-preserving, so no new red test is planned — the relocated describe blocks plus the existing suite are the regression net.
  Test Impact Analysis records that the extraction unlocks no new unit tests and makes none redundant.
- Skipped `ask_user`: the issue's proposed change is unambiguous.
  Design-review checklist found no introduced smells (no new collaborator threading, no output arguments, no LoD reach-through).
- Docs updates target `architecture.md` (module listing, `Refactoring targets` 1 → 0, finding #2 resolved, roadmap step 1 ✅) and `v3-architecture.md` module listing, as a separate `docs:` commit.

## Stage: Implementation — Build (2026-06-02T11:00:00Z)

### Session summary

Executed both plan steps in two commits.
Step 1 (`refactor:`) created `src/tool-input-prompt-formatters.ts` with the three prompt formatters plus `getPromptPath`, removed them from `tool-input-preview.ts` (dropping its now-unused `./common` import), repointed `tool-preview-formatter.ts`, and relocated the four describe blocks into `test/tool-input-prompt-formatters.test.ts`.
Step 2 (`docs:`) recorded the split in `architecture.md` (module listing, `Refactoring targets` 1 → 0, finding #2 resolved, roadmap step 1 ✅) and `v3-architecture.md`.

### Observations

- No deviations from the plan.
  The consumer audit was exact: `tool-preview-formatter.ts` was the only production importer of the moved symbols, and the three other test files imported only retained constants.
- `fallow health --targets` confirmed the outcome — the "Refactoring targets" section no longer appears (0 targets, down from 1); `tool-input-prompt-formatters.ts` reports maintainability 85.4 and `tool-input-preview.ts` is now a low cooling hotspot (2.6).
- Full suite stayed green throughout: 79 files / 1753 tests pass; `tsc --noEmit` and `pnpm run lint` clean.
- Pre-completion reviewer: PASS — all deterministic checks (`check`, `lint`, `test`, `fallow dead-code`) green; conventional commits valid; docs forward/reverse clean; all four new exports consumed (no dead re-export); 8 Mermaid diagrams parsed clean.

## Stage: Final Retrospective (2026-06-02T15:28:20Z)

### Session summary

The planning and build stages executed cleanly: an exact consumer audit, a behavior-preserving cohesion split landed in two commits (`refactor:` then `docs:`), full suite green throughout, and a pre-completion `PASS`.
The one notable friction was confirming the `fallow` outcome (refactoring targets 1 → 0), which took ~10 tool calls fighting human-readable `fallow health` output.
The user then chose to defer shipping: #314 is built but unpushed, to roll into a per-track batch ship later.

### Observations

#### What went well

- The plan-stage consumer audit was exact and paid off at build time — `tool-preview-formatter.ts` was the only production importer of the moved symbols, the three other test files imported only retained constants, and the build hit zero surprises and zero deviations.
- Folding the extraction, the consumer repoint, and both test-file edits into one `refactor:` commit (the [#282] lesson, carried forward in the plan) meant the type checker never saw a broken intermediate state.
- Correctly surfaced the release-please batching reality during the shipping discussion — every push to `main` feeds the same open release-please PR, so deferring the ship is a no-op until push and per-track batching loses no releases.

#### What caused friction (agent side)

- `missing-context` — did not load the `fallow` skill before interpreting `fallow health` output.
  The skill steers toward `--format json --quiet 2>/dev/null || true`, which sidesteps the human-output quirks entirely.
  Impact: ~10 tool calls to confirm a single metric (targets = 0), instead of one JSON read.
- `rabbit-hole` — the human-readable `fallow health --targets` output omits the "Refactoring targets" section entirely when there are zero targets, and terse `--targets` differs from full `--score --hotspots --targets`.
  Grepping the text output returned nothing, which read as "command broke" rather than "zero targets."
  Impact: chained ~10 calls (sed, tail, grep, bare `fallow` → command-not-found, wrong `pnpm --filter` script path) before asserting the section's absence with `grep -c`.

#### What caused friction (user side)

- The shipping cadence (per-issue vs. batch) is a cross-session decision for the whole #314–#321 roadmap, surfaced only after the build was fully done and reviewed.
  Opportunity, not criticism: noting a shipping-cadence intent when the roadmap was authored in `architecture.md` would let each build session know up front whether to ship or stage.

### Diagnostic details

- **Model-performance correlation** — the only subagent dispatch was the `pre-completion-reviewer` on `anthropic/claude-sonnet-4-6` (29 tool uses); appropriate for judgment-heavy review (code design, docs staleness, Mermaid parsing).
  No mismatch.
- **Escalation-delay tracking** — the `fallow` rabbit hole ran ~10 consecutive tool calls on the same goal (confirm targets = 0), well past the 5-call threshold.
  The trigger to change strategy (load the `fallow` skill / switch to JSON) was available from the first failed grep.
- **Unused-tool detection** — the `fallow` skill was available and never loaded; its `--format json` guidance directly resolves the friction.
- **Feedback-loop gap analysis** — no gap.
  Verification ran incrementally: `check`+`lint` baseline before edits, `check`+`lint`+`test` after step 1 before committing, `lint` after step 2, then full `check`+`test`+`lint` at the end.

### Changes made

1. `.pi/skills/fallow/SKILL.md` — added Key gotcha #5: `health --targets` omits the "Refactoring targets" section when there are zero targets; use `--format json` to confirm a file dropped off the list.

### Deferred-ship state (cross-session bridge)

- #314 is **built and reviewed (`PASS`) but not shipped**: 5 commits sit on local `main`, unpushed (ahead of `origin/main` by 5).
  No release-please PR is triggered until push.
- Shipping decision: **batch per dependency track** — Track B (#315→#316→#317), Track C (#318, #319), Track D (#320), Track E (#321); #314 rolls into the first batch ship.
- Build depth for the behavioral refactors (#315–#317 forwarding, #320 composition root): decide TDD vs. build per issue when each session starts.

[#282]: https://github.com/gotgenes/pi-packages/issues/282
