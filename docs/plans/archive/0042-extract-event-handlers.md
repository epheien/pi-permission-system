---
issue: 42
issue_title: "Extract event handlers from piPermissionSystemExtension into separate modules"
---

# Extract event handlers into separate modules

## Problem Statement

After #21 (module extraction), #41 (permission-gate abstraction), and #55 (pure `evaluate()`), `src/index.ts` is still ~1066 lines.
The `piPermissionSystemExtension` factory contains 6 inline event-handler closures (~740 lines) that each represent a distinct concern.
The `tool_call` handler alone is ~250 lines.
This makes the file hard to navigate, review, and test in isolation.

The target architecture identifies this extraction as the first step in the structural cleanup phase, blocking #43 (eliminate module-scope state).

## Goals

- Create `src/handlers/` with dedicated modules for each handler group.
- Define a `HandlerDeps` interface that replaces closure-captured state with an explicit dependency bag.
- Reduce `src/index.ts` to a thin wiring layer (≤200 lines target).
- Add unit tests for each handler module using mocked deps.
- No change to permission semantics — pure structural refactor.

## Non-Goals

- Changing permission resolution logic, merge precedence, or default policy.
- Restructuring module-scope state (`PI_AGENT_DIR`, `extensionLogger`, etc.) — deferred to #43 (`ExtensionRuntime`).
- Refactoring `promptPermission`, `writeReviewLog`, or other helper internals.
- Extracting the config-save/load helpers or the slash-command registration (they are not event handlers).
- Unifying the Rule type or normalizing config into flat `Ruleset` at load time — deferred to #56 per the refactoring sequence.

## Background

The six handlers currently live as anonymous closures inside `piPermissionSystemExtension()`:

| Handler              | Approx lines | Concern                                                   |
| -------------------- | ------------ | --------------------------------------------------------- |
| `session_start`      | ~20          | Init runtime state, start forwarding, log config          |
| `resources_discover` | ~12          | Re-create permission manager on reload                    |
| `session_shutdown`   | ~8           | Teardown                                                  |
| `before_agent_start` | ~80          | Tool filtering + prompt sanitization                      |
| `input`              | ~50          | Skill input permission gate                               |
| `tool_call`          | ~250         | Skill-read, external-directory, and tool permission gates |

All handlers share closure state: `permissionManager`, `extensionConfig`, `runtimeContext`, `activeSkillEntries`, `sessionApprovalCache`, `lastKnownActiveAgentName`, and several inner helper functions (`resolveAgentName`, `shouldExposeTool`, `promptPermission`, `canRequestPermissionConfirmation`, `reviewPermissionDecision`, `createPermissionRequestId`, etc.).

Key dependencies already extracted:

