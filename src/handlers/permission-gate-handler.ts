import type {
  ExtensionContext,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  formatMissingToolNameReason,
  formatUnknownToolReason,
} from "#src/permission-prompts";
import type { PermissionSession } from "#src/permission-session";
import {
  checkRequestedToolRegistration,
  getToolNameFromValue,
  type ToolRegistry,
} from "#src/tool-registry";
import { toRecord } from "#src/value-guards";
import type { GateBypass } from "./gates/descriptor";
import type { GateRunner } from "./gates/runner";
import type {
  GateNotifier,
  SkillInputGatePipeline,
} from "./gates/skill-input-gate-pipeline";
import type { ToolCallGatePipeline } from "./gates/tool-call-gate-pipeline";
import type { GateOutcome, ToolCallContext } from "./gates/types";

/** Minimal subset of InputEvent used by handleInput. */
interface InputPayload {
  text: string;
}

/**
 * Handles permission gate events: tool_call and input.
 *
 * Constructor deps:
 * - `session` — state/lifecycle owner: bind per-event context, resolve agent name
 * - `toolRegistry` — Pi tool API subset (getAll + setActive)
 * - `pipeline` — owns tool-call gate-producer assembly and the run loop
 * - `skillInputPipeline` — owns skill-input gate assembly (pre-check, notify, run)
 * - `runner` — pre-built gate runner (constructed in the composition root)
 */
export class PermissionGateHandler {
  constructor(
    private readonly session: PermissionSession,
    private readonly toolRegistry: ToolRegistry,
    private readonly pipeline: ToolCallGatePipeline,
    private readonly skillInputPipeline: SkillInputGatePipeline,
    private readonly runner: GateRunner,
  ) {}

  async handleToolCall(
    event: unknown,
    ctx: ExtensionContext,
  ): Promise<GateOutcome> {
    this.session.activate(ctx);

    const agentName = this.session.resolveAgentName(ctx);

    const input = getEventInput(event);
    const toolCallId =
      typeof (event as Record<string, unknown>).toolCallId === "string"
        ? ((event as Record<string, unknown>).toolCallId as string)
        : "";

    const validation = validateRequestedTool(event, this.toolRegistry.getAll());
    if (validation.status === "block") {
      // Under yolo the extension bypasses every check but an explicit deny.
      // A tool name Pi itself will reject (unknown/unregistered) therefore
      // passes through — recorded as an auto-approval so the bypass stays
      // auditable rather than looking like a silent allow.
      if (!this.session.isYoloEnabled()) {
        return { action: "block", reason: validation.reason };
      }
      return await this.runner.run(
        yoloUnregisteredToolBypass(
          event,
          toolCallId,
          agentName,
          validation.reason,
        ),
        agentName,
        toolCallId,
      );
    }
    const toolName = validation.toolName;

    const tcc: ToolCallContext = {
      toolName,
      agentName,
      input,
      toolCallId,
      cwd: ctx.cwd,
    };

    return await this.pipeline.evaluate(tcc, this.runner);
  }

  async handleInput(
    event: InputPayload,
    ctx: ExtensionContext,
  ): Promise<InputEventResult> {
    this.session.activate(ctx);

    const skillName = extractSkillNameFromInput(event.text);
    if (!skillName) {
      return { action: "continue" };
    }

    const agentName = this.session.resolveAgentName(ctx);
    const notifier: GateNotifier = {
      warn: (message) => {
        if (ctx.hasUI) {
          ctx.ui.notify(message, "warning");
        }
      },
    };
    const outcome = await this.skillInputPipeline.evaluate(
      skillName,
      agentName,
      notifier,
      this.runner,
    );
    return outcome.action === "block"
      ? { action: "handled" }
      : { action: "continue" };
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────

/**
 * Build the audited bypass result for a tool name Pi itself will reject.
 *
 * Under yolo the extension bypasses every check but an explicit `deny`, and an
 * unregistered or missing tool name can never match a `deny` rule — so it
 * passes. Recorded as an auto-approval (rather than a silent allow) so the
 * review log still shows what yolo let through and why.
 */
function yoloUnregisteredToolBypass(
  event: unknown,
  toolCallId: string,
  agentName: string | null,
  blockedReason: string,
): GateBypass {
  return {
    action: "allow",
    log: {
      event: "permission_request.auto_approved",
      details: {
        source: "tool_call",
        toolCallId,
        toolName: getToolNameFromValue(event) ?? "<unknown>",
        agentName,
        resolution: "auto_approved",
        bypassedCheck: "unregistered-tool",
        blockedReason,
      },
    },
  };
}

/** Discriminated result of validating a tool-call event's name and registration. */
export type RequestedToolValidation =
  | { status: "ok"; toolName: string }
  | { status: "block"; reason: string };

/**
 * Validate the tool name from a raw event against the registered tool list.
 *
 * Composes `getToolNameFromValue` + `checkRequestedToolRegistration` + the
 * two reason formatters and returns a discriminated result so `handleToolCall`
 * reads as a straight validate → proceed path without nested early-returns.
 *
 * Returns the **raw** tool name (not the normalised form) so that
 * `ToolCallContext.toolName` stays identical to the pre-extraction behaviour.
 */
export function validateRequestedTool(
  event: unknown,
  availableTools: readonly unknown[],
): RequestedToolValidation {
  const toolName = getToolNameFromValue(event);
  if (!toolName) {
    return { status: "block", reason: formatMissingToolNameReason() };
  }
  const check = checkRequestedToolRegistration(toolName, availableTools);
  if (check.status === "missing-tool-name") {
    return { status: "block", reason: formatMissingToolNameReason() };
  }
  if (check.status === "unregistered") {
    return {
      status: "block",
      reason: formatUnknownToolReason(
        check.requestedToolName,
        check.availableToolNames,
      ),
    };
  }
  return { status: "ok", toolName };
}

/**
 * Extract the tool input from an event, checking both `input` and `arguments`
 * fields (different Pi SDK versions use different names).
 */
export function getEventInput(event: unknown): unknown {
  const record = toRecord(event);

  if (record.input !== undefined) {
    return record.input;
  }

  if (record.arguments !== undefined) {
    return record.arguments;
  }

  return {};
}

/**
 * Parse a `/skill:<name>` prefix from user input.
 * Returns the skill name, or null if the text is not a skill invocation.
 */
export function extractSkillNameFromInput(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/skill:")) {
    return null;
  }

  const afterPrefix = trimmed.slice("/skill:".length);
  if (!afterPrefix) {
    return null;
  }

  const firstWhitespace = afterPrefix.search(/\s/);
  const skillName = (
    firstWhitespace === -1 ? afterPrefix : afterPrefix.slice(0, firstWhitespace)
  ).trim();
  return skillName || null;
}
