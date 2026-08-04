---
issue: 107
issue_title: "refactor: break handleToolCall into per-gate functions"
---

# Extract per-gate functions from handleToolCall

## Problem Statement

`src/handlers/tool-call.ts` is a ~600-line file whose `handleToolCall` function orchestrates four sequential permission gates inline:

1. **Skill-read gate** — checks whether a `read` targets a skill file.
2. **External-directory gate** — checks whether a file tool targets a path outside CWD (including a Pi infrastructure read bypass).
3. **Bash external-directory gate** — extracts paths from bash commands and checks them against external-directory policy.
4. **Normal tool permission gate** — the standard tool/bash/mcp/skill check.

Each gate follows the same structural pattern (check permission → build message → call `applyPermissionGate()` → emit decision event → handle session approval), but the wiring is inlined and repeated, making the function hard to read and test in isolation.

## Goals

- Extract each gate into its own pure-ish function with a narrow input type.
- Reduce `handleToolCall` to a ~30-line orchestrator that chains gates and short-circuits on block.
- Factor repeated emit-decision / record-session-rule patterns into shared helpers.
- Preserve all existing behavior — this is a strict refactor, not a behavior change.
- Keep all existing tests green throughout.

## Non-Goals

- Adding new gates (e.g., network-access) — that is a follow-up.
- Changing `HandlerDeps` or `ExtensionRuntime` interfaces.
- Changing `PermissionGateParams` or `applyPermissionGate`.
- Modifying permission prompts, decision events, or session-rule logic.

## Background

### Permission surfaces involved

All surfaces are touched indirectly: the tool gate handles `tools / bash / mcp / skill`, the external-directory gate handles `external_directory`, and the skill-read gate handles `skill` (specifically skill-file reads).

### Key modules

| File                               | Role                                                        |
| ---------------------------------- | ----------------------------------------------------------- |
| `src/handlers/tool-call.ts`        | The monolith being decomposed                               |
| `src/handlers/types.ts`            | `HandlerDeps` and `PromptPermissionDetails` types           |
| `src/permission-gate.ts`           | `applyPermissionGate()` — the generic deny/ask/allow gate   |
| `src/permission-events.ts`         | `emitDecisionEvent()` — the broadcast event emitter         |
| `src/session-rules.ts`             | `deriveApprovalPattern()` — session-rule recording          |
| `src/external-directory.ts`        | Path-bearing-tool helpers, Pi infrastructure read detection |
| `src/skill-prompt-sanitizer.ts`    | `findSkillPathMatch()` — skill-file matching                |
| `tests/handlers/tool-call.test.ts` | 812-line test file exercising the full handler              |

### Current structure

`handleToolCall` runs gates sequentially.
Each gate can short-circuit with `{ block: true, reason }`.
If no gate blocks, the function returns `{}` (allow).
The helper functions `deriveDecisionValue`, `deriveResolution`, and `getEventInput` are already at module scope.

## Design Overview

### Gate result type

All gates return a common result type:

```typescript
/** Outcome of a single permission gate evaluation. */
export type GateOutcome =
  | { action: "allow" }
  | { action: "block"; reason: string };
```

This is simpler than `PermissionGateResult` because session-approval recording is handled internally by each gate before returning.

### Gate context

Each gate receives a narrow context object assembled by the orchestrator, rather than the full `HandlerDeps` bag.
However, since these are internal helpers (not public API) and they all need overlapping subsets of `HandlerDeps`, the pragmatic approach is to pass `HandlerDeps`, the event, and the `ExtensionContext` — the same signature as `handleToolCall` — plus any gate-specific pre-computed values (e.g., `toolName`, `agentName`, `input`).

A shared context struct avoids repeating the pre-validation logic:

```typescript
/** Pre-validated context shared across all gates. */
interface ToolCallContext {
  toolName: string;
  agentName: string | null;
  input: unknown;
  toolCallId: string;
  cwd: string | undefined;
}
```

### File layout

New files under `src/handlers/gates/`:

