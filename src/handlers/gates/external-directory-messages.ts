import {
  type ExternalPathDisclosure,
  resolvesToSuffix,
} from "#src/denial-messages";

/** Section header listing the patterns a "for this session" grant would record. */
const PATTERNS_HEADER = "Patterns";

/**
 * One opencode-style headline line: `Access external directory <path>`, with
 * the ` (resolves to '…')` suffix when the canonical target differs.
 */
function externalDirectoryLine(
  path: string,
  resolvedPath: string | undefined,
): string {
  return `Access external directory ${path}${resolvesToSuffix(resolvedPath)}`;
}

/**
 * Render the "Patterns" section for the granted wildcard patterns.
 *
 * Deduplicates — several external paths can share one parent-glob (e.g. two
 * files in `/etc` both yield `/etc/*`), and showing it once is enough.
 */
function patternsSection(patterns: string[]): string {
  const unique = [...new Set(patterns)];
  return `${PATTERNS_HEADER}\n${unique.map((pattern) => `- ${pattern}`).join("\n")}`;
}

/**
 * opencode-style ask message for a path-bearing tool crossing the working
 * directory boundary: the accessed directory as the headline, then the
 * wildcard patterns a session grant would record (so the user sees exactly
 * what "for this session" would allow).
 *
 * Deliberately omits the tool name, CWD, and agent — the surface boundary and
 * requester are already conveyed by the dialog framing, and the ask stays as
 * lean as OpenCode's. Denial messages (denial-messages.ts) keep the full
 * context for post-decision review.
 */
export function formatExternalDirectoryAskPrompt(
  pathValue: string,
  resolvedPath: string | undefined,
  patterns: string[],
): string {
  return `${externalDirectoryLine(pathValue, resolvedPath)}\n\n${patternsSection(patterns)}`;
}

/**
 * opencode-style ask message for a bash command touching directories outside
 * the working directory. Headlines each external path (with symlink
 * disclosure), then lists the wildcard patterns a session grant would record.
 *
 * The bash command itself is intentionally not shown here — it is redundant
 * with the pending tool invocation and stays available in the review log and
 * denial messages for post-decision debugging.
 */
export function formatBashExternalDirectoryAskPrompt(
  externalPaths: ExternalPathDisclosure[],
  patterns: string[],
): string {
  const lines = externalPaths.map(({ path, resolvedPath }) =>
    externalDirectoryLine(path, resolvedPath),
  );
  return `${lines.join("\n")}\n\n${patternsSection(patterns)}`;
}
