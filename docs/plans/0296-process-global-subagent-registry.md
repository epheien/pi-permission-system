---
issue: 296
issue_title: "Permission forwarding broken for in-process @gotgenes/pi-subagents children — `ask` silently blocked (regression: pi-subagents v11.4.0 / pi-permission-system v8.0.0)"
---

# Back `SubagentSessionRegistry` with a process-global instance

## Problem Statement

Permission forwarding no longer works for in-process `@gotgenes/pi-subagents` children.
When a subagent triggers an `ask` decision (for example an external-directory `ls`), the request is blocked deterministically instead of being forwarded to the parent session's UI, and no `forwarded_permission.*` entry is written — the child never enters the forwarding path.

The root cause is a per-session event-bus split.
Each session's `ResourceLoader` creates its own `EventBus`, and `@gotgenes/pi-subagents` builds the child session's loader without passing the parent's bus.
The child lifecycle is published on the **parent's** bus (`createChildLifecyclePublisher((c, d) => pi.events.emit(c, d))`), so the parent's permission-system instance registers the child in its `SubagentSessionRegistry` and can poll/surface requests.
But the **child's** permission-system instance is a separate jiti module instance with its own empty `new SubagentSessionRegistry()`, subscribed to the child's separate bus, so it never receives the registration.
In the child, `isSubagentExecutionContext()` then misses the registry, finds no env hints (`@gotgenes/pi-subagents` sets none), and fails the filesystem heuristic (child sessions live at `<parent-session-dir>/<basename>/tasks`, not `~/.pi/agent/subagent-sessions`).
`canResolveAskPermissionRequest = hasUI || isSubagent || yolo` is then false on all three counts, so the `ask` is blocked.

