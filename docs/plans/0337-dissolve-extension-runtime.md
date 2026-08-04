---
issue: 337
issue_title: "Dissolve ExtensionRuntime; one source of truth for session state"
---

# Dissolve ExtensionRuntime; one source of truth for session state

## Problem Statement

`createExtensionRuntime()` returns a god object literal that mixes path constants, mutable per-session state, mutable `config`, and logging methods.
After Phase 4 Steps 2 and 3 ([#335], [#336]) moved config into `ConfigStore` and made the logger injectable, the runtime object's remaining job is to hold a `PermissionManager`, a `SessionRules`, and the runtime `ExtensionContext` — and to serve as the internal composition root for the config-modal and the deprecated RPC handlers.

The object is a split-brain.
`runtime.permissionManager` and `runtime.sessionRules` are read by the deprecated `permissions:rpc:check` handler, the `/permission-system` config-modal, and `LocalPermissionsService`.
But the gate path uses a *different* `PermissionManager` (the separately-constructed `sessionManager` in `index.ts`) and a *different* `SessionRules` (the one `PermissionSession` constructs internally).
Session approvals recorded by the gate path land in `PermissionSession`'s private `SessionRules`, which the RPC check never sees — so the RPC check reads an empty session-rules set and answers `ask` for a surface the user already approved for the session.

There is a second, quieter split-brain on context: `ConfigStore` reads/writes `runtime.runtimeContext` through a transitional `RuntimeContextRef`, while `PermissionSession` owns its own private `this.context` (set in `activate`).
They are kept in sync only by coincidence of call order at `session_start`.

This issue dissolves the runtime object, establishes a single `PermissionManager` / `SessionRules` / context shared by every consumer, and closes both split-brains.

## Goals

- Fix the session-rules split-brain: the deprecated RPC check, the config-modal, `LocalPermissionsService`, and the gate path read and write the *same* `SessionRules` instance.
- Fix the manager split-brain: those same consumers read the *same* `PermissionManager` instance that `PermissionSession` configures for the project cwd at `session_start`.
- Make `PermissionSession` the single owner of the runtime `ExtensionContext`; retire the transitional `RuntimeContextRef` seam on `ConfigStore`.
- Remove the `ExtensionRuntime` interface and `createExtensionRuntime()` factory entirely; `index.ts` constructs `ExtensionPaths`, the single `PermissionManager`, the single `SessionRules`, the `ConfigStore`, and the logger directly.
- Behavior-preserving except for the two bug fixes above; the suite stays green at every commit.

## Non-Goals

- Collapsing the remaining `index.ts` closure bags into plain object references — that is Step 5 ([#338]) and is sequenced after this step.
- Splitting `PermissionSession`'s six role interfaces into distinct collaborators (`PromptingGateway`, `PermissionResolver`) — Steps 6–8 ([#339], [#340], [#341]).
- Changing the RPC contract, the config-modal UI, the `PermissionsService` surface, or any config-file format.
- Un-deprecating the `permissions:rpc:check` channel; it stays deprecated, it just stops lying.

## Background

Relevant modules (see `docs/architecture/architecture.md` § Module structure):

- `src/runtime.ts` — `ExtensionRuntime` interface (extends `ExtensionPaths` + an internal `SessionState`) and `createExtensionRuntime()`.
  After [#335]/[#336] it constructs the `PermissionManager`, the `SessionRules`, the `ConfigStore` (passing a `RuntimeContextRef` that closes over `runtime.runtimeContext`), and the logger.
- `src/config-store.ts` — `ConfigStore` plus the narrow `SessionConfigStore` / `CommandConfigStore` / `ConfigReader` interfaces and the transitional `RuntimeContextRef`.
  `refresh(ctx?)` and `logResolvedPaths()` reach context through `this.deps.context`.
- `src/permission-session.ts` — owns `this.context`, a private `new SessionRules()`, and an injected `ScopedPermissionManager`.
  Already implements `getRuntimeContext()`, `getSessionRuleset()`, `recordSessionApproval()`, and the lifecycle methods that `configureForCwd` the manager.
- `src/permission-event-rpc.ts` — `registerPermissionRpcHandlers(events, deps)`; `deps.getPermissionManager()`, `deps.getSessionRules()`, `deps.getRuntimeContext()`.
- `src/config-modal.ts` — `registerPermissionSystemCommand(pi, controller)`; `controller.getComposedRules()` reads the manager.
- `src/permissions-service.ts` — `LocalPermissionsService` injected with `PermissionManager` + `SessionRules` + `ToolInputFormatterRegistry`.
- `src/index.ts` — the composition root that wires all of the above to one `ExtensionRuntime`.

Constraints from AGENTS.md and the package skill:

- Default to least privilege; the bug fix only ever *adds* visibility of already-granted session approvals — it never widens policy.
- Keep schema/example/loader/docs aligned — not touched here (no config-format change).
- `PermissionManager`'s narrow `ScopedPermissionManager` interface is the seam `PermissionSession` depends on; RPC depends on `Pick<PermissionManager, "checkPermission">`.
  The composition root owns the single concrete instance and hands each consumer the narrow view it already declares.
- When removing an export that consumers import, fold every consumer + consumer-test update into the same commit (type-coupled).
- When a roadmap step ships, mark it `✓ complete` in `architecture.md` as part of the shipping change.

### Verified: cwd never changes mid-session

[#334] already verified against Pi core that the project cwd is assigned once and never reassigned, and that `/reload` re-emits `session_start` with the same cwd.
A single `PermissionManager`, configured once per session via `configureForCwd(ctx.cwd)`, is therefore correct for every consumer — there is no scenario where the RPC reader and the gate reader need different managers.

## Design Overview

### One PermissionManager, one SessionRules, one context

The composition root owns three shared collaborators and injects each into every consumer that needs it:

```typescript
// index.ts (after dissolution — illustrative)
const agentDir = getAgentDir();
const paths = computeExtensionPaths(agentDir);
const permissionManager = new PermissionManager({ agentDir });
const sessionRules = new SessionRules();

const session = new PermissionSession(
  paths,
  logger,
  forwarding,
  permissionManager, // configured for cwd at session_start
  sessionRules,      // injected, not self-constructed
  configStore,
  runtimeDeps,
);

// RPC, config-modal, service all reference the SAME two instances:
registerPermissionRpcHandlers(pi.events, {
  getPermissionManager: () => permissionManager,
  getSessionRules: () => sessionRules.getRuleset(),
  getRuntimeContext: () => session.getRuntimeContext(),
  // …
});
registerPermissionSystemCommand(pi, {
  config: configStore,
  getConfigPath: () => getGlobalConfigPath(agentDir),
  getComposedRules: () =>
    permissionManager.getComposedConfigRules(
      session.lastKnownActiveAgentName ?? undefined,
    ),
});
const permissionsService = new LocalPermissionsService(
  permissionManager,
  sessionRules,
  formatterRegistry,
);
```

`PermissionSession.recordSessionApproval()` and the RPC `getSessionRules()` now drive and read the same `SessionRules`.
`PermissionSession.resetForNewSession()` calls `permissionManager.configureForCwd(ctx.cwd)` on the same manager the RPC/service/config-modal read, so project-scope config and session approvals are visible everywhere.
`PermissionSession.shutdown()` clears that shared `SessionRules` — which is the desired single-source behavior (approvals end with the session for every reader).

### Inject SessionRules instead of self-constructing it

`PermissionSession` currently does `private readonly sessionRules = new SessionRules()`.
Change it to accept `SessionRules` as a constructor parameter so the composition root owns the single instance.
This is the same DIP move [#334] made for `PermissionManager`.

```typescript
constructor(
  private readonly paths: ExtensionPaths,
  readonly logger: SessionLogger,
  private readonly forwarding: ForwardingController,
  private readonly permissionManager: ScopedPermissionManager,
  private readonly sessionRules: SessionRules,
  private readonly configStore: SessionConfigStore,
  private readonly runtimeDeps: PermissionSessionRuntimeDeps,
) {}
```

`getSessionRuleset()`, `recordSessionApproval()`, and the `clear()` in `shutdown()` are unchanged — they already delegate to `this.sessionRules`.

### PermissionSession owns context; retire RuntimeContextRef

`ConfigStore` stops storing the runtime context.
The two methods that need it receive what they read from the caller, which is `PermissionSession` (the owner):

- `refresh(ctx?: ExtensionContext)` keeps its signature but uses the passed `ctx` directly for `cwd`, `hasUI` status sync, and the warning `ui.notify` — no `context.set` / `context.get`.
  The only no-`ctx` caller is the factory-init `configStore.refresh()`, where the cwd is legitimately unknown (`null`), exactly as today.
- `logResolvedPaths(cwd?: string)` gains a `cwd` parameter; `PermissionSession.logResolvedConfigPaths()` passes `this.context?.cwd`.

`ConfigStoreDeps` drops its `context: RuntimeContextRef` field (4 → 3 fields), and the `RuntimeContextRef` interface is deleted from `config-store.ts`.

Call-order check at `session_start` (unchanged ordering, preserved behavior):

1. `session.refreshConfig(ctx)` → `configStore.refresh(ctx)` — uses `ctx.cwd`, notifies warnings via `ctx.ui`.
2. `session.resetForNewSession(ctx)` → `activate(ctx)` sets `this.context = ctx` and `configureForCwd(ctx.cwd)`.
3. `session.logResolvedConfigPaths()` → `configStore.logResolvedPaths(this.context?.cwd)` — `this.context` is set by step 2.

The RPC prompt handler's `getRuntimeContext` and the lifecycle handler's `getRuntimeContext` both already route through `session.getRuntimeContext()` after this change, so the context split-brain is closed by construction.

### Logger notify sink

The logger's IO-failure notify sink currently reads `runtime.runtimeContext?.ui.notify`.
It becomes `(message) => session.getRuntimeContext()?.ui.notify(message, "warning")`.
This is a forward reference: `session` is constructed after the logger (the logger is a `PermissionSession` dependency), so `index.ts` declares `let session` before the logger and assigns it after.
This mirrors the existing `getConfig: () => configStore.current()` forward-reference pattern already used in `createExtensionRuntime`, so it introduces no new idiom.

### Delete runtime.ts

After removing the `ExtensionRuntime` interface, the internal `SessionState` interface, and `createExtensionRuntime()`, the only remaining content of `runtime.ts` is `export type { ExtensionPaths } from "./extension-paths"`.
No module imports `ExtensionPaths` from `runtime.ts` (consumers already import it from `extension-paths.ts`), so the file is deleted outright rather than left as a re-export shell.

### Edge cases

- Factory-init `configStore.refresh()` with no `ctx`: cwd `null`, no status sync, no notify — identical to today.
- `reload` via `resources_discover`: `session.reload()` reconfigures the shared manager and clears caches; it does not refresh config (unchanged).
- Subagent child: context ownership and instance sharing are per-session-instance; the process-global service slot logic ([#302]) is untouched.

## Module-Level Changes

- `src/runtime.ts` — deleted.
  Removes `ExtensionRuntime`, the internal `SessionState`, `createExtensionRuntime()`, and the `ExtensionPaths` re-export.
- `src/permission-session.ts` — add `sessionRules: SessionRules` constructor parameter (between `permissionManager` and `configStore`); remove the internal `private readonly sessionRules = new SessionRules()` field initializer.
  Update the constructor doc comment that references "where the `ExtensionRuntime` is available".
- `src/config-store.ts` — delete the `RuntimeContextRef` interface; remove `context` from `ConfigStoreDeps`; rework `refresh(ctx?)` to use the passed `ctx` directly; change `logResolvedPaths()` to `logResolvedPaths(cwd?: string)`; update `SessionConfigStore.logResolvedPaths` accordingly and its doc comment.
- `src/index.ts` — remove `createExtensionRuntime` import; construct `paths` (`computeExtensionPaths`), `permissionManager`, `sessionRules`, `configStore`, and `logger` directly; remove the separate `sessionManager`; route every `runtime.*` reference to the new locals; point RPC `getRuntimeContext` and the logger notify sink at `session.getRuntimeContext()`; point config-modal `getComposedRules` at `session.lastKnownActiveAgentName`.
- `src/permissions-service.ts` — no signature change; update the class doc comment that references "the runtime's permission manager".
- `test/runtime.test.ts` — deleted (see Test Impact Analysis).
- `test/config-store.test.ts` — remove the `makeContextRef` helper and `RuntimeContextRef` import; pass `ctx` directly to `refresh`; pass `cwd` to `logResolvedPaths`; rewrite the two context-seam tests ("updates context via context.set", "does not overwrite context when ctx is omitted") as ctx-parameter behavior.
- `test/permission-session.test.ts` — update `createSession` to inject a `SessionRules` (real instance or narrow mock) into the new constructor slot.
- `test/composition-root.test.ts` — add the single-source-of-truth characterization tests (gate session-approval visible to the RPC check and the service).
- `docs/architecture/architecture.md` — remove the `runtime.ts` line from § Module structure; update the `config-store.ts` line to drop the "`RuntimeContextRef` context seam (#335)" note; the Finding 3 / metrics rows (`as unknown as ExtensionRuntime` ×3, `runtime`-as-first-arg free functions) move toward zero — update if the shipping commit refreshes metrics.
  Mark Step 4 `✓ complete` at ship time.

No removed symbol is referenced by `.pi/skills/package-pi-permission-system/SKILL.md` (it does not name `ExtensionRuntime`, `createExtensionRuntime`, or `RuntimeContextRef`).

## Test Impact Analysis

New unit/integration tests this change enables:

- Composition-root characterization tests proving the gate path and the RPC/service path share one `SessionRules` — previously impossible to assert because the gate recorded into a different instance than the readers saw.
  These are the regression guards for the headline bug.

Existing tests that become redundant:

- `test/runtime.test.ts` is deleted.
  Its path-derivation cases (sessionsDir, subagentSessionsDir, forwardingDir, globalLogsDir, `piInfrastructureDirs`, null-discovery omission) are already covered one-for-one by `test/extension-paths.test.ts` against `computeExtensionPaths`.
  Its default-config case is covered by `config-store.test.ts`; its logger-construction wiring moves into `index.ts` and is exercised by `composition-root.test.ts` + `session-logger.test.ts`.
  No coverage is lost.

Existing tests that must stay as-is (they exercise the layers, not the runtime wrapper):

- `test/permission-event-rpc.test.ts`, `test/config-modal.test.ts`, `test/permissions-service.test.ts` — these unit-test the handlers with injected mock deps and are agnostic to which concrete instances the composition root supplies.
  They do not change; the bug lived only in the wiring, so the proof lives at the composition root.
- `test/config-store.test.ts` keeps its config-load, save, and resolved-path coverage; only the context-seam plumbing changes.

## TDD Order

1. `fix:` — single source of truth for session state.
   Test surface: `test/composition-root.test.ts` — new `describe("single source of truth for session state")`.
   Add a characterization test that writes a global config (`permission: { "*": "allow", demo: "ask" }`), fires `session_start` with a UI `ctx` whose `ui.select` returns `options[1]` (the "for this session" option, robust to label text), drives a `tool_call` on `demo` so the gate records a session approval, then issues a `permissions:rpc:check` for `surface: "demo"` and asserts the reply `result` is `"allow"` (it is `"ask"` before the fix); also assert `getPermissionsService().checkPermission("demo")` reports `allow`.
   Implementation in the same commit: in `index.ts`, drop the separate `sessionManager` and pass the runtime's single `PermissionManager` to `PermissionSession`; inject the runtime's single `SessionRules` into `PermissionSession` (new constructor slot); update `test/permission-session.test.ts` `createSession` to supply the `SessionRules`.
   The `ExtensionRuntime` object still exists at this point — this commit fixes the bug with the minimum structural change.
   Suggested message: `fix: share one PermissionManager and SessionRules across gate and RPC paths (#337)`.

2. `refactor:` — dissolve `ExtensionRuntime`.
   Test surface: existing suite stays green (`composition-root`, `config-store`, `permission-session`).
   Inline-construct `paths` / `permissionManager` / `sessionRules` / `configStore` / `logger` in `index.ts`; move context ownership fully to `PermissionSession`; retire `RuntimeContextRef` (rework `ConfigStore.refresh(ctx?)` to use the passed ctx, change `logResolvedPaths()` → `logResolvedPaths(cwd?)`, drop `context` from `ConfigStoreDeps`); point the logger notify sink and RPC `getRuntimeContext` at `session.getRuntimeContext()`; delete `src/runtime.ts`; delete `test/runtime.test.ts`; update `test/config-store.test.ts` (remove `makeContextRef`, pass ctx/cwd directly); update the doc comments in `permission-session.ts` and `permissions-service.ts`.
   This is behavior-preserving — the bug was already fixed in step 1 — so every commit leaves the suite green.
   Suggested message: `refactor: dissolve ExtensionRuntime god object (#337)`.

3. `docs:` — architecture sync.
   Remove the `runtime.ts` line from § Module structure; drop the `RuntimeContextRef` note on the `config-store.ts` line; refresh the Finding 3 / constructibility-metric rows that referenced `ExtensionRuntime` and the runtime-arg free functions.
   Suggested message: `docs: update architecture for dissolved ExtensionRuntime (#337)`. (Marking the roadmap step `✓ complete` is done at ship time per the package skill.)

## Risks and Mitigations

- Risk: the type-coupled removal of `createExtensionRuntime` and the `RuntimeContextRef`/constructor changes break compilation across `index.ts`, `config-store.ts`, `permission-session.ts`, and their tests.
  Mitigation: split the bug fix (step 1) from the structural dissolution (step 2); each step folds all consumer + consumer-test updates into one commit and is verified with `pnpm run check` + `pnpm -r run test` before committing.
- Risk: the logger notify sink's forward reference to `session` could fire before `session` is assigned (factory-init `configStore.refresh()`).
  Mitigation: at factory init there is no UI context anyway; `session?.getRuntimeContext()` resolves to `undefined` and no notify occurs — identical to the current `runtime.runtimeContext` being `null` at init.
- Risk: a behavior change sneaks in via the context-seam retirement (e.g. `refresh` without `ctx` losing a previously-set context).
  Mitigation: the only no-`ctx` caller is the one-time factory-init refresh, which never had a prior context; the design-overview call-order check confirms `session_start` ordering is preserved.
- Risk: deleting `runtime.test.ts` drops coverage.
  Mitigation: the Test Impact Analysis maps every `runtime.test.ts` case to an equivalent in `extension-paths.test.ts` / `config-store.test.ts` / `composition-root.test.ts`.

## Open Questions

- Whether to also add a manager-split-brain regression test (project-scope config visible to the RPC check after `configureForCwd`).
  Defer-until-needed: composition-root tests write to the global config path, so the session-rules characterization test is the clearer and sufficient guard; add the manager case only if a regression appears.

[#302]: https://github.com/gotgenes/pi-packages/issues/302
[#334]: https://github.com/gotgenes/pi-packages/issues/334
[#335]: https://github.com/gotgenes/pi-packages/issues/335
[#336]: https://github.com/gotgenes/pi-packages/issues/336
[#338]: https://github.com/gotgenes/pi-packages/issues/338
[#339]: https://github.com/gotgenes/pi-packages/issues/339
[#340]: https://github.com/gotgenes/pi-packages/issues/340
[#341]: https://github.com/gotgenes/pi-packages/issues/341
