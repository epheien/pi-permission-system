---
issue: 338
issue_title: "Collapse the index.ts closure bags into object references"
---

# Collapse the `index.ts` closure bags into object references

## Problem Statement

`index.ts` is the composition root, and it carries roughly twenty `() =>` / `.bind` adapter closures.
These are not intrinsic wiring — they are scar tissue from the now-dissolved runtime god object.
`() => runtime.config` thunks existed because config was mutable shared state; `runtime.writeReviewLog.bind(runtime)` adapters existed because the logging operations were free functions; `(ctx) => refreshExtensionConfig(runtime, ctx)` wrapped each runtime free-function.

With Phase 4 Steps 2–4 done (`ConfigStore` owns config, the logger is an injectable object, the runtime ops are methods, and `PermissionManager` / `SessionRules` are single shared instances), each consumer can now receive the real collaborator object and call its methods directly.
The adapter closures collapse to plain object references.

This is Phase 4 Step 5 (Track B).
It is behavior-preserving: only the shape of the dependency wiring changes, not what the extension does.

## Goals

- Replace the logging/config adapter closures in `index.ts` with direct references to the shared `logger`, `ConfigStore`, `PermissionManager`, `SessionRules`, and `PermissionSession` collaborators.
- Shrink the deps interfaces on `PermissionPrompter`, `PermissionSession`, the command controller, the RPC handlers, `ConfigStore`, and `PermissionForwarder` so each accepts the collaborator object (or a narrow interface over it) instead of a bag of adapter functions.
- Unify all logging on the single `SessionLogger` object via narrow `ReviewLogger` / `DebugReviewLogger` seam interfaces, eliminating the duplicated `writeReviewLog` field on the forwarder.
- Keep the suite green and verify the composition root via `test/composition-root.test.ts`.

This is not a breaking change to any published API: every interface touched is internal to the package.

## Non-Goals