| File                         | Exports                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `types.ts`                   | `GateOutcome`, `ToolCallContext`                                                   |
| `skill-read.ts`              | `evaluateSkillReadGate(ctx, tcc, deps) → Promise<GateOutcome \| null>`             |
| `external-directory.ts`      | `evaluateExternalDirectoryGate(ctx, tcc, deps) → Promise<GateOutcome \| null>`     |
| `bash-external-directory.ts` | `evaluateBashExternalDirectoryGate(ctx, tcc, deps) → Promise<GateOutcome \| null>` |
| `tool.ts`                    | `evaluateToolGate(ctx, tcc, deps) → Promise<GateOutcome>`                          |
| `index.ts`                   | Re-exports                                                                         |

Gates that may not apply (skill-read, external-directory, bash-external-directory) return `null` when they are not relevant (e.g., tool is not `read`, path is not outside CWD), signaling "no opinion — continue to next gate."

### Orchestrator

`handleToolCall` becomes:

```typescript
export async function handleToolCall(deps, event, ctx) {
  deps.runtime.runtimeContext = ctx;
  deps.startForwardedPermissionPolling(ctx);

  const agentName = deps.resolveAgentName(ctx);
  const toolName = getToolNameFromValue(event);
  // ... early validation (missing tool, unregistered) ...

  const tcc: ToolCallContext = { toolName, agentName, input, toolCallId, cwd: ctx.cwd };

  const skillResult = await evaluateSkillReadGate(ctx, tcc, deps);
  if (skillResult?.action === "block") return { block: true, reason: skillResult.reason };

  const extDirResult = await evaluateExternalDirectoryGate(ctx, tcc, deps);
  if (extDirResult?.action === "block") return { block: true, reason: extDirResult.reason };

  const bashExtResult = await evaluateBashExternalDirectoryGate(ctx, tcc, deps);
  if (bashExtResult?.action === "block") return { block: true, reason: bashExtResult.reason };

  const toolResult = await evaluateToolGate(ctx, tcc, deps);
  if (toolResult.action === "block") return { block: true, reason: toolResult.reason };

  return {};
}
```

### Shared helpers

`deriveDecisionValue` and `deriveResolution` stay in `tool-call.ts` (or move to `gates/helpers.ts`) since multiple gates use them.

## Module-Level Changes

### New files

- `src/handlers/gates/types.ts` — `GateOutcome`, `ToolCallContext` types.
- `src/handlers/gates/helpers.ts` — `deriveDecisionValue`, `deriveResolution` (currently private in `tool-call.ts`).
- `src/handlers/gates/skill-read.ts` — skill-read gate logic extracted from lines ~130–185 of `tool-call.ts`.
- `src/handlers/gates/external-directory.ts` — external-directory gate logic extracted from lines ~190–310, including Pi infrastructure read bypass and session-rule check.
- `src/handlers/gates/bash-external-directory.ts` — bash external-directory gate extracted from lines ~315–405.
- `src/handlers/gates/tool.ts` — normal tool gate extracted from lines ~410–530.
- `src/handlers/gates/index.ts` — barrel re-exports.

### Changed files

- `src/handlers/tool-call.ts` — replace inline gate logic with calls to extracted functions; move `deriveDecisionValue`, `deriveResolution` to `gates/helpers.ts` or keep in place and export.
- `tests/handlers/tool-call.test.ts` — no changes expected (the public API `handleToolCall` is unchanged; existing tests exercise the full pipeline through the same entry point).

### New test files

- `tests/handlers/gates/helpers.test.ts` — unit tests for `deriveDecisionValue` and `deriveResolution`.
- `tests/handlers/gates/skill-read.test.ts` — unit tests for the skill-read gate in isolation.
- `tests/handlers/gates/external-directory.test.ts` — unit tests for external-directory gate.
- `tests/handlers/gates/bash-external-directory.test.ts` — unit tests for bash external-directory gate.
- `tests/handlers/gates/tool.test.ts` — unit tests for the normal tool gate.

