---
issue: 364
issue_title: "Inject `logger` directly; drop the relay-only field from `PermissionSession`"
---

# Inject `logger` directly; drop the relay-only field from `PermissionSession`

## Problem Statement

`PermissionSession` accepts a `SessionLogger` in its constructor but never reads it internally — it only re-exposes it as a public `readonly logger` field for other collaborators to reach through.
`SessionLifecycleHandler` reaches `this.session.logger` (a stranger reached through the session) in three places, and the composition root reaches `session.logger` once more to build the `GateDecisionReporter`.
That is a relay-only dependency and a Law-of-Demeter reach-through: every consumer already has — or can be handed — the composition-root `logger` directly, so none of them needs to go through the session.

This is Phase 5 Step 3 (Track A) of the pi-permission-system improvement roadmap.

## Goals

- Remove the `readonly logger` constructor parameter from `PermissionSession`, narrowing the constructor from 7 positional args to 6.
- Inject `SessionLogger` directly into `SessionLifecycleHandler`; replace the three `this.session.logger` reach-throughs with `this.logger`.
- Wire `GateDecisionReporter` with the composition-root `logger` instead of `session.logger`.
- Keep behavior identical — this is a structural refactor with no observable change.

This change is not breaking: it alters no public extension surface, config, output shape, or default.
All edits are internal wiring and types.

## Non-Goals

