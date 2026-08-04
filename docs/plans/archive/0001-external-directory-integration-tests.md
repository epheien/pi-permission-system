---
issue: 1
issue_title: "Add integration tests for external_directory tool_call enforcement"
---

# External-directory integration tests

## Problem Statement

The `external_directory` enforcement in the `tool_call` handler has no integration test coverage at the handler level.
Existing tests cover the policy-resolution layer (`PermissionManager.checkPermission`) and the pure descriptor function (`describeExternalDirectoryGate`), but never exercise the wiring that decides whether the external-directory check fires, formats deny/ask messages, interacts with the UI, and writes review-log entries.
This gap allowed a critical upstream bug to ship — four undefined symbols referenced at runtime — because the test suite stopped at the manager layer.

The code has since been refactored into a descriptor + runner architecture:

- `src/handlers/gates/external-directory.ts` — pure descriptor (unit-tested)
- `src/handlers/gates/runner.ts` — generic gate runner (unit-tested)
- `src/handlers/permission-gate-handler.ts` — wiring (`handleToolCall`)

The wiring layer — `PermissionGateHandler.handleToolCall` — has only one external-directory test (`tests/handlers/tool-call.test.ts`) and zero review-log assertions.
Integration tests at this level are the durable defense against this class of regression.

## Goals

- Cover the path-scope matrix: inside CWD (skip), outside CWD (fire), non-path-bearing tool (skip), each `PATH_BEARING_TOOLS` member, optional path omitted (skip).
- Cover the policy-state matrix with out-of-cwd paths: `allow`, `deny`, `ask` (user approves / user denies / no UI).
- Assert on both the `{ block, reason }` return value and `session.logger.review` (review-log) side effects.
- Assert on `permissions:decision` event emissions for each code path.
- Verify that removing any of the four `external_directory` helpers causes test failures (regression guard).
- Per-agent override of `external_directory` is honored over the global policy.

## Non-Goals

- Full end-to-end tests wiring `piPermissionSystemExtension(stubApi)` — the handler-level test is the right seam given the current architecture.
- Testing bash external-directory enforcement — that is a separate gate with its own descriptor (`describeBashExternalDirectoryGate`) and is out of scope for this issue.
- Testing `PermissionManager.checkPermission("external_directory", ...)` — already covered in `tests/permission-system.test.ts`.
- Refactoring any production code.

## Background

### Permission surface

`external_directory` — gates tool calls whose `input.path` resolves outside the working directory (`ctx.cwd`).

### Path-bearing tools

The set `PATH_BEARING_TOOLS` in `src/path-utils.ts` contains: `read`, `write`, `edit`, `find`, `grep`, `ls`.
Of these, `find`, `grep`, and `ls` have optional `path` — when omitted, the external-directory gate is skipped.

### Handler architecture

`PermissionGateHandler.handleToolCall` (in `src/handlers/permission-gate-handler.ts`):

1. Activates the session, resolves agent name.
2. Validates tool name and registration.
3. Runs the skill-read gate (descriptor → runner).
4. Runs the external-directory gate (descriptor → runner), handling both `GateBypass` (infra reads) and `GateDescriptor` (permission check) results.
5. Runs the bash external-directory gate (descriptor → runner).
6. Runs the normal tool permission gate (descriptor → runner).

### Existing test coverage

| File                                                      | What it tests                                 | Gap                                                            |
| --------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| `tests/permission-system.test.ts`                         | `checkPermission("external_directory", ...)`  | Policy only; no handler wiring                                 |
| `tests/handlers/gates/external-directory.test.ts`         | `describeExternalDirectoryGate` pure function | Descriptor only; no runner/handler                             |
| `tests/handlers/gates/runner.test.ts`                     | `runGateCheck` generic runner                 | Generic; not specific to external_directory                    |
| `tests/handlers/tool-call.test.ts`                        | `handleToolCall` wiring                       | 1 external_directory test (deny only)                          |
| `tests/handlers/tool-call-events.test.ts`                 | Decision event emissions                      | 1 infra auto-allowed test; no external_directory policy matrix |
| `tests/handlers/external-directory-session-dedup.test.ts` | Session-approval deduplication                | Stateful session mocks; complementary                          |

### Test seam

Tests mock `PermissionSession` (the session boundary) while exercising real descriptor + runner code.
This is the established pattern in `tests/handlers/tool-call.test.ts` and `tests/handlers/tool-call-events.test.ts`.

## Design Overview

