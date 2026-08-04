import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  getActiveAgentName,
  getActiveAgentNameFromSystemPrompt,
} from "#src/active-agent";
import {
  type ForwarderContext,
  getCwd,
  getSessionId,
} from "#src/authority/forwarder-context";
import {
  cleanupPermissionForwardingLocationIfEmpty,
  ensurePermissionForwardingLocation,
  logPermissionForwardingError,
  logPermissionForwardingWarning,
  readForwardedPermissionResponse,
  safeDeleteFile,
  sleep,
  writeJsonFileAtomic,
} from "#src/authority/forwarding-io";
import type { PermissionPromptDecision } from "#src/authority/permission-dialog";
import {
  type ForwardedAccessFacts,
  type ForwardedPermissionRequest,
  type ForwardedPromptDisplay,
  type ForwardedSessionApproval,
  PERMISSION_FORWARDING_POLL_INTERVAL_MS,
  PERMISSION_FORWARDING_TIMEOUT_MS,
  type PermissionForwardingLocation,
  resolvePermissionForwardingTargetSessionId,
  SUBAGENT_PARENT_SESSION_ENV_CANDIDATES,
} from "#src/authority/permission-forwarding";
import type { SubagentSessionRegistry } from "#src/authority/subagent-registry";
import { buildUiPrompt } from "#src/permission-ui-prompt";
import type { DebugReviewLogger } from "#src/session-logger";
import { toRecord } from "#src/value-guards";
import type { TerminalAuthorizer } from "./authorizer";
import type { PromptPermissionDetails } from "./permission-prompter";

// ── Module-private helpers ────────────────────────────────────────────────

function getContextSystemPrompt(ctx: ForwarderContext): string | undefined {
  const getSystemPrompt = toRecord(ctx).getSystemPrompt;
  if (typeof getSystemPrompt !== "function") {
    return undefined;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- getSystemPrompt is a Pi SDK accessor returning any
    const systemPrompt = getSystemPrompt.call(ctx);
    return typeof systemPrompt === "string" ? systemPrompt : undefined;
  } catch (error) {
    // No deps available in this helper — warning silently dropped.
    logPermissionForwardingWarning(
      null,
      "Failed to read context system prompt for forwarded permission metadata",
      error,
    );
    return undefined;
  }
}

// ── ParentAuthorizer ────────────────────────────────────────────────────

/**
 * The facts a forwarded request relays unchanged from the child's ask: the
 * prompt message, the optional display projection, and the optional
 * session-approval suggestion.
 *
 * Bundled into one object so the two-hop private chain
 * (`waitForForwardedApproval` → `buildForwardedRequest`) threads a single
 * relayed value instead of three positional optionals.
 */
interface ForwardedRequestFacts {
  message: string;
  display?: ForwardedPromptDisplay;
  sessionApproval?: ForwardedSessionApproval;
  /** The child-fixed access facts; the edge completes them into a `ForwardedAccessIntent`. */
  accessIntent?: ForwardedAccessFacts;
}

/** Constructor config for {@link ParentAuthorizer}. */
export interface ParentAuthorizerDeps {
  forwardingDir: string;
  /** In-process subagent session registry for forwarding target resolution. */
  registry?: SubagentSessionRegistry;
  logger: DebugReviewLogger;
}

/**
 * Authorizer for a subagent session: escalate the ask up the tree to the
 * parent's authority.
 *
 * Owns the escalation-up role of the forwarded-permission behavior: builds
 * and persists a request file, then polls for the parent session's
 * response. `ctx` is bound once at construction — `selectAuthorizer` only
 * constructs a `ParentAuthorizer` for a context it has already confirmed has
 * no UI and is a subagent, so `authorize` never re-derives that dispatch
 * (formerly `ApprovalEscalator.requestApproval`'s `hasUI` / `!isSubagent`
 * arms, both dead once every caller routes through `selectAuthorizer`).
 */
export class ParentAuthorizer implements TerminalAuthorizer {
  private readonly forwardingDir: string;
  private readonly registry: SubagentSessionRegistry | undefined;
  private readonly logger: DebugReviewLogger;

  constructor(
    private readonly ctx: ForwarderContext,
    deps: ParentAuthorizerDeps,
  ) {
    this.forwardingDir = deps.forwardingDir;
    this.registry = deps.registry;
    this.logger = deps.logger;
  }

