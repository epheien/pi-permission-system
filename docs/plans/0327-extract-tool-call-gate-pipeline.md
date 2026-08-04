---
issue: 327
issue_title: "Extract a ToolCallGatePipeline collaborator that owns tool-call gate construction"
---

# Extract a ToolCallGatePipeline collaborator

## Problem Statement

`PermissionGateHandler.handleToolCall` builds six gate producers inline.
To do so it pulls a cluster of anemic getters off the session — `getActiveSkillEntries()`, `getInfrastructureDirs()` + `getInfrastructureReadPaths()` (concatenated by hand), and `config` (to compute `resolveToolPreviewLimits`) — then assembles the gates itself.
This is "ask for the ingredients, then assemble": gate-construction work that currently has no owner.

Issue [#319] deliberately rejected a single session-implemented "context" interface because that "would just re-expose the session (glomming state)."
The anemic getters are the same smell from the other direction: the missing piece is not a wider session interface but a collaborator that owns gate construction and depends on narrow inputs.

## Goals

- Introduce a `ToolCallGatePipeline` collaborator that owns the ordered tool-call gate-producer assembly and exposes an `evaluate(...)` seam.
- Construct the pipeline in the composition root (`index.ts`) and inject it into `PermissionGateHandler` — not construct it inside the handler.
- Apply Tell-Don't-Ask narrowings on `PermissionSession` so the pipeline reads clean values, not raw config: `getToolPreviewLimits()` and `getInfrastructureReadDirs()`.
- Remove the now-unused `getInfrastructureDirs()` / `getInfrastructureReadPaths()` getters.
- Shrink `handleToolCall`'s direct session reaches to context/identity operations (`activate`, `resolveAgentName`), setting up [#325].
- Behavior-preserving: no change to any permission decision, log entry, or emitted event.

## Non-Goals

- Retyping the `PermissionGateHandler` constructor against narrow role interfaces and dropping the `as unknown as PermissionSession` casts — that is [#325], which #327 prepares for.
- Relocating the existing `new GateRunner(...)` / `new GateDecisionReporter(...)` construction out of the handler constructor — that is the explicit scope of [#320] (composition root) and [#325] (inject the pre-built reporter).
  This plan injects the *new* collaborator properly from the start but leaves the pre-existing internal construction for its owning issues.
- Deleting the handler integration tests that now overlap with the new pipeline unit tests — deferred to [#321] (shared test-fixture extraction).
- Unifying `handleInput` with the runner pipeline — that is [#326], already landed.

## Background

Relevant modules:

- `src/handlers/permission-gate-handler.ts` — `PermissionGateHandler`; `handleToolCall` assembles the six gate producers and loops them through `this.runner.run(...)`.
  Constructor is `(session, events, toolRegistry, customFormatters?)`; it builds `GateDecisionReporter` and `GateRunner` internally and holds `customFormatters` only to construct the `ToolPreviewFormatter`.
- `src/handlers/gates/runner.ts` — `GateRunner.run(gate, agentName, toolCallId)` dispatches null / bypass / descriptor; reused per gate ([#323]).
- `src/handlers/gates/types.ts` — `ToolCallContext`, `GateOutcome`.
- `src/handlers/gates/*.ts` — the pure descriptor factories the producers call (`describeSkillReadGate`, `describePathGate`, `describeExternalDirectoryGate`, `describeBashExternalDirectoryGate`, `describeBashPathGate`, `describeToolGate`, `resolveBashCommandCheck`) plus `BashProgram` ([#308]).
- `src/permission-session.ts` — `PermissionSession`; owns `resolve` (`PermissionResolver`), `getActiveSkillEntries()`, `getInfrastructureDirs()`/`getInfrastructureReadPaths()`, and the `config` getter.
- `src/tool-preview-formatter.ts` — `ToolPreviewFormatter`, `ToolPreviewFormatterOptions`, `resolveToolPreviewLimits(config)` ([#266]).
- `src/index.ts` — composition root; constructs the session, reporter inputs, and `PermissionGateHandler`.

Constraints from AGENTS.md and the `code-design` skill:

- Default to dependency injection for non-trivial collaborators; accept them as parameters rather than constructing them internally.
- Use a narrow interface type for an injected collaborator, not the concrete class (avoids forcing `as unknown as` casts in test mocks).
- `@typescript-eslint/require-await` is enabled for `src/` — keep `evaluate` genuinely `async` (it awaits `BashProgram.parse` and `runner.run`).
- The pipeline lives under `src/handlers/gates/` (a Pi SDK / event-handler consumer layer), so importing the gate factories and `ToolPreviewFormatter` is fine.

## Design Overview

### New collaborator: `ToolCallGatePipeline`

A class in `src/handlers/gates/tool-call-gate-pipeline.ts` that owns the ordered gate-producer assembly and the run loop.
It depends on a narrow `ToolCallGateInputs` interface (extending `PermissionResolver`) plus optional custom formatters — never the concrete `PermissionSession`.

```typescript
export interface ToolCallGateInputs extends PermissionResolver {
  getActiveSkillEntries(): SkillPromptEntry[];
  getInfrastructureReadDirs(): string[];
  getToolPreviewLimits(): ToolPreviewFormatterOptions;
}

export class ToolCallGatePipeline {
  constructor(
    private readonly inputs: ToolCallGateInputs,
    private readonly customFormatters?: ToolInputFormatterLookup,
  ) {}

  async evaluate(
    tcc: ToolCallContext,
    runner: GateRunner,
  ): Promise<GateOutcome> {
    // owns: bash-command extraction + single BashProgram.parse,
    // formatter construction from getToolPreviewLimits(),
    // infraDirs from getInfrastructureReadDirs(),
    // the six gate producers, and the run loop returning the first block.
  }
}
```

`PermissionSession` already supplies `resolve` and `getActiveSkillEntries()`; the two new methods (below) complete the contract.
The session is **not** declared `implements ToolCallGateInputs` — the structural check happens at the construction call site (`new ToolCallGatePipeline(session, ...)`), which keeps the domain module `permission-session.ts` free of an upward import from the handler layer.

### Why the pipeline owns the bash parse (settled in planning)

The issue flagged the seam shape as open ("most likely `evaluate(tcc, bashProgram, runner)`").
Decision: the pipeline owns the bash-command extraction and the single `BashProgram.parse` — the seam is `evaluate(tcc, runner)`.
The bash command string and `BashProgram` are purely tool-call gate-construction inputs (`handleInput` never needs them), so moving the parse into the pipeline is the strongest realization of "the handler tells the pipeline to evaluate a tool call."

### Why the runner is passed per-call, not injected into the pipeline

`GateRunner` is shared: `handleInput` calls `this.runner.run(...)` directly, and `handleToolCall` delegates to the pipeline.
The handler keeps the runner as its member (constructed in its constructor today; relocation is [#320]'s job) and passes it to `evaluate`.
This avoids dual ownership and avoids pulling runner construction out of the handler — out of scope for #327.

### Dependency-injection wiring

The pipeline is constructed in `index.ts` and injected into the handler:

```typescript
// index.ts
const toolCallGatePipeline = new ToolCallGatePipeline(session, formatterRegistry);
const gates = new PermissionGateHandler(
  session,
  pi.events,
  toolRegistry,
  toolCallGatePipeline,
);
```

```typescript
// PermissionGateHandler
constructor(
  private readonly session: PermissionSession,
  events: PermissionEventBus,
  private readonly toolRegistry: ToolRegistry,
  private readonly pipeline: ToolCallGatePipeline,
) {
  this.reporter = new GateDecisionReporter(session.logger, events);
  this.runner = new GateRunner(session, session, session, this.reporter);
}
```

The handler drops its `customFormatters` constructor parameter (the pipeline owns the formatter now).
`handleToolCall` shrinks to: activate → validate tool → resolve agent name → build `tcc` → `await this.pipeline.evaluate(tcc, this.runner)` → map the outcome.

### Tell-Don't-Ask narrowings on `PermissionSession`

```typescript
getToolPreviewLimits(): ToolPreviewFormatterOptions {
  return resolveToolPreviewLimits(this.config);
}

getInfrastructureReadDirs(): string[] {
  return [
    ...this.paths.piInfrastructureDirs,
    ...(this.config.piInfrastructureReadPaths ?? []),
  ];
}
```

`getInfrastructureReadDirs()` replaces the two-method reach plus the handler's hand-rolled concat (`[...getInfrastructureDirs(), ...getInfrastructureReadPaths()]`).
`getToolPreviewLimits()` replaces the handler's `resolveToolPreviewLimits(session.config)` reach.
The `config` getter stays — `getToolPreviewLimits` / `getInfrastructureReadDirs` read it internally, and `index.ts` still consumes config elsewhere.

### Consumer call-site sketch (Tell-Don't-Ask check)

```typescript
// handleToolCall residual — a single tell, no gate-construction reach-through
const tcc: ToolCallContext = { toolName, agentName, input, toolCallId, cwd: ctx.cwd };
const outcome = await this.pipeline.evaluate(tcc, this.runner);
return outcome.action === "block" ? { block: true, reason: outcome.reason } : {};
```

The handler no longer reads `getActiveSkillEntries`, `getInfrastructureDirs`, `getInfrastructureReadPaths`, or `config` in `handleToolCall`; the pipeline owns those reads through the narrow interface.

### Edge cases (all behavior-preserving)

- Non-bash tools: `command`/`bashProgram` are `null`; the three bash gates short-circuit exactly as today.
- Bash with an empty command: same `null` `BashProgram`, same fallback to the whole-input check.
- Parse-once invariant: `BashProgram.parse` runs at most once per `evaluate`, shared across the three bash gates and the tool gate ([#308]) — now enforced inside the pipeline.
- Infra read bypass: driven by `getInfrastructureReadDirs()` returning the combined list, identical to the prior concat.

## Module-Level Changes

| File                                                     | Change                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/handlers/gates/tool-call-gate-pipeline.ts`          | **New.** `ToolCallGateInputs` interface + `ToolCallGatePipeline` class; owns bash parse, formatter, infra dirs, the six producers, and the run loop.                                                                                                                                                                                                                                      |
| `src/permission-session.ts`                              | Add `getToolPreviewLimits()` and `getInfrastructureReadDirs()`; import `resolveToolPreviewLimits` + `ToolPreviewFormatterOptions`. Later remove `getInfrastructureDirs()` / `getInfrastructureReadPaths()`.                                                                                                                                                                               |
| `src/handlers/permission-gate-handler.ts`                | Add injected `pipeline` constructor param; drop `customFormatters` param. Remove inline gate-producer assembly, formatter construction, `infraDirs` concat, bash parse, and the now-unused imports (`resolveToolPreviewLimits`, `ToolPreviewFormatter`, `getNonEmptyString`, `BashProgram`, the six gate factories, `resolveBashCommandCheck`, `GateResult`). `handleInput` is unchanged. |
| `src/index.ts`                                           | Construct `ToolCallGatePipeline` and pass it to `PermissionGateHandler` in place of `formatterRegistry`.                                                                                                                                                                                                                                                                                  |
| `test/helpers/gate-fixtures.ts`                          | Add `makeGateInputs` (mock of `ToolCallGateInputs`).                                                                                                                                                                                                                                                                                                                                      |
| `test/handlers/gates/tool-call-gate-pipeline.test.ts`    | **New.** Pipeline unit tests.                                                                                                                                                                                                                                                                                                                                                             |
| `test/helpers/handler-fixtures.ts`                       | `makeHandler` builds a real `ToolCallGatePipeline` from the mocked session and injects it. `makeSession` adds `getToolPreviewLimits` + `getInfrastructureReadDirs` mocks and drops the two old infra getters.                                                                                                                                                                             |
| `test/handlers/tool-call-events.test.ts`                 | Rename the `getInfrastructureDirs` override to `getInfrastructureReadDirs`.                                                                                                                                                                                                                                                                                                               |
| `test/handlers/external-directory-integration.test.ts`   | Replace the `getInfrastructureDirs` / `getInfrastructureReadPaths` mocks with `getInfrastructureReadDirs`.                                                                                                                                                                                                                                                                                |
| `test/handlers/external-directory-session-dedup.test.ts` | Same mock rename as above.                                                                                                                                                                                                                                                                                                                                                                |
| `test/permission-session.test.ts`                        | Replace the `getInfrastructureDirs` / `getInfrastructureReadPaths` unit tests with a `getInfrastructureReadDirs` test; add a `getToolPreviewLimits` test.                                                                                                                                                                                                                                 |
| `test/composition-root.test.ts`                          | Verify wiring is unchanged after the `index.ts` injection (handler registration, shared instances). Update only if it asserts the handler's constructor arity.                                                                                                                                                                                                                            |
| `docs/architecture/architecture.md`                      | Add `tool-call-gate-pipeline.ts` to the module tree; refresh the `permission-gate-handler.ts` description; note roadmap step 10.                                                                                                                                                                                                                                                          |
| `.pi/skills/package-pi-permission-system/SKILL.md`       | Document `makeGateInputs` in the `gate-fixtures.ts` inventory.                                                                                                                                                                                                                                                                                                                            |

## Test Impact Analysis

New unit tests the extraction enables (previously only reachable through the full `handleToolCall` path):

- `tool-call-gate-pipeline.test.ts` — the pipeline in isolation: runs the six gates in order, short-circuits on the first block, returns `{ action: "allow" }` when all pass, parses the bash command at most once, builds the formatter from `getToolPreviewLimits()`, and uses `getInfrastructureReadDirs()` for the external-directory gate.
  Uses `makeGateInputs` (cast-free mock) + `makeGateRunner` (real runner with role mocks).

Existing tests that become partially redundant but stay (behavior-preserving issue; removal deferred to [#321]):

- `tool-call.test.ts`, `tool-call-events.test.ts` — exercise the gate flow through `handleToolCall`; they remain valid integration coverage and still pass after the refactor (with the mock renames above).
  They now overlap with the pipeline unit tests; flag as [#321] simplification candidates, do not delete here.

Existing tests that must stay as-is (genuinely exercise the layer):

- `external-directory-integration.test.ts`, `external-directory-session-dedup.test.ts` — drive infra-read bypass and session-dedup through the full handler; the mock renames are mechanical and the assertions are unchanged.
- `permission-session.test.ts` — the new `getInfrastructureReadDirs` / `getToolPreviewLimits` cases replace the old infra-getter cases; `resolve` and skill-entry tests are untouched.

## TDD Order

1. **Add the Tell-Don't-Ask session methods.**
   Add `getToolPreviewLimits()` and `getInfrastructureReadDirs()` to `PermissionSession` alongside the existing getters; cover both in `permission-session.test.ts` (combined infra list; preview limits resolved from config).
   Run `pnpm run check`.
   Commit: `feat: add getToolPreviewLimits and getInfrastructureReadDirs to PermissionSession (#327)`.

2. **Introduce the pipeline.**
   Add `ToolCallGateInputs` + `ToolCallGatePipeline` in the new module and `makeGateInputs` in `gate-fixtures.ts`; write `tool-call-gate-pipeline.test.ts` (gate order, first-block short-circuit, all-allow, parse-once, formatter/infra-dir sourcing).
   The pipeline is not yet wired into the handler.
   Run `pnpm run check`.
   Commit: `feat: introduce ToolCallGatePipeline collaborator (#327)`.

3. **Inject the pipeline and delegate.**
   Change the `PermissionGateHandler` constructor to accept the injected `pipeline` and drop `customFormatters`; replace the inline gate assembly in `handleToolCall` with `await this.pipeline.evaluate(tcc, this.runner)` and remove the now-unused imports.
   Construct the pipeline in `index.ts` and pass it.
   Update both `new PermissionGateHandler(...)` call sites (`index.ts`, `makeHandler`) in this same commit — the constructor-arity change forces it.
   Update `makeSession` and the local session mocks in `tool-call-events.test.ts` / `external-directory-*.test.ts` to the new method names.
   Verify `composition-root.test.ts`.
   Run the full suite (`pnpm --filter @gotgenes/pi-permission-system exec vitest run`) and `pnpm run check`.
   Commit: `refactor: delegate tool-call gate construction to injected ToolCallGatePipeline (#327)`.

4. **Remove the dead infra getters.**
   Delete `getInfrastructureDirs()` / `getInfrastructureReadPaths()` from `PermissionSession` and their dedicated `permission-session.test.ts` cases (now covered by `getInfrastructureReadDirs`).
   Run `pnpm fallow dead-code` to confirm nothing else references them.
   Commit: `refactor: remove unused infrastructure-dir getters from PermissionSession (#327)`.

5. **Update docs.**
   Add `tool-call-gate-pipeline.ts` to the `architecture.md` module tree, refresh the `permission-gate-handler.ts` description, note roadmap step 10, and document `makeGateInputs` in the package SKILL.
   Commit: `docs: document ToolCallGatePipeline in architecture and package skill (#327)`.

## Risks and Mitigations

- **Session mocks missing the new methods → runtime `undefined`** (timing bugs the type checker won't catch, since `makeSession` casts to `PermissionSession`).
  Mitigation: step 3 updates every session mock on the handler/pipeline path and runs the full suite, not just the typecheck.
- **Behavior drift when the bash parse moves into the pipeline.**
  Mitigation: behavior-preserving extraction; the existing integration tests plus the new parse-once unit test pin the invariant.
- **Layer inversion if `permission-session.ts` imports the pipeline's interface.**
  Mitigation: no `implements` on the session; the structural check lives at the `new ToolCallGatePipeline(session, ...)` call site, so the domain module never imports from the handler layer.
- **`index.ts` wiring regression.**
  Mitigation: `composition-root.test.ts` (the `make-fake-pi.ts` harness) covers handler registration and shared-instance contracts.

## Open Questions

- Whether `ToolCallGateInputs` should fold into the role set [#325] introduces (and possibly be renamed there).
  Defer to [#325] — for #327 it is a narrow, pipeline-owned interface.
- Whether the redundant handler integration tests should be trimmed once the pipeline unit tests exist.
  Defer to [#321].

[#266]: https://github.com/gotgenes/pi-packages/issues/266
[#308]: https://github.com/gotgenes/pi-packages/issues/308
[#319]: https://github.com/gotgenes/pi-packages/issues/319
[#320]: https://github.com/gotgenes/pi-packages/issues/320
[#321]: https://github.com/gotgenes/pi-packages/issues/321
[#323]: https://github.com/gotgenes/pi-packages/issues/323
[#325]: https://github.com/gotgenes/pi-packages/issues/325
[#326]: https://github.com/gotgenes/pi-packages/issues/326
