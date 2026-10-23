import type {
  BashCommand,
  WrapperKind,
} from "#src/access-intent/bash/command-enumeration";
import { pickMostRestrictive } from "#src/handlers/gates/candidate-check";
import type { ScopedPermissionResolver } from "#src/permission-resolver";
import type { PermissionCheckResult } from "#src/types";

/**
 * Options controlling how synthesized `ask` floors behave.
 *
 * Under yolo the extension is meant to bypass everything but an explicit
 * `deny`, so the two floors this module synthesizes (the wrapper floor and the
 * unparseable-command sentinel) must not fire. Both bypass paths tag an
 * allowed result `origin: "yolo"` so the review log still records that yolo —
 * not policy — let the command through.
 */
export interface ResolveBashCommandCheckOptions {
  /** Bypass every non-`deny` floor (yolo mode). Defaults to false. */
  yolo?: boolean;
}

/**
 * The synthetic `matchedPattern` recorded when a wrapper unit's `allow` is
 * floored to `ask`, keyed by the wrapper kind that caused the floor.
 */
const WRAPPER_SENTINEL: Record<WrapperKind, string> = {
  "opaque-payload": "<opaque-bash-wrapper>",
  indirection: "<indirection-bash-wrapper>",
};

/**
 * Tag an allowed result as yolo-granted; a `deny` passes through untouched.
 *
 * Only the `allow` case is retagged: a `deny` must survive yolo, and an `ask`
 * reaching this point is already the resolver's own decision (the manager
 * rewrites `ask` to `allow` under yolo), so it is left as-is.
 */
function tagYolo(result: PermissionCheckResult): PermissionCheckResult {
  return result.state === "allow" ? { ...result, origin: "yolo" } : result;
}
/**
 * Resolve the bash command-pattern decision for a (possibly chained) command.
 *
 * A bash invocation may be a shell program with several commands joined by
 * `&&`, `||`, `;`, `|`, `&`, or newlines. Matching the whole string against the
 * bash patterns lets a denied command ride through on an allowed leading one
 * (issue #301). Instead, the caller supplies the program's command units (from
 * the shared `BashProgram.commands()` parse) — including those nested inside
 * substitutions and subshells (#306); each is evaluated on the `bash` surface
 * and the most restrictive result wins (`deny > ask > allow`).
 *
 * The selected result carries the offending sub-command in `command`, its rule
 * in `matchedPattern`, and the offending command's execution context in
 * `commandContext` (set only for a nested command), so the prompt,
 * session-approval suggestion, and decision event scope to that command.
 *
 * A wrapper unit (flagged with a `wrapperKind` by the enumerator) hides or
 * indirects the command that should be gated, so an `allow` is floored up to a
 * synthetic `ask` — the `<opaque-bash-wrapper>` pattern for an inline-shell
 * payload (`bash -c`/`eval`, #481) or `<indirection-bash-wrapper>` for a
 * prefix/exec wrapper (`sudo`/`env`/`xargs`/`find -exec`/…, #490) — to keep it
 * from riding a permissive rule; an explicit `deny`/`ask` on the wrapper is left
 * untouched (`deny > ask > allow`).
 *
 * When `commands` is empty there are two cases. A trivially-empty command (an
 * empty, whitespace-only, or comment-only line) has genuinely nothing to gate,
 * so the whole `command` is resolved as before. A non-empty command that parsed
 * to zero command units (a parse anomaly or an opaque program) fails closed to
 * a synthetic `ask` so a permissive top-level `*` cannot silently allow an
 * unparseable command (e.g. `cd /repo && git push` riding a top-level allow on
 * the empty-parse path) — #452.
 *
 * Pure and synchronous: the (async, tree-sitter) parse happens once in the
 * handler, which passes the decomposed `commands` here.
 *
 * Under yolo the two synthesized `ask` paths below (the wrapper floor and the
 * unparseable-command sentinel) are bypassed; see
 * {@link ResolveBashCommandCheckOptions}.
 */
export function resolveBashCommandCheck(
  command: string,
  commands: BashCommand[],
  agentName: string | undefined,
  resolver: ScopedPermissionResolver,
  options: ResolveBashCommandCheckOptions = {},
): PermissionCheckResult {
  const yolo = options.yolo === true;
  const resolveWhole = () =>
    resolver.resolve({
      kind: "tool",
      surface: "bash",
      input: { command },
      agentName,
    });

  if (commands.length === 0) {
    if (isTriviallyEmptyCommand(command)) {
      return yolo ? tagYolo(resolveWhole()) : resolveWhole();
    }
    // yolo: the whole-string match is the best available `deny` check when
    // the command cannot be decomposed — never prompt.
    if (yolo) return tagYolo(resolveWhole());
    return {
      state: "ask",
      toolName: "bash",
      source: "bash",
      origin: "builtin",
      command,
      matchedPattern: "<unparseable-bash-command>",
    };
  }

  const results = commands.map((cmd) => {
    const base = resolver.resolve({
      kind: "tool",
      surface: "bash",
      input: { command: cmd.text },
      agentName,
    });
    const result =
      cmd.wrapperKind && base.state === "allow"
        ? yolo
          ? tagYolo(base)
          : {
              ...base,
              state: "ask" as const,
              matchedPattern: WRAPPER_SENTINEL[cmd.wrapperKind],
            }
        : base;
    return cmd.context ? { ...result, commandContext: cmd.context } : result;
  });
  return (
    pickMostRestrictive(results) ??
    resolver.resolve({
      kind: "tool",
      surface: "bash",
      input: { command },
      agentName,
    })
  );
}

/**
 * True when a command has genuinely nothing to gate: it is empty,
 * whitespace-only, or contains only comment lines (every non-blank line starts
 * with `#`). Such a command yields zero command units legitimately, so the
 * whole-string resolve is safe rather than a parse anomaly.
 */
function isTriviallyEmptyCommand(command: string): boolean {
  const lines = command
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.every((line) => line.startsWith("#"));
}
