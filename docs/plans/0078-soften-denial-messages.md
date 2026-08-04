---
issue: 78
issue_title: Change denied tool message
---

# Soften denial messages

## Problem Statement

When a tool call is denied, the extension appends a "Hard stop" suffix to the denial reason returned to the agent:

> Hard stop: this permission denial is policy-enforced.
> Do not retry or investigate bypasses; report the block to the user.

This causes two problems:

1. The aggressive language makes the LLM interpret the denial as a blanket ban on *all* similar operations (e.g., all writes), not just the specific call that was denied.
2. No denial message identifies `pi-permission-system` as the extension making the decision — the agent has no way to know where the policy lives or which extension blocked it.

Both problems trace to a structural issue: denial message text is scattered across 6 gate files and 2 shared hint functions, with no single point of control.

## Goals

- Centralize all denial message formatting into a single "sink" module so message text, tone, and attribution are controlled in one place.
- Attribute every denial to `pi-permission-system` so the agent knows which extension is gatekeeping.
- Remove all "Hard stop" / "Do not retry" behavioral instructions.
- Replace with informative, scoped messages that describe *what* was denied, *who* denied it (policy rule vs. user at prompt), and *why* (including any user-supplied reason), without prescribing what the agent should do next.

## Non-Goals

- Making the denial message text user-configurable (possible follow-up).
- Changing `applyPermissionGate` — it stays unchanged; the runner constructs the `messages` it needs from the new formatter.
- Changing the "ask" prompt wording (messages shown to the *user* when asking for approval).
- Moving `formatAskPrompt` / `formatSkillAskPrompt` / `formatMissingToolNameReason` / `formatUnknownToolReason` — these are prompt or pre-check messages, not denial messages.

## Background

### Current architecture (formatting pushed upstream)

Each of the 6 gate functions pre-formats three message strings (`denyReason`, `unavailableReason`, `userDeniedReason`) and embeds them in the `GateDescriptor.messages` object.
The runner passes those strings to `applyPermissionGate`, which returns the appropriate one as the block reason.
Neither the runner nor `applyPermissionGate` has any control over message content — they are dumb pass-throughs.

```text
Gate (6 files)         Descriptor          Runner           applyPermissionGate
──────────────         ──────────          ──────           ───────────────────
Pre-formats 3    →     Carries pre-   →    Passes to   →    Returns pre-formatted
message strings        formatted strings   gate function     string as block reason
```

This is why:

- The "Hard stop" text ended up duplicated in 5 places (2 functions + 3 inline strings).
- No gate thought to mention `pi-permission-system` — each composes its own text independently.
- Changing tone or attribution requires editing every gate.

### Denial message sources (current)

| Source                                    | File                                                | What it formats                       |
| ----------------------------------------- | --------------------------------------------------- | ------------------------------------- |
| `formatPermissionHardStopHint`            | `src/permission-prompts.ts`                         | Tool/bash/MCP "Hard stop" suffix      |
| `formatDenyReason`                        | `src/permission-prompts.ts`                         | Tool/bash/MCP policy deny             |
| `formatUserDeniedReason`                  | `src/permission-prompts.ts`                         | Tool/bash/MCP user deny               |
| `formatExternalDirectoryHardStopHint`     | `src/handlers/gates/external-directory-messages.ts` | External-directory "Hard stop" suffix |
| `formatExternalDirectoryDenyReason`       | `src/handlers/gates/external-directory-messages.ts` | External-directory policy deny        |
| `formatExternalDirectoryUserDeniedReason` | `src/handlers/gates/external-directory-messages.ts` | External-directory user deny          |
| `formatBashExternalDirectoryDenyReason`   | `src/handlers/gates/external-directory-messages.ts` | Bash external-directory policy deny   |
| `formatPathDenyReason`                    | `src/handlers/gates/path.ts`                        | Path policy deny                      |
| Inline in `path.ts`                       | `src/handlers/gates/path.ts`                        | Path user deny                        |
| Inline in `bash-path.ts`                  | `src/handlers/gates/bash-path.ts`                   | Bash-path user deny                   |
| Inline in `bash-external-directory.ts`    | `src/handlers/gates/bash-external-directory.ts`     | Bash external-directory user deny     |
| Inline in `skill-read.ts`                 | `src/handlers/gates/skill-read.ts`                  | Skill-read user deny                  |

### Relevant AGENTS.md constraints

- Keep scope tight; prefer small, reversible changes.
- Prefer explicit configuration over hidden behavior.
- Keep modules focused and composable (one concern per file).

## Design Overview

### Target architecture (formatting at the sink)

