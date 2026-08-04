---
issue: 118
issue_title: "refactor: extract gate runner so gates become pure descriptor functions"
---

# Extract gate runner so gates become pure descriptor functions

## Problem Statement

After #111, each gate function accepts a narrow per-gate dep interface (e.g. `ToolGateDeps` with 7 leaf methods).
This is better than the old 18-field `ExtensionRuntime`, but 5 of the 7 methods (`checkPermission`, `getSessionRuleset`, `approveSessionRule`, `writeReviewLog`, `canConfirm`) appear in every gate and are used in the same mechanical sequence:

1. Call `checkPermission` with session rules.
2. If session hit → log it, emit event, return allow.
3. If deny → build message, log it, return block.
4. If ask → check `canConfirm`, call `promptPermission`, handle result.
5. If session-approved → call `approveSessionRule`.
6. Emit decision event.

Steps 2–6 are identical across all four gates.
Each gate duplicates the same wiring with only the *what-to-check* and *message formatting* varying.

The dep surface is still too large: a gate that only needs to say "check `bash` with this input and format the deny message like this" should not know that `writeReviewLog` exists.

## Goals

- Gate functions become pure (or nearly pure) — they receive a `ToolCallContext`, return a `GateDescriptor | null`, require zero deps, and are testable with simple assertions.
- A single `runGateCheck()` function (the "runner") takes the descriptor plus infrastructure deps and executes the full check→log→emit→approve cycle.
- The runner is tested once; gates are tested with trivial input→output assertions.
- Per-gate dep interfaces (`ToolGateDeps`, `ExternalDirectoryGateDeps`, etc.) are removed.
- Subsumes #112 (centralize decision-event emission) — the runner is the single emission site.
- No behavioral change — same permission decisions, same events, same log entries.

## Non-Goals

- Extracting `handleInput`'s skill-input gate into the same descriptor model — follow-up.
- Changing `applyPermissionGate` — it stays as-is inside the runner.
- Adding new gates (e.g. network-access gate).
- Changing config format, schema, or the `/permission-system` slash command.

## Background

### Prerequisite issues

| Issue | Status               | Relationship                                                |
| ----- | -------------------- | ----------------------------------------------------------- |
| #107  | Closed (implemented) | Extracted gate functions into `src/handlers/gates/`         |
| #111  | Closed (implemented) | Narrowed handler deps; introduced per-gate interfaces       |
| #112  | Closed (subsumed)    | Centralize decision-event emission — achieved by the runner |

### Permission surfaces involved

All surfaces flow through the gates being refactored: `tools`, `bash`, `mcp`, `skill` (via tool gate and skill-read gate), `external_directory` (via external-directory and bash-external-directory gates).

### Key modules

| File                                            | Role                                                      |
| ----------------------------------------------- | --------------------------------------------------------- |
| `src/handlers/gates/types.ts`                   | `GateOutcome`, `ToolCallContext`, per-gate dep interfaces |
| `src/handlers/gates/tool.ts`                    | Normal tool permission gate (~130 lines)                  |
| `src/handlers/gates/external-directory.ts`      | External-directory gate (~130 lines)                      |
| `src/handlers/gates/bash-external-directory.ts` | Bash external-directory gate (~100 lines)                 |
| `src/handlers/gates/skill-read.ts`              | Skill-read gate (~80 lines)                               |
| `src/handlers/gates/helpers.ts`                 | `deriveDecisionValue`, `deriveResolution`                 |
| `src/handlers/gates/index.ts`                   | Barrel re-exports                                         |
| `src/handlers/tool-call.ts`                     | Orchestrator that builds per-gate adapter objects         |
| `src/permission-gate.ts`                        | `applyPermissionGate()` — the generic deny/ask/allow gate |
| `src/permission-events.ts`                      | `emitDecisionEvent()`, `PermissionDecisionEvent`          |

### Current gate structure (example: tool.ts)

Each gate currently:

