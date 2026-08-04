---
issue: 335
issue_title: "Extract a ConfigStore from the runtime free-functions"
---

# Extract a ConfigStore from the runtime free-functions

## Problem Statement

The extension's mutable config lives as a reassigned field (`config`) on the `ExtensionRuntime` god object, and its operations are free functions that take that god object as their first argument: `refreshExtensionConfig(runtime, ctx)`, `saveExtensionConfig(runtime, next, ctx)`, and `logResolvedConfigPaths(runtime)`.
Because the value is reassigned on every refresh/save and the operations are free functions, every consumer captures a `() => runtime.config` closure to read the live value — four such closures across `index.ts` and the runtime factory.
Config has no owner.

This is Phase 4 Step 2 (Track B: De-god the runtime) from `docs/architecture/architecture.md` — the first link in the chain `ConfigStore → injectable logger → dissolve runtime → collapse index.ts closures`.
It is behavior-preserving.

## Goals

- Introduce `src/config-store.ts` — a `ConfigStore` class that privately owns `config` + `lastConfigWarning` and exposes `current()` / `refresh(ctx?)` / `save(next, ctx)` / `logResolvedPaths()`.
- Convert the three `(runtime, …)` config free functions into `ConfigStore` methods; the runtime no longer carries `config` / `lastConfigWarning`.
- Give the config consumers (`PermissionSession`, `PermissionPrompter`, the `/permission-system` command controller) a `ConfigStore` / `ConfigReader` reference so they call `store.current()` instead of capturing `() => runtime.config`.
- Behavior-preserving: no observable change to config loading, saving, warnings, status sync, or resolved-path logging.

## Non-Goals