```text
Gate (6 files)         Descriptor             Runner (the sink)
──────────────         ──────────             ─────────────────
Builds structured  →   Carries               Calls formatDenialMessage()
DenialContext           DenialContext     →    to produce messages, then
(no message text)       (no messages)         passes them to applyPermissionGate
```

Gates provide *what happened* as structured data.
The runner — the single point where block reasons are finalized — constructs the `messages` object by calling a centralized formatter.
`applyPermissionGate` stays unchanged; it still receives `messages` as before.

### `DenialContext` discriminated union

Each gate surface carries the minimum fields the formatter needs:

```typescript
type DenialContext =
  | {
      kind: "tool";
      check: PermissionCheckResult;
      agentName?: string;
      input?: unknown;
    }
  | {
      kind: "path";
      toolName: string;
      pathValue: string;
      agentName?: string;
    }
  | {
      kind: "external_directory";
      toolName: string;
      pathValue: string;
      cwd: string;
      agentName?: string;
    }
  | {
      kind: "bash_external_directory";
      command: string;
      externalPaths: string[];
      cwd: string;
      agentName?: string;
    }
  | {
      kind: "bash_path";
      command: string;
      pathValue: string;
      agentName?: string;
    }
  | {
      kind: "skill_read";
      skillName: string;
      readPath: string;
      agentName?: string;
    };
```

### Centralized formatter

A single module (`src/denial-messages.ts`) exports three functions:

```typescript
export const EXTENSION_TAG = "[pi-permission-system]";

export function formatDenyReason(ctx: DenialContext): string;
export function formatUnavailableReason(ctx: DenialContext): string;
export function formatUserDeniedReason(ctx: DenialContext, denialReason?: string): string;
```

Each function switches on `ctx.kind` to produce surface-specific text and appends `EXTENSION_TAG`.
All denial message text lives in this one file.

Example outputs:

```text
Agent 'builder' is not permitted to run 'write' (matched 'write'). [pi-permission-system]
User denied tool 'write'. Reason: too risky. [pi-permission-system]
User denied access to path '/etc/passwd'. [pi-permission-system]
Current agent is not permitted to access path '/etc/passwd' via tool 'read'. [pi-permission-system]
```

### Runner as the glue

In `runGateCheck`, after resolving the permission state and before calling `applyPermissionGate`, the runner constructs the `messages` object:

```typescript
const messages = {
  denyReason: formatDenyReason(descriptor.denialContext),
  unavailableReason: formatUnavailableReason(descriptor.denialContext),
  userDeniedReason: (decision) =>
    formatUserDeniedReason(descriptor.denialContext, decision.denialReason),
};
```

`applyPermissionGate` and `PermissionGateParams.messages` are unchanged.

### Lift-and-shift migration

To avoid a big-bang rewrite, the migration is incremental:

1. Add `denialContext` as an **optional** field on `GateDescriptor` alongside `messages`.
2. Update the runner to construct `messages` from `denialContext` when present, falling back to `descriptor.messages` when not.
3. Migrate each gate to provide `denialContext` instead of `messages`, one family at a time.
4. Once all gates use `denialContext`, make it required and remove `messages` from `GateDescriptor`.

### Result shape

`GateOutcome` (returned by the runner to the orchestrator) is unchanged: `{ action: "block"; reason: string }`.
`PermissionGateParams` and `applyPermissionGate` are unchanged.
The `GateDescriptor.messages` field is replaced by `denialContext` — this is the only interface change.

## Module-Level Changes

### `src/denial-messages.ts` (NEW)

- **Add** `DenialContext` discriminated union type.
- **Add** `EXTENSION_TAG` constant.
- **Add** `formatDenyReason(ctx)`, `formatUnavailableReason(ctx)`, `formatUserDeniedReason(ctx, denialReason?)`.
- All denial message text for all 6 surfaces lives here.

### `src/handlers/gates/descriptor.ts`

- **Add** `denialContext: DenialContext` to `GateDescriptor` (optional during migration, required at end).
- **Remove** `messages` from `GateDescriptor` (final step).

### `src/handlers/gates/runner.ts`

- **Add** import of formatter functions from `../../denial-messages`.
- **Add** `messages` construction from `descriptor.denialContext` before passing to `applyPermissionGate`.
- **Remove** usage of `descriptor.messages` (final step).

### `src/handlers/gates/tool.ts`

- **Replace** `messages` construction with `denialContext: { kind: "tool", check, agentName, input }`.
- **Remove** imports of `formatDenyReason`, `formatUserDeniedReason` from `../../permission-prompts`.

### `src/handlers/gates/path.ts`

- **Replace** `messages` construction with `denialContext: { kind: "path", toolName, pathValue, agentName }`.
- **Remove** `formatPathDenyReason` export (absorbed into `denial-messages.ts`).

### `src/handlers/gates/bash-path.ts`

