import { join } from "node:path";
import type { PermissionUiPromptSource } from "#src/permission-events";
import type { PermissionDecisionState } from "./permission-dialog";
import type { SubagentSessionRegistry } from "./subagent-registry";

export const PERMISSION_FORWARDING_POLL_INTERVAL_MS = 250;
export const PERMISSION_FORWARDING_TIMEOUT_MS = 10 * 60 * 1000;
export const SUBAGENT_ENV_HINT_KEYS = [
  // pi-agent-router (original)
  "PI_IS_SUBAGENT",
  "PI_SUBAGENT_SESSION_ID",
  "PI_AGENT_ROUTER_SUBAGENT",
  // nicobailon/pi-subagents
  "PI_SUBAGENT_CHILD",
  "PI_SUBAGENT_RUN_ID",
  "PI_SUBAGENT_CHILD_AGENT",
  "PI_SUBAGENT_DEPTH",
  // HazAT/pi-interactive-subagents
  "PI_SUBAGENT_NAME",
  "PI_SUBAGENT_ID",
  "PI_SUBAGENT_SESSION",
  "PI_SUBAGENT_ACTIVITY_FILE",
] as const;
/** Ordered list of env var names to check for the parent session ID. First match wins. */
export const SUBAGENT_PARENT_SESSION_ENV_CANDIDATES: readonly string[] = [
  // pi-agent-router (original)
  "PI_AGENT_ROUTER_PARENT_SESSION_ID",
  // Shared convention for CLI-based subagent extensions
  // (nicobailon/pi-subagents, HazAT/pi-interactive-subagents, etc.)
  "PI_SUBAGENT_PARENT_SESSION",
] as const;

/** @deprecated Use SUBAGENT_PARENT_SESSION_ENV_CANDIDATES */
export const SUBAGENT_PARENT_SESSION_ENV_KEY =
  SUBAGENT_PARENT_SESSION_ENV_CANDIDATES[0];

const SESSION_FORWARDING_ROOT_DIRECTORY_NAME = "sessions";
const SESSION_FORWARDING_REQUESTS_DIRECTORY_NAME = "requests";
const SESSION_FORWARDING_RESPONSES_DIRECTORY_NAME = "responses";

/**
 * Display fields relayed from a forwarding child to the parent UI so the parent
 * can emit a non-degraded `permissions:ui_prompt` event.
 *
 * Carried separately from the prompt message because the parent reconstructs
 * the original event from the escalated ask's details (`buildUiPrompt`), not
 * from the message text.
 */
export interface ForwardedPromptDisplay {
  source: PermissionUiPromptSource;
  surface: string | null;
  value: string | null;
}

/**
 * The child's session-approval suggestion, relayed to the serving node so a
 * human who grants "the whole session" records the same pattern the child
 * would have recorded locally.
 *
 * A plain data shape (not the `SessionApproval` value object) so it serializes
 * onto the forwarded request; the serving node rebuilds a `SessionApproval`
 * from it via `SessionApproval.multiple`.
 */
export interface ForwardedSessionApproval {
  surface: string;
  patterns: readonly string[];
}

/**
 * The child-fixed facts a gate emits: the surface it evaluated and the match
 * set it computed. `requesterCwd` and `principal` are stamped at the escalation
 * edge (`ParentAuthorizer`), so a gate carries only what it alone can produce.
 *
 * Strings only — an `AccessPath` never crosses onto the wire
 * (`docs/decisions/0002-path-values-string-boundary.md`).
 */
export interface ForwardedAccessFacts {
  /** Gate surface: `"path"`, `"external_directory"`, `"bash"`, a tool name, or a skill name. */
  surface: string;
  /**
   * The child-fixed match set. Path surface: `AccessPath.matchValues()`
   * (absolute ∪ cwd-relative ∪ canonical), computed at the child. Non-path
   * surface: the already-portable single value as a one-element array.
   */
  matchValues: string[];
  /** `AccessPath.boundaryValue()` (canonical) for a path surface; `null` for a non-path surface. */
  boundaryValue: string | null;
}

/**
 * The forwarded-wire access intent (ADR 0008 §2): the child-fixed access facts
 * plus the requester identity the escalation edge stamps.
 *
 * The serving node resolves against this intent directly (Step 3, [#597]),
 * using `matchValues` as-is — it never re-derives a path through its own
 * `PathNormalizer`/cwd. See
 * `docs/decisions/0008-cross-session-access-intent.md`.
 */