- `applyPermissionGate` from `src/permission-gate.ts` (#41) — used by `input` and `tool_call` handlers.
- `evaluate()`, `Rule`, `Ruleset` from `src/rule.ts` (#55) — used internally by `checkPermission()`; handlers still go through `PermissionManager`.
- `sanitizeAvailableToolsSection` from `src/system-prompt-sanitizer.ts` — used by `before_agent_start`.
- `resolveSkillPromptEntries` / `findSkillPathMatch` from `src/skill-prompt-sanitizer.ts`.

Permission surfaces involved: tools, bash, mcp, skills, external_directory (all gate through these handlers).

See architecture docs § "Monolithic index.ts" and § "Module map" for the full as-is picture.

## Design Overview

### Handler deps interface

A single context object replaces individual closure captures.
Each handler function receives deps + the event + the Pi extension context:

```typescript
export interface HandlerDeps {
  // Mutable shared state (wrapped for testability)
  getPermissionManager: () => PermissionManager;
  setPermissionManager: (pm: PermissionManager) => void;
  getExtensionConfig: () => PermissionSystemExtensionConfig;
  getRuntimeContext: () => ExtensionContext | null;
  setRuntimeContext: (ctx: ExtensionContext | null) => void;
  getActiveSkillEntries: () => SkillPromptEntry[];
  setActiveSkillEntries: (entries: SkillPromptEntry[]) => void;
  sessionApprovalCache: SessionApprovalCache;

  // Derived helpers (closures over shared state)
  refreshExtensionConfig: (ctx?: ExtensionContext) => void;
  invalidateAgentStartCache: () => void;
  resolveAgentName: (ctx: ExtensionContext, systemPrompt?: string) => string | null;
  shouldExposeTool: (toolName: string, agentName: string | null) => boolean;
  canRequestPermissionConfirmation: (ctx: ExtensionContext) => boolean;
  promptPermission: (ctx: ExtensionContext, details: PromptPermissionDetails) => Promise<PermissionPromptDecision>;
  createPermissionRequestId: (prefix: string) => string;
  notifyWarning: (message: string) => void;
  logResolvedConfigPaths: () => void;

  // Forwarding
  startForwardedPermissionPolling: (ctx: ExtensionContext) => void;
  stopForwardedPermissionPolling: () => void;

  // Logging
  writeReviewLog: (event: string, details: Record<string, unknown>) => void;
  writeDebugLog: (event: string, details: Record<string, unknown>) => void;

  // Pi API subset
  getAllTools: () => unknown[];
  setActiveTools: (names: string[]) => void;
}
```

The exact shape may slim down during implementation — some helpers (e.g., `shouldExposeTool`) could stay in the handler module if they only need `getPermissionManager`.
The key constraint is: **every test can construct a `HandlerDeps` with stubs and exercise a handler without importing `src/index.ts`**.

### Alignment with ExtensionRuntime (#43)

The target architecture defines an `ExtensionRuntime` context object that replaces all module-scope mutable state.
`HandlerDeps` is designed as a stepping stone: #43 will fold the getter/setter pairs and mutable fields into `ExtensionRuntime` and pass that to handlers instead.
To keep that transition smooth:

- Handler function signatures use a single `deps` parameter (not positional state args) — swapping the type is a one-line change per handler.
- Helpers that only read state (e.g., `shouldExposeTool`, `canRequestPermissionConfirmation`) should be pure functions of their inputs where possible, taking the needed value as a parameter rather than closing over the deps bag.
  This aligns with the target architecture's principle: *"pure evaluation, IO at the edges."*

### File layout

```text
src/handlers/
  types.ts               # HandlerDeps interface + PromptPermissionDetails
  lifecycle.ts           # session_start, resources_discover, session_shutdown
  before-agent-start.ts  # tool filtering + prompt sanitization
  input.ts               # skill input gate
  tool-call.ts           # skill-read, external-directory, tool permission gates
  index.ts               # barrel re-export
```

Each handler file exports a named function matching the event:

```typescript
// src/handlers/lifecycle.ts
export async function handleSessionStart(
  deps: HandlerDeps,
  event: SessionStartEvent,
  ctx: ExtensionContext,
): Promise<void> { ... }
```

### Wiring in src/index.ts

After extraction, `piPermissionSystemExtension` becomes:

```typescript
export default function piPermissionSystemExtension(pi: ExtensionAPI): void {
  // ~40 lines: create shared state, build deps object
  const deps: HandlerDeps = { ... };

  // ~10 lines: setup (config, command registration, forwarding logger)
  refreshExtensionConfig();
  registerPermissionSystemCommand(pi, { ... });

  // ~20 lines: register handlers
  pi.on("session_start", (event, ctx) => handleSessionStart(deps, event, ctx));
  pi.on("resources_discover", (event, ctx) => handleResourcesDiscover(deps, event, ctx));
  pi.on("session_shutdown", () => handleSessionShutdown(deps));
  pi.on("before_agent_start", (event, ctx) => handleBeforeAgentStart(deps, event, ctx));
  pi.on("input", (event, ctx) => handleInput(deps, event, ctx));
  pi.on("tool_call", (event, ctx) => handleToolCall(deps, event, ctx));
}
```

Target: ≤200 lines for `src/index.ts` (currently ~1066).

### Module-scope state

The issue explicitly defers restructuring module-scope state (`PI_AGENT_DIR`, `extensionLogger`, `setExtensionConfig`, etc.).
These remain in `src/index.ts` and are referenced by the deps object closures.
Issue #43 will lift them into `ExtensionRuntime` (see `src/runtime.ts` in the target module structure).

## Module-Level Changes

### New files

| File                                 | Contents                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `src/handlers/types.ts`              | `HandlerDeps` interface, `PromptPermissionDetails` type                  |
| `src/handlers/lifecycle.ts`          | `handleSessionStart`, `handleResourcesDiscover`, `handleSessionShutdown` |
| `src/handlers/before-agent-start.ts` | `handleBeforeAgentStart`                                                 |
| `src/handlers/input.ts`              | `handleInput`                                                            |
| `src/handlers/tool-call.ts`          | `handleToolCall`                                                         |
| `src/handlers/index.ts`              | Barrel re-export                                                         |

### Modified files

| File           | Change                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` | Remove inline handler bodies; build `HandlerDeps`; register handlers via one-liner calls. Extract `extractSkillNameFromInput`, `getEventToolName`, `getEventInput` to a utility or into the handler that uses them. |

### Test files

| File                                        | Contents                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------ |
| `tests/handlers/lifecycle.test.ts`          | Session start init, reload path, resources_discover reload, shutdown cleanup   |
| `tests/handlers/before-agent-start.test.ts` | Tool filtering, prompt sanitization, cache key logic                           |
| `tests/handlers/input.test.ts`              | Skill input gate: allow, deny, ask paths                                       |
| `tests/handlers/tool-call.test.ts`          | Skill-read gate, external-directory (file + bash), normal tool permission gate |

## TDD Order

Each cycle is red → green → commit.

1. **Define `HandlerDeps` and `PromptPermissionDetails` types**
   - Test: `tsc` compiles with no errors (type-only, no runtime test).
   - Commit: `feat: define HandlerDeps interface for handler extraction (#42)`

2. **Extract lifecycle handlers + tests**
   - Test surface: `tests/handlers/lifecycle.test.ts` — session_start sets runtime context and refreshes config; resources_discover re-creates permission manager on reload; session_shutdown clears state and stops polling.
   - Commit: `feat: extract lifecycle handlers into src/handlers/lifecycle.ts (#42)`

3. **Extract before_agent_start handler + tests**
   - Test surface: `tests/handlers/before-agent-start.test.ts` — tool filtering respects `shouldExposeTool`; prompt sanitization modifies system prompt; cache key prevents redundant work.
   - Commit: `feat: extract before_agent_start handler into src/handlers/before-agent-start.ts (#42)`

4. **Extract input handler + tests**
   - Test surface: `tests/handlers/input.test.ts` — non-skill input passes through; skill input deny/ask/allow gates via `applyPermissionGate`.
   - Commit: `feat: extract input handler into src/handlers/input.ts (#42)`

5. **Extract tool_call handler + tests**
   - Test surface: `tests/handlers/tool-call.test.ts` — missing/unregistered tool blocking; skill-read gate; external-directory gate (file tools); external-directory gate (bash); normal tool permission gate; session-approval cache integration.
   - Commit: `feat: extract tool_call handler into src/handlers/tool-call.ts (#42)`

6. **Wire handlers in src/index.ts and verify integration**
   - Replace inline handler bodies with one-liner registrations.
   - Run full test suite (`npx vitest run`) to confirm no regressions.
   - Commit: `refactor: wire extracted handlers in src/index.ts (#42)`

7. **Move shared helper functions out of index.ts**
   - Move `extractSkillNameFromInput`, `getEventToolName`, `getEventInput` to appropriate handler modules or a shared utility.
   - Run full test suite.
   - Commit: `refactor: relocate handler helper functions from src/index.ts (#42)`

8. **Verify line count target and update docs**
   - Confirm `src/index.ts` is ≤200 lines.
   - Commit: `docs: update plan status for handler extraction (#42)`

## Risks and Mitigations

| Risk                                                           | Mitigation                                                                                                                                                                                               |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Could this silently weaken a permission?                       | No — this is a pure structural refactor. Handler logic moves verbatim. Tests verify identical gate behavior with mocked deps. The full existing test suite (`npx vitest run`) must pass at every commit. |
| Closure state semantics change when accessed via deps          | The deps bag uses getter/setter pairs for mutable state, preserving the same "always read latest" semantics as closures. Tests verify state mutations propagate correctly.                               |
| `HandlerDeps` interface becomes a god object                   | Start minimal — only include what handlers actually consume. If any field is unused, remove it. The interface can be narrowed per-handler via `Pick<HandlerDeps, ...>` if it grows unwieldy.             |
| Event type signatures are not exported by the Pi SDK           | Use `Parameters<...>` inference or define minimal event shapes in `src/handlers/types.ts`. If the SDK changes, type errors surface at compile time.                                                      |
| Existing integration tests break during incremental extraction | Steps 2–5 keep old inline handlers working in parallel until step 6 swaps them out. This avoids a big-bang rewrite.                                                                                      |

## Implementation Notes

- `extractSkillNameFromInput` landed in `src/handlers/input.ts` (exported).
- `getEventInput` landed in `src/handlers/tool-call.ts` (exported).
- `getEventToolName` was eliminated entirely — handlers call `getToolNameFromValue` from `tool-registry.ts` directly.
- `shouldExposeTool` was extracted as a pure exported function in `src/handlers/before-agent-start.ts` rather than a dep entry, consistent with the target architecture principle.
- Event parameter types: the SDK does not export `ResourcesDiscoverEvent`; handler files use lean local payload interfaces (`SessionStartPayload`, `ResourcesDiscoverPayload`, `InputPayload`, `BeforeAgentStartPayload`) instead of full SDK event types, since handlers consume only a subset of fields.
- `src/index.ts` reduced from 1066 → 466 lines (56% reduction).
  The ≤200 line target requires #43 to eliminate module-scope state and extract the remaining factory helpers (`refreshExtensionConfig`, `saveExtensionConfig`, `promptPermission`, `resolveAgentName`, `logResolvedConfigPaths`, etc.) into an `ExtensionRuntime` context object.

## Open Questions

- **Should `HandlerDeps` be split into per-handler narrower interfaces?**
  Defer until the single interface proves unwieldy — YAGNI for now.
