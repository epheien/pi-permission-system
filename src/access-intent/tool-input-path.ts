import type { ToolAccessExtractorLookup } from "#src/tool-access-extractor-registry";
import { getNonEmptyString, toRecord } from "#src/value-guards";
import { classifyToolKind } from "./tool-kind";

export function getPathBearingToolPath(
  toolName: string,
  input: unknown,
): string | null {
  if (classifyToolKind(toolName) !== "path") {
    return null;
  }

  return getNonEmptyString(toRecord(input).path);
}

/**
 * Extract the filesystem path a tool will access, for the cross-cutting `path`
 * and `external_directory` gates.
 *
 * Unlike {@link getPathBearingToolPath} (built-in tools only), this recognizes
 * extension and MCP tools so they are no longer exempt from path gating:
 *
 * - `bash` → `null` (bash has its own token-based path gates).
 * - Built-in path-bearing tools → `input.path`.
 * - `mcp` → `input.arguments.path`.
 * - Any other tool → a registered {@link ToolAccessExtractor}'s path, else the
 *   default `input.path` convention.
 */
export function getToolInputPath(
  toolName: string,
  input: unknown,
  extractors?: ToolAccessExtractorLookup,
): string | null {
  const record = toRecord(input);

  switch (classifyToolKind(toolName)) {
    case "bash":
      return null;
    case "path":
      return getNonEmptyString(record.path);
    case "mcp":
      return getNonEmptyString(toRecord(record.arguments).path);
    case "skill":
    case "extension": {
      const custom = extractors?.get(toolName);
      if (custom) {
        return getNonEmptyString(custom(record));
      }
      return getNonEmptyString(record.path);
    }
  }
}
