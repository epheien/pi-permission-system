---
issue: 333
issue_title: "Permission prompt for chained bash commands only shows the triggering sub-command, hiding the rest of the chain from the user"
---

# Surface the full chained command in the bash permission prompt

## Problem Statement

When the model runs a chained bash command (e.g. `cd /var/www/html && rm -rf *`), the permission system splits the chain, picks the most restrictive sub-command (`rm -rf *`), and prompts the user about that sub-command alone.
The prompt reads `Current agent requested bash command 'rm -rf *'. Allow this command?` — with no hint that a `cd` into a critical path preceded it.
The user approves what looks like a harmless relative delete, not realising it wipes a web root.
The full original command is already passed into `formatAskPrompt` as the `input` argument, but the bash branch ignores it.

## Goals

- Append the full original command to the bash ask prompt when it differs from the matched sub-command, so the user sees the whole chain before approving.
- Suppress the suffix when the sub-command and full command are identical (no chain), keeping single-command prompts unchanged.
- Keep the change isolated to `formatAskPrompt`'s bash branch.

## Non-Goals

- No change to chain splitting, sub-command selection, or the "most restrictive" analysis (`evaluate-bash-command-chains` machinery is correct and stays as-is).
- No change to the MCP or generic-tool branches of `formatAskPrompt`.
- No change to the denial-message path (`denial-messages.ts`) — only the `ask` prompt is in scope.
- No new config field or schema change.

## Background

`formatAskPrompt` (`src/permission-prompts.ts`) builds the user-facing approval prompt.
Its signature already accepts `input?: unknown` (the raw tool input), used today only by the MCP and generic-tool branches via the `ToolPreviewFormatter`.
The bash branch reads `result.command` (the selected sub-command) and `result.matchedPattern`/`result.commandContext` (for the qualifier) but never reads `input`.

The call site in `src/handlers/gates/tool.ts` already forwards the raw input as `tcc.input`, so no wiring change is needed — the full command is reachable inside the bash branch right now.

`src/common.ts` already exports the two helpers the issue references:

- `toRecord(value: unknown): Record<string, unknown>` — coerces a non-object/array to `{}`.
- `getNonEmptyString(value: unknown): string | null` — returns a trimmed non-empty string or `null`.

Constraint from the package skill: default to least privilege and keep prompts reviewable.
Adding chain context strengthens the user's ability to make an informed `ask` decision, consistent with that priority.

## Design Overview

Inside the existing `if (result.toolName === "bash")` branch:

1. `subCommand` = `result.command ?? ""` (unchanged — the matched sub-command).
2. `fullCommand` = `getNonEmptyString(toRecord(input).command)` — the raw command string from the tool input, or `null`.
3. `fullCommandInfo` = `(full command: '<fullCommand>')` only when `fullCommand` is non-null **and** `fullCommand !== subCommand`; otherwise empty.
4. Return `${subject} requested bash command '${subCommand}'${qualifierInfo}${fullCommandInfo}. Allow this command?`.

Ordering: `qualifierInfo` (matched-pattern / nested-context note) stays immediately after the sub-command, and `fullCommandInfo` follows it, before the terminal `. Allow this command?`.

Edge cases:

- `input` is `undefined` (existing bash tests pass it as `undefined`) → `toRecord(undefined)` is `{}`, `fullCommand` is `null`, no suffix.
  Existing tests stay green.
- `input.command` equals the sub-command (single, non-chained command) → suffix suppressed.
- `input.command` is missing, empty, or non-string → `getNonEmptyString` returns `null`, no suffix.
- `input.command` differs from sub-command (real chain) → suffix appended with the full chain.

Resulting prompt for the issue's repro:

```text
Current agent requested bash command 'rm -rf .' (full command: 'echo "hello" && rm -rf .'). Allow this command?
```

No type or signature change — only the bash branch body changes.

## Module-Level Changes

- `src/permission-prompts.ts`
  - Add `import { getNonEmptyString, toRecord } from "./common";` (top-level import).
  - In the bash branch of `formatAskPrompt`, read the full command from `input` and append `fullCommandInfo` when it differs from the sub-command.
- `test/permission-prompts.test.ts`
  - Add tests covering: chain → suffix present; single command (input === sub-command) → no suffix; `input` undefined → no suffix; missing/empty `command` → no suffix.

No schema, config, README, `docs/configuration.md`, or architecture-doc changes — this is a behavior-preserving prompt-text fix with no new surface or field.

## Test Impact Analysis

This is a localized bug fix, not an extraction, so the extraction-specific analysis is light:

1. New tests enabled: the full-command-context behavior is newly testable purely at the `formatAskPrompt` unit level — no new seam is required because `input` is already a parameter.
2. Redundant tests: none.
   Existing bash tests pass `input` as `undefined`; they continue to assert the un-suffixed prompt and remain valid as the "no chain context" case.
3. Tests that must stay: all existing `formatAskPrompt` bash/MCP/tool tests stay as-is — they pin the surrounding branches and the qualifier ordering this change must not disturb.

## TDD Order

1. **Red → Green → Commit** — `test/permission-prompts.test.ts`, bash full-command context.
   - Red: add a test that a chained `input` (`{ command: 'echo "hello" && rm -rf .' }`) with `result.command = "rm -rf ."` produces a prompt containing `(full command: 'echo "hello" && rm -rf .')`.
   - Add companion tests: identical sub-command and full command → no `full command:` suffix; `input` `undefined` → no suffix; `input.command` missing/empty → no suffix; qualifier + full-command ordering (`'rm -rf .' (matched 'rm *') (full command: '...')`).
   - Green: implement the bash-branch change in `src/permission-prompts.ts` (import helpers, compute `fullCommandInfo`).
   - Commit: `fix: surface full chained command in bash permission prompt (#333)`.

The production change and its tests land in one cycle because the change is a single branch edit with no intermediate state.

## Risks and Mitigations

- **Risk:** appending the full command when no chain exists would make every single-command prompt noisier.
  **Mitigation:** the `fullCommand !== subCommand` guard suppresses the suffix for non-chained commands; a dedicated test pins this.
- **Risk:** a non-string or missing `input.command` could throw or print `undefined`.
  **Mitigation:** `toRecord` + `getNonEmptyString` normalise both cases to `null`; tests cover undefined and missing `command`.
- **Risk:** disturbing the qualifier ordering relied on by existing tests.
  **Mitigation:** `fullCommandInfo` is appended strictly after `qualifierInfo`; the existing nested-context test plus a new ordering test pin the layout.

## Open Questions

None.
The issue's proposed change is unambiguous and the helpers it references already exist.
