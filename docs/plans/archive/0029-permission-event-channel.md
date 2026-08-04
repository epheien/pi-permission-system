---
issue: 29
issue_title: "Re-add permission-request event channel with a proper public contract"
---

# Permission event channel with decision broadcast and RPC

## Problem Statement

Issue #20 deleted the undocumented `pi-permission-system:permission-request` event channel because it had no subscribers, no documentation, no tests, and no public type contract.
The concept is useful — three major subagent extensions (nicobailon/pi-subagents, tintinweb/pi-subagents, HazAT/pi-interactive-subagents) need to interact with the permission system at runtime, and `pi.events` is the only cross-extension communication channel Pi provides.
This plan re-introduces the channel with a proper public contract: exported types, documentation, payload-shape tests, protocol versioning, and three distinct surfaces.

## Goals

1. Emit `permissions:decision` events for every permission gate resolution so external consumers can observe decisions.
2. Expose a `permissions:rpc:check` request/reply RPC so other extensions can query the permission policy without importing this package.
3. Expose a `permissions:rpc:prompt` request/reply RPC so in-process child sessions (tintinweb) can forward permission prompts to the parent session's UI.
4. Emit `permissions:ready` on extension load so consumers can detect the extension's presence without polling.
5. Export TypeScript types from a dedicated `src/permission-events.ts` module for compile-time type safety.
6. Add payload-shape regression tests for every emitted event and RPC reply.
7. Document channel names, payload fields, protocol version, stability guarantees, and worked examples in `README.md`.

## Non-Goals

