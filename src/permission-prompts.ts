import { classifyToolKind, isMcpCheck } from "./access-intent/tool-kind";
import { describeBashCommandContext } from "./denial-messages";
import type { SkillPromptEntry } from "./skill-prompt-sanitizer";
import type { ToolPreviewFormatter } from "./tool-preview-formatter";
import type { PermissionCheckResult } from "./types";
import { getNonEmptyString, toRecord } from "./value-guards";

// NOTE: formatDenyReason, formatUserDeniedReason, and
// formatPermissionHardStopHint have been moved to denial-messages.ts.
// This module retains only pre-check messages and user-facing ask prompts.

export function formatMissingToolNameReason(): string {
  return "Tool call was blocked because no tool name was provided. Use a registered tool name from pi.getAllTools().";
}

export function formatUnknownToolReason(
  toolName: string,
  availableToolNames: readonly string[],
): string {
  const preview = availableToolNames.slice(0, 10);
  const suffix = availableToolNames.length > preview.length ? ", ..." : "";
  const availableList =
    preview.length > 0 ? `${preview.join(", ")}${suffix}` : "none";

  const mcpHint =
    classifyToolKind(toolName) === "mcp"
      ? ""
      : ' If this was intended as an MCP server tool, call the registered \'mcp\' tool when available (for example: {"tool":"server:tool"}).';

  return `Tool '${toolName}' is not registered in this runtime and was blocked before permission checks.${mcpHint} Registered tools: ${availableList}.`;
}

export function formatAskPrompt(
  result: PermissionCheckResult,
  agentName?: string,
  input?: unknown,
  formatter?: ToolPreviewFormatter,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  const rows: Array<[string, string]> = [["Agent", subject]];

  if (classifyToolKind(result.toolName) === "bash") {
    if (result.matchedPattern) {
      rows.push(["Rule", `matched '${result.matchedPattern}'`]);
    }
    const context = describeBashCommandContext(result.commandContext);
    if (context) {
      rows.push(["Context", `inside ${context}`]);
    }
    const subCommand = result.command ?? "";
    const fullCommand =
      getNonEmptyString(toRecord(input).command) ?? subCommand;
    const block = keyValueBlock(rows);
    return fullCommand ? `${block}\n\n$ ${fullCommand}` : block;
  }

  if (isMcpCheck(result) && result.target) {
    if (result.matchedPattern) {
      rows.push(["Rule", `matched '${result.matchedPattern}'`]);
    }
    const preview = formatter
      ? formatter.formatToolInputForPrompt("mcp", input)
      : "";
    if (preview) {
      rows.push(["Input", preview]);
    }
    return `${keyValueBlock(rows)}\n\n${result.target}`;
  }

  if (result.matchedPattern) {
    rows.push(["Rule", `matched '${result.matchedPattern}'`]);
  }
  rows.push(["Tool", result.toolName]);
  const preview = formatter
    ? formatter.formatToolInputForPrompt(result.toolName, input)
    : "";
  if (preview) {
    rows.push(["Input", preview]);
  }
  return keyValueBlock(rows);
}

export function formatSkillAskPrompt(
  skillName: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return keyValueBlock([
    ["Agent", subject],
    ["Skill", skillName],
  ]);
}

export function formatSkillPathAskPrompt(
  skill: SkillPromptEntry,
  readPath: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return keyValueBlock([
    ["Agent", subject],
    ["Skill", skill.name],
    ["Path", readPath],
  ]);
}

/**
 * Render structured key/value rows as an aligned, markdown-style block.
 *
 * Rows are emitted as `Label: value` with values aligned to the widest label,
 * which reads cleanly in narrow terminals and survives line wrapping.
 */
export function keyValueBlock(rows: Array<[string, string]>): string {
  if (rows.length === 0) {
    return "";
  }
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows
    .map(([label, value]) => `  ${`${label}:`.padEnd(width + 3)}${value}`)
    .join("\n");
}

// formatSkillPathDenyReason has been moved to denial-messages.ts.