### Documentation

- `docs/architecture/target-architecture.md` — update if it references `tool-call.ts` structure.

## TDD Order

### Step 1: Introduce gate types

1. Create `src/handlers/gates/types.ts` with `GateOutcome` and `ToolCallContext`.
2. Create `src/handlers/gates/index.ts` barrel.
3. Verify build passes.

Commit: `refactor: add gate types for tool-call decomposition (#107)`

### Step 2: Extract helpers (red → green)

`deriveDecisionValue` and `deriveResolution` are currently private module-scope functions.
Extracting them to `src/handlers/gates/helpers.ts` makes them directly unit-testable.

1. Write `tests/handlers/gates/helpers.test.ts` testing:
   - `deriveDecisionValue`: returns command for bash, target for mcp, toolName otherwise.
   - `deriveResolution`: returns `policy_allow` for allow state, `policy_deny` for deny state.
   - `deriveResolution`: returns `user_approved` for ask+allow without session.
   - `deriveResolution`: returns `user_approved_for_session` for ask+allow with session.
   - `deriveResolution`: returns `auto_approved` for ask+allow with autoApproved flag.
   - `deriveResolution`: returns `user_denied` for ask+block with canConfirm.
   - `deriveResolution`: returns `confirmation_unavailable` for ask+block without canConfirm.
2. Move `deriveDecisionValue` and `deriveResolution` to `src/handlers/gates/helpers.ts`.
3. Tests go green.

Commit: `refactor: extract gate helper functions (#107)`

### Step 3: Extract skill-read gate (red → green)

The existing integration tests only cover deny and non-skill-path passthrough.
The extracted gate's direct interface enables testing paths that are hard to reach through the full pipeline.

1. Write `tests/handlers/gates/skill-read.test.ts` testing:
   - Returns `null` when tool is not `read`.
   - Returns `null` when no active skill entries.
   - Returns `null` when read path doesn't match any skill.
   - Returns `{ action: "allow" }` when skill state is `allow`.
   - Returns `{ action: "block", reason }` when skill state is `deny`.
   - Returns `{ action: "allow" }` when state is `ask` and user approves.
   - Returns `{ action: "block", reason }` when state is `ask` and user denies.
   - Returns `{ action: "block" }` when state is `ask` and no UI available (confirmation-unavailable).
   - Emits decision event with correct surface (`skill`), resolution, origin, and matchedPattern fields.
2. Implement `src/handlers/gates/skill-read.ts`.
3. Tests go green.

Commit: `refactor: extract evaluateSkillReadGate (#107)`

### Step 4: Extract external-directory gate (red → green)

The existing integration tests miss: confirmation-unavailable, user-denies-ask, and decision event field assertions (resolution, origin, matchedPattern) for each sub-path (infra bypass, session hit, policy gate).

1. Write `tests/handlers/gates/external-directory.test.ts` testing:
   - Returns `null` when no CWD.
   - Returns `null` when tool is not path-bearing.
   - Returns `null` when path is inside CWD.
   - Pi infrastructure read bypass — returns `{ action: "allow" }`, emits event with resolution `infrastructure_auto_allowed`, and writes review log.
   - Pi infrastructure read bypass respects `config.piInfrastructureReadPaths`.
   - Does NOT bypass for write tools targeting infra dirs.
   - Session-rule hit — returns `{ action: "allow" }`, emits event with resolution `session_approved` and correct `matchedPattern`.
   - Policy deny — returns `{ action: "block" }`, emits event with resolution `policy_deny`.
   - Policy ask, user approves once — returns `{ action: "allow" }`, does NOT record session rule.
   - Policy ask, user approves for session — records session rule via `deriveApprovalPattern` and returns `{ action: "allow" }`.
   - Policy ask, user denies — returns `{ action: "block" }`, emits event with resolution `user_denied`.
   - Policy ask, no UI available — returns `{ action: "block" }`, emits event with resolution `confirmation_unavailable`.
