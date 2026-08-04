---
issue: 221
issue_title: "Expose subagent session registry and tool-level permission query on PermissionsService"
---

# Subagent session registry and tool-level permission query

## Problem Statement

`PermissionsService` currently exposes only `checkPermission(surface, value?, agentName?)`.
In-process subagent extensions (like `@gotgenes/pi-subagents`) cannot:

1. Signal that a session is a child — `isSubagentExecutionContext()` relies on env vars (process-based) and filesystem-path matching (`session dir ⊂ subagentSessionsDir`), neither of which works for in-process children.
2. Provide a parent session ID for `ask`-state forwarding — `resolvePermissionForwardingTargetSessionId()` only reads env var candidates.
3. Efficiently check tool-level permissions — consumers must call `checkPermission` per tool and interpret the full result; the internal `PermissionManager.getToolPermission()` is not exposed.

## Goals

- Add `registerSubagentSession` and `unregisterSubagentSession` methods to `PermissionsService`.
- Add `getToolPermission(toolName, agentName?)` method to `PermissionsService`.
- Update `isSubagentExecutionContext()` to check the session registry before falling back to env vars and filesystem heuristics.
- Update `resolvePermissionForwardingTargetSessionId()` to read `parentSessionId` from the registry when env vars are absent.
- All additions are backwards-compatible (semver-minor).

## Non-Goals