1. Calls `deps.checkPermission(...)` — needs `checkPermission`, `getSessionRuleset`.
2. Handles the session-hit fast path — needs `writeReviewLog`, `emitDecision`.
3. Builds messages using formatting functions.
4. Calls `applyPermissionGate()` — needs `canConfirm`, `promptPermission`, `writeReviewLog`.
5. Emits a decision event — needs `emitDecision`.
6. Records session approval — needs `approveSessionRule`.

The gate knows about all 7 dep methods, yet only the message building and `checkPermission` input vary.

## Design Overview

### GateDescriptor type

The descriptor captures everything the runner needs to execute a gate check:

```typescript
/** Pure output of a gate function — describes what to check and how to present it. */
interface GateDescriptor {
  /** Permission surface to check (e.g. "bash", "external_directory", "skill"). */
  surface: string;
  /** Input passed to checkPermission. */
  input: unknown;
  /** Message strings/factories for each outcome. */
  messages: {
    denyReason: string;
    unavailableReason: string;
    userDeniedReason: (decision: PermissionPromptDecision) => string;
  };
  /** Session-approval suggestion for "for this session" option. */
  sessionApproval?: { surface: string; pattern: string };
  /** Details passed to the interactive permission prompt. */
  promptDetails: Omit<PromptPermissionDetails, "requestId">;
  /** Extra context fields written to the review log alongside gate outcomes. */
  logContext: Record<string, unknown>;
  /** Surface and value for the decision event (may differ from the check surface). */
  decision: {
    surface: string;
    value: string;
  };
}
```

### Gate-specific variations

Some gates have behavior that does not fit the single-descriptor model cleanly:

#### Skill-read gate

The skill-read gate's `checkPermission` call is replaced by `findSkillPathMatch()` — it resolves the permission state from the matched skill entry, not from the permission manager.
The descriptor needs to carry the pre-resolved `state` so the runner can skip the `checkPermission` call:

```typescript
interface GateDescriptor {
  // ... common fields ...
  /**
   * When set, the gate has already resolved the permission state
   * (e.g. from a skill entry match). The runner uses this directly
   * instead of calling checkPermission.
   */
  preResolved?: {
    state: PermissionState;
  };
}
```

#### External-directory gate — infrastructure bypass

The external-directory gate has a Pi infrastructure read bypass that short-circuits before the normal permission check.
This is modeled as a separate early return from the gate function — it returns a `GateBypass` instead of a `GateDescriptor`:

```typescript
/** Early allow result — gate has determined the action without needing the runner. */
interface GateBypass {
  action: "allow";
  /** Optional review log entry and decision event to emit. */
  log?: { event: string; details: Record<string, unknown> };
  decision?: PermissionDecisionEvent;
}

type GateResult = GateDescriptor | GateBypass | null;
```

The orchestrator checks: if the result is a `GateBypass`, it logs/emits and continues.
If it is a `GateDescriptor`, it passes it to the runner.
If `null`, the gate does not apply.

#### Bash external-directory gate — multiple paths

The bash external-directory gate extracts multiple paths, filters already-covered ones, and prompts once for all uncovered paths.
It also records one session rule per uncovered path (not one total).

This is modeled by allowing the descriptor's `sessionApproval` to carry multiple patterns:

```typescript
interface GateDescriptor {
  // ... common fields ...
  sessionApproval?: {
    surface: string;
    pattern: string;
  } | {
    surface: string;
    patterns: string[];
  };
}
```

The bash-external-directory gate function needs `checkPermission` and `getSessionRuleset` to filter covered paths — but these calls happen during descriptor construction (they are reads, not side effects).
The gate function signature becomes:

```typescript
function describeBashExternalDirectoryGate(
  tcc: ToolCallContext,
  checkPermission: CheckPermissionFn,
  getSessionRuleset: () => Rule[],
): Promise<GateResult>
```

This is still nearly pure — it takes two read-only functions and returns a descriptor.
Critically, it does NOT need `writeReviewLog`, `emitDecision`, `canConfirm`, `promptPermission`, or `approveSessionRule`.

