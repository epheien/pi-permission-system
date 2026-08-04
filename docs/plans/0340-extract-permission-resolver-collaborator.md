---
issue: 340
issue_title: "Extract a PermissionResolver collaborator out of PermissionSession"
---

# Extract a PermissionResolver collaborator out of PermissionSession

## Problem Statement

`PermissionSession` is a god object that implements six role interfaces.
One of those roles — permission resolution — is a cohesive cluster of methods (`resolve` / `checkPermission` / `getToolPermission` / `getConfigIssues` / `getPolicyCacheStamp`) that is currently fused into the session.
Because the resolution logic lives on the session, every test that wants to exercise resolution must build a full session fixture (the 17-field `makeSession` intersection mock).

This is Phase 4, Step 7 (Track C: split the session) of the `pi-permission-system` improvement roadmap.
It promotes `PermissionResolver` from a one-method interface (`resolve`) into a concrete collaborator that holds the `PermissionManager` + `SessionRules` and owns the whole resolution surface, so the resolve role becomes a distinct, directly unit-testable object.

## Goals

- Promote `permission-resolver.ts` to a concrete `PermissionResolver` class holding `ScopedPermissionManager` + `SessionRules`, owning `resolve` / `checkPermission` / `getToolPermission` / `getConfigIssues` / `getPolicyCacheStamp`.
- Rename the narrow `{ resolve }` role interface (currently `PermissionResolver`) to `ScopedPermissionResolver` so the concrete class can take the canonical name.
- Route `GateRunner`, `ToolCallGatePipeline`, and `SkillInputGatePipeline` through the new resolver for the resolve / check role.
- Remove the resolve role from `PermissionSession` (drop the `resolve` method and the `ScopedPermissionResolver` implements clause).
- Keep the change behavior-preserving — the full suite stays green at every step.

## Non-Goals