- Building a general-purpose cross-extension RPC framework — scoped to permission events only.
- Replacing the file-based permission forwarding for CLI-spawned subagents (#96) — the event bus RPC is specifically for in-process subagents.
- Proposing changes to Pi's extension API (badlogic/pi-mono#4207 tracks `registerService()`/`getService()`).
- Adopting the event API in subagent extensions (#98) — this plan builds the prerequisite API.
- Adding authentication or caller validation to RPC handlers — `pi.events` is shared within a single Node.js process; any loaded extension can emit.

## Background

### Dependency status

| Issue | Description                                  | Status                      |
| ----- | -------------------------------------------- | --------------------------- |
| #20   | Deleted the original undocumented channel    | ✅ Closed                   |
| #96   | Env var broadening for CLI-spawned subagents | ✅ Closed                   |
| #97   | Coexistence documentation                    | ✅ Closed                   |
| #98   | Adoption by subagent maintainers             | Open — depends on this plan |

All hard prerequisites are resolved.
This plan unblocks #98.

### Pi SDK event bus

The `ExtensionAPI` provides `events: EventBus` with an untyped interface:

```typescript
interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}
```

This is the only cross-extension communication mechanism Pi provides. tintinweb/pi-subagents already built a working RPC over this bus with protocol versioning, request/reply envelopes, and scoped reply channels — a proven pattern in the ecosystem.

### Affected permission surfaces

This change touches the **event emission layer** — it does not change any allow/deny/ask decision logic.
All six permission surfaces (tools, bash, mcp, skills, special, external_directory) emit decision broadcasts.
The RPC check endpoint covers all surfaces.
The RPC prompt endpoint handles the `ask` state for any surface.

### Existing forwarding model

File-based forwarding (`src/forwarded-permissions/`) handles CLI-spawned subagents (different processes, different event buses).
The event bus RPC handles in-process subagents (same process, shared event bus) where file-based forwarding cannot work because no child process exists.
Both paths coexist — they serve different transport needs.

## Design Overview

### Channel taxonomy

| Channel                                    | Direction | Purpose                                                   |
| ------------------------------------------ | --------- | --------------------------------------------------------- |
| `permissions:ready`                        | Broadcast | Emitted once on extension load; consumers detect presence |
| `permissions:decision`                     | Broadcast | Emitted after every permission gate resolution            |
| `permissions:rpc:check`                    | Request   | Query the permission policy (no prompting)                |
| `permissions:rpc:check:reply:<requestId>`  | Reply     | Response to a check request                               |
| `permissions:rpc:prompt`                   | Request   | Forward a permission prompt to the parent's UI            |
| `permissions:rpc:prompt:reply:<requestId>` | Reply     | Response to a prompt request                              |

### Envelope shapes

Following tintinweb's convention: success envelope `{ success: true, data?: T }`, error envelope `{ success: false, error: string }`.
All RPC requests include `requestId: string` for reply channel scoping.
All RPC replies include `protocolVersion: number` for forward compatibility.

```typescript
/** RPC protocol version — bumped on breaking envelope or method changes. */
export const PERMISSIONS_PROTOCOL_VERSION = 1;

/** RPC reply envelope. */
export type PermissionsRpcReply<T = void> =
  | { success: true; protocolVersion: number; data?: T }
  | { success: false; protocolVersion: number; error: string };
```

### Surface 1: Decision broadcast

Emitted after every permission gate outcome in the handler layer — not inside `applyPermissionGate()` itself, because the gate lacks the full context (surface name, command, agent name, origin).

```typescript
export interface PermissionDecisionEvent {
  /** Permission surface: "bash", "read", "mcp", "skill", "external_directory", etc. */
  surface: string;
  /** The value that was evaluated (command, tool name, skill name, path). */
  value: string;
  /** Final decision. */
  result: "allow" | "deny";
  /** How the decision was reached. */
  resolution:
    | "policy_allow"
    | "policy_deny"
    | "session_approved"
    | "infrastructure_auto_allowed"
    | "user_approved"
    | "user_approved_for_session"
    | "user_denied"
    | "auto_approved"
    | "confirmation_unavailable";
  /** Which config scope contributed the winning rule (when available). */
  origin: string | null;
  /** Agent name (when known). */
  agentName: string | null;
  /** Matched pattern from the winning rule (when available). */
  matchedPattern: string | null;
}
```

#### Emission points in handlers

Each handler site calls a shared `emitDecisionEvent(events, payload)` helper after the gate resolves.
The helper is thin — it constructs the channel name and calls `events.emit()`.

| Handler                                       | Gate/check                                    | Resolution mapped                                                   |
| --------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------- |
| `tool-call.ts` — session-hit fast path        | `checkPermission` returns `source: "session"` | `session_approved`                                                  |
| `tool-call.ts` — infrastructure read bypass   | `isPiInfrastructureRead` returns `true`       | `infrastructure_auto_allowed`                                       |
| `tool-call.ts` — skill-read gate              | `applyPermissionGate` result                  | `policy_allow`, `policy_deny`, `user_*`, `confirmation_unavailable` |
| `tool-call.ts` — external-directory gate      | `applyPermissionGate` result                  | Same set                                                            |
| `tool-call.ts` — bash external-directory gate | `applyPermissionGate` result                  | Same set                                                            |
| `tool-call.ts` — normal tool gate             | `applyPermissionGate` result                  | Same set                                                            |
| `input.ts` — skill input gate                 | `applyPermissionGate` result                  | Same set                                                            |

#### Mapping gate outcomes to resolution

The `applyPermissionGate` return type is `{ action: "allow" | "block" }`.
The resolution is derived from the combination of:

- The input `state` ("allow", "deny", "ask")
- Whether the prompt was shown (canConfirm)
- The user's decision (approved, approved_for_session, denied, denied_with_reason)

To capture this without modifying the gate's return type, the handler wraps the gate call with pre/post tracking.
The approach: check the `state` before the gate call, check the `action` after, and reconstruct the resolution:

- `state === "allow"` → `policy_allow`
- `state === "deny"` → `policy_deny`
- `state === "ask"` and `action === "allow"` → `user_approved` or `user_approved_for_session` (distinguished by `sessionApproval` in the gate result)
- `state === "ask"` and `action === "block"` → `user_denied` or `confirmation_unavailable` (distinguished by `canConfirm`)

Auto-approved (yolo mode) is handled inside `PermissionPrompter` before the gate is called.
To capture it, the prompter's `prompt()` method emits the decision event directly for the auto-approve path, or we track the auto-approve outcome via the decision callback.

Better approach: add an optional `onDecision` callback to the `PermissionPrompter` that fires for auto-approved decisions, so the handler can distinguish yolo auto-approve from user approval.

### Surface 2: Policy query RPC

The handler listens on `permissions:rpc:check`, evaluates the policy, and replies on `permissions:rpc:check:reply:<requestId>`.

```typescript
export interface PermissionsCheckRequest {
  requestId: string;
  surface: string;
  /** The value to evaluate: command string, tool name, skill name, or path. */
  value?: string;
  /** Optional agent name for per-agent policy resolution. */
  agentName?: string;
}

export interface PermissionsCheckReplyData {
  result: "allow" | "deny" | "ask";
  matchedPattern: string | null;
  origin: string | null;
}
```

Implementation: call `permissionManager.checkPermission()` with the provided surface and value, including current session rules.
The handler constructs a synthetic input object from `surface` + `value` that matches what `normalizeInput()` expects.

### Surface 3: Prompt forwarding RPC

The handler listens on `permissions:rpc:prompt`, shows a UI dialog, and replies on `permissions:rpc:prompt:reply:<requestId>`.

```typescript
export interface PermissionsPromptRequest {
  requestId: string;
  surface: string;
  /** Value being evaluated (shown in the dialog). */
  value: string;
  /** Optional agent name for display. */
  agentName?: string;
  /** Message to display in the permission dialog. */
  message: string;
  /** Optional label for the "for this session" option. */
  sessionLabel?: string;
}

export interface PermissionsPromptReplyData {
  approved: boolean;
  /** Detailed state: "approved", "approved_for_session", "denied", "denied_with_reason". */
  state: string;
  denialReason?: string;
}
```

#### Guard: only respond when UI is available

The handler checks `runtime.runtimeContext?.hasUI` before attempting the dialog.
If no UI context exists, it replies with `{ success: false, error: "no_ui" }`.
The caller treats error replies or timeouts as denial (graceful degradation).

#### In-process concurrency

Multiple child sessions may request prompts simultaneously.
Since the Pi UI is sequential (one dialog at a time), concurrent RPC prompt requests are serialized by the UI's own dialog queue.
No explicit concurrency control is needed in the handler.

### Ready event

```typescript
export interface PermissionsReadyEvent {
  protocolVersion: number;
}
```

Emitted once in `piPermissionSystemExtension()` after RPC handlers are registered.
Consumers listen for `permissions:ready` to detect the extension's presence and protocol version.

### Versioning policy

All exported types carry the `PERMISSIONS_PROTOCOL_VERSION` constant.
RPC replies include `protocolVersion` in the envelope.
Stability guarantee: fields may be added, but existing fields will not be removed or renamed without a major version bump (semver-major change).

### Integration points

The `pi.events` bus is accessed via the `ExtensionAPI` parameter in `piPermissionSystemExtension()`.
It is passed to:

1. An `emitDecisionEvent()` helper (called from handlers)
2. `registerPermissionRpcHandlers()` (called once during setup)
3. A `permissions:ready` emit (called once during setup)

The `HandlerDeps` interface gains an `events` field (the `EventBus` reference) so handlers can call `emitDecisionEvent()`.

## Module-Level Changes

| File                                       | Action                          | Detail                                                                                                                                             |
| ------------------------------------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/permission-events.ts`                 | **new**                         | Channel name constants, protocol version, all event/request/reply TypeScript types, `emitDecisionEvent()` helper, `emitReadyEvent()` helper        |
| `src/permission-event-rpc.ts`              | **new**                         | `registerPermissionRpcHandlers(events, deps)` — wires `permissions:rpc:check` and `permissions:rpc:prompt` handlers; returns unsubscribe functions |
| `src/index.ts`                             | changed                         | Pass `pi.events` to RPC registration and handler deps; emit `permissions:ready`; store unsubscribe handles for cleanup in `session_shutdown`       |
| `src/handlers/types.ts`                    | changed                         | Add `events: EventBus` (or `emitDecision: (event) => void`) to `HandlerDeps`                                                                       |
| `src/handlers/tool-call.ts`                | changed                         | Call `emitDecisionEvent()` after each gate resolution and session/infrastructure fast path                                                         |
| `src/handlers/input.ts`                    | changed                         | Call `emitDecisionEvent()` after skill input gate resolution                                                                                       |
| `src/handlers/before-agent-start.ts`       | unchanged                       | Tool filtering is a pre-start phase, not an individual decision event (no emission here)                                                           |
| `src/permission-gate.ts`                   | unchanged                       | Gate remains a pure decision function; emission stays at the handler layer                                                                         |
| `src/permission-prompter.ts`               | changed                         | Add optional `onAutoApprove` callback or return metadata so handlers can distinguish yolo auto-approve from user approval for the decision event   |
| `tests/permission-events.test.ts`          | **new**                         | Payload-shape assertions for `PermissionDecisionEvent`, `PermissionsReadyEvent`, all RPC request/reply shapes                                      |
| `tests/permission-event-rpc.test.ts`       | **new**                         | RPC handler tests: check returns correct result, prompt shows dialog and returns decision, error replies for missing UI, unknown surface           |
| `tests/handlers/tool-call-events.test.ts`  | **new** or merged into existing | Verify `permissions:decision` emitted with correct payload for allow, deny, ask→approved, session-approved, infrastructure-bypass paths            |
| `tests/handlers/input-events.test.ts`      | **new** or merged into existing | Verify `permissions:decision` emitted for skill input gate                                                                                         |
| `README.md`                                | changed                         | Add "Event API" section: channel names, payload fields, RPC protocol, stability guarantees, worked examples                                        |
| `docs/architecture/target-architecture.md` | changed                         | Add `src/permission-events.ts` and `src/permission-event-rpc.ts` to module structure; add event bus section to architecture overview               |

## TDD Order

### Step 1: Types, constants, and helper stubs

Define all types and channel constants in `src/permission-events.ts`.
Export the `emitDecisionEvent()` and `emitReadyEvent()` helpers (thin wrappers around `events.emit()`).
Export `PermissionsRpcReply`, `PERMISSIONS_PROTOCOL_VERSION`, all event/request/reply interfaces.

1. **Red**: `tests/permission-events.test.ts` — assert module exports expected constants (`PERMISSIONS_PROTOCOL_VERSION === 1`, channel name strings), assert `emitDecisionEvent` calls `events.emit` with the channel name and payload, assert `emitReadyEvent` emits the correct shape.
2. **Green**: Implement `src/permission-events.ts` with types, constants, and emit helpers.
3. Commit: `feat: add permission event types and emit helpers (#29)`

### Step 2: Ready event

Wire `emitReadyEvent()` in `src/index.ts` after extension setup.

1. **Red**: `tests/permission-events.test.ts` (or integration test) — assert that `permissions:ready` is emitted with `{ protocolVersion: 1 }` when extension loads. (May test via a mock `pi.events` in an integration harness or unit-test the helper directly.)
2. **Green**: Add `emitReadyEvent(pi.events)` call in `piPermissionSystemExtension()`.
3. Commit: `feat: emit permissions:ready on extension load (#29)`

### Step 3: Policy query RPC handler

Implement `registerPermissionRpcHandlers()` in `src/permission-event-rpc.ts` — starting with the `permissions:rpc:check` handler.

1. **Red**: `tests/permission-event-rpc.test.ts` — mock event bus and permission manager; emit a `permissions:rpc:check` request; assert the handler replies on `permissions:rpc:check:reply:<requestId>` with `{ success: true, protocolVersion: 1, data: { result: "allow", ... } }`.
   Test deny, ask, unknown surface, and missing `requestId` cases.
2. **Green**: Implement the check handler in `src/permission-event-rpc.ts`.
   Wire it in `src/index.ts`.
3. Commit: `feat: add permissions:rpc:check policy query RPC (#29)`

### Step 4: Prompt forwarding RPC handler

Add the `permissions:rpc:prompt` handler to `registerPermissionRpcHandlers()`.

1. **Red**: `tests/permission-event-rpc.test.ts` — emit a `permissions:rpc:prompt` request; assert the handler calls the UI dialog function with the message; assert the reply contains the approval decision.
   Test the no-UI guard (reply with `success: false, error: "no_ui"`).
   Test user-denied path.
2. **Green**: Implement the prompt handler.
   It checks `runtime.runtimeContext?.hasUI`, calls `requestPermissionDecisionFromUi`, and emits the reply.
3. Commit: `feat: add permissions:rpc:prompt forwarding RPC (#29)`

### Step 5: Wire RPC cleanup on session shutdown

Store unsubscribe handles from `registerPermissionRpcHandlers()` and call them in `handleSessionShutdown()`.

1. **Red**: `tests/permission-event-rpc.test.ts` — assert unsubscribe functions are returned and callable.
2. **Green**: Store handles in `ExtensionRuntime` or `HandlerDeps`; call in shutdown.
3. Commit: `feat: clean up RPC handlers on session shutdown (#29)`

### Step 6: Decision broadcast in tool-call handler

Add `events` (or `emitDecision`) to `HandlerDeps`.
Emit `permissions:decision` after each gate resolution in `handleToolCall`.

1. **Red**: `tests/handlers/tool-call-events.test.ts` — mock `deps.events.emit`; exercise `handleToolCall` with allow, deny, ask→approved, session-approved, and infrastructure-auto-allowed scenarios; assert each emits `permissions:decision` with the correct `resolution` and `surface`.
2. **Green**: Add `events` to `HandlerDeps` in `src/handlers/types.ts`.
   Add `emitDecisionEvent()` calls in `src/handlers/tool-call.ts` at each decision point.
   Update `src/index.ts` to pass `pi.events` in deps.
3. **Red/Green**: Update existing tool-call handler tests that construct `HandlerDeps` to include the new `events` field (mock `{ emit: vi.fn(), on: vi.fn() }`).
   This is a pre-requisite for the existing test suite to pass after the type change.
4. Commit: `feat: emit permission decision events from tool-call handler (#29)`

### Step 7: Decision broadcast in input handler

Emit `permissions:decision` after the skill input gate in `handleInput`.

1. **Red**: `tests/handlers/input-events.test.ts` — mock `deps.events.emit`; exercise skill input allow, deny, ask paths; assert emission.
2. **Green**: Add `emitDecisionEvent()` calls in `src/handlers/input.ts`.
3. Commit: `feat: emit permission decision events from input handler (#29)`

### Step 8: Auto-approve resolution tracking

Ensure yolo-mode auto-approved decisions emit with `resolution: "auto_approved"` rather than `"user_approved"`.
The `PermissionPrompter.prompt()` returns `{ approved: true, state: "approved" }` for both user approval and yolo auto-approve — they are indistinguishable at the handler level.

1. **Red**: Test that when yolo mode is enabled, the emitted decision has `resolution: "auto_approved"`.
2. **Green**: Either add a distinguishing field to `PermissionPromptDecision` (e.g. `autoApproved: true`) or have the prompter accept an `onAutoApprove` callback.
   The handler sets a local flag before calling the gate and checks it when constructing the emission payload.
3. Commit: `feat: distinguish auto-approved from user-approved in decision events (#29)`

### Step 9: Documentation

Add "Event API" section to `README.md` with channel names, payload fields, protocol version, stability guarantees, worked examples for decision broadcast, check RPC, and prompt RPC.
Update `docs/architecture/target-architecture.md` module list.

1. Commit: `docs: document permission event API and RPC protocol (#29)`

## Risks and Mitigations

| Risk                                                                                    | Mitigation                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Could this silently weaken a permission?                                                | No. Event emission is fire-and-forget; it does not alter any allow/deny/ask decision path. The gate logic is unchanged.                                                                                                                                                                 |
| RPC prompt handler could be exploited by a malicious extension to show unwanted dialogs | `pi.events` is process-scoped — any loaded extension already has full access to the UI. The prompt handler adds no new attack surface beyond what `pi.events.emit("input", ...)` already provides. The handler also requires `hasUI` to respond.                                        |
| Multiple extension instances register duplicate RPC handlers on the same event bus      | In-process subagent child sessions (tintinweb) do not reload extensions — only the parent instance is active. CLI-spawned subagents run in separate processes with separate event buses. The plan adds a `hasUI` guard so even if duplicates exist, only the instance with UI responds. |
| Decision event payload bloat slows down the event bus                                   | Payloads are small (<500 bytes). The event bus is synchronous in-process `emit()` — no serialization overhead.                                                                                                                                                                          |
| Breaking change to channel names after adoption                                         | Channel names are constants exported from `src/permission-events.ts`. Versioning policy: no renames without semver-major. `protocolVersion` in RPC replies enables forward-compatible negotiation.                                                                                      |
| Existing tests break when `HandlerDeps` gains an `events` field                         | Step 6 explicitly folds in the type change and mock updates for existing test files before adding emission logic.                                                                                                                                                                       |

## Open Questions

1. **Should `before_agent_start` tool-filtering decisions emit events?**
   Tool filtering is a bulk pre-start phase (deny tools hidden before the agent runs).
   Emitting for each filtered tool could be noisy.
   Deferred — the handler can opt in later without API changes.
2. **Should the prompt RPC handler write to the permission review log?**
   Currently, the review log captures all UI dialog outcomes.
   The RPC prompt handler should likely log too, but the source would be `"rpc_prompt"` rather than `"tool_call"`.
   Deferred to implementation.
3. **Should the check RPC normalize the `value` input the same way handlers do?**
   For example, bash commands go through `normalizeInput()` which extracts the command string.
   Exposing raw `checkPermission()` without normalization may surprise callers.
   Deferred — start with raw passthrough and document the limitation.
4. **Should we add a `permissions:rpc:ping` channel for health checks?**
   tintinweb uses `subagents:rpc:ping`.
   The `permissions:ready` event serves a similar purpose, but a synchronous ping RPC could be useful for late-arriving consumers.
   Low cost to add — can be folded into step 3 if desired.