- Moving the runtime context (`runtimeContext`) ownership into the store.
  The roadmap deliberately scopes this store to `config` + `lastConfigWarning`; context unification onto `PermissionSession` is Step 4 (#337).
  Until then the store reads/writes the still-runtime-owned context through a narrow transitional seam.
- Making the logger injectable / removing `createSessionLogger(runtime)` — Step 3 (#336).
- Dissolving `ExtensionRuntime` or fixing the `permissionManager` / `sessionRules` split-brain — Step 4 (#337).
- Collapsing the remaining `index.ts` closure bags and `.bind` logging adapters into object references, and shrinking the `PermissionPrompter` / command / RPC deps bags beyond the config fields — Step 5 (#338).
- Any `PermissionSession` god-object decomposition (Steps 6-8).

## Background

Relevant modules:

- `src/runtime.ts` — defines `ExtensionRuntime` (extends `ExtensionPaths` + `SessionState`, adds `config`, `lastConfigWarning`, `writeDebugLog`, `writeReviewLog`), the three config free functions, and the `createExtensionRuntime()` factory.
  `refreshExtensionConfig` reads/writes `runtime.runtimeContext`, reads `runtime.agentDir`, mutates `runtime.config` + `runtime.lastConfigWarning`, syncs status, notifies, and writes the debug log.
  `saveExtensionConfig` is self-contained on its passed `ExtensionCommandContext` (no `runtime.runtimeContext` read), mutates `runtime.config` + `runtime.lastConfigWarning`, and writes the debug log.
  `logResolvedConfigPaths` reads `runtime.permissionManager.getResolvedPolicyPaths()` and `runtime.runtimeContext?.cwd`, then writes the review + debug logs.
- `src/index.ts` — the composition root.
  Four `() => runtime.config` closures (`prompter`, `session` runtimeDeps, the command controller, and the logger `getConfig` inside the factory), plus the `(ctx) => refreshExtensionConfig(runtime, ctx)` / `() => logResolvedConfigPaths(runtime)` session wrappers, the `(next, ctx) => saveExtensionConfig(runtime, next, ctx)` command wrapper, the `shouldAutoApprove: () => shouldAutoApprovePermissionState("ask", runtime.config)` forwarding dep, and `refreshExtensionConfig(runtime)` (the initial pre-session refresh).
- `src/permission-session.ts` — `PermissionSessionRuntimeDeps` carries `refreshExtensionConfig(ctx?)`, `logResolvedConfigPaths()`, `getConfig()` (plus `canRequestPermissionConfirmation` + `promptPermission`).
  The session's `config` getter, `refreshConfig`, and `logResolvedConfigPaths` delegate to those three members; `getInfrastructureReadDirs` and `getToolPreviewLimits` read `this.config`.
- `src/permission-prompter.ts` — `PermissionPrompterDeps.getConfig()` feeds the yolo-mode auto-approve check.
- `src/config-modal.ts` — `PermissionSystemConfigController.getConfig()` + `setConfig(next, ctx)` (plus `getConfigPath`, `getComposedRules`).
- `src/session-logger.ts` — `createSessionLogger(runtime)` reads `runtime.writeDebugLog` / `writeReviewLog` / `runtimeContext`; it does **not** read `runtime.config`, so moving config out does not affect it.
- `src/permission-manager.ts` — `getResolvedPolicyPaths(): ResolvedPolicyPaths`.

Constraints from AGENTS.md / the package skill:

- Keep schema, example config, `docs/configuration.md`, `README.md`, and the loader aligned — not triggered here; this is a pure internal restructure with no config-format change.
- Inject the new collaborator with a narrow interface type, not the concrete class, so test mocks need no `as unknown as` cast (concrete class types leak private fields to the structural checker).
- Do not read `process.env` / `getAgentDir()` inside the store — `agentDir` is passed in.
- Business logic at the edges: the store still calls the existing `loadAndMergeConfigs` / `loadUnifiedConfig` / `normalizePermissionSystemConfig` / `syncPermissionSystemStatus` / `buildResolvedConfigLogEntry` free functions (full IO injection is out of scope; the constructibility win here is config *ownership* and a substitutable store, not IO injection).

### Why the context seam stays transitional

`runtime.runtimeContext` is written **only** by `refreshExtensionConfig` today and read by `refreshExtensionConfig`, `logResolvedConfigPaths`, the deprecated RPC handler (`getRuntimeContext`), and the runtime/session loggers' `warn`.
The store's `refresh(ctx?)` must keep setting it (so the RPC + loggers see the current context), and `logResolvedPaths()` must keep reading its `cwd`.
Because Step 4 unifies the context onto `PermissionSession` (not onto the store), this Step does **not** move context ownership into `ConfigStore`.
Instead the store takes a narrow `RuntimeContextRef` (get/set) backed by the still-runtime-owned `runtimeContext` field.
This get/set pair is the runtime-context seam — not one of the four `() => runtime.config` closures this Step removes — and it dissolves in Step 4.

## Design Overview

### `ConfigStore` and its collaborators

`ConfigStore` privately owns `config` and `lastConfigWarning` and holds four narrow collaborators — none of them the whole runtime:

```typescript
/** Read-only view of the current config — for consumers that only read. */
export interface ConfigReader {
  current(): PermissionSystemExtensionConfig;
}

/** Transitional get/set seam over the runtime-owned context (retired in Step 4 / #337). */
export interface RuntimeContextRef {
  get(): ExtensionContext | null;
  set(ctx: ExtensionContext): void;
}

/** Narrow logging sink — replaced by an injected logger in Step 3 (#336). */
export interface ConfigStoreLogger {
  writeDebugLog(event: string, details?: Record<string, unknown>): void;
  writeReviewLog(event: string, details?: Record<string, unknown>): void;
}

/** Narrow view of the manager's resolved policy paths (for logResolvedPaths). */
export interface ResolvedPolicyPathProvider {
  getResolvedPolicyPaths(): ResolvedPolicyPaths;
}

export interface ConfigStoreDeps {
  agentDir: string;
  context: RuntimeContextRef;
  policyPaths: ResolvedPolicyPathProvider;
  logger: ConfigStoreLogger;
}

export class ConfigStore implements ConfigReader {
  private config: PermissionSystemExtensionConfig;
  private lastConfigWarning: string | null = null;

  constructor(private readonly deps: ConfigStoreDeps) {
    this.config = { ...DEFAULT_EXTENSION_CONFIG };
  }

  current(): PermissionSystemExtensionConfig { return this.config; }
  refresh(ctx?: ExtensionContext): void { /* refreshExtensionConfig body */ }
  save(next: PermissionSystemExtensionConfig, ctx: ExtensionCommandContext): void { /* saveExtensionConfig body */ }
  logResolvedPaths(): void { /* logResolvedConfigPaths body */ }
}
```

Each method body is the corresponding free-function body with `runtime.config` / `runtime.lastConfigWarning` → `this.config` / `this.lastConfigWarning`, `runtime.runtimeContext` → `this.deps.context.get()` (and the one assignment → `this.deps.context.set(ctx)`), `runtime.agentDir` → `this.deps.agentDir`, `runtime.permissionManager.getResolvedPolicyPaths()` → `this.deps.policyPaths.getResolvedPolicyPaths()`, and `runtime.writeDebugLog` / `writeReviewLog` → `this.deps.logger.*`.
`save` is unchanged apart from the field/logging redirection — it uses its own `ExtensionCommandContext`, not the context seam.

### Construction in the factory (this Step)

The store is constructed inside `createExtensionRuntime()`, where the runtime's context field, manager, and logger sink are in scope without index-level closures, and exposed as `runtime.configStore`.
The existing logger ↔ config temporal coupling is preserved (Step 3 fixes it):

```typescript
const runtime = { ...paths, runtimeContext: null, permissionManager, /* … */,
  writeDebugLog: () => {}, writeReviewLog: () => {} } as ExtensionRuntime;

const configStore = new ConfigStore({
  agentDir,
  context: {
    get: () => runtime.runtimeContext,
    set: (ctx) => { runtime.runtimeContext = ctx; },
  },
  policyPaths: runtime.permissionManager,
  logger: {
    writeDebugLog: (e, d) => runtime.writeDebugLog(e, d),
    writeReviewLog: (e, d) => runtime.writeReviewLog(e, d),
  },
});
runtime.configStore = configStore;

const logger = createPermissionSystemLogger({
  getConfig: () => configStore.current(), // was () => runtime.config
  /* … */
});
runtime.writeDebugLog = /* … */; runtime.writeReviewLog = /* … */;
```

The store's `logger` sink defers to `runtime.writeDebugLog` (assigned after the logger is built but before any store method runs at session time) — the same deferred-binding pattern the factory already uses.

### Consumer call sites (Tell-Don't-Ask)

`PermissionSession` holds the store directly; its config members leave `PermissionSessionRuntimeDeps`:

```typescript
// permission-session.ts
get config() { return this.configStore.current(); }
refreshConfig(ctx?) { this.configStore.refresh(ctx); }
logResolvedConfigPaths() { this.configStore.logResolvedPaths(); }
```

`PermissionPrompter` and the forwarding `shouldAutoApprove` read through `ConfigReader`; the command controller holds the store for `current()` + `save()`.
None re-capture `runtime.config`.

### Edge cases

- `refresh()` with no `ctx` → context seam unchanged; `cwd`/`hasUI` read whatever the seam currently holds (matches today's `runtime.runtimeContext` read).
- `refresh(ctx)` before any context exists → `context.set(ctx)` then read back — identical to the current first-assignment path.
- `logResolvedPaths()` reads `context.get()?.cwd` — null before the first `refresh(ctx)`, exactly as today.
- Warning dedup (`lastConfigWarning`) and the `!warning` reset move verbatim into the store's private field.

### Extracted-module upstream check

`config-store.ts` imports only the existing config IO/reporting free functions, `node:fs` / `node:path` helpers, `DEFAULT_EXTENSION_CONFIG` + `normalizePermissionSystemConfig` (`extension-config.ts`), the config-paths helpers, and SDK context types — the same imports `runtime.ts` already has for these bodies.
It does **not** import `runtime.ts` (no cycle): the runtime imports the store, not vice versa.
No output-argument mutation is carried over — the store mutates only its own private fields; the one external write (`runtimeContext`) goes through the explicit `RuntimeContextRef.set` seam rather than reaching into a passed bag.

## Module-Level Changes

- `src/config-store.ts` (new) — `ConfigStore` class + `ConfigReader`, `RuntimeContextRef`, `ConfigStoreLogger`, `ResolvedPolicyPathProvider`, `ConfigStoreDeps` interfaces.
  Holds the three former free-function bodies as methods plus `current()`.
- `src/runtime.ts`
  - Construct `ConfigStore` in `createExtensionRuntime()`; add `configStore: ConfigStore` to `ExtensionRuntime`.
  - Remove `config` and `lastConfigWarning` from `ExtensionRuntime` (and `SessionState` if declared there); the logger `getConfig` reads `configStore.current()`.
  - Convert `refreshExtensionConfig` / `saveExtensionConfig` / `logResolvedConfigPaths` into thin delegators to `runtime.configStore` during migration, then delete them in the final step.
  - Drop config-IO imports that move solely into `config-store.ts` once the free functions are deleted.
- `src/permission-session.ts`
  - Add constructor param `configStore: ConfigStore` (or a session-narrow interface); store it.
  - Remove `refreshExtensionConfig`, `logResolvedConfigPaths`, `getConfig` from `PermissionSessionRuntimeDeps` (leaving `canRequestPermissionConfirmation` + `promptPermission`).
  - `config` getter / `refreshConfig` / `logResolvedConfigPaths` delegate to `this.configStore`.
- `src/permission-prompter.ts`
  - Replace `PermissionPrompterDeps.getConfig(): Config` with `config: ConfigReader`; `prompt` reads `this.deps.config.current()`.
- `src/config-modal.ts`
  - Point `PermissionSystemConfigController` at the store: `current()` + `save()` (replacing `getConfig` / `setConfig`); keep `getConfigPath` / `getComposedRules`.
- `src/index.ts`
  - Pass `runtime.configStore` into `PermissionSession`, `PermissionPrompter` (as `config`), and the command controller; remove the four `() => runtime.config` closures, the two session free-function wrappers, and the command `setConfig` wrapper.
  - `shouldAutoApprove` reads `runtime.configStore.current()`.
  - The initial `refreshExtensionConfig(runtime)` becomes `runtime.configStore.refresh()`.
- `test/config-store.test.ts` (new) — unit tests for the store with injected fakes.
- `test/runtime.test.ts` — delete the `refreshExtensionConfig` describe block (behavior now owned by `config-store.test.ts`); adjust any `createExtensionRuntime` assertion that read `runtime.config` / `runtime.lastConfigWarning`.
- `test/permission-session.test.ts` — inject a fake `ConfigStore`; drop the three config members from the runtimeDeps fixture; re-point the `refreshConfig` / `logResolvedConfigPaths` delegation assertions at the store fake.
- `test/permission-prompter.test.ts` — replace the `getConfig` stub with a `config: ConfigReader` fake.
- `test/config-modal.test.ts` — replace the `getConfig` / `setConfig` controller stubs with a `ConfigStore` fake (`current` / `save`).

Grep confirms `runtime.config` is read only in `src/index.ts` (5 lines) and `src/runtime.ts`; `lastConfigWarning` only in `src/runtime.ts`; the three free functions only in `src/index.ts`, `src/runtime.ts`, `src/permission-session.ts`, and their tests.
`session-logger.test.ts`'s `as unknown as ExtensionRuntime` mock does not set `config`, so removing the field does not break it.
The package skill (`.pi/skills/package-pi-permission-system/SKILL.md`) does not name `refreshExtensionConfig` / `saveExtensionConfig` / `logResolvedConfigPaths`.

Doc updates: `docs/architecture/architecture.md` already names `config-store.ts` and the `ConfigStore` outcome in the Step 2 narrative and the module-structure list; the constructibility metrics table is a phase-start snapshot, not a live count, so no edit is required by this Step (the `/retro` for the phase will refresh it).

## Test Impact Analysis

1. New unit tests enabled: `config-store.test.ts` constructs `ConfigStore` directly with plain fakes for the context seam, policy-path provider, and logger sink — no `as unknown as ExtensionRuntime`, no `vi.mock("../src/runtime")`.
   It exercises `current()`, `refresh(ctx?)` (config update, warning set/clear/dedup, status sync gated on `hasUI`, debug log), `save(next, ctx)` (success write, error notify + early return, debug log), and `logResolvedPaths()` (review + debug entries from the injected policy-path provider).
2. Redundant tests: the `runtime.test.ts` `refreshExtensionConfig` describe block — the function under test becomes a delegator and is then deleted; its behavior is covered at the layer that now owns it.
   Removed in the step that turns the free functions into delegators.
3. Tests that must stay: the `permission-session.test.ts` config-delegation tests (now assert delegation to the injected `ConfigStore` fake rather than the runtimeDeps stub — same contract, different collaborator); the `permission-prompter.test.ts` yolo auto-approve tests (now via the `ConfigReader` fake); the `config-modal.test.ts` get/set tests (now via the `ConfigStore` fake); the `createExtensionRuntime` path-derivation tests (unaffected).

## TDD Order

1. **Add `ConfigStore` + interfaces with `config-store.test.ts`** — `feat:`
   - Red: `test/config-store.test.ts` — construct `new ConfigStore({ agentDir, context: fakeRef, policyPaths: fakeProvider, logger: fakeSink })`; assert `current()`, `refresh` (load/normalize, warning set/clear/dedup, status sync on `hasUI`, debug log, `context.set` on `ctx`), `save` (write path, error-notify + early return, debug log), `logResolvedPaths` (review + debug entries).
     Mock the config-IO/status/reporter modules as `runtime.test.ts` does today.
   - Green: implement the class and interfaces by lifting the three free-function bodies and redirecting field/context/logger access.
   - Additive: no production consumer yet (gains consumers in steps 2-5 of this plan — not a speculative export; `pnpm fallow dead-code` runs clean at plan completion).
   - Run `pnpm run check` + `config-store.test.ts`.
   - Commit: `feat: add ConfigStore owning extension config state`.

2. **Construct `ConfigStore` in the factory; back runtime config with it** — `refactor:`
   - Build the store in `createExtensionRuntime()`; add `runtime.configStore`; remove `config` (replace its readers in `runtime.ts` with `configStore.current()`; expose a temporary `get config()` getter on the runtime object so the still-unmigrated `index.ts` consumers compile) and remove the `lastConfigWarning` field (no external reader).
   - Logger `getConfig` → `() => configStore.current()`; the three free functions become one-line delegators to `runtime.configStore`.
   - Delete the redundant `refreshExtensionConfig` block from `runtime.test.ts`.
   - Internal to `runtime.ts`; `index.ts` and the other consumers are untouched this step.
   - Run `pnpm run check` + the full suite.
   - Commit: `refactor: back ExtensionRuntime config with ConfigStore`.

3. **Inject `ConfigStore` into `PermissionSession`** — `refactor:`
   - Coupled step (constructor-signature change; single production call site `index.ts` + the `createSession` test helper).
   - Red: `permission-session.test.ts` — inject a `ConfigStore` fake; drop `refreshExtensionConfig` / `logResolvedConfigPaths` / `getConfig` from the runtimeDeps fixture; re-point the delegation assertions at the store fake.
   - Green: add the `configStore` constructor param; delegate the `config` getter / `refreshConfig` / `logResolvedConfigPaths` to it; remove the three members from `PermissionSessionRuntimeDeps`; update `index.ts` to pass `runtime.configStore` and drop the two session config wrappers.
   - Run `pnpm run check` (shared-interface change) + the full suite.
   - Commit: `refactor: inject ConfigStore into PermissionSession`.

4. **Point `PermissionPrompter` (and forwarding) at `ConfigReader`** — `refactor:`
   - Coupled step (deps-interface change; single call site `index.ts` + `permission-prompter.test.ts`).
   - Red: `permission-prompter.test.ts` — replace the `getConfig` stub with a `config: ConfigReader` fake.
   - Green: `PermissionPrompterDeps.getConfig()` → `config: ConfigReader`; `prompt` reads `this.deps.config.current()`; `index.ts` passes `config: runtime.configStore` and rewrites `shouldAutoApprove` to read `runtime.configStore.current()`.
   - Run `pnpm run check` + the full suite.
   - Commit: `refactor: read config from ConfigReader in PermissionPrompter`.

5. **Point the `/permission-system` command at the `ConfigStore`** — `refactor:`
   - Coupled step (controller-interface change; single call site `index.ts` + `config-modal.test.ts`).
   - Red: `config-modal.test.ts` — replace the `getConfig` / `setConfig` controller stubs with a `ConfigStore` fake (`current` / `save`).
   - Green: `PermissionSystemConfigController` reads `current()` + `save()`; `index.ts` passes `runtime.configStore`; drop the `getConfig` closure and the `setConfig` wrapper.
   - Run `pnpm run check` + the full suite.
   - Commit: `refactor: drive the permission-system command from ConfigStore`.

6. **Remove the runtime config free functions and the transitional getter** — `refactor:`
   - All consumers now read the store; delete `refreshExtensionConfig` / `saveExtensionConfig` / `logResolvedConfigPaths` and the temporary `get config()` getter from `runtime.ts`; change the initial `refreshExtensionConfig(runtime)` in `index.ts` to `runtime.configStore.refresh()`; drop now-unused imports.
   - Run `pnpm run check`, the full suite, and `pnpm fallow dead-code` to confirm no orphaned exports.
   - Commit: `refactor: remove runtime config free-functions`.

## Risks and Mitigations

- Risk: the transitional `RuntimeContextRef` get/set seam changes when/where `runtime.runtimeContext` is written.
  Mitigation: `set` is called exactly where `refreshExtensionConfig` assigned today (and only there); `get` reads the same field; the RPC + loggers read the unchanged field.
  Covered by the `config-store.test.ts` `context.set` assertion and the surviving composition-root test.
- Risk: removing `config` / `lastConfigWarning` from `ExtensionRuntime` breaks an importer not found by grep.
  Mitigation: grep across `src/` + `test/` is clean (config in `index.ts` + `runtime.ts`; warning in `runtime.ts` only); step 6 runs `pnpm fallow dead-code` as a backstop; the temporary getter keeps `index.ts` compiling across steps 2-5.
- Risk: dropping the `getConfig` callbacks surfaces incomplete mock returns the call shape previously hid.
  Mitigation: the consumer-test fakes return full `PermissionSystemExtensionConfig` shapes via the existing `DEFAULT_EXTENSION_CONFIG` clone; the narrow `ConfigReader` only requires `current()`.
- Risk: the logger ↔ config temporal coupling (store built before the logger that the store's sink defers to) misfires.
  Mitigation: identical deferred-binding pattern to today's `writeDebugLog`/`writeReviewLog` reassignment; store methods only run at session time, after the reassignment; Step 3 removes the coupling entirely.

## Open Questions

- Should `runtimeContext` ownership move onto the store rather than staying a transitional seam?
  Deferred to Step 4 (#337), which unifies context onto `PermissionSession`; owning it in the store now would pre-empt and then re-do that work.
- Should the remaining `() => configStore.current()` adapters (the logger `getConfig`, the forwarding `shouldAutoApprove`) collapse to bare references?
  The logger one is retired in Step 3 (#336); the index-level deps-bag collapse is Step 5 (#338).