- Track B (`CacheKeyGate`, [#365]), Track C ([#366], [#367]), and Track D ([#368]) — independent Phase 5 steps, deferred.
- Reshaping the `SessionLogger` interface or `PermissionSessionLogger` class (settled in [#362]).
- Touching the logger's notify sink (`(m) => session.notify(m)`), which uses `session.notify`, not `session.logger`, and is unaffected (settled in [#363]).
- Removing the now-stale `logger` field from the `MockGateHandlerSession` test type — see Open Questions.

## Background

Relevant modules:

- `src/permission-session.ts` — `PermissionSession` class.
  The constructor's second positional arg is `readonly logger: SessionLogger`.
  Grepping the class body confirms `this.logger` is never read internally; the field exists only for external reach-through.
- `src/handlers/lifecycle.ts` — `SessionLifecycleHandler`.
  Reaches `this.session.logger.warn(issue)` once (policy issues) and `this.session.logger.debug("lifecycle.reload", …)` twice (session-start reload, resources-discover reload).
- `src/decision-reporter.ts` — `GateDecisionReporter` already accepts a `SessionLogger` as its first constructor arg; no change to the class, only to how `index.ts` wires it.
- `src/index.ts` — the composition root.
  Constructs `logger = new PermissionSessionLogger(…)`, then passes it into the `PermissionSession` constructor, and later reaches `session.logger` to build the reporter.
- Test fixtures: `test/helpers/session-fixtures.ts` (`makeRealSession`) and `test/helpers/handler-fixtures.ts` (`makeHandler`).

Prerequisites — both implemented (CLOSED):

- [#362] — converted `createSessionLogger` into the `PermissionSessionLogger` class.
- [#363] — added `PermissionSession.notify()` and dissolved the `index.ts` forward-reference cycle (removed the `null as unknown as ConfigStore` cast).

The roadmap notes this step "shares edits to `permission-session.ts` and `index.ts`" with Step 2, so it lands after [#363] to avoid conflicts.
Current `main` already contains the [#363] result (`let configStore: ConfigStore;` with no cast, notify sink `(m) => session.notify(m)`), so the dependency is satisfied.

Constraint from AGENTS.md / package skill: when a roadmap step ships, mark it `✓ complete` in `docs/architecture/architecture.md` as part of the shipping change.
That mark-complete is a ship-stage action, noted here for continuity.

## Design Overview

### Decision model

`SessionLifecycleHandler` already depends on three collaborators (`session`, `resolver`, `serviceLifecycle`).
It gains a fourth, `logger: SessionLogger` — a narrow interface (`debug` / `review` / `warn`) it fully uses (reads `warn` and `debug`).
This is a direct injection that replaces an indirect reach-through; it does not widen the dependency surface in any meaningful way (the logger was already reachable, just through the session).

`GateDecisionReporter` is unchanged: it already takes a `SessionLogger` first.
Only the composition-root argument changes from `session.logger` to the in-scope `logger`.

`PermissionSession` loses its `logger` field and the `SessionLogger` import.
The constructor narrows to 6 positional args:

```typescript
constructor(
  private readonly paths: ExtensionPaths,
  private readonly forwarding: ForwardingController,
  private readonly permissionManager: ScopedPermissionManager,
  private readonly sessionRules: SessionRules,
  private readonly configStore: SessionConfigStore,
  private readonly gateway: PromptingGatewayLifecycle,
) {}
```

### Handler call-site sketch (verifies the injection pattern)

After the change, `SessionLifecycleHandler` tells its own injected logger rather than reaching through the session:

```typescript
// handlers/lifecycle.ts (after)
for (const issue of policyIssues) {
  this.logger.warn(issue);
}
// ...
this.logger.debug("lifecycle.reload", { triggeredBy: "session_start", reason, cwd });
```

The composition root hands every consumer the same `logger` instance it already holds — no object reaches through another:

```typescript
// index.ts (after)
const lifecycle = new SessionLifecycleHandler(session, resolver, serviceLifecycle, logger);
const reporter = new GateDecisionReporter(logger, pi.events);
```

This follows Tell-Don't-Ask (the handler tells the logger) and the Law of Demeter (no `session.logger` chain).

### Edge cases

- No runtime behavior changes: the same `PermissionSessionLogger` instance receives the same `warn` / `debug` / `review` calls in the same order.
- `PermissionSession.notify()` (the UI sink) is independent of `session.logger` and stays as-is.

## Module-Level Changes

Source:

- `src/permission-session.ts` — remove the `readonly logger: SessionLogger` constructor parameter; remove the now-unused `import type { SessionLogger }`; update the class-level JSDoc "Constructor deps" list to drop the `SessionLogger` bullet.
- `src/handlers/lifecycle.ts` — add `private readonly logger: SessionLogger` as the fourth constructor parameter; add `import type { SessionLogger } from "#src/session-logger"`; replace the three `this.session.logger.*` calls with `this.logger.*`; update the constructor-deps JSDoc to document `logger`.
- `src/index.ts` — drop the `logger` argument from `new PermissionSession(…)`; pass `logger` as the fourth argument to `new SessionLifecycleHandler(session, resolver, serviceLifecycle, logger)`; change `new GateDecisionReporter(session.logger, pi.events)` to `new GateDecisionReporter(logger, pi.events)`.

Tests:

- `test/helpers/session-fixtures.ts` — drop the `logger` argument from the `new PermissionSession(…)` call in `makeRealSession`.
  Keep `makeLogger()` and continue returning `logger` in the result bag (tests still wire it into the handler and reporter).
- `test/helpers/handler-fixtures.ts` — add `logger` to `makeHandler`'s returned bag (it is already destructured from `makeRealSession` and passed to `new GateDecisionReporter`); no other change.
- `test/handlers/lifecycle.test.ts` — `makeSetup` constructs the handler with an explicit `logger` arg.
  Pass a logger that is distinct from the session's collaborators so the existing `logger.warn` / `logger.debug` assertions genuinely verify direct injection (see Test Impact Analysis).
- `test/handlers/external-directory-integration.test.ts` — destructure `logger` from `makeHandler(…)` and replace the three `session.logger.review` reads with `logger.review`.

Docs:

- `.pi/skills/package-pi-permission-system/SKILL.md` — update the documented `makeHandler` return bag to include `logger`.
- `docs/architecture/architecture.md` — mark Phase 5 Step 3 `✓ complete` (ship-stage action; the Phase 5 baseline/target metric table is a phase-level summary and is not edited per-step).

No `docs/architecture/` layout/complexity listing references the `logger` field directly, so no diagram updates are required beyond the step-complete mark.

## Test Impact Analysis

1. New coverage enabled.
   Today `lifecycle.test.ts` cannot distinguish "handler uses `session.logger`" from "handler uses an injected logger" because `makeRealSession` returns the same logger instance the session holds.
   After injection, the handler can be handed a logger that is independent of the session, so the existing `logger.warn` / `logger.debug` assertions become a genuine test of direct injection.
   This is the meaningful red→green in Step 1: assert against a distinct injected logger first (fails while the handler reads `this.session.logger`), then wire the injection (passes).

2. Redundant coverage.
   None.
   No test asserts the existence of the `PermissionSession.logger` field directly (`permission-session.test.ts` has zero `logger` references), so nothing becomes dead.
   The three `session.logger.review` reads in `external-directory-integration.test.ts` are re-pointed at the fixture `logger`, asserting the same behavior.

3. Coverage that must stay.
   The `external-directory-integration.test.ts` review-log assertions stay — they verify the reporter writes (or does not write) block entries through the logger.
   They move from `session.logger.review` to the fixture `logger.review` (the same instance the reporter receives), so the assertion's meaning is preserved.

## TDD Order

1. Inject `logger` into `SessionLifecycleHandler` (keep the `PermissionSession.logger` field intact).
   - Surface: `test/handlers/lifecycle.test.ts`.
   - Red: change `makeSetup` to pass an explicit, session-independent `logger` (e.g. a second `makeLogger()`) as a fourth constructor arg and keep asserting `logger.warn` / `logger.debug`.
     This fails to compile against the 3-arg handler and, once compiling, fails because the handler still reads `this.session.logger`.
   - Green: add the `logger` constructor parameter to `SessionLifecycleHandler`, switch the three `this.session.logger.*` calls to `this.logger.*`, update its JSDoc and import, and pass `logger` from `index.ts`.
   - This commit leaves `PermissionSession.logger` in place (still read only by the reporter wiring), so the whole tree type-checks.
   - Commit: `refactor: inject logger into SessionLifecycleHandler (#364)`.

2. Drop the relay-only `logger` field from `PermissionSession` and re-point the reporter wiring.
   - Surface: `src/permission-session.ts`, `src/index.ts`, `test/helpers/session-fixtures.ts`, `test/helpers/handler-fixtures.ts`, `test/handlers/external-directory-integration.test.ts`.
   - This is one commit: removing the constructor field breaks every `new PermissionSession(…)` call site and every `session.logger` read at the type level simultaneously, so the field removal, both construction-site updates, the reporter rewire, the `makeHandler` return addition, and the external-directory test re-point must all land together.
   - Steps: remove the `readonly logger` parameter and its import/JSDoc from `PermissionSession`; drop the `logger` argument from `new PermissionSession(…)` in `index.ts` and in `makeRealSession`; change `new GateDecisionReporter(session.logger, …)` to `new GateDecisionReporter(logger, …)`; add `logger` to `makeHandler`'s return; re-point the three `session.logger.review` reads to the fixture `logger`.
   - Green: `pnpm run check` and `pnpm run test` pass; the constructor is 6 args.
   - Commit: `refactor: drop relay-only logger field from PermissionSession (#364)`.

3. Align documentation.
   - Surface: `.pi/skills/package-pi-permission-system/SKILL.md`.
   - Update the documented `makeHandler` return bag to include `logger`.
   - Commit: `docs(pi-permission-system): document logger in makeHandler return (#364)`.
   - The `docs/architecture/architecture.md` step-complete mark is performed at ship time per the package convention.

## Risks and Mitigations

- Risk: missing a `session.logger` consumer.
  Mitigation: the full-tree grep found exactly four reach-throughs (3 in `lifecycle.ts`, 1 in `index.ts`) plus three test reads in `external-directory-integration.test.ts`; the TypeScript compiler will reject any missed site once the field is removed in Step 2.
- Risk: Step 2 is a multi-file atomic change; a partial edit leaves the tree red.
  Mitigation: it is a single commit gated by `pnpm run check`; the interlock is intentional and small (six files).
- Risk: stale documentation.
  Mitigation: Step 3 updates the package skill; the architecture step-complete mark is part of ship.

## Open Questions

- The `MockGateHandlerSession` test type in `handler-fixtures.ts` still carries a `logger: SessionLogger` member (commented "Logger shape expected by GateDecisionReporter").
  After this change the real session no longer exposes a logger and nothing reads `.logger` off that mock type.
  Removing it is a tidy-up but would also require a SKILL.md edit (the type is documented there); defer unless it proves to be dead weight during implementation.

[#362]: https://github.com/gotgenes/pi-packages/issues/362
[#363]: https://github.com/gotgenes/pi-packages/issues/363
[#365]: https://github.com/gotgenes/pi-packages/issues/365
[#366]: https://github.com/gotgenes/pi-packages/issues/366
[#367]: https://github.com/gotgenes/pi-packages/issues/367
[#368]: https://github.com/gotgenes/pi-packages/issues/368