- Removing `checkPermission` / `getToolPermission` / `getConfigIssues` / `getPolicyCacheStamp` from `PermissionSession`.
  These remain (delegating to the session's own `PermissionManager`) because the `AgentPrepSession`, `SessionLifecycleSession`, and `SkillPermissionChecker` interfaces still depend on them.
  Removing them and unwinding those fig-leaf interfaces is Step 8 ([#341]).
- Rewiring `AgentPrepHandler` / `SessionLifecycleHandler` to depend on the resolver — deferred to Step 8.
- Touching `LocalPermissionsService` (`permissions-service.ts`), which keeps its own direct `PermissionManager` delegation.
- Any change to permission decision semantics, config format, schema, or docs beyond the architecture/skill descriptions.

## Background

Relevant modules (see `docs/architecture/architecture.md`):

- `src/permission-resolver.ts` — currently just the `PermissionResolver` interface (`resolve(surface, input, agentName)`); the relay-collapsing abstraction introduced in [#319].
  Implemented by `PermissionSession`.
- `src/permission-session.ts` — the god object.
  Implements `PermissionResolver`, `SessionApprovalRecorder`, `GateHandlerSession`, `AgentPrepSession`, `SessionLifecycleSession`.
  Holds the injected `ScopedPermissionManager` + `SessionRules`.
  Its `resolve` composes `checkPermission` with `getSessionRuleset()`.
- `src/handlers/gates/runner.ts` — `GateRunner` is constructed with a `PermissionResolver` and calls `resolver.resolve(...)`.
- `src/handlers/gates/tool-call-gate-pipeline.ts` — `ToolCallGateInputs extends PermissionResolver`; the pipeline is constructed with `session` and uses `this.inputs.resolve(...)` plus three query methods (`getActiveSkillEntries`, `getInfrastructureReadDirs`, `getToolPreviewLimits`).
- `src/handlers/gates/skill-input-gate-pipeline.ts` — `SkillInputGateInputs` is a narrow `{ checkPermission }`; constructed with `session`.
- Gate descriptor factories `path.ts`, `bash-command.ts`, `bash-external-directory.ts`, `bash-path.ts` — each takes a `resolver: PermissionResolver` and calls `resolver.resolve(...)`.
- `src/index.ts` — composition root.
  Constructs `permissionManager`, `sessionRules`, `session`, and wires `new GateRunner(session, session, gateway, reporter)`, `new ToolCallGatePipeline(session, formatterRegistry)`, `new SkillInputGatePipeline(session)`.

Precedent from Step 6 ([#339], `PromptingGateway`): the prompting role was fully removed from `PermissionSession` and `GateRunner` was rewired to a distinct collaborator.
This step mirrors that for resolution.

Naming follows the established role-interface + concrete-class convention (`ScopedPermissionManager` + `PermissionManager`, `GatePrompter` + `PromptingGateway`, `DecisionReporter` + `GateDecisionReporter`).
Per the user decision on this issue, the concrete class takes the canonical name `PermissionResolver` and the narrow role interface is renamed `ScopedPermissionResolver` — symmetric with `ScopedPermissionManager` (the narrow session-scoped contract the concrete class implements).

Constraint from `AGENTS.md` / `code-design`: a shared interface referencing a collaborator must use a narrow interface type, not the concrete class — the gate factories' test mocks are plain objects (`{ resolve }`), so the `{ resolve }` interface must survive as a distinct type from the class.

## Design Overview

### The narrow role interface

```typescript
// permission-resolver.ts — the resolve role the gate factories / runner / pipeline need.
export interface ScopedPermissionResolver {
  resolve(
    surface: string,
    input: unknown,
    agentName?: string,
  ): PermissionCheckResult;
}
```

### The concrete class

```typescript
// permission-resolver.ts — the concrete collaborator holding the manager + rules.
export class PermissionResolver implements ScopedPermissionResolver {
  constructor(
    private readonly permissionManager: ScopedPermissionManager,
    private readonly sessionRules: Pick<SessionRules, "getRuleset">,
  ) {}

  resolve(surface: string, input: unknown, agentName?: string): PermissionCheckResult {
    return this.checkPermission(surface, input, agentName, this.sessionRules.getRuleset());
  }

  checkPermission(surface: string, input: unknown, agentName?: string, sessionRules?: Rule[]): PermissionCheckResult {
    return this.permissionManager.checkPermission(surface, input, agentName, sessionRules);
  }

  getToolPermission(toolName: string, agentName?: string): PermissionState {
    return this.permissionManager.getToolPermission(toolName, agentName);
  }

  getConfigIssues(agentName?: string): string[] {
    return this.permissionManager.getConfigIssues(agentName);
  }

  getPolicyCacheStamp(agentName?: string): string {
    return this.permissionManager.getPolicyCacheStamp(agentName);
  }
}
```

Notes on the dependency contract:

- The constructor accepts `ScopedPermissionManager` (the narrow interface), not the concrete `PermissionManager`, so unit tests pass a fake manager without an `as unknown as` cast.
- The session-rules dependency is narrowed to `Pick<SessionRules, "getRuleset">` (ISP — the resolver only reads the ruleset; it never records approvals).
  Unit tests can pass a real `new SessionRules()` or a `{ getRuleset: () => rules }` stub.
- `getToolPermission` / `getConfigIssues` / `getPolicyCacheStamp` are included per the issue's resolution surface even though no current resolver consumer calls them; Step 8 rewires `AgentPrepHandler` / `SessionLifecycleHandler` to use them.

### Consumer call sites

`GateRunner` (unchanged body; constructor param type only):

```typescript
// runner.ts
constructor(
  private readonly resolver: ScopedPermissionResolver, // was PermissionResolver
  private readonly recorder: SessionApprovalRecorder,
  private readonly prompter: GatePrompter,
  private readonly reporter: DecisionReporter,
) {}
// ... this.resolver.resolve(descriptor.surface, descriptor.input, agentName ?? undefined)
```

`ToolCallGatePipeline` (resolver split out of the query inputs):

```typescript
// tool-call-gate-pipeline.ts
export interface ToolCallGateInputs {            // no longer extends ScopedPermissionResolver
  getActiveSkillEntries(): SkillPromptEntry[];
  getInfrastructureReadDirs(): string[];
  getToolPreviewLimits(): ToolPreviewFormatterOptions;
}

constructor(
  private readonly resolver: ScopedPermissionResolver,
  private readonly inputs: ToolCallGateInputs,
  private readonly customFormatters?: ToolInputFormatterLookup,
) {}
// gate factories now receive this.resolver; query methods stay on this.inputs:
//   describePathGate(tcc, this.resolver)
//   describeBashExternalDirectoryGate(tcc, bashProgram, this.resolver)
//   describeBashPathGate(tcc, bashProgram, this.resolver)
//   resolveBashCommandCheck(command ?? "", bashProgram.commands(), agentName, this.resolver)
//   this.resolver.resolve(tcc.toolName, tcc.input, ...)
//   this.inputs.getActiveSkillEntries() / getInfrastructureReadDirs() / getToolPreviewLimits()
```

`index.ts` (construct the resolver once; share the same `permissionManager` + `sessionRules` instances the session holds):

```typescript
const resolver = new PermissionResolver(permissionManager, sessionRules);
// ...
const gateRunner = new GateRunner(resolver, session, gateway, reporter);
const toolCallGatePipeline = new ToolCallGatePipeline(resolver, session, formatterRegistry);
const skillInputGatePipeline = new SkillInputGatePipeline(resolver);
```

`SkillInputGatePipeline` needs no interface change — the `PermissionResolver` class satisfies `SkillInputGateInputs` (`{ checkPermission }`) structurally; only the construction site moves from `session` to `resolver`.

### Separation of concerns / shared-instance contract

After this step, both `PermissionSession` and `PermissionResolver` hold references to the *same* `permissionManager` and `sessionRules` instances (injected from the composition root — never reconstructed).
`PermissionSession` keeps the manager for lifecycle (`configureForCwd` in `resetForNewSession` / `reload`) and the transitional query methods; the rules for `getSessionRuleset` / `recordSessionApproval` / `clear`.
`PermissionResolver` reads them for resolution.
There is no split-brain because the instances are identical — this mirrors the shared-instance contract established when `ExtensionRuntime` was dissolved in [#337].

### Edge cases

- Raw vs. session-scoped check: `resolve` applies `sessionRules.getRuleset()`; `checkPermission` (called by `SkillInputGatePipeline` with three args) intentionally passes no session rules — the raw skill-input semantics from [#326] are preserved because the 4th argument stays optional.
- Empty session ruleset: `resolve` forwards `[]` when no approvals are recorded (identical to the current session behavior).

## Module-Level Changes

Source:

- `src/permission-resolver.ts` — rename interface `PermissionResolver` → `ScopedPermissionResolver`; add concrete `class PermissionResolver implements ScopedPermissionResolver` (constructor `ScopedPermissionManager` + `Pick<SessionRules, "getRuleset">`; methods `resolve`, `checkPermission`, `getToolPermission`, `getConfigIssues`, `getPolicyCacheStamp`).
  Add imports for `ScopedPermissionManager`, `SessionRules`, `Rule`, `PermissionState` (types).
- `src/permission-session.ts` — drop `resolve` method; remove `ScopedPermissionResolver` (formerly `PermissionResolver`) from the `implements` list and its import.
  Keep `checkPermission` / `getToolPermission` / `getConfigIssues` / `getPolicyCacheStamp` (transitional; removed in Step 8).
- `src/handlers/gates/runner.ts` — import + constructor param `PermissionResolver` → `ScopedPermissionResolver`.
- `src/handlers/gates/tool-call-gate-pipeline.ts` — `ToolCallGateInputs` no longer extends the resolve interface (becomes the three query methods); add `resolver: ScopedPermissionResolver` as the first constructor param; route gate factories + tool resolve through `this.resolver`.
  Update the doc comment.
- `src/handlers/gates/path.ts`, `bash-command.ts`, `bash-external-directory.ts`, `bash-path.ts` — import + `resolver` param type `PermissionResolver` → `ScopedPermissionResolver`.
- `src/index.ts` — construct `new PermissionResolver(permissionManager, sessionRules)`; rewire `GateRunner` (first arg → `resolver`), `ToolCallGatePipeline` (prepend `resolver`), `SkillInputGatePipeline` (`session` → `resolver`).

`src/handlers/gates/skill-input-gate-pipeline.ts` is unchanged (only its construction site in `index.ts` moves).

Tests:

- `test/permission-resolver.test.ts` — new: unit tests for the concrete class (no session fixture).
- `test/permission-session.test.ts` — remove the `describe("resolve")` block (moves to the resolver test); `makePermissionManager` and the surviving delegation tests stay.
- `test/helpers/gate-fixtures.ts` — `makeResolver` / `makeGateRunner` / `makeGateInputs` type references `PermissionResolver["resolve"]` → `ScopedPermissionResolver["resolve"]`; `makeGateInputs` drops the `resolve` field (now produced by `makeResolver`).
  Imports updated.
- `test/handlers/gates/tool-call-gate-pipeline.test.ts` — construct `new ToolCallGatePipeline(resolver, inputs, ...)`; the `resolve`-override test (`makeGateInputs({ resolve })`) switches to `makeResolver({ ... })`.
- `test/handlers/gates/skill-input-gate-pipeline.test.ts` — no construction change (still `new SkillInputGatePipeline(inputs)` via `makeSkillInputInputs`, which is structurally a resolver subset); verify it still type-checks.
- `test/handlers/gates/bash-external-directory.test.ts`, `bash-path.test.ts` — import `PermissionResolver` type → `ScopedPermissionResolver`.

Docs:

- `docs/architecture/architecture.md` — update the module-structure entries for `permission-resolver.ts` (now interface + concrete class), `permission-session.ts` (implements four interfaces, resolve role removed), and `runner.ts` (constructed with `ScopedPermissionResolver`); decrement the "role interfaces implemented by one class" metric (5 → 4) in the constructibility table. (The Step 7 `✓ complete` marker on the roadmap step line is appended during `/ship-issue`, per the package skill.)
- `.pi/skills/package-pi-permission-system/SKILL.md` — update the `makeResolver` description (`PermissionResolver` mock → `ScopedPermissionResolver` mock) and `makeGateInputs` (no longer stubs `resolve`).

## Test Impact Analysis

1. New unit tests enabled by the extraction: `test/permission-resolver.test.ts` exercises `resolve` (applies the session ruleset; defaults `agentName` to `undefined`; returns the manager's result; applies a recorded approval), and `checkPermission` / `getToolPermission` / `getConfigIssues` / `getPolicyCacheStamp` delegation — all by constructing `new PermissionResolver(fakeManager, new SessionRules())` with no session fixture.
   This is the headline win: the resolve role is now testable without `makeSession`.
2. Redundant tests: the `describe("resolve")` block in `test/permission-session.test.ts` (four cases) duplicates the new resolver tests once `resolve` moves off the session — removed in the same step that removes `session.resolve`.
3. Tests that must stay as-is: the session's `checkPermission` / `getToolPermission` / `getConfigIssues` / `getPolicyCacheStamp` delegation tests (the session keeps those methods until Step 8); the `AgentPrepHandler` / `SessionLifecycleHandler` tests (still depend on the session interfaces); the gate-factory and runner tests (still drive `resolve` through the narrow interface, now `ScopedPermissionResolver`).

## TDD Order

1. **Rename the narrow interface `PermissionResolver` → `ScopedPermissionResolver`** (refactor).
   Mechanical rename across `permission-resolver.ts` and every type-importer (`runner.ts`, `tool-call-gate-pipeline.ts`, `path.ts`, `bash-command.ts`, `bash-external-directory.ts`, `bash-path.ts`, `permission-session.ts` implements clause, `test/helpers/gate-fixtures.ts`, `test/handlers/gates/bash-external-directory.test.ts`, `test/handlers/gates/bash-path.test.ts`).
   No behavior change; the existing suite is the regression guard.
   Run `pnpm run check` after committing (a renamed export breaks all importers in one commit — this is the atomic rename step).
   Commit: `refactor: rename PermissionResolver interface to ScopedPermissionResolver (#340)`.

2. **Add the concrete `PermissionResolver` class; route `GateRunner` + `SkillInputGatePipeline` through it** (test + feat).
   Red→green: write `test/permission-resolver.test.ts` against the new class (resolve + four delegations), then implement the class in `permission-resolver.ts`.
   Construct `new PermissionResolver(permissionManager, sessionRules)` in `index.ts`; pass it as `GateRunner`'s first arg and as `SkillInputGatePipeline`'s constructor arg.
   `session.resolve` still exists and is still used by `ToolCallGatePipeline`, so the suite stays green.
   Commit: `feat: add PermissionResolver class and route gate runner through it (#340)`.

3. **Inject the resolver into `ToolCallGatePipeline`** (refactor + test).
   Narrow `ToolCallGateInputs` to the three query methods; add `resolver: ScopedPermissionResolver` as the first constructor param; route gate factories + tool resolve through `this.resolver`.
   Update `index.ts` (`new ToolCallGatePipeline(resolver, session, formatterRegistry)`), `makeGateInputs` (drop `resolve`), and `tool-call-gate-pipeline.test.ts` (pass a `makeResolver(...)` resolver; move the `resolve`-override case onto it).
   These land together because narrowing the interface and constructing the pipeline are type-coupled (single call site in `index.ts`).
   Commit: `refactor: inject resolver into ToolCallGatePipeline (#340)`.

4. **Remove the resolve role from `PermissionSession`** (refactor).
   With no remaining consumer of `session.resolve`, delete the method and the `ScopedPermissionResolver` implements clause (and its import); remove the now-redundant `describe("resolve")` block from `test/permission-session.test.ts`.
   Commit: `refactor: remove resolve role from PermissionSession (#340)`.

5. **Update architecture and skill docs** (docs).
   Update the `docs/architecture/architecture.md` module-structure entries (`permission-resolver.ts`, `permission-session.ts`, `runner.ts`) and decrement the role-interfaces metric (5 → 4); update the `makeResolver` / `makeGateInputs` descriptions in `.pi/skills/package-pi-permission-system/SKILL.md`.
   Commit: `docs: update architecture and skill for PermissionResolver extraction (#340)`.

## Risks and Mitigations

- Risk: the session and resolver hold different `PermissionManager` / `SessionRules` instances (split-brain).
  Mitigation: `index.ts` injects the same instances into both; neither reconstructs them.
  Verified by `test/composition-root.test.ts` (shared-instance contract).
- Risk: a missed `session.resolve` consumer breaks at runtime, not at type-check.
  Mitigation: grep confirms the only `resolve` callers are the gate factories, `GateRunner`, and `ToolCallGatePipeline`, all rewired before Step 4 removes the method; run the full suite (not just changed files) before each commit.
- Risk: narrowing `ToolCallGateInputs` (dropping `resolve`) silently leaves a stale `resolve` field in a fixture.
  Mitigation: update `makeGateInputs` and the pipeline test in the same step (Step 3); `pnpm run check` flags excess/missing properties.
- Risk: the interface rename misses an importer.
  Mitigation: dedicated rename step (Step 1) followed immediately by `pnpm run check`.

## Open Questions

- Step 8 ([#341]) removes the transitional `checkPermission` / `getToolPermission` / `getConfigIssues` / `getPolicyCacheStamp` from `PermissionSession`, rewires `AgentPrepHandler` / `SessionLifecycleHandler` to the resolver, and unwinds the fig-leaf interfaces.
  The exact disposition of `SkillPermissionChecker` (whether `AgentPrepHandler` passes the resolver to `resolveSkillPromptEntries`) is decided there, not here.

[#319]: https://github.com/gotgenes/pi-packages/issues/319
[#326]: https://github.com/gotgenes/pi-packages/issues/326
[#337]: https://github.com/gotgenes/pi-packages/issues/337
[#339]: https://github.com/gotgenes/pi-packages/issues/339
[#341]: https://github.com/gotgenes/pi-packages/issues/341
