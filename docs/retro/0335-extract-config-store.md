---
issue: 335
issue_title: "Extract a ConfigStore from the runtime free-functions"
---

# Retro: #335 — Extract a ConfigStore from the runtime free-functions

## Stage: Planning (2026-06-05T01:50:00Z)

### Session summary

Produced the numbered implementation plan for Phase 4 Step 2 — extracting a `ConfigStore` class that owns `config` + `lastConfigWarning` and converts the three `(runtime, …)` config free functions into methods.
Predecessor #334 (inject a single `PermissionManager`) is already merged; this is the first session on #335 (no prior retro).
The plan is six behavior-preserving TDD cycles using a lift-and-shift migration (introduce the store, back the runtime with it via a temporary `get config()` getter, migrate consumers one at a time, then delete the free functions).

### Observations

- The one genuine design fork — how the store obtains the runtime context that `refresh` / `logResolvedPaths` need — was settled by the roadmap, not by `ask_user`.
  `docs/architecture/architecture.md` deliberately scopes the store to `config` + `lastConfigWarning` (context unification onto `PermissionSession` is Step 4 / #337), so owning `runtimeContext` in the store was rejected.
  The plan injects a transitional `RuntimeContextRef` (get/set) backed by the still-runtime-owned `runtimeContext` field; it dissolves in #337.
- Tension between the issue's "the 4× `() => runtime.config` closures … are gone" and the roadmap reserving the `index.ts` deps-bag collapse for Step 5 (#338).
  Resolved by removing the `PermissionSession`, `PermissionPrompter`, and command `() => runtime.config` closures here (those consumers hold the store / a `ConfigReader`), while the logger `getConfig` adapter is redirected to `configStore.current()` and fully retired in Step 3 (#336), and the forwarding `shouldAutoApprove` adapter survives to Step 5.
  Documented as an explicit scoping decision in the plan's Non-Goals / Open Questions.
- The logger ↔ config temporal coupling (the store must be built before the logger whose sink the store defers to) is preserved verbatim — it is the existing deferred-binding pattern and Step 3 (#336) removes it.
  Avoided pulling that fix forward into this Step.
- `createSessionLogger(runtime)` reads `runtime.writeDebugLog` / `writeReviewLog` / `runtimeContext` but **not** `runtime.config`, so removing the `config` field does not touch it — confirmed by grep before finalizing the module list.
- Lift-and-shift chosen because the alternative (remove `config` + the free functions in one commit) would force every consumer and test into a single oversized commit; the temporary `get config()` getter keeps `index.ts` compiling across the four consumer-migration steps.

## Stage: Implementation — TDD (2026-06-05T22:25:00Z)

### Session summary

All 6 TDD cycles completed across `config-store.ts` (new), `runtime.ts`, `permission-session.ts`, `permission-prompter.ts`, `config-modal.ts`, and `index.ts`.
Test count went from 1831 (86 files) to 1840 (87 files): +22 new `config-store.test.ts` tests, -13 deleted `refreshExtensionConfig` tests from `runtime.test.ts`.
Pre-completion reviewer returned PASS with no findings requiring action.

### Observations

- Step 2 (`runtime.ts`) required `Object.defineProperty` for the transitional `get config()` getter bridge; the plain-object-literal factory pattern can't have getters inline.
  The `as unknown as ExtensionRuntime` cast is needed because `Object.defineProperty` returns the pre-cast type.
  The bridge was removed cleanly in Step 6 when the last consumer (`canResolveAskPermissionRequest` in `index.ts`) migrated.
- `@deprecated` JSDoc tags on the Step-2 delegator functions triggered `@typescript-eslint/no-deprecated` on every call site in `index.ts`.
  Replaced with prose comments per the AGENTS.md lift-and-shift rule ("do not mark it `@deprecated`").
- `ConfigStore.save` was flagged as dead code by fallow because fallow cannot trace calls through the `CommandConfigStore` interface.
  Suppressed with `// fallow-ignore-next-line unused-class-member` plus an explanatory prose comment above it.
- Step 5 (`config-modal.ts`) needed two passes: the batch edit for the interface + import was rejected (edit[2] in the first call failed to match), but the body-method edits applied.
  Lesson: when one edit in a batch fails, the entire batch is rolled back — check match fidelity for every oldText before sending.
- Architecture doc updated: `config-store.ts` added to the module-structure listing; Steps 1 and 2 marked `✓ complete` in the Phase 4 roadmap.
- Pre-completion reviewer verdict: **PASS** — all deterministic checks green, no structural findings, `fallow` clean.

## Stage: Final Retrospective (2026-06-05T10:56:41Z)

### Session summary

Shipped #335 end-to-end: the TDD implementation (6 green cycles), pre-completion review (PASS), push, CI verification, issue close, and release of `pi-permission-system-v10.3.0`.
The refactor is behavior-preserving — `config` now has one owner (`ConfigStore`) and the `() => runtime.config` closures plus three `(runtime, …)` free functions are gone.
Friction was concentrated in mechanical `Edit`-tool usage (failed batches, a clumsy large-block deletion), not in design or strategy.

### Observations

#### What went well

- Narrow-interface segregation (`ConfigReader` / `SessionConfigStore` / `CommandConfigStore`) let every test double satisfy the type structurally — zero `as unknown as` casts in the new fixtures.
  The pre-completion reviewer called this out explicitly; it validates the `code-design` "inject a narrow interface, not the concrete class" rule.
- Incremental verification: `check` + `vitest` + `lint` ran after each of the 6 TDD steps, so the `@deprecated` lint error and the batch-application gaps surfaced inside the step that caused them rather than at the end.
- The `ask_user` batching gate at ship time worked cleanly — surfaced that #335 is 1 of 9 steps and let the user choose release-now vs. batch instead of assuming.

#### What caused friction (agent side)

- `wrong-abstraction` — deleting the ~145-line `refreshExtensionConfig` `describe` block from `runtime.test.ts` was attempted with incremental surgical `Edit`s (rename to `PLACEHOLDER_DELETED`, add `describe.skip`, add `eslint-disable-line` comments) before abandoning that for a one-shot `python3` truncation at a marker.
  Impact: ~5 fumbling tool calls before switching to the bulk approach; no rework to shipped code.
- `other` (tool batch atomicity) — in both Step 4 (`permission-prompter.test.ts`) and Step 5 (`config-modal.ts`) a large multi-`edit` `Edit` call was rejected because one `oldText` (edit[2]) failed to match; the whole batch rolled back, but follow-up calls only re-applied a subset, so the import/interface edits silently never landed and a later `pnpm run check` failed.
  Impact: 2 extra check-fix cycles (one per step).
- `instruction-violation` (self-identified) — marked the Step-2 delegator functions `@deprecated` despite the `testing` skill's explicit "do not mark it `@deprecated`" rule; `@typescript-eslint/no-deprecated` caught it at the Step-2 lint gate.
  Impact: one extra edit cycle (3 JSDoc→prose edits); rule already exists and lint enforced it, so the safety net held.
- `missing-context` (user-caught) — the Phase 4 roadmap step-completion markers in `architecture.md` were not updated when #335 shipped (nor was #334's when it shipped earlier); the user had to ask "mark step 1 as complete."
  Impact: one extra user round-trip + a follow-up commit (`bc0fd5f5`).

#### What caused friction (user side)

- None material.
  The one user intervention (marking roadmap steps complete) was mechanical oversight of a doc-bookkeeping gap, not strategic redirection — the kind of thing the ship flow should catch automatically.

### Diagnostic details

- **Escalation-delay tracking** — the `runtime.test.ts` block deletion ran ~5 consecutive `Edit`/`Read` calls on the same goal before switching tactics; just under the 5-call dispatch threshold, but a single boundary-to-boundary replacement (or the `python3` cut) should have been the first move.
- **Feedback-loop gap analysis** — no gap: verification was incremental after every step, and `fallow dead-code` ran from the repo root at Step 6 and again at ship.
  This is why the `@deprecated` and batch-application slips cost a cycle each instead of compounding.
- **Model-performance correlation** — the only subagent dispatch was the `pre-completion-reviewer` on its default model for judgment-heavy code review; appropriate, returned a thorough PASS.
  No mismatch.

### Changes made

1. `.pi/skills/package-pi-permission-system/SKILL.md` — added a note to mark a roadmap step `✓ complete` in `architecture.md` as part of the shipping change (addresses the user-caught completion-marking gap).
2. `AGENTS.md` — added an `### Edit tool batches` subsection under Workflow: a rejected multi-edit `Edit` call applies nothing, so re-apply every intended edit and run `pnpm run check` after a rejection (addresses the Step 4 / Step 5 batch-atomicity friction).
3. `packages/pi-permission-system/docs/retro/0335-extract-config-store.md` — this Final Retrospective stage entry.
