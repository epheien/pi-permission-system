import type { TSNode } from "#src/access-intent/bash/parser";
import type { BashCommandContext } from "#src/types";

// ── Command type ─────────────────────────────────────────────────────────────

/**
 * One command-pattern unit of a parsed bash program.
 *
 * Minimal by design — `text` is the simple-command (or whole compound
 * statement) string matched against the bash rules.
 * The type is the stable extension point: #306 adds an execution `context`,
 * #307 adds per-command path candidates and an effective working directory.
 */
/**
 * Why a command unit's decision is floored to at least `ask`.
 * `"opaque-payload"` — an inline-shell payload (`bash -c`/`eval`) whose inner
 * program is not re-parsed (#481).
 * `"indirection"` — a prefix/exec wrapper (`sudo`/`env`/`xargs`/`find -exec`/…)
 * whose inner command is a visible argument but is not gated on its own (#490).
 * The kind selects the audit sentinel; both floor identically.
 */
export type WrapperKind = "opaque-payload" | "indirection";

export interface BashCommand {
  readonly text: string;
  /**
   * Execution context for a nested command (substitution or subshell); absent
   * for a current-shell (top-level) command.
   */
  readonly context?: BashCommandContext;
  /**
   * Set when this unit is a floored indirection wrapper; its decision is floored
   * to at least `ask` so the wrapped command cannot ride a permissive `allow`.
   * Absent for an ordinary command.
   */
  readonly wrapperKind?: WrapperKind;
}

// ── Command enumeration ──────────────────────────────────────────────────────

/**
 * Container node types descended into when enumerating command units.
 */
const COMMAND_ENUM_DESCEND = new Set([
  "program",
  "list",
  "pipeline",
  "redirected_statement",
]);

/**
 * Named node types skipped during command enumeration: redirect targets,
 * comments, and heredoc bodies — none is a command to evaluate.
 * Anonymous tokens (chain operators `&&`/`;`/`|`, substitution and subshell
 * delimiters `$(`/`)`/`` ` ``/`(`) are filtered by the `isNamed` guard, not
 * listed here.
 */
const COMMAND_ENUM_SKIP = new Set([
  "file_redirect",
  "heredoc_redirect",
  "herestring_redirect",
  "comment",
  "heredoc_body",
  "heredoc_end",
]);

/**
 * Nested execution contexts whose interior commands really execute and must be
 * evaluated too: command substitution (`$(…)`, backticks) and process
 * substitution (`<(…)`/`>(…)`).
 * Subshells (`( … )`) are handled separately because they are also emitted
 * whole.
 */
const NESTED_EXECUTION_CONTEXTS = new Map<string, BashCommandContext>([
  ["command_substitution", "command_substitution"],
  ["process_substitution", "process_substitution"],
]);

/**
 * Enumerate the command units of a bash program, in source order.
 *
 * Descends container nodes (`program`, `list`, `pipeline`,
 * `redirected_statement`) and emits each `command` node whole.
 * Additionally descends into the three nested execution contexts — command
 * substitution (`$(…)`, backticks), process substitution (`<(…)`/`>(…)`), and
 * subshells (`( … )`) — emitting each inner command as its own unit *in
 * addition to* the enclosing command, since those inner commands really execute
 * (#306).
 * Control-flow bodies and `{ … }` brace groups are emitted whole without
 * descending (deferred).
 *
 * The enclosing command/subshell is always still emitted whole, so adding the
 * nested units can only ever produce a more-restrictive decision, never weaker.
 *
 * Each emitted command unit has any leading `variable_assignment` prefix
 * stripped (so an env-var prefix cannot defeat a command-pattern rule), and a
 * wrapper unit (`bash -c`/`eval`, or an indirection wrapper such as `sudo`) is
 * tagged with a {@link WrapperKind} so its decision is later floored to `ask`.
 */
export function collectCommands(node: TSNode): BashCommand[] {
  const out: BashCommand[] = [];
  collectCommandsInto(node, undefined, out);
  return out;
}

function collectCommandsInto(
  node: TSNode,
  context: BashCommandContext | undefined,
  out: BashCommand[],
): void {
  // Anonymous tokens (operators `&&`/`;`/`|`, delimiters `$(`/`)`/`` ` ``/`(`)
  // carry no command.
  if (!node.isNamed) return;
  if (COMMAND_ENUM_SKIP.has(node.type)) return;

  if (node.type === "command") {
    out.push(
      makeUnit(commandUnitText(node), context, classifyWrapperCommand(node)),
    );
    // A command's text already contains any substitution; descend its subtree
    // to ALSO emit the inner commands of command/process substitutions.
    collectSubstitutionCommands(node, out);
    return;
  }

  if (node.type === "subshell") {
    out.push(makeUnit(node.text, context)); // never-weaker whole emit
    descendCommandChildren(node, "subshell", out);
    return;
  }

  if (COMMAND_ENUM_DESCEND.has(node.type)) {
    descendCommandChildren(node, context, out);
    return;
  }

  // Any other named statement (compound_statement `{ … }`, if/while/for/case,
  // function_definition): emit whole, do not descend — deferred (#306).
  out.push(makeUnit(node.text, context));
}

function makeUnit(
  text: string,
  context: BashCommandContext | undefined,
  wrapperKind?: WrapperKind,
): BashCommand {
  const unit: BashCommand = context ? { text, context } : { text };
  return wrapperKind ? { ...unit, wrapperKind } : unit;
}

/**
 * Shell command names whose `-c` flag introduces an opaque inline program.
 */
const SHELL_WRAPPER_NAMES = new Set(["bash", "sh", "dash", "zsh", "ksh"]);

