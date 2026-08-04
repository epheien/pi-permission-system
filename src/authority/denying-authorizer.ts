import type { PermissionPromptDecision } from "#src/authority/permission-dialog";
import type { TerminalAuthorizer } from "./authorizer";

/**
 * Least-privilege Authorizer: no authority is reachable for this session
 * (no UI, not a subagent), so every ask is denied.
 *
 * The denial carries the `confirmationUnavailable` marker so the ask path can
 * distinguish "nobody could answer" from an interactive user denial when it
 * derives the review-entry and decision-event resolution.
 */
export class DenyingAuthorizer implements TerminalAuthorizer {
  authorize(): Promise<PermissionPromptDecision> {
    return Promise.resolve({
      approved: false,
      state: "denied",
      confirmationUnavailable: true,
    });
  }
}
