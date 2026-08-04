import type { AccessPath } from "#src/access-intent/access-path";
import { classifyToolKind } from "#src/access-intent/tool-kind";
import type { ForwardedAccessFacts } from "#src/authority/permission-forwarding";
import type {
  PermissionDecisionEvent,
  PermissionDecisionResolution,
} from "#src/permission-events";
import type { PermissionCheckResult } from "#src/types";

/**
 * Build the child-fixed access facts for a path-shaped gate from its
 * `AccessPath`.
 *
 * Converts the `AccessPath` to strings at the point of emission (ADR-0002: an
 * `AccessPath` never crosses onto the wire), carrying the lexical ∪ canonical
 * match set. An empty `boundaryValue()` (a literal-only path) becomes `null`,
 * so the wire distinguishes "no canonical form" cleanly.
 */
export function accessFactsFromPath(
  surface: string,
  path: AccessPath,
): ForwardedAccessFacts {
  return {
    surface,
    matchValues: path.matchValues(),
    boundaryValue: path.boundaryValue() || null,
  };
}

/**
 * Build the child-fixed access facts for a non-path gate (bash command, MCP
 * target, skill name, plain tool) from its already-portable single value.
 */
export function accessFactsFromValue(
  surface: string,
  value: string,
): ForwardedAccessFacts {
  return { surface, matchValues: [value], boundaryValue: null };
}

/**
 * Derive the human-readable value for a decision event from a check result.
 * Bash → extracted command; MCP → qualified target;
 * path-bearing tools → file path; others → tool name.
 */
export function deriveDecisionValue(
  toolName: string,
  check: Pick<PermissionCheckResult, "command" | "target">,
  path?: string,
): string {
  switch (classifyToolKind(toolName)) {
    case "bash":
      return check.command ?? toolName;
    case "mcp":
      return check.target ?? toolName;
    case "path":
    case "skill":
    case "extension":
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- || intentional: an empty path falls through to toolName (the original `if (path)` truthiness)
      return path || toolName;
  }
}

/**
 * Build a `PermissionDecisionEvent` from the gate's inputs.
 *
 * Centralises the `origin / agentName / matchedPattern ?? null` normalization
 * that is otherwise duplicated across the session-hit path and the gate-result
 * path in `runGateCheck`.
 */
export function buildDecisionEvent(
  decision: { surface: string; value: string },
  check: Pick<PermissionCheckResult, "origin" | "matchedPattern">,
  agentName: string | null,
  result: "allow" | "deny",
  resolution: PermissionDecisionResolution,
): PermissionDecisionEvent {
  return {
    surface: decision.surface,
    value: decision.value,
    result,
    resolution,
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- ?? null normalises undefined to null for the log record
    origin: check.origin ?? null,
    agentName: agentName ?? null,
    matchedPattern: check.matchedPattern ?? null,
  };
}

/**
 * Map the gate outcome back to a PermissionDecisionResolution.
 *
 * @param state     - The permission state passed to the gate.
 * @param action    - The gate's resulting action ("allow" | "block").
 * @param hasSession - True when the gate result carries a sessionApproval
 *                    (indicates the user chose "for this session").
 * @param confirmationUnavailable - True when the denial came from the
 *                    DenyingAuthorizer (no live authority was reachable).
 */
export function deriveResolution(
  state: "allow" | "deny" | "ask",
  action: "allow" | "block",
  hasSession: boolean,
  confirmationUnavailable: boolean,
  autoApproved = false,
): PermissionDecisionResolution {
  if (state === "allow") return autoApproved ? "auto_approved" : "policy_allow";
  if (state === "deny") return "policy_deny";
  // state === "ask"
  if (action === "allow") {
    if (autoApproved) return "auto_approved";
    return hasSession ? "user_approved_for_session" : "user_approved";
  }
  return confirmationUnavailable ? "confirmation_unavailable" : "user_denied";
}