This is a regression.
The retired `permission-bridge.ts` (pi-subagents [#101]) registered through `globalThis[Symbol.for("@gotgenes/pi-permission-system:service")]` — a process-global channel that survives jiti/session isolation.
The [#261] event-based inversion replaced that with a per-session bus, and [#267] then removed the `globalThis` fallback entirely.

## Goals

- Restore forwarding for in-process `@gotgenes/pi-subagents` children: a child's `ask` decision reaches the parent's UI as a `Permission Required (Subagent)` prompt.
- Make the single `SubagentSessionRegistry` instance process-global so the parent's instance writes and the child's instance reads the same store, regardless of which per-session event bus each instance is wired to.
- Reuse the package's established `Symbol.for()` convention (the same mechanism `src/service.ts` uses for `PermissionsService`).
- Keep the existing event-driven registration ([ADR-0002]) intact — only the registry's storage location changes; the publish/subscribe flow and the synchronous `session-created` ordering guarantee are unchanged.

## Non-Goals

- No changes to `@gotgenes/pi-subagents`.
  The publisher already emits `subagents:child:session-created` / `subagents:child:disposed` on the parent bus correctly, and the parent-side subscription is correct.
  This is a single-package fix even though the issue carries both `pkg:*` labels.
- Not fixing the sibling-key collision for concurrent children of the same parent (all share the `<parent>/<basename>/tasks` `getSessionDir()` key).
  This pre-dates the regression and is independent of the event-bus split — see Open Questions.
- Not broadening env-hint or filesystem detection for CLI/process-based subagent extensions (that is the separate, still-open [#22]).
- No change to the `PermissionsService` public surface or the prompt-forwarding RPC.

## Background

Relevant modules in `packages/pi-permission-system/src/`:

- `subagent-registry.ts` — the `SubagentSessionRegistry` class (a `Map<string, SubagentSessionInfo>` keyed by child session directory).
  Today it is instantiated once with `new SubagentSessionRegistry()` in `index.ts`.
- `index.ts` — the composition root.
  Line 41 constructs the registry and threads the instance into `PermissionPrompter`, `forwardingDeps`, `ForwardingManager`, the two `isSubagentExecutionContext(...)` closures, and `subscribeSubagentLifecycle(pi.events, subagentRegistry)`.
- `subagent-context.ts` — `isSubagentExecutionContext(ctx, subagentSessionsDir, registry)` checks `registry.has(sessionDir)` first.
- `permission-forwarding.ts` — `resolvePermissionForwardingTargetSessionId(...)` reads `registry.get(sessionDir)?.parentSessionId` to find the forwarding target.
- `subagent-lifecycle-events.ts` — `subscribeSubagentLifecycle(events, registry)` registers on `session-created` and unregisters on `disposed`.
- `service.ts` — the existing `Symbol.for("@gotgenes/pi-permission-system:service")` pattern to mirror: a process-global slot accessor that survives jiti's `moduleCache: false` isolation.

Constraint from `AGENTS.md` / the `package-pi-permission-system` skill: under jiti, module-scoped state is isolated per extension instance; `globalThis` + `Symbol.for()` is the prescribed mechanism for process-global state.
The `session-created` handler must stay synchronous (the core emits it on the same call stack right before `bindExtensions()`); this fix does not touch that handler.

The registration key matches the runtime lookup key: the event payload's `sessionDir` is the output of `deriveSubagentSessionDir`, and the SDK's `SessionManager.getSessionDir()` returns exactly the directory passed to `SessionManager.create(cwd, dir)` (verified — `newSession()` does not mutate `sessionDir`).
So once the parent's registration lands in a shared store, the child's lookup hits it.

## Design Overview

Introduce a lazily-initialized, process-global accessor for the registry and have the composition root use it instead of `new`.

New accessor in `subagent-registry.ts` (the class is unchanged):

```typescript
const SUBAGENT_SESSION_REGISTRY_KEY = Symbol.for(
  "@gotgenes/pi-permission-system:subagent-registry",
);

/**
 * Return the process-global SubagentSessionRegistry, creating it on first call.
 *
 * Backed by globalThis + Symbol.for() so the parent's permission-system
 * instance (which registers children on the parent event bus) and each child's
 * separate jiti instance (which reads the registry to detect itself and resolve
 * its forwarding target) share one store across per-session event buses.
 */
export function getSubagentSessionRegistry(): SubagentSessionRegistry {
  const store = globalThis as Record<symbol, unknown>;
  const existing = store[SUBAGENT_SESSION_REGISTRY_KEY] as
    | SubagentSessionRegistry
    | undefined;
  if (existing) {
    return existing;
  }
  const registry = new SubagentSessionRegistry();
  store[SUBAGENT_SESSION_REGISTRY_KEY] = registry;
  return registry;
}
```

Consumer call site in `index.ts` (one line):

```typescript
const subagentRegistry = getSubagentSessionRegistry();
```

All downstream wiring (`prompter`, `forwardingDeps`, `ForwardingManager`, `subscribeSubagentLifecycle`, the `isSubagentExecutionContext` closures) is unchanged — it already receives the instance by reference and the type is identical.

Lifecycle and ordering, after the change:

1. The parent's permission-system runs `getSubagentSessionRegistry()` at process startup — first call creates the global registry — and subscribes to the parent bus.
2. A child spawns; the core emits `session-created` on the parent bus before `bindExtensions()`; the parent's synchronous subscriber calls `registry.register(childSessionDir, { agentName, parentSessionId })` on the global registry.
3. `bindExtensions()` instantiates the child's permission-system; its `getSubagentSessionRegistry()` returns the same global instance (already populated).
4. On the child's first `tool_call`, `isSubagentExecutionContext()` hits `registry.has(childSessionDir)` → true; the `ask` resolves via `waitForForwardedPermissionApproval`, which reads `parentSessionId` from the same registry and writes a request the parent already polls for.
5. On child completion, the core emits `disposed` on the parent bus; the parent's subscriber calls `registry.unregister(childSessionDir)`.

Why this is the right shape:

- Tell-Don't-Ask / Law of Demeter: callers ask once for the shared registry, then tell it to `register` / `unregister` / `has` / `get`.
  No reach-through, no new collaborator surface.
- SRP: the accessor owns the "where the single instance lives" concern; the class keeps owning the data.
- It deliberately does **not** add a shutdown/unpublish hook for the registry.
  A child's `session_shutdown` must not be able to wipe the parent's registrations.
  Entries are created and removed only by the parent's `session-created` / `disposed` subscription, so no teardown hook is needed and child shutdown leaves the store intact.

### Why not share the event bus instead?

The deeper cause of the regression is that a cross-session signal (`subagents:child:session-created`) was routed over a per-session transport.
Each session's `ResourceLoader` mints its own `pi.events` bus (`resource-loader.ts`: `this.eventBus = options.eventBus ?? createEventBus()`), and the child's loader is built without the parent's bus, so the child subscribes to a different bus than the one the parent publishes on.

Crucially, lifecycle events do **not** travel on `pi.events`.
`pi.on(...)` registers into a per-extension handler map, and the per-session `ExtensionRunner` dispatches lifecycle by iterating those maps — it never routes `tool_call` / `turn_end` / etc. through the bus.
Session isolation (the parent not seeing the child's tool calls) is therefore guaranteed by the per-session `ExtensionRunner`, not by the bus being per-session.
The per-session scope of `pi.events` is incidental to lifecycle correctness.

A per-session `pi.events` is still the right default: intra-session cross-extension coordination must stay scoped, and this package itself depends on it (`registerPermissionRpcHandlers(pi.events, ...)`, `emitReadyEvent(pi.events)`).
The mismatch is using that bus as a cross-session channel, not the bus being per-session.

Rejected alternatives:

- **Pass the parent's bus into the child's loader (share one `pi.events`).**
  Highest blast radius: it would cross *every* extension's intra-session channels between parent and child (this package's RPC and ready events, plus any other extension's pub/sub), breaking the isolation other extensions rely on.
- **Introduce a process-global event bus for cross-session signals.**
  More general, but no such bus exists today; inventing one is broader scope and largely re-creates what `globalThis` + `Symbol.for()` already provides.

The chosen approach keeps per-session buses and moves only the cross-session *state* to a process-global store.
The child never needs to *receive* the event — it only needs to answer "am I a subagent, and who is my parent?", which is a state lookup, not an event.
The parent writes the global registry; the child reads it.
The lifecycle events remain useful for the parent-side registration and telemetry, and the child simply stops depending on receiving them.

Edge cases:

- `/reload`: the parent re-runs `getSubagentSessionRegistry()` and reuses the existing global registry.
  This differs from the previous (broken) per-instance registry, which started empty after every reload; reuse is correct because entries are keyed per child and cleaned on `disposed`, and a reload with no in-flight children leaves an empty store.
- Concurrency: distinct children with distinct session directories register under distinct keys safely.
  Concurrent siblings of one parent share a key (see Open Questions) — pre-existing, unchanged by this fix.

## Module-Level Changes

- `packages/pi-permission-system/src/subagent-registry.ts` — add the `SUBAGENT_SESSION_REGISTRY_KEY` symbol (module-private) and the exported `getSubagentSessionRegistry()` accessor.
  The `SubagentSessionRegistry` class and `SubagentSessionInfo` interface are unchanged.
- `packages/pi-permission-system/src/index.ts` — change the import from `{ SubagentSessionRegistry }` to `{ getSubagentSessionRegistry }` and replace `const subagentRegistry = new SubagentSessionRegistry();` with `const subagentRegistry = getSubagentSessionRegistry();`.
  No other lines change (`SubagentSessionRegistry` is referenced only at the import and that one construction site).
- `packages/pi-permission-system/test/subagent-registry.test.ts` — add a `describe("getSubagentSessionRegistry (process-global accessor)")` block (mirrors the `globalThis accessor` block in `test/service.test.ts`), with an `afterEach` that clears the global slot.
- `packages/pi-permission-system/docs/subagent-integration.md` — the "Deterministic child detection" bullet currently implies in-process detection works via the registry; add that the registry is process-global (`globalThis` + `Symbol.for()`) because parent and child run on separate per-session event buses, which is what makes the child's lookup see the parent's registration.
- `packages/pi-permission-system/docs/architecture/architecture.md` — in the detection-model section (around the `SubagentSessionRegistry` references near lines 417 and 438) add a sentence noting the registry is a process-global singleton shared across per-session buses, and add `getSubagentSessionRegistry` to the `subagent-registry.ts` description in the module listing (around line 538).
- `.pi/skills/package-pi-permission-system/SKILL.md` — extend the "Event-based subagent integration" section: the registry must be process-global because the publisher emits on the parent's bus while the child's instance listens on a separate bus; record this as the durable lesson behind this regression.

No changes to `service.ts`, `subagent-context.ts`, `permission-forwarding.ts`, `forwarding-manager.ts`, or `subagent-lifecycle-events.ts` — they already operate on the injected registry instance.

## Test Impact Analysis

1. New tests enabled: the process-global accessor is new behavior that could not be tested before (the registry was only ever `new`'d directly).
   New cases: returns a `SubagentSessionRegistry`; returns the **same** instance on repeated calls; an entry registered through one returned reference is visible through another (the parent-writes/child-reads property); state is observable across calls within the process.
2. Redundant tests: none.
   The existing `subagent-registry.test.ts` cases construct `new SubagentSessionRegistry()` and exercise `register`/`unregister`/`has`/`get` mechanics — those remain valid and are not duplicated by the accessor tests.
3. Tests that must stay as-is: `subagent-context.test.ts`, `permission-forwarding.test.ts`, and `subagent-lifecycle-events.test.ts` inject a registry instance directly and exercise detection, target resolution, and the subscribe/register/unregister wiring.
   They genuinely cover that layer and are unaffected by where the production instance is stored.

## TDD Order

1. `fix:` — add the process-global accessor.
   Test surface: `test/subagent-registry.test.ts`, new `describe("getSubagentSessionRegistry (process-global accessor)")` block with `afterEach` clearing the global slot via `Symbol.for("@gotgenes/pi-permission-system:subagent-registry")`.
   Red: import `getSubagentSessionRegistry` (does not exist yet) and assert same-instance-on-repeat plus cross-reference state sharing.
   Green: implement `getSubagentSessionRegistry()` and the module-private symbol in `src/subagent-registry.ts`.
   Commit: `fix: add process-global SubagentSessionRegistry accessor (#296)`.
2. `fix:` — wire the composition root to the shared registry.
   Change `src/index.ts` to import and call `getSubagentSessionRegistry()` instead of `new SubagentSessionRegistry()`.
   This is the regression fix; the accessor from step 1 gains its production consumer here (so no dead-export window remains at review time).
   Run `pnpm run check` immediately (composition-root/wiring change) and the full package suite.
   Commit: `fix: share SubagentSessionRegistry across parent and child sessions (#296)`.
3. `docs:` — update `docs/subagent-integration.md`, `docs/architecture/architecture.md`, and `.pi/skills/package-pi-permission-system/SKILL.md` to document the process-global registry and the per-session-bus rationale.
   Commit: `docs: explain process-global subagent registry across session buses (#296)`.

## Risks and Mitigations

- Global state leaking across unit tests.
  Mitigation: the accessor test clears the `Symbol.for(...)` slot in `afterEach`, mirroring `test/service.test.ts`.
  No other test uses the accessor (all others construct the class directly), so cross-file pollution is not possible.
- A child's shutdown wiping the parent's registrations.
  Mitigation by design: no shutdown/unpublish hook is added for the registry; entries are mutated only by the parent's `session-created` / `disposed` subscription.
- Stale entries across `/reload`.
  Mitigation: entries are keyed per child and removed on `disposed`; a reload with no in-flight children leaves an empty store, and the parent reuses the same registry deliberately.
- Release semantics.
  Both code commits use `fix:` so release-please cuts a patch — appropriate for restoring previously-working behavior; the accessor is internal (not part of the published `PermissionsService` surface), so it is not a `feat`.

## Open Questions

- Concurrent sibling children of the same parent share the `<parent-session-dir>/<basename>/tasks` `getSessionDir()` key, so they collide on one registry entry; when one sibling is disposed, `unregister` removes the shared entry and detection breaks for still-running siblings.
  This pre-dates the regression (the old bridge keyed on the same path) and is independent of the event-bus split, so it is out of scope here.
  It is latent today (forwarding is broken end-to-end) but becomes live the moment this fix lands, and is tracked in [#298] (leaning toward keying the registry by the child's session id).
- This regression is an instance of a broader gap: the composition root (`index.ts`) has no test coverage, so wiring faults (a collaborator instantiated instead of shared, a dropped handler, a leaked teardown) slip past the unit suite.
  The practical coverage for *this* fix is the accessor unit test (TDD step 1) plus the existing injected-registry tests; a `makeFakePi()` composition-root harness and the backfill tests that would have caught this class of fault are tracked separately in [#297] and intentionally out of scope here.

[ADR-0002]: https://github.com/gotgenes/pi-packages/blob/main/packages/pi-subagents/docs/decisions/0002-extensions-on-a-minimal-core.md
[#22]: https://github.com/gotgenes/pi-packages/issues/22
[#101]: https://github.com/gotgenes/pi-packages/issues/101
[#261]: https://github.com/gotgenes/pi-packages/issues/261
[#267]: https://github.com/gotgenes/pi-packages/issues/267
[#297]: https://github.com/gotgenes/pi-packages/issues/297
[#298]: https://github.com/gotgenes/pi-packages/issues/298