  authorize(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> {
    const uiPrompt = buildUiPrompt(details);
    return this.waitForForwardedApproval(this.ctx, {
      message: details.message,
      display: {
        source: uiPrompt.source,
        surface: uiPrompt.surface,
        value: uiPrompt.value,
      },
      sessionApproval: details.sessionApproval,
      accessIntent: details.accessIntent,
    });
  }

  // ── Private methods ────────────────────────────────────────────────────

  private async waitForForwardedApproval(
    ctx: ForwarderContext,
    facts: ForwardedRequestFacts,
  ): Promise<PermissionPromptDecision> {
    const requesterSessionId = getSessionId(ctx);
    const targetSessionId = resolvePermissionForwardingTargetSessionId({
      hasUI: ctx.hasUI,
      // Invariant: selectAuthorizer only selects ParentAuthorizer for a
      // no-UI subagent context, so this is always true — no detection dep
      // needed to re-derive it here.
      isSubagent: true,
      currentSessionId: requesterSessionId,
      env: process.env,
      sessionId: requesterSessionId,
      registry: this.registry,
    });

    if (!targetSessionId) {
      logPermissionForwardingError(
        this.logger,
        `Permission forwarding target session could not be resolved. ` +
          `Checked env vars: ${SUBAGENT_PARENT_SESSION_ENV_CANDIDATES.join(", ")}. ` +
          `If you are using a subagent extension (nicobailon/pi-subagents, HazAT/pi-interactive-subagents, etc.), ` +
          `ask its maintainer to set PI_SUBAGENT_PARENT_SESSION in the child process environment ` +
          `(see https://github.com/gotgenes/pi-permission-system/issues/143).`,
      );
      return { approved: false, state: "denied" };
    }

    const location = ensurePermissionForwardingLocation(
      this.logger,
      this.forwardingDir,
      targetSessionId,
    );
    if (!location) {
      logPermissionForwardingError(
        this.logger,
        `Permission forwarding is unavailable because session-scoped directories could not be prepared for '${targetSessionId}'`,
      );
      return { approved: false, state: "denied" };
    }

    const request = this.buildForwardedRequest(
      ctx,
      facts,
      requesterSessionId,
      targetSessionId,
    );
    const requestPath = join(location.requestsDir, `${request.id}.json`);
    const responsePath = join(location.responsesDir, `${request.id}.json`);

    this.logger.review("forwarded_permission.request_created", {
      requestId: request.id,
      requesterAgentName: request.requesterAgentName,
      requesterSessionId: request.requesterSessionId,
      targetSessionId,
      requestPath,
      responsePath,
    });

    try {
      writeJsonFileAtomic(this.logger, requestPath, request);
    } catch (error) {
      logPermissionForwardingError(
        this.logger,
        `Failed to write forwarded permission request '${requestPath}'`,
        error,
      );
      return { approved: false, state: "denied" };
    }

    return this.pollForForwardedResponse(
      location,
      request,
      requestPath,
      responsePath,
    );
  }

  private buildForwardedRequest(
    ctx: ForwarderContext,
    facts: ForwardedRequestFacts,
    requesterSessionId: string,
    targetSessionId: string,
  ): ForwardedPermissionRequest {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${process.pid}`;
    const requesterAgentName =
      getActiveAgentName(ctx) ??
      getActiveAgentNameFromSystemPrompt(getContextSystemPrompt(ctx)) ??
      "unknown";
    // Complete the child-fixed facts into a full ForwardedAccessIntent: the
    // gate fixed the access facts; the edge stamps the requester identity it
    // alone knows (cwd + principal). The parent resolves against this intent
    // and never re-derives the match set (ADR 0008).
    const accessIntent = facts.accessIntent
      ? {
          ...facts.accessIntent,
          requesterCwd: getCwd(ctx),
          principal: {
            sessionId: requesterSessionId,
            agentName: requesterAgentName,
          },
        }
      : undefined;
    return {
      id: requestId,
      createdAt: Date.now(),
      requesterSessionId,
      targetSessionId,
      requesterAgentName,
      message: facts.message,
      ...(facts.display
        ? {
            source: facts.display.source,
            surface: facts.display.surface,
            value: facts.display.value,
          }
        : {}),
      ...(facts.sessionApproval
        ? { sessionApproval: facts.sessionApproval }
        : {}),
      ...(accessIntent ? { accessIntent } : {}),
    };
  }

  private async pollForForwardedResponse(
    location: PermissionForwardingLocation,
    request: ForwardedPermissionRequest,
    requestPath: string,
    responsePath: string,
  ): Promise<PermissionPromptDecision> {
    const { id: requestId, requesterAgentName, targetSessionId } = request;
    const deadline = Date.now() + PERMISSION_FORWARDING_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (existsSync(responsePath)) {
        const response = readForwardedPermissionResponse(
          this.logger,
          responsePath,
        );
        this.logger.review("forwarded_permission.response_received", {
          requestId,
          approved: response?.approved ?? null,
          state: response?.state ?? null,
          denialReason: response?.denialReason ?? null,
          responderSessionId: response?.responderSessionId ?? null,
          targetSessionId,
          responsePath,
        });
        safeDeleteFile(
          this.logger,
          responsePath,
          "forwarded permission response",
        );
        safeDeleteFile(
          this.logger,
          requestPath,
          "forwarded permission request",
        );
        cleanupPermissionForwardingLocationIfEmpty(this.logger, location);
        return response ?? { approved: false, state: "denied" };
      }

      await sleep(PERMISSION_FORWARDING_POLL_INTERVAL_MS);
    }

    logPermissionForwardingWarning(
      this.logger,
      `Timed out waiting for forwarded permission response '${responsePath}'`,
    );
    this.logger.review("forwarded_permission.response_timed_out", {
      requestId,
      requesterAgentName,
      targetSessionId,
      responsePath,
    });
    safeDeleteFile(this.logger, requestPath, "forwarded permission request");
    cleanupPermissionForwardingLocationIfEmpty(this.logger, location);
    return { approved: false, state: "denied" };
  }
}