- Extracting the `PromptingGateway` that owns the stored context, `canConfirm()`, and the prompt twins — that is Phase 4 Step 6 ([#339]).
  The `canRequestPermissionConfirmation` closure on `PermissionSessionRuntimeDeps` legitimately remains until then.
- Extracting the `PermissionResolver` collaborator ([#340]) or slimming `PermissionSession` to a state/lifecycle owner ([#341]).
- Removing the two forward-reference cycle closures in the logger construction (`getConfig`, `notify`) — see Design Overview; per project direction these stay as idiomatic forward-reference closures (the pi-subagents pattern), not setter-injected mutations.
- Any change to log file format, config schema, or permission semantics.

## Background

Relevant modules and their current adapter-closure relationships in `src/index.ts`:

- `createSessionLogger({ globalLogsDir, getConfig, notify })` — the logger reads config toggles via `getConfig: () => configStore.current()` and surfaces UI warnings via `notify: (m) => sessionNotify?.getRuntimeContext()?.ui.notify(...)`.
  Both are forward-reference closures: the logger is built before `configStore` and before `session`.
- `ConfigStore` — its `ConfigStoreLogger` dep (`{ writeDebugLog, writeReviewLog }`) is fed two arrow adapters wrapping `logger.debug` / `logger.review`.
- `PermissionForwarder` — its deps carry `logger: ForwardedPermissionLogger` (two adapters), a duplicated top-level `writeReviewLog` adapter, and `shouldAutoApprove: () => shouldAutoApprovePermissionState("ask", configStore.current())`.
- `PermissionPrompter` — `writeReviewLog: (e, d) => logger.review(e, d)`.
- `PermissionSession` runtime deps — `promptPermission: (ctx, d) => prompter.prompt(ctx, d)` and `canRequestPermissionConfirmation: (ctx) => canResolveAskPermissionRequest({...})`.
- The `/permission-system` command controller — `getConfigPath: () => getGlobalConfigPath(agentDir)` and `getComposedRules: () => permissionManager.getComposedConfigRules(session.lastKnownActiveAgentName ?? undefined)`.
- The RPC handlers — `getPermissionManager`, `getSessionRules`, `getRuntimeContext`, and `writeReviewLog` closures.
- `toolRegistry` — `getAll: () => pi.getAllTools()`, `setActive: (n) => pi.setActiveTools(n)`.
- Six `pi.on(...)` event handler arrows.

Why the closures are now collapsible:

- The config-read thunks returned `configStore.current()`; consumers can hold the `ConfigStore` object (a `ConfigReader`) and call `.current()` themselves.
- The logging adapters wrapped `logger.review` / `logger.debug` to bridge method-name mismatches and to avoid `@typescript-eslint/unbound-method`.
  Passing the `logger` object and calling `this.deps.logger.review(...)` as a method avoids the unbound-method rule (it is a method call on a stored object, not a bare value) and removes the adapter.
- The RPC `getPermissionManager` / `getSessionRules` / `getRuntimeContext` closures returned single shared instances (after [#334] / [#337]); passing the objects and calling their methods at handle time preserves the same liveness.

Constraint from AGENTS.md and the package skill: keep schema/example/docs aligned (not touched here — no config change); the `session-created` handler must stay synchronous (not touched); use `#src/` path aliases for sibling imports.

## Design Overview

### The two logger cycles stay as forward-reference closures

The logger participates in two genuine construction cycles:

- Logger ↔ `ConfigStore`: the logger reads the debug/review toggles from config; `ConfigStore` writes the debug log.
- Logger ↔ `PermissionSession`: the logger surfaces UI warnings through the session's runtime context; the session is constructed with the logger as a constructor argument.

Per project direction (matching the pi-subagents composition root), these are resolved with forward-reference closures that capture the not-yet-assigned variable by reference — not with setter methods on the logger and not by restructuring the toggle-read into a push model.
So `getConfig` and `notify` remain as the only two closures in the logger construction, and the logger object itself is built before `configStore` and `session`.

Crucially, because the logger object is fully built first, every *other* consumer (`ConfigStore`, `PermissionForwarder`, `PermissionPrompter`, the RPC handlers, `PermissionSession`) receives the `logger` object directly — their logging adapters all collapse.

### Unify logging on narrow seam interfaces

Add two narrow interfaces to `session-logger.ts` so consumers depend only on what they use (ISP), and `SessionLogger` satisfies all of them:

```typescript
export interface ReviewLogger {
  review(event: string, details?: Record<string, unknown>): void;
}

export interface DebugReviewLogger extends ReviewLogger {
  debug(event: string, details?: Record<string, unknown>): void;
}

export interface SessionLogger extends DebugReviewLogger {
  warn(message: string): void;
}
```

Consumers depend on the narrowest slice:

- `PermissionPrompter`, RPC handlers → `ReviewLogger`.
- `ConfigStore`, `PermissionForwarder` (and `forwarded-permissions/io.ts`) → `DebugReviewLogger`.

This lets `index.ts` pass the one `logger` object everywhere with zero adapters.
`ConfigStoreLogger` is deleted; `ForwardedPermissionLogger` is replaced by `DebugReviewLogger` (its `writeReviewLog` / `writeDebugLog` methods rename to `review` / `debug`).

### Resulting deps shapes

```typescript
// config-store.ts
interface ConfigStoreDeps {
  agentDir: string;
  policyPaths: ResolvedPolicyPathProvider;
  logger: DebugReviewLogger; // was ConfigStoreLogger
}

// permission-prompter.ts
interface PermissionPrompterDeps {
  config: ConfigReader;
  logger: ReviewLogger; // was writeReviewLog(event, details)
  events: PermissionEventBus;
  forwarder: ApprovalRequester;
}

// forwarded-permissions/permission-forwarder.ts
interface PermissionForwarderDeps {
  forwardingDir: string;
  subagentSessionsDir: string;
  registry?: SubagentSessionRegistry;
  events?: PermissionEventBus;
  logger: DebugReviewLogger; // merges old logger + duplicated writeReviewLog
  requestPermissionDecisionFromUi: /* unchanged bare function */;
  config: ConfigReader; // was shouldAutoApprove: () => boolean
}

// permission-event-rpc.ts
interface PermissionRpcDeps {
  permissionManager: Pick<PermissionManager, "checkPermission">; // was getPermissionManager()
  sessionRules: Pick<SessionRules, "getRuleset">; // was getSessionRules()
  session: { getRuntimeContext(): ExtensionContext | null }; // was getRuntimeContext()
  requestPermissionDecisionFromUi: /* unchanged */;
  logger: ReviewLogger; // was writeReviewLog
}

// config-modal.ts
interface PermissionSystemConfigController {
  config: CommandConfigStore;
  configPath: string; // was getConfigPath(): string
  permissionManager: { getComposedConfigRules(agentName?: string): Ruleset };
  session: { readonly lastKnownActiveAgentName: string | null };
}

// permission-session.ts
interface PermissionSessionRuntimeDeps {
  canRequestPermissionConfirmation(ctx: ExtensionContext): boolean; // kept (Step 6 / #339)
  prompter: PermissionPrompterApi; // was promptPermission(ctx, details)
}
```

`requestPermissionDecisionFromUi` is already passed as a bare imported function reference (not a closure) in both the forwarder and RPC deps; it stays.

### Consumer call-site sketches (verify Tell-Don't-Ask / LoD)

The command controller computes the composed rules from the two injected references rather than receiving a pre-bound thunk:

```typescript
// config-modal.ts handleArgs, "show" branch
const rules = controller.permissionManager.getComposedConfigRules(
  controller.session.lastKnownActiveAgentName ?? undefined,
);
```

The RPC check handler asks each injected collaborator directly:

```typescript
const sessionRules = deps.sessionRules.getRuleset();
const result = deps.permissionManager.checkPermission(surface, input, agentName ?? undefined, sessionRules);
// ...
deps.logger.review("permission_request.rpc_prompt", { ... });
```

`PermissionForwarder` reads config and logs through its own injected objects (the duplicated review field is gone):

```typescript
if (shouldAutoApprovePermissionState("ask", this.config.current())) {
  this.logger.review("forwarded_permission.auto_approved", details);
  // ...
}
```

These are all single-level method calls on injected collaborators (ask the object for what you need), not reach-through chains.

### `index.ts` closure budget after this step

| Closure / adapter                          | Count | Disposition                                                        |
| ------------------------------------------ | ----- | ------------------------------------------------------------------ |
| `pi.on(...)` handlers                      | 6     | Legitimate event wiring (permanent)                                |
| `toolRegistry` `getAll` / `setActive`      | 2     | Legitimate SDK adapter (permanent)                                 |
| logger `getConfig` / `notify`              | 2     | Forward-reference cycle closures (permanent; pi-subagents pattern) |
| session `canRequestPermissionConfirmation` | 1     | Transitional — removed by Step 6 ([#339])                          |

So `index.ts` drops from ~20 to 11 (10 after Step 6).
The roadmap's "≤ 8" target assumed the two logger cycle closures would also collapse; with the no-setter / forward-reference-closure direction they remain as the idiomatic floor.
The architecture metric and Step 5 outcome note are updated to record this (20 → 11) rather than leaving the optimistic ≤ 8.

### Design-review checklist

| Smell               | Location                                                      | Finding                                                                                                          | Resolution                                                                 |
| ------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Dependency width    | every consumer deps bag                                       | Adapter-function fields replaced by collaborator objects; forwarder loses `writeReviewLog` + `shouldAutoApprove` | Narrower, object-based deps                                                |
| LoD violation       | logger `notify` chain `session.getRuntimeContext().ui.notify` | Reach-through remains inside the kept cycle closure                                                              | Out of scope; addressed when prompting/context ownership moves (Steps 6/8) |
| Output arguments    | none                                                          | No writes back into received deps                                                                                | —                                                                          |
| Parameter relay     | adapter closures relaying to one method                       | Removed by passing the object                                                                                    | Fixed here                                                                 |
| Test mock depth     | consumer tests                                                | Bare-function mocks become `{ review: vi.fn() }` object mocks; no new casts                                      | Improved                                                                   |
| Missing abstraction | scattered logging adapters                                    | The shared `SessionLogger` object + `ReviewLogger` / `DebugReviewLogger` seams                                   | Introduced here                                                            |

## Module-Level Changes

- `src/session-logger.ts` — add `ReviewLogger` and `DebugReviewLogger`; make `SessionLogger extends DebugReviewLogger`.
- `src/config-store.ts` — `ConfigStoreDeps.logger: DebugReviewLogger`; delete the `ConfigStoreLogger` interface; change internal `this.deps.logger.writeDebugLog` / `writeReviewLog` calls to `.debug` / `.review`.
- `src/permission-prompter.ts` — replace `writeReviewLog` dep with `logger: ReviewLogger`; `writeReviewEntry` calls `this.deps.logger.review(...)`.
- `src/permission-event-rpc.ts` — reshape `PermissionRpcDeps` to `{ permissionManager, sessionRules, session, requestPermissionDecisionFromUi, logger }`; update `handleCheckRpc` / `handlePromptRpc` bodies (`deps.getPermissionManager()` → `deps.permissionManager`, `deps.getSessionRules()` → `deps.sessionRules.getRuleset()`, `deps.getRuntimeContext()` → `deps.session.getRuntimeContext()`, `deps.writeReviewLog` → `deps.logger.review`).
- `src/forwarded-permissions/io.ts` — rename `ForwardedPermissionLogger` to use `review` / `debug` (alias to `DebugReviewLogger` imported from `#src/session-logger`); update the 4 internal `logger?.writeReviewLog` / `writeDebugLog` calls.
- `src/forwarded-permissions/permission-forwarder.ts` — merge `logger` + the duplicated `writeReviewLog` into one `logger: DebugReviewLogger`; replace `shouldAutoApprove` with `config: ConfigReader`; update internals (`this.writeReviewLog(...)` → `this.logger.review(...)`, `this.shouldAutoApprove()` → `shouldAutoApprovePermissionState("ask", this.config.current())`); import `shouldAutoApprovePermissionState` and `ConfigReader`.
- `src/config-modal.ts` — `PermissionSystemConfigController`: replace `getConfigPath(): string` with `configPath: string`; replace optional `getComposedRules?()` with `permissionManager` + `session` narrow refs; `handleArgs` computes the composition inline.
- `src/permission-session.ts` — `PermissionSessionRuntimeDeps`: replace `promptPermission` with `prompter: PermissionPrompterApi`; `prompt()` calls `this.runtimeDeps.prompter.prompt(ctx, details)`.
- `src/index.ts` — collapse the logging/config/rule adapter closures into direct `logger` / `configStore` / `permissionManager` / `sessionRules` / `session` / `prompter` references; precompute `configPath: getGlobalConfigPath(agentDir)`; keep the two logger cycle closures, `canRequestPermissionConfirmation`, `toolRegistry`, and the six `pi.on` handlers.
- `docs/architecture/architecture.md` — update the `index.ts` closures + `.bind` adapters metric (20 → 11 with the budget breakdown) and the Step 5 outcome note; the `✓ complete` mark is added during shipping per the package skill.
- Tests updated alongside their consumers (see TDD Order): `test/config-store.test.ts`, `test/permission-prompter.test.ts`, `test/permission-event-rpc.test.ts`, `test/forwarded-permissions/io.test.ts`, `test/permission-forwarder.test.ts`, `test/config-modal.test.ts`, `test/permission-session.test.ts`, `test/composition-root.test.ts`.

`ConfigStoreLogger` and `ForwardedPermissionLogger` are referenced only in historical `docs/plans/` and `docs/retro/` files (and not in `.pi/skills/`); historical docs are left untouched.

## Test Impact Analysis

1. New tests enabled — minimal; this is interface reshaping, not new extraction.
   Consumer unit tests now build simple object mocks (`{ review: vi.fn() }`, `{ debug: vi.fn(), review: vi.fn() }`, `{ getRuleset: vi.fn() }`) instead of bare-function mocks, which is closer to how production wires them and removes a small amount of indirection.
2. Redundant tests — none become redundant; no test is deleted.
   Existing assertions on `writeReviewLog(...)` calls migrate to `logger.review(...)` on the object mock.
3. Tests that must stay — all behavioral tests for the forwarder, prompter, RPC, config-store, config-modal, and session continue to exercise the same behavior through the reshaped deps.
   `test/composition-root.test.ts` (handler-registration completeness, single-source-of-truth, teardown, subagent registry sharing) is the primary behavior-preserving guard and stays green throughout; extend it to assert the command and RPC paths operate against the injected objects.

## TDD Order

Each cycle reshapes one consumer's deps interface and folds its test updates and the matching `index.ts` wiring change into the same commit, because an interface-shape change breaks the consumer's construction at the type level immediately (AGENTS.md rule).

1. `refactor:` add narrow logger seams and migrate `ConfigStore`.
   Surface: `test/config-store.test.ts`.
   Add `ReviewLogger` / `DebugReviewLogger` to `session-logger.ts`; change `ConfigStoreDeps.logger` to `DebugReviewLogger`; delete `ConfigStoreLogger`; update internal calls; update the 7 test mock references (`{ writeDebugLog, writeReviewLog }` → `{ debug, review }`); pass `logger` to `ConfigStore` in `index.ts` (removes 2 closures).
   Commit: `refactor: pass the session logger directly to ConfigStore`.
2. `refactor:` migrate `PermissionPrompter`.
   Surface: `test/permission-prompter.test.ts`.
   Replace `writeReviewLog` dep with `logger: ReviewLogger`; update the ~28 test references and assertions; pass `logger` in `index.ts` (removes 1 closure).
   Commit: `refactor: inject the session logger into PermissionPrompter`.
3. `refactor:` migrate the RPC handlers.
   Surface: `test/permission-event-rpc.test.ts`, `test/composition-root.test.ts`.
   Reshape `PermissionRpcDeps` to object references; update handler bodies and test mocks; pass `permissionManager` / `sessionRules` / `session` / `logger` in `index.ts` (removes 4 closures); add a composition-root assertion that an RPC check resolves against the injected manager + rules.
   Commit: `refactor: inject collaborators into the permission RPC handlers`.
4. `refactor:` migrate `PermissionForwarder` and the forwarding IO logger.
   Surface: `test/forwarded-permissions/io.test.ts`, `test/permission-forwarder.test.ts`.
   Rename `ForwardedPermissionLogger` → `DebugReviewLogger` (4 `io.ts` calls + 12 io-test refs + 2 forwarder-test refs); merge `logger` + duplicated `writeReviewLog` into one `logger`; replace `shouldAutoApprove` with `config: ConfigReader`; update forwarder internals; pass `logger` + `configStore` in `index.ts` (removes 4 closures).
   Commit: `refactor: inject the session logger and config reader into PermissionForwarder`.
5. `refactor:` migrate the `/permission-system` command controller.
   Surface: `test/config-modal.test.ts`.
   Replace `getConfigPath()` with `configPath: string` and `getComposedRules?()` with `permissionManager` + `session` narrow refs; compute the composition inline in `handleArgs`; update the test controller mocks; pass `configPath` + objects in `index.ts` (removes 2 closures).
   Commit: `refactor: pass config path and rule sources to the command controller`.
6. `refactor:` migrate `PermissionSession` prompting dep.
   Surface: `test/permission-session.test.ts`, `test/composition-root.test.ts`.
   Replace `promptPermission` with `prompter: PermissionPrompterApi`; `prompt()` delegates to `this.runtimeDeps.prompter.prompt`; update the session test mock; pass the `prompter` object in `index.ts` (removes 1 closure); leave `canRequestPermissionConfirmation` for Step 6.
   Commit: `refactor: inject the prompter into PermissionSession as an object reference`.
7. `docs:` update the architecture roadmap.
   Update the `index.ts` closures metric (20 → 11 with the budget breakdown) and the Step 5 outcome note explaining the retained cycle closures.
   Commit: `docs: update architecture metrics for collapsed index.ts wiring (#338)`.

## Risks and Mitigations

- Import cycle from the forwarder importing `yolo-mode` and `ConfigReader`.
  Mitigation: verified `yolo-mode.ts` imports only `extension-config` and `types`, and `config-store.ts` does not import the forwarder — no cycle.
  Re-run `pnpm run check` after cycle 4.
- The `ForwardedPermissionLogger` rename ripples through `io.ts` and two test files.
  Mitigation: only 4 internal `io.ts` call sites; the rename is mechanical and confined to cycle 4 with its tests in the same commit.
- `@typescript-eslint/unbound-method` re-triggering.
  Mitigation: consumers call `this.deps.logger.review(...)` as a method on a stored object (not a bare reference), which the rule allows; no arrow wrappers are reintroduced.
- Behavior drift in the RPC / command paths (they now call methods on objects instead of pre-bound thunks).
  Mitigation: the objects are the same single shared instances the thunks returned (post-[#334] / [#337]); `composition-root.test.ts` asserts the end-to-end paths.

## Open Questions

- Whether to add `globalConfigPath` to `ExtensionPaths` rather than recomputing `getGlobalConfigPath(agentDir)` for the command's `configPath`.
  Deferred: recomputing once at construction is a value reference, not a closure, and adding it to `ExtensionPaths` is out of scope for this step.

[#334]: https://github.com/gotgenes/pi-packages/issues/334
[#337]: https://github.com/gotgenes/pi-packages/issues/337
[#339]: https://github.com/gotgenes/pi-packages/issues/339
[#340]: https://github.com/gotgenes/pi-packages/issues/340
[#341]: https://github.com/gotgenes/pi-packages/issues/341
