---
issue: 297
issue_title: "Add composition-root test coverage for pi-permission-system (makeFakePi harness + backfill)"
---

# Composition-root test coverage via a `makeFakePi()` harness

## Problem Statement

The composition root of `@gotgenes/pi-permission-system` — the `piPermissionSystemExtension(pi)` default export in `src/index.ts` — has effectively no targeted test coverage, so a whole class of wiring faults slips past the suite.
Issue [#296] is a concrete instance: a one-line wiring fault (`new SubagentSessionRegistry()` instead of the shared process-global instance) disabled subagent forwarding, and every existing test missed it because the tests **inject** a registry into the subscriber and the detector, sharing one hand-made instance by construction, and never run the factory that decides which instance each side gets.

That pattern generalizes.
Unit tests prove each piece works in isolation; they cannot see a handler that was never registered, two collaborators that must share an instance but got two (the [#296] class), a teardown that leaked, an ordering contract, or multi-instance global-state interplay.
None of these are expressible as unit tests, because the contract under test is the wiring itself.

The fix is a `makeFakePi()` test harness that lets a test run the **real** `piPermissionSystemExtension(pi)` and introspect/drive the result, plus a backfill of wiring tests that exercise the contracts above.

## Goals

- Build a reusable `makeFakePi()` harness that runs the real factory and exposes the registered handlers, a real event bus, a minimal tool registry, and captured command registrations.
- Backfill composition-root tests for the six wiring contracts the issue enumerates: registry sharing, handler-registration completeness, shutdown teardown, service↔gate formatter-registry sharing, `ready`-after-publish ordering, and multi-instance global-state interplay.
- Characterize target 6 (suspected latent multi-instance bug) with a real assertion; if it confirms a bug, file a separate fix issue rather than fixing it here.
- After the backfill lands, consolidate the existing inline `createToolCallHarness` in `test/permission-system.test.ts` onto `makeFakePi()` to remove duplication.

## Non-Goals

- Not fixing the suspected target-6 bug (child shutdown unpublishing the parent's global service) in this plan — characterize only, then defer to a follow-up issue (see Open Questions).
- No changes to production `src/` modules.
  The harness runs the factory as-is; if a target test reveals a production bug, that fix is a separate issue.
- No changes to `@gotgenes/pi-subagents`.
- Not broadening env-hint or filesystem subagent detection (the still-open [#22]).
- No change to the `PermissionsService` public surface, the RPC contract, or the config schema.

## Background

Relevant modules in `packages/pi-permission-system/`:

- `src/index.ts` — the composition root.
  It constructs `runtime` (via `createExtensionRuntime()`), the shared `getSubagentSessionRegistry()`, a single `ToolInputFormatterRegistry`, the `PermissionsService`, and wires six `pi.on(...)` handlers: `session_start`, `resources_discover`, `session_shutdown`, `before_agent_start`, `input`, `tool_call`.
  It publishes the service via `publishPermissionsService(...)`, subscribes the subagent lifecycle via `subscribeSubagentLifecycle(pi.events, registry)`, emits `permissions:ready` **after** publishing, and registers a teardown closure on the `SessionLifecycleHandler` that unsubscribes RPC + lifecycle and calls `unpublishPermissionsService()`.
- `src/service.ts` — `publishPermissionsService` / `getPermissionsService` / `unpublishPermissionsService`, backed by `globalThis` + `Symbol.for("@gotgenes/pi-permission-system:service")`.
- `src/subagent-registry.ts` — `getSubagentSessionRegistry()`, backed by `globalThis` + `Symbol.for("@gotgenes/pi-permission-system:subagent-registry")`.
  The class is keyed by **`sessionId`**, not `sessionDir`.
- `src/subagent-lifecycle-events.ts` — `subscribeSubagentLifecycle(events, registry)` registers on `SUBAGENT_CHILD_SESSION_CREATED` (`"subagents:child:session-created"`) and unregisters on `SUBAGENT_CHILD_DISPOSED`.
  The `session-created` payload it reads is `{ sessionId: string; parentSessionId?: string }`.
- `src/subagent-context.ts` — `isSubagentExecutionContext(ctx, subagentSessionsDir, registry)` checks `registry.has(ctx.sessionManager.getSessionId())` first.
- `src/runtime.ts` — `createExtensionRuntime()` calls `getAgentDir()` (from the SDK) at invocation time, reading `PI_CODING_AGENT_DIR`.
  The factory invokes it with no `agentDir` option, so composition-root tests must control the env.
- `test/helpers/handler-fixtures.ts` — existing `makeCtx`, `makeEvents` (a no-op `emit`/`on` stub), `makeToolRegistry`, etc.
- `test/permission-system.test.ts` — already contains an inline `createToolCallHarness` (≈line 110) that sets `PI_CODING_AGENT_DIR` to a tmpdir, writes a config file, and runs the real factory with a hand-rolled fake `pi`.
  Its event bus is a **no-op** stub (not a real `createEventBus()`), its `handlers` is a `Record<string, MockHandler>` (last-write-wins, not inspectable for completeness), and it has no generic `fire()` driver.
  `makeFakePi()` is the generalization of this harness.

Constraints from `AGENTS.md` / the `package-pi-permission-system` skill:

- Under jiti, module-scoped state is isolated per extension instance; the two `Symbol.for()` global slots are the shared channels.
  Tests that run the factory mutate both slots and **must** clean them in `afterEach`, or state leaks across tests (especially the multi-invocation targets 1, 3, and 6).
- The `session-created` handler must stay synchronous — the harness `fire()` must support both sync and async handlers.
- Prefer `vi.stubEnv` + `vi.unstubAllEnvs` over manual `process.env` save/restore for the agent-dir isolation.

Discrepancy to carry into the tests: the issue's pseudocode keys the registry and event payload by `sessionDir`, but the current code (post [#221] / [#296]) keys by `sessionId`.
The backfill tests use `sessionId` and a `ctx.sessionManager.getSessionId()` that returns the registered id.

## Design Overview

### `makeFakePi()` harness

A test-only factory in `test/helpers/make-fake-pi.ts` that returns a `FakePi` — a structural subset of `ExtensionAPI` (ISP: only the methods the factory touches) plus inspection/drive affordances.

```typescript
import { createEventBus, type EventBus } from "@earendil-works/pi-coding-agent";

/** A handler recorded by `pi.on(...)`, kept generic over event/result shapes. */
type RecordedHandler = (event: unknown, ctx: unknown) => unknown;

export interface FakePi {
  /** Real event bus so cross-extension pub/sub and RPC behave as in production. */
  events: EventBus;
  /** Every `pi.on(event, handler)` registration, keyed by event name. */
  handlers: Map<string, RecordedHandler>;
  /** Every `pi.registerCommand(name, …)` registration, keyed by command name. */
  commands: Map<string, unknown>;
  /** Drive a registered handler; resolves to its (possibly async) result. */
  fire(event: string, input?: unknown, ctx?: unknown): Promise<unknown>;
  /** Minimal tool registry. */
  getAllTools(): { name: string }[];
  setActiveTools(names: string[]): void;
}

export interface MakeFakePiOptions {
  /** Inject a shared bus to model parent/child instances; defaults to a fresh bus. */
  events?: EventBus;
  /** Tool names returned by getAllTools(); defaults to a small set. */
  toolNames?: readonly string[];
}

export function makeFakePi(options: MakeFakePiOptions = {}): FakePi { /* … */ }
```

Notes on the harness:

- `events` defaults to `createEventBus()`; tests pass `{ events: sharedBus }` to model two factory instances sharing (or **not** sharing) a bus.
- `on(event, handler)` records into `handlers`; `fire(event, input, ctx)` looks the handler up and returns `Promise.resolve(handler(input, ctx))` so both sync (`session_shutdown` → `Promise<void>`) and async (`tool_call`) handlers work uniformly.
- `registerCommand(name, opts)` records into `commands`; `registerProvider`, `exec`, and any other unused `ExtensionAPI` methods the cast needs are no-op `vi.fn()` stubs.
- The object is cast `as unknown as ExtensionAPI` at the call to `piPermissionSystemExtension(pi)`; the `FakePi` interface itself stays narrow.

### Shared composition-root test setup

Every composition-root test needs the same isolation, so factor it into a `beforeEach`/`afterEach` block (kept local to the new test file, not in `makeFakePi` — env/global lifecycle is not the `pi` object's concern):

```typescript
let agentDir: string;
beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-perm-comp-root-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(() => {
  // Drop both process-global slots so factory runs do not leak across tests.
  delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
  delete (globalThis as Record<symbol, unknown>)[SUBAGENT_REGISTRY_KEY];
  vi.unstubAllEnvs();
  rmSync(agentDir, { recursive: true, force: true });
});
```

The service slot is cleared via `unpublishPermissionsService()` (preferred over a raw `delete`); the registry slot has no public unpublish accessor by design (a child's shutdown must never wipe the parent's registrations), so the test deletes the `Symbol.for(...)` slot directly — the same pattern `test/subagent-registry.test.ts` already uses.

### Per-target sketches

1. Registry sharing across instances (the [#296] class).
   Run the factory twice with **different** buses; emit `SUBAGENT_CHILD_SESSION_CREATED` on the parent bus with `{ sessionId, parentSessionId }`; assert the child's `tool_call` for an external-directory `ls` is **not** blocked (it detects itself as a subagent via the shared global registry and forwards instead).
2. Handler-registration completeness.
   `piPermissionSystemExtension(makeFakePi())`; assert `[...pi.handlers.keys()].sort()` equals the six expected events sorted.
   Guards against a refactor silently dropping a handler.
3. Shutdown teardown chain.
   Run the factory; assert `getPermissionsService()` is defined; `await pi.fire("session_shutdown")`; assert the service is unpublished and that a post-shutdown `SUBAGENT_CHILD_SESSION_CREATED` does **not** land a registration (lifecycle unsubscribed).
4. Service↔gate share one `ToolInputFormatterRegistry`.
   Register a formatter via `getPermissionsService()!.registerToolInputFormatter("mcp", fmt)`; fire an `mcp` `tool_call` that resolves to `ask` under a UI-capturing `ctx`; assert the captured prompt preview reflects `fmt`'s output (proves the live gate consults the same registry the service wrote to).
5. `ready`-after-publish ordering.
   Subscribe to `permissions:ready` on the bus **before** running the factory; in the listener push whether `getPermissionsService()` is present; assert the recorded sequence is `["present"]`.
6. Multi-instance global-state interplay (characterization).
   Run the factory for a parent, then a child; `await child.fire("session_shutdown")`; assert the **current** behavior of `getPermissionsService()`.
   If the suspicion holds (the child's shutdown deletes the parent's slot → `undefined`), document it with `test.fails` asserting the desired behavior (`toBeDefined()`) and file a follow-up fix issue; otherwise assert the passing behavior directly.

## Module-Level Changes

- `test/helpers/make-fake-pi.ts` — **new**.
  Exports `makeFakePi`, `FakePi`, `MakeFakePiOptions`.
- `test/composition-root.test.ts` — **new**.
  Houses the shared `beforeEach`/`afterEach` isolation and the six target tests (targets 1–6).
- `test/permission-system.test.ts` — **changed (final step)**.
  Migrate the inline `createToolCallHarness` onto `makeFakePi()`, removing the duplicated hand-rolled fake `pi` while preserving the existing config-file write, tmpdir, and `ctx`/prompt-capture behavior those tests depend on.
- No `src/` changes.
- No `docs/architecture/` updates needed — no module is added, removed, or moved in `src/`.

## Test Impact Analysis

1. New coverage enabled: the six wiring contracts above, none of which any existing unit test can express (they require running the real factory and observing cross-instance global state, handler registration, teardown, and event ordering).
2. Redundant existing tests: none are made redundant — the new tests cover the composition root, a layer no current test touches.
   The final consolidation step removes **duplication of harness code**, not test coverage: the assertions in `permission-system.test.ts` are preserved, only their fake-`pi` plumbing is swapped for `makeFakePi()`.
3. Tests that must stay as-is: all existing unit tests (they exercise injected collaborators in isolation, which remains the right granularity for those modules).

## TDD Order

1. Build `makeFakePi()` + target 2 (handler-registration completeness).
   Surface: `test/composition-root.test.ts` + `test/helpers/make-fake-pi.ts`.
   Covers: harness boot, real event bus, `handlers` map, the six-handler completeness assertion.
   Red: test imports a non-existent `makeFakePi`.
   Green: harness built, factory runs, keys match.
   Run `pnpm --filter @gotgenes/pi-permission-system run check` immediately (new test infra + SDK type cast).
   Commit: `test: add makeFakePi harness and handler-registration completeness test (#297)`.
2. Target 1 — registry sharing across instances.
   Covers: two factory instances on different buses share the global registry; child forwards instead of blocking.
   Commit: `test: cover subagent registry sharing across factory instances (#297)`.
3. Target 3 — shutdown teardown chain.
   Covers: service unpublished and lifecycle unsubscribed after `session_shutdown`.
   Commit: `test: cover composition-root shutdown teardown chain (#297)`.
4. Target 4 — service↔gate formatter-registry sharing.
   Covers: a formatter registered via the published service reaches the live gate's prompt preview.
   Commit: `test: cover service and gate sharing one formatter registry (#297)`.
5. Target 5 — `ready`-after-publish ordering.
   Covers: a `permissions:ready` listener can immediately resolve the service.
   Commit: `test: cover ready emitted after service publication (#297)`.
6. Target 6 — multi-instance global-state interplay (investigation).
   Covers: parent/child publish/unpublish interplay on the global service slot.
   Land a real assertion of current behavior; if buggy, `test.fails` the desired behavior and open a follow-up fix issue.
   Commit: `test: characterize multi-instance global service interplay (#297)`.
7. Consolidate `createToolCallHarness` onto `makeFakePi()`.
   Migrate `test/permission-system.test.ts`'s inline fake `pi` to the shared harness; keep config write / tmpdir / prompt-capture behavior; run the full package suite before committing.
   Commit: `refactor(test): migrate createToolCallHarness onto makeFakePi (#297)`.

## Risks and Mitigations

- Global-state leakage across tests — running the factory mutates two `Symbol.for()` slots.
  Mitigation: the shared `afterEach` clears both slots and unstubs env; verify by running targets 1, 3, and 6 in isolation and together.
- Filesystem side effects — the real factory loads config and creates a logs directory under `getAgentDir()`.
  Mitigation: `vi.stubEnv("PI_CODING_AGENT_DIR", <tmpdir>)` per the existing inline harness; `rmSync` the tmpdir in `afterEach`.
- Target-4 prompt-preview assertion is the most coupled — it needs an `ask`-resolving config and a UI-capturing `ctx`.
  Mitigation: reuse `makeCtx` / config patterns from existing handler and forwarding tests; if the preview path proves brittle, fall back to asserting both sides reference the same registry instance via a narrower observable (documented inline).
- The `sessionDir`-vs-`sessionId` discrepancy could be miscopied from the issue pseudocode.
  Mitigation: the plan pins the key to `sessionId`; tests build `ctx.sessionManager.getSessionId()` to return the registered id.
- Consolidation step touches a 2585-line test file.
  Mitigation: it is the final, isolated step; run the full suite before committing; the change is plumbing-only with assertions preserved.

## Open Questions

- Does target 6 confirm the latent bug?
  If `getPermissionsService()` returns `undefined` after a child's shutdown while the parent is still alive, file a dedicated fix issue (likely: scope the service slot per-instance, or make the child skip publish/unpublish when a parent service already occupies the slot).
  This plan only characterizes it.
- Should `makeFakePi()` eventually replace `makeEvents` (the no-op bus) in `handler-fixtures.ts` for handler tests that would benefit from a real bus?
  Deferred — out of scope here; revisit if a handler test needs real pub/sub.

[#22]: https://github.com/gotgenes/pi-packages/issues/22
[#221]: https://github.com/gotgenes/pi-packages/issues/221
[#296]: https://github.com/gotgenes/pi-packages/issues/296