Create a single new test file `tests/handlers/external-directory-integration.test.ts` that exercises `PermissionGateHandler.handleToolCall` with the external-directory gate.

### Test harness

Reuse the mock-session pattern from `tests/handlers/tool-call.test.ts`:

- `makeSession()` — stub `PermissionSession` with controllable `checkPermission`, `canPrompt`, `prompt`, `getInfrastructureDirs`, `getInfrastructureReadPaths`.
- `makeCtx()` — stub `ExtensionContext` with `cwd`, `hasUI`, `ui`.
- `makeEvents()` — stub event bus capturing `emit` calls.
- `makeToolRegistry()` — stub tool list including all `PATH_BEARING_TOOLS` members.

Configure `checkPermission` to return different states depending on the surface argument:

- When called with `"external_directory"` → return the desired test state.
- When called with the tool name → return `"allow"` (so the tool gate does not interfere).

### Test groups

#### 1. Path scope (gate applicability)

Test that `handleToolCall` correctly skips or fires the external-directory gate based on the tool and path:

- Tool with `input.path` inside `ctx.cwd` → no block (external-directory check skipped, falls through to tool gate).
- Tool with `input.path` outside `ctx.cwd` → external-directory check fires (policy decides outcome).
- Non-path-bearing tool (`bash`) with a path-shaped input → external-directory check skipped.
- Each `PATH_BEARING_TOOLS` member (`read`, `write`, `edit`, `find`, `grep`, `ls`) gates correctly with an out-of-cwd path.
- Tools with optional path (`find`, `grep`, `ls`) where `path` is omitted → external-directory check skipped.

#### 2. Policy state matrix (out-of-cwd path)

For a `read` tool with an external path:

- `external_directory: allow` → no block, no block-type review-log entry, decision event with `resolution: "policy_allow"` on the `external_directory` surface.
- `external_directory: deny` → `{ block: true, reason }` where `reason` contains the external path and the hard-stop hint; review-log entry with `resolution: "policy_denied"`; decision event with `resolution: "policy_deny"`.
- `external_directory: ask`, user approves → no block; decision event with `resolution: "user_approved"`.
- `external_directory: ask`, user denies → block with user-denied reason; decision event with `resolution: "user_denied"`.
- `external_directory: ask`, user denies with `denialReason` → block reason includes the denial reason.
- `external_directory: ask`, no UI → block with `confirmation_unavailable` reason; review-log entry with `resolution: "confirmation_unavailable"`; decision event.

#### 3. Per-agent override

Configure `checkPermission` to vary its return based on the `agentName` argument — when the agent name is passed, return `allow`; otherwise return `deny`.
Assert that the agent-specific override is honored.

#### 4. Regression guard (helper presence)

Import the four helpers directly and assert they are callable functions:

- `formatExternalDirectoryDenyReason`
- `formatExternalDirectoryAskPrompt`
- `formatExternalDirectoryUserDeniedReason`
- `formatExternalDirectoryHardStopHint`

If any are removed, the import fails and the entire test file errors.

### Mock configuration for surface-aware checkPermission

```typescript
function makeCheckPermission(
  externalDirectoryState: PermissionState,
  toolState: PermissionState = "allow",
) {
  return vi.fn().mockImplementation(
    (surface: string): PermissionCheckResult => {
      const state = surface === "external_directory"
        ? externalDirectoryState
        : toolState;
      return { state, toolName: surface, source: "tool", origin: "builtin" };
    },
  );
}
```

This separates the external-directory policy from the per-tool policy so tests can verify gate ordering.

## Module-Level Changes

### New files

- `tests/handlers/external-directory-integration.test.ts` — all new integration tests described above.

### Unchanged files (verification only)

- `src/handlers/gates/external-directory.ts` — no changes; tests exercise it indirectly via `handleToolCall`.
- `src/handlers/gates/external-directory-messages.ts` — no changes; regression guard imports its exports.
- `src/handlers/gates/runner.ts` — no changes; exercised indirectly.
- `src/handlers/permission-gate-handler.ts` — no changes; the SUT.
- `src/path-utils.ts` — no changes; `PATH_BEARING_TOOLS` used in test assertions.

### No architecture doc changes

No architecture docs describe the external-directory gate flow in isolation.
The living architecture doc (`docs/architecture/architecture.md`) does not need updating for test-only changes.

## Test Impact Analysis

1. **New unit tests enabled**: The new file covers handler-level integration that was previously impractical because the handler was a 1800-line monolith.
   The refactored descriptor + runner architecture makes it possible to test gate wiring without mocking internal functions.
