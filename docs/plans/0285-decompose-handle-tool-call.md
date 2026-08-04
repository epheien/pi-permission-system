---
issue: 285
issue_title: "Decompose handleToolCall in permission-gate-handler.ts"
---

# Decompose `handleToolCall` into a gate pipeline

## Problem Statement

`PermissionGateHandler.handleToolCall` in `src/handlers/permission-gate-handler.ts` runs six permission gates in sequence — skill-read, path, external-directory, bash-external-directory, bash-path, and the normal tool gate.
Four of the six gates repeat the same hand-written shape: produce a descriptor, branch on `isGateBypass`, write the review log, emit the decision, otherwise call `runGateCheck` and short-circuit on a block result.
`fallow health --targets` ranks this function as the package's single highest-priority refactoring target: cognitive complexity 52 in a 396-LOC file with CRAP risk 172, the worst in the package — and it sits on the security-critical `tool_call` decision path where untested complexity is a correctness risk, not only a maintainability one.

This is Phase 2 step 1 of the improvement roadmap in `packages/pi-permission-system/docs/architecture/architecture.md`.

## Goals

- Extract a single `runGate` helper that uniformly handles the bypass log/emit branch, calls `runGateCheck`, and returns either a block result or `undefined`.
- Extract the tool-name validation prelude (missing-name / unregistered-tool checks) into a helper returning a discriminated result.
- Collapse the body of `handleToolCall` to read as: validate → build context → run an ordered gate pipeline that short-circuits on the first block.
- Behavior-preserving: the existing `permission-gate.test.ts`, `tool-call.test.ts`, `tool-call-events.test.ts`, `runner.test.ts`, and the external-directory integration suites stay green without modification.
- Drive cognitive complexity from 52 toward the `< 15` target and dissolve the CRAP-172 hotspot.

## Non-Goals

