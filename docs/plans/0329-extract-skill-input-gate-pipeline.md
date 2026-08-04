---
issue: 329
issue_title: "Extract a SkillInputGatePipeline for the handleInput skill-input gate"
---

# Extract a SkillInputGatePipeline

## Problem Statement

`PermissionGateHandler.handleInput` still hand-assembles the skill-input permission gate inline: a raw `checkPermission` pre-check, a deny notify, the `describeSkillInputGate` descriptor, a request-id mint, and the `runner.run(...)` call.
This is gate-construction work with no owner — the same shape `ToolCallGatePipeline.evaluate` already owns for the six tool-call gates ([#327]).
Because the assembly is inline, `handleInput` reaches the session for `checkPermission` and `createPermissionRequestId`, which is the only reason the handler's `GateHandlerSession` role still carries four members instead of the two-member context role (`activate` + `resolveAgentName`) both entry points actually share.

Extracting a `SkillInputGatePipeline` collaborator makes the `input` path symmetric with the `tool_call` path and lets `GateHandlerSession` shrink to its context role.

## Goals

- Introduce a `SkillInputGatePipeline` collaborator that owns the skill-input gate assembly (pre-check, deny notify, descriptor, request-id mint, run) and exposes an `evaluate(...)` seam.
- Construct the pipeline in the composition root (`index.ts`) and inject it into `PermissionGateHandler`.
- Reduce `handleInput` to `activate → resolveAgentName → extract skill name → pipeline.evaluate → map outcome`, symmetric with `handleToolCall`.
- Shrink `GateHandlerSession` to the two-method context role (`activate`, `resolveAgentName`); `checkPermission` and `createPermissionRequestId` leave the handler's session surface.
- Fold the request-id minting (formerly `PermissionSession.createPermissionRequestId`) into the pipeline and remove it from `PermissionSession` — this absorbs the scope of [#330], which can be closed when this lands.
- Behavior-preserving: the untagged skill-input deny notify, the raw-`checkPermission` (no-session-rules) semantics ([#326]), and the request-id format are all preserved.

## Non-Goals

- Retyping `AgentPrepHandler` / `SessionLifecycleHandler` against role interfaces — that is [#331].
- Reframing `index.ts` as collaborator injection — that is [#320]; this plan injects the *new* collaborator properly but leaves the surrounding factory shape alone.
- Trimming the `input*.test.ts` handler integration tests that now overlap with the new pipeline unit tests — deferred to [#321].
- Changing any permission decision, emitted event, log entry, or user-facing message text.

## Background

Relevant modules:

- `src/handlers/permission-gate-handler.ts` — `PermissionGateHandler`; `handleInput` hand-rolls the skill-input gate, while `handleToolCall` already delegates to the injected `ToolCallGatePipeline`.
  Constructor today is `(session: GateHandlerSession, toolRegistry, pipeline: ToolCallGatePipeline, runner: GateRunner)`.
- `src/gate-handler-session.ts` — `GateHandlerSession`, the four-method role the handler's `session` is typed against (`activate`, `resolveAgentName`, `checkPermission`, `createPermissionRequestId`); its own doc comment flags [#329] as the issue that shrinks it.
- `src/handlers/gates/skill-input.ts` — `describeSkillInputGate(skillName, agentName, preCheck)`, the pure descriptor factory ([#326]); the pipeline imports it unchanged.
- `src/handlers/gates/tool-call-gate-pipeline.ts` — `ToolCallGatePipeline` + `ToolCallGateInputs`; the structural model this plan mirrors.
- `src/handlers/gates/runner.ts` — `GateRunner.run(gate, agentName, toolCallId)`; reused per gate ([#323]).
- `src/handlers/gates/types.ts` — `GateOutcome` (`{ action: "allow" } | { action: "block"; reason }`).
- `src/permission-session.ts` — `PermissionSession`; owns `checkPermission` and `createPermissionRequestId`, and `implements GateHandlerSession`.
- `src/index.ts` — composition root; constructs the session, `ToolCallGatePipeline`, `GateRunner`, and `PermissionGateHandler`.

Constraints from AGENTS.md and the `code-design` skill:

- Default to dependency injection for non-trivial collaborators; inject the new pipeline rather than constructing it in the handler.
- Use a narrow interface type for an injected collaborator, not the concrete `PermissionSession` (avoids `as unknown as` casts).
- `@typescript-eslint/require-await` is enabled for `src/`: `evaluate` has no `await` of its own (it returns `runner.run(...)`), so it must be a non-`async` function returning `Promise<GateOutcome>`, not an `async` function with no `await`.
- `createPermissionRequestId` reads `Date.now()` / `Math.random()` / `process.pid`; it is a handler-layer (SDK-consumer) helper, not a pure library util, so relocating it into the pipeline module is in keeping with the SDK-boundary rule.
- The pipeline lives under `src/handlers/gates/` (a handler/SDK-consumer layer), so importing the descriptor factory and SDK context types is fine.

## Design Overview

### New collaborator: `SkillInputGatePipeline`

A class in `src/handlers/gates/skill-input-gate-pipeline.ts` that owns the skill-input gate assembly and depends on a narrow `SkillInputGateInputs` interface — never the concrete `PermissionSession`.

```typescript
export interface SkillInputGateInputs {
  /** Raw permission check (no session rules) — preserves #326 skill-input semantics. */
  checkPermission(
    surface: string,
    input: unknown,
    agentName?: string,
  ): PermissionCheckResult;
}

/** Narrow UI seam: warn the user if an interactive UI is available, else no-op. */
export interface GateNotifier {
  warn(message: string): void;
}

export class SkillInputGatePipeline {
  constructor(private readonly inputs: SkillInputGateInputs) {}

  evaluate(
    skillName: string,
    agentName: string | null,
    notifier: GateNotifier,
    runner: GateRunner,
  ): Promise<GateOutcome> {
    const check = this.inputs.checkPermission(
      "skill",
      { name: skillName },
      agentName ?? undefined,
    );
    if (check.state === "deny") {
      notifier.warn(formatSkillDenyNotice(skillName, agentName));
    }
    return runner.run(
      describeSkillInputGate(skillName, agentName, check),
      agentName,
      createSkillInputRequestId(),
    );
  }
}
```

`PermissionSession` satisfies `SkillInputGateInputs` structurally at the construction call site (`new SkillInputGatePipeline(session)`); no `implements` clause is added, so the domain module never imports upward from the handler layer (same pattern `ToolCallGatePipeline` uses).

### Why the pipeline owns the request-id mint (absorbing #330)

The user-settled decision for this plan is to fold request-id generation into the pipeline now rather than deferring to [#330].
`createPermissionRequestId` touches zero session state — it is a misplaced utility on the session god-object whose sole caller is the skill-input assembly.
Folding it in means the pipeline mints its own id and `PermissionSession.createPermissionRequestId` is removed outright, so [#330] is satisfied by this issue and can be closed when this ships.

The minter relocates as a small module-level helper so its format/uniqueness tests have a direct target:

```typescript
/** Mint a unique id for a skill-input permission request. Format preserved from #330. */
export function createSkillInputRequestId(): string {
  return `skill-input-${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${process.pid}`;
}
```

The `prefix` parameter is dropped — the pipeline only ever minted `"skill-input"` ids.

### Why the runner is passed per-call, not injected into the pipeline

`GateRunner` is shared: the handler holds it and both `handleToolCall` (via `ToolCallGatePipeline`) and `handleInput` (via `SkillInputGatePipeline`) pass it to `evaluate`.
This mirrors `ToolCallGatePipeline.evaluate(tcc, runner)` exactly and avoids dual ownership of the runner.

### The notifier seam (Tell-Don't-Ask split)

The deny notify needs two facts: the permission decision (`deny`) and whether an interactive UI exists.
The pipeline owns the decision; the UI availability is per-event context.
Splitting them keeps the pipeline free of `ExtensionContext`: the pipeline *tells* the notifier to `warn`, and the notifier (built in the handler from `ctx`) decides whether a UI is present.

```typescript
// handleInput — builds the notifier from ctx, then tells the pipeline to evaluate
const notifier: GateNotifier = {
  warn: (message) => {
    if (ctx.hasUI) {
      ctx.ui.notify(message, "warning");
    }
  },
};
const outcome = await this.skillInputPipeline.evaluate(
  skillName,
  agentName,
  notifier,
  this.runner,
);
```

Net behavior is identical to today's `if (check.state === "deny" && ctx.hasUI) ctx.ui.notify(...)`: the pipeline calls `warn` only on deny; the notifier delivers only when `hasUI`.
The notify message stays untagged (no `[pi-permission-system]` prefix) — distinct from the gate deny reasons the runner routes through `formatDenyReason`:

```typescript
function formatSkillDenyNotice(skillName: string, agentName: string | null): string {
  return agentName
    ? `Skill '${skillName}' is not permitted for agent '${agentName}'.`
    : `Skill '${skillName}' is not permitted by the current skill policy.`;
}
```

### `handleInput` after the change

```typescript
async handleInput(
  event: InputPayload,
  ctx: ExtensionContext,
): Promise<InputEventResult> {
  this.session.activate(ctx);
  const skillName = extractSkillNameFromInput(event.text);
  if (!skillName) {
    return { action: "continue" };
  }
  const agentName = this.session.resolveAgentName(ctx);
  const notifier: GateNotifier = {
    warn: (message) => {
      if (ctx.hasUI) {
        ctx.ui.notify(message, "warning");
      }
    },
  };
  const outcome = await this.skillInputPipeline.evaluate(
    skillName,
    agentName,
    notifier,
    this.runner,
  );
  return outcome.action === "block"
    ? { action: "handled" }
    : { action: "continue" };
}
```

The handler no longer calls `session.checkPermission`, `session.createPermissionRequestId`, or imports `describeSkillInputGate`.

### `GateHandlerSession` shrinks to the context role

```typescript
export interface GateHandlerSession {
  activate(ctx: ExtensionContext): void;
  resolveAgentName(ctx: ExtensionContext): string | null;
}
```

`checkPermission` and `createPermissionRequestId` are removed; the `PermissionCheckResult` import in `gate-handler-session.ts` goes with them.
`PermissionSession implements GateHandlerSession` still holds (it has both remaining methods); `checkPermission` stays on `PermissionSession` (used by `resolve` and structurally by `SkillInputGateInputs`), while `createPermissionRequestId` is removed entirely.

### Handler constructor

```typescript
constructor(
  private readonly session: GateHandlerSession,
  private readonly toolRegistry: ToolRegistry,
  private readonly pipeline: ToolCallGatePipeline,
  private readonly skillInputPipeline: SkillInputGatePipeline,
  private readonly runner: GateRunner,
) {}
```

The fifth collaborator sits at the dependency-width threshold; all five are distinct injected collaborators (not a relay bag), and grouping them is [#320]'s concern — track and watch, do not address here.

### Composition-root wiring

```typescript
const skillInputGatePipeline = new SkillInputGatePipeline(session);
const gates = new PermissionGateHandler(
  session,
  toolRegistry,
  toolCallGatePipeline,
  skillInputGatePipeline,
  gateRunner,
);
```

### Edge cases (all behavior-preserving)

- Non-skill input: `extractSkillNameFromInput` returns `null`; `handleInput` returns `{ action: "continue" }` before the pipeline is touched — `checkPermission` is never called (the existing "does not check permissions for non-skill input" test still holds).
- Deny + no UI: pipeline calls `notifier.warn`; the notifier no-ops because `hasUI` is false — `ctx.ui.notify` is not called.
- Ask + no confirmation: handled inside `runner.run` exactly as today (`confirmation_unavailable`).
- Request-id format/uniqueness: preserved by `createSkillInputRequestId`.

## Module-Level Changes

| File                                                     | Change                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/handlers/gates/skill-input-gate-pipeline.ts`        | **New.** `SkillInputGateInputs` + `GateNotifier` interfaces, `SkillInputGatePipeline` class, and the `createSkillInputRequestId` + `formatSkillDenyNotice` helpers.                                                                                                                                                                                          |
| `src/handlers/permission-gate-handler.ts`                | Add injected `skillInputPipeline` constructor param. Rewrite `handleInput` to build the notifier and delegate to `pipeline.evaluate`. Remove the inline `checkPermission` / notify / `describeSkillInputGate` / `createPermissionRequestId` block and the now-unused `describeSkillInputGate` import; add `GateNotifier` + `SkillInputGatePipeline` imports. |
| `src/gate-handler-session.ts`                            | Shrink `GateHandlerSession` to `activate` + `resolveAgentName`; remove `checkPermission`, `createPermissionRequestId`, the `PermissionCheckResult` import, and refresh the doc comment (drop the "transitional" note).                                                                                                                                       |
| `src/permission-session.ts`                              | Remove the `createPermissionRequestId` method; drop any import left unused by its removal. `checkPermission` stays.                                                                                                                                                                                                                                          |
| `src/index.ts`                                           | Construct `SkillInputGatePipeline` and inject it into `PermissionGateHandler` (fifth arg).                                                                                                                                                                                                                                                                   |
| `test/helpers/handler-fixtures.ts`                       | `MockGateHandlerSession` and `makeSession` drop `createPermissionRequestId`. `makeHandler` builds a real `SkillInputGatePipeline(session)` and injects it.                                                                                                                                                                                                   |
| `test/helpers/gate-fixtures.ts`                          | Add `makeSkillInputInputs` (mock of `SkillInputGateInputs`) and `makeNotifier` (`GateNotifier` mock with a `warn` `vi.fn()`).                                                                                                                                                                                                                                |
| `test/handlers/gates/skill-input-gate-pipeline.test.ts`  | **New.** Pipeline unit tests.                                                                                                                                                                                                                                                                                                                                |
| `test/handlers/external-directory-integration.test.ts`   | Local `makeHandler` constructs + injects `SkillInputGatePipeline`; local session mock drops `createPermissionRequestId`.                                                                                                                                                                                                                                     |
| `test/handlers/external-directory-session-dedup.test.ts` | Same construction + mock update as above.                                                                                                                                                                                                                                                                                                                    |
| `test/permission-session.test.ts`                        | Remove the `createPermissionRequestId` describe block (behavior relocated to the pipeline).                                                                                                                                                                                                                                                                  |
| `test/composition-root.test.ts`                          | Verify handler registration / shared-instance wiring is unchanged; update only if it asserts the handler's constructor arity.                                                                                                                                                                                                                                |
| `docs/architecture/architecture.md`                      | Add `skill-input-gate-pipeline.ts` to the module tree; refresh the `gate-handler-session.ts` (now two-method) and `permission-gate-handler.ts` (fifth collaborator) descriptions; remove `createPermissionRequestId` from the `permission-session.ts` description; mark Step 12 done and note Step 13 ([#330]) folded into Step 12.                          |
| `.pi/skills/package-pi-permission-system/SKILL.md`       | Document `makeSkillInputInputs` + `makeNotifier` in the `gate-fixtures.ts` inventory.                                                                                                                                                                                                                                                                        |

Grep confirmation (every removed symbol): `createPermissionRequestId` appears only in `gate-handler-session.ts`, `permission-session.ts`, `permission-gate-handler.ts`, `permission-session.test.ts`, the two `external-directory-*.test.ts` local mocks, and `handler-fixtures.ts` — all listed above.

## Test Impact Analysis

New unit tests the extraction enables (previously only reachable through the full `handleInput` path):

- `skill-input-gate-pipeline.test.ts` — the pipeline in isolation:
  - deny → `notifier.warn` called with a message containing the skill name, and `describeSkillInputGate` run with the `preCheck`;
  - allow / ask → `notifier.warn` not called; outcome maps from `runner.run`;
  - block outcome → `{ action: "block" }`; allow outcome → `{ action: "allow" }`;
  - `createSkillInputRequestId` format (`startsWith("skill-input-")`) and uniqueness across calls (relocated from `permission-session.test.ts`).
  - Uses `makeSkillInputInputs` (cast-free single-method mock) + `makeGateRunner` (real runner with role mocks) + `makeNotifier`.

Existing tests that become partially redundant but stay (behavior-preserving; trimming deferred to [#321]):

- `input.test.ts`, `input-events.test.ts` — exercise the skill-input flow through `handleInput`; they remain valid integration coverage and still pass through the real handler → pipeline → notifier path after the `makeSession` mock update.
  They now overlap with the pipeline unit tests; flag as [#321] candidates, do not delete here.

Existing tests that must stay as-is (genuinely exercise their layer):

- `external-directory-integration.test.ts`, `external-directory-session-dedup.test.ts` — drive the tool-call path; the constructor-arity + mock edits are mechanical, the assertions unchanged.
- `permission-session.test.ts` — only the `createPermissionRequestId` block moves; `checkPermission`, `resolve`, and the rest are untouched.

## TDD Order

1. **Introduce the pipeline.**
   Add `SkillInputGateInputs` + `GateNotifier` + `SkillInputGatePipeline` + `createSkillInputRequestId` + `formatSkillDenyNotice` in the new module, plus `makeSkillInputInputs` and `makeNotifier` in `gate-fixtures.ts`.
   Write `skill-input-gate-pipeline.test.ts` (deny-notify, allow/ask no-notify, block/allow mapping, request-id format + uniqueness).
   The pipeline is not yet wired into the handler.
   Run `pnpm run check`.
   Commit: `feat: introduce SkillInputGatePipeline collaborator (#329)`.

2. **Inject the pipeline, rewrite `handleInput`, and remove the request-id minter.**
   This is one commit because the constructor-arity change and the `GateHandlerSession` / `PermissionSession` shrink break every call site and the `createPermissionRequestId` consumers at the type level simultaneously:
   - add the injected `skillInputPipeline` param to `PermissionGateHandler`; rewrite `handleInput` to build the notifier and delegate; drop the `describeSkillInputGate` import;
   - shrink `GateHandlerSession` to `activate` + `resolveAgentName`; remove `PermissionSession.createPermissionRequestId`;
   - construct + inject `SkillInputGatePipeline` in `index.ts`;
   - update `makeHandler` / `makeSession` / `MockGateHandlerSession` and the two `external-directory-*.test.ts` local `makeHandler` + session mocks (construct the pipeline, drop `createPermissionRequestId`);
   - remove the `createPermissionRequestId` describe block from `permission-session.test.ts`.
   Verify `composition-root.test.ts`.
   Run the full suite (`pnpm --filter @gotgenes/pi-permission-system exec vitest run`), `pnpm run check`, and `pnpm fallow dead-code` (confirm `createPermissionRequestId` and the old inline assembly are gone).
   Commit: `refactor: delegate skill-input gate construction to injected SkillInputGatePipeline (#329, #330)`.

3. **Update docs.**
   Add `skill-input-gate-pipeline.ts` to the `architecture.md` module tree; refresh the `gate-handler-session.ts`, `permission-gate-handler.ts`, and `permission-session.ts` descriptions; mark roadmap Step 12 done and note Step 13 ([#330]) folded in; document `makeSkillInputInputs` + `makeNotifier` in the package SKILL.
   Commit: `docs: document SkillInputGatePipeline in architecture and package skill (#329)`.

## Risks and Mitigations

- **Session mocks missing the new shape → runtime surprise.**
  `MockGateHandlerSession` casts away from the concrete class, so a dropped field can pass typecheck but fail at runtime.
  Mitigation: step 2 updates every session mock on the handler path and runs the full suite, not just the typecheck.
- **Notify behavior drift when the `hasUI` gate moves into the notifier closure.**
  Mitigation: the deny/no-deny and UI-present/absent cases are pinned by the existing `input.test.ts` notify tests (unchanged) plus the new pipeline `notifier.warn` unit assertions.
- **Request-id format regression when the minter relocates.**
  Mitigation: the format + uniqueness tests move to the pipeline unit test against `createSkillInputRequestId`; the expression is copied verbatim.
- **Closing [#330] prematurely.**
  Mitigation: the plan removes `createPermissionRequestId` outright and `pnpm fallow dead-code` confirms no residual caller; [#330] is closed only after this ships.
- **`index.ts` wiring regression.**
  Mitigation: `composition-root.test.ts` (the `make-fake-pi.ts` harness) covers handler registration and shared-instance contracts.

## Open Questions

- Whether the handler's five injected collaborators should be grouped — deferred to [#320] (composition-root reframe); track and watch.
- Whether the `input*.test.ts` integration tests should be trimmed once the pipeline unit tests exist — deferred to [#321].

[#320]: https://github.com/gotgenes/pi-packages/issues/320
[#321]: https://github.com/gotgenes/pi-packages/issues/321
[#323]: https://github.com/gotgenes/pi-packages/issues/323
[#326]: https://github.com/gotgenes/pi-packages/issues/326
[#327]: https://github.com/gotgenes/pi-packages/issues/327
[#330]: https://github.com/gotgenes/pi-packages/issues/330
[#331]: https://github.com/gotgenes/pi-packages/issues/331