- Changing the `checkPermission` method signature or behavior.
- Adding bulk `filterToolsForAgent(tools[], agentName)` — consumers compose this from `getToolPermission` themselves.
- Implementing the pi-subagents consumer side (that is #101).
- Changing how process-based subagent detection (env vars) works.
- Changing the file-based forwarding mechanism itself.

## Background

### Current detection flow in `isSubagentExecutionContext()`

```typescript
function isSubagentExecutionContext(ctx, subagentSessionsDir): boolean {
  // 1. Check env vars (process-based subagent extensions)
  for (const key of SUBAGENT_ENV_HINT_KEYS) { ... }
  // 2. Check filesystem path (session dir within known subagent dir)
  return isPathWithinDirectory(sessionDir, subagentSessionsDir);
}
```

Pi-subagents stores sessions under `<parent-dir>/<parent-basename>/tasks/`, which is NOT within `<agentDir>/subagent-sessions/`.
So filesystem detection fails for in-process children created by `@gotgenes/pi-subagents`.

### Current forwarding target resolution

```typescript
function resolvePermissionForwardingTargetSessionId(options): string | null {
  if (options.hasUI) return normalize(options.currentSessionId);
  if (!options.isSubagent) return null;
  // Only checks env vars — no other source
  for (const key of SUBAGENT_PARENT_SESSION_ENV_CANDIDATES) { ... }
  return null;
}
```

When `isSubagent` is true but no env var is set, `null` is returned and forwarding fails with a logged error.

### `PermissionManager.getToolPermission()`

Already exists internally with clear semantics:

```typescript
getToolPermission(toolName: string, agentName?: string): PermissionState {
  const { composedRules } = this.resolvePermissions(agentName);
  return evaluate(normalizedToolName, "*", composedRules).action;
}
```

This needs only a one-line delegation on the service.

### Concurrency consideration

Multiple in-process subagents may run concurrently (background agents).
A scalar flag on `globalThis` would cause race conditions.
A session-keyed `Map` (keyed by session directory path) is race-safe because each session has a unique directory.

## Design Overview

### Subagent session registry

A `Map<string, SubagentSessionInfo>` stored on `globalThis` via `Symbol.for()`.
Both the provider (pi-subagents) and reader (pi-permission-system) access the same map through accessor helpers.

```typescript
/** Signal stored per registered in-process subagent session. */
export interface SubagentSessionInfo {
  /** Parent session ID for permission forwarding. */
  parentSessionId?: string;
  /** Agent name for per-agent policy resolution. */
  agentName: string;
}
```

The key is the session directory path (from `ctx.sessionManager.getSessionDir()`), which is unique per session and available to both the producer and consumer.

Consumer call site (pi-subagents, 3 lines):

```typescript
const svc = getPermissionsService();
svc?.registerSubagentSession(sessionDir, { parentSessionId, agentName });
// ... after session completes:
svc?.unregisterSubagentSession(sessionDir);
```

### Updated detection flow

```typescript
function isSubagentExecutionContext(ctx, subagentSessionsDir): boolean {
  // 1. Check explicit registry (in-process subagent extensions)
  if (isRegisteredSubagentSession(sessionDir)) return true;
  // 2. Check env vars (process-based subagent extensions)
  for (const key of SUBAGENT_ENV_HINT_KEYS) { ... }
  // 3. Check filesystem path (fallback heuristic)
  return isPathWithinDirectory(sessionDir, subagentSessionsDir);
}
```

### Updated forwarding target resolution

```typescript
function resolvePermissionForwardingTargetSessionId(options): string | null {
  if (options.hasUI) return normalize(options.currentSessionId);
  if (!options.isSubagent) return null;
  // 1. Check explicit registry for parent session ID
  const registered = getRegisteredSubagentSession(sessionDir);
  if (registered?.parentSessionId) return registered.parentSessionId;
  // 2. Fall back to env vars
  for (const key of SUBAGENT_PARENT_SESSION_ENV_CANDIDATES) { ... }
  return null;
}
```

Note: `resolvePermissionForwardingTargetSessionId` currently doesn't receive the session directory.
We need to add `sessionDir?: string` to its options interface, threading it from the call site that already has `ctx.sessionManager.getSessionDir()`.

### Extended `PermissionsService` interface

```typescript
export interface PermissionsService {
  checkPermission(
    surface: string,
    value?: string,
    agentName?: string,
  ): PermissionCheckResult;

  /** Register an in-process subagent session for detection and forwarding. */
  registerSubagentSession(sessionKey: string, info: SubagentSessionInfo): void;

  /** Unregister a previously registered subagent session. */
  unregisterSubagentSession(sessionKey: string): void;

  /** Query tool-level permission state (deny/allow/ask) for pre-filtering. */
  getToolPermission(toolName: string, agentName?: string): PermissionState;
}
```

### Registry storage

The registry `Map` is stored on the `ExtensionRuntime` (not on `globalThis` directly).
The service adapter delegates `register`/`unregister` to a `SubagentSessionRegistry` class.
Detection functions receive the registry as a parameter (testable without global state).

```typescript
export class SubagentSessionRegistry {
  private readonly sessions = new Map<string, SubagentSessionInfo>();

  register(sessionKey: string, info: SubagentSessionInfo): void {
    this.sessions.set(sessionKey, info);
  }

  unregister(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }

  get(sessionKey: string): SubagentSessionInfo | undefined {
    return this.sessions.get(sessionKey);
  }

  has(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }
}
```

This class lives in a new module `src/subagent-registry.ts`.
It follows the "State owns its mutations" principle from the architecture.

### Why not store on `globalThis` directly?

The `PermissionsService` is already on `globalThis` via `Symbol.for()`.
Consumers call `getPermissionsService()?.registerSubagentSession(...)`.
The registry is internal state of the permission system, not a standalone protocol.
This keeps ownership clear — pi-permission-system owns the registry; consumers interact through the typed service interface.

## Module-Level Changes

### New files

| File                       | Purpose                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `src/subagent-registry.ts` | `SubagentSessionRegistry` class + `SubagentSessionInfo` type |

### Modified files

| File                                   | Change                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/service.ts`                       | Extend `PermissionsService` interface with 3 new methods; export `SubagentSessionInfo` type      |
| `src/index.ts`                         | Construct `SubagentSessionRegistry`; wire new service methods in the `permissionsService` object |
| `src/subagent-context.ts`              | Add `registry` parameter to `isSubagentExecutionContext()`; check it first                       |
| `src/permission-forwarding.ts`         | Add `sessionDir?` to `resolvePermissionForwardingTargetSessionId` options; check registry        |
| `src/forwarding-manager.ts`            | Thread registry through to `isSubagentExecutionContext` call                                     |
| `src/forwarded-permissions/polling.ts` | Thread registry + sessionDir through to detection/resolution calls                               |
| `src/permission-prompter.ts`           | Thread registry into forwarding deps (for `confirmPermission` call)                              |
| `src/runtime.ts`                       | Add `subagentRegistry` field to `ExtensionRuntime`                                               |
| `src/yolo-mode.ts`                     | No change (already correct)                                                                      |

### Test files

| File                                   | Change                                         |
| -------------------------------------- | ---------------------------------------------- |
| `test/subagent-registry.test.ts` (new) | Unit tests for `SubagentSessionRegistry`       |
| `test/subagent-context.test.ts`        | Add tests for registry-based detection         |
| `test/permission-forwarding.test.ts`   | Add tests for registry-based target resolution |
| `test/service.test.ts`                 | Add tests for new service methods              |

## Test Impact Analysis

1. **New tests enabled**: `SubagentSessionRegistry` can be tested in pure isolation (no filesystem, no env vars, no SDK).
   Detection and forwarding can now be tested with explicit registry entries instead of env var stubbing.
2. **Existing tests unchanged**: All env-var and filesystem detection tests remain valid — those paths still execute when the registry has no matching entry.
3. **Signature change tests**: Tests that call `isSubagentExecutionContext(ctx, subagentSessionsDir)` must add the registry parameter.
   Tests for `resolvePermissionForwardingTargetSessionId` must add `sessionDir` to the options object.

## TDD Order

### Step 1: `SubagentSessionRegistry` class

- Test: `register`, `unregister`, `get`, `has` operations
- Green: Implement `src/subagent-registry.ts`
- Commit: `feat(pi-permission-system): add SubagentSessionRegistry class`

### Step 2: Extend `PermissionsService` interface and service wiring

- Test: `service.test.ts` — new methods delegate correctly
- Green: Extend interface in `src/service.ts`; wire in `src/index.ts` using the registry and `PermissionManager.getToolPermission()`
- Commit: `feat(pi-permission-system): expose registry and getToolPermission on PermissionsService`

### Step 3: Registry-aware subagent detection

- Test: `subagent-context.test.ts` — returns true when session key is in registry (no env vars, no filesystem match)
- Green: Add `registry` parameter to `isSubagentExecutionContext()`; check it first
- Update all callers: `forwarding-manager.ts`, `forwarded-permissions/polling.ts`, `index.ts`
- Commit: `feat(pi-permission-system): detect in-process subagents via session registry`

### Step 4: Registry-aware forwarding target resolution

- Test: `permission-forwarding.test.ts` — returns `parentSessionId` from registry when env vars absent
- Green: Add `sessionDir?` to options; check registry before env vars
- Update call sites: `forwarded-permissions/polling.ts`
- Commit: `feat(pi-permission-system): resolve forwarding target from subagent registry`

### Step 5: Thread registry through remaining callers

- Update `runtime.ts` to hold the registry instance
- Update `permission-prompter.ts` and `forwarding-manager.ts` to pass registry
- Run full test suite; fix any callers still using the old 2-arg signature
- Commit: `refactor(pi-permission-system): thread SubagentSessionRegistry through runtime`

### Step 6: Documentation

- Update `README.md` cross-extension integration section
- Commit: `docs(pi-permission-system): document subagent session registry API`

## Risks and Mitigations

| Risk                                                                         | Mitigation                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signature change to `isSubagentExecutionContext` breaks call sites           | Lift-and-shift: add optional `registry?` parameter first, make required in a follow-up step within the same PR                                                    |
| Registry entries leak if `unregisterSubagentSession` is never called (crash) | Document that consumers MUST unregister in a `finally` block; registry entries are harmless (detection returns true for a session that no longer exists — benign) |
| Multiple extensions could call `registerSubagentSession` for the same key    | Last-write-wins semantics (Map.set); documented as single-writer expected                                                                                         |
| Adding methods to `PermissionsService` interface                             | Backwards-compatible: existing consumers only call `checkPermission`; new methods are additive                                                                    |

## Open Questions

1. Should `getToolPermission` also accept session rules (like `checkPermission` does internally)?
   Deferred — start with the simple delegation; add if a consumer needs it.
2. Should the registry be cleared on `session_shutdown`?
   No — the registry is process-scoped and outlives individual sessions.
   Entries are managed by the producer (pi-subagents), not the permission system.
