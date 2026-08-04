---
issue: 336
issue_title: "Make the logger injectable; drop createSessionLogger(runtime)"
---

# Make the logger injectable; drop `createSessionLogger(runtime)`

## Problem Statement

`createSessionLogger(runtime)` (`src/session-logger.ts`) captures the entire `ExtensionRuntime` and reaches through it to talk to strangers — `runtime.writeDebugLog`, `runtime.writeReviewLog`, and `runtime.runtimeContext?.ui.notify` — a Law-of-Demeter violation.
The runtime factory (`src/runtime.ts`) compounds the smell: it stubs `writeDebugLog` / `writeReviewLog` as `() => {}`, builds the JSONL writer plus a warning-dedup reporter, then reassigns the two methods afterward (a forward reference / temporal coupling).
The composition root (`src/index.ts`) then threads the same logging surface through five `.bind(runtime)` adapter closures.

This is Phase 4 Step 3 (Track B: De-god the runtime) from `docs/architecture/architecture.md` — the second link in the chain `ConfigStore → injectable logger → dissolve runtime → collapse index.ts closures`.
It depends on the `ConfigStore` extraction (Step 2, [#335], complete) for the debug toggle.
It is behavior-preserving.

## Goals

- Repurpose `createSessionLogger` to take narrow dependencies — the logs directory, a config reader (for the debug/review write toggles), and a notify sink — instead of the whole `ExtensionRuntime`.
- Fold the JSONL-writer composition (`createPermissionSystemLogger`), the warning-dedup reporter, and the `warn` notify path into the single `createSessionLogger` factory, so one object owns the complete `SessionLogger` contract (`debug` / `review` / `warn`).
- Remove `writeDebugLog` / `writeReviewLog` from `ExtensionRuntime`; expose the built logger as `runtime.logger` instead.
- Remove the `runtime.writeDebugLog` / `runtime.runtimeContext?.ui.notify` reach-through from `session-logger.ts`, and drop the five `.bind(runtime)` logging adapters in `index.ts`.
- Behavior-preserving: no observable change to debug/review log writing, the config toggles, warning deduplication, or warning notification.

## Non-Goals

- Moving the runtime context (`runtimeContext`) ownership off the runtime.
  The notify sink keeps reading the still-runtime-owned context through the transitional `RuntimeContextRef` seam introduced in [#335]; context unification onto `PermissionSession` is Step 4 ([#337]).
- Dissolving `ExtensionRuntime` or moving the logger / `ConfigStore` construction out of the factory and into `index.ts` — Step 4 ([#337]).
  The logger is built in the factory because it is mutually entangled with `ConfigStore`, which the factory owns until [#337].
- Collapsing the remaining `index.ts` deps bags and unifying the `writeReviewLog` field naming across the forwarder / prompter / RPC consumers — Step 5 ([#338]).
- Renaming the `SessionLogger` interface methods (`debug` / `review` / `warn`) or the consumer fields (`writeReviewLog` / `writeDebugLog`).

## Background

Relevant modules:

- `src/session-logger.ts` — defines the `SessionLogger` interface (`debug` / `review` / `warn`, all `void`) and `createSessionLogger(runtime)`, which delegates `debug` / `review` to `runtime.writeDebugLog` / `writeReviewLog` and `warn` to `runtime.runtimeContext?.ui.notify(message, "warning")`.
- `src/logging.ts` — `createPermissionSystemLogger({ getConfig, debugLogPath, reviewLogPath, ensureLogsDirectory })` returns a `PermissionSystemLogger` whose `debug` / `review` write a JSONL line (gated on `config.debugLog` / `config.permissionReviewLog`) and return a warning string on failure.
  This module has no `ExtensionRuntime` reference today.
- `src/runtime.ts` — `createExtensionRuntime()` builds the `PermissionSystemLogger`, owns the `reportedLoggingWarnings` dedup `Set` + `reportLoggingWarning` helper (which calls `runtime.runtimeContext?.ui.notify`), and assigns `runtime.writeDebugLog` / `writeReviewLog` (the stub-then-reassign pattern).
  `ConfigStore` is constructed here too, with a deferred-binding `ConfigStoreLogger` that points at `runtime.writeDebugLog` / `writeReviewLog`.
  The `contextRef: RuntimeContextRef` seam (`get`/`set` over `runtime.runtimeContext`) already exists for `ConfigStore`.
- `src/index.ts` — calls `createSessionLogger(runtime)` once (passed as `PermissionSession`'s `logger`), and threads `runtime.writeReviewLog.bind(runtime)` / `runtime.writeDebugLog.bind(runtime)` into the `PermissionForwarder` logger + `writeReviewLog`, the `PermissionPrompter`, and the RPC handlers (five `.bind` sites total).
- `src/config-store.ts` — `ConfigStore` implements `ConfigReader` (`current()`); its `ConfigStoreLogger` dep is `{ writeDebugLog, writeReviewLog }`.
  Its `refresh` / `save` / `logResolvedPaths` write through that sink.
- `src/decision-reporter.ts` — `GateDecisionReporter` holds a `SessionLogger` and calls `.review`; built in `index.ts` from `session.logger`.
  Unchanged.
- `src/handlers/lifecycle.ts` — the sole `SessionLogger.warn` caller (`this.session.logger.warn(issue)`).
  Unchanged.

Consumer logging-field shapes (all preserved):

- `ForwardedPermissionLogger` (`src/forwarded-permissions/io.ts`): `{ writeReviewLog, writeDebugLog }`.
- `PermissionPrompterDeps.writeReviewLog`, the RPC handler deps `writeReviewLog`, and `forwardingDeps.writeReviewLog`: bare `(event, details) => void`.

Constraints from AGENTS.md / the package skill:

- Inject the new collaborator with a narrow interface, not the concrete runtime, so test doubles need no `as unknown as ExtensionRuntime` cast.
- Do not read `getAgentDir()` / `process.*` inside the factory function — `globalLogsDir` is passed in.
- Keep business logic at the edges: `createSessionLogger` composes the existing `createPermissionSystemLogger` rather than re-implementing JSONL writing.
- The package skill does not name `createSessionLogger`, `writeDebugLog`, or `writeReviewLog`, so no skill edit is required.

### The logger ↔ ConfigStore cycle

The logger needs the config (to read the `debugLog` / `permissionReviewLog` toggles at write time); `ConfigStore` needs the logger (to write `config.loaded` / `config.saved` / `config.resolved` entries).
Today this is broken with the stub-then-reassign forward reference.
This plan breaks it cleanly with a lazy config read: build the logger first with `getConfig: () => configStore.current()` (a thunk, called only at write time), then build `ConfigStore` with the fully-constructed logger's methods.
The logger object is complete when `ConfigStore` is constructed; only the *config value* is read lazily, which is correct because config changes across the session.
No method is stubbed-then-reassigned.

## Design Overview

### The injectable `createSessionLogger`

`createSessionLogger` becomes the single home for the full `SessionLogger` contract: it composes the JSONL writer, owns the warning-dedup `Set`, and routes both IO-failure warnings and explicit `warn` calls through the injected notify sink.

```typescript
export interface SessionLogger {
  debug(event: string, details?: Record<string, unknown>): void;
  review(event: string, details?: Record<string, unknown>): void;
  warn(message: string): void;
}

export interface SessionLoggerDeps {
  /** Root logs directory; the debug + review log file paths derive from it. */
  globalLogsDir: string;
  /** Reads current config for the debug/review write toggles (call-time). */
  getConfig: () => PermissionSystemExtensionConfig;
  /** Surfaces a warning message to the user; read at call time. */
  notify: (message: string) => void;
}

export function createSessionLogger(deps: SessionLoggerDeps): SessionLogger {
  const writer = createPermissionSystemLogger({
    getConfig: deps.getConfig,
    debugLogPath: join(deps.globalLogsDir, DEBUG_LOG_FILENAME),
    reviewLogPath: join(deps.globalLogsDir, REVIEW_LOG_FILENAME),
    ensureLogsDirectory: () =>
      ensurePermissionSystemLogsDirectory(deps.globalLogsDir),
  });

  const reported = new Set<string>();
  const report = (warning: string): void => {
    if (reported.has(warning)) return;
    reported.add(warning);
    deps.notify(warning);
  };

  return {
    debug: (event, details) => {
      const warning = writer.debug(event, details);
      if (warning) report(warning);
    },
    review: (event, details) => {
      const warning = writer.review(event, details);
      if (warning) report(warning);
    },
    warn: (message) => deps.notify(message),
  };
}
```

The returned methods are standalone closures (no `this`), so consumers can pass `logger.review` / `logger.debug` as bare references with no `.bind`.

### Construction in the factory

`createExtensionRuntime()` builds the logger before `ConfigStore`, using a lazy `getConfig` thunk and the existing `contextRef` seam for the notify sink:

```typescript
let configStore: ConfigStore;

const logger = createSessionLogger({
  globalLogsDir: paths.globalLogsDir,
  getConfig: () => configStore.current(),
  notify: (message) =>
    runtime.runtimeContext?.ui.notify(message, "warning"),
});

configStore = new ConfigStore({
  agentDir,
  context: contextRef,
  policyPaths: permissionManager,
  logger: { writeDebugLog: logger.debug, writeReviewLog: logger.review },
});

runtime.configStore = configStore;
runtime.logger = logger;
```

`ExtensionRuntime` drops `writeDebugLog` / `writeReviewLog` and gains `logger: SessionLogger`.
The `() => {}` stubs, the post-construction reassignment, the `reportedLoggingWarnings` `Set`, the `reportLoggingWarning` helper, and the `createPermissionSystemLogger` import all leave `runtime.ts`.

Note: the notify sink reads `runtime.runtimeContext` at call time (matching today's `reportLoggingWarning` and `warn` behavior).
The `contextRef` seam may equally be used (`contextRef.get()?.ui.notify(...)`); both read the same field.

### Consumer call sites (no `.bind`)

`index.ts` reads `runtime.logger` and passes the bound closures directly:

```typescript
// PermissionSession logger arg
new PermissionSession(runtime, runtime.logger, /* … */);

// PermissionForwarder
logger: { writeReviewLog: runtime.logger.review, writeDebugLog: runtime.logger.debug },
writeReviewLog: runtime.logger.review,

// PermissionPrompter
writeReviewLog: runtime.logger.review,

// RPC handlers
writeReviewLog: runtime.logger.review,
```

The `writeReviewLog` / `writeDebugLog` field *names* on the consumer deps stay (they are mapped to `logger.review` / `logger.debug` values); unifying the naming is deferred to [#338].

### Edge cases (all preserved)

- `warn` is never deduplicated (explicit warnings always notify); only IO-failure warnings flow through the dedup `Set`.
- The notify sink is a no-op when `runtimeContext` is null (early-session) — `?.ui.notify` short-circuits, exactly as today.
- The dedup `Set` lives for the lifetime of the logger (one per `createExtensionRuntime` call), matching today's per-runtime `Set`.
- The debug/review toggles are read at write time via `getConfig`, so a config reload mid-session changes logging behavior with no rebuild — unchanged.

### Extracted-module upstream check

`session-logger.ts` gains imports for `join` (`node:path`), `DEBUG_LOG_FILENAME` / `REVIEW_LOG_FILENAME` (`config-paths.ts`), `ensurePermissionSystemLogsDirectory` + `PermissionSystemExtensionConfig` (`extension-config.ts`), and `createPermissionSystemLogger` (`logging.ts`) — all of which `runtime.ts` already imports for this work; they move, not duplicate.
`session-logger.ts` no longer imports `runtime.ts` (the LoD reach-through is gone), so the dependency edge `runtime.ts → session-logger.ts` is one-way with no cycle.
No output-argument mutation is carried over: the logger mutates only its private dedup `Set`; the notify sink is an injected callback, not a reached-into bag.

## Module-Level Changes

- `src/session-logger.ts`
  - Rewrite `createSessionLogger` to accept `SessionLoggerDeps` (`globalLogsDir`, `getConfig`, `notify`); compose `createPermissionSystemLogger`, own the dedup `Set` + reporter, and implement `warn` via `notify`.
  - Add the `SessionLoggerDeps` interface export.
  - Drop the `import type { ExtensionRuntime }`.
- `src/runtime.ts`
  - Remove `writeDebugLog` / `writeReviewLog` from the `ExtensionRuntime` interface; add `logger: SessionLogger`.
  - In the factory: build the logger via `createSessionLogger({ globalLogsDir, getConfig: () => configStore.current(), notify })` before `ConfigStore`; pass `{ writeDebugLog: logger.debug, writeReviewLog: logger.review }` as the `ConfigStoreLogger`; set `runtime.logger`.
  - Delete the `() => {}` stubs, the post-construction `writeDebugLog`/`writeReviewLog` reassignment, the `reportedLoggingWarnings` `Set`, `reportLoggingWarning`, and the `createPermissionSystemLogger` import (now unused here); import `createSessionLogger` + `SessionLogger` from `session-logger.ts`.
- `src/index.ts`
  - Drop `import { createSessionLogger }`.
  - Pass `runtime.logger` to `PermissionSession`.
  - Replace the five `runtime.writeReviewLog.bind(runtime)` / `runtime.writeDebugLog.bind(runtime)` adapters with `runtime.logger.review` / `runtime.logger.debug`.
- `test/session-logger.test.ts` — rewrite for the new signature (plain fakes: `getConfig`, `notify`, a temp `globalLogsDir`); cover the toggles, the success write, the IO-failure warning + dedup, and `warn` direct-notify.
- `test/runtime.test.ts` — re-point the logger mock from `../src/logging` to `../src/session-logger` (mock `createSessionLogger`); delete the `writeDebugLog` / `writeReviewLog` delegation + dedup + notify tests (now owned by `session-logger.test.ts`); assert `runtime.logger` is the object the factory built and that `createSessionLogger` is called with a `globalLogsDir`-derived value and a `getConfig` reading `configStore.current()`.

Grep confirms `runtime.writeDebugLog` / `runtime.writeReviewLog` are referenced only in `src/runtime.ts`, `src/index.ts`, and `test/runtime.test.ts`; `createSessionLogger` only in `src/index.ts` (call), `src/session-logger.ts` (def), and `test/session-logger.test.ts`.
The `SessionLogger` interface (`debug` / `review` / `warn`) is unchanged, so `decision-reporter.ts`, `handlers/lifecycle.ts`, `permission-session.ts`, `session-lifecycle-session.ts`, `handler-fixtures.ts`, and `gate-fixtures.ts` need no edits.

Doc updates: `docs/architecture/architecture.md` line 567 describes `session-logger.ts` as the "SessionLogger interface + createSessionLogger() factory" — still accurate, optionally clarified to "(composes the JSONL writer, warning dedup, and notify sink)".
The Phase 4 health-metrics table is a phase-start snapshot, not a live count (per the [#335] plan), so it is not edited here.
The roadmap Step 3 `✓ complete` mark is appended at ship time, not during planning.

## Test Impact Analysis

1. New unit tests enabled: `session-logger.test.ts` now constructs `createSessionLogger` with plain fakes — no `as unknown as ExtensionRuntime`.
   It can exercise the toggle gating, JSONL write success (temp dir), the IO-failure warning path (drive a failure via a non-writable `globalLogsDir` or by asserting on a fake notify), warning deduplication, and the un-deduplicated `warn` path — all without the runtime god object.
2. Redundant tests: the `runtime.test.ts` `writeDebugLog` / `writeReviewLog` delegation, dedup, and notify tests become redundant — the behavior they covered now lives in `createSessionLogger` and is tested in `session-logger.test.ts`.
   They are deleted when the runtime stops owning those methods.
3. Tests that must stay: the `runtime.test.ts` path-derivation, `piInfrastructureDirs`, default-state, and `configStore.current()` tests (unaffected); the `config-store.test.ts` logging-sink assertions (the sink contract — `{ writeDebugLog, writeReviewLog }` — is unchanged); the `logging.test.ts` / `config-reporter.test.ts` `createPermissionSystemLogger` tests (the JSONL writer is unchanged and is now composed, not bypassed).

## TDD Order

This is a signature change on `createSessionLogger` plus removal of two `ExtensionRuntime` fields, which break every consumer at the type level simultaneously.
Lift-and-shift across two steps keeps each commit small and the repo green between them: Step 1 introduces the new logger object and exposes `runtime.logger` while keeping the old runtime methods as thin delegators; Step 2 removes the old methods and the `.bind` adapters.

1. **Inject the new `createSessionLogger`; expose `runtime.logger`** — `refactor:`
   - Coupled step: `createSessionLogger`'s signature changes (sole call site `index.ts` line 72), so it cannot land in isolation.
   - Red: rewrite `test/session-logger.test.ts` for `SessionLoggerDeps` — assert toggle gating, success write (temp dir), IO-failure warning + dedup, and `warn` direct-notify.
   - Green:
     - Rewrite `createSessionLogger` to `SessionLoggerDeps` (compose the writer, own the dedup `Set`, implement `warn`).
     - In `runtime.ts`, build the logger via the new factory and set `runtime.logger`; keep `writeDebugLog` / `writeReviewLog` on the runtime *as thin delegators* (`(e, d) => logger.debug(e, d)` / `review`) so `index.ts`'s `.bind` sites still compile; point the `ConfigStoreLogger` at `{ writeDebugLog: logger.debug, writeReviewLog: logger.review }`; delete the stubs, the reassignment, the dedup `Set`, and `reportLoggingWarning`.
     - In `index.ts`, swap `createSessionLogger(runtime)` → `runtime.logger` (drop the import).
     - In `test/runtime.test.ts`, re-point the mock to `../src/session-logger`; move the dedup/notify/delegation assertions out (now in `session-logger.test.ts`) but keep `writeDebugLog`/`writeReviewLog` delegation smoke checks if still present this step.
   - Run `pnpm run check` + the full suite.
   - Commit: `refactor: build an injectable SessionLogger in the runtime factory`.

2. **Remove the runtime logging methods and the `.bind` adapters** — `refactor:`
   - Coupled step: removing the two fields breaks every `.bind` site at the type level; fold all consumer + test edits in.
   - Green:
     - `index.ts`: replace the five `runtime.writeReviewLog.bind(runtime)` / `runtime.writeDebugLog.bind(runtime)` with `runtime.logger.review` / `runtime.logger.debug`.
     - `runtime.ts`: remove `writeDebugLog` / `writeReviewLog` from the `ExtensionRuntime` interface and the factory (the `ConfigStoreLogger` already uses `logger.debug` / `logger.review`).
     - `test/runtime.test.ts`: delete the `writeDebugLog` / `writeReviewLog` tests; add/keep the `runtime.logger` assertion and the `createSessionLogger` call-args assertion.
   - Run `pnpm run check`, the full suite, and `pnpm fallow dead-code` to confirm no orphaned exports (e.g., an now-unused `logging.ts` re-export).
   - Commit: `refactor: drop runtime logging methods and index .bind adapters`.

## Risks and Mitigations

- Risk: the lazy `getConfig: () => configStore.current()` thunk is invoked before `configStore` is assigned, throwing a TDZ / undefined error.
  Mitigation: `getConfig` is only called at log *write* time (inside `writer.debug` / `review`), never during construction; `configStore` is assigned synchronously on the next statement, and the first log write happens at session time.
  Covered by the `runtime.test.ts` "getConfig reads configStore.current()" assertion.
- Risk: passing `logger.review` / `logger.debug` as bare references loses `this` and misfires.
  Mitigation: the methods are arrow-function closures over `writer` / `report` / `deps` with no `this` dependency; the existing `decision-reporter.ts` already passes `session.logger` around as a value.
- Risk: the dedup `Set` semantics change when moved from the runtime into the logger.
  Mitigation: identical `Set`-membership logic, identical per-runtime lifetime (one logger per factory call); the dedup tests move verbatim to `session-logger.test.ts`.
- Risk: a logging consumer outside grep's reach breaks when the runtime fields are removed.
  Mitigation: grep is clean (`runtime.writeDebugLog` / `writeReviewLog` only in `runtime.ts`, `index.ts`, `runtime.test.ts`); Step 2 runs `pnpm fallow dead-code` as a backstop; Step 1's delegators keep `index.ts` green until Step 2.

## Open Questions

- Should the `writeReviewLog` / `writeDebugLog` consumer field names unify to `review` / `debug` (so the logger satisfies the deps directly with no name mapping)?
  Deferred to [#338] (the index.ts deps-bag collapse), which owns the consumer-deps churn.
- Should the logger construction move from the factory into `index.ts`?
  Deferred to [#337], which dissolves `ExtensionRuntime` and relocates `ConfigStore` + logger construction to the composition root together.

[#335]: https://github.com/gotgenes/pi-packages/issues/335
[#337]: https://github.com/gotgenes/pi-packages/issues/337
[#338]: https://github.com/gotgenes/pi-packages/issues/338
