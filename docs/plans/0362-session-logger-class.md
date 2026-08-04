---
issue: 362
issue_title: "Convert `createSessionLogger` factory into a `SessionLogger` class"
---

# Convert the `createSessionLogger` factory into a `PermissionSessionLogger` class

## Problem Statement

`createSessionLogger(deps)` (`src/session-logger.ts`) returns an object literal that closes over a mutable `reported: Set<string>` (the IO-failure-warning dedup) plus the composed JSONL writer.
This is a bag of state and closures masquerading as a factory — the exact pattern Phase 3 and Phase 4 converted everywhere else.
`fallow` cannot see the smell because the mutable `Set` is hidden inside the closure, so the syntactic surface stays clean (health 76, 0% dead exports) while the design smell persists.

This is Phase 5 Step 1 (Track A: logger state + composition-root coupling) from `docs/architecture/architecture.md`.
It is the foundation of Track A — Step 2 ([#363]) dissolves the `index.ts` forward-reference construction cycle that the old factory forced, and depends on this reshape.
The change is behavior-preserving.

## Goals

- Replace the `createSessionLogger` factory with a `PermissionSessionLogger` class that privately owns `reported` (the dedup `Set`) and the composed `PermissionSystemLogger` writer, and implements the existing `SessionLogger` interface (`debug` / `review` / `warn`).
- Construct it as `new PermissionSessionLogger(deps)` at the sole production call site (`src/index.ts`) and in `test/session-logger.test.ts`.
- Behavior-preserving: the dedup semantics, the config-toggle gating, and the notify routing are unchanged.

## Non-Goals

- Dissolving the `index.ts` forward-reference cycle (`let configStore = null as unknown as ConfigStore`, the `let sessionNotify` holder, and the `getRuntimeContext()?.ui.notify` reach-through).
  That is Step 2 ([#363]); this plan keeps the construction order and the `notify` closure exactly as they are today.
- Dropping the relay-only `logger` field from `PermissionSession` or injecting the logger directly into the lifecycle handler / reporter — Step 3 ([#364]).
- Renaming the `SessionLogger` / `DebugReviewLogger` / `ReviewLogger` interfaces or their methods (`debug` / `review` / `warn`).
  These are the injection seams the consumers depend on and they stay untouched.
- Changing the `PermissionSystemLogger` JSONL writer (`logging.ts`) or any consumer-side logger wiring (`ConfigStore`, `PermissionForwarder`, `PermissionPrompter`, RPC handlers, `GateDecisionReporter`, `lifecycle.ts`).

## Background

Relevant modules:

- `src/session-logger.ts` — declares the three narrowing seams (`ReviewLogger { review }`, `DebugReviewLogger extends ReviewLogger { debug }`, `SessionLogger extends DebugReviewLogger { warn }`), the `SessionLoggerDeps` interface (`globalLogsDir`, `getConfig`, `notify`), and the `createSessionLogger(deps)` factory.
  The factory composes `createPermissionSystemLogger`, owns the `reported` dedup `Set` plus a `reportOnce` closure, and returns an object literal whose `debug` / `review` route IO-failure warnings through `reportOnce` and whose `warn` calls `deps.notify` directly.
- `src/logging.ts` — `createPermissionSystemLogger({ getConfig, debugLogPath, reviewLogPath, ensureLogsDirectory })` returns a `PermissionSystemLogger` whose `debug` / `review` write a JSONL line (gated on `config.debugLog` / `config.permissionReviewLog`) and return a warning string on failure.
  Exports the `PermissionSystemLogger` interface — this plan adds a type import for the new private field.
- `src/index.ts` — the composition root.
  Builds the logger via `createSessionLogger({ globalLogsDir, getConfig: () => configStore.current(), notify: (message) => sessionNotify?.getRuntimeContext()?.ui.notify(message, "warning") })` and injects the resulting object into `ConfigStore`, `PermissionForwarder`, `PermissionPrompter`, the RPC handlers, `PermissionSession`, and (as `session.logger`) `GateDecisionReporter`.
- Consumers all store the injected logger object and invoke `this.logger.review(...)` / `.debug(...)` / `.warn(...)` on it (`decision-reporter.ts`, `config-store.ts`, `permission-prompter.ts`, `permission-forwarder.ts`, `permission-event-rpc.ts`, `handlers/lifecycle.ts`).
  None destructure the logger or pass a bare `logger.review` reference.

Constraints from AGENTS.md / the package skill:

- The codebase convention is `interface` (the seam) + a distinctly-named concrete `class`: `DecisionReporter`→`GateDecisionReporter`, `PermissionsService`→`LocalPermissionsService`, `ScopedPermissionManager`→`PermissionManager`.
  The `SessionLogger` interface is the widely-injected seam and must stay; the class therefore takes a distinct, domain-qualified name — `PermissionSessionLogger` (mirroring `PermissionServiceLifecycle` / `PermissionForwarder` / `PermissionResolver`).
- Class collaborators use TS `private readonly` fields, matching `GateDecisionReporter` (`private readonly logger: SessionLogger`).
- Do not read `process.*` / `getAgentDir()` inside the class — `globalLogsDir` arrives via `SessionLoggerDeps`.
- The package skill does not reference `createSessionLogger`, so no skill edit is required (grep-confirmed against `.pi/skills/package-pi-permission-system/SKILL.md`).

## Design Overview

### The `PermissionSessionLogger` class

The class is a one-for-one reshape of the factory: the constructor composes the JSONL writer and seeds the dedup `Set`; the three methods carry the same bodies the object-literal closures had today.
Because the `SessionLogger` interface is unchanged, every consumer keeps injecting the same seam.

```typescript
import type { PermissionSystemLogger } from "./logging";

export class PermissionSessionLogger implements SessionLogger {
  private readonly writer: PermissionSystemLogger;
  private readonly reported = new Set<string>();
  private readonly notify: (message: string) => void;

  constructor(deps: SessionLoggerDeps) {
    this.writer = createPermissionSystemLogger({
      getConfig: deps.getConfig,
      debugLogPath: join(deps.globalLogsDir, DEBUG_LOG_FILENAME),
      reviewLogPath: join(deps.globalLogsDir, REVIEW_LOG_FILENAME),
      ensureLogsDirectory: () =>
        ensurePermissionSystemLogsDirectory(deps.globalLogsDir),
    });
    this.notify = deps.notify;
  }

  debug(event: string, details?: Record<string, unknown>): void {
    const warning = this.writer.debug(event, details);
    if (warning) this.reportOnce(warning);
  }

  review(event: string, details?: Record<string, unknown>): void {
    const warning = this.writer.review(event, details);
    if (warning) this.reportOnce(warning);
  }

  warn(message: string): void {
    this.notify(message);
  }

  private reportOnce(warning: string): void {
    if (this.reported.has(warning)) return;
    this.reported.add(warning);
    this.notify(warning);
  }
}
```

`SessionLoggerDeps`, the three seam interfaces, and the module's existing imports (`join`, `DEBUG_LOG_FILENAME` / `REVIEW_LOG_FILENAME`, `ensurePermissionSystemLogsDirectory` + `PermissionSystemExtensionConfig`, `createPermissionSystemLogger`) all stay; the only new import is the `PermissionSystemLogger` type, for the private `writer` field.

### Construction at the composition root

`index.ts` swaps the factory call for `new`, leaving the dependency expressions byte-for-byte identical:

```typescript
const logger = new PermissionSessionLogger({
  globalLogsDir: paths.globalLogsDir,
  getConfig: () => configStore.current(),
  notify: (message) =>
    sessionNotify?.getRuntimeContext()?.ui.notify(message, "warning"),
});
```

The `let configStore = null as unknown as ConfigStore` forward reference and the `let sessionNotify` holder remain — dissolving them is [#363]'s job and depends on this step landing first.

### `this`-binding safety

The factory returned arrow-function closures (no `this`), so the [#336] design noted consumers could pass `logger.review` as a bare reference.
A class's instance methods are `this`-sensitive, so this would be a regression risk — but every consumer invokes the logger through its stored object reference (`this.logger.review(...)`, `this.deps.logger.debug(...)`), never as a bare value (grep-confirmed across all six consumers).
Object-reference invocation preserves `this`, so no `.bind` is needed and `@typescript-eslint/unbound-method` is not triggered (it fires only on bare method references, which do not exist here).

### Edge cases (all preserved)

- `warn` is never deduplicated; only IO-failure warnings flow through `reportOnce`.
- The notify sink is a no-op when `sessionNotify` / `runtimeContext` is null (early-session) — the optional chain short-circuits, exactly as today.
- The dedup `Set` lives for the lifetime of the instance (one per `new PermissionSessionLogger`), matching the former per-factory-call `Set`.
- The debug/review toggles are read at write time via the `getConfig` thunk, so a mid-session config reload changes logging behavior with no rebuild — unchanged.

## Module-Level Changes

- `src/session-logger.ts`
  - Replace the `createSessionLogger` function with `export class PermissionSessionLogger implements SessionLogger` (constructor composes the writer + seeds the dedup `Set`; `debug` / `review` / `warn` methods; private `reportOnce`).
  - Add `import type { PermissionSystemLogger } from "./logging"`.
  - Keep the `SessionLoggerDeps` interface and the three seam interfaces unchanged.
- `src/index.ts`
  - Change the import from `createSessionLogger` to `PermissionSessionLogger`.
  - Change `createSessionLogger({...})` to `new PermissionSessionLogger({...})`; leave the dependency object and the surrounding forward-reference wiring untouched.
- `test/session-logger.test.ts`
  - Change the import from `createSessionLogger` to `PermissionSessionLogger`.
  - Change every `createSessionLogger(deps)` to `new PermissionSessionLogger(deps)` (mechanical, ~10 call sites).
  - Rename the top-level `describe("createSessionLogger", …)` to `describe("PermissionSessionLogger", …)`.
  - Assertions are unchanged — behavior is preserved.
- `docs/architecture/architecture.md`
  - Update the `session-logger.ts` layout line (currently "SessionLogger interface + createSessionLogger(deps) factory; …") to describe the `PermissionSessionLogger` class, and append `[#362]` to the file's reference-link definitions.

Grep confirms `createSessionLogger` appears only in `src/session-logger.ts` (def), `src/index.ts` (sole call), and `test/session-logger.test.ts`; `SessionLoggerDeps` only in those same files.
The `SessionLogger` / `DebugReviewLogger` / `ReviewLogger` interfaces are unchanged, so `decision-reporter.ts`, `config-store.ts`, `permission-prompter.ts`, `permission-forwarder.ts`, `permission-event-rpc.ts`, `handlers/lifecycle.ts`, and the `makeLogger` test fixture need no edits.
The Phase 5 health-metrics table and the roadmap Step 1 prose are phase-start snapshots, not live counts (per the [#336] convention); the `✓ complete` mark on the roadmap step is appended at ship time, not during planning.

## Test Impact Analysis

1. New unit tests enabled: none.
   This is a behavior-preserving reshape of the same surface (`debug` / `review` / `warn` over the same deps), not an extraction that exposes a previously-untestable seam.
   `test/session-logger.test.ts` already constructs the logger from plain fakes (`getConfig`, `notify`, a temp `globalLogsDir`) with no casts, and that remains true with `new PermissionSessionLogger(deps)`.
2. Redundant tests: none.
   No lower-level test supersedes an existing one; the existing toggle-gating, success-write, IO-failure-dedup, and un-deduplicated-`warn` cases all stay and exercise the same behavior through the new constructor.
3. Tests that must stay as-is: all of `test/session-logger.test.ts` (the construction expression changes; the assertions do not).
   `logging.test.ts` (the JSONL writer is unchanged and still composed by the class) and every consumer test (the injected seam is unchanged) are unaffected.

## TDD Order

This is a single behavior-preserving refactor.
The export changes name and call form (`createSessionLogger(x)` → `new PermissionSessionLogger(x)`), which breaks the sole production call site and the test file at the type level together — so per the "removing an export breaks all importers in one commit" rule, the class, the `index.ts` call-site update, and the test-construction updates land in one step.

1. **Convert the factory to `PermissionSessionLogger`** — `refactor:`
   - Red: in `test/session-logger.test.ts`, change the import to `PermissionSessionLogger`, rewrite every `createSessionLogger(deps)` to `new PermissionSessionLogger(deps)`, and rename the top-level `describe`.
     The suite fails to compile because the class does not exist yet.
   - Green:
     - In `session-logger.ts`, replace `createSessionLogger` with the `PermissionSessionLogger` class (constructor composes the writer + seeds the dedup `Set`; `debug` / `review` / `warn` + private `reportOnce`); add the `PermissionSystemLogger` type import.
     - In `index.ts`, swap the import and the construction expression to `new PermissionSessionLogger({...})`.
     - Update the `docs/architecture/architecture.md` `session-logger.ts` layout line.
   - Run `pnpm run check`, the full test suite, and `pnpm fallow dead-code` (confirm no orphaned `createSessionLogger` export remains and no new dead export appears).
   - Commit: `refactor: convert createSessionLogger factory to PermissionSessionLogger class`.

## Risks and Mitigations

- Risk: a class instance method loses `this` when a consumer passes `logger.review` as a bare reference (a regression from the former arrow-closure object).
  Mitigation: grep-confirmed that all six consumers invoke the logger through its stored object reference, never as a bare value; object-reference calls preserve `this`.
  `pnpm run check` (which runs `@typescript-eslint/unbound-method`) is the backstop — it fires on any bare method reference.
- Risk: the `getConfig: () => configStore.current()` thunk runs before `configStore` is assigned and throws.
  Mitigation: unchanged from today — `getConfig` is invoked only at log-write time inside `writer.debug` / `review`, never during construction; `configStore` is assigned on the next statement.
  This plan does not touch that ordering.
- Risk: the dedup `Set` semantics shift when moved from a closure into a private field.
  Mitigation: identical membership logic, identical per-instance lifetime (one `Set` per `new PermissionSessionLogger`, matching one per former factory call); the existing dedup tests pass unchanged.
- Risk: a hidden consumer breaks when the `createSessionLogger` export is removed.
  Mitigation: grep is clean (three files only); the one-commit fold keeps every importer green; `pnpm fallow dead-code` is the backstop.

## Open Questions

- None.
  The class name (`PermissionSessionLogger`) was resolved during planning against the package's interface/class naming convention.
  The forward-reference cycle that the old factory forced is intentionally left in place for [#363].

[#336]: https://github.com/gotgenes/pi-packages/issues/336
[#363]: https://github.com/gotgenes/pi-packages/issues/363
[#364]: https://github.com/gotgenes/pi-packages/issues/364
