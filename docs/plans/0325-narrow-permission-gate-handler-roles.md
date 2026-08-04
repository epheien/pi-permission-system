---
issue: 325
issue_title: "Depend on session role interfaces in PermissionGateHandler, not the concrete PermissionSession class"
---

# Depend on session role interfaces in PermissionGateHandler

## Problem Statement

`PermissionGateHandler`'s constructor takes `session: PermissionSession` — the concrete class, with 36 public members and private fields — but the handler touches only a handful of them.
Because the parameter is a concrete class, every hand-rolled test mock must `as unknown as PermissionSession` to satisfy the type, which disables TypeScript's structural check.
A consumer that calls a session method the mock lacks then fails at runtime, not at `pnpm run check` — exactly what happened during [#319], where adding `resolve()` broke three session mocks with `resolver.resolve is not a function` instead of a compile error.

This issue retypes the handler against narrow role interfaces and drops the casts so mock completeness is enforced at type-check time.

## Goals

- Type the handler's `session` dependency against a narrow role interface, not the concrete `PermissionSession` class.
- Inject the pre-built `GateRunner` (constructed in the composition root) so the handler stops building collaborators in its constructor and stops reaching through `session.logger`.
- Drop the `events` constructor parameter — it exists only to build the reporter.
- Drop the `as unknown as PermissionSession` casts in `handler-fixtures.ts` `makeSession`, `external-directory-integration.test.ts`, and `external-directory-session-dedup.test.ts`.
- Behavior-preserving — no decision, event, or log output changes.

## Non-Goals

- Extracting the skill-input gate assembly out of `handleInput` — tracked in [#329]; this plan keeps that assembly inline and therefore keeps `checkPermission` + `createPermissionRequestId` on the handler's session role.
- Relocating `createPermissionRequestId` off `PermissionSession` — tracked in [#330].
- Narrowing `AgentPrepHandler` and `SessionLifecycleHandler` against role interfaces, or touching their local `makeSession` casts — tracked in [#331].
- Changing the skill-input pre-check from `checkPermission` (no session rules) to `resolve` (session rules) — a behavior change, deferred to [#329].
- Reframing `index.ts` as collaborator injection — that is Step 15 ([#320]); this plan only adds two construction sites that feed it.

## Background

Relevant modules and how they relate:

- `src/handlers/permission-gate-handler.ts` — the consumer being narrowed.
  Its constructor currently builds `this.reporter = new GateDecisionReporter(session.logger, events)` and `this.runner = new GateRunner(session, session, session, this.reporter)`, then `handleToolCall` / `handleInput` use `this.runner` and the injected `this.pipeline`.
- `src/permission-session.ts` — the concrete class.
  It already `implements PermissionResolver, SessionApprovalRecorder, GatePrompter`; this plan adds one more role to that list.
- `src/permission-resolver.ts`, `src/decision-reporter.ts`, `src/gate-prompter.ts`, `src/session-approval-recorder.ts` — the existing role interfaces from [#319], [#322], [#323], all in top-level `src/` and implemented by `PermissionSession`.
- `src/handlers/gates/runner.ts` (`GateRunner`) and `src/handlers/gates/tool-call-gate-pipeline.ts` (`ToolCallGatePipeline` + `ToolCallGateInputs`) — the collaborators the handler delegates to.
  `ToolCallGateInputs` is the precedent for a narrow, structurally-satisfied session view; it lives in the handler layer and `extends PermissionResolver`.
- `test/helpers/handler-fixtures.ts` — the shared `makeSession` / `makeHandler`, used **only** by `PermissionGateHandler` tests (`input*.test.ts`, `tool-call*.test.ts`).
  `before-agent-start.test.ts` and `lifecycle.test.ts` define their own local `makeSession` and import only `makeCtx`, so narrowing the shared fixture does not touch them.

After [#326] (skill-input unification) and [#327] (`ToolCallGatePipeline` extraction), the handler's residual `PermissionSession` surface is exactly four members: `activate`, `resolveAgentName`, `checkPermission`, `createPermissionRequestId`, plus the `logger` read in the constructor and the three roles passed to `GateRunner`.

Constraints from AGENTS.md and the package skill:

- Role interfaces that `PermissionSession` implements must live in top-level `src/` (a domain module cannot import from the `handlers/` layer without inverting the dependency).
- `pnpm fallow dead-code` must stay clean — the new interface must have a consumer in the same commit it is introduced.
- Adding to a barrel requires a real consumer; do not add speculative re-exports.

Design-review checklist (run before finalizing):

| Smell             | Location                          | Evidence                                          | Fix                                         |
| ----------------- | --------------------------------- | ------------------------------------------------- | ------------------------------------------- |
| Wide interface    | `PermissionGateHandler` ctor      | `session: PermissionSession` (36 members), uses 4 | Narrow `GateHandlerSession` role            |
| LoD reach-through | `permission-gate-handler.ts` ctor | `new GateDecisionReporter(session.logger, …)`     | Build reporter in `index.ts`; inject runner |
| Parameter relay   | `events` ctor param               | only relayed into the reporter                    | Drop `events`; reporter built upstream      |
| Test-mock depth   | 3 `makeSession` fixtures          | `as unknown as PermissionSession`                 | Type against the role intersection          |

## Design Overview

Introduce one narrow role interface and inject the runner so the handler depends on assembled collaborators, not a god-object.

### The role interface

```typescript
// src/gate-handler-session.ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PermissionCheckResult } from "./types";

/**
 * The session surface PermissionGateHandler invokes directly: bind the
 * per-event context, identify the agent, and (for the skill-input gate) run a
 * raw permission check and mint a request id.
 *
 * Transitional: #329 (SkillInputGatePipeline) absorbs the skill-input
 * assembly, after which checkPermission + createPermissionRequestId leave this
 * role and it collapses to a two-method context role.
 */
export interface GateHandlerSession {
  activate(ctx: ExtensionContext): void;
  resolveAgentName(ctx: ExtensionContext): string | null;
  checkPermission(
    surface: string,
    input: unknown,
    agentName?: string,
  ): PermissionCheckResult;
  createPermissionRequestId(prefix: string): string;
}
```

`PermissionSession` adds `GateHandlerSession` to its `implements` list — it already has all four methods (the class's four-argument `checkPermission` and two-argument `resolveAgentName` remain assignable to the narrower role signatures).

### Handler constructor

```typescript
export class PermissionGateHandler {
  constructor(
    private readonly session: GateHandlerSession,
    private readonly toolRegistry: ToolRegistry,
    private readonly pipeline: ToolCallGatePipeline,
    private readonly runner: GateRunner,
  ) {}
  // handleToolCall / handleInput bodies unchanged: they call
  // this.session.activate / resolveAgentName / checkPermission /
  // createPermissionRequestId, this.pipeline.evaluate, this.runner.run.
}
```

The `reporter` field, the `GateDecisionReporter` / `GateRunner` construction, and the `events` parameter are removed.

### Composition-root wiring (the call site)

The runner and reporter move to `index.ts`, where the real `PermissionSession` is in scope, so `session.logger` is a direct field read by the owner — not a reach-through by a downstream handler:

```typescript
const reporter = new GateDecisionReporter(session.logger, pi.events);
const gateRunner = new GateRunner(session, session, session, reporter);
const toolCallGatePipeline = new ToolCallGatePipeline(session, formatterRegistry);
const gates = new PermissionGateHandler(
  session,
  toolRegistry,
  toolCallGatePipeline,
  gateRunner,
);
```

This is Tell-Don't-Ask at the seam: the handler is told its runner; it no longer assembles one from session internals.

### Test-fixture return type

The shared `makeSession` (and the two integration-test mocks) build one object used as the pipeline input, the three runner roles, the reporter's logger source, and the handler's session role.
Its return type becomes the precise intersection — no cast — so a missing member fails `pnpm run check`:

```typescript
type MockGateHandlerSession = ToolCallGateInputs &
  SessionApprovalRecorder &
  GatePrompter &
  GateHandlerSession & {
    // logger source for the reporter the fixture builds
    logger: SessionLogger;
    // internal delegation helpers resolve/canConfirm/promptPermission read
    getSessionRuleset(): Rule[];
    canPrompt(ctx: ExtensionContext): boolean;
    prompt(
      ctx: ExtensionContext,
      details: PromptPermissionDetails,
    ): Promise<PermissionPromptDecision>;
  };
```

`ToolCallGateInputs` already `extends PermissionResolver`, so `resolve` is covered.
The two vestigial members the current mocks carry only to satisfy the concrete class — `getToolPermission` and `config` — are dropped (no consumer on the gate path reads them).

Edge case — fixture self-reference: the mock's `resolve` delegates to `checkPermission` + `getSessionRuleset`, and `canConfirm` / `promptPermission` delegate to `canPrompt` / `prompt`, so integration tests can drive outcomes through the production-named stubs.
Today this works because the delegations are assigned **after** the `as unknown as` cast.
Without the cast the object literal must satisfy the type at creation, so define the three delegations inline in the literal as closures that read the final `session` object at call time, then spread `...overrides` last (overrides win, and the closures pick up an overridden `checkPermission`).
This replaces the current `Object.hasOwn(overrides, …)` guards.

## Module-Level Changes

- `src/gate-handler-session.ts` — **new**: the `GateHandlerSession` interface.
- `src/permission-session.ts` — add `GateHandlerSession` to the `implements` list; import it.
  No method-body changes.
- `src/handlers/permission-gate-handler.ts` — constructor signature `(session: GateHandlerSession, toolRegistry, pipeline, runner)`; remove the `events` param, the `reporter` field, and the `GateDecisionReporter` / `GateRunner` construction.
  Imports: drop `GateDecisionReporter` + `DecisionReporter` (`#src/decision-reporter`), `PermissionEventBus` (`#src/permission-events`), and `PermissionSession`; add `GateHandlerSession` (`#src/gate-handler-session`); change `GateRunner` to a type-only import.
- `src/index.ts` — build `reporter` and `gateRunner`, pass `gateRunner` to the handler, drop the `pi.events` argument; add imports for `GateDecisionReporter` (`./decision-reporter`) and `GateRunner` (`./handlers/gates/runner`).
- `test/helpers/handler-fixtures.ts` — `makeSession` return type → `MockGateHandlerSession` (cast removed, `getToolPermission` + `config` dropped, delegations inlined); narrow the `overrides` key type from `keyof PermissionSession` to `MockGateHandlerSession`; `makeHandler` builds `reporter` + `runner` from the mock and passes the runner, dropping the `events` handler argument (still returns `events` for `getDecisionEvents`).
- `test/handlers/external-directory-integration.test.ts` — local `makeSession` retyped and cast dropped (same delegation restructuring); `makeHandler` builds reporter + runner.
- `test/handlers/external-directory-session-dedup.test.ts` — local `makeSession` retyped and cast dropped; `makeHandlerForSession` builds reporter + runner.
- `packages/pi-permission-system/docs/architecture/architecture.md` — module-structure listing (add `gate-handler-session.ts`; update the `permission-gate-handler.ts` and `permission-session.ts` descriptions) and Phase 3 Step 11 (record the runner injection + the new role, and the [#329] / [#330] / [#331] follow-ups).

Symbol-removal grep results (per AGENTS.md): the only `new PermissionGateHandler(...)` sites are `index.ts` and the three test fixtures above; `composition-root.test.ts` drives the handler through `pi.fire`, not its constructor, so it needs no change.
The package skill (`.pi/skills/package-pi-permission-system/SKILL.md`) names `makeSession` but not its type or the handler's constructor arity, so no skill edit is required.

## Test Impact Analysis

1. New tests enabled — the change is type-level; its payoff is compile-time enforcement (the `implements` clause plus the precise fixture intersection), not a new runtime test.
   Naming `GateHandlerSession` does make a future minimal four-method handler unit test possible, but the existing integration tests already cover the behavior, so none is added here.
2. Tests that become redundant — none.
   No assertion is duplicated or obviated.
3. Tests that must stay as-is — the gate-handler integration suites (`tool-call*.test.ts`, `input*.test.ts`, `external-directory-*.test.ts`) genuinely exercise the handler → pipeline → runner → reporter stack with a mocked session boundary.
   Only their fixture wiring changes (build/inject the runner; retype the mock); the assertions are untouched.

## TDD Order

This is a behavior-preserving refactor; the existing suite plus `pnpm run check` are the safety net, so the cycles are "change → green" rather than "new red test → green".

1. **Introduce the role, inject the runner, retype the handler** — add `src/gate-handler-session.ts`; add `implements GateHandlerSession` to `PermissionSession`; change the handler constructor (inject runner, drop `events`, drop in-constructor construction); update all four call sites (`index.ts` + the three test fixtures) in this commit, since the constructor signature change breaks them all at the type level.
   The mocks keep their `as unknown as PermissionSession` casts for now (a `PermissionSession` still satisfies the narrow role).
   Verify `pnpm run check` and the full package suite are green.
   Commit: `refactor: inject GateRunner and type PermissionGateHandler against GateHandlerSession (#325)`.
2. **Drop the casts** — retype the three `makeSession` mocks to the `MockGateHandlerSession` intersection, remove the casts, inline the delegations, drop the vestigial `getToolPermission` / `config` members, and narrow the `overrides` key type.
   `pnpm run check` now enforces mock completeness.
   Because `handler-fixtures.ts` is a shared helper, run the full package suite, not just one file.
   Commit: `refactor: drop as-unknown-as PermissionSession casts in handler mocks (#325)`.
3. **Document** — update the architecture module-structure listing and Phase 3 Step 11.
   Commit: `docs: record GateHandlerSession retyping in architecture (#325)`.

## Risks and Mitigations

- **Risk:** dropping a cast surfaces a missing mock member.
  **Mitigation:** that is the intended win — `pnpm run check` names the gap; the intersection type in the plan lists every required member so the mock is complete.
- **Risk:** the fixture delegation breaks if the self-referencing closures are restructured incorrectly, silently changing how `external-directory-session-dedup.test.ts` drives session-approval state.
  **Mitigation:** keep the closures reading the final `session` object at call time and spread `...overrides` last; run the full suite (the dedup test is the canary).
- **Risk:** injecting the runner perturbs `index.ts` wiring.
  **Mitigation:** `composition-root.test.ts` drives via `pi.fire` and asserts registration + behavior; keep it green.
- **Risk:** excess-property errors when removing the cast if a vestigial member lingers.
  **Mitigation:** drop `getToolPermission` and `config` from the mocks (unused on the gate path); the literal then matches the intersection exactly.

## Open Questions

- Should `GateHandlerSession` already split into a two-method `SessionContext` (`activate` + `resolveAgentName`) base that it `extends`?
  Deferred: a second consumer for `SessionContext` arrives only with [#329] / [#331], and introducing it now would be a speculative abstraction `fallow` could flag.
  This plan keeps a flat four-method role and lets [#329] shrink it.
- Should the skill-input pre-check apply session rules (`resolve`) rather than the raw `checkPermission`?
  It does not today; changing it is a behavior change recorded against [#329].

[#319]: https://github.com/gotgenes/pi-packages/issues/319
[#320]: https://github.com/gotgenes/pi-packages/issues/320
[#322]: https://github.com/gotgenes/pi-packages/issues/322
[#323]: https://github.com/gotgenes/pi-packages/issues/323
[#326]: https://github.com/gotgenes/pi-packages/issues/326
[#327]: https://github.com/gotgenes/pi-packages/issues/327
[#329]: https://github.com/gotgenes/pi-packages/issues/329
[#330]: https://github.com/gotgenes/pi-packages/issues/330
[#331]: https://github.com/gotgenes/pi-packages/issues/331