export interface ForwardedAccessIntent extends ForwardedAccessFacts {
  /** The requester's cwd, for provenance/disclosure — never for parent re-derivation. */
  requesterCwd: string;
  /** Who is requesting. */
  principal: {
    sessionId: string;
    agentName: string;
  };
}

export type ForwardedPermissionRequest = {
  id: string;
  createdAt: number;
  requesterSessionId: string;
  targetSessionId: string;
  requesterAgentName: string;
  message: string;
  /**
   * Original prompt display fields, persisted so the parent emits a
   * non-degraded event. Optional for version-skew tolerance: a parent on a
   * newer version may read a request written by an older child during an
   * upgrade, in which case the reader defaults `source` to `"tool_call"`.
   */
  source?: PermissionUiPromptSource;
  surface?: string | null;
  value?: string | null;
  /**
   * The child's session-approval suggestion. Present when the child computed a
   * "for this session" pattern for the ask; lets the serving node record a
   * whole-session grant. Optional for version-skew tolerance (an older child
   * omits it, and the serving dialog then offers no scope choice).
   */
  sessionApproval?: ForwardedSessionApproval;
  /**
   * The child-fixed access intent (ADR 0008 §2). Optional for version-skew
   * tolerance: an older child omits it, and the serving node floors to `ask`
   * (Step 3). Present on a current child's request for every gate surface.
   */
  accessIntent?: ForwardedAccessIntent;
};

export type ForwardedPermissionResponse = {
  approved: boolean;
  state: PermissionDecisionState;
  denialReason?: string;
  responderSessionId: string;
  respondedAt: number;
};

export type PermissionForwardingLocation = {
  sessionId: string;
  sessionRootDir: string;
  requestsDir: string;
  responsesDir: string;
  label: "primary";
};

export function normalizePermissionForwardingSessionId(
  value: unknown,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "unknown") {
    return null;
  }

  return trimmed;
}

function encodeSessionIdForPath(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

export function createPermissionForwardingLocation(
  forwardingRootDir: string,
  sessionId: string,
): PermissionForwardingLocation {
  const normalizedSessionId = normalizePermissionForwardingSessionId(sessionId);
  if (!normalizedSessionId) {
    throw new Error(
      "Permission forwarding session id must be a non-empty string.",
    );
  }

  const sessionRootDir = join(
    forwardingRootDir,
    SESSION_FORWARDING_ROOT_DIRECTORY_NAME,
    encodeSessionIdForPath(normalizedSessionId),
  );

  return {
    sessionId: normalizedSessionId,
    sessionRootDir,
    requestsDir: join(
      sessionRootDir,
      SESSION_FORWARDING_REQUESTS_DIRECTORY_NAME,
    ),
    responsesDir: join(
      sessionRootDir,
      SESSION_FORWARDING_RESPONSES_DIRECTORY_NAME,
    ),
    label: "primary",
  };
}

export function resolvePermissionForwardingTargetSessionId(options: {
  hasUI: boolean;
  isSubagent: boolean;
  currentSessionId?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Child session id for registry lookup. */
  sessionId?: string;
  /** In-process subagent session registry (checked before env vars). */
  registry?: SubagentSessionRegistry;
}): string | null {
  if (options.hasUI) {
    return normalizePermissionForwardingSessionId(options.currentSessionId);
  }

  if (!options.isSubagent) {
    return null;
  }

  // 1. Registry — in-process subagents register parentSessionId explicitly.
  if (options.registry && options.sessionId) {
    const entry = options.registry.get(options.sessionId);
    const resolved = normalizePermissionForwardingSessionId(
      entry?.parentSessionId,
    );
    if (resolved) return resolved;
  }

  // 2. Env vars — process-based subagent extensions.
  const env = options.env ?? process.env;
  for (const key of SUBAGENT_PARENT_SESSION_ENV_CANDIDATES) {
    const resolved = normalizePermissionForwardingSessionId(env[key]);
    if (resolved) return resolved;
  }
  return null;
}

export function isForwardedPermissionRequestForSession(
  request: Pick<ForwardedPermissionRequest, "targetSessionId">,
  sessionId: string | null | undefined,
): boolean {
  const normalizedRequestSessionId = normalizePermissionForwardingSessionId(
    request.targetSessionId,
  );
  const normalizedSessionId = normalizePermissionForwardingSessionId(sessionId);
  return (
    normalizedRequestSessionId !== null &&
    normalizedRequestSessionId === normalizedSessionId
  );
}