- **Replace** `messages` construction with `denialContext: { kind: "bash_path", command, pathValue: worstToken, agentName }`.
- **Remove** import of `formatPathDenyReason` from `./path`.

### `src/handlers/gates/external-directory.ts`

- **Replace** `messages` construction with `denialContext: { kind: "external_directory", toolName, pathValue, cwd, agentName }`.
- **Remove** imports of `formatExternalDirectoryDenyReason`, `formatExternalDirectoryUserDeniedReason` from `./external-directory-messages`.

### `src/handlers/gates/bash-external-directory.ts`

- **Replace** `messages` construction with `denialContext: { kind: "bash_external_directory", command, externalPaths, cwd, agentName }`.
- **Remove** imports of `formatBashExternalDirectoryDenyReason`, `formatExternalDirectoryHardStopHint` from `./external-directory-messages`.

### `src/handlers/gates/skill-read.ts`

- **Replace** `messages` construction with `denialContext: { kind: "skill_read", skillName, readPath, agentName }`.
- **Remove** imports of `formatSkillPathDenyReason` from `../../permission-prompts`.

### `src/handlers/gates/external-directory-messages.ts`

- **Delete** entire file (all functions absorbed into `denial-messages.ts`).

### `src/permission-prompts.ts`

- **Remove** `formatPermissionHardStopHint` (deleted).
- **Remove** `formatDenyReason` (moved to `denial-messages.ts`).
- **Remove** `formatUserDeniedReason` (moved to `denial-messages.ts`).
- **Remove** `formatSkillPathDenyReason` (moved to `denial-messages.ts`).
- **Keep** `formatMissingToolNameReason`, `formatUnknownToolReason` (pre-check messages, not denial messages).
- **Keep** `formatAskPrompt`, `formatSkillAskPrompt`, `formatSkillPathAskPrompt` (user-facing prompts, not denial messages).

### `src/permission-gate.ts`

- **No change.**

### Removed-symbol audit

Symbols removed from public module exports:

- `formatPermissionHardStopHint` — internal to `permission-prompts.ts`, imported in `tests/permission-prompts.test.ts`.
- `formatDenyReason` — imported in `src/handlers/gates/tool.ts`, `tests/permission-prompts.test.ts`.
- `formatUserDeniedReason` — imported in `src/handlers/gates/tool.ts`, `tests/permission-prompts.test.ts`.
- `formatSkillPathDenyReason` — imported in `src/handlers/gates/skill-read.ts`, `tests/permission-prompts.test.ts`.
- `formatPathDenyReason` — imported in `src/handlers/gates/bash-path.ts`, `tests/handlers/gates/path.test.ts` (if it exists).
- `formatExternalDirectoryHardStopHint` — imported in `src/handlers/gates/bash-external-directory.ts`, `tests/handlers/external-directory-integration.test.ts`, `tests/handlers/gates/external-directory-messages.test.ts`.
- `formatExternalDirectoryDenyReason` — imported in `src/handlers/gates/external-directory.ts`, `tests/handlers/external-directory-integration.test.ts`, `tests/handlers/gates/external-directory-messages.test.ts`.
- `formatExternalDirectoryUserDeniedReason` — imported in `src/handlers/gates/external-directory.ts`, `tests/handlers/gates/external-directory-messages.test.ts`.
- `formatBashExternalDirectoryDenyReason` — imported in `src/handlers/gates/bash-external-directory.ts`, `tests/handlers/gates/external-directory-messages.test.ts`.
- `formatBashExternalDirectoryAskPrompt` — imported in `src/handlers/gates/bash-external-directory.ts`, `tests/handlers/gates/external-directory-messages.test.ts`.
  **Note:** this is an ask-prompt function, not a denial message.
  Move to `permission-prompts.ts` (or keep in a reduced `external-directory-messages.ts`) rather than deleting.
- `formatExternalDirectoryAskPrompt` — imported in `src/handlers/gates/external-directory.ts`, `tests/handlers/gates/external-directory-messages.test.ts`.
  Same treatment as above — ask-prompt, not denial message.

All import sites are covered in the gate migration steps.

## Test Impact Analysis

### New tests

1. `tests/denial-messages.test.ts` (NEW) — comprehensive tests for `formatDenyReason`, `formatUnavailableReason`, `formatUserDeniedReason` across all 6 `DenialContext` kinds.
   Every test asserts the presence of `[pi-permission-system]` and the absence of "Hard stop".
   This single test file replaces denial-message assertions currently spread across 4 test files.

### Tests that must change

1. `tests/permission-prompts.test.ts` — remove tests for `formatPermissionHardStopHint`, `formatDenyReason`, `formatUserDeniedReason`, `formatSkillPathDenyReason` (moved to `denial-messages.test.ts`).
   Keep tests for `formatAskPrompt`, `formatSkillAskPrompt`, `formatMissingToolNameReason`, `formatUnknownToolReason`.
