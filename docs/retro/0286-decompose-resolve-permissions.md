---
issue: 286
issue_title: "Decompose resolvePermissions in permission-manager.ts"
---

# Retro: #286 — Decompose `resolvePermissions` in `permission-manager.ts`

## Stage: Planning (2026-05-31T04:36:52Z)

### Session summary

Planned the Phase 2 step 2 decomposition of `PermissionManager.resolvePermissions`.
The plan extracts `mergeScopesWithOrigins(scopes)` (returning `{ mergedPermission, origins }`) into a new `src/scope-merge.ts` module with a sibling `test/scope-merge.test.ts`, leaving the remaining method as a linear pipeline.
Behavior-preserving: `permission-manager-unified.test.ts` stays green unmodified.

### Observations

- One genuine design decision surfaced via `ask_user`: where the extracted function lives.
  Options were a new module, folding into `permission-merge.ts`, or an exported in-file helper (the [#285] precedent).
  User chose the new `scope-merge.ts` module — matches the package's dominant one-concern-per-file convention and keeps `permission-merge.ts` purely about config-shape merge.
- Caught a non-obvious cleanup: after extraction, `permission-manager.ts` no longer calls `mergeFlatPermissions` directly (it was the sole call site there), so its import must be removed in the same step — `pnpm check` will catch a stray reference.
- The `OriginMap` type alias moves into `scope-merge.ts` and stays unexported (the consumer reads `origins` via the inferred `MergedScopes` return type); `MergedScopes` is exported and the new test imports it so fallow does not flag a dead export.
- TDD order follows the accepted [#285] pattern: step 1 commits a red test (module not yet created), step 2 creates the module + rewires the sole call site in one commit, step 3 updates `architecture.md` after re-running `fallow health --targets` to record new numbers.
- The attribution branch (shallow-merge vs. full-replacement, including the `eslint-disable @typescript-eslint/no-unnecessary-condition` comments) moves verbatim — the densest, highest-risk part — so behavior is preserved by construction.

## Stage: Implementation — TDD (2026-05-31T04:52:42Z)

### Session summary

Completed all three TDD cycles: wrote `test/scope-merge.test.ts` (9 tests, red), created `src/scope-merge.ts` and rewired `resolvePermissions` (green, +1553 total passing vs. 1544 baseline), then updated `docs/architecture/architecture.md` (module-tree entry, health metrics, step 2 marked ✅).
All deterministic checks pass (check, lint, test, fallow dead-code).
Pre-completion reviewer returned PASS.

### Observations

- The first `Edit` on `permission-manager.ts` accidentally prepended duplicate import blocks (the `oldText` matched only the first line of the original import section rather than the whole block).
  Recovered by reading the corrupted file and rewriting the entire import section with a second `Edit` covering the full duplicated range.
  Lesson: when replacing a multi-line import block, use the entire block (including closing `} from "..."`) as `oldText`, not just the opening line.
- The `fallow health --targets` output confirms `resolvePermissions` is no longer in the refactoring-targets list; `permission-manager.ts` is gone from the CRAP-risk note; the four remaining targets are `tool-input-preview.ts`, `config-loader.ts` (stripJsonComments / Phase 2 step 5), `runner.ts` (runGateCheck / step 3), and `bash-path-extractor.ts` (step 4).
- `MergedScopes` is imported by the test file (typed as the result of `mergeScopesWithOrigins([])` in the first test case), satisfying fallow's dead-export check.
- Pre-completion reviewer: PASS — no warnings.

## Stage: Final Retrospective (2026-05-31T05:02:52Z)

### Session summary

Shipped the behavior-preserving decomposition of `PermissionManager.resolvePermissions` across three stages (plan → TDD → ship): the scope-merge + origin-tracking loop now lives in a pure `mergeScopesWithOrigins` in the new `src/scope-merge.ts`, with 9 new unit tests and `permission-manager-unified.test.ts` unchanged.
CI passed on `47e0bf43`, the issue was closed, and no release-please PR was produced (no `feat:`/`fix:` commits).
The session was unusually clean — one minor mechanical edit slip, caught instantly by the autoformat hook, with no rework to committed code.

### Observations

#### What went well

- The deterministic feedback loop was exemplary: the green baseline (`check`, `lint`, `test`) was verified before any code change, per-step test runs followed each cycle, and the full suite plus `fallow dead-code` ran after the last step.
  Verification never bunched at the end.
- The `pi-autoformat` save hook surfaced the corrupted import block (duplicate `import` declarations → biome parse error) within a single tool call, before any manual `lint`/`check` run — the hook functioned as an instant guardrail against a mechanical slip.
- The planning-stage `ask_user` handshake (module placement) paid off downstream: the chosen `src/scope-merge.ts` location drove a frictionless TDD stage because the file/test layout was already settled.
- The cross-session retro bridge worked as intended: the TDD stage read the Planning observations (the `mergeFlatPermissions` import-removal warning, the `MergedScopes` dead-export note) and acted on them without rediscovery.

#### What caused friction (agent side)

- `other` (edit-tool misuse) — the first `Edit` on `src/permission-manager.ts` used an `oldText` that matched only the opening lines of the import section while its `newText` carried the full restructured import blocks, prepending duplicates of imports that still existed below.
  Impact: ~2 extra tool calls (read the corrupted file, one corrective `Edit` spanning the full duplicated range); no rework to committed code because the autoformat hook caught it immediately.
  Self-identified via the hook's biome output.

#### What caused friction (user side)

- None.
  User involvement was limited to the one planning-stage decision (`ask_user`) and stage advancement — strategic, not mechanical oversight.

### Diagnostic details

- **Model-performance correlation** — the only subagent dispatch was the `pre-completion-reviewer` (judgment-heavy: deterministic checks, design review, Mermaid validation via `mmdc`).
  It produced a thorough, well-structured PASS report — no reasoning-weak-model mismatch evident.
- **Escalation-delay tracking** — no `rabbit-hole` points; the import-block corruption resolved in one corrective tool call, far below the 5-call escalation threshold.
- **Unused-tool detection** — no `missing-context` gaps; planning exploration and grep coverage were sufficient, and no situation called for an unused Explore/`colgrep`/`web_search`.
- **Feedback-loop gap analysis** — no gap; verification ran incrementally (baseline-first, per-step, full-suite-last) and the save hook added continuous coverage.

### Changes made

1. Appended this Final Retrospective stage entry to `packages/pi-permission-system/docs/retro/0286-decompose-resolve-permissions.md`.
   No `AGENTS.md` or prompt changes — the single friction point was a one-off mechanical edit slip, self-caught instantly by the autoformat hook, which does not justify a standing rule.