2. Implement `src/handlers/gates/external-directory.ts`.
3. Tests go green.

Commit: `refactor: extract evaluateExternalDirectoryGate (#107)`

### Step 5: Extract bash external-directory gate (red → green)

The existing integration tests miss: ask+user approves, ask+user denies, confirmation-unavailable, and multiple-uncovered-paths recording multiple session rules.

1. Write `tests/handlers/gates/bash-external-directory.test.ts` testing:
   - Returns `null` when tool is not `bash`.
   - Returns `null` when no CWD.
   - Returns `null` when command has no external paths.
   - Returns `null` when all external paths are session-covered (logs `session_approved`).
   - Uncovered paths, policy deny — returns `{ action: "block" }`.
   - Uncovered paths, policy ask, user approves once — returns `{ action: "allow" }`, does NOT record session rules.
   - Uncovered paths, policy ask, user approves for session — records one session rule per uncovered path.
   - Uncovered paths, policy ask, user denies — returns `{ action: "block" }`.
   - Uncovered paths, policy ask, no UI available — returns `{ action: "block" }`.
   - Mixed covered/uncovered — only uncovered paths appear in the prompt.
2. Implement `src/handlers/gates/bash-external-directory.ts`.
3. Tests go green.

Commit: `refactor: extract evaluateBashExternalDirectoryGate (#107)`

### Step 6: Extract normal tool gate (red → green)

The existing integration tests cover allow/deny/ask+approve/ask+deny and session recording well.
The extracted gate additionally exposes: decision event field assertions per resolution, `deriveDecisionValue` producing the correct value for bash (command) and mcp (target), auto-approved resolution, and the bash-specific vs generic unavailable message.

1. Write `tests/handlers/gates/tool.test.ts` testing:
   - Session-rule hit — returns `{ action: "allow" }`, emits event with resolution `session_approved` and correct `matchedPattern`.
   - Policy allow — returns `{ action: "allow" }`, emits event with resolution `policy_allow`.
   - Policy deny — returns `{ action: "block" }`, emits event with resolution `policy_deny`.
   - Policy ask, user approves once — returns `{ action: "allow" }`, emits `user_approved`, does NOT record session rule.
   - Policy ask, user approves for session — records session rule via `suggestSessionPattern`, emits `user_approved_for_session`.
   - Policy ask, user denies — returns `{ action: "block" }`, emits `user_denied`.
   - Policy ask, no UI available — returns `{ action: "block" }`, emits `confirmation_unavailable`.
   - Auto-approved decision emits resolution `auto_approved`.
   - Bash tool: `deriveDecisionValue` produces the command string; unavailable message includes the command.
   - MCP tool: `deriveDecisionValue` produces the target string.
2. Implement `src/handlers/gates/tool.ts`.
3. Tests go green.

Commit: `refactor: extract evaluateToolGate (#107)`

### Step 7: Wire orchestrator and verify existing tests

1. Replace inline gate logic in `handleToolCall` with calls to the four extracted gate functions.
2. Update imports (helpers already moved in step 2).
3. Run full test suite — all 812 lines of `tests/handlers/tool-call.test.ts` must pass unchanged.
4. Run `pnpm run build` to confirm types.

Commit: `refactor: wire handleToolCall to per-gate functions (#107)`

### Step 8: Remove redundant integration tests

After steps 3–6 provide comprehensive per-gate unit tests, 18 integration tests in `tests/handlers/tool-call.test.ts` become redundant — they exercise gate-internal logic through the full pipeline with no additional fidelity over the direct gate tests.
The orchestrator is now a ~30-line linear chain; one wiring-smoke-test per gate (kept below) is sufficient.

Tests to **remove** (gate-internal logic fully covered by per-gate tests):

From `describe("handleToolCall")`:

- "blocks when tool ask has no UI available" → `tool.test.ts`
- "allows when user approves the ask prompt" → `tool.test.ts`
- "blocks when user denies the ask prompt" → `tool.test.ts`

From `describe("handleToolCall — external-directory gate")`:

- "allows when session has an existing approval for the external path" → `external-directory.test.ts`
- "approves session when user selects approved_for_session" → `external-directory.test.ts`

From `describe("handleToolCall — Pi infrastructure read bypass")` (entire block):

- "skips external-directory gate for read tool targeting an infra dir" → `external-directory.test.ts`
- "does NOT skip gate for write tool targeting an infra dir" → `external-directory.test.ts`
- "does NOT skip gate for read tool targeting a non-infra external path" → `external-directory.test.ts`
- "writes a review log entry when bypassing the gate" → `external-directory.test.ts`
- "respects config piInfrastructureReadPaths for bypass" → `external-directory.test.ts`

From `describe("handleToolCall — bash external-directory gate")`:

- "skips bash external gate when all referenced paths are session-approved" → `bash-external-directory.test.ts`

From `describe("handleToolCall — session-hit detection (normal gate)")` (entire block):

- "skips gate and logs session_approved when bash check returns source=session" → `tool.test.ts`
- "skips gate and logs session_approved when mcp check returns source=session" → `tool.test.ts`
- "does NOT call sessionRules.approve when source is session" → `tool.test.ts`

From `describe("handleToolCall — session recording on approved_for_session")` (entire block):

- "records bash session approval with suggestBashPattern result" → `tool.test.ts`
- "records mcp session approval with suggestMcpPattern result" → `tool.test.ts`
- "records tool session approval with * pattern for read surface" → `tool.test.ts`
- "does NOT call sessionRules.approve when user approves once" → `tool.test.ts`

Tests to **keep** (orchestrator wiring, setup, pre-gate validation):

- `getEventInput` (4 tests) — utility function stays in `tool-call.ts`
- "sets runtime context" — orchestrator setup
- "starts forwarded permission polling" — orchestrator setup
- "blocks when tool name cannot be resolved" — pre-gate validation
- "blocks when tool is not registered" — pre-gate validation
- "returns empty object when tool is allowed" — end-to-end happy-path smoke
- "blocks when tool is denied by policy" — wiring: tool gate block propagates
- "blocks a read of a denied skill path" — wiring: skill-read gate block propagates
- "allows a read of a non-skill path…" — wiring: skill-read null → falls through
- "blocks a read of a path outside cwd when policy is deny" — wiring: ext-dir gate block propagates
- "blocks a bash command referencing an external path…" — wiring: bash-ext-dir gate block propagates

Commit: `test: remove redundant integration tests covered by per-gate units (#107)`

### Step 9: Update architecture docs

1. Update `docs/architecture/target-architecture.md` if it references `tool-call.ts`.

Commit: `docs: update architecture for gate extraction (#107)`

## Risks and Mitigations

| Risk                                                     | Mitigation                                                                                                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Behavioral regression during extraction                  | All existing integration tests in `tool-call.test.ts` run after each step; the orchestrator's public contract is unchanged.                                    |
| Could this silently weaken a permission?                 | No — the refactor moves code without changing logic. Gate ordering is preserved. Short-circuit semantics are preserved. No new `"allow"` paths are introduced. |
| Gate functions may need `HandlerDeps` fields that change | Gates use the same `HandlerDeps` interface; no interface changes are planned.                                                                                  |
| Over-decomposition makes the call chain harder to follow | Each gate file is self-contained; the orchestrator is a linear chain. The overall structure is easier to follow than the monolith.                             |
| Test mocking complexity increases                        | Gate unit tests construct narrow mocks for their specific gate; existing integration tests continue exercising the full pipeline.                              |

## Open Questions

- Whether `deriveDecisionValue` and `deriveResolution` should live in `gates/helpers.ts` or stay in `tool-call.ts` and be imported by gates.
  Defer until implementation — the answer depends on which feels cleaner once the code is written.
- Whether gate functions should take a narrower subset of `HandlerDeps` or the full bag.
  The plan uses the full `HandlerDeps` for pragmatism; narrowing can be a follow-up if it improves testability.
