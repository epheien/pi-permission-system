---
issue: 65
issue_title: "Synthesize defaults into ruleset and unify the evaluate path"
---

# Synthesize defaults into ruleset and unify the evaluate path

## Problem Statement

`checkPermission()` in `permission-manager.ts` has ~120 lines of per-surface branching with side-channel fallback values (`bashDefault`, `mcpToolLevel`, `hasAnyMcpAllowRule`) computed outside the ruleset.
These are effectively implicit rules that `evaluate()` never sees.

This means:

- Session rules cannot participate in the main evaluation path (they are checked separately in a pre-gate step in `tool-call.ts`)
- Adding session approvals to new surfaces (#51) would require duplicating the separate pre-check pattern for each surface
- The permission model has two decision engines: `evaluate()` for explicit rules and per-surface `if/else` for defaults and fallbacks

## Goals

- Add `synthesizeDefaults()` that converts `defaultPolicy` into catch-all rules at lowest priority.
- Add `synthesizeOverrides()` that converts `tools.bash`/`tools.mcp` into catch-all rules between defaults and config rules.
- Synthesize MCP baseline auto-allow rules conditionally when any explicit MCP allow rule exists.
- Thread session rules into `checkPermission()` so they participate in `evaluate()` at highest priority.
- Simplify `checkPermission()` to rely on `evaluate()` alone — eliminate `bashDefault`, `mcpToolLevel`, `hasAnyMcpAllowRule` side-channel values.
- Remove the separate session-rule pre-check from `tool-call.ts` — `evaluate()` handles it.
- Add `source: "session"` as a valid `PermissionCheckResult.source` value.
- All existing tests pass — behavior is unchanged.

## Non-Goals

- Generalizing session approvals to non-external_directory surfaces (#51 — follow-up, blocked on this).
- Adding pattern suggestions to the permission dialog (#51).
- Changing the on-disk config format or `/permission-system` slash command name.
- Changing `evaluate()` itself — it remains a pure last-match-wins scanner.
- Persisting session approvals to disk.

## Background

### Dependencies

| Issue | Status | Relationship                                                           |
| ----- | ------ | ---------------------------------------------------------------------- |
| #55   | Closed | Extracted `evaluate()` — prerequisite, landed                          |
| #56   | Closed | Unified Rule type and normalizeConfig — prerequisite, landed           |
| #57   | Closed | Replaced SessionApprovalCache with SessionRules — prerequisite, landed |
| #51   | Open   | Generalize session approvals — **blocked on this issue**               |

### Relevant modules

| File                        | Role                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/permission-manager.ts` | `resolvePermissions()` builds rules + side-channels; `checkPermission()` uses per-surface branching |
| `src/rule.ts`               | `Rule`, `Ruleset`, `evaluate()` — the target sole decision engine                                   |
| `src/normalize.ts`          | `normalizeConfig()` converts on-disk config → Ruleset (excludes tools.bash/mcp)                     |
| `src/defaults.ts`           | `mergeDefaults()`, `getSurfaceDefault()`, `DEFAULT_POLICY`                                          |
| `src/session-rules.ts`      | `SessionRules` class wrapping a Ruleset                                                             |
| `src/handlers/tool-call.ts` | Separate session-rule pre-check for external_directory, normal permission gate                      |
| `src/types.ts`              | `PermissionCheckResult` (source field), `PermissionDefaultPolicy`                                   |

### Permission surfaces involved

All: tools, bash, mcp, skills, special (external_directory).

### Current `ResolvedPermissions` type

```typescript
type ResolvedPermissions = {
  rules: Ruleset;
  defaults: PermissionDefaultPolicy;
  bashDefault: PermissionState;
  mcpToolLevel: PermissionState | undefined;
  hasAnyMcpAllowRule: boolean;
};
```

After this change, `ResolvedPermissions` simplifies to:

```typescript
type ResolvedPermissions = {
  /** Fully composed ruleset: defaults + overrides + baseline + config rules. */
  composedRules: Ruleset;
};
```

Session rules are appended at call-time (not cached in `resolvedPermissionsCache`) because they change mid-session.

## Design Overview

### Composed ruleset layout

```text
Index 0..D: Synthesized defaults (lowest priority)
  { surface: "*",                    pattern: "*", action: defaults.tools }
  { surface: "bash",                 pattern: "*", action: defaults.bash }
  { surface: "mcp",                  pattern: "*", action: defaults.mcp }
  { surface: "skill",                pattern: "*", action: defaults.skills }
  { surface: "special",              pattern: "*", action: defaults.special }

Index D+1..O: Synthesized overrides (tools.bash / tools.mcp, per-scope)
  { surface: "bash", pattern: "*", action: globalConfig.tools.bash }
  { surface: "bash", pattern: "*", action: projectConfig.tools.bash }
  ...
  { surface: "mcp",  pattern: "*", action: globalConfig.tools.mcp }
  ...

Index O+1..B: MCP baseline auto-allow (conditional)
  { surface: "mcp", pattern: "mcp_status",   action: "allow" }
  { surface: "mcp", pattern: "mcp_list",     action: "allow" }
  { surface: "mcp", pattern: "mcp_search",   action: "allow" }
  { surface: "mcp", pattern: "mcp_describe", action: "allow" }
  { surface: "mcp", pattern: "mcp_connect",  action: "allow" }

Index B+1..C: Config rules (global → project → agent → project-agent)
  { surface: "bash",  pattern: "git *",  action: "allow" }
  { surface: "mcp",   pattern: "exa:*",  action: "allow" }
  ...

Index C+1..end: Session rules (highest priority, appended at call-time)
  { surface: "external_directory", pattern: "/other/proj/*", action: "allow" }
```

`evaluate()` scans from end → last-match-wins → session rules override config, config overrides baseline/overrides, overrides override defaults.

### MCP baseline auto-allow as synthesized rules

Current behavior: if the MCP operation is a metadata target (status, list, search, describe, connect) AND (`hasAnyMcpAllowRule` OR `defaults.mcp === "allow"`), auto-allow.

After:

- If `defaults.mcp === "allow"` → the synthesized default `{ surface: "mcp", pattern: "*", action: "allow" }` catches all targets, including baseline ones.
  No separate baseline rules needed.
- If any config rule has `surface: "mcp" && action: "allow"` → synthesize explicit baseline rules for the 5 targets, placed BEFORE config rules so explicit denies can still override them.
- If neither condition → no baseline rules synthesized → baseline targets fall through to MCP default (ask or deny).

This preserves exact current behavior while expressing it as rules.

### `tools.bash` / `tools.mcp` override rules

AGENTS.md states: *"`tools.bash` and `tools.mcp` are fallback overrides — they set the default when no bash/mcp pattern matches, but specific patterns from any scope always have priority."*

These become `{ surface: "bash"|"mcp", pattern: "*" }` catch-all rules placed BETWEEN defaults and config rules.
Specific patterns from config rules sit at higher indices → last-match-wins ensures they override the catch-all.
Multiple scopes each contribute their own override rule; scope ordering (global → project → agent → project-agent) and last-match-wins handle precedence.

### `Rule.layer` metadata

Add an optional `layer` field to `Rule` for source reporting:

```typescript
export interface Rule {
  surface: string;
  pattern: string;
  action: PermissionState;
  /** Origin layer — used to derive PermissionCheckResult.source. Not used by evaluate(). */
  layer?: "default" | "override" | "baseline" | "config" | "session";
}
```

`evaluate()` ignores this field.
Post-evaluation, `checkPermission()` derives `PermissionCheckResult.source`:

| `rule.layer`            | Derived `source`                                                                                      |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `"default"`             | `"default"` for extension tools; `"tool"` for built-in tools; surface name for bash/mcp/skill/special |
| `"override"`            | `"tool"` (preserves current `tools.bash`/`tools.mcp` → `source: "tool"` behavior)                     |
| `"baseline"`            | `"mcp"`                                                                                               |
| `"config"` or undefined | Derived from `rule.surface`: bash→"bash", mcp→"mcp", skill→"skill", special→"special", else→"tool"    |
| `"session"`             | `"session"` (new value)                                                                               |

### Threading session rules into `checkPermission()`

Add an optional `sessionRules` parameter:

```typescript
checkPermission(
  toolName: string,
  input: unknown,
  agentName?: string,
  sessionRules?: Ruleset,
): PermissionCheckResult
```

When provided, session rules are appended to the composed ruleset before `evaluate()`.
This keeps `PermissionManager` stateless regarding sessions — sessions are runtime state, not configuration.

### Removing the external_directory pre-check

After threading session rules, `tool-call.ts` changes from:

```typescript
// Before: separate session pre-check
const sessionRuleset = deps.runtime.sessionRules.getRuleset();
const sessionMatch = evaluate("external_directory", path, sessionRuleset);
if (sessionRuleset.includes(sessionMatch)) { /* log + skip */ }
else { /* normal gate */ }
```

To:

```typescript
// After: unified check
const extCheck = deps.runtime.permissionManager.checkPermission(
  "external_directory", { path: normalizedExtPath }, agentName,
  deps.runtime.sessionRules.getRuleset(),
);
if (extCheck.source === "session") { /* log session_approved + skip */ }
else { /* normal gate using extCheck.state */ }
```

### `getToolPermission()` simplification

`getToolPermission()` also uses `bashDefault`/`mcpToolLevel`.
After the change, it evaluates against the composed rules directly.
For "bash", it evaluates `evaluate("bash", "*", composedRules)`.
For "mcp", it evaluates `evaluate("mcp", "*", composedRules)`.
The synthesized override rules ensure correct results.

### `PermissionCheckResult.source` update

Add `"session"` to the `source` union:

```typescript
export interface PermissionCheckResult {
  // ...
  source: "tool" | "bash" | "mcp" | "skill" | "special" | "default" | "session";
}
```

### External-directory input normalization

Currently `checkPermission("external_directory", {})` always matches the generic policy.
After the change, when called with path info (`{ path: normalizedExtPath }`), it evaluates `evaluate("external_directory", normalizedExtPath, composedRules)` so session rules can match specific paths.
When called without path info (e.g., to get the general policy for tool filtering), it evaluates with `"*"` as the value.

## Module-Level Changes

### `src/rule.ts`

- Add optional `layer?: "default" | "override" | "baseline" | "config" | "session"` to `Rule` interface.
- No changes to `evaluate()` — it ignores `layer`.

### `src/synthesize.ts` (new)

- `synthesizeDefaults(defaults: PermissionDefaultPolicy): Ruleset` — 5 catch-all rules with `layer: "default"`.
- `synthesizeOverrides(overrides: Array<{ bash?: PermissionState; mcp?: PermissionState }>): Ruleset` — per-scope override rules with `layer: "override"`.
- `synthesizeBaseline(configRules: Ruleset): Ruleset` — conditional MCP baseline rules with `layer: "baseline"`.
  Emits rules only when `configRules` contains at least one `surface: "mcp" && action: "allow"` rule.
- `composeRuleset(defaults: Ruleset, overrides: Ruleset, baseline: Ruleset, configRules: Ruleset): Ruleset` — concatenates in priority order.

### `src/permission-manager.ts`

- Remove `bashDefault`, `mcpToolLevel`, `hasAnyMcpAllowRule` from `ResolvedPermissions`.
- Replace with `composedRules: Ruleset` (excludes session rules — those are appended at call-time).
- `resolvePermissions()` calls `synthesizeDefaults()`, `synthesizeOverrides()`, `synthesizeBaseline()`, `composeRuleset()`.
- Simplify `checkPermission()`: input normalization → `evaluate(surface, value, [...composedRules, ...sessionRules])` → derive source from `rule.layer`.
- Simplify `getToolPermission()`: evaluate against composed rules directly.
- MCP multi-target loop remains: iterate targets, call `evaluate()` for each, return first match.
- Add `sessionRules?: Ruleset` parameter to `checkPermission()`.
- Remove `TOOL_SURFACE_OVERRIDE_KEYS` import usage from resolve flow (overrides extracted separately).

### `src/normalize.ts`

- No changes — `normalizeConfig()` continues to exclude `tools.bash`/`tools.mcp` via `TOOL_SURFACE_OVERRIDE_KEYS`.
- Config rules emitted by `normalizeConfig()` get `layer: "config"` (either in `normalizeConfig()` or applied by the caller).

### `src/defaults.ts`

- `getSurfaceDefault()` can be removed after the refactor (defaults are rules now).
  Defer removal to avoid breaking other callers — mark as `@deprecated`.
- `mergeDefaults()` remains (needed to compute the merged default policy before synthesizing).

### `src/types.ts`

- Add `"session"` to `PermissionCheckResult.source` union type.

### `src/session-rules.ts`

- Add `layer: "session"` to rules created by `SessionRules.approve()`.

### `src/handlers/tool-call.ts`

- Remove separate session-rule pre-check for file-tool external_directory gate.
- Remove separate session-rule pre-check for bash external_directory gate.
- Pass `deps.runtime.sessionRules.getRuleset()` to `checkPermission()`.
- Check `result.source === "session"` to log `session_approved`.
- Keep `deriveApprovalPattern()` usage for recording new session approvals on "approved_for_session".
- Remove `import { evaluate } from "../rule"` (no longer needed in handler).

### `tests/synthesize.test.ts` (new)

- Unit tests for `synthesizeDefaults()`, `synthesizeOverrides()`, `synthesizeBaseline()`, `composeRuleset()`.

### `tests/permission-system.test.ts`

- Update tests that assert `source: "default"` for built-in tools (behavior unchanged, but verify).
- Add tests for session-rule-aware `checkPermission()`.

### `tests/handlers/tool-call.test.ts`

- Remove session pre-check mock setup.
- Add assertions that `checkPermission` is called with session rules.
- Verify `session_approved` logging still works via `source === "session"`.

### `tests/rule.test.ts`

- Add test verifying `evaluate()` ignores `layer` field (doesn't affect matching).

## TDD Order

1. **test: add Rule.layer type and verify evaluate() ignores it**
   - Red: test that a rule with `layer: "config"` matches identically to one without.
   - Green: add `layer?` to `Rule` interface.
   - Commit: `test: verify evaluate() ignores Rule.layer metadata`

2. **test: add synthesizeDefaults unit tests**
   - Red: write tests for `synthesizeDefaults()` output shape and layer tagging.
   - Green: implement `src/synthesize.ts` with `synthesizeDefaults()`.
   - Commit: `feat: add synthesizeDefaults() (#65)`

3. **test: add synthesizeOverrides unit tests**
   - Red: test per-scope override generation, empty-input handling.
   - Green: implement `synthesizeOverrides()`.
   - Commit: `feat: add synthesizeOverrides() (#65)`

4. **test: add synthesizeBaseline unit tests**
   - Red: test conditional MCP baseline synthesis (present when allow exists, absent when not).
   - Green: implement `synthesizeBaseline()`.
   - Commit: `feat: add synthesizeBaseline() for MCP auto-allow (#65)`

5. **test: add composeRuleset unit tests**
   - Red: test correct ordering of layers, last-match-wins behavior across layers.
   - Green: implement `composeRuleset()`.
   - Commit: `feat: add composeRuleset() (#65)`

6. **feat: add layer tagging to SessionRules.approve()**
   - Update `SessionRules.approve()` to set `layer: "session"`.
   - Update session-rules tests.
   - Commit: `feat: tag session rules with layer metadata (#65)`

7. **feat: add "session" to PermissionCheckResult.source**
   - Update `src/types.ts`.
   - Commit: `feat: add "session" source to PermissionCheckResult (#65)`

8. **feat: refactor resolvePermissions() to use composed ruleset**
   - Replace `bashDefault`, `mcpToolLevel`, `hasAnyMcpAllowRule` with `composedRules`.
   - Call `synthesizeDefaults()`, `synthesizeOverrides()`, `synthesizeBaseline()`, `composeRuleset()`.
   - Update `ResolvedPermissions` type.
   - Keep `checkPermission()` and `getToolPermission()` working (adapt them to use `composedRules`).
   - All existing permission-system tests must pass.
   - Commit: `feat: compose ruleset with synthesized defaults and overrides (#65)`

9. **feat: simplify checkPermission() to use evaluate() alone**
   - Replace per-surface branching with unified evaluate loop.
   - Add `sessionRules?: Ruleset` parameter.
   - Derive `source` from `rule.layer`.
   - MCP multi-target pre-processing remains (loop over candidates).
   - All existing tests must pass.
   - Commit: `feat: unify checkPermission() through evaluate() (#65)`

10. **feat: simplify getToolPermission() to use composed rules**
    - Remove bashDefault/mcpToolLevel references.
    - Evaluate against composed rules directly.
    - Commit: `feat: simplify getToolPermission() with composed ruleset (#65)`

11. **feat: remove external_directory session pre-check from tool-call handler**
    - Pass session rules to `checkPermission()`.
    - Check `source === "session"` for logging.
    - Remove direct `evaluate()` call and session ruleset handling.
    - Update tool-call handler tests.
    - Commit: `feat: remove separate session pre-check from tool_call (#65)`

12. **test: add integration tests for session-aware checkPermission**
    - Test that session rules override config for external_directory.
    - Test that session rules don't affect surfaces they weren't approved for.
    - Commit: `test: integration coverage for session-aware evaluation (#65)`

13. **docs: update architecture docs and deprecate getSurfaceDefault()**
    - Mark `getSurfaceDefault()` as `@deprecated`.
    - Update `docs/architecture/target-architecture.md` to reflect implementation.
    - Commit: `docs: update architecture for synthesized defaults (#65)`

## Risks and Mitigations

| Risk                                                                                                   | Mitigation                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP baseline auto-allow semantics change subtly when expressed as rules                                | Synthesized baseline rules are placed BEFORE config rules, so explicit deny rules override them. Condition matches exactly: `configRules.some(r => r.surface === "mcp" && r.action === "allow")`. Existing MCP baseline tests verify behavior. |
| `source` field derivation changes for edge cases, breaking tests                                       | Explicit derivation table with per-built-in-tool handling. Run full test suite at each step.                                                                                                                                                   |
| tools.bash/tools.mcp override rules accidentally override explicit patterns from lower-priority scopes | Override rules use pattern `"*"` and are placed BEFORE config rules. Any specific pattern in config sits at higher index and wins via last-match-wins. Explicit test for this case.                                                            |
| Session rules appended at call-time cause cache invalidation thrash                                    | Session rules are NOT part of `resolvedPermissionsCache` — they're appended fresh on each `checkPermission()` call. The composed config rules remain cached.                                                                                   |
| Could this silently weaken a permission?                                                               | No — the change is purely structural. Every decision path is verified against existing tests. Synthesized defaults use the same values as the current hardcoded fallbacks. Session rules remain allow-only and user-approved.                  |
| Performance regression from larger rule arrays                                                         | Rule arrays are small (typically <50 entries). `evaluate()` is a linear scan from end. No measurable impact.                                                                                                                                   |
| `normalizeConfig()` layer tagging changes existing rule objects                                        | Layer is added during composition, not in `normalizeConfig()`. Existing callers of `normalizeConfig()` see rules without layer tags — no behavioral change.                                                                                    |

## Open Questions

- Should `composeRuleset()` live in `src/synthesize.ts` or `src/compose.ts`?
  Leaning toward `src/synthesize.ts` since it co-locates all rule synthesis logic.
  Revisit if the file grows beyond ~100 lines.
- Should `getSurfaceDefault()` be removed immediately or deprecated?
  Deprecation is safer — it may have callers in `before-agent-start.ts` or tool filtering.
  Remove in a follow-up cleanup.
- Should the `PermissionCheckResult` include a `matchedRule?: Rule` field for debugging?
  Useful for #51 (session approval pattern display) but adds coupling.
  Defer to #51 — for now, `matchedPattern` and `source` are sufficient.
