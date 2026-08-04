---
issue: 347
issue_title: "piInfrastructureReadPaths in config.json is silently ignored by config-loader merge pipeline"
---

# Retro: #347 — piInfrastructureReadPaths config-loader gap

## Stage: Planning (2026-06-08T21:30:00Z)

### Session summary

Diagnosed `piInfrastructureReadPaths` being silently dropped: it is parsed by `normalizePermissionSystemConfig()` but that runs on the output of `loadAndMergeConfigs()`, whose intermediate `UnifiedPermissionConfig` never declares, parses, or merges the field — structurally identical to the [#332] loader gap.
Produced `docs/plans/0347-infra-read-paths-config-loader-gap.md` with five red→green TDD cycles that add a shared `normalizeOptionalStringArray` helper, carry the field through the unified loader with override-wins merge, and add `refresh`/`save` preservation tests.

### Observations

- Root cause is a missing field in `UnifiedPermissionConfig`, not a matching bug — confirmed `isPiInfrastructureRead()` / `path-utils.ts` matching is correct and out of scope ([#122], [#350] already cover it).
- Verified against the [#332] fix shape: `ConfigStore.save()` spreads `...existing.config`, so once the loader carries the field the save path preserves it automatically — no explicit save-side copy expected (step 5 adds a test that folds in a `save()` fix only if it proves red).
- Decision (`ask_user`): replace (override-wins) merge across layers, not concatenate — every other `UnifiedPermissionConfig` field replaces or deep-shallow-merges, so a concatenating array would be the lone divergent rule; the reported bug is a single-layer drop, so replace is the minimal consistent fix.
- Chose to extract `normalizeOptionalStringArray` into `common.ts` (alongside `normalizeOptionalPositiveInt`) rather than duplicate the inline guard — both `normalizeUnifiedConfig` and the existing `normalizePermissionSystemConfig` validate the same "optional string array" concern, so the helper dedupes rather than adds a third copy.
- Pre-monorepo plans in `docs/plans/archive/` use upstream issue numbers; ignored them for `NNNN` selection.
  Picked `0347` to match the issue.
- No `docs/architecture/`, schema, `config.example.json`, or `docs/configuration.md` changes needed — the field is already declared and documented everywhere except the loader.

[#122]: https://github.com/gotgenes/pi-packages/issues/122
[#332]: https://github.com/gotgenes/pi-packages/issues/332
[#350]: https://github.com/gotgenes/pi-packages/issues/350

## Stage: Implementation — TDD (2026-06-08T22:00:00Z)

### Session summary

Executed all five TDD cycles from the plan in a single session across four commits.
Added `normalizeOptionalStringArray` to `src/common.ts`, refactored `normalizePermissionSystemConfig()` in `src/extension-config.ts` to use it (no behavior change), added `piInfrastructureReadPaths` to `UnifiedPermissionConfig` with parse and override-wins merge in `src/config-loader.ts`, and added `refresh()` + `save()` integration tests to `test/config-store.test.ts`.
Test count grew from 1873 to 1894 (+21).

### Observations

- Step 5 (`save()` preservation) was green immediately against the step-4 production fix — the `...existing.config` spread in `ConfigStore.save()` carries the field automatically once the loader declares and parses it, exactly as predicted from the [#332] precedent.
  No additional `save()` production change was needed.
- The `it.each` for malformed `piInfrastructureReadPaths` values in `test/config-loader.test.ts` used a `const` assertion on the tuple array (`as const`); the `"mixed-type array"` entry `["a", 1]` required the outer array to be typed carefully since `as const` would make `1` a literal `1` not assignable to the union — worked fine with the existing pattern already established for other `it.each` tables in the file.
- Pre-completion reviewer: **PASS** — all deterministic checks clean, no warnings.

## Stage: Final Retrospective (2026-06-09T00:15:00Z)

### Session summary

Shipped issue #347 end-to-end across four stages (plan → TDD → ship → retro) in one continuous session, releasing `@gotgenes/pi-permission-system` v10.7.0.
The fix carries `piInfrastructureReadPaths` through the unified config loader, closing a silent config-field drop that is the second instance of the [#332] loader-gap bug class.
Execution was exceptionally clean: zero rework commits, zero follow-up fixes, CI green on the first push, and the pre-completion reviewer returned PASS with no warnings.

### Observations

#### What went well

- **Sibling-fix template produced an accurate forecast** — the plan treated [#332] as an isomorphic precedent and predicted that step 5 (`save()` preservation) would pass green with no production change, because `ConfigStore.save()` already spreads `...existing.config`.
  That held exactly: the two `save()`/`refresh()` integration tests were green immediately against the step-4 loader fix.
  Reusing a closed sibling issue as a structural template is what kept this fix small and predictable.
- **Recurring bug class made visible** — recognizing #347 as "the same shape as #332" during planning (not during review) meant the root cause was named correctly up front and the matching logic (`isPiInfrastructureRead`) was ruled out of scope without a detour.
- **Incremental verification throughout** — per-file `vitest` after every red/green, `pnpm run check` immediately after the shared-module change (step 2) and the interface change (step 4), and the full `test` + `lint` + `fallow dead-code` gate after the last step.
  Every red phase produced exactly the predicted failure count (8, then 5), confirming the tests targeted the right surface.

#### What caused friction (agent side)

- `instruction-violation` (self-identified) — the `/tdd-plan` "Write stage notes" step ends with a commit (`docs(retro): add TDD stage notes`), but the TDD stage left the retro edit uncommitted at the session boundary; the `/ship-issue` stage committed it as its first action.
  Impact: negligible — no rework, one commit shifted across a stage boundary; ship handled the pending edit cleanly.

#### What caused friction (user side)

- None.
  User involvement was the four stage prompts plus one `ask_user` answer (merge semantics: replace).
  No correction or redirection was needed; the merge-semantics decision was surfaced at the right moment in planning.

### Diagnostic details

- **Model-performance correlation** — model selection tracked task complexity cleanly across the session: planning and this retrospective ran on `claude-opus-4-8` (judgment-heavy: root-cause diagnosis, the `ask_user` merge decision, this synthesis); the mechanical TDD and ship stages ran on `claude-sonnet-4-6`; the `pre-completion-reviewer` subagent ran on `claude-sonnet-4-6` (its frontmatter default) and returned PASS.
  No reasoning-weak-on-judgment or high-cost-on-mechanical mismatch.
- **Feedback-loop gap analysis** — no gap; verification ran incrementally (see "What went well"), not just at the end.
- **Escalation-delay tracking** and **unused-tool detection** — nothing notable; no `rabbit-hole` friction, no error sequence exceeded one tool call, and no `Explore`/`colgrep`/`web_search` gap (the sibling-fix precedent meant the codebase area was already understood from #332).

### Changes made

1. `.pi/skills/package-pi-permission-system/SKILL.md` — added a Configuration-section bullet directing that a new `PermissionSystemExtensionConfig` field also be carried through the loader's `UnifiedPermissionConfig` (`normalizeUnifiedConfig` + `mergeUnifiedConfigs`), naming the #332 / #347 bug class.
2. `packages/pi-permission-system/docs/retro/0347-infra-read-paths-config-loader-gap.md` — added this Final Retrospective stage entry.
