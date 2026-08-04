---
issue: 356
issue_title: "Harden config pipeline against silently-dropped fields (follow-up to #332)"
---

# Retro: #356 — Harden config pipeline against silently-dropped fields

## Stage: Planning (2026-06-12)

### Session summary

Planned the two-part hardening from issue #356: retype `normalizePermissionSystemConfig`'s parameter from `unknown` to `UnifiedPermissionConfig` (so a future field declared on the runtime type but absent from the merge intermediate becomes a compile error), and add a full-pipeline seam test in a new `test/config-pipeline.test.ts`.
Investigation confirmed the issue author's flagged uncertainty was real: the retype only achieves its safety goal if `toRecord` and the `normalizeOptional*` coercion are also dropped (reading typed fields directly), which breaks ~6 test-only garbage-input cases and 2 `as unknown` call sites.
Operator chose the full retype and a new dedicated test file.

### Observations

- The defensive coercion in `normalizePermissionSystemConfig` is dead code for production — both call sites (`ConfigStore.refresh`, `ConfigStore.save`) already feed typed objects that passed through `normalizeUnifiedConfig` at the JSON boundary.
  The boundary's defensive parse is already fully tested in `test/config-loader.test.ts` (booleans lines 188–199; length fields 296–325), so the redundant `test/extension-config.test.ts` cases are pure deletions, not relocations.
- `config-store.ts` needs no edit — `PermissionSystemExtensionConfig` is structurally assignable to the all-optional `UnifiedPermissionConfig`, so `save(next)` compiles unchanged.
- Change is non-breaking: type-only + test changes; observable runtime behavior identical.
- Accepted minor ISP slack: the function reads 6/7 `UnifiedPermissionConfig` fields (never `permission`); narrowing to `Omit<..., "permission">` rejected as speculative since the issue prescribes the `UnifiedPermissionConfig` type and the compile-error property holds regardless.
- TDD ordering puts the seam regression test first (passes immediately, since #332 already fixed the loader) as a safety net before the refactor; the refactor is one atomic commit because the type change breaks tests and call sites at the type level.
- `config-modal.test.ts` call-site fix routes through `loadUnifiedConfig(configPath).config` instead of `JSON.parse(...) as unknown`, which mirrors the production load path more faithfully.

## Stage: Implementation — TDD (2026-06-12)

### Session summary

Completed both TDD steps cleanly: (1) added `test/config-pipeline.test.ts` with 4 full-pipeline seam tests, all green on first run (the #332 loader fix was already in place); (2) atomic refactor commit retypes `normalizePermissionSystemConfig` to `(raw: UnifiedPermissionConfig)`, drops the redundant `toRecord`/`normalizeOptional*` body, deletes 4 garbage-input tests from `test/extension-config.test.ts`, and fixes 2 `as unknown` call sites in `test/config-modal.test.ts`.
Final suite: 94 test files, 1951 tests — net count unchanged (4 deleted, 4 added).

### Observations

- Step 1 passed immediately as designed — the seam test is a regression guard, not a new-behavior test.
- The atomic Step 2 commit required 3 file edits (src + 2 test files) but `pnpm run check` passed cleanly — `PermissionSystemExtensionConfig` is structurally assignable to `UnifiedPermissionConfig` so both production call sites compiled unchanged.
- `readFileSync` import stayed in `test/config-modal.test.ts` — it has a third use at line 215 unrelated to the `normalizePermissionSystemConfig` call sites.
- The 4-test deletion in `test/extension-config.test.ts` was exactly offset by the 4-test addition in `test/config-pipeline.test.ts`, keeping the total at 1951.
- Post-implementation: fallow dead-code clean; lint/check/test all green.
- Pre-completion reviewer: WARN — one finding: package `SKILL.md` still said "silently dropped before runtime" after the change makes it a compile error.
  Addressed immediately with a `docs:` commit updating the skill to note the `tsc` enforcement.

## Stage: Final Retrospective (2026-06-12T13:38:07Z)

### Session summary

Shipped issue #356 cleanly across three stages (planning, TDD, ship) with zero rework: the two-part hardening retyped `normalizePermissionSystemConfig` to `UnifiedPermissionConfig` and added a full-pipeline seam test, landing as `test:` + `refactor:` commits plus one reviewer-prompted `docs:` fix.
CI passed first try; no release-please PR opened (neither `test:` nor `refactor:` triggers a version bump), so the issue closed without a release.
Net test delta was zero — 4 redundant garbage-input tests deleted, 4 seam tests added — confirming the deletions were genuinely covered at the boundary.

### Observations

#### What went well

- The planning-stage `ask_user` gate paid off: the operator had flagged uncertainty in the issue body about whether the `unknown`→typed retype was friction-free, and investigation confirmed it was real (the retype only works if `toRecord` and the coercion are also dropped).
  Surfacing the full-retype-vs-defer decision before planning meant the TDD stage had no surprises.
- The pre-completion reviewer earned its keep: it caught that the package `SKILL.md` prose ("silently dropped before runtime") went stale when the change upgraded that scenario to a compile error — a doc-accuracy gap no deterministic check would flag.
  Fixed in one `docs:` commit (`2ce733c9`) before shipping.
- Net-zero test count (1951 → 1951) across a delete-4 / add-4 swap validated the plan's Test Impact Analysis: the deleted `extension-config.test.ts` cases were truly redundant with `config-loader.test.ts` boundary coverage, not unique.
- Feedback-loop discipline was clean: `pnpm run check` ran immediately after the interface-shape change in TDD Step 2 (not deferred to end-of-session), exactly as the plan's TDD Order specified.

#### What caused friction (agent side)

- `premature-convergence` — the plan's Non-Goals asserted "no skill edit required," but the behavioral upgrade (silent runtime drop → `tsc` compile error) made the package skill's descriptive prose stale.
  Planning converged on "no skill edit" by reasoning only about symbol references, not about behavioral-claim staleness.
  Impact: one follow-up `docs:` commit (`2ce733c9`) caught by the pre-completion reviewer; no code rework, no shipping delay.

#### What caused friction (user side)

- None.
  The operator's planning `ask_user` answer (full retype + new test file) was decisive and drove the rest of the work without further intervention.

### Diagnostic details

- **Model-performance correlation** — Ship stage ran entirely on `claude-sonnet-4-6` (mechanical git/CI/issue-close work — appropriate); the `pre-completion-reviewer` subagent ran on `claude-sonnet-4-6` (judgment-heavy review — appropriate); retro ran on `claude-opus-4-8`.
  The `deepseek-v4-flash` entries in `model_change` had no assistant turn under them — transient selections that never executed.
  No quality mismatch.
- **Feedback-loop gap analysis** — No gap.
  Verification was incremental: per-file `vitest run` after each TDD step, `pnpm run check` right after the interface change, and the full suite + lint + fallow before pushing.
- Escalation-delay and unused-tool lenses found nothing notable (no rabbit holes, no missing-context friction).

### Changes made

1. Appended this Final Retrospective stage entry to `packages/pi-permission-system/docs/retro/0356-harden-config-pipeline-dropped-fields.md`.

No `AGENTS.md` or `.pi/prompts/` changes: the one WARN (stale skill prose) was caught by the existing pre-completion reviewer, so a new planning rule would over-fit a one-off the safety net already handles.