2. `tests/handlers/gates/external-directory-messages.test.ts` — delete or reduce to only ask-prompt tests (if ask-prompt functions remain in this file).
3. `tests/handlers/external-directory-integration.test.ts` — replace `toContain("Hard stop")` with `toContain("[pi-permission-system]")`.
   Remove import of `formatExternalDirectoryHardStopHint`.
4. `tests/bash-external-directory.test.ts` — replace `toContain("Hard stop")` with `toContain("[pi-permission-system]")`.
5. Gate test files that construct mock `GateDescriptor` objects with `messages` — update to use `denialContext` instead.

### Tests that stay as-is

- Tests for `applyPermissionGate` (interface unchanged).
- Tests for permission resolution, wildcard matching, session rules — unrelated to message formatting.
- Tests for ask-prompt formatting functions.

## TDD Order

1. **Red → Green:** Create `src/denial-messages.ts` with `DenialContext` type, `EXTENSION_TAG`, and the three formatter functions covering all 6 context kinds.
   Create `tests/denial-messages.test.ts` with comprehensive tests asserting correct output for each kind, presence of `[pi-permission-system]`, and absence of "Hard stop".
   Commit: `feat: add centralized denial message formatter (#78)`
2. **Red → Green:** Add optional `denialContext` to `GateDescriptor`.
   Update `runGateCheck` to construct `messages` from `denialContext` when present, falling back to `descriptor.messages`.
   Add runner tests verifying the formatter path.
   Commit: `refactor: wire runner to construct messages from denialContext (#78)`
3. **Red → Green:** Migrate tool gate and path gate to `denialContext`.
   Remove `formatDenyReason`, `formatUserDeniedReason`, `formatPermissionHardStopHint` from `permission-prompts.ts`.
   Remove `formatPathDenyReason` from `path.ts`.
   Update `tests/permission-prompts.test.ts` to remove migrated tests.
   Commit: `refactor: migrate tool and path gates to denialContext (#78)`
4. **Red → Green:** Migrate external-directory gate and bash-external-directory gate to `denialContext`.
   Move ask-prompt functions (`formatExternalDirectoryAskPrompt`, `formatBashExternalDirectoryAskPrompt`) to `permission-prompts.ts`.
   Delete `external-directory-messages.ts`.
   Update `tests/handlers/gates/external-directory-messages.test.ts` and `tests/handlers/external-directory-integration.test.ts`.
   Commit: `refactor: migrate external-directory gates to denialContext (#78)`
5. **Red → Green:** Migrate bash-path gate and skill-read gate to `denialContext`.
   Remove `formatSkillPathDenyReason` from `permission-prompts.ts`.
   Update `tests/bash-external-directory.test.ts`.
   Commit: `refactor: migrate bash-path and skill-read gates to denialContext (#78)`
6. **Red → Green:** Make `denialContext` required on `GateDescriptor`, remove `messages`.
   Remove the fallback path in the runner.
   Update any remaining test fixtures constructing descriptors with `messages`.
   Run `pnpm run check` to verify no type errors remain.
   Commit: `refactor!: remove messages from GateDescriptor (#78)`

## Risks and Mitigations

| Risk                                                                      | Mitigation                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM retries denied operations because messages are less aggressive.       | Base messages still clearly state "is not permitted" / "User denied". The skill-read gate has shipped without "Hard stop" with no observed retry loops. The `[pi-permission-system]` attribution adds clarity the old messages lacked. |
| Large blast radius — 6 gate files, runner, descriptor, 2 deleted modules. | Lift-and-shift migration: `denialContext` is added alongside `messages`, gates migrate incrementally, `messages` is removed only after all gates are migrated. Each step leaves the repo green.                                        |
| `DenialContext` union grows unwieldy as new surfaces are added.           | Each variant is small (3–5 fields). New surfaces add one variant to the union and one branch to each formatter function — no existing code changes.                                                                                    |
| Ask-prompt functions in `external-directory-messages.ts` are collateral.  | They move to `permission-prompts.ts` where sibling ask-prompt functions already live. Imports update but behavior is unchanged.                                                                                                        |

## Open Questions

- The skill-read gate currently produces denial messages without "Hard stop" and without extension attribution.
  After this change it gains `[pi-permission-system]` attribution via the centralized formatter — verify this is desirable (likely yes).
- Should `EXTENSION_TAG` reference the `EXTENSION_ID` constant from `extension-config.ts` rather than duplicating the string?
  Using the existing constant keeps the name in one place, but adds an import dependency from the denial-messages module to the config module.
