---
issue: 331
issue_title: "Narrow AgentPrepHandler and SessionLifecycleHandler against role interfaces"
---

# Narrow AgentPrepHandler and SessionLifecycleHandler against role interfaces

## Problem Statement

`AgentPrepHandler` and `SessionLifecycleHandler` both take `session: PermissionSession` — the concrete class, with private fields — even though each touches only a handful of its public members.
Because the parameter is a concrete class, the local `makeSession` fixtures in `before-agent-start.test.ts` and `lifecycle.test.ts` each cast `as unknown as PermissionSession` to satisfy the type, which disables TypeScript's structural check.
A consumer that calls a session method the mock lacks then fails at runtime, not at `pnpm run check` — the same smell [#325] removed from `PermissionGateHandler` (and the exact regression that bit during [#319]).

This issue retypes both handlers against narrow role interfaces and drops the two remaining `as unknown as PermissionSession` casts in the handler test tree, completing the handler-narrowing arc.

## Goals

- Type `AgentPrepHandler`'s `session` dependency against a narrow `AgentPrepSession` role, not the concrete `PermissionSession` class.
- Type `SessionLifecycleHandler`'s `session` dependency against a narrow `SessionLifecycleSession` role.
- Reuse the existing two-method context role (`GateHandlerSession`: `activate` + `resolveAgentName`) for `AgentPrepHandler` rather than redefining it.
- Drop the `as unknown as PermissionSession` casts in `before-agent-start.test.ts` and `lifecycle.test.ts`, retyping their mocks to the role with `vi.fn<T>()` so `pnpm run check` enforces mock completeness.
- Behavior-preserving — no decision, event, log, or cache output changes.

## Non-Goals

- Touching `PermissionGateHandler` or its fixtures — done in [#325].
- Reframing `index.ts` as collaborator injection — that is Step 15 ([#320]); this plan changes no `index.ts` wiring (the real `PermissionSession` already satisfies every role).
- Splitting `PermissionSession` or relocating any of its methods — these roles are views onto the existing class, not a decomposition of it.
- Adding new runtime behavior or new tests beyond the type-level enforcement the retyping enables.
- Extracting a shared `refreshConfig` micro-role — a single shared method does not clear the bar for its own interface (design-review check 7); declaring it on each role is cheaper than the wrong abstraction.

## Background

Relevant modules and how they relate:

- `src/handlers/before-agent-start.ts` (`AgentPrepHandler`) — handles `before_agent_start`: tool filtering + prompt sanitization.
  Its `handle` calls `session.activate`, `refreshConfig`, `resolveAgentName(ctx, systemPrompt)`, `getToolPermission`, the active-tools cache pair (`shouldUpdateActiveTools` / `commitActiveToolsCacheKey`), `getPolicyCacheStamp`, the prompt-state cache pair (`shouldUpdatePromptState` / `commitPromptStateCacheKey`), and `setActiveSkillEntries`.
  It also passes `this.session` to `resolveSkillPromptEntries`, which consumes the `SkillPermissionChecker` role (`checkPermission`).
- `src/handlers/lifecycle.ts` (`SessionLifecycleHandler`) — handles `session_start`, `resources_discover`, `session_shutdown`.
  It calls `session.refreshConfig`, `resetForNewSession`, `logResolvedConfigPaths`, `resolveAgentName(ctx)`, `getConfigIssues`, `reload`, `getRuntimeContext`, `shutdown`, and reads `session.logger` (`warn`, `debug`).
  It does **not** call `session.activate`.
- `src/gate-handler-session.ts` (`GateHandlerSession`) — the two-method context role (`activate`, `resolveAgentName`) established by [#325] and shrunk to two methods by [#329].
  `resolveAgentName` is currently declared `(ctx) => string | null`; `AgentPrepHandler` calls it with a second `systemPrompt` argument, so reusing this role requires widening that one signature.
- `src/skill-prompt-sanitizer.ts` (`SkillPermissionChecker`) — the existing narrow `checkPermission` role that `resolveSkillPromptEntries` accepts.
- `src/permission-session.ts` (`PermissionSession`) — the concrete class.
  It already `implements PermissionResolver, SessionApprovalRecorder, GatePrompter, GateHandlerSession` and already has every method both new roles need; this plan adds two more roles to that `implements` list with no method-body changes.
- `src/index.ts` — constructs both handlers with the real `session`.
  No change: `PermissionSession` implements the new roles, so it stays assignable to the narrowed constructor parameters.
- `test/handlers/before-agent-start.test.ts`, `test/handlers/lifecycle.test.ts` — each defines a **local** `makeSession` that casts `as unknown as PermissionSession`.
  These are the only two casts left in the handler test tree (the shared `handler-fixtures.ts` `makeSession` was de-casted in [#325]).

Constraints from AGENTS.md and the package skill:

- Role interfaces that `PermissionSession` implements must live in top-level `src/` (a domain module cannot import from the `handlers/` layer without inverting the dependency) — mirror `gate-handler-session.ts`, one role per file.
- `pnpm fallow dead-code` must stay clean — each new interface must have a consumer in the same commit it is introduced (the handler constructor + the `implements` clause).
- Adding to a barrel requires a real consumer; these roles are imported directly by their handler and by `permission-session.ts`, so no barrel re-export is added.
- The package skill (`.pi/skills/package-pi-permission-system/SKILL.md`) names the shared `handler-fixtures.ts` `makeSession` but not the two local ones, and not these handlers' constructor arity — no skill edit is required.

### Design-review checklist (run before finalizing)

| Smell           | Location                            | Evidence                                                        | Fix                                                                                           |
| --------------- | ----------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Wide interface  | `AgentPrepHandler` ctor             | `session: PermissionSession` (concrete class), uses ~11 members | Narrow `AgentPrepSession` role (reuses `GateHandlerSession` + `SkillPermissionChecker`)       |
| Wide interface  | `SessionLifecycleHandler` ctor      | `session: PermissionSession` (concrete class), uses 9 members   | Narrow `SessionLifecycleSession` role                                                         |
| Test-mock depth | 2 local `makeSession` fixtures      | `as unknown as PermissionSession`                               | Type against the role; `vi.fn<T>()` per method                                                |
| ISP over-reach  | lifecycle reuse of the context role | lifecycle never calls `activate`                                | `SessionLifecycleSession` declares only `resolveAgentName`, not the full `GateHandlerSession` |

No Law-of-Demeter reach-throughs, output arguments, scattered resets, or parameter relays appear on either handler path — the handlers already talk only to `session` and tell it what to do.
The only structural change is the parameter type.

## Design Overview

Introduce two narrow role interfaces — one per handler — each a cohesive view onto `PermissionSession`, reusing the existing context and skill-checker roles where the handler's usage matches them exactly.

### Reuse the context role: widen `GateHandlerSession.resolveAgentName`

`AgentPrepHandler` uses both context methods (`activate` + `resolveAgentName`), so it reuses `GateHandlerSession` directly.
The only friction is that it calls `resolveAgentName(ctx, event.systemPrompt)` — a two-argument call the current role signature rejects.
Widen the role's one method to carry the optional second parameter the concrete method already accepts:

```typescript
// src/gate-handler-session.ts
export interface GateHandlerSession {
  activate(ctx: ExtensionContext): void;
  resolveAgentName(ctx: ExtensionContext, systemPrompt?: string): string | null;
}
```

This is behavior-neutral for `PermissionGateHandler` (it still calls `resolveAgentName(ctx)` with one argument) and for `PermissionSession` (its method already has the optional `systemPrompt` parameter).
Widening — not redefining — keeps a single context role shared across the gate and agent-prep handlers, as the issue directs.

### `AgentPrepSession` role

`AgentPrepHandler`'s surface is the context role, the skill-permission checker (because it passes `session` to `resolveSkillPromptEntries`), and the agent-start prep operations (config refresh, tool exposure, the two cache pairs, the policy stamp, and skill-entry storage):

```typescript
// src/agent-prep-session.ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GateHandlerSession } from "./gate-handler-session";
import type { SkillPermissionChecker, SkillPromptEntry } from "./skill-prompt-sanitizer";
import type { PermissionState } from "./types";

/**
 * The session surface AgentPrepHandler invokes during `before_agent_start`:
 * bind context + identify the agent (GateHandlerSession), check skill
 * permissions for prompt sanitization (SkillPermissionChecker), refresh
 * config, decide tool exposure, manage the active-tools / prompt-state cache
 * keys, and store the resolved skill entries.
 */
export interface AgentPrepSession extends GateHandlerSession, SkillPermissionChecker {
  refreshConfig(ctx?: ExtensionContext): void;
  getToolPermission(toolName: string, agentName?: string): PermissionState;
  shouldUpdateActiveTools(cacheKey: string): boolean;
  commitActiveToolsCacheKey(cacheKey: string): void;
  getPolicyCacheStamp(agentName?: string): string;
  shouldUpdatePromptState(cacheKey: string): boolean;
  commitPromptStateCacheKey(cacheKey: string): void;
  setActiveSkillEntries(entries: SkillPromptEntry[]): void;
}
```

ISP check: every member is read by `AgentPrepHandler.handle` (or, for `checkPermission`, by the `resolveSkillPromptEntries` call it makes), so the role carries no unused field.

### `SessionLifecycleSession` role

`SessionLifecycleHandler` needs `resolveAgentName` but never calls `activate`, so it does **not** reuse `GateHandlerSession` (that would carry an unused method — an ISP violation).
It declares the config/lifecycle surface plus the logger it reads:

```typescript
// src/session-lifecycle-session.ts
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SessionLogger } from "./session-logger";

/**
 * The session surface SessionLifecycleHandler invokes across session_start,
 * resources_discover, and session_shutdown: refresh + report config, reset /
 * reload / shut down session state, resolve the agent name, surface config
 * issues, read the runtime context, and log.
 */
export interface SessionLifecycleSession {
  refreshConfig(ctx?: ExtensionContext): void;
  resetForNewSession(ctx: ExtensionContext): void;
  logResolvedConfigPaths(): void;
  resolveAgentName(ctx: ExtensionContext, systemPrompt?: string): string | null;
  getConfigIssues(agentName?: string): string[];
  reload(): void;
  getRuntimeContext(): ExtensionContext | null;
  shutdown(): void;
  readonly logger: SessionLogger;
}
```

`resolveAgentName` overlaps with `GateHandlerSession`'s signature, but that overlap is the nature of role interfaces — each role lists what its one consumer needs; a duplicated method signature is cheaper than forcing lifecycle to depend on `activate`.

### Handler constructor changes (the call sites)

Only the parameter types change; both `handle*` bodies stay identical:

```typescript
export class AgentPrepHandler {
  constructor(
    private readonly session: AgentPrepSession,
    private readonly toolRegistry: ToolRegistry,
  ) {}
  // handle(): activate → refreshConfig → resolveAgentName → tool filter →
  // cache-keyed setActive → prompt sanitize (resolveSkillPromptEntries(…, this.session, …)) → setActiveSkillEntries
}

export class SessionLifecycleHandler {
  constructor(
    private readonly session: SessionLifecycleSession,
    private readonly activateService: (ctx: ExtensionContext) => void,
    private readonly cleanupRpc: () => void,
  ) {}
  // handleSessionStart / handleResourcesDiscover / handleSessionShutdown bodies unchanged
}
```

`PermissionSession` adds `AgentPrepSession` and `SessionLifecycleSession` to its `implements` list.
It already has all of their methods (the four-argument `checkPermission` and two-argument `resolveAgentName` remain assignable to the narrower role signatures; `readonly logger` satisfies the role's `logger`), so no method body changes.

`src/index.ts` is untouched: `new AgentPrepHandler(session, toolRegistry)` and `new SessionLifecycleHandler(session, …)` still compile because `session: PermissionSession` is assignable to the narrowed parameters.

### Test-fixture retyping (no cast)

Each local `makeSession` becomes a typed object literal returning the role, following the `vi.fn<T>()` pattern [#325] established in `handler-fixtures.ts`:

```typescript
// before-agent-start.test.ts
function makeSession(overrides: Partial<AgentPrepSession> = {}): AgentPrepSession {
  return {
    activate: vi.fn<AgentPrepSession["activate"]>(),
    refreshConfig: vi.fn<AgentPrepSession["refreshConfig"]>(),
    resolveAgentName: vi.fn<AgentPrepSession["resolveAgentName"]>().mockReturnValue(null),
    checkPermission: vi.fn<AgentPrepSession["checkPermission"]>().mockReturnValue({ state: "allow" }),
    getToolPermission: vi.fn<AgentPrepSession["getToolPermission"]>().mockReturnValue("allow"),
    shouldUpdateActiveTools: vi.fn<AgentPrepSession["shouldUpdateActiveTools"]>().mockReturnValue(true),
    commitActiveToolsCacheKey: vi.fn<AgentPrepSession["commitActiveToolsCacheKey"]>(),
    getPolicyCacheStamp: vi.fn<AgentPrepSession["getPolicyCacheStamp"]>().mockReturnValue("stamp-1"),
    shouldUpdatePromptState: vi.fn<AgentPrepSession["shouldUpdatePromptState"]>().mockReturnValue(true),
    commitPromptStateCacheKey: vi.fn<AgentPrepSession["commitPromptStateCacheKey"]>(),
    setActiveSkillEntries: vi.fn<AgentPrepSession["setActiveSkillEntries"]>(),
    ...overrides,
  };
}
```

The current `before-agent-start.test.ts` mock carries a `logger` and a `getActiveSkillEntries` field that `AgentPrepHandler` never reads; the new typed literal drops both (the role does not declare them, and TypeScript's excess-property check would reject `logger` otherwise).
The `lifecycle.test.ts` mock is retyped the same way against `SessionLifecycleSession`, keeping its `logger: { debug, review, warn }` and dropping the cast.
The `overrides` parameter narrows from `Partial<Record<keyof PermissionSession, unknown>>` to `Partial<Role>`, so an override naming a non-member fails `pnpm run check`.

Edge case: `lifecycle.test.ts` overrides `getConfigIssues`, `getRuntimeContext`, `refreshConfig`, and `resetForNewSession` in various tests; all four are role members, so spreading `...overrides` last still type-checks.

## Module-Level Changes

- `src/gate-handler-session.ts` — widen `resolveAgentName` to `(ctx, systemPrompt?)`.
  No new import; behavior-neutral for the gate handler.
- `src/agent-prep-session.ts` — **new**: the `AgentPrepSession` interface (`extends GateHandlerSession, SkillPermissionChecker`).
- `src/session-lifecycle-session.ts` — **new**: the `SessionLifecycleSession` interface.
- `src/permission-session.ts` — add `AgentPrepSession` and `SessionLifecycleSession` to the `implements` list; import both.
  No method-body changes.
- `src/handlers/before-agent-start.ts` — constructor parameter `session: AgentPrepSession`; swap the `import type { PermissionSession }` for `import type { AgentPrepSession } from "#src/agent-prep-session"`.
  `handle` body unchanged.
- `src/handlers/lifecycle.ts` — constructor parameter `session: SessionLifecycleSession`; swap the `PermissionSession` import for `import type { SessionLifecycleSession } from "#src/session-lifecycle-session"`.
  Handler bodies unchanged.
- `test/handlers/before-agent-start.test.ts` — retype `makeSession` to `AgentPrepSession` (cast dropped, `vi.fn<T>()` per method, `logger` + `getActiveSkillEntries` removed); narrow the `overrides` key type to `Partial<AgentPrepSession>`; swap the `PermissionSession` import for `AgentPrepSession`.
- `test/handlers/lifecycle.test.ts` — retype `makeSession` to `SessionLifecycleSession` (cast dropped, `vi.fn<T>()` per method, `logger` retained); narrow the `overrides` key type; swap the `PermissionSession` import for `SessionLifecycleSession`.
- `packages/pi-permission-system/docs/architecture/architecture.md` — mark Phase 3 Step 14 ✅ and record the role names + the `resolveAgentName` widening; in the module-structure listing add `agent-prep-session.ts` and `session-lifecycle-session.ts`, and update the `before-agent-start.ts`, `lifecycle.ts`, and `permission-session.ts` lines to name the new role dependencies.

Symbol-grep results (per AGENTS.md): the only `new AgentPrepHandler(...)` / `new SessionLifecycleHandler(...)` sites are `index.ts` and the two test files above; `composition-root.test.ts` drives both handlers through `pi.fire`, not their constructors, so it needs no change.
No exported symbol is removed or renamed; the `handlers/index.ts` barrel is unchanged.

## Test Impact Analysis

1. New tests enabled — the change is type-level; its payoff is compile-time enforcement (the two `implements` clauses plus the precise mock types), not a new runtime test.
   Naming the roles makes a future minimal unit test of either handler possible without the concrete class, but the existing suites already cover the behavior, so none is added here.
2. Tests that become redundant — none.
   No assertion is duplicated or obviated; only the fixture typing changes.
3. Tests that must stay as-is — every behavior assertion in `before-agent-start.test.ts` and `lifecycle.test.ts` genuinely exercises the handler against a mocked session boundary; only the mock's type (and two vestigial fields) change, never the assertions.

## TDD Order

This is a behavior-preserving refactor; the existing suite plus `pnpm run check` are the safety net, so the cycles are "change → green", not "new red test → green".

1. **Introduce the roles and retype both handlers** — widen `GateHandlerSession.resolveAgentName`; add `src/agent-prep-session.ts` and `src/session-lifecycle-session.ts`; add both to `PermissionSession`'s `implements` list; change both handler constructor parameter types and swap their imports.
   `index.ts` is unchanged (the concrete session still satisfies the narrowed params); the two test mocks keep their `as unknown as PermissionSession` casts for now (a `PermissionSession` still satisfies the narrow roles).
   Verify `pnpm run check` and the full package suite are green.
   Commit: `refactor: type AgentPrepHandler and SessionLifecycleHandler against session role interfaces (#331)`.
2. **Drop the AgentPrepHandler mock cast** — retype `before-agent-start.test.ts` `makeSession` to `AgentPrepSession` with `vi.fn<T>()`, drop the cast, remove the vestigial `logger` + `getActiveSkillEntries`, and narrow the `overrides` key type.
   Run the file plus `pnpm run check`.
   Commit: `refactor: drop as-unknown-as PermissionSession cast in AgentPrepHandler mock (#331)`.
3. **Drop the SessionLifecycleHandler mock cast** — retype `lifecycle.test.ts` `makeSession` to `SessionLifecycleSession` the same way, dropping the cast and narrowing `overrides`.
   Run the file plus `pnpm run check`.
   Commit: `refactor: drop as-unknown-as PermissionSession cast in SessionLifecycleHandler mock (#331)`.
4. **Document** — mark architecture Step 14 ✅ and update the module-structure listing.
   Commit: `docs: record handler role-interface narrowing in architecture (#331)`.

Steps 2 and 3 are independent (different files) and could be folded into one commit; they are kept separate only for reviewability and may be merged if preferred.

## Risks and Mitigations

- **Risk:** dropping a cast surfaces a missing or mistyped mock member.
  **Mitigation:** that is the intended win — `pnpm run check` names the gap; the role definitions above list every required member so the typed literal is complete.
- **Risk:** widening `GateHandlerSession.resolveAgentName` perturbs the gate handler or its mocks.
  **Mitigation:** an added optional parameter is backward-compatible; the gate handler still calls with one argument and `MockGateHandlerSession`'s `vi.fn<GateHandlerSession["resolveAgentName"]>()` re-derives from the widened type.
  Keep `composition-root.test.ts` and the gate-handler suites green.
- **Risk:** excess-property error when removing the cast because the literal still carries `logger` / `getActiveSkillEntries` (AgentPrep) that the role omits.
  **Mitigation:** drop both fields in Step 2; the literal then matches `AgentPrepSession` exactly.
- **Risk:** `readonly logger` on `PermissionSession` fails to satisfy the role's `logger`.
  **Mitigation:** the role declares `readonly logger` and TypeScript treats a `readonly` source property as assignable to a mutable target regardless; either way it type-checks.

## Open Questions

- Should `AgentPrepHandler` get its own `resolveAgentName(ctx, systemPrompt?)` declaration instead of widening `GateHandlerSession`, to keep the gate context role free of an unused `systemPrompt` parameter?
  Resolved in favor of widening: the issue directs reuse of the shared context role rather than redefining it, and the optional parameter is harmless to the gate path.
- Should `refreshConfig` (shared by both new roles) become its own micro-role?
  Deferred: a single shared method does not clear the design-review bar for a new interface; revisit only if a third consumer appears.

[#319]: https://github.com/gotgenes/pi-packages/issues/319
[#320]: https://github.com/gotgenes/pi-packages/issues/320
[#325]: https://github.com/gotgenes/pi-packages/issues/325
[#329]: https://github.com/gotgenes/pi-packages/issues/329
