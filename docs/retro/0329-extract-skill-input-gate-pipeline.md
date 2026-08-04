---
issue: 329
issue_title: "Extract a SkillInputGatePipeline for the handleInput skill-input gate"
---

# Retro: #329 — Extract a SkillInputGatePipeline for the handleInput skill-input gate

## Stage: Planning (2026-06-03T00:00:00Z)

### Session summary

Produced the implementation plan for extracting a `SkillInputGatePipeline` that mirrors the `ToolCallGatePipeline` ([#327]) for the `input` path.
Verified that prerequisites [#326] (`describeSkillInputGate`, `skill_input` denial kind) and [#327] (`ToolCallGatePipeline`, `GateHandlerSession`) are already landed in the codebase, and that `docs/architecture/architecture.md` already carries Step 12/13 entries for this work.

### Observations

- The one genuinely ambiguous design choice — whether to defer the request-id relocation to [#330] or fold it into this pipeline now — was surfaced via `ask_user`.
  The user chose to **absorb [#330]**: the pipeline mints its own id via a relocated `createSkillInputRequestId` helper, and `PermissionSession.createPermissionRequestId` is removed outright.
  The plan notes [#330] can be closed when this ships.
- Settled the notifier seam as a narrow `GateNotifier` interface (`warn(message)`) built per-event in `handleInput` from `ctx`, splitting the deny decision (pipeline) from the `hasUI` gate (notifier closure) — Tell-Don't-Ask, keeps `ExtensionContext` out of the pipeline.
- `evaluate` must be a non-`async` function returning `runner.run(...)` directly: it has no `await` of its own, and `@typescript-eslint/require-await` would reject an `async` body with no `await`.
- The runner is passed per-call (not injected into the pipeline), mirroring `ToolCallGatePipeline.evaluate(tcc, runner)` and avoiding dual ownership.
- Step 2 is deliberately one commit: the constructor-arity change plus the `GateHandlerSession` / `PermissionSession` shrink break every call site and all `createPermissionRequestId` consumers at the type level at once, so they cannot land separately.
- Tracked but not addressed: the handler reaches five injected collaborators after this change (dependency-width threshold) — grouping is [#320]'s concern.

[#320]: https://github.com/gotgenes/pi-packages/issues/320
[#326]: https://github.com/gotgenes/pi-packages/issues/326
[#327]: https://github.com/gotgenes/pi-packages/issues/327
[#330]: https://github.com/gotgenes/pi-packages/issues/330

## Stage: Implementation — TDD (2026-06-03T17:48:00Z)

### Session summary

Implemented the `SkillInputGatePipeline` extraction across 3 TDD cycles.
Step 1 added the new `skill-input-gate-pipeline.ts` module with `SkillInputGateInputs`, `GateNotifier`, `SkillInputGatePipeline`, `createSkillInputRequestId`, and `formatSkillDenyNotice`, plus test fixtures and 12 new pipeline unit tests.
Step 2 was one atomic commit: shrank `GateHandlerSession` to two methods, rewrote `handleInput` to delegate, removed `PermissionSession.createPermissionRequestId`, updated `index.ts` and all four affected test files.
Step 3 updated `architecture.md` (module tree, roadmap Steps 12–13 ✅) and the package SKILL fixture inventory.
Final test count: 84 files, 1817 tests (+1 file, +10 tests from baseline).

### Observations

- One post-implementation lint fixup: `GateNotifier` import in `gate-fixtures.ts` became unused after the return-type annotation was dropped from `makeNotifier` (per testing-skill rule: don't annotate factory return with the interface, it erases `Mock<...>` methods).
  Amended into the docs commit before pushing.
- The `makeNotifier` return type is intentionally unannotated — returning `GateNotifier & { warn: ReturnType<typeof vi.fn> }` caused a type error because `(message: string) => void` is not assignable to `MockInstance<Procedure | Constructable>`.
  Fixed by using `vi.fn<(message: string) => void>()` with no return-type annotation on the factory itself.
- Step 2's single-commit constraint worked cleanly: the constructor-arity change, `GateHandlerSession` shrink, `createPermissionRequestId` removal, and all four call-site updates compiled as one coherent change.
- Pre-completion reviewer: PASS (all deterministic checks green, code design clean, docs complete, Mermaid diagrams validated).

## Stage: Final Retrospective (2026-06-03T18:05:00Z)

### Session summary

A single continuous session carried #329 from planning through TDD implementation to this retro: extracted `SkillInputGatePipeline`, shrank `GateHandlerSession` to a two-method context role, and folded `createPermissionRequestId` into the pipeline (absorbing #330).
Three TDD cycles landed across `feat`/`refactor`/`docs` commits; final suite 84 files / 1817 tests, pre-completion reviewer PASS.
Ship is intentionally deferred until #321 — the six commits remain local and unpushed.

### Observations

#### What went well

- The Step 2 atomic refactor — constructor-arity change, `GateHandlerSession` shrink, `PermissionSession.createPermissionRequestId` removal, and four call-site updates across `index.ts` plus three test files — compiled and passed the full suite on the first run.
  The plan's deliberate "fold into one commit" call (forced by simultaneous type-level breakage) paid off: no intermediate broken state, no follow-up fixups on the production change itself.
- The planning `ask_user` gate cleanly resolved the request-id boundary (absorb #330 vs. defer) before any code existed, and the implementation followed that decision without revisiting it.

#### What caused friction (agent side)

- `instruction-violation` (self-identified) — wrote `makeNotifier` in `gate-fixtures.ts` with the return-type annotation `GateNotifier & { warn: ReturnType<typeof vi.fn> }`, directly contradicting the `testing` skill's explicit rule "Do not use `ReturnType<typeof vi.fn>` — in Vitest v4 it expands to `Mock<Procedure | Constructable>`, a union that TypeScript cannot call."
  Caught at `pnpm run check` after Step 1.
  Impact: removed the annotation (left the factory return unannotated per the same skill's other rule), which then orphaned the `GateNotifier` import — caught only at the final `biome check`, requiring a second edit and a `--amend`.
  Two corrective edits, no new commit; the governing rule already exists and is crisp, so this is a salience slip, not a doc gap.

#### What caused friction (user side)

- None.
  The mid-retro "skipping ship-issue until #321" note arrived in time and changed nothing already done.

### Diagnostic details

- **Model-performance correlation** — TDD implementation ran on `anthropic/claude-sonnet-4-6` (appropriate for a behavior-preserving extraction); the retro runs on `anthropic/claude-opus-4-8` (judgment work).
  The `pre-completion-reviewer` subagent returned a thorough multi-section PASS.
  Two `opencode-go/deepseek-v4-flash` `model_change` entries appear with no assistant turn under them — transient selections that never ran; no judgment-heavy work landed on a weak model.
- **Feedback-loop gap analysis** — verification was incremental (per-file `vitest` after Step 1, full suite after Step 2, then `check`/`lint`/`fallow` at the end).
  The one gap: the `makeNotifier` type error surfaced only at `pnpm run check` (vitest does not typecheck) and the orphaned-import warning only at the final `biome check` — both are inherent to those tools' staging, not a missed earlier run.
  Escalation-delay and unused-tool lenses found nothing (no rabbit-holes; the single friction resolved in two edits).

### Changes made

1. Appended this Final Retrospective stage entry to `packages/pi-permission-system/docs/retro/0329-extract-skill-input-gate-pipeline.md`.
   No `AGENTS.md` or prompt changes — the single friction point is already covered by existing `testing`-skill rules (user-confirmed retro-file-only scope).
