---
issue: 319
issue_title: "Introduce PermissionResolver and remove the session-rule relay from the permission gates"
---

# Introduce PermissionResolver and remove the session-rule relay

## Problem Statement

Every permission gate is handed two functions, `checkPermission` and `getSessionRuleset`, but `getSessionRuleset` is never used on its own.
At all five call sites — `runGateCheck` plus `describePathGate`, `describeBashPathGate`, `describeBashExternalDirectoryGate`, and `resolveBashCommandCheck` — the ruleset is fetched only to be handed straight back into the next `checkPermission` call:

```typescript
const sessionRules = getSessionRuleset();
const check = checkPermission(surface, input, agent, sessionRules);
```

So the pair is not two collaborators; it is one operation — "resolve the effective permission, applying the current session rules" — split into a primitive plus a relay.
This is the first step of a larger rework: the `GateRunnerDeps` closure bag in `handleToolCall` conflates this relay with four genuine roles, and the relay must go before the roles become visible.

## Goals

- Define a narrow `PermissionResolver` interface exposing a single `resolve(surface, input, agentName?)` operation.
- Have `PermissionSession` implement it by composing `checkPermission` with `getSessionRuleset` internally.
- Migrate all four gate descriptor producers and `resolveBashCommandCheck` to depend on `PermissionResolver` instead of the `checkPermission` + `getSessionRuleset` pair.
- Replace the `checkPermission` + `getSessionRuleset` members of the `GateRunnerDeps` bag with `resolve`.
- Keep the change behavior-preserving.

## Non-Goals

- Extracting the `DecisionReporter` (`writeReviewLog` + `emitDecision`) collaborator — that is #322.
- Replacing `GateRunnerDeps` with a `GateRunner` class injected with role collaborators, and adding the `GatePrompter` role — that is #323.
- Changing any permission decision, log entry, or decision-event payload.
- Touching `handleInput` (it calls `session.checkPermission` directly with no session-rule relay and is out of scope).

## Background

- `src/handlers/gates/runner.ts` (`runGateCheck`) resolves the check via `deps.checkPermission(surface, input, agent, deps.getSessionRuleset())` unless `preCheck`/`preResolved` short-circuits it.
- `src/handlers/gates/{path,bash-path,bash-external-directory}.ts` each declare a local `CheckPermissionFn` type and take `(checkPermission, getSessionRuleset)`; each calls `getSessionRuleset()` once, then `checkPermission(..., sessionRules)` one or more times.
- `src/handlers/gates/bash-command.ts` (`resolveBashCommandCheck`) takes `(command, commands, agentName, sessionRules, checkPermission)` and calls `checkPermission(..., sessionRules)` per command unit.
- `src/handlers/permission-gate-handler.ts` builds `checkPermission` and `getSessionRuleset` closures over `this.session`, threads them into every gate producer and the inline tool-gate resolution, and packs them into the `GateRunnerDeps` bag.
- `PermissionSession` already exposes both `checkPermission(surface, input, agentName?, sessionRules?)` and `getSessionRuleset()`.
- `SessionRules.getRuleset()` returns a fresh array copy (`[...this.rules]`) on each call.

Constraint from AGENTS.md / `code-design`: when a shared interface references a collaborator, use a narrow interface type, not the concrete class; keep Pi SDK imports out of the new pure module.

## Design Overview

A single new role interface:

```typescript
// src/permission-resolver.ts
import type { PermissionCheckResult } from "./types";

/**
 * Resolves the effective permission for a surface/input, applying the
 * current session rules internally. Collapses the checkPermission +
 * getSessionRuleset relay that every gate previously threaded by hand.
 */
export interface PermissionResolver {
  resolve(
    surface: string,
    input: unknown,
    agentName?: string,
  ): PermissionCheckResult;
}
```

`PermissionSession` implements it:

```typescript
class PermissionSession implements PermissionResolver {
  resolve(
    surface: string,
    input: unknown,
    agentName?: string,
  ): PermissionCheckResult {
    return this.checkPermission(
      surface,
      input,
      agentName,
      this.getSessionRuleset(),
    );
  }
}
```

Gate consumer call site (replaces the `(checkPermission, getSessionRuleset)` pair):

```typescript
// describePathGate, after migration
const check = resolver.resolve("path", { path: filePath }, tcc.agentName ?? undefined);
```

The module is a pure type — no SDK imports, no behavior — so the session imports it downward (`./permission-resolver`) and the gates/runner import it via `#src/permission-resolver`.
No import cycle: the resolver references only `PermissionCheckResult` from `types.ts`.

Edge cases:

- Multi-check gates (`describeBashPathGate`, `describeBashExternalDirectoryGate`) previously snapshotted the ruleset once and reused it across token checks; after migration `resolve` re-snapshots per call.
  Because no `recordSessionApproval` happens during descriptor construction, every snapshot within a gate is equal — behavior-preserving (see Risks).
- `resolveBashCommandCheck`'s empty-`commands` fallback still calls `resolve("bash", { command }, agentName)`, matching the prior whole-command `checkPermission` fallback.
- `GateRunnerDeps` keeps `resolve` aligned with the interface by extending it (`interface GateRunnerDeps extends PermissionResolver { … }`).

## Module-Level Changes

