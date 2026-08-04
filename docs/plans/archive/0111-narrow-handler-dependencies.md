---
issue: 111
issue_title: "refactor: narrow handler dependencies and runtime access"
---

# Narrow handler dependencies by eliminating deep mocking

## Problem Statement

Every handler test file contains a near-identical `makeRuntime()` factory constructing an 18-field `ExtensionRuntime` mock.
Gate tests must build deeply nested mock trees — `deps.runtime.permissionManager.checkPermission`, `deps.runtime.sessionRules.getRuleset()` — with `as unknown as` casts, even though each gate only calls 5–7 leaf methods.

The pain shows up concretely in tests:

1. **Copy-paste `makeRuntime()`** — 6 files × identical 18-field factories.
   Adding a field to `ExtensionRuntime` breaks all 6.
2. **Deep mock nesting** — `deps.runtime.permissionManager.checkPermission` is 3 levels deep.
   Every test that cares about a permission result wraps it in two objects.
3. **Irrelevant fields in scope** — gate tests never read `permissionForwardingTimer`, `lastConfigWarning`, `globalLogsDir`, yet must provide them.
4. **`deps.runtime.runtimeContext!`** — gates fish out the context only to pass it back to `deps.promptPermission(ctx, ...)`.
   The `ctx` was already available to `handleToolCall`.
5. **Two-tier override dance** — tests override both `makeDeps({ runtime: makeRuntime({ ... }) })` AND `makeDeps({ promptPermission: ... })` for the same scenario.

## Goals

- Each gate declares a **flat, per-gate interface** with only the leaf methods it calls — no object nesting, no `ExtensionContext`, no `.runtime.`.
- Gate tests become trivial: flat `vi.fn()` stubs, zero `as unknown as` casts.
- The orchestrator (`handleToolCall`) builds closure-based adapters that capture `ctx` — gates never see `ExtensionContext`.
- Lifecycle handlers (`handleSessionStart`, etc.) access mutable state through a slim `SessionState` interface, not the full 18-field runtime.
- No behavioral change — same permission decisions, same event emissions.

## Non-Goals

- Removing `ExtensionRuntime` entirely — it remains as the internal composition root in `src/index.ts`.
- Changing the `/permission-system` slash command or config format.
- Refactoring `applyPermissionGate` — it already follows the right pattern (injected callbacks).
- Extracting `handleInput`'s permission logic into a gate (follow-up).

## Related Issues

- **#114** (closed as duplicate of #111) — describes the per-gate interface segregation in detail.
  Folded into this plan.
- **#107** — extracted gate functions into `src/handlers/gates/`.
  Already implemented.
  This plan narrows their dependency signatures.

## Background

### What each gate actually calls (leaf methods)