- No change to `runGateCheck` ([#287]), `resolvePermissions` ([#286]), `bash-path-extractor.ts` ([#289]), or `stripJsonComments` ([#290]) — those are sibling Phase 2 steps.
- No change to gate behavior, ordering, decision semantics, review-log output, or any gate descriptor shape.
- No change to `GateRunnerDeps`, `GateDescriptor`, or `GateResult` in `gates/descriptor.ts`.
- No formatter threading (Phase 1 step 2 / [#282], [#266]) — this plan only makes that future change cheaper by decomposing the call site first.
- `handleInput` and the two existing pure helpers (`getEventInput`, `extractSkillNameFromInput`) are untouched.

## Background

Relevant existing modules:

- `src/handlers/permission-gate-handler.ts` — `PermissionGateHandler` class; `handleToolCall` is the target method.
- `src/handlers/gates/descriptor.ts` — defines `GateResult = GateDescriptor | GateBypass | null`, the `isGateBypass` type guard, and `GateRunnerDeps`.
- `src/handlers/gates/runner.ts` — `runGateCheck(descriptor, agentName, toolCallId, deps)` returns a `GateOutcome` (`{ action: "allow" }` or `{ action: "block"; reason }`).
- `src/handlers/gates/types.ts` — `ToolCallContext` (the `tcc` value) and `GateOutcome`.
- `src/tool-registry.ts` — `getToolNameFromValue(value)` returns `string | null`; `checkRequestedToolRegistration(toolName, tools)` returns `ToolRegistrationCheckResult` (`"missing-tool-name" | "registered" | "unregistered"`).
- `src/permission-prompts.ts` — `formatMissingToolNameReason()`, `formatUnknownToolReason(name, available)`.

Each gate producer differs only in arity and async-ness:

- `describeSkillReadGate(tcc, getActiveSkillEntries)` → `GateDescriptor | null` (never a bypass).
- `describePathGate(tcc, checkPermission, getSessionRuleset)` → `GateResult` (bypass carries `log` only).
- `describeExternalDirectoryGate(tcc, infraDirs)` → `GateResult` (bypass carries `log` and `decision`).
- `describeBashExternalDirectoryGate(tcc, checkPermission, getSessionRuleset)` → `Promise<GateResult>` (bypass carries `log` only).
- `describeBashPathGate(tcc, checkPermission, getSessionRuleset)` → `Promise<GateResult>` (bypass carries `log` only).
- The normal tool gate is special: `handleToolCall` runs `checkPermission` first, then `describeToolGate(tcc, toolCheck)` (always a descriptor), then assigns `toolDescriptor.preCheck = toolCheck`.

Constraints from AGENTS.md / package skill that apply:

- Default to least privilege; the same policy + input must always produce the same decision — the refactor must not perturb ordering or any branch.
- This file already exports two internal-plus-tested pure helpers (`getEventInput`, `extractSkillNameFromInput`); a new exported pure helper follows the established convention, so fallow will not flag it (a test imports it).

## Design Overview

### Unified `runGate` helper

A local arrow function inside `handleToolCall`, closing over `tcc` and `runnerDeps` (and the `writeReviewLog` / `emitDecision` closures already built there).
It accepts any `GateResult` and returns a block result or `undefined`:

```typescript
const runGate = async (
  gate: GateResult,
): Promise<{ block: true; reason: string } | undefined> => {
  if (!gate) {
    return undefined;
  }
  if (isGateBypass(gate)) {
    if (gate.log) {
      writeReviewLog(gate.log.event, gate.log.details);
    }
    if (gate.decision) {
      emitDecision(gate.decision);
    }
    return undefined;
  }
  const result = await runGateCheck(
    gate,
    tcc.agentName,
    tcc.toolCallId,
    runnerDeps,
  );
  return result.action === "block"
    ? { block: true, reason: result.reason }
    : undefined;
};
```

Behavior-preservation note: the bypass branch always handles both `log` and `decision`.
Today the path/bash gates only have their `log` read and the external-directory gate has both read; since those gates never emit a `decision` on bypass except external-directory, reading `gate.decision` unconditionally is strictly equivalent (it is `undefined` for the others).
The skill-read gate never returns a bypass, so routing it through `runGate` (which calls `runGateCheck` for descriptors) preserves its current direct-`runGateCheck` path.

### Ordered pipeline

The six gates collapse into an ordered list of producer thunks (some async), iterated with first-block short-circuit:

```typescript
const gateProducers: Array<() => GateResult | Promise<GateResult>> = [
  () => describeSkillReadGate(tcc, () => this.session.getActiveSkillEntries()),
  () => describePathGate(tcc, checkPermission, getSessionRuleset),
  () => describeExternalDirectoryGate(tcc, infraDirs),
  () => describeBashExternalDirectoryGate(tcc, checkPermission, getSessionRuleset),
  () => describeBashPathGate(tcc, checkPermission, getSessionRuleset),
  () => {
    const toolCheck = checkPermission(
      tcc.toolName,
      tcc.input,
      tcc.agentName ?? undefined,
      getSessionRuleset(),
    );
    const toolDescriptor = describeToolGate(tcc, toolCheck);
    toolDescriptor.preCheck = toolCheck;
    return toolDescriptor;
  },
];

for (const produce of gateProducers) {
  const blocked = await runGate(await produce());
  if (blocked) {
    return blocked;
  }
}
return {};
```

The `infraDirs` array (`getInfrastructureDirs()` + `getInfrastructureReadPaths()`) is computed once before the loop, exactly as today.
Ordering is identical to the current sequence.

### Tool-name validation prelude

Extract a pure, exported helper that composes `getToolNameFromValue` + `checkRequestedToolRegistration` + the two reason formatters, returning a discriminated result.
It reads the raw tool name (not the normalized one) to match the current `tcc.toolName` value exactly:

```typescript
export type RequestedToolValidation =
  | { status: "ok"; toolName: string }
  | { status: "block"; reason: string };

export function validateRequestedTool(
  event: unknown,
  availableTools: readonly ToolInfo[],
): RequestedToolValidation {
  const toolName = getToolNameFromValue(event);
  if (!toolName) {
    return { status: "block", reason: formatMissingToolNameReason() };
  }
  const check = checkRequestedToolRegistration(toolName, availableTools);
  if (check.status === "missing-tool-name") {
    return { status: "block", reason: formatMissingToolNameReason() };
  }
  if (check.status === "unregistered") {
    return {
      status: "block",
      reason: formatUnknownToolReason(
        check.requestedToolName,
        check.availableToolNames,
      ),
    };
  }
  return { status: "ok", toolName };
}
```

`handleToolCall` then opens with:

```typescript
const validation = validateRequestedTool(event, this.toolRegistry.getAll());
if (validation.status === "block") {
  return { block: true, reason: validation.reason };
}
const toolName = validation.toolName;
```

The `availableTools` parameter type reuses whatever `getToolNameFromValue`'s registration check already accepts (the `getAll()` return type from `ToolRegistry`); no new type is invented — ISP holds because the helper reads only the tool list.

### Edge cases (all unchanged)

- Empty / missing tool name → block with the missing-name reason.
- Unregistered tool → block with the unknown-tool reason (including the available-names list).
- A bypass gate with a `decision` (external-directory) still emits it; a bypass gate with only a `log` still writes only the log.
- A `null` gate result is a no-op.
- First gate to block wins; later gates do not run.

## Module-Level Changes

`src/handlers/permission-gate-handler.ts`:

- Add exported `validateRequestedTool` + `RequestedToolValidation` type (placed with the other pure helpers at the bottom, following the stepdown rule).
- Rewrite the body of `handleToolCall`: validation prelude call, then the `runGate` closure, then the producer-array pipeline replacing the six hand-written gate blocks.
- Remove the now-dead direct `checkRequestedToolRegistration` / `formatMissingToolNameReason` / `formatUnknownToolReason` usages from the method body (they move into the helper); keep the imports — they are still referenced by the helper in the same file.
- No change to `handleInput`, `getEventInput`, or `extractSkillNameFromInput`.

`src/index.ts`: no change — `new PermissionGateHandler(...)` and `gates.handleToolCall(...)` wiring is untouched.

Documentation:

- `docs/architecture/architecture.md` — line ~493 module listing currently reads `permission-gate-handler.ts PermissionGateHandler (...); getEventInput + extractSkillNameFromInput pure helpers`; add `validateRequestedTool` to the pure-helper list.
  Mark Phase 2 step 1 ([#285]) as completed in the roadmap steps section, and refresh the `Worst CRAP risk` health-metric note for `permission-gate-handler.ts` if re-running `fallow health` confirms the drop (record the new number).
- `.pi/skills/package-pi-permission-system/SKILL.md` — no symbol it documents is removed; no change needed.

No file in Module-Level Changes is also claimed unchanged in Non-Goals.

## Test Impact Analysis

1. New unit tests enabled by the extraction.
   `validateRequestedTool` becomes directly testable as a pure function: missing/empty name, `missing-tool-name` registration status, `unregistered` status (asserting the reason includes available names), and the `ok` path returning the raw tool name.
   Previously these paths could only be exercised end-to-end through `handleToolCall`.
2. Tests that become redundant.
   None are removed in this plan.
   The end-to-end missing-name and unknown-tool assertions in `tool-call.test.ts` could in principle be thinned once the unit tests exist, but they also verify the `{ block, reason }` wiring through `handleToolCall`, so they stay as integration coverage — behavior-preserving means they must keep passing unmodified.
3. Tests that must stay as-is.
   `permission-gate.test.ts`, `runner.test.ts`, `tool-call.test.ts`, `tool-call-events.test.ts`, and `external-directory-integration.test.ts` genuinely exercise the gate-orchestration layer being refactored; they are the safety net proving behavior preservation and must remain green without modification.

## TDD Order

1. `test:` Add `validateRequestedTool` unit tests (new `test/handlers/validate-requested-tool.test.ts`, or a `describe` block in `tool-call.test.ts`).
   Cover: empty/missing name → block + missing reason; `missing-tool-name` status → block; `unregistered` → block with available names in the reason; `ok` → returns the raw tool name.
   Red: the export does not exist yet.
   Suggested commit: `test: cover validateRequestedTool extraction`.
2. `refactor:` Extract `validateRequestedTool` + `RequestedToolValidation` and wire the prelude in `handleToolCall`.
   Green: new unit tests + all existing handler suites pass.
   Suggested commit: `refactor: extract validateRequestedTool from handleToolCall`.
3. `refactor:` Introduce the `runGate` closure and replace the six hand-written gate blocks with the ordered producer pipeline.
   No new test — the existing handler/integration suites prove behavior preservation; run `pnpm --filter @gotgenes/pi-permission-system run test` before committing.
   Suggested commit: `refactor: decompose handleToolCall into a gate pipeline`.
4. `docs:` Update `architecture.md` (module listing, Phase 2 step 1 status, CRAP-risk metric) after re-running `fallow health --targets` to capture the new complexity number.
   Suggested commit: `docs: mark Phase 2 step 1 complete in permission-system roadmap`.

All four steps are small and individually reviewable; no step requires rewriting an entire large test file.
The validation extraction (step 2) and its single call site live in the same file, so the type checker stays satisfied within each commit.

## Risks and Mitigations

- Risk: a subtle behavior change in the bypass branch (e.g., emitting a `decision` where the old code did not).
  Mitigation: only the external-directory gate produces a bypass `decision`, and its current block already emits it; reading `gate.decision` unconditionally is equivalent for the `log`-only gates.
  The external-directory integration suite verifies this.
- Risk: gate ordering drift.
  Mitigation: the producer array preserves the exact six-gate order; the integration tests assert decisions that depend on ordering.
- Risk: the normal tool gate's `preCheck` assignment is lost in the producer thunk.
  Mitigation: the thunk reproduces the `checkPermission → describeToolGate → preCheck` sequence verbatim; `runner.test.ts` and `tool-call.test.ts` exercise the `preCheck` path.
- Risk: `validateRequestedTool` returns the normalized name instead of the raw one, shifting `tcc.toolName`.
  Mitigation: the helper returns the raw `getToolNameFromValue` result, matching today's `toolName` binding; the `ok`-path unit test asserts the raw value.

## Open Questions

- Whether to also extract the inline `toolCallId` string-coercion ternary into a tiny helper — deferred; it is incidental noise, not part of the two named extractions, and removing it now would widen scope without a test-surface payoff.
- Whether the end-to-end missing-name/unknown-tool assertions in `tool-call.test.ts` should later be thinned once unit coverage exists — deferred to a future test-dedup pass ([#288]).

[#266]: https://github.com/gotgenes/pi-packages/issues/266
[#282]: https://github.com/gotgenes/pi-packages/issues/282
[#285]: https://github.com/gotgenes/pi-packages/issues/285
[#286]: https://github.com/gotgenes/pi-packages/issues/286
[#287]: https://github.com/gotgenes/pi-packages/issues/287
[#288]: https://github.com/gotgenes/pi-packages/issues/288
[#289]: https://github.com/gotgenes/pi-packages/issues/289
[#290]: https://github.com/gotgenes/pi-packages/issues/290