- `src/permission-resolver.ts` — **new**: the `PermissionResolver` interface.
- `src/permission-session.ts` — add `implements PermissionResolver` and the `resolve` method; import the interface type.
- `src/handlers/gates/path.ts` — replace the `checkPermission` + `getSessionRuleset` params with a single `resolver: PermissionResolver`; drop the local `CheckPermissionFn` type; call `resolver.resolve(...)`.
- `src/handlers/gates/bash-path.ts` — same migration; the per-token loop calls `resolver.resolve(...)`.
- `src/handlers/gates/bash-external-directory.ts` — same migration.
- `src/handlers/gates/bash-command.ts` — `resolveBashCommandCheck` drops the `sessionRules` and `checkPermission` params for a single `resolver: PermissionResolver`; drop the local `CheckPermissionFn` type.
- `src/handlers/gates/descriptor.ts` — `GateRunnerDeps`: remove `checkPermission` and `getSessionRuleset`; `extends PermissionResolver` to gain `resolve`.
- `src/handlers/gates/runner.ts` — resolve the check via `deps.resolve(descriptor.surface, descriptor.input, agentName ?? undefined)`.
- `src/handlers/permission-gate-handler.ts` — expose `this.session` as `PermissionResolver` to every gate producer and the inline tool-gate resolution; set the bag's `resolve`; remove the now-unused `checkPermission` and `getSessionRuleset` closures.
- `test/helpers/gate-fixtures.ts` — add `makeResolver(overrides)` returning `{ resolve: vi.fn() }`; update `makeRunnerDeps` to expose `resolve` instead of `checkPermission` + `getSessionRuleset`.
- `test/handlers/gates/{path,bash-path,bash-external-directory,bash-command,runner}.test.ts` — inject a resolver mock; assert on `resolver.resolve(surface, input, agentName)` (three args, no ruleset) instead of `checkPermission(..., sessionRules)`.
- `docs/architecture/architecture.md` — add `permission-resolver.ts` to the `src/` file tree; reframe the Phase 3 Track C roadmap entry (old Step 6 "GateRunnerContext narrow interface") into the three-step decomposition (#319 resolver, #322 reporter, #323 GateRunner), and update the matching Mermaid node and Track C summary row.

No removed or renamed public exports; `getSessionRuleset` and `checkPermission` remain on `PermissionSession` (still used by `resolve`, `handleInput`, and other callers).
A repo-wide grep confirms no other consumer imports the gates' local `CheckPermissionFn` types (they are file-private).

## Test Impact Analysis

1. New unit tests enabled: `PermissionSession.resolve` can now be tested in isolation — that it forwards the surface/input/agent and applies the current session ruleset.
   This composition was previously implicit in every gate's wiring and never unit-tested on its own.
2. Tests simplified: the five gate/runner test files drop the separate `getSessionRuleset` mock and the four-argument `checkPermission` assertion, asserting instead on a single three-argument `resolver.resolve` call — fewer moving parts per test.
3. Tests that stay as-is: every gate descriptor test keeps exercising its gate's branching logic (null/bypass/descriptor, most-restrictive selection, backward-compat `matchedPattern === undefined` handling); only the injected collaborator and its assertion shape change.

## TDD Order

1. Add `PermissionResolver` + `PermissionSession.resolve`.
   Surface: `test/permission-session.test.ts`.
   Covers: `resolve` forwards `surface`/`input`/`agentName` and applies the session ruleset; reflects a recorded approval on the next `resolve`.
   Commit: `feat: add PermissionResolver.resolve to PermissionSession`.
2. Migrate `describePathGate` to `PermissionResolver`; add `makeResolver` to `gate-fixtures.ts`; update `path.test.ts` and the handler call site (handler keeps the old closures for the not-yet-migrated gates and the runner bag).
   Commit: `refactor: migrate describePathGate to PermissionResolver`.
3. Migrate `describeBashExternalDirectoryGate`; update its test and the handler call site.
   Commit: `refactor: migrate describeBashExternalDirectoryGate to PermissionResolver`.
4. Migrate `describeBashPathGate`; update its test and the handler call site.
   Commit: `refactor: migrate describeBashPathGate to PermissionResolver`.
5. Migrate `resolveBashCommandCheck` and the inline tool-gate resolution in `handleToolCall`; update `bash-command.test.ts`.
   Commit: `refactor: migrate resolveBashCommandCheck to PermissionResolver`.
6. Replace the bag's `checkPermission` + `getSessionRuleset` with `resolve`: update `GateRunnerDeps` (`extends PermissionResolver`), `runner.ts`, `makeRunnerDeps`, `runner.test.ts`, and remove the handler's now-unused closures.
   Commit: `refactor: resolve via PermissionResolver in the gate runner`.
7. Update `docs/architecture/architecture.md` (file tree + Phase 3 Track C roadmap reframing).
   Commit: `docs: reframe Phase 3 Track C into the gate-runner collaborator decomposition`.

Each step changes one gate's signature plus its single handler call site and its test in the same commit — the type checker would reject splitting them.
The handler carries both the resolver and the legacy closures through steps 2–5, so the repo stays green between commits; step 6 deletes the last closures once no consumer remains.

## Risks and Mitigations

- Per-call ruleset snapshot: `getRuleset()` copies the array each call, so multi-token gates now snapshot per `resolve` instead of once per gate.
  Mitigation: no `recordSessionApproval` runs during descriptor construction, so all snapshots within a gate are identical; the result is unchanged and the extra allocations are negligible for realistic ruleset/token sizes.
- Mechanical breadth: five gate/runner test files change their injected collaborator.
  Mitigation: a shared `makeResolver` fixture and one-gate-per-commit sequencing keep each diff small and reviewable.
- Inline tool-gate coupling: `handleToolCall` resolves the tool check via both `resolveBashCommandCheck` and a direct `checkPermission` call.
  Mitigation: migrate both in step 5 so the inline path flips to `resolve` atomically.

## Open Questions

- The home and grouping of the remaining roles (`GatePrompter`, `SessionApprovalRecorder`, `DecisionReporter`) are deferred to #322 and #323; this plan introduces only `PermissionResolver`.