| Gate                                | Leaf methods used                                                                                                                                           |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evaluateToolGate`                  | `checkPermission`, `getSessionRuleset`, `approveSessionRule`, `writeReviewLog`, `emitDecision`, `canConfirm`, `promptPermission`                            |
| `evaluateExternalDirectoryGate`     | `checkPermission`, `getSessionRuleset`, `approveSessionRule`, `writeReviewLog`, `emitDecision`, `canConfirm`, `promptPermission`, `getPiInfrastructureDirs` |
| `evaluateBashExternalDirectoryGate` | `checkPermission`, `getSessionRuleset`, `approveSessionRule`, `writeReviewLog`, `canConfirm`, `promptPermission`                                            |
| `evaluateSkillReadGate`             | `getActiveSkillEntries`, `writeReviewLog`, `emitDecision`, `canConfirm`, `promptPermission`, `createRequestId`                                              |

Note: `canConfirm` and `promptPermission` in the narrow interface do NOT take `ctx` — the adapter closure captures it.

### Permission surfaces involved

None directly — pure internal refactor.
All surfaces are exercised by the handlers being refactored; integration tests validate correctness.

## Design Overview

### Per-gate flat interfaces

```typescript
/** Narrow deps for evaluateToolGate — every field is a leaf method. */
export interface ToolGateDeps {
  checkPermission(
    surface: string,
    input: unknown,
    agentName?: string,
    sessionRules?: Rule[],
  ): PermissionCheckResult;
  getSessionRuleset(): Rule[];
  approveSessionRule(surface: string, pattern: string): void;
  writeReviewLog(event: string, details: Record<string, unknown>): void;
  emitDecision(event: PermissionDecisionEvent): void;
  canConfirm(): boolean;
  promptPermission(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision>;
}

/** Narrow deps for evaluateExternalDirectoryGate. */
export interface ExternalDirectoryGateDeps {
  checkPermission(
    surface: string,
    input: unknown,
    agentName?: string,
    sessionRules?: Rule[],
  ): PermissionCheckResult;
  getSessionRuleset(): Rule[];
  approveSessionRule(surface: string, pattern: string): void;
  writeReviewLog(event: string, details: Record<string, unknown>): void;
  emitDecision(event: PermissionDecisionEvent): void;
  canConfirm(): boolean;
  promptPermission(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision>;
  /** Resolved infrastructure dirs (static + config-based). */
  getInfrastructureDirs(): string[];
}

/** Narrow deps for evaluateBashExternalDirectoryGate. */
export interface BashExternalDirectoryGateDeps {
  checkPermission(
    surface: string,
    input: unknown,
    agentName?: string,
    sessionRules?: Rule[],
  ): PermissionCheckResult;
  getSessionRuleset(): Rule[];
  approveSessionRule(surface: string, pattern: string): void;
  writeReviewLog(event: string, details: Record<string, unknown>): void;
  canConfirm(): boolean;
  promptPermission(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision>;
}

/** Narrow deps for evaluateSkillReadGate. */
export interface SkillReadGateDeps {
  getActiveSkillEntries(): SkillPromptEntry[];
  writeReviewLog(event: string, details: Record<string, unknown>): void;
  emitDecision(event: PermissionDecisionEvent): void;
  canConfirm(): boolean;
  promptPermission(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision>;
  createRequestId(prefix: string): string;
}
```

Key design choices:

- **`canConfirm()` takes no args** — the adapter captures `ctx` via closure.
- **`promptPermission(details)` takes no `ctx`** — same reason.
- **`emitDecision(event)` takes the full event** — gates already build the event data; no reason to split it.
- **`getActiveSkillEntries()` is a getter** — skill entries are mutable (set by `handleBeforeAgentStart`), so the gate reads current state via function call.
- **`getInfrastructureDirs()` merges static + config** — hides `piInfrastructureDirs` + `config.piInfrastructureReadPaths` behind one call.

### Adapter construction in handleToolCall

```typescript
export async function handleToolCall(deps: HandlerDeps, event: unknown, ctx: ExtensionContext) {
  deps.session.runtimeContext = ctx;
  deps.startForwardedPermissionPolling(ctx);

  const agentName = deps.resolveAgentName(ctx);
  // ... tool name validation ...

  const tcc: ToolCallContext = { toolName, agentName, input, toolCallId, cwd: ctx.cwd };

  // Shared adapter base — captures ctx in closures
  const canConfirm = () => deps.canRequestPermissionConfirmation(ctx);
  const promptPermission = (details: PromptPermissionDetails) =>
    deps.promptPermission(ctx, details);

  // Gate-specific adapters (cheap — just function references + closures)
  const toolGateDeps: ToolGateDeps = {
    checkPermission: (s, i, a, r) => deps.session.permissionManager.checkPermission(s, i, a, r),
    getSessionRuleset: () => deps.session.sessionRules.getRuleset(),
    approveSessionRule: (s, p) => deps.session.sessionRules.approve(s, p),
    writeReviewLog: deps.writeReviewLog,
    emitDecision: (e) => emitDecisionEvent(deps.events, e),
    canConfirm,
    promptPermission,
  };

  // ... call gates with narrow deps ...
}
```

### SessionState for lifecycle handlers

```typescript
/** Mutable session state — the only part of ExtensionRuntime that handlers mutate. */
export interface SessionState {
  runtimeContext: ExtensionContext | null;
  permissionManager: PermissionManager;
  readonly sessionRules: SessionRules;
  activeSkillEntries: SkillPromptEntry[];
  lastKnownActiveAgentName: string | null;
  lastActiveToolsCacheKey: string | null;
  lastPromptStateCacheKey: string | null;
}
```

### Slimmed HandlerDeps

```typescript
export interface HandlerDeps {
  // ── Session state (replaces `runtime`) ───────────────────────────────
  readonly session: SessionState;