2. **Existing tests that become redundant**: None.
   The single test in `tests/handlers/tool-call.test.ts` ("blocks a read of a path outside cwd when policy is deny") is a subset of the new matrix, but it exercises the same layer and is cheap to keep.
3. **Existing tests that must stay**: All existing tests in `tests/handlers/gates/external-directory.test.ts` (descriptor unit tests), `tests/handlers/gates/runner.test.ts` (runner unit tests), `tests/permission-system.test.ts` (policy resolution), and `tests/handlers/external-directory-session-dedup.test.ts` (session dedup) remain valid — they test different layers.

## TDD Order

### Cycle 1 — Regression guard: helper imports

Write tests that import the four `external-directory-messages` helpers and assert they are functions.
These fail if any helper is removed.

- **Test surface**: `tests/handlers/external-directory-integration.test.ts`
- **Covers**: Regression guard — presence of `formatExternalDirectoryDenyReason`, `formatExternalDirectoryAskPrompt`, `formatExternalDirectoryUserDeniedReason`, `formatExternalDirectoryHardStopHint`.
- **Commit**: `test: add regression guard for external_directory helper imports (#1)`

### Cycle 2 — Path scope: gate applicability

Add tests verifying the external-directory gate is skipped or fired based on tool name and path:

- Path inside CWD → not blocked.
- Path outside CWD → blocked when policy is `deny`.
- Non-path-bearing tool (`bash`) → not blocked.
- Each `PATH_BEARING_TOOLS` member → blocked when policy is `deny` and path is external.
- Optional-path tools without `path` → not blocked.
- **Test surface**: `tests/handlers/external-directory-integration.test.ts`
- **Covers**: Path scope — gate applicability matrix.
- **Commit**: `test: add external_directory path-scope integration tests (#1)`

### Cycle 3 — Policy state matrix: allow and deny

Add tests for `external_directory` policy states `allow` and `deny` with out-of-cwd paths:

- `allow` → falls through to tool gate, no block.
- `deny` → blocks with deny reason containing the path, review-log entry, decision event.
- **Test surface**: `tests/handlers/external-directory-integration.test.ts`
- **Covers**: Policy state — `allow` and `deny` paths.
- **Commit**: `test: add external_directory allow/deny policy state tests (#1)`

### Cycle 4 — Policy state matrix: ask (user approves, user denies, no UI)

Add tests for `external_directory: ask` with out-of-cwd paths:

- User approves → no block, decision event with `user_approved`.
- User denies → block with user-denied reason, decision event.
- User denies with `denialReason` → block reason includes the denial reason.
- No UI available → block with `confirmation_unavailable`, review-log entry, decision event.
- **Test surface**: `tests/handlers/external-directory-integration.test.ts`
- **Covers**: Policy state — `ask` paths (all outcomes).
- **Commit**: `test: add external_directory ask-state integration tests (#1)`

### Cycle 5 — Per-agent override and decision events

Add tests verifying:

- Per-agent override of `external_directory` is honored (agent-specific `checkPermission` return).
- Decision events emitted on the `external_directory` surface with correct `resolution` for each code path (consolidate any missing event assertions).
- **Test surface**: `tests/handlers/external-directory-integration.test.ts`
- **Covers**: Per-agent override; decision event emissions.
- **Commit**: `test: add external_directory per-agent override and decision event tests (#1)`

## Risks and Mitigations

| Risk                                                                                  | Mitigation                                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Could this silently weaken a permission?                                              | No. This is a test-only change; no production code is modified.                                                                                                               |
| Tests pass even when helpers are broken                                               | Cycle 1 imports helpers directly — removing them fails the import. Cycles 3–4 assert on message content (deny reason text contains the path), so broken formatting is caught. |
| Mock session diverges from real `PermissionSession`                                   | Use the same mock pattern as existing `tool-call.test.ts` and `tool-call-events.test.ts`. If `PermissionSession` changes, all three files break together.                     |
| `checkPermission` mock returns same state for all surfaces, hiding gate ordering bugs | The `makeCheckPermission` helper returns different states per surface, so the external-directory gate and tool gate are independently controllable.                           |
| New test file adds maintenance burden                                                 | The file is focused on one gate; the mock factory is reusable. The test matrix matches the issue's acceptance criteria 1:1.                                                   |

## Open Questions

- None.
  The issue is specific about what to test, and the current architecture provides a clean test seam at `handleToolCall`.