### GateRunnerDeps

The runner handles all side effects.
Its deps are the infrastructure functions shared by all gates:

```typescript
interface GateRunnerDeps {
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
```

This is essentially the union of the existing per-gate dep interfaces, minus gate-specific methods like `getInfrastructureDirs` and `getActiveSkillEntries`.
It is constructed once in `handleToolCall` and reused for all gates.

### runGateCheck function

```typescript
async function runGateCheck(
  descriptor: GateDescriptor,
  agentName: string | null,
  toolCallId: string,
  deps: GateRunnerDeps,
): Promise<GateOutcome> {
  // 1. Resolve permission state
  const check = descriptor.preResolved
    ? { state: descriptor.preResolved.state, /* synthetic fields */ }
    : deps.checkPermission(
        descriptor.surface,
        descriptor.input,
        agentName ?? undefined,
        deps.getSessionRuleset(),
      );

  // 2. Session-hit fast path
  if (check.source === "session") {
    deps.writeReviewLog("permission_request.session_approved", { ... });
    deps.emitDecision({ ...descriptor.decision, resolution: "session_approved", ... });
    return { action: "allow" };
  }

  // 3. Apply gate (deny/ask/allow)
  const gate = await applyPermissionGate({
    state: check.state,
    canConfirm: deps.canConfirm(),
    sessionApproval: /* first pattern from descriptor.sessionApproval */,
    promptForApproval: () => deps.promptPermission({
      requestId: toolCallId,
      ...descriptor.promptDetails,
    }),
    writeLog: deps.writeReviewLog,
    logContext: descriptor.logContext,
    messages: descriptor.messages,
  });

  // 4. Emit decision event
  deps.emitDecision({
    ...descriptor.decision,
    result: gate.action === "allow" ? "allow" : "deny",
    resolution: deriveResolution(check.state, gate.action, hasSession, canConfirm, autoApproved),
    origin: check.origin ?? null,
    agentName,
    matchedPattern: check.matchedPattern ?? null,
  });

  // 5. Record session approval(s)
  if (gate.action === "allow" && gate.sessionApproval) {
    // Handle single or multiple patterns
    deps.approveSessionRule(gate.sessionApproval.surface, gate.sessionApproval.pattern);
  }

  if (gate.action === "block") {
    return { action: "block", reason: gate.reason };
  }
  return { action: "allow" };
}
```

### Updated orchestrator

```typescript
async function handleToolCall(deps, event, ctx) {
  // ... pre-validation (unchanged) ...

  const tcc: ToolCallContext = { toolName, agentName, input, toolCallId, cwd: ctx.cwd };

  // Build runner deps once
  const runnerDeps: GateRunnerDeps = {
    checkPermission: (s, i, a, r) => deps.session.permissionManager.checkPermission(s, i, a, r),
    getSessionRuleset: () => deps.session.sessionRules.getRuleset(),
    approveSessionRule: (s, p) => deps.session.sessionRules.approve(s, p),
    writeReviewLog: deps.writeReviewLog,
    emitDecision: (e) => emitDecisionEvent(deps.events, e),
    canConfirm: () => deps.canRequestPermissionConfirmation(ctx),
    promptPermission: (details) => deps.promptPermission(ctx, details),
  };

  // Skill-read gate
  const skillDesc = describeSkillReadGate(tcc, () => deps.session.activeSkillEntries);
  if (skillDesc) {
    if ("action" in skillDesc) { /* bypass */ }
    else {
      const result = await runGateCheck(skillDesc, agentName, toolCallId, runnerDeps);
      if (result.action === "block") return { block: true, reason: result.reason };
    }
  }

  // External-directory gate
  const extDirDesc = describeExternalDirectoryGate(tcc, infraDirs);
  // ... same pattern ...

  // Bash external-directory gate
  const bashExtDesc = await describeBashExternalDirectoryGate(tcc, runnerDeps.checkPermission, runnerDeps.getSessionRuleset);
  // ... same pattern ...

  // Tool gate
  const toolDesc = describeToolGate(tcc);
  const toolResult = await runGateCheck(toolDesc, agentName, toolCallId, runnerDeps);
  // ...
}
```

