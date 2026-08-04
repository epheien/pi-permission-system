---
issue: 320
issue_title: "Reframe the index.ts composition root as collaborator injection"
---

# Reframe the `index.ts` composition root as collaborator injection

## Problem Statement

`piPermissionSystemExtension` (`src/index.ts`, now 206 lines) is the package's #1 churn hotspot.
The issue frames the remaining factory work as "constructing collaborators and injecting them, not hand-rolling closures," once Tracks B and C have landed.
Those prerequisites — the `PermissionForwarder` (#315/#316/#317), `PermissionResolver` (#319), `DecisionReporter` (#322), `GateRunner` (#323), and the gate pipelines (#327/#329) — are all present in `main`, so the factory already injects those collaborators.

What is left in the factory is two genuinely anemic constructs that still hold behavior as inline literals/closures:

1. The `permissionsService` object literal (~18 lines) — three methods reaching into `runtime` and `formatterRegistry`, the in-process implementation of the cross-extension `PermissionsService` interface.
2. The service-publication lifecycle — an `activateServiceForSession` closure (the #302-critical "publish only when not a registered subagent child, then emit ready" gate) plus the teardown closure passed to `SessionLifecycleHandler` (unsubscribe RPC + subagent-lifecycle, then unpublish).

Both are behavior with no named home: testable only through the heavy `make-fake-pi.ts` composition-root harness.
The rest of the factory builds the package's established construction-time injection bags (`PermissionSessionRuntimeDeps`, `PermissionPrompterDeps`, `PermissionForwarderDeps`, command deps, RPC deps) — legitimate composition-root wiring, not closure-bag smell.

## Goals

- Promote the inline `permissionsService` literal to a named `LocalPermissionsService` class with a unit-testable home.
- Promote the two service-lifecycle closures to a named `PermissionServiceLifecycle` collaborator (implementing a narrow `ServiceLifecycle` interface) that owns the #302 child-gated publish, ready emission, and session-scoped teardown ordering.
- Inject the `ServiceLifecycle` collaborator into `SessionLifecycleHandler`, replacing its two `activateService` / `cleanupRpc` callback parameters with one narrow collaborator.
- Keep the change behavior-preserving: handler registration, the `session_start`-gated service publish, and the synchronous lifecycle subscription must behave identically (verified by `test/composition-root.test.ts`).
- Cool the `index.ts` hotspot by giving wiring a collaborator to touch instead of an inline literal/closure.

## Non-Goals

- Hitting the roadmap's "< 100 lines" target.
  The scope chosen here is collaborators-only (an [`ask_user`](#open-questions) decision): the two genuine extractions remove ~35–40 lines, landing `index.ts` near ~165–170 lines.
  Forcing it under 100 would require relocating the established injection-bag construction into `buildX()` helpers — pure statement relocation with no new collaborator, which AGENTS.md flags as procedure-splitting, not design improvement.
- Eliminating the `() => runtime.config` / `runtime.x.bind(runtime)` relay closures by retyping `PermissionPrompter` / `PermissionSession` / command / RPC consumers onto narrow `ExtensionRuntime` role interfaces (the deeper, multi-consumer Track-C-style option, explicitly declined).
- Changing any permission decision, log entry, ready event, or service-publication semantics.
- Touching the forwarder, prompter, session, command, or RPC deps bags — they stay constructed inline.

## Background

Current `src/index.ts` construction sites:

- `runtime = createExtensionRuntime()` — `ExtensionRuntime` (data: paths + mutable `SessionState` + `config` + log methods).
  `runtime.permissionManager` is typed mutable on `SessionState` but is **never reassigned on the runtime object** (verified: the only `.permissionManager =` writes are `this.permissionManager` inside `PermissionSession`, a different object); `runtime.sessionRules` is `readonly`.
- `forwardingDeps: PermissionForwarderDeps` → `forwarder = new PermissionForwarder(...)`.
- `prompter = new PermissionPrompter({ getConfig, writeReviewLog, events, forwarder })`.
- `session = new PermissionSession(runtime, logger, ForwardingManager, runtimeDeps)`.
- `registerPermissionSystemCommand(pi, { … })`.
- `rpcHandles = registerPermissionRpcHandlers(pi.events, { … })` → returns `{ unsubCheck, unsubPrompt }` (plain closures from `events.on`).
- `permissionsService: PermissionsService = { checkPermission, getToolPermission, registerToolInputFormatter }` — the literal to promote.
- `activateServiceForSession`, `unsubSubagentLifecycle = subscribeSubagentLifecycle(pi.events, subagentRegistry)`, and the teardown closure in `new SessionLifecycleHandler(session, activateServiceForSession, teardown)` — the lifecycle to promote.
- `toolRegistry` adapter and the `pi.on(...)` arrows — genuine SDK-boundary glue, kept as-is.

Relevant modules:

- `src/service.ts` — defines the `PermissionsService` interface (cross-extension, `Symbol.for()`-backed accessor) plus `publishPermissionsService` / `unpublishPermissionsService` / `getPermissionsService`.
  Stays the pure accessor + interface module.
- `src/permission-events.ts` — `emitReadyEvent(events: PermissionEventBus)`; `PermissionEventBus` interface.
- `src/subagent-context.ts` — `isRegisteredSubagentChild(ctx, registry)`.
- `src/subagent-lifecycle-events.ts` — `subscribeSubagentLifecycle(events, registry): () => void`.
- `src/input-normalizer.ts` — `buildInputForSurface(surface, value)` (pure).
- `src/handlers/lifecycle.ts` — `SessionLifecycleHandler(session, activateService, cleanupRpc)`; calls `activateService(ctx)` in `handleSessionStart` and `cleanupRpc()` in `handleSessionShutdown`.
- `src/permission-manager.ts` (`PermissionManager`), `src/session-rules.ts` (`SessionRules`), `src/tool-input-formatter-registry.ts` (`ToolInputFormatterRegistry`) — the service's collaborators.

Constraints from AGENTS.md / `code-design`:

- An extraction that only relocates statements without a new collaborator or moving behavior onto data is procedure-splitting — both extractions here introduce a named, testable collaborator, clearing that bar.
- When a shared interface references a collaborator, use a narrow interface type, not the concrete class (`SessionLifecycleHandler` depends on `ServiceLifecycle`, not `PermissionServiceLifecycle`).
- Lifecycle/wiring collaborators at the SDK boundary may import SDK types (`ExtensionContext`), like the existing handlers.
- Composition-root tests must `vi.stubEnv("PI_CODING_AGENT_DIR", …)` and clear both `Symbol.for()` slots in `afterEach`.

### Design-review checklist (run before finalizing)

| Check                | Finding                                                                                                                                                                                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dependency width     | `LocalPermissionsService` — 3 deps, all used. `PermissionServiceLifecycle` — 4 deps, all used (`subscriptions` is a `() => void[]` data array, not a bag). `SessionLifecycleHandler` narrows from two callbacks to one 2-method interface. |
| Law of Demeter       | The service talks only to its own injected fields (`this.permissionManager`, `this.sessionRules`, `this.formatterRegistry`) — no reach-through. The composition root grabbing `runtime.permissionManager` to inject is normal wiring.      |
| Output arguments     | None.                                                                                                                                                                                                                                      |
| Scattered resets     | None.                                                                                                                                                                                                                                      |
| Parameter relay      | `SessionLifecycleHandler`'s two relayed callbacks collapse to one collaborator — relay reduced.                                                                                                                                            |
| Test mock depth      | New collaborators unit-tested with plain mocks; `lifecycle.test.ts` mock simplifies to `{ activate, teardown }`. No `as unknown as`.                                                                                                       |
| Missing abstractions | The two anemic literals/closures become named classes — this is the fix.                                                                                                                                                                   |

Verdict: both extractions are genuine (named, testable homes; narrower handler coupling) and inline to this change.

## Design Overview

### `LocalPermissionsService`

The in-process implementation of `PermissionsService`, injected with the three collaborators it delegates to.
`runtime.permissionManager` and `runtime.sessionRules` are injected as instances (verified stable: the manager is never reassigned on the runtime, `sessionRules` is `readonly`), so the class talks only to its own fields — no reach-through:

```typescript
// src/permissions-service.ts (new)
import { buildInputForSurface } from "./input-normalizer";
import type { PermissionManager } from "./permission-manager";
import type { PermissionsService } from "./service";
import type { SessionRules } from "./session-rules";
import type {
  ToolInputFormatter,
  ToolInputFormatterRegistry,
} from "./tool-input-formatter-registry";

/** In-process implementation of the cross-extension PermissionsService. */
export class LocalPermissionsService implements PermissionsService {
  constructor(
    private readonly permissionManager: PermissionManager,
    private readonly sessionRules: SessionRules,
    private readonly formatterRegistry: ToolInputFormatterRegistry,
  ) {}

  checkPermission(surface: string, value?: string, agentName?: string) {
    const input = buildInputForSurface(surface, value);
    return this.permissionManager.checkPermission(
      surface,
      input,
      agentName,
      this.sessionRules.getRuleset(),
    );
  }

  getToolPermission(toolName: string, agentName?: string) {
    return this.permissionManager.getToolPermission(toolName, agentName);
  }

  registerToolInputFormatter(toolName: string, formatter: ToolInputFormatter) {
    return this.formatterRegistry.register(toolName, formatter);
  }
}
```

`index.ts` constructs it with `new LocalPermissionsService(runtime.permissionManager, runtime.sessionRules, formatterRegistry)` — byte-identical to the literal's `runtime.permissionManager` / `runtime.sessionRules.getRuleset()` reads (the literal already used the runtime's manager, not the session's).

### `ServiceLifecycle` / `PermissionServiceLifecycle`

A narrow interface for `SessionLifecycleHandler` to depend on, plus the implementation owning the #302-critical publish gate and teardown ordering.
The session-scoped subscription unsubs (`rpcHandles.unsubCheck`, `rpcHandles.unsubPrompt`, `unsubSubagentLifecycle`) flow in as a `() => void[]` data array, preserving the current shutdown order (subscriptions first, then unpublish):

```typescript
// src/service-lifecycle.ts (new)
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emitReadyEvent, type PermissionEventBus } from "./permission-events";
import {
  publishPermissionsService,
  unpublishPermissionsService,
  type PermissionsService,
} from "./service";
import { isRegisteredSubagentChild } from "./subagent-context";
import type { SubagentSessionRegistry } from "./subagent-registry";

/** The session-scoped service lifecycle the lifecycle handler drives. */
export interface ServiceLifecycle {
  activate(ctx: ExtensionContext): void;
  teardown(): void;
}

export class PermissionServiceLifecycle implements ServiceLifecycle {
  constructor(
    private readonly service: PermissionsService,
    private readonly registry: SubagentSessionRegistry,
    private readonly events: PermissionEventBus,
    private readonly subscriptions: readonly (() => void)[],
  ) {}

  activate(ctx: ExtensionContext): void {
    // Publish only for a non-child session so a registered subagent child
    // never clobbers the parent's process-global service. See #302.
    if (!isRegisteredSubagentChild(ctx, this.registry)) {
      publishPermissionsService(this.service);
    }
    emitReadyEvent(this.events);
  }

  teardown(): void {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    unpublishPermissionsService(this.service);
  }
}
```

### `SessionLifecycleHandler` retyping

The handler's two callback params collapse to one collaborator:

```typescript
constructor(
  private readonly session: SessionLifecycleSession,
  private readonly serviceLifecycle: ServiceLifecycle,
) {}

// handleSessionStart: this.serviceLifecycle.activate(ctx);
// handleSessionShutdown: this.serviceLifecycle.teardown();
```

### Composition root after the change

```typescript
const rpcHandles = registerPermissionRpcHandlers(pi.events, { … });
const permissionsService = new LocalPermissionsService(
  runtime.permissionManager,
  runtime.sessionRules,
  formatterRegistry,
);
const unsubSubagentLifecycle = subscribeSubagentLifecycle(pi.events, subagentRegistry);
const serviceLifecycle = new PermissionServiceLifecycle(
  permissionsService,
  subagentRegistry,
  pi.events,
  [rpcHandles.unsubCheck, rpcHandles.unsubPrompt, unsubSubagentLifecycle],
);
// …
const lifecycle = new SessionLifecycleHandler(session, serviceLifecycle);
```

### Edge cases

- `runtime.permissionManager` stability — injecting the instance (vs. late-binding through `runtime`) is behavior-preserving only because it is never reassigned; a clarifying comment records the invariant.
- `emitReadyEvent` ordering — `activate` publishes then emits, matching the old closure; the "ready emitted after service publication" test guards it.
- Teardown order — `subscriptions` iterates `[unsubCheck, unsubPrompt, unsubSubagentLifecycle]` before `unpublishPermissionsService`, identical to the old teardown closure; the "shutdown teardown chain" test guards it.
- Child gating — `activate` skips publish for a registered child but still emits ready, identical to the old `activateServiceForSession`; the "multi-instance global service interplay" (#302) test guards it.
- Passing `rpcHandles.unsubCheck` / `unsubPrompt` by reference is safe — they are plain closures returned from `registerPermissionRpcHandlers`, not class methods, so `@typescript-eslint/unbound-method` does not fire (if it does, wrap as `() => rpcHandles.unsubCheck()`).

## Module-Level Changes

- `src/permissions-service.ts` — **new**: `LocalPermissionsService` class.
- `src/service-lifecycle.ts` — **new**: `ServiceLifecycle` interface + `PermissionServiceLifecycle` class.
- `src/handlers/lifecycle.ts` — replace the `activateService: (ctx) => void` and `cleanupRpc: () => void` constructor params with `serviceLifecycle: ServiceLifecycle`; call `this.serviceLifecycle.activate(ctx)` in `handleSessionStart` and `this.serviceLifecycle.teardown()` in `handleSessionShutdown`; update the constructor doc comment; import `ServiceLifecycle`.
- `src/index.ts` — replace the `permissionsService` literal with `new LocalPermissionsService(...)`; remove the `activateServiceForSession` closure and the inline teardown closure, replacing them with `new PermissionServiceLifecycle(...)` and `new SessionLifecycleHandler(session, serviceLifecycle)`; drop the now-unused imports (`buildInputForSurface`, `publishPermissionsService`, `unpublishPermissionsService`, `emitReadyEvent`, `isRegisteredSubagentChild`); keep `subscribeSubagentLifecycle`, `getSubagentSessionRegistry`, `isSubagentExecutionContext` (still used by the session deps).
- `test/permissions-service.test.ts` — **new**: unit tests for `LocalPermissionsService`.
- `test/service-lifecycle.test.ts` — **new**: unit tests for `PermissionServiceLifecycle`.
- `test/handlers/lifecycle.test.ts` — replace the `activateService` / `cleanupRpc` `vi.fn()` mocks with a `serviceLifecycle = { activate: vi.fn(), teardown: vi.fn() }`; update the constructor call and the two assertions ("activates the service for the session with ctx" → `serviceLifecycle.activate` with `ctx`; "calls cleanupRpc" → `serviceLifecycle.teardown`).
- `docs/architecture/architecture.md` — add `permissions-service.ts` and `service-lifecycle.ts` to the `src/` tree; update the `index.ts` tree line; update the `permission-gate-handler.ts` / lifecycle wiring note if it references the old callbacks; mark Phase 3 Step 15 (#320) with the collaborators-only outcome (two collaborators extracted, `index.ts` ~206 → ~170; the "< 100 lines" target reconsidered as procedure-splitting and deferred); update the `S15` Mermaid node and the Track D row; refresh the `index.ts` churn-hotspot note.
- `.pi/skills/package-pi-permission-system/SKILL.md` — optional: note that `LocalPermissionsService` and `PermissionServiceLifecycle` own the service implementation and the `session_start`-gated publish / teardown (the #302 narrative now points at a named collaborator).

A repo-wide grep confirms the `permissionsService` literal, `activateServiceForSession`, and the teardown closure live only in `index.ts`; `SessionLifecycleHandler`'s callbacks are referenced only in `lifecycle.ts` and `lifecycle.test.ts`; no other module imports these.

## Test Impact Analysis

1. New tests enabled.
   `LocalPermissionsService` becomes directly unit-testable (input building, session-rule application, and delegation to the manager / registry) — previously reachable only through `composition-root.test.ts`.
   `PermissionServiceLifecycle.activate` / `teardown` become directly unit-testable (child-gated publish, ready emission, teardown ordering) — previously buried in two anonymous `index.ts` closures.
2. Redundant / simplified tests.
   None removed.
   `composition-root.test.ts` keeps every assertion (the wiring it checks is unchanged); the new unit tests add lower-level coverage of the same behavior.
   `lifecycle.test.ts` simplifies its mock surface (two callbacks → one 2-method collaborator) with no loss of assertion coverage.
3. Tests that stay as-is.
   `composition-root.test.ts` (handler-registration completeness, subagent registry sharing, shutdown teardown chain, shared formatter registry, ready-after-publish, multi-instance #302 interplay) — these genuinely exercise the wired composition root and must pass unchanged, proving the extraction is behavior-preserving.

## TDD Order

1. Extract `LocalPermissionsService`.
   Surface: new `test/permissions-service.test.ts` — `checkPermission` builds the surface input, applies the current session ruleset, and delegates to `PermissionManager.checkPermission`; `getToolPermission` delegates; `registerToolInputFormatter` delegates to the registry.
   Green: add `src/permissions-service.ts`; rewire `index.ts` to `new LocalPermissionsService(runtime.permissionManager, runtime.sessionRules, formatterRegistry)`; drop the `buildInputForSurface` import.
   `composition-root.test.ts` "service and gate share one formatter registry" must stay green (same `formatterRegistry` instance still injected into the service and the gate pipeline).
   Run `pnpm run check` after this step.
   Commit: `refactor: extract LocalPermissionsService from the composition root`.
2. Extract `PermissionServiceLifecycle` and inject it into `SessionLifecycleHandler`.
   Surface: new `test/service-lifecycle.test.ts` — `activate` publishes then emits ready for a non-child session, skips publish but still emits ready for a registered child, and `teardown` runs the subscriptions in order before unpublishing.
   Green: add `src/service-lifecycle.ts`; retype `SessionLifecycleHandler` to take `serviceLifecycle: ServiceLifecycle` (replacing the two callbacks) and call `activate` / `teardown`; update `lifecycle.test.ts`; rewire `index.ts` to build `PermissionServiceLifecycle` and `new SessionLifecycleHandler(session, serviceLifecycle)`; drop the now-unused `publishPermissionsService` / `unpublishPermissionsService` / `emitReadyEvent` / `isRegisteredSubagentChild` imports.
   The handler constructor-signature change breaks `lifecycle.test.ts` at the type level in this commit, so the collaborator, handler retype, handler-test update, and `index.ts` wiring land together.
   Run `pnpm run check` after this step.
   Commit: `refactor: drive service publish/teardown through an injected ServiceLifecycle`.
3. Update the architecture roadmap and package skill.
   Surface: docs only.
   Update `docs/architecture/architecture.md` (tree, Step 15 outcome, `S15` Mermaid node, Track D row, `index.ts` churn note) and the `SKILL.md` service-publish note.
   Commit: `docs: record the composition-root collaborator extraction (#320)`.

## Risks and Mitigations

- Injecting `runtime.permissionManager` as an instance (vs. late binding) would change behavior if it were ever reassigned.
  Mitigation: verified by grep that `runtime.permissionManager` is never reassigned (only `this.permissionManager` inside `PermissionSession`); `sessionRules` is `readonly`; a clarifying comment records the invariant, and `composition-root.test.ts` exercises the live service.
- A transcription slip in `activate` / `teardown` could change publish gating or teardown order.
  Mitigation: the closures move verbatim; `composition-root.test.ts`'s ready-after-publish, teardown-chain, and #302 interplay tests guard each behavior, and the new `service-lifecycle.test.ts` asserts ordering directly.
- `@typescript-eslint/unbound-method` could flag `rpcHandles.unsubCheck` / `unsubPrompt` passed by reference.
  Mitigation: they are plain closures (not class methods), so the rule does not fire; if it does, wrap as `() => rpcHandles.unsubCheck()`.
- Scope creep toward the "< 100 lines" target.
  Mitigation: the collaborators-only scope is the recorded `ask_user` decision; the remaining injection-bag construction stays inline as legitimate wiring.

## Open Questions

- Eliminating the relay closures (`() => runtime.config`, `runtime.x.bind(runtime)`) by retyping the prompter / session / command / RPC consumers onto narrow `ExtensionRuntime` role interfaces is the deeper follow-up that would get `index.ts` well under 100 lines; deferred (declined for this issue via `ask_user`).
- Whether the runtime's separate `permissionManager` (global-only config, never refreshed for project cwd) is the intended source for the cross-extension service is pre-existing behavior preserved verbatim here — worth a future look, out of scope.
