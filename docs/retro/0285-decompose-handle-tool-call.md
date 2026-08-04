---
issue: 285
issue_title: "Decompose handleToolCall in permission-gate-handler.ts"
---

# Retro: #285 — Decompose `handleToolCall` into a gate pipeline

## Stage: Planning (2026-05-30T00:00:00Z)

### Session summary

Produced a numbered implementation plan for decomposing `PermissionGateHandler.handleToolCall` into a unified `runGate` closure plus an ordered gate-producer pipeline, and an extracted `validateRequestedTool` pure helper.
The change is behavior-preserving; existing handler and integration suites are the safety net and must stay green unmodified.
Plan filed at `packages/pi-permission-system/docs/plans/0285-decompose-handle-tool-call.md`.

### Observations

- The issue and the architecture-doc Phase 2 roadmap (step 1) specify the design unambiguously, so no `ask_user` gate was needed.
- Key behavior-preservation insight: the unified `runGate` reads `gate.decision` unconditionally on the bypass branch.
  Only the external-directory gate emits a bypass `decision` (and already does today); for the `log`-only gates `gate.decision` is `undefined`, so the unified handling is strictly equivalent.
- The normal tool gate is the one special producer: it must reproduce the `checkPermission → describeToolGate → preCheck` sequence verbatim inside its thunk.
- `validateRequestedTool` must return the raw `getToolNameFromValue` result, not the normalized name, to keep `tcc.toolName` identical to current behavior.
- Decided to export `validateRequestedTool` for direct unit testing, following the existing exported-plus-tested pure-helper convention already in this file (`getEventInput`, `extractSkillNameFromInput`) — a test consumer keeps fallow from flagging it as dead.
- Deferred the inline `toolCallId` ternary extraction as out-of-scope noise; deferred end-to-end test thinning to the [#288] test-dedup pass.
- Ordering note from the issue: land before Phase 1 step 2 ([#282]) since both touch the `describeToolGate` call site; decompose-first avoids a rebase.
- Doc follow-up flagged for implementation: update `architecture.md` module listing (~line 493), mark Phase 2 step 1 done, and refresh the CRAP-risk metric after re-running `fallow health --targets`.

[#282]: https://github.com/gotgenes/pi-packages/issues/282
[#288]: https://github.com/gotgenes/pi-packages/issues/288

## Stage: Implementation — TDD (2026-05-30T22:00:00Z)

### Session summary

All four TDD cycles completed in sequence: unit tests for `validateRequestedTool` (red), extraction and wiring of `validateRequestedTool` + `RequestedToolValidation` (green), introduction of the `runGate` closure and ordered `gateProducers` pipeline replacing six hand-written gate blocks (green, verified by all existing suites), and `architecture.md` update marking Phase 2 step 1 complete.
Test count delta: +1 file, +10 tests (67 files / 1520 tests total, up from 66 / 1510).
Pre-completion reviewer: **PASS**.

### Observations

- **ESLint/Biome friction on the loop comment:** added a `// eslint-disable-next-line no-await-in-loop` comment above the pipeline `for` loop; ESLint stripped it (the rule is not enabled in this package) and left a trailing space; Biome rejected the trailing space in the follow-up lint run.
  Fixed with `biome check --write` before re-committing.
  Lesson: don't pre-emptively add `eslint-disable` for rules that may not be configured — run lint first and see what it actually complains about.
- **Complexity outcome:** `handleToolCall` no longer appears as a refactoring target in `fallow health --targets`.
  CRAP risk for `permission-gate-handler.ts` dropped from 172 → 79.4 (now `handleInput`, which predates this issue and was always high).
  Refactoring targets for the package: 5 → 4.
- **`validateRequestedTool` returns raw name, not normalised:** confirmed by the `ok`-path unit test.
  The plan note was accurate and critical — the normalised form from `ToolRegistrationCheckResult.normalizedToolName` would have silently changed `tcc.toolName` for tools registered under aliases.
- **All pre-existing suites stayed green without modification**, as required by the plan's behavior-preservation goal.