  // ── Immutable paths ──────────────────────────────────────────────────
  readonly piInfrastructureDirs: string[];
  /** Returns config-derived infrastructure read paths (current at call time). */
  getPiInfrastructureReadPaths(): string[];

  // ── Logging (promoted from runtime) ──────────────────────────────────
  writeDebugLog(event: string, details?: Record<string, unknown>): void;
  writeReviewLog(event: string, details?: Record<string, unknown>): void;

  // ── Event bus ────────────────────────────────────────────────────────
  readonly events: PermissionEventBus;

  // ── Factories & helpers ──────────────────────────────────────────────
  createPermissionManagerForCwd(cwd: string | undefined | null): PermissionManager;
  refreshExtensionConfig(ctx?: ExtensionContext): void;
  notifyWarning(message: string): void;
  logResolvedConfigPaths(): void;
  resolveAgentName(ctx: ExtensionContext, systemPrompt?: string): string | null;
  canRequestPermissionConfirmation(ctx: ExtensionContext): boolean;
  promptPermission(
    ctx: ExtensionContext,
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision>;
  createPermissionRequestId(prefix: string): string;
  startForwardedPermissionPolling(ctx: ExtensionContext): void;
  stopForwardedPermissionPolling(): void;
  stopPermissionRpcHandlers(): void;
  getAllTools(): unknown[];
  setActiveTools(names: string[]): void;
}
```

### What test code looks like after

**Gate test (evaluateToolGate):**

```typescript
function makeToolGateDeps(overrides: Partial<ToolGateDeps> = {}): ToolGateDeps {
  return {
    checkPermission: vi.fn().mockReturnValue({ state: "allow", source: "tool" }),
    getSessionRuleset: vi.fn().mockReturnValue([]),
    approveSessionRule: vi.fn(),
    writeReviewLog: vi.fn(),
    emitDecision: vi.fn(),
    canConfirm: vi.fn().mockReturnValue(true),
    promptPermission: vi.fn().mockResolvedValue({ approved: true, state: "approved" }),
    ...overrides,
  };
}

it("blocks when policy is deny", async () => {
  const deps = makeToolGateDeps({
    checkPermission: vi.fn().mockReturnValue({ state: "deny", source: "tool" }),
  });
  const result = await evaluateToolGate(tcc, deps);
  expect(result).toMatchObject({ action: "block" });
});
```

No `makeRuntime()`.
No nesting.
No `as unknown as`.
One override for the field that matters.

**Lifecycle test (handleSessionStart):**

```typescript
function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    runtimeContext: null,
    permissionManager: { getConfigIssues: vi.fn().mockReturnValue([]) } as any,
    sessionRules: { approve: vi.fn(), getRuleset: vi.fn().mockReturnValue([]), clear: vi.fn() } as any,
    activeSkillEntries: [],
    lastKnownActiveAgentName: null,
    lastActiveToolsCacheKey: null,
    lastPromptStateCacheKey: null,
    ...overrides,
  };
}
```

7 fields instead of 18.
No forwarding state, no path constants, no config warning.

## Module-Level Changes

| File                                                   | Change                                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `src/handlers/gates/types.ts`                          | Add `ToolGateDeps`, `ExternalDirectoryGateDeps`, `BashExternalDirectoryGateDeps`, `SkillReadGateDeps` |
| `src/handlers/gates/tool.ts`                           | Accept `ToolGateDeps`; replace `deps.runtime.*` with flat method calls; drop `HandlerDeps` import     |
| `src/handlers/gates/external-directory.ts`             | Accept `ExternalDirectoryGateDeps`; use `deps.getInfrastructureDirs()`                                |
| `src/handlers/gates/bash-external-directory.ts`        | Accept `BashExternalDirectoryGateDeps`                                                                |
| `src/handlers/gates/skill-read.ts`                     | Accept `SkillReadGateDeps`; use `deps.getActiveSkillEntries()`                                        |
| `src/handlers/types.ts`                                | Replace `runtime: ExtensionRuntime` with `session: SessionState`; promote logging/paths               |
| `src/handlers/tool-call.ts`                            | Build per-gate adapter objects from `deps` + `ctx`; pass narrow deps to each gate                     |
| `src/handlers/before-agent-start.ts`                   | Use `deps.session.*` instead of `deps.runtime.*`                                                      |
| `src/handlers/lifecycle.ts`                            | Use `deps.session.*` + `deps.writeDebugLog`                                                           |
| `src/handlers/input.ts`                                | Use `deps.session.*` + `deps.writeReviewLog`                                                          |
| `src/runtime.ts`                                       | Export `SessionState` interface; `ExtensionRuntime` extends it                                        |
| `src/index.ts`                                         | Wire `HandlerDeps.session` from runtime; promote logging + paths                                      |
| `tests/handlers/gates/tool.test.ts`                    | New file — gate tests with `makeToolGateDeps()`                                                       |
| `tests/handlers/gates/external-directory.test.ts`      | New file                                                                                              |
| `tests/handlers/gates/bash-external-directory.test.ts` | New file                                                                                              |
| `tests/handlers/gates/skill-read.test.ts`              | New file                                                                                              |
| `tests/handlers/tool-call.test.ts`                     | Simplify — remove `makeRuntime()`, use `makeSession()`                                                |
| `tests/handlers/tool-call-events.test.ts`              | Same simplification                                                                                   |
| `tests/handlers/before-agent-start.test.ts`            | Replace `makeRuntime()` with `makeSession()`                                                          |
| `tests/handlers/lifecycle.test.ts`                     | Same                                                                                                  |
| `tests/handlers/input.test.ts`                         | Same                                                                                                  |
| `tests/handlers/input-events.test.ts`                  | Same                                                                                                  |
| `docs/architecture/target-architecture.md`             | Update handler/gate architecture section                                                              |

## Test Impact Analysis

1. **New unit tests enabled**: Each gate can now be tested in complete isolation in its own file with a 7-field flat mock.
   Previously impractical due to `makeRuntime()` cost.
2. **Existing handler tests become simpler**: `makeRuntime()` (18 fields) → `makeSession()` (7 fields).
   Deep `as unknown as ExtensionRuntime["permissionManager"]` casts disappear.
   Gate-specific tests in existing handler files can be migrated to dedicated gate test files or simplified in place.
3. **Integration tests stay as-is**: `tests/permission-system.test.ts` exercises the full extension through Pi SDK mocks — never constructs `HandlerDeps` directly — validates the wiring is correct.

## TDD Order

### Phase 1: Per-gate interfaces + gate migration (the #114 work)

1. Define `ToolGateDeps` in `src/handlers/gates/types.ts`.
   Write `tests/handlers/gates/tool.test.ts` using the flat interface (red — gates don't accept it yet).
   - `test: add tool gate tests with narrow ToolGateDeps (#111)`

2. Change `evaluateToolGate` signature to accept `ToolGateDeps`.
   Replace all `deps.runtime.*` references with flat method calls.
   Gate tests go green.
   Existing `handleToolCall` tests still pass because `handleToolCall` adapts deps before calling the gate.
   - `refactor: evaluateToolGate accepts narrow ToolGateDeps (#111)`

3. Same for `evaluateExternalDirectoryGate` — define `ExternalDirectoryGateDeps`, write tests, migrate.
   - `test: add external-directory gate tests with narrow deps (#111)`
   - `refactor: evaluateExternalDirectoryGate accepts ExternalDirectoryGateDeps (#111)`

4. Same for `evaluateBashExternalDirectoryGate`.
   - `test: add bash-external-directory gate tests with narrow deps (#111)`
   - `refactor: evaluateBashExternalDirectoryGate accepts narrow deps (#111)`

5. Same for `evaluateSkillReadGate`.
   - `test: add skill-read gate tests with narrow deps (#111)`
   - `refactor: evaluateSkillReadGate accepts SkillReadGateDeps (#111)`

6. Update `handleToolCall` to build per-gate adapter objects.
   During this step it still reads from `deps.runtime` to construct the adapters.
   - `refactor: handleToolCall builds per-gate adapters (#111)`

### Phase 2: SessionState + slim HandlerDeps (the #111 decomposition)

1. Define `SessionState` in `src/runtime.ts`.
   Make `ExtensionRuntime` extend it.
   - `refactor: define SessionState interface (#111)`

2. Replace `runtime: ExtensionRuntime` with `session: SessionState` on `HandlerDeps`.
   Promote `writeDebugLog`, `writeReviewLog`, `piInfrastructureDirs`, `getPiInfrastructureReadPaths` to top-level.
   Update `src/index.ts` wiring.
   - `refactor: HandlerDeps uses SessionState, promotes logging (#111)`

3. Migrate `handleToolCall` adapter construction to use `deps.session.*` + `deps.writeReviewLog`.
   - `refactor: handleToolCall adapters use deps.session (#111)`

4. Migrate `handleBeforeAgentStart` to `deps.session.*`.
   - `refactor: handleBeforeAgentStart uses deps.session (#111)`

5. Migrate lifecycle handlers to `deps.session.*` + `deps.writeDebugLog`.
   - `refactor: lifecycle handlers use deps.session (#111)`

6. Migrate `handleInput` to `deps.session.*` + `deps.writeReviewLog`.
   - `refactor: handleInput uses deps.session (#111)`

### Phase 3: Test cleanup

1. Replace `makeRuntime()` with `makeSession()` across all handler test files.
   Remove `ExtensionRuntime` imports.
   - `test: handler tests use makeSession instead of makeRuntime (#111)`

2. Migrate gate-level assertions from handler test files to dedicated gate test files where they test more clearly in isolation.
   - `test: consolidate gate tests in dedicated files (#111)`

### Phase 4: Docs

1. Update `docs/architecture/target-architecture.md` to reflect per-gate interfaces and SessionState.
   - `docs: update target architecture for gate interfaces (#111)`

## Risks and Mitigations

| Risk                                                                               | Mitigation                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Could this silently weaken a permission?                                           | No — pure refactor. Same `checkPermission` calls, same parameters, same gate evaluation order. Integration test validates end-to-end.                                                                              |
| Adapter construction in `handleToolCall` adds overhead                             | Adapter objects are cheap (function references + one closure for `ctx`). No allocation pressure vs. current path.                                                                                                  |
| Gate interface drift — someone adds a dep to a gate without updating the interface | TypeScript enforces it: if the gate calls `deps.newMethod()` and the interface lacks it, compilation fails.                                                                                                        |
| Large blast radius across 6 test files                                             | Phase 1 (gates) lands independently and creates new test files without touching existing ones. Phase 2+3 migrates existing tests incrementally.                                                                    |
| Shared method signatures across gate interfaces feel DRY-violating                 | Intentional: each gate's interface documents exactly what it uses. A shared base type would re-introduce coupling and baggy mocks. Composition via `extends` can be applied later if a real shared subset emerges. |

## Open Questions

- Should gate interfaces use `Pick<PermissionManager, "checkPermission">` or a standalone function type?
  Standalone function type (as shown) — it's flatter and test-friendlier.
  The gate never needs to know `PermissionManager` exists.
- Should `handleInput`'s permission logic be extracted into a `SkillInputGateDeps`-style gate for consistency?
  Likely yes, but deferred to a follow-up to keep scope contained.
- Can gate interfaces share a common base (e.g. `BaseGateDeps` with `writeReviewLog` + `canConfirm` + `promptPermission`)?
  Possible, but risks re-introducing the "bag" problem for tests that use the base.
  Defer until repetition is clearly painful.
