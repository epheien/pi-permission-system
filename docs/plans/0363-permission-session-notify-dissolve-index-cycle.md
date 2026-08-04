---
issue: 363
issue_title: "Add `PermissionSession.notify()` and dissolve the `index.ts` forward-reference cycle"
---

# Add `PermissionSession.notify()` and dissolve the `index.ts` forward-reference cycle

## Problem Statement

The composition root (`src/index.ts`) papers over a true construction cycle with a `null`-init cast and a mutable holder.
The logger needs late-bound config-reading and UI-notify capability, but it is constructed before the `ConfigStore` and `PermissionSession` it depends on.
Today that is bridged two ways:

- `let configStore = null as unknown as ConfigStore` — the only production `as unknown as` cast in the package, used solely so the logger's `getConfig: () => configStore.current()` thunk compiles.
- `let sessionNotify: PermissionSession | null = null`, assigned `sessionNotify = session` after the session is built, with the notify sink reaching through it: `sessionNotify?.getRuntimeContext()?.ui.notify(message, "warning")`.

Two smells ride together: the `as unknown as` cast and the `getRuntimeContext()?.ui.notify(...)` Law-of-Demeter reach-through.
`PermissionSession` owns the context, so it should expose the notify behavior (Tell-Don't-Ask) rather than letting a closure reach through it to `.ui`.

This is Phase 5 Step 2 (Track A) from `docs/architecture/architecture.md`.
The change is behavior-preserving.

## Goals

- Add a `notify(message: string)` method to `PermissionSession` that tells the owned context to surface a warning (Tell-Don't-Ask), no-op when no UI context is active.
- Wire the logger's notify sink as `(m) => session.notify(m)`, replacing the `getRuntimeContext()?.ui.notify` reach-through.
- Remove the `let configStore = null as unknown as ConfigStore` cast and the `let sessionNotify` holder, ordering construction so the logger's `getConfig` / `notify` sinks resolve via lazy thunks over forward-declared bindings — no cast, no null-init holder.
- Outcome: production `as unknown as` casts drop 3 → 2 (the two remaining are JSON-serialization casts in `config-store.ts`); `index.ts` has no `null`-init holders.

This change is **not breaking**: notify behavior is identical (a warning is surfaced when a UI context is active, no-op otherwise); no public API, config, default, or output shape changes.

## Non-Goals

- Dropping the relay-only `logger` field from `PermissionSession` or injecting the logger directly into the lifecycle handler / reporter — that is Phase 5 Step 3 ([#364]), which shares edits to `permission-session.ts` and `index.ts` and lands after this step.
- Touching the `SessionLogger` interface, the `PermissionSessionLogger` class, or its `notify` dep signature — the sink stays `(message: string) => void`; only the value passed at the composition root changes.
- The anemic cache-key accessors / `CacheKeyGate` work ([#365], Track B) — different `permission-session.ts` members.
- Any change to `ConfigStore.refresh()` semantics — only its call-site ordering in the factory moves.

## Background

Relevant modules:

- `src/index.ts` — the extension factory / composition root.
  Constructs the logger first, then `configStore`, `forwarder`, `prompter`, calls `configStore.refresh()`, then builds `gateway` and `session`, then assigns `sessionNotify = session`.
  The logger's deps close over `configStore` (via `getConfig`) and `sessionNotify` (via `notify`), both of which are unavailable at logger-construction time — hence the cast and the holder.
- `src/permission-session.ts` — `PermissionSession` owns the `private context: ExtensionContext | null` field and already exposes `getRuntimeContext()` plus context-tapping methods (`reload`, `logResolvedConfigPaths` read `this.context?.cwd`).
  Adding `notify` follows the same `this.context?.…` pattern.
- `src/session-logger.ts` — `PermissionSessionLogger` (the class shipped by [#362]) takes `notify: (message: string) => void` in `SessionLoggerDeps` and routes both IO-failure warnings (deduped via `reportOnce`) and explicit `warn()` calls through it.
  The sink signature is unchanged here.
- `src/config-store.ts` — `ConfigStore.refresh()` surfaces *config-merge* warnings through the passed `ctx?.ui.notify(...)` directly (a no-op at factory-init, where it is called with no `ctx`).
  Separately, `refresh()` calls `this.deps.logger.debug("config.loaded", …)`; if that debug write fails IO, the logger's `reportOnce` path invokes the injected notify sink — the one path by which the sink can fire during construction.

Constraints from AGENTS.md / the package skill:

- "Changes to publication timing or teardown order should go through `PermissionServiceLifecycle`, not `index.ts`" — not relevant here; this change touches only collaborator construction ordering, not service publication/teardown.
- Biome bans `x!` (`noNonNullAssertion`); a `let configStore: ConfigStore | undefined` + `configStore!.current()` workaround is therefore not viable — the forward-declared annotated `let` (no initializer) is the clean path.
- Forward-declared `let x: T;` (no initializer, assigned once later) is established codebase precedent (e.g. `let state: SessionState | undefined;` in `pi-autoformat/src/extension.ts`); `prefer-const` / biome `useConst` does not flag it because a `const` cannot be declared without an initializer, so the rule cannot suggest the conversion.

## Design Overview

### The `notify` method on `PermissionSession`

`PermissionSession` owns the runtime context, so it owns the behavior of surfacing a warning through it.
The method taps the private `context` field directly (consistent with `reload` / `logResolvedConfigPaths`), short-circuiting to a no-op when no UI context is active — the same best-effort semantics the old `sessionNotify?.getRuntimeContext()?.ui.notify(...)` chain had:

```typescript
// ── UI notifications ────────────────────────────────────────────────────

/** Surface a warning message to the user via the active UI context, if any. */
notify(message: string): void {
  this.context?.ui.notify(message, "warning");
}
```

This replaces a four-link reach-through (`sessionNotify` → `getRuntimeContext()` → `?.ui` → `.notify`) with a single tell to the context-owning session.

### Construction order at the composition root

The cycle is genuine and bidirectional in two pairs:

- logger needs `configStore` (lazily, via `getConfig`); `configStore` needs `logger` (eagerly, at construction).
- logger needs `session` (lazily, via `notify`); `session` needs `logger` (eagerly, at construction).

Lazy thunks break both cycles: `getConfig` / `notify` are invoked only at log-write / warn time, never during construction.
The forward references therefore need only be *in scope* as `let` bindings — no cast, no null-init holder:

```typescript
let configStore: ConfigStore;
let session: PermissionSession;

const logger = new PermissionSessionLogger({
  globalLogsDir: paths.globalLogsDir,
  getConfig: () => configStore.current(),
  notify: (message) => session.notify(message),
});

configStore = new ConfigStore({ agentDir, policyPaths: permissionManager, logger });
// ... forwarder, prompter ...
const gateway = new PromptingGateway({ ... });
session = new PermissionSession(
  paths,
  logger,
  new ForwardingManager(paths.subagentSessionsDir, forwarder, subagentRegistry),
  permissionManager,
  sessionRules,
  configStore,
  gateway,
);

configStore.refresh(); // moved: now runs after `session` is assigned
```

### Why `configStore.refresh()` must move after `session`

`configStore.refresh()` calls `this.deps.logger.debug("config.loaded", …)`.
If that debug write fails IO (debug logging enabled + filesystem error), the logger's `reportOnce` path fires the notify sink — `(m) => session.notify(m)`.
With the old `sessionNotify?.` guard this was a safe no-op while the session was unbuilt; with a direct `session.notify(m)`, calling it while `session` is still `undefined` would throw `Cannot read properties of undefined`.

Moving `refresh()` to after the `session` assignment guarantees `session` is bound before any sink can fire.
`session.notify` then internally no-ops because `this.context` is still `null` at factory-init (no `activate()` has run yet) — preserving today's behavior exactly.
Reordering is safe: `PermissionPrompter`, `PromptingGateway`, and `PermissionSession` constructors only store references; nothing between the old and new `refresh()` positions reads merged config eagerly (handlers and the command read config at event time).

### Edge cases (all preserved)

- No UI context yet (factory-init, pre-`activate`): `this.context?` short-circuits — no-op, as today.
- UI context active (mid-session): `ctx.ui.notify(message, "warning")` — identical to the old chain's terminal call.
- Config-merge warnings in `refresh()` still flow through `ctx?.ui.notify(...)` directly (unchanged); only the *logger* sink routes through `session.notify`.

## Module-Level Changes

- `src/permission-session.ts`
  - Add the `notify(message: string): void` method (taps `this.context?.ui.notify(message, "warning")`).
    No new constructor field; no interface change.
- `src/index.ts`
  - Replace `let configStore = null as unknown as ConfigStore` with `let configStore: ConfigStore;` (annotated forward declaration, no initializer).
  - Remove `let sessionNotify: PermissionSession | null = null;` and the `sessionNotify = session;` assignment; add `let session: PermissionSession;` forward declaration and assign it in place (`session = new PermissionSession(...)`).
  - Change the logger's notify sink from `(message) => sessionNotify?.getRuntimeContext()?.ui.notify(message, "warning")` to `(message) => session.notify(message)`.
  - Move the `configStore.refresh()` call to immediately after the `session = new PermissionSession(...)` assignment.
  - Remove the now-stale forward-reference comments.
- `docs/architecture/architecture.md`
  - Update the `permission-session.ts` layout line (line ~500) to note the new `notify` UI-tell over the owned context.
  - Do **not** edit the Phase 5 metrics table or roadmap-step prose — they are phase-start snapshots, not live counts (the [#336] / [#362] convention); the `✓ complete` roadmap mark is appended at ship time by `/ship-issue`, not during this change.

Grep confirms `sessionNotify` appears only in `src/index.ts`; the `null as unknown as ConfigStore` cast appears only in `src/index.ts`.
No test references `sessionNotify`.
The package skill does not reference either, so no skill edit is required.

## Test Impact Analysis

1. New unit tests enabled: the `PermissionSession.notify()` method is directly unit-testable in isolation — previously the notify behavior lived in an `index.ts` closure reachable only through the composition root.
   New cases (in `test/permission-session.test.ts`, using `makeRealSession` + `makeCtx`, whose `ui.notify` is already a `vi.fn()`):
   - after `activate(ctx)`, `session.notify(msg)` calls `ctx.ui.notify(msg, "warning")`;
   - before activation (or after `deactivate()`), `session.notify(msg)` is a no-op and does not throw.
2. Redundant tests: none.
   No existing test covered the `index.ts` notify closure directly, so nothing is superseded.
3. Tests that must stay as-is: the existing `composition-root.test.ts` factory-construction tests (they exercise the real wiring and back-stop the reorder) and the `session-logger.test.ts` notify-sink tests (the sink signature is unchanged).

## TDD Order

The `notify` method and the `index.ts` rewiring land in **one** cycle: between adding the method and wiring its sole production caller, `notify` would be a public class member with no production caller, which `pnpm fallow dead-code` can flag as `unused-class-member`.
Folding both keeps a production caller present in the same commit.
The rewiring is behavior-preserving and is covered at the type level by `pnpm run check` and at runtime by the existing `composition-root.test.ts` factory smoke tests, so no new composition-root test is required.

1. **Add `PermissionSession.notify()` and dissolve the `index.ts` forward-reference cycle** — `refactor:`
   - Red: in `test/permission-session.test.ts`, add a `describe("notify", …)` block asserting (a) the message is forwarded to `ctx.ui.notify(message, "warning")` after `activate`, and (b) it is a no-op (no throw) before activation / after `deactivate`.
     Fails to compile because `notify` does not exist.
   - Green:
     - Add the `notify(message: string): void` method to `PermissionSession`.
     - In `index.ts`: replace the cast with `let configStore: ConfigStore;`, replace the `sessionNotify` holder with `let session: PermissionSession;`, change the notify sink to `(m) => session.notify(m)`, assign `session = new PermissionSession(...)` in place, and move `configStore.refresh()` to after that assignment; delete the stale forward-reference comments.
     - Update the `permission-session.ts` layout line in `docs/architecture/architecture.md`.
   - Verify: `pnpm run check`, the full test suite (`pnpm -r run test` or the package filter), and `pnpm fallow dead-code` (confirm `notify` has a production caller, no orphaned holder, and production `as unknown as` count dropped to 2).
   - Commit: `refactor: add PermissionSession.notify() and dissolve index.ts forward-reference cycle`.

## Risks and Mitigations

- Risk: the notify sink fires during `configStore.refresh()` while `session` is still `undefined`, throwing.
  Mitigation: move `configStore.refresh()` to after the `session` assignment (see Design Overview); `session.notify` then no-ops on the null context.
  The reorder is behavior-equivalent because no constructor between the old and new positions reads merged config eagerly.
- Risk: a linter (`prefer-const` / biome `useConst`) flags the forward-declared `let configStore` / `let session`.
  Mitigation: the rule cannot suggest `const` for a `let` declared without an initializer (assigned in a later statement), so it does not fire; established codebase precedent confirms this (`pi-autoformat/src/extension.ts`).
  `pnpm run check` is the backstop.
- Risk: a forward-declared `let` referenced in a closure trips a "used before assigned" (TS2454) error.
  Mitigation: TypeScript exempts closure captures from definite-assignment analysis (it cannot know when the closure runs); all *synchronous* uses of both bindings occur after their assignment.
  `pnpm run check` confirms.
- Risk: a hidden consumer of `sessionNotify` or the cast breaks.
  Mitigation: grep-confirmed both symbols are confined to `src/index.ts`; the single-commit rewiring keeps every importer green; `pnpm fallow dead-code` is the backstop.

## Open Questions

- None.
  The construction-ordering approach (lazy thunks over forward-declared `let` bindings + reordered `refresh()`) follows directly from the genuine cycle and is the minimal change that removes both the cast and the holder.
  Dropping the relay-only `logger` field is deferred to [#364] as planned.

[#336]: https://github.com/gotgenes/pi-packages/issues/336
[#362]: https://github.com/gotgenes/pi-packages/issues/362
[#364]: https://github.com/gotgenes/pi-packages/issues/364
[#365]: https://github.com/gotgenes/pi-packages/issues/365