### What gate tests look like after

```typescript
describe("describeToolGate", () => {
  it("returns descriptor with bash surface and command in decision value", () => {
    const tcc = makeTcc({ toolName: "bash", input: { command: "git status" } });
    const desc = describeToolGate(tcc);
    expect(desc.surface).toBe("bash");
    expect(desc.decision.value).toBe("git status");
    expect(desc.messages.denyReason).toContain("git status");
  });

  it("returns descriptor with mcp surface when tool is mcp", () => {
    const tcc = makeTcc({ toolName: "mcp", input: { tool: "server:tool" } });
    const desc = describeToolGate(tcc);
    expect(desc.surface).toBe("mcp");
  });
});
```

No mocks.
No async.
No deps.
Pure input → output.

## Module-Level Changes

### New files

| File                                  | Contents                                                             |
| ------------------------------------- | -------------------------------------------------------------------- |
| `src/handlers/gates/descriptor.ts`    | `GateDescriptor`, `GateBypass`, `GateResult`, `GateRunnerDeps` types |
| `src/handlers/gates/runner.ts`        | `runGateCheck()` function                                            |
| `tests/handlers/gates/runner.test.ts` | Tests for `runGateCheck()`                                           |

### Changed files

| File                                                   | Change                                                                                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/handlers/gates/types.ts`                          | Remove `ToolGateDeps`, `ExternalDirectoryGateDeps`, `BashExternalDirectoryGateDeps`, `SkillReadGateDeps`. Keep `GateOutcome` and `ToolCallContext`.              |
| `src/handlers/gates/tool.ts`                           | Rename to pure descriptor factory `describeToolGate(tcc): GateDescriptor`. Remove deps parameter, `applyPermissionGate` call, event emission, session recording. |
| `src/handlers/gates/external-directory.ts`             | Rename to `describeExternalDirectoryGate(tcc, infraDirs): GateResult`. Remove deps, keep infrastructure bypass as `GateBypass`.                                  |
| `src/handlers/gates/bash-external-directory.ts`        | Rename to `describeBashExternalDirectoryGate(tcc, checkPermission, getSessionRuleset): Promise<GateResult>`. Remove deps except the two read functions.          |
| `src/handlers/gates/skill-read.ts`                     | Rename to `describeSkillReadGate(tcc, getActiveSkillEntries): GateResult`. Return `GateDescriptor` with `preResolved` state from matched skill entry.            |
| `src/handlers/gates/helpers.ts`                        | `deriveDecisionValue`, `deriveResolution` remain (used by runner).                                                                                               |
| `src/handlers/gates/index.ts`                          | Update barrel exports to new function names and types.                                                                                                           |
| `src/handlers/tool-call.ts`                            | Build `GateRunnerDeps` once; call descriptor factories; pass descriptors to `runGateCheck()`; handle `GateBypass` inline.                                        |
| `tests/handlers/gates/tool.test.ts`                    | Rewrite to pure input→output assertions (no mocks).                                                                                                              |
| `tests/handlers/gates/external-directory.test.ts`      | Split: pure descriptor tests + a few integration tests for bypass.                                                                                               |
| `tests/handlers/gates/bash-external-directory.test.ts` | Split: descriptor tests (need `checkPermission`/`getSessionRuleset` stubs only) + runner integration.                                                            |
| `tests/handlers/gates/skill-read.test.ts`              | Rewrite to pure input→output assertions.                                                                                                                         |
| `docs/architecture/target-architecture.md`             | Update gates section to reflect descriptor + runner architecture.                                                                                                |

### Unchanged files

| File                               | Reason                                                  |
| ---------------------------------- | ------------------------------------------------------- |
| `src/permission-gate.ts`           | Used inside `runGateCheck` — no interface change.       |
| `src/permission-events.ts`         | Used by runner — no interface change.                   |
| `src/handlers/input.ts`            | Skill-input gate is out of scope — follow-up.           |
| `tests/handlers/tool-call.test.ts` | Orchestrator integration tests — should pass unchanged. |

## Test Impact Analysis

### New unit tests enabled

1. **Pure gate descriptor tests** — each gate function is now a pure function returning data.
   Tests become simple assertions on the returned descriptor's fields (surface, messages, decision value, sessionApproval patterns).
   Zero mocks needed for `describeToolGate`, `describeSkillReadGate`, and `describeExternalDirectoryGate`.
2. **Runner tests** — `runGateCheck()` is tested once with all resolution paths: session-hit, policy-allow, policy-deny, ask+approve, ask+approve-for-session, ask+deny, ask+no-UI.
   This replaces the duplicated wiring assertions scattered across 4 gate test files.

### Existing tests that become redundant

The existing gate tests in `tests/handlers/gates/{tool,external-directory,bash-external-directory,skill-read}.test.ts` exercise both descriptor construction AND the mechanical check→log→emit→approve cycle.
After the split:

- Assertions on `deps.emitDecision` call shapes → move to `runner.test.ts`.
- Assertions on `deps.writeReviewLog` call shapes → move to `runner.test.ts`.
- Assertions on `deps.approveSessionRule` calls → move to `runner.test.ts`.
- Assertions on `deps.canConfirm` / `deps.promptPermission` interactions → move to `runner.test.ts`.

Each existing gate test file simplifies from ~150 lines with 7-field mock factories to ~50 lines of pure assertions.

### Existing tests that must stay

- `tests/handlers/tool-call.test.ts` — orchestrator integration tests validate wiring between descriptor factories, runner, and `handleToolCall`.
  These exercise the real call chain.
- `tests/handlers/gates/helpers.test.ts` — `deriveDecisionValue` and `deriveResolution` are still used by the runner.
- `tests/permission-system.test.ts` — full extension integration tests.

## TDD Order

### Step 1: Define descriptor types

1. Create `src/handlers/gates/descriptor.ts` with `GateDescriptor`, `GateBypass`, `GateResult`, and `GateRunnerDeps` types.
2. Export from `src/handlers/gates/index.ts`.
3. Run `pnpm run build` to verify types.

Commit: `refactor: add GateDescriptor and GateRunnerDeps types (#118)`

### Step 2: Implement and test runGateCheck (red → green)

1. Write `tests/handlers/gates/runner.test.ts` testing all runner paths:
   - Policy allow → returns `{ action: "allow" }`, emits `policy_allow` decision.
   - Policy deny → returns `{ action: "block" }`, emits `policy_deny` decision, writes review log.
   - Session-hit → returns `{ action: "allow" }`, emits `session_approved`, writes review log.
   - Ask + user approves → returns `{ action: "allow" }`, emits `user_approved`.
   - Ask + user approves for session → returns `{ action: "allow" }`, emits `user_approved_for_session`, calls `approveSessionRule`.
   - Ask + user approves for session with multiple patterns → calls `approveSessionRule` once per pattern.
   - Ask + user denies → returns `{ action: "block" }`, emits `user_denied`.
   - Ask + no UI → returns `{ action: "block" }`, emits `confirmation_unavailable`.
   - Auto-approved → emits `auto_approved`.
   - Pre-resolved state (skill-read) → uses `preResolved.state` instead of calling `checkPermission`.
2. Implement `src/handlers/gates/runner.ts`.
3. Tests go green.
   Run `pnpm run build`.

Commit: `feat: implement runGateCheck gate runner (#118)`

### Step 3: Extract describeToolGate (red → green)

1. Write new pure tests in `tests/handlers/gates/tool.test.ts` for `describeToolGate`:
   - Returns descriptor with tool name as surface for standard tools.
   - Returns `"bash"` surface with command in `decision.value` for bash tools.
   - Returns `"mcp"` surface with target in `decision.value` for MCP tools.
   - Populates `messages.denyReason` via `formatDenyReason`.
   - Populates `sessionApproval` via `suggestSessionPattern`.
   - Populates `promptDetails` with correct fields.
   - Populates `logContext` with tool input preview.
2. Rename `evaluateToolGate` → `describeToolGate`, change return type to `GateDescriptor`.
   Remove deps parameter, `applyPermissionGate` call, event emission, session recording.
   The function now needs only `ToolCallContext` plus a `checkPermission` call to get the `PermissionCheckResult` for message formatting.
   **Design note**: `describeToolGate` needs the `PermissionCheckResult` to build messages (it calls `formatDenyReason(check)`, `formatAskPrompt(check)`, etc.).
   Two options: (a) pass `checkPermission` as a parameter and call it inside the descriptor factory, or (b) call `checkPermission` in the orchestrator and pass the result.
   Option (b) is purer — the factory takes data in, returns data out — so `describeToolGate(tcc, check): GateDescriptor`.
   However, this means the session-hit fast path must also move to the runner (which is the goal anyway).
3. Update `handleToolCall` to call `describeToolGate(tcc, check)` then `runGateCheck(descriptor, ...)`.
4. Existing orchestrator tests (`tests/handlers/tool-call.test.ts`) must still pass.
5. Run `pnpm run build`.

Commit: `refactor: describeToolGate returns pure descriptor (#118)`

### Step 4: Extract describeSkillReadGate (red → green)

1. Write new pure tests for `describeSkillReadGate(tcc, getActiveSkillEntries)`:
   - Returns `null` when tool is not `read`.
   - Returns `null` when no active skill entries.
   - Returns `null` when read path does not match any skill.
   - Returns `GateDescriptor` with `preResolved.state` matching the skill entry's state.
   - Decision surface is `"skill"`, decision value is the skill name.
   - Messages contain the skill name.
2. Rename `evaluateSkillReadGate` → `describeSkillReadGate`.
   Remove deps except `getActiveSkillEntries`.
   Return `GateDescriptor | null`.
3. Update `handleToolCall` to use `describeSkillReadGate` → `runGateCheck`.
4. Existing orchestrator tests pass.
5. Run `pnpm run build`.

Commit: `refactor: describeSkillReadGate returns pure descriptor (#118)`

### Step 5: Extract describeExternalDirectoryGate (red → green)

1. Write new pure tests for `describeExternalDirectoryGate(tcc, infraDirs)`:
   - Returns `null` when no CWD, tool is not path-bearing, or path is inside CWD.
   - Returns `GateBypass` with `action: "allow"` for Pi infrastructure reads, including the decision event and log entry.
   - Returns `GateDescriptor` with `surface: "external_directory"` for external paths.
   - Decision value is the external path.
   - Session approval pattern uses `deriveApprovalPattern`.
2. Rename `evaluateExternalDirectoryGate` → `describeExternalDirectoryGate`.
   Remove all deps; accept `infraDirs: string[]` directly.
   Return `GateResult`.
3. Update `handleToolCall` to handle `GateBypass` (log + emit inline) or pass `GateDescriptor` to `runGateCheck`.
4. Existing orchestrator tests pass.
5. Run `pnpm run build`.

Commit: `refactor: describeExternalDirectoryGate returns pure descriptor (#118)`

### Step 6: Extract describeBashExternalDirectoryGate (red → green)

1. Write tests for `describeBashExternalDirectoryGate(tcc, checkPermission, getSessionRuleset)`:
   - Returns `null` when tool is not bash, no CWD, or no external paths.
   - Returns `null` (with session-approved log context) when all paths are session-covered.
     **Note**: the session-approved log entry for this case is a bypass — handle as `GateBypass`.
   - Returns `GateDescriptor` with multi-pattern `sessionApproval` for uncovered paths.
   - Uses config-level `checkPermission("external_directory", {})` for the policy state.
2. Rename `evaluateBashExternalDirectoryGate` → `describeBashExternalDirectoryGate`.
   Accept only `checkPermission` and `getSessionRuleset` as functional parameters.
   Return `Promise<GateResult>`.
3. Update `handleToolCall`.
4. Existing orchestrator tests pass.
5. Run `pnpm run build`.

Commit: `refactor: describeBashExternalDirectoryGate returns pure descriptor (#118)`

### Step 7: Remove per-gate dep interfaces

1. Remove `ToolGateDeps`, `ExternalDirectoryGateDeps`, `BashExternalDirectoryGateDeps`, `SkillReadGateDeps` from `src/handlers/gates/types.ts`.
2. Update `src/handlers/gates/index.ts` barrel exports.
3. Remove unused imports from `src/handlers/tool-call.ts`.
4. Run full test suite and `pnpm run build`.

Commit: `refactor: remove per-gate dep interfaces (#118)`

### Step 8: Simplify gate test files

1. Remove mock-heavy assertions from gate test files that are now covered by `runner.test.ts`:
   - `emitDecision` call-shape assertions.
   - `writeReviewLog` call-shape assertions.
   - `approveSessionRule` call assertions.
   - `canConfirm` / `promptPermission` interaction assertions.
2. Keep gate-specific tests: null returns, descriptor field values, message formatting, bypass conditions.
3. Run full test suite.

Commit: `test: simplify gate tests after runner extraction (#118)`

### Step 9: Update architecture docs

1. Update `docs/architecture/target-architecture.md`:
   - Add `runner.ts` and `descriptor.ts` to the gates directory listing.
   - Note that gates are pure descriptor factories and the runner handles all side effects.
2. Remove #112 from any open/planned lists if referenced.

Commit: `docs: update target architecture for gate runner (#118)`

## Risks and Mitigations

| Risk                                                                         | Mitigation                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Could this silently weaken a permission?                                     | No — the runner executes the same `applyPermissionGate` with the same parameters. Gate ordering is preserved. The refactor moves logic without changing it. Integration tests in `tool-call.test.ts` and `permission-system.test.ts` validate end-to-end. |
| Descriptor type may not cover all gate variations                            | The plan explicitly models three variations (pre-resolved state for skill-read, bypass for infrastructure reads, multi-pattern session approval for bash). Each is tested.                                                                                |
| `describeToolGate` needs `PermissionCheckResult` for message formatting      | Addressed by passing the check result as a parameter. The orchestrator calls `checkPermission` and passes the result to both the descriptor factory and the runner. The runner re-uses the same check result.                                             |
| Bash external-directory gate needs `checkPermission` to filter covered paths | Addressed by keeping `checkPermission` and `getSessionRuleset` as explicit function parameters (reads, not side effects).                                                                                                                                 |
| Large blast radius across gate test files                                    | Steps 3–6 migrate one gate at a time. Each step leaves the full test suite green. Step 8 simplifies tests only after the runner is proven.                                                                                                                |
| `handleInput`'s inline resolution logic is left inconsistent                 | Explicitly deferred as a non-goal. The `deriveResolution` function in `helpers.ts` already exists for future migration.                                                                                                                                   |

## Open Questions

- Should the `PermissionCheckResult` be passed to `describeToolGate` or should the descriptor factory call `checkPermission` itself?
  The plan proposes passing it for purity, but the alternative (passing `checkPermission` as a function) keeps the factory self-contained.
  Decide during implementation based on which tests read more naturally.
- Should the runner handle the session-hit fast path, or should the orchestrator handle it before calling the runner?
  The plan places it in the runner for centralization, but if the session-hit log context varies per gate (it currently includes gate-specific fields like `path`, `command`), the orchestrator may need to handle it.
  Examine the actual log context variance during step 2 and decide.
- Should `handleInput`'s skill-input gate be migrated to the descriptor model in a follow-up issue?
  Likely yes — the inline `deriveResolution` logic in `input.ts` would benefit from the same centralization.
  File a follow-up after this lands.
