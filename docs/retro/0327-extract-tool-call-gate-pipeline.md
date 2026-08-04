---
issue: 327
issue_title: "Extract a ToolCallGatePipeline collaborator that owns tool-call gate construction"
---

# Retro: #327 — Extract a ToolCallGatePipeline collaborator that owns tool-call gate construction

## Stage: Planning (2026-06-03T03:45:47Z)

### Session summary

Produced the implementation plan for extracting a `ToolCallGatePipeline` collaborator that owns tool-call gate construction, narrowing `PermissionSession` with `getToolPreviewLimits()` / `getInfrastructureReadDirs()`, and removing the anemic `getInfrastructureDirs` / `getInfrastructureReadPaths` getters.
The plan is a five-step lift-and-shift (add session methods → introduce pipeline + tests → inject and delegate → remove dead getters → docs), all behavior-preserving.
Confirmed #326 (handleInput unification) is already landed, so the handler's `handleInput` is unchanged here.

### Observations

- Settled the `evaluate(...)` seam the issue left open: chose `evaluate(tcc, runner)` with the pipeline owning the bash-command extraction and the single `BashProgram.parse`, since those are purely tool-call gate-construction inputs that `handleInput` never needs (decided via `ask_user`).
- The user corrected an initial draft that constructed the pipeline inside the `PermissionGateHandler` constructor — that violated dependency injection.
  Revised so `index.ts` constructs the pipeline and injects it; the handler also drops its now-unneeded `customFormatters` constructor parameter.
  Deliberately left the pre-existing `new GateRunner(...)` / `new GateDecisionReporter(...)` construction in the handler constructor alone — relocating those is the explicit scope of #320 and #325, and folding them in would balloon the issue.
- Chose a narrow pipeline-owned interface `ToolCallGateInputs` (extends `PermissionResolver`) over depending on the concrete `PermissionSession`, so the new pipeline unit tests stay cast-free.
  Avoided a layer inversion by **not** declaring `PermissionSession implements ToolCallGateInputs` — the structural check lives at the `new ToolCallGatePipeline(session, ...)` call site, keeping the domain module free of an upward import from the handler layer.
- The runner is passed per-call to `evaluate` rather than injected into the pipeline, because the same `GateRunner` instance is shared with `handleInput`.
- Key follow-on risk for `/tdd-plan`: the session mocks are cast via `as unknown as PermissionSession`, so renamed/added methods (`getInfrastructureReadDirs`, `getToolPreviewLimits`) fail at runtime, not at typecheck — step 3 must update every session mock on the handler/pipeline path and run the full suite.

## Stage: Implementation — TDD (2026-06-03T04:09:24Z)

### Session summary

All 5 TDD steps completed across 5 commits.
Added 14 tests (1796 → 1807 after removing the 3 deleted old-getter tests, then +14 new = 1807 net; old 2 old-getter tests subtracted).
`ToolCallGatePipeline` with `ToolCallGateInputs` interface introduced; `makeGateInputs` added to `gate-fixtures.ts`; handler and composition root wired correctly.
Pre-completion reviewer returned PASS.

### Observations

- Step 3 risk materialised exactly as predicted: `getInfrastructureDirs` and `getInfrastructureReadPaths` overrides in `test/handlers/external-directory-integration.test.ts`, `external-directory-session-dedup.test.ts`, and `tool-call-events.test.ts` were dead after the handler stopped calling them.
  Updating all mocks and running the full suite caught this correctly (no typecheck errors, but runtime failures if mocks were missed).
- `external-directory-session-dedup.test.ts` had 6 direct `new PermissionGateHandler(...)` calls; added a local `makeHandlerForSession(session)` helper and replaced them all with `perl` in-place substitution — cleaner than 6 individual edits.
- The `PermissionResolver` import in the new pipeline test file was unused (lint caught it) — removed before commit.
- The `makeHandlerForSession` helper in the dedup test file references `makeToolRegistry()` which is defined after it; both are `function` declarations so hoisting keeps them safe.
- Pre-completion reviewer: PASS — no warnings.

## Stage: Final Retrospective (2026-06-03T04:11:51Z)

### Session summary

