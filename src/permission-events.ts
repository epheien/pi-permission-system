/**
 * Permission event channel — public contract.
 *
 * Exports channel name constants, TypeScript types for all emitted events,
 * and thin emit helpers.
 *
 * Stability guarantee: fields may be added, but existing fields will not be
 * removed or renamed without a semver-major version bump.
 */

/** Minimal event bus interface required by the emit helpers. */
export interface PermissionEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

// ── Channel name constants ─────────────────────────────────────────────────

/** Emitted at `session_start`, after the service is published. */
export const PERMISSIONS_READY_CHANNEL = "permissions:ready";

/** Emitted when a permission request is committed to the active UI prompt path. */
export const PERMISSIONS_UI_PROMPT_CHANNEL = "permissions:ui_prompt";

/** Emitted after every permission gate resolution. */
export const PERMISSIONS_DECISION_CHANNEL = "permissions:decision";

// ── permissions:ready ──────────────────────────────────────────────────────

/**
 * Payload emitted on `permissions:ready`.
 *
 * Intentionally empty: the channel is a readiness signal. There is no
 * `protocolVersion` — the published types plus package semver define the
 * broadcast contract.
 */
export type PermissionsReadyEvent = Record<string, never>;

// ── permissions:ui_prompt ──────────────────────────────────────────────────

/**
 * Origin of a UI prompt.
 *
 * Forwarding is orthogonal to origin: a forwarded subagent prompt keeps its
 * original source and is identified by a non-null `forwarding` field, not by a
 * dedicated source value.
 */
export type PermissionUiPromptSource =
  | "tool_call"
  | "skill_input"
  | "skill_read";

/** Forwarding context, present only when a prompt was forwarded from a non-UI subagent. */
export interface ForwardedPromptContext {
  /** Requesting subagent's display name, when known. */
  requesterAgentName: string | null;
  /** Requesting subagent's session id, when known. */
  requesterSessionId: string | null;
}

/**
 * Payload emitted on `permissions:ui_prompt`, immediately before the active
 * user-facing permission UI is shown.
 *
 * Lean by design: `surface`/`value` are the normalized display projection a
 * notification consumer reads; `source` is the origin; `forwarding` is non-null
 * only for forwarded subagent prompts. There is no `protocolVersion` — the
 * published types plus package semver define the broadcast contract, and
 * consumers should read defensively.
 */
export interface PermissionUiPromptEvent {
  /** Unique ID for the permission request being prompted. */
  requestId: string;
  /** Prompt origin. */
  source: PermissionUiPromptSource;
  /** Normalized display surface (e.g. "bash", "skill"), when known. */
  surface: string | null;
  /** Normalized display value (command, path, skill name, etc.), when known. */
  value: string | null;
  /** Agent name (when known). */
  agentName: string | null;
  /** Message displayed to the user. */
  message: string;
  /** Forwarding context, or null for a direct prompt. */
  forwarding: ForwardedPromptContext | null;
}

// ── permissions:decision ───────────────────────────────────────────────────

/** How a permission decision was reached. */
export type PermissionDecisionResolution =
  | "policy_allow"
  | "policy_deny"
  | "session_approved"
  | "infrastructure_auto_allowed"
  | "user_approved"
  | "user_approved_for_session"
  | "user_denied"
  | "auto_approved"
  | "confirmation_unavailable";

/** Payload emitted on `permissions:decision`. */
export interface PermissionDecisionEvent {
  /** Permission surface: "bash", "read", "mcp", "skill", "external_directory", etc. */
  surface: string;
  /** The value that was evaluated (command, tool name, skill name, path). */
  value: string;
  /** Final decision. */
  result: "allow" | "deny";
  /** How the decision was reached. */
  resolution: PermissionDecisionResolution;
  /** Which config scope contributed the winning rule (when available). */
  origin: string | null;
  /** Agent name (when known). */
  agentName: string | null;
  /** Matched pattern from the winning rule (when available). */
  matchedPattern: string | null;
}

// ── Emit helpers ───────────────────────────────────────────────────────────

/**
 * Emit the `permissions:ready` broadcast.
 * Call at `session_start`, after the service is published, so a consumer
 * reacting to ready can immediately resolve `getPermissionsService()`.
 */
export function emitReadyEvent(events: PermissionEventBus): void {
  const payload: PermissionsReadyEvent = {};
  try {
    events.emit(PERMISSIONS_READY_CHANNEL, payload);
  } catch {
    // Broadcasts are best-effort. A throwing listener must not block the
    // permission system from completing session startup.
  }
}

/**
 * Emit a `permissions:ui_prompt` broadcast.
 * Call immediately before invoking the active user-facing permission UI.
 */
export function emitUiPromptEvent(
  events: PermissionEventBus,
  event: PermissionUiPromptEvent,
): void {
  try {
    events.emit(PERMISSIONS_UI_PROMPT_CHANNEL, event);
  } catch {
    // UI-prompt broadcasts are observational. A consumer failure must not block
    // the permission dialog itself.
  }
}

/**
 * Emit a `permissions:decision` broadcast.
 * Call after every permission gate resolution.
 */
export function emitDecisionEvent(
  events: PermissionEventBus,
  event: PermissionDecisionEvent,
): void {
  try {
    events.emit(PERMISSIONS_DECISION_CHANNEL, event);
  } catch {
    // Broadcasts are best-effort. A throwing listener must not block the
    // permission gate from resolving.
  }
}
