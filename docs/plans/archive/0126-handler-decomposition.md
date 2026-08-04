---
issue: 126
issue_title: "refactor: handler decomposition — ExtensionPaths, SessionLogger, ForwardingManager, PermissionSession, handler classes"
---

# Handler decomposition

## Problem statement

`HandlerDeps` is a 20-field bag passed identically to every event handler.
The handlers exhibit three structural problems:

1. **Output arguments** — every handler writes `deps.session.runtimeContext = ctx` back into the bag it received, and lifecycle handlers do scattered 4-field resets.
2. **Law of Demeter violations** — handlers reach through `deps.session.permissionManager.checkPermission(...)` and `deps.session.sessionRules.getRuleset()` to talk to strangers two levels deep.
3. **Missing encapsulation** — no object owns the mutable session state.
   Six files independently reset the same fields to the same values.

## Goals

- Replace `HandlerDeps` with handler classes that take narrow, typed constructor deps.
- Extract a `PermissionSession` class that owns all mutable session state and exposes operations instead of fields.
- Extract three intermediate abstractions (`ExtensionPaths`, `SessionLogger`, `ForwardingManager`) so `PermissionSession` takes 4 high-level deps instead of 7+ raw ones.
- No behavioral change — same permission decisions, same event emissions, same config loading.

## Non-goals

- Changing the gate descriptor/runner architecture (already clean after #107/#118).
- Changing the `/permission-system` slash command or config format.
- Refactoring `PermissionManager` or `PermissionPrompter` internals.

## Target architecture

```text
index.ts (composition root)
├── ExtensionPaths          (value object, computed from agentDir)
├── SessionLogger           (interface: debug + review + warn)
├── PermissionPrompter      (existing class, unchanged)
├── ForwardingManager       (new class, owns polling timer lifecycle)
├── PermissionSession       (new class, takes the 4 above)
│   ├── owns: PermissionManager, SessionRules, config, caches, skill entries
│   ├── exposes: checkPermission, prompt, activate, resetForNewSession, ...
│   └── can satisfy GateRunnerDeps directly
├── SessionLifecycleHandler (2 deps: session + rpcCleanup)
├── AgentPrepHandler        (2 deps: session + toolRegistry)
└── PermissionGateHandler   (3 deps: session + events + toolRegistry)
```

### Law of Demeter violations eliminated

| Before                                                  | After                               |
| ------------------------------------------------------- | ----------------------------------- |
| `deps.session.permissionManager.checkPermission(...)`   | `session.checkPermission(...)`      |
| `deps.session.permissionManager.getConfigIssues(...)`   | `session.getConfigIssues(...)`      |
| `deps.session.permissionManager.getToolPermission(...)` | `session.getToolPermission(...)`    |
| `deps.session.sessionRules.getRuleset()`                | `session.getSessionRuleset()`       |
| `deps.session.sessionRules.approve(s, p)`               | `session.approveSessionRule(s, p)`  |
| `deps.session.sessionRules.clear()`                     | `session.shutdown()` (encapsulated) |

### Output arguments eliminated

| Before                                                                               | After                                                 |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `deps.session.runtimeContext = ctx` (4 sites)                                        | `session.activate(ctx)` (encapsulated)                |
| `deps.session.activeSkillEntries = []` (3 sites)                                     | `session.resetForNewSession()` / `session.shutdown()` |
| `deps.session.lastActiveToolsCacheKey = null` (3 sites)                              | Same                                                  |
| `deps.session.lastPromptStateCacheKey = null` (3 sites)                              | Same                                                  |
| `deps.session.permissionManager = deps.createPermissionManagerForCwd(cwd)` (2 sites) | `session.resetForNewSession(ctx)` (encapsulated)      |

## Issue sequence

Each issue is independently shippable.
Later issues depend on earlier ones but each leaves the repo green.

### Phase 1: Extract intermediate abstractions (parallel-safe)

1. **#126 — ExtensionPaths** — value object extracted from `ExtensionRuntime`.
   Zero behavioral risk.
   Smallest possible change.
2. **#127 — SessionLogger** — interface unifying `writeDebugLog` + `writeReviewLog` + `notifyWarning`.
   Touches all handler files and their test factories but is mechanical find-and-replace.
3. **#128 — ForwardingManager** — class encapsulating polling timer lifecycle.
   Removes 3 fields + 2 free functions from `ExtensionRuntime`/`runtime.ts`.

Issues #126, #127, and #128 are independent of each other and can be done in any order or in parallel.
Recommended order: #126 → #127 → #128 (increasing complexity).

### Phase 2: Core abstraction

1. **#129 — PermissionSession** — class encapsulating all mutable session state.
   Depends on #126, #127, #128.
   This is the largest change — introduces the class, migrates handlers to use it, updates `HandlerDeps` to pass `PermissionSession` instead of `SessionState` + scattered helpers.
   After this step, `HandlerDeps` shrinks dramatically but still exists as a transitional type.

### Phase 3: Handler classes

1. **#130 — Handler classes** — replace `HandlerDeps` + free functions with `SessionLifecycleHandler`, `AgentPrepHandler`, `PermissionGateHandler`.
   Depends on #129.
   Deletes `HandlerDeps` and `src/handlers/types.ts`.
   Each handler class has 2–3 constructor deps.
   Test factories become trivial (mock `PermissionSession` + 1–2 other deps).

## Test impact

- **Phase 1**: Test factories update mechanically (rename fields).
  No new test files needed.
- **Phase 2**: `makeDeps()` factories shrink.
  Gate tests may need `PermissionSession` mock, but `PermissionSession` can satisfy `GateRunnerDeps` so the mock is flat.
- **Phase 3**: `makeDeps()` disappears entirely.
  Each handler test constructs `new Handler(mockSession, ...)`.
  Integration test (`permission-system.test.ts`) is unaffected — it calls `piPermissionSystemExtension(mockPi)` and never sees handler internals.

## Risks and mitigations

| Risk                                                                               | Mitigation                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Could silently weaken a permission?                                                | Pure refactor — same `checkPermission` calls, same parameters, same gate evaluation order. Integration tests validate end-to-end.                                                                                                |
| Large blast radius in phase 2 (PermissionSession)                                  | Phase 1 extractions land first, shrinking the diff. PermissionSession can be introduced alongside existing code and migrated handler-by-handler.                                                                                 |
| Handler class constructor changes are breaking for tests                           | Each handler class is in its own file with its own test file. Migration is per-handler, not all-at-once.                                                                                                                         |
| `PermissionSession` becomes a god object                                           | It encapsulates state that is already coupled (permissionManager + sessionRules + caches + skillEntries all reset together). The operations it exposes are the same ones handlers already perform — just without LoD violations. |
| Shared `PermissionSession` mock across handler tests re-introduces the bag problem | Handler tests mock only the session methods they call. TypeScript enforces that the mock satisfies the interface. Unlike `HandlerDeps`, the session mock is a single object with meaningful methods, not 20 unrelated fields.    |
