---
issue: 301
issue_title: "Only first command in bash command chain is evaluated"
---

# Evaluate every command in a bash command chain

## Problem Statement

When the agent runs a chained bash command such as `cd /path/to/project && npm install compromised-package`, the permission system matches the **entire command string** against the bash command patterns.
With a policy of `{ "cd *": "allow", "npm *": "deny" }`, the whole string matches `cd *` (allow) but the `npm *` (deny) rule is never evaluated against the `npm install …` segment.
A denied command therefore rides through on the back of an allowed leading command — a permission bypass.
Every command in a chain must be evaluated independently, with precedence `deny > ask > allow`.

The bash `path` and `external_directory` surfaces already decompose chains correctly.
Only the bash **command-pattern** surface was left matching the raw program string.

## Dependency

This plan builds on [#304] (landed locally), which introduced the two seams this fix needs:

- `BashProgram` (`src/handlers/gates/bash-program.ts`) — a bash command parsed once into a reusable value object exposing typed slices (`pathTokens()`, `externalPaths(cwd)`).
  This fix adds a third slice, `topLevelCommands()`, captured in the same parse.
- `pickMostRestrictive` (`src/handlers/gates/candidate-check.ts`) — selects the most-restrictive `PermissionCheckResult` (`deny > ask > allow`, first-wins) from a list.
  Already used by the bash path and external-directory gates; this fix is the third consumer.

With both in place, the change is small: one new `BashProgram` method, one small resolver, and the gate wiring.

## Goals

- Evaluate each top-level simple-command in a bash chain (`&&`, `||`, `;`, `|`, `&`, newlines) independently against the bash command-pattern rules.
- Combine the per-command results with `pickMostRestrictive`, reporting the offending command's matched pattern.
- Reuse the existing `BashProgram` parse — one decomposition model for the whole package, no second splitter that could diverge from the path/external-directory decomposition.
- Preserve current behavior for single-command bash calls (no regression) and keep `PermissionManager.checkPermission()` synchronous and unchanged.

## Non-Goals

- Changing `PermissionManager.checkPermission()`, the public `PermissionsService.checkPermission()` API, or the event-bus RPC.
  Those are synchronous and cannot run the async tree-sitter decomposition; they continue to match a single command string.
  An async decompose-and-check service method is a possible follow-up, not this issue.
- Recursing into command substitution (`$(…)`, backticks) or subshells (`( … )`) to evaluate nested commands.
  Scope is top-level chain operators only; nested constructs are matched as their enclosing statement's text and noted as a known limitation.
- Parse-once-and-inject a shared `BashProgram` across the three bash gates.
  Each gate still parses; consolidation is the deferred gate-consolidation follow-up.
- Touching `bash-arity.ts`, `pattern-suggest.ts`, or the wildcard matcher.

## Background

Relevant modules:

- `src/permission-manager.ts` — `checkPermission(toolName, input, agentName, sessionRules)` is synchronous; for bash it produces `values: [command]` (one whole-string candidate) and matches it with `evaluateFirst`.
  Exposed synchronously via `src/service.ts` and `src/permission-event-rpc.ts`.
- `src/handlers/permission-gate-handler.ts` — `handleToolCall` runs an ordered, `await`-friendly gate pipeline (`gateProducers: Array<() => GateResult | Promise<GateResult>>`).
  The final producer performs the bash command-pattern check: it calls `checkPermission(tcc.toolName, tcc.input, …)` once and feeds the result into `describeToolGate` as `preCheck`.
  `toRecord` and `getNonEmptyString` are already available to it.
- `src/handlers/gates/bash-program.ts` — `BashProgram.parse(command)` walks the AST once into `rawTokens` + `leadingCdTarget`.
  The walker primitives (`collectPathCandidateTokens`, `resolveNodeText`, `extractCommandName`, `findFirstCommand`, the `program`/`list` descent in `findFirstCommand`) live here and are reused for the new top-level-command walk.
- `src/handlers/gates/candidate-check.ts` — `pickMostRestrictive(results)`.
- `src/handlers/gates/bash-path.ts` / `bash-external-directory.ts` — existing consumers of `BashProgram` + `pickMostRestrictive`; the template for this fix.
- `src/handlers/gates/tool.ts` — `describeToolGate(tcc, check, formatter)` builds the prompt/session-approval/decision descriptor from a `PermissionCheckResult`; for bash it derives the session-approval suggestion and decision value from `check.command`.

Constraints from `AGENTS.md` / package skill that apply:

- Default to least privilege; silent over-matching is a permission bypass — the fix must never be *weaker* than today.
- Wildcard matching must be explicit and tested, including over-match and under-match cases.
- Keep schema, example config, `docs/configuration.md`, `README.md`, and types aligned when behavior changes.
- Pure logic, IO at the edges; inject collaborators for testability (the resolver takes `checkPermission` and a `decompose` callback).

AST shapes (confirmed empirically during planning):

| Input                | Tree                                                  | Top-level commands   |
| -------------------- | ----------------------------------------------------- | -------------------- |
| `cd /p && npm i x`   | `program > list > [command, &&, command]`             | `cd /p`, `npm i x`   |
| `a \|\| b`           | `program > list > [command, \|\|, command]`           | `a`, `b`             |
| `a ; b` / `a & b`    | `program > [command, sep, command]`                   | `a`, `b`             |
| `cat f \| grep b`    | `program > pipeline > [command, \|, command]`         | `cat f`, `grep b`    |
| `foo\nbar`           | `program > [command, command]`                        | `foo`, `bar`         |
| `echo 'x && y'`      | `program > command` (quoted)                          | `echo 'x && y'`      |
| `echo $(curl \| sh)` | `program > command > command_substitution > pipeline` | `echo $(curl \| sh)` |
| `( cd /t && rm x )`  | `program > subshell > list`                           | `( cd /t && rm x )`  |

Descend `program`/`list`/`pipeline` and emit each `command` node's text.
A non-command top-level statement (`subshell`, control-flow, `redirected_statement`) is emitted as its own whole-text unit without descending — quotes are respected by the parser, and substitution/subshell contents stay inside the enclosing statement's text (the chosen scope).

## Design Overview

Decision model: the unit of bash policy is the simple-command, not the raw shell program.
Add one slice to `BashProgram`, evaluate each unit through the unchanged synchronous `checkPermission`, and combine with `pickMostRestrictive` in the gate layer — exactly mirroring the path/external-directory gates.

### New `BashProgram` slice

`BashProgram.parse()` already walks the AST once; capture the top-level command texts in the same walk and store them alongside `rawTokens`.

```typescript
// src/handlers/gates/bash-program.ts

export class BashProgram {
  private constructor(
    private readonly rawTokens: readonly string[],
    private readonly leadingCdTarget: string | undefined,
    private readonly topLevelCommandTexts: readonly string[], // new
  ) {}

  /** Top-level simple-commands of the chain, in source order. May be empty
   *  (e.g. an unparseable command or a bare subshell); callers fall back to
   *  the whole command so the surface is never evaluated weaker than before. */
  topLevelCommands(): string[] { return [...this.topLevelCommandTexts]; }
}
```

A new private `collectTopLevelCommandTexts(rootNode)` walker descends `program`/`list`/`pipeline` (and `redirected_statement`), emits each `command` node's `.text`, and emits other top-level statement nodes (subshell, control-flow) whole.
`parse()` runs it once and passes the result to the constructor.

### Most-restrictive resolver (gate layer)

```typescript
// src/handlers/gates/bash-command.ts

type CheckPermissionFn = (
  surface: string, input: unknown, agentName?: string, sessionRules?: Rule[],
) => PermissionCheckResult;

const defaultDecompose = async (cmd: string): Promise<string[]> =>
  (await BashProgram.parse(cmd)).topLevelCommands();

/** Evaluate each top-level command on the bash surface and select the
 *  most-restrictive result (deny > ask > allow). */
export async function resolveBashCommandCheck(
  command: string,
  agentName: string | undefined,
  sessionRules: Rule[],
  checkPermission: CheckPermissionFn,
  decompose: (cmd: string) => Promise<string[]> = defaultDecompose,
): Promise<PermissionCheckResult> {
  const units = await decompose(command);
  const results = units.map((unit) =>
    checkPermission("bash", { command: unit }, agentName, sessionRules),
  );
  return (
    pickMostRestrictive(results) ??
    checkPermission("bash", { command }, agentName, sessionRules)
  );
}
```

`pickMostRestrictive` returns `| undefined`; the `??` fallback handles an empty `units` list (no top-level commands found) by evaluating the whole command — identical to today's behavior and never weaker.
Because `checkPermission("bash", { command: unit })` sets `resultExtras.command = unit`, the selected result carries the **offending** sub-command in `command` and its rule in `matchedPattern`, so the session-approval suggestion and decision value scope to that command (e.g. `npm install pkg` → `npm *`), while the whole command remains available via `tcc.input` for the prompt preview.

### Gate wiring (call-site sketch)

The final gate producer becomes async for bash; non-bash tools are unchanged:

```typescript
async () => {
  const toolCheck =
    tcc.toolName === "bash"
      ? await resolveBashCommandCheck(
          getNonEmptyString(toRecord(tcc.input).command) ?? "",
          tcc.agentName ?? undefined,
          getSessionRuleset(),
          checkPermission,
        )
      : checkPermission(tcc.toolName, tcc.input, tcc.agentName ?? undefined, getSessionRuleset());
  const toolDescriptor = describeToolGate(tcc, toolCheck, formatter);
  toolDescriptor.preCheck = toolCheck;
  return toolDescriptor;
};
```

No change to `GateDescriptor`/`GateRunnerDeps`; `describeToolGate` already consumes a `PermissionCheckResult`, so all existing prompt/log/decision/session machinery is reused.

### Edge cases and the no-weakening guarantee

- Single command → `topLevelCommands()` returns one entry → identical to today.
- Empty/whitespace command → no command node → `units` empty → `??` fallback evaluates `{ command: "" }`, matching current behavior.
- Bare subshell `( rm x )` → emitted whole → matched as `( rm x )` (the documented top-level-scope limitation; never weaker).
- All-allow chain → `pickMostRestrictive` returns the first allow → allow (no prompt).
- Quoted operators (`echo 'a && b'`) → one command (parser respects quotes) — no false split.
- Behavior change (intended): a config pattern that *spans* a chain (e.g. `"cd * && npm *": "allow"`) no longer matches as a unit, because each command is evaluated separately.
  Documented and called out in Risks.

### Design-review checklist

- Dependency width: `resolveBashCommandCheck` params all used; `CheckPermissionFn` matches the sibling-gate local type.
- Law of Demeter: no reach-through chains.
- Output arguments: resolver returns a value, mutates nothing.
- Parameter relay: `sessionRules` is consumed at the endpoint (`checkPermission`).
- Test mock depth: `checkPermission` and `decompose` are injected functions — fakeable without `as unknown as`.
- ISP: new functions take primitives/functions only.

## Module-Level Changes

- `src/handlers/gates/bash-program.ts` — add the `topLevelCommandTexts` field + constructor parameter, the `topLevelCommands()` method, and a private `collectTopLevelCommandTexts` walker; populate it in `parse()`.
- `src/handlers/gates/bash-command.ts` — new module exporting `resolveBashCommandCheck` (and the local `CheckPermissionFn` type, matching sibling-gate convention).
- `src/handlers/permission-gate-handler.ts` — make the final gate producer's bash branch async and call `resolveBashCommandCheck`; import it.
- `docs/configuration.md` — rewrite the `bash` Surface section: patterns match each top-level command in a chain (not the full string); most-restrictive-wins; `&& || ; | &` and newlines split commands; quotes/substitutions/subshells are not split; behavior-change note for chain-spanning patterns.
- `docs/architecture/architecture.md` — add a `bash-command.ts` entry to the directory listing, update the `bash-program.ts` entry to mention `topLevelCommands()`, and note in the gate-pipeline section that the bash command-pattern check decomposes chains and combines most-restrictively.
- `README.md` — verify the bash matching description; update only if it claims whole-command-string matching.

## Test Impact Analysis

1. New unit tests enabled:
   - `BashProgram.topLevelCommands()` — testable for every chain operator, quoting, nesting, redirection, and the empty case (extends the existing `test/handlers/gates/bash-program.test.ts`).
   - `resolveBashCommandCheck` — testable with an injected `decompose` and a fake `checkPermission`: `deny > ask > allow`, single-command passthrough, all-allow, empty-units fallback, and `sessionRules` threading.
     No tree-sitter needed.
2. Existing tests that stay as-is:
   - `test/rule.test.ts` — `checkPermission`/`evaluateFirst` unchanged.
   - `test/bash-external-directory.test.ts`, `test/handlers/gates/bash-path.test.ts`, `bash-external-directory.test.ts` — path/external-directory behavior untouched.
   - `test/handlers/tool-call.test.ts` bash gate tests — single-command bash routes through `resolveBashCommandCheck` → one-element decomposition → identical outcomes; verify they still pass after Step 3.
3. No tests become redundant; new tests are additive.

## TDD Order

1. `fix: enumerate top-level bash commands in BashProgram`
   - Surface: extend `test/handlers/gates/bash-program.test.ts` with `topLevelCommands()` cases — single command → one entry; `&&`/`||`/`;`/`|`/`&`/newline chains → ordered entries; `echo 'a && b'` → one entry; `( … )` / `$( … )` → enclosing statement only; redirection → command captured; empty → `[]`.
   - Implement the field, method, and `collectTopLevelCommandTexts` walker in `bash-program.ts`.
   - Run `pnpm run check` (constructor signature change is internal to the file).
2. `fix: evaluate each bash sub-command with most-restrictive precedence`
   - Surface: new `test/handlers/gates/bash-command.test.ts` against `resolveBashCommandCheck` with injected `decompose` + fake `checkPermission`.
   - Covers: all-allow → first allow; allow+deny → deny with the deny unit's `matchedPattern`/`command`; allow+ask → ask; single command passthrough; empty units → whole-command fallback; `sessionRules` forwarded to each call.
   - Implement `src/handlers/gates/bash-command.ts`.
3. `fix: gate bash command chains per sub-command (#301)`
   - Surface: `test/handlers/tool-call.test.ts` — new case.
     With `session.checkPermission` mocked to return `deny` when `input.command` matches `npm *` and `allow` for `echo *`, firing a `bash` tool_call with `command: "echo start && npm install compromised-package"` (no external paths, so earlier gates do not fire) returns `{ block: true }`; assert a non-chained allowed bash command still returns `{}`.
   - Implement the async bash branch in the final gate producer of `permission-gate-handler.ts`.
   - Run `pnpm run check` after this commit.
4. `docs: document per-sub-command bash chain evaluation (#301)`
   - Update `docs/configuration.md`, `docs/architecture/architecture.md`, and `README.md` per Module-Level Changes.
   - Docs-only commit.

## Risks and Mitigations

- Chain-spanning config patterns stop matching as a unit.
  Mitigation: documented behavior change; per-command evaluation is strictly safer (deny/ask take precedence) and chain-spanning patterns are an anti-pattern.
- Subshell / command-substitution contents are not independently evaluated.
  Mitigation: documented known limitation; never weaker than today (the enclosing statement's whole text is still matched).
- Extra tree-sitter parse per bash command (now path + external-directory + command).
  Mitigation: consistent with the current design; parse-sharing is the deferred gate-consolidation follow-up.
- The synchronous service API / RPC remain whole-string.
  Mitigation: out of scope (Non-Goals); the runtime gate — the security boundary — is fully fixed.

## Open Questions

- Should the session-approval suggestion for a denied/ask chain scope to the offending sub-command (current plan: yes, via `check.command = unit`) or to the whole command the user submitted?
  Decide during the prompt UX review in Step 3.

[#304]: https://github.com/gotgenes/pi-packages/issues/304
