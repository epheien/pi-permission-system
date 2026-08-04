---
issue: 323
issue_title: "Replace GateRunnerDeps with a GateRunner class injected with role collaborators"
---

# Replace `GateRunnerDeps` with an injected `GateRunner` class

## Problem Statement

`PermissionGateHandler.handleToolCall` still hand-assembles the gate runner's collaborators as closures and threads them through every gate call.
The runner is a free function, `runGateCheck(descriptor, agentName, toolCallId, deps)`, whose `deps` is a `GateRunnerDeps` bag holding `resolve`, `recordSessionApproval`, `reporter`, `canConfirm`, and `promptPermission`.
After #319 (`PermissionResolver`) and #322 (`DecisionReporter`) landed, that bag resolves to four distinct role collaborators — a permission resolver, a session-approval recorder, a prompter, and a decision reporter — that are "built once in the orchestrator and reused for all gates," as the runner's own doc comment says.
That is constructor injection waiting to happen.
The handler additionally owns a `runGate` closure that performs the null / bypass / descriptor dispatch around `runGateCheck`; that dispatch belongs on the runner, not in an anonymous handler closure.

## Goals

- Add a `GatePrompter` role (`canConfirm()` + `promptPermission(details)`) and a `SessionApprovalRecorder` role (`recordSessionApproval(approval)`); `PermissionSession` implements both, the prompter via stored-context adapters over its existing `canPrompt(ctx)` / `prompt(ctx, details)`.
- Convert `runGateCheck` into a `GateRunner` class constructed with `PermissionResolver`, `SessionApprovalRecorder`, `GatePrompter`, and `DecisionReporter`, exposing `run(gate, agentName, toolCallId)`.
- Consolidate the null / bypass / descriptor dispatch (the handler's `runGate` closure) into `GateRunner.run`.
- Delete the `GateRunnerDeps` interface; `PermissionGateHandler` constructs one `GateRunner` in its constructor and calls `run(...)` per gate.
- Keep the change behavior-preserving; no public npm export changes (every touched module is internal `#src`).

## Non-Goals

- Retyping the `PermissionGateHandler` constructor against the narrow role set and dropping the `as unknown as PermissionSession` casts in its session mocks — that is #325, the phase capstone.
  This plan leaves the handler constructor taking the concrete `PermissionSession` and keeps the `as unknown as` mocks, adding only the delegating prompter methods those mocks need to keep passing.
- Changing any permission decision, log entry, or decision-event payload.
- Touching `handleInput` — it prompts via `session.prompt(ctx, details)` directly, never through the runner, and stays as-is.
- Folding the `GatePrompter` role into `handleInput` or sharing more of the runner's decision-building with `handleInput`.

## Background

- `src/handlers/gates/runner.ts` — `runGateCheck(descriptor, agentName, toolCallId, deps)` runs the check→log→emit→approve cycle using `deps.resolve`, `deps.reporter.writeReviewLog`/`emitDecision`, `deps.canConfirm`, `deps.promptPermission`, and `deps.recordSessionApproval`.
  It handles only `GateDescriptor` inputs.
- `src/handlers/gates/descriptor.ts` — `interface GateRunnerDeps extends PermissionResolver` adds `recordSessionApproval`, `reporter: DecisionReporter`, `canConfirm()`, `promptPermission(details)`.
  The file also defines `GateDescriptor`, `GateBypass`, `GateResult`, `isGateBypass`, `isGateDescriptor`.
- `src/handlers/permission-gate-handler.ts` — builds `canConfirm`/`promptPermission`/`recordSessionApproval` closures over `ctx` and `this.session`, packs them plus `this.reporter` into a `runnerDeps: GateRunnerDeps` bag per `handleToolCall`, and owns a `runGate` closure that does the null / bypass (log+emit) / descriptor dispatch.
  `this.reporter` is already a `GateDecisionReporter` built once in the constructor (#322).
- `src/permission-session.ts` — already `implements PermissionResolver`; stores `this.context` via `activate(ctx)`; exposes `recordSessionApproval`, `canPrompt(ctx)`, `prompt(ctx, details)`.
  `activate(ctx)` runs at the top of `handleToolCall`, so the stored context is current before any gate runs.
- `src/permission-resolver.ts` and `src/decision-reporter.ts` are the precedent role modules (a narrow interface, SDK-free, co-located with its implementor where natural).
- `src/handlers/gates/types.ts` — `GateOutcome = { action: "allow" } | { action: "block"; reason: string }`.

Constraints from AGENTS.md / `code-design`:

- When a shared interface references a collaborator, use the narrow interface type, not the concrete class.
- Keep Pi SDK imports out of pure role modules.
- Removing an exported interface breaks every consumer at the type level in one commit; lift-and-shift large test-file migrations rather than rewriting the whole file at once.

Design-review (from the `design-review` checklist) of the resulting `GateRunner`:

- Dependency width: four narrow role collaborators (1–2 methods each), all used by the runner — no wide bag.
- Law of Demeter: the transitional `deps.reporter.x()` field-then-call on a parameter bag (the #322 "track and watch") becomes `this.reporter.x()` on a direct field — resolved.
- Output arguments / scattered resets: none.
- Parameter relay: the stable collaborators become constructor fields; only the genuine per-call data (`gate`, `agentName`, `toolCallId`) flows to `run` — the relay is gone.
- Missing intermediate abstractions: `GatePrompter` and `SessionApprovalRecorder` name the last two implicit roles, letting `GateRunnerDeps` be deleted entirely.

## Design Overview

### Two new role interfaces

```typescript
// src/gate-prompter.ts
import type { PermissionPromptDecision } from "./permission-dialog";
import type { PromptPermissionDetails } from "./permission-prompter";

/**
 * The prompting role the gate runner needs: a yes/no on whether an
 * interactive confirmation is possible, and the prompt itself. The context
 * is bound by the implementor, not threaded per call.
 */
export interface GatePrompter {
  canConfirm(): boolean;
  promptPermission(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision>;
}
```

```typescript
// src/session-approval-recorder.ts
import type { SessionApproval } from "./session-approval";

/** Records a granted session-scoped approval into the session ruleset. */
export interface SessionApprovalRecorder {
  recordSessionApproval(approval: SessionApproval): void;
}
```

Separate one-role-per-file modules mirror `permission-resolver.ts` / `decision-reporter.ts` and keep both roles SDK-free; co-locating `SessionApprovalRecorder` inside `session-approval.ts` was considered and rejected for consistency with that precedent.

### `PermissionSession` implements the prompter via stored-context adapters

`PermissionSession` already stores `this.context` (set by `activate`) and exposes `canPrompt(ctx)` / `prompt(ctx, details)`.
The `GatePrompter` adapters read the stored context so the runner never threads it:

```typescript
class PermissionSession
  implements PermissionResolver, SessionApprovalRecorder, GatePrompter
{
  canConfirm(): boolean {
    return this.context !== null && this.canPrompt(this.context);
  }

  promptPermission(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> {
    if (this.context === null) {
      throw new Error(
        "promptPermission called before the session was activated",
      );
    }
    return this.prompt(this.context, details);
  }
}
```

`canConfirm()` returns `false` when no context is active, so `applyPermissionGate` never reaches `promptForApproval`; the `null` guard in `promptPermission` is therefore unreachable in correct use and exists only as a defensive invariant.
`canPrompt(ctx)` / `prompt(ctx, details)` stay public — `handleInput` still calls them directly.

### `GateRunner` class

```typescript
// src/handlers/gates/runner.ts
export class GateRunner {
  constructor(
    private readonly resolver: PermissionResolver,
    private readonly recorder: SessionApprovalRecorder,
    private readonly prompter: GatePrompter,
    private readonly reporter: DecisionReporter,
  ) {}

  async run(
    gate: GateResult,
    agentName: string | null,
    toolCallId: string,
  ): Promise<GateOutcome> {
    if (!gate) {
      return { action: "allow" };
    }
    if (isGateBypass(gate)) {
      if (gate.log) {
        this.reporter.writeReviewLog(gate.log.event, gate.log.details);
      }
      if (gate.decision) {
        this.reporter.emitDecision(gate.decision);
      }
      return { action: "allow" };
    }
    return this.runDescriptor(gate, agentName, toolCallId);
  }

  private async runDescriptor(
    descriptor: GateDescriptor,
    agentName: string | null,
    toolCallId: string,
  ): Promise<GateOutcome> {
    /* the current runGateCheck body, using this.resolver / this.prompter /
       this.reporter / this.recorder instead of deps.* */
  }
}
```

`run` returns `GateOutcome` for all three input shapes (null and bypass both resolve to `{ action: "allow" }` after any bypass side effects).

### Handler call site

```typescript
constructor(session, events, toolRegistry, customFormatters?) {
  this.reporter = new GateDecisionReporter(session.logger, events);
  this.runner = new GateRunner(session, session, session, this.reporter);
}

// in handleToolCall, replacing the runnerDeps bag + runGate closure:
for (const produce of gateProducers) {
  const outcome = await this.runner.run(
    await produce(),
    tcc.agentName,
    tcc.toolCallId,
  );
  if (outcome.action === "block") {
    return { block: true, reason: outcome.reason };
  }
}
return {};
```

The handler passes `session` for three roles (it implements `PermissionResolver`, `SessionApprovalRecorder`, `GatePrompter`) and `this.reporter` for the fourth.
This is Tell-Don't-Ask (tell the runner to run the gate) and respects the Law of Demeter (the handler talks to the runner, not its collaborators).
The collaborator closures (`canConfirm`, `promptPermission`, `recordSessionApproval`, the `resolve` lambda) and the `runGate` closure are deleted.

### Transition strategy (lift-and-shift)

`GateRunnerDeps` structurally already supplies all four roles (`resolve` → resolver, `recordSessionApproval` → recorder, `canConfirm` + `promptPermission` → prompter, `reporter` → reporter).
So `GateRunner` is introduced alongside `runGateCheck`, and `runGateCheck` temporarily becomes a thin wrapper:

```typescript
export async function runGateCheck(descriptor, agentName, toolCallId, deps) {
  return new GateRunner(deps, deps, deps, deps.reporter).run(
    descriptor,
    agentName,
    toolCallId,
  );
}
```

This keeps `runner.test.ts` and the handler green while the handler (next step) and the large runner test (after) migrate independently; the wrapper, `GateRunnerDeps`, and `makeRunnerDeps` are deleted only once nothing references them.

### Edge cases

- `run(null, …)` returns `{ action: "allow" }`, matching the old `runGate` returning `undefined` (the handler treats any non-block outcome as continue).
- The bypass branch fires `writeReviewLog` / `emitDecision` through the reporter exactly as the handler's `runGate` did — byte-identical side effects.
- Stored context equals the `handleToolCall` `ctx`: `activate(ctx)` sets `this.context = ctx` before the gate loop, so the prompter adapters see the same context the old closures captured.
- The handler integration-test session mocks are `as unknown as PermissionSession`, so they do not structurally require the new methods; at runtime the runner calls `session.canConfirm()` / `session.promptPermission(details)`, so the three mocks gain delegating adapters (see Module-Level Changes) to keep their `prompt`-override and `prompt`-call-count tests passing.

## Module-Level Changes

- `src/gate-prompter.ts` — **new**: `GatePrompter` interface.
- `src/session-approval-recorder.ts` — **new**: `SessionApprovalRecorder` interface.
- `src/permission-session.ts` — add `SessionApprovalRecorder, GatePrompter` to the `implements` clause; add `canConfirm()` and `promptPermission(details)` stored-context adapters; import both interface types.
- `src/handlers/gates/runner.ts` — add the `GateRunner` class (with the moved `runDescriptor` body and the consolidated null/bypass dispatch); import `PermissionResolver`, `SessionApprovalRecorder`, `GatePrompter`, `DecisionReporter`, and `isGateBypass`; (step 2) reduce `runGateCheck` to a wrapper; (final step) delete `runGateCheck`.
- `src/handlers/gates/descriptor.ts` — (final step) delete the `GateRunnerDeps` interface and remove its now-unused imports (`DecisionReporter`, `PermissionResolver`, `PromptPermissionDetails`, `PermissionPromptDecision`); keep `DenialContext`, `PermissionDecisionEvent`, `SessionApproval`, `PermissionCheckResult`, `PermissionState`, and the descriptor/guard exports.
- `src/handlers/permission-gate-handler.ts` — add a `private readonly runner: GateRunner` field built in the constructor; replace the `runnerDeps` bag, the collaborator closures, and the `runGate` closure with `this.runner.run(...)` in the gate loop; drop the now-unused imports (`runGateCheck`, `GateRunnerDeps`, `isGateBypass`, `PermissionResolver` if unused after the closure removal, `PromptPermissionDetails` if unused); keep `GateResult` (gate-producer typing).
- `test/helpers/gate-fixtures.ts` — add `makeGateRunner(overrides)` returning `{ runner, deps }` (builds the four role mocks and a `GateRunner`); keep `makeReporter` and `makeResolver`; (final step) delete `makeRunnerDeps` and the `GateRunnerDeps` import.
- `test/helpers/handler-fixtures.ts` — `makeSession`: add delegating `canConfirm` (→ mock `canPrompt`) and `promptPermission` (→ mock `prompt`) adapters, guarded with `Object.hasOwn` like the existing `resolve` delegation.
- `test/handlers/external-directory-integration.test.ts` and `test/handlers/external-directory-session-dedup.test.ts` — add the same delegating `canConfirm` / `promptPermission` to their local session mocks.
- `test/handlers/gates/runner.test.ts` — migrate each `runGateCheck(d, a, t, makeRunnerDeps(X))` to `const { runner, deps } = makeGateRunner(X); runner.run(d, a, t)`, keeping the `deps.reporter.*` / `deps.resolve` / `deps.promptPermission` / `deps.recordSessionApproval` assertions unchanged.
- `test/permission-session.test.ts` — new unit tests for `canConfirm` / `promptPermission` (delegation and null-context behavior).
- `.pi/skills/package-pi-permission-system/SKILL.md` — update the `gate-fixtures.ts` listing: replace `makeRunnerDeps` with `makeGateRunner` (constructs a `GateRunner` with role mocks, returns `{ runner, deps }`).
- `docs/architecture/architecture.md` — mark Phase 3 step 8 (#323) and the row-6 `GateRunner` clause ✅; update the `runner.ts` and `descriptor.ts` `src/` tree lines (`GateRunner` class; `GateRunnerDeps` removed); update the `S8` Mermaid node and the Track C summary; add a `✅ … (#323)` entry to the numbered improvement steps.

A repo-wide grep confirms `runGateCheck` and `GateRunnerDeps` are referenced only in `runner.ts`, `descriptor.ts`, `permission-gate-handler.ts`, `gate-fixtures.ts`, and `runner.test.ts` (plus the architecture doc); no other `SKILL.md` references them.

## Test Impact Analysis

1. New tests enabled.
   `PermissionSession.canConfirm` / `promptPermission` become directly unit-testable (delegation to `canPrompt` / `prompt`; `canConfirm` false and the `promptPermission` throw when no context is active) — behavior previously buried in per-`handleToolCall` closures.
   `GateRunner.run`'s null and bypass dispatch become directly unit-testable; that dispatch lived in the handler's anonymous `runGate` closure and was only reachable through full handler integration tests.
2. Redundant / simplified tests.
   None are removed.
   `runner.test.ts` keeps every assertion; only the call form changes (`runGateCheck(…, deps)` → `makeGateRunner(…).runner.run(…)` with the same `deps.*` mocks).
   The handler integration tests that exercise the infra-read bypass still pass through the handler, now additionally covered at the unit level by `GateRunner.run`.
3. Tests that stay as-is (behavior-preserving).
   The handler integration suites (`tool-call`, `tool-call-events`, `external-directory-integration`, `external-directory-session-dedup`) keep their `prompt` overrides and `session.prompt` call-count assertions working because the new mock `promptPermission` / `canConfirm` delegate to the mock's own `prompt` / `canPrompt`.
   `input` / `input-events` are untouched (`handleInput` still calls `session.prompt(ctx, …)` directly).
   Every gate descriptor test (`path`, `bash-path`, `bash-external-directory`, `bash-command`, etc.) is unaffected — they depend on `makeResolver`, not the runner.

## TDD Order

1. Add the `GatePrompter` and `SessionApprovalRecorder` roles and implement them on `PermissionSession`.
   Surface: `test/permission-session.test.ts`.
   Covers: `canConfirm` delegates to `canPrompt` with the stored context and returns `false` when inactive; `promptPermission` delegates to `prompt` with the stored context and throws when inactive.
   No other consumers yet — repo stays green.
   Commit: `feat: add GatePrompter and SessionApprovalRecorder session roles`.
2. Add the `GateRunner` class alongside `runGateCheck`; reduce `runGateCheck` to a wrapper delegating to `new GateRunner(deps, deps, deps, deps.reporter).run(...)`; add `makeGateRunner` to `gate-fixtures.ts`.
   Surface: new `GateRunner.run` null/bypass tests in `test/handlers/gates/runner.test.ts` (existing `runGateCheck` tests stay green via the wrapper).
   Run `pnpm run check` after this step (new class + transitional wrapper).
   Commit: `feat: add GateRunner class consolidating gate dispatch`.
3. Migrate `PermissionGateHandler`: build `this.runner = new GateRunner(session, session, session, this.reporter)` in the constructor; replace the `runnerDeps` bag, the collaborator closures, and the `runGate` closure with `this.runner.run(...)` in the gate loop; drop the now-unused imports.
   Add delegating `canConfirm` / `promptPermission` to `makeSession` and the two `external-directory-*` local session mocks so the runtime runner calls resolve through the mocks' `canPrompt` / `prompt`.
   Surface: existing handler integration suites stay green (behavior-preserving).
   Run `pnpm run check` after this step (constructor signature is unchanged, but the runner wiring and mock shapes change).
   Commit: `refactor: run permission gates through an injected GateRunner`.
4. Migrate `runner.test.ts` to `makeGateRunner(...).runner.run(...)`; delete the `runGateCheck` wrapper, the `GateRunnerDeps` interface (and its now-unused descriptor imports), and the `makeRunnerDeps` fixture; update the `gate-fixtures.ts` entry in `SKILL.md`.
   Surface: `test/handlers/gates/runner.test.ts` (full assertion set preserved).
   Commit: `refactor: remove GateRunnerDeps and runGateCheck`.
5. Update `docs/architecture/architecture.md`: mark step 8 (#323) and the row-6 `GateRunner` clause ✅; update the `runner.ts` / `descriptor.ts` tree lines, the `S8` Mermaid node, and the Track C summary.
   Commit: `docs: record the GateRunner extraction in the Phase 3 roadmap`.

Step 2's wrapper keeps the handler and the large runner test green so steps 3 and 4 migrate independently; the wrapper, interface, and fixture are deleted only in step 4, once no consumer remains.

## Risks and Mitigations

- The runtime runner calls `session.canConfirm()` / `session.promptPermission()`, which the `as unknown as PermissionSession` mocks do not structurally require — so a missing method would fail at runtime, not at `pnpm run check` (exactly the #319 friction).
  Mitigation: step 3 adds the delegating adapters to all three session mocks (grepped: `handler-fixtures.ts` `makeSession`, `external-directory-integration.test.ts`, `external-directory-session-dedup.test.ts`) and runs the full handler suite before committing.
- The delegating-mock tactic is itself a decoupling smell.
  Mitigation: it is transitional; #325 retypes the handler against the role interfaces and removes the `as unknown as` casts, at which point the delegation is unnecessary.
- Deleting `GateRunnerDeps` ripples to the descriptor, runner, handler, fixture, and runner test.
  Mitigation: the wrapper isolates the test migration (step 4) from the handler migration (step 3); the interface is deleted only when both are done.
- `runDescriptor` is a verbatim move of the `runGateCheck` body; a transcription slip could change behavior.
  Mitigation: the existing `runner.test.ts` assertions (run through the wrapper in steps 2–3, directly in step 4) guard the descriptor path unchanged.

## Open Questions

- The residual session-member cluster (`activate`, `resolveAgentName`, `config`, `getInfrastructureDirs`, `getInfrastructureReadPaths`, `getActiveSkillEntries`, `createPermissionRequestId`) has no role yet and is deferred to #325; this plan introduces only `GatePrompter` and `SessionApprovalRecorder`, the last two roles the runner needs.
- Whether `handleInput` should eventually prompt through a `GatePrompter` rather than `session.prompt(ctx, …)` directly is out of scope; it does not run through the gate runner.