/**
 * Indirection wrappers that always invoke a following command, so the wrapper
 * (not the inner command) is what a bash rule matches. Floored by command-name
 * basename alone. Extend this set to cover another always-invoking wrapper.
 */
const INDIRECTION_WRAPPER_NAMES = new Set([
  "sudo",
  "env",
  "xargs",
  "time",
  "nohup",
  "timeout",
  "nice",
  // Exec-capable rewrites and prefix wrappers surveyed in #575: parallelizers
  // (parallel/rust-parallel/rush), a sudo rewrite (doas), and prefix wrappers
  // (setsid/stdbuf/watch/flock) that all always invoke a following command.
  "parallel",
  "rust-parallel",
  "rush",
  "doas",
  "setsid",
  "stdbuf",
  "watch",
  "flock",
]);

/**
 * Search tools that invoke a command per result only when an exec flag is
 * present; a bare search runs no subcommand. Floored only when an argument
 * exactly matches one of the tool's exec flags. Extend by adding a tool with
 * its exec-flag set.
 */
const EXEC_CONDITIONAL_WRAPPERS = new Map<string, ReadonlySet<string>>([
  ["find", new Set(["-exec", "-execdir", "-ok", "-okdir"])],
  ["fd", new Set(["-x", "--exec", "-X", "--exec-batch"])],
]);

/**
 * Classify a `command` node as a floored wrapper, or `undefined` for an
 * ordinary command. Reads only the node's own named children (a shallow walk),
 * skipping any leading `variable_assignment` prefix, and matches the command
 * name on its basename (so `/bin/bash -c …` counts).
 *
 * `"opaque-payload"`: `eval`, or a shell (`bash`/`sh`/`dash`/`zsh`/`ksh`) with a
 * `-c` short-flag cluster (`-c`, `-ec`, `-xc`) — the inner program is a quoted
 * argument the enumerator does not re-parse (#481).
 *
 * `"indirection"`: an always-invoking prefix/exec wrapper
 * (`INDIRECTION_WRAPPER_NAMES`), or a search tool (`EXEC_CONDITIONAL_WRAPPERS`,
 * `find`/`fd`) carrying a per-result exec flag — the inner command is a visible
 * argument that a `<cmd> *` rule would otherwise never match (#490). A bare
 * `find`/`fd` search runs no subcommand and is not flagged.
 */
function classifyWrapperCommand(node: TSNode): WrapperKind | undefined {
  const { commandName, args } = readWrapperCommand(node);
  if (commandName === undefined) return undefined;
  if (commandName === "eval") return "opaque-payload";
  if (SHELL_WRAPPER_NAMES.has(commandName) && hasShortFlagC(args)) {
    return "opaque-payload";
  }
  if (INDIRECTION_WRAPPER_NAMES.has(commandName)) return "indirection";
  const execFlags = EXEC_CONDITIONAL_WRAPPERS.get(commandName);
  if (execFlags && args.some((arg) => execFlags.has(arg))) return "indirection";
  return undefined;
}

/**
 * A `command` node's name basename and its argument texts, skipping any leading
 * `variable_assignment` prefix (matching `commandUnitText`). `commandName` is
 * `undefined` for a pure assignment with no `command_name`.
 */
function readWrapperCommand(node: TSNode): {
  commandName: string | undefined;
  args: string[];
} {
  let commandName: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child?.isNamed) continue;
    if (child.type === "variable_assignment") continue;
    if (commandName === undefined) {
      commandName = basename(child.text);
      continue;
    }
    args.push(child.text);
  }
  return { commandName, args };
}

/**
 * True when an argument list has a short-flag cluster containing `c` before any
 * `--` end-of-options marker (`-c`, `-ec`, `-xc`) — the inline-shell payload
 * flag for `bash`/`sh`/`dash`/`zsh`/`ksh`.
 */
function hasShortFlagC(args: string[]): boolean {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg.startsWith("-") && !arg.startsWith("--") && arg.includes("c")) {
      return true;
    }
  }
  return false;
}

/** The final path segment of a command name (`/bin/bash` → `bash`). */
function basename(name: string): string {
  const slash = name.lastIndexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

/**
 * The command-pattern text of a `command` node, with any leading
 * `variable_assignment` prefix stripped.
 *
 * An env-var prefix (`AWS_PROFILE=prod aws …`, `PGPASSWORD=…`) is part of the
 * `command` node's text but must not defeat a rule that gates the underlying
 * command, so matching targets the text from the first non-assignment child
 * (the `command_name`) onward, sliced verbatim to preserve spacing. A pure
 * assignment (`FOO=bar`, no `command_name`) runs no command and is returned
 * unchanged.
 */
function commandUnitText(node: TSNode): string {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.isNamed && child.type !== "variable_assignment") {
      return node.text.slice(child.startIndex - node.startIndex);
    }
  }
  return node.text;
}

function descendCommandChildren(
  node: TSNode,
  context: BashCommandContext | undefined,
  out: BashCommand[],
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) collectCommandsInto(child, context, out);
  }
}

/**
 * Search a command's subtree for command/process substitutions and enumerate
 * the commands inside them, tagged with the substitution's execution context.
 * A substitution can nest under `command_name` (when the whole command is
 * `$(…)`) or under an argument, so the entire subtree is searched.
 */
function collectSubstitutionCommands(node: TSNode, out: BashCommand[]): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const nestedContext = NESTED_EXECUTION_CONTEXTS.get(child.type);
    if (nestedContext) {
      descendCommandChildren(child, nestedContext, out);
    } else {
      collectSubstitutionCommands(child, out);
    }
  }
}