Planned and implemented #327 across three stages (planning, TDD, retro) in a single working session: extracted `ToolCallGatePipeline` (owning tool-call gate construction and the run loop), narrowed `PermissionSession` with `getToolPreviewLimits()` / `getInfrastructureReadDirs()`, and removed the anemic `getInfrastructureDirs` / `getInfrastructureReadPaths` getters.
Five behavior-preserving commits plus docs; the full suite went 1796 → 1807 tests, and the pre-completion reviewer returned PASS with no warnings.
The only substantive correction came in planning — a dependency-injection misstep the user caught before any code was written.

### Observations

#### What went well

- The planning-stage risk note ("step 3 must update every session mock on the handler/pipeline path") fired exactly as predicted in TDD step 3, and was pre-mitigated — the renamed `getInfrastructureReadDirs` / added `getToolPreviewLimits` mocks across three test files were updated in one pass with zero rework.
  The cross-session retro bridge worked as designed: a risk recorded at planning prevented a runtime-only (non-typecheck) failure at implementation.
- The `ask_user` gate on the `evaluate(...)` seam shape produced a decision (`evaluate(tcc, runner)`, pipeline owns the bash parse) that held unchanged through implementation — no seam churn.
- Lift-and-shift sequencing (add new methods alongside old → introduce pipeline → inject and delegate → remove old getters) kept every one of the five commits green and type-clean; no commit left the tree broken.

#### What caused friction (agent side)

- `instruction-violation` — the initial plan draft constructed `ToolCallGatePipeline` inside the `PermissionGateHandler` constructor (`new ToolCallGatePipeline(...)`), violating the `code-design` skill's dependency-injection rule even though that skill was loaded.
  Root cause: anchored on local precedent — the handler already constructs `GateRunner` and `GateDecisionReporter` internally — without recognizing that this precedent is the exact smell #320 / #325 exist to remove.
  User-caught.
  Impact: design correction at planning before any code was written, so no code rework; the plan's Design Overview and TDD steps were revised to inject from `index.ts` and drop the handler's `customFormatters` param.
- `other` — the plan used reference-style issue-link definitions (`[#319]:` …) with bare `#319` body references, tripping `rumdl` MD053 (unused link definition) on first `lint:md`.
  Self-caught via lint; fixed with one `perl` pass bracketing the body references.
  Impact: one extra fix cycle in planning, no rework.
  The `markdown-conventions` skill already documents this rule, so no convention change is warranted.

#### What caused friction (user side)

- During TDD step 3 and the docs step, execution paused after tool calls and the user had to nudge three times ("You need to keep going", "Please continue").
  Opportunity, not criticism: these were mid-step boundaries on a long mechanical refactor (handler + `index.ts` + four test files), not decision points — the continuation was unambiguous.
  No prompt or convention change proposed; this reads as turn-continuity friction rather than a workflow gap.

### Changes made

1. Added a one-sentence clause to the Dependency Inversion (DIP) section of `.pi/skills/code-design/SKILL.md`: when adding a new collaborator to a class that still constructs other collaborators internally, inject the new one anyway — existing constructor-internal construction is often the smell being removed, not a precedent to extend.
   This addresses the user-caught DI violation where the plan draft constructed `ToolCallGatePipeline` inside the `PermissionGateHandler` constructor by mirroring the sibling `GateRunner` / `GateDecisionReporter` construction.

### Diagnostic details

- **Model-performance correlation** — one subagent dispatched (`pre-completion-reviewer`, 236s, 34 tool uses) on judgment-heavy review work; appropriate match, no mismatch.
  Planning exploration (~15 `read`/`grep` calls) ran on the parent session rather than via an `Explore` subagent — acceptable here since the symbol set was known and keeping context aided the design decision.
- **Escalation-delay tracking** — no `rabbit-hole` friction; no error or approach occupied more than one or two consecutive tool calls.
- **Feedback-loop gap analysis** — verification ran incrementally: each TDD step ran its affected test file (red → green) then `pnpm run check`; step 3 ran the full handler test directory plus the whole suite and `check` before commit; final gates (full suite, `check`, `lint`, `fallow dead-code`) all green.
  No end-loaded-verification gap.
