---
issue: 55
issue_title: "Extract pure evaluate() function from PermissionManager"
---

# Extract pure evaluate() function from PermissionManager

## Problem Statement

`PermissionManager.checkPermission()` is a ~120-line method dispatching on surface type via `if/else if` branches.
Every branch does the same thing: match input against compiled patterns, fall back to a default.
Only MCP has genuinely different logic (multi-name lookup + baseline auto-allow).

Permission evaluation is not independently testable — it requires a `PermissionManager` instance with filesystem access for config loading.
AGENTS.md states: *"Permission decisions should be pure functions of (policy, request) wherever possible — keep IO at the edges."*

## Goals

- Extract a pure `evaluate()` function into `src/rule.ts` that takes a surface name, a match pattern, and one or more rulesets, returning the winning rule.
- Define `Rule` and `Ruleset` types that align with the target architecture (`docs/architecture/target-architecture.md`).
- Refactor `PermissionManager.checkPermission()` to call `evaluate()` internally — no change to external behavior or return types.
- Add focused unit tests for `evaluate()` covering all surfaces, wildcard matching, last-match-wins semantics, and default fallback.
- Preserve all existing `PermissionManager` tests without modification.

## Non-Goals

- Config normalization into flat `Ruleset` at load time (deferred to #56).
- Removing per-surface compiled pattern arrays or `BashFilter` class (deferred to #56).
- Changing the on-disk config format or `PermissionCheckResult` return type.
- Replacing `SessionApprovalCache` with session rules (deferred to #57).
- Extracting event handlers (#42) or eliminating module-scope state (#43).

## Background

### Permission surfaces involved

All: tools, bash, mcp, skills, special, external_directory.

### Relevant modules

| Module                                     | Role                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `src/permission-manager.ts`                | Owns `checkPermission()` — the method being refactored                                        |
| `src/wildcard-matcher.ts`                  | `findCompiledWildcardMatch` / `findCompiledWildcardMatchForNames` — used for pattern matching |
| `src/bash-filter.ts`                       | `BashFilter.check()` — wraps wildcard matching for bash commands                              |
| `src/types.ts`                             | `PermissionState`, `PermissionCheckResult`, `GlobalPermissionConfig`, `AgentPermissions`      |
| `docs/architecture/target-architecture.md` | Defines the target `Rule`/`Ruleset`/`evaluate()` shape                                        |

### Current flow

1. `resolvePermissions(agentName)` loads and merges config into `merged: GlobalPermissionConfig` + compiled pattern arrays per surface.
2. `checkPermission(toolName, input, agentName)` dispatches on surface type:
   - `special` → `findCompiledPermissionMatch(compiledSpecial, name)` → fallback to `defaultPolicy.special`
   - `skill` → `findCompiledPermissionMatch(compiledSkills, skillName)` → fallback to `defaultPolicy.skills`
   - `bash` → `bashFilter.check(command)` → fallback to bash default
   - `mcp` → `findCompiledPermissionMatchForNames(compiledMcp, targets)` → tool-level mcp → baseline auto-allow → fallback to `defaultPolicy.mcp`
   - built-in tool → `merged.tools[name]` → fallback to `defaultPolicy.tools`
   - other tool → `merged.tools[name]` → fallback to `defaultPolicy.tools`

### Merge precedence

Global → project → per-agent frontmatter (unchanged by this issue).
Compiled pattern arrays preserve insertion order; `findCompiledWildcardMatch` iterates **last to first** (last-match-wins).

## Design Overview

### New types (`src/rule.ts`)

```typescript
import type { PermissionState } from "./types";

/** A single permission rule — the atomic unit of policy. */
export interface Rule {
  /** The permission surface: "bash", "read", "mcp", "skill", "external_directory", etc. */
  surface: string;
  /** The match pattern: a command glob, tool name, skill name, or "*". */
  pattern: string;
  /** The permission decision. */
  action: PermissionState;
}

/** An ordered list of rules. Later rules take priority (last-match-wins). */
export type Ruleset = Rule[];
```

### `evaluate()` function (`src/rule.ts`)

```typescript
import { wildcardMatch } from "./wildcard-matcher";

/**
 * Pure permission evaluation.
 * Returns the last matching rule across all provided rulesets,
 * or a synthetic rule with the surface default if no match is found.
 */
export function evaluate(
  surface: string,
  pattern: string,
  ...rulesets: Ruleset[]
): Rule {
  const rules = rulesets.flat();
  const match = rules.findLast(
    (rule) => wildcardMatch(rule.surface, surface) && wildcardMatch(rule.pattern, pattern),
  );
  return match ?? { surface, pattern, action: getDefaultAction(surface) };
}
```

### `getDefaultAction()` (`src/rule.ts`)

```typescript
const SURFACE_DEFAULTS: Record<string, PermissionState> = {
  tools: "ask",
  bash: "ask",
  mcp: "ask",
  skill: "ask",
  special: "ask",
};

/**
 * Returns the default action for a surface when no rules match.
 * Defaults to "ask" for unknown surfaces (least privilege).
 */
export function getDefaultAction(surface: string): PermissionState {
  return SURFACE_DEFAULTS[surface] ?? "ask";
}
```

Note: `getDefaultAction` is a simple fallback for the **pure** function.
The actual per-surface defaults from `defaultPolicy` in the merged config will be passed as an explicit final rule or a fallback override when `checkPermission()` calls `evaluate()`.
This keeps `evaluate()` pure — it does not need access to the loaded config.

### `wildcardMatch()` helper (`src/wildcard-matcher.ts`)

A new convenience export wrapping the existing compiled pattern infrastructure for single-shot matching:

```typescript
/**
 * Test whether `value` matches `pattern` using wildcard rules.
 * Used by evaluate() for rule matching.
 */
export function wildcardMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === value;
  const compiled = compileWildcardPattern(pattern, true);
  return compiled.regex.test(value);
}
```

### Integration into `checkPermission()`

`checkPermission()` converts the existing compiled-pattern lookup into `evaluate()` calls per surface.
Because #56 has not yet normalized config into flat rulesets, the integration layer builds temporary `Ruleset` values from the already-compiled patterns:

```typescript
// Helper: convert compiled patterns into a Ruleset for evaluate()
function compiledToRuleset(
  surface: string,
  patterns: CompiledPermissionPatterns,
): Ruleset {
  return patterns.map((p) => ({ surface, pattern: p.pattern, action: p.state }));
}
```

Each surface branch in `checkPermission()` becomes a thin call to `evaluate()`:

- **special**: `evaluate("special", normalizedToolName, compiledToRuleset("special", compiledSpecial))`
- **skill**: `evaluate("skill", skillName, compiledToRuleset("skill", compiledSkills))`
- **bash**: `evaluate("bash", command, compiledToRuleset("bash", bashPatterns))`
- **built-in tool / other tool**: `evaluate(normalizedToolName, "*", toolsRuleset)`
- **mcp**: loops `evaluate("mcp", candidate, compiledToRuleset("mcp", compiledMcp))` over derived targets — existing multi-name logic preserved, baseline auto-allow logic preserved.

The `PermissionCheckResult` return type and `source` field remain unchanged.

### Edge cases

1. **MCP baseline auto-allow**: remains outside `evaluate()` — it is a heuristic that fires only when no rule matches and certain preconditions hold.
   Preserved as-is.
2. **`BashFilter`**: still instantiated and used (deferred removal to #56).
   Internally its `check()` method will delegate to `evaluate()` or remain unchanged for this step — TBD during implementation based on code clarity.
   The plan prefers minimal changes: keep `BashFilter.check()` as-is and call `evaluate()` only from `checkPermission()` for the bash surface.
3. **Compiled pattern caching**: no change.
   Patterns are still compiled once per config load; `compiledToRuleset()` is cheap (array map, no regex compilation).
4. **`defaultPolicy` injection**: each surface branch passes the relevant default as a fallback after calling `evaluate()`, rather than encoding it in `SURFACE_DEFAULTS`.
   This preserves the current behavior where user-configured defaults override the hardcoded ones.

## Module-Level Changes

### `src/rule.ts` (new)

- Export `Rule`, `Ruleset`, `evaluate()`, `getDefaultAction()`.
- Pure module — no IO, no imports beyond `./wildcard-matcher`.

### `src/wildcard-matcher.ts` (modified)

- Add exported `wildcardMatch(pattern, value): boolean` convenience function.
- No changes to existing exports.

### `src/permission-manager.ts` (modified)

- Import `evaluate`, `Rule`, `Ruleset` from `./rule`.
- Add private helper `compiledToRuleset()`.
- Refactor `checkPermission()` to use `evaluate()` for each surface, preserving `PermissionCheckResult` construction.
- No change to public API surface or return types.

### `tests/rule.test.ts` (new)

- Unit tests for `evaluate()` and `getDefaultAction()`.

### `tests/wildcard-matcher.test.ts` (modified)

- Add tests for the new `wildcardMatch()` convenience function.

### No changes to

- `schemas/permissions.schema.json` — no config format change.
- `config/config.example.json` — no config format change.
- `README.md` — internal refactor, no user-facing change.
- `src/types.ts` — `PermissionCheckResult` and related types unchanged.
- `src/bash-filter.ts` — kept as-is (removed in #56).
- Existing tests in `tests/permission-system.test.ts`, `tests/bash-filter.test.ts`, etc.

## TDD Order

1. **Red**: test `wildcardMatch("*", "anything")` returns `true`, exact match returns `true`, non-match returns `false`, glob patterns match correctly.
   **Green**: implement `wildcardMatch()` in `src/wildcard-matcher.ts`.
   `test: wildcardMatch convenience function`

2. **Red**: test `getDefaultAction("bash")` returns `"ask"`, `getDefaultAction("unknown_surface")` returns `"ask"`.
   **Green**: implement `getDefaultAction()` in `src/rule.ts`.
   `test: getDefaultAction returns per-surface defaults`

3. **Red**: test `evaluate("bash", "git status", rules)` returns the matching rule when one exists; returns a synthetic rule with default action when no match.
   **Green**: implement `evaluate()` skeleton.
   `feat: add evaluate() pure function in src/rule.ts`

4. **Red**: test last-match-wins — given two conflicting rules for the same surface/pattern, `evaluate()` returns the later one.
   **Green**: already passes if `findLast` is used correctly.
   `test: evaluate last-match-wins semantics`

5. **Red**: test `evaluate()` with wildcard surface matching (e.g. rule with `surface: "*"` matches any surface).
   **Green**: ensure `wildcardMatch` is applied to the surface field.
   `test: evaluate wildcard surface matching`

6. **Red**: test `evaluate()` with multiple rulesets — rules from later rulesets take priority.
   **Green**: verify `rulesets.flat()` ordering is correct (later rulesets' rules appear last).
   `test: evaluate multi-ruleset precedence`

7. **Red**: test `evaluate()` for each permission surface (tool, bash, mcp, skill, special) with realistic rules and patterns.
   **Green**: should pass with existing implementation.
   `test: evaluate covers all permission surfaces`

8. **Refactor**: wire `evaluate()` into `checkPermission()` for the `special` surface branch.
   Run full test suite.
   `refactor: checkPermission special branch uses evaluate()`

9. **Refactor**: wire `evaluate()` into the `skill` surface branch.
   Run full test suite.
   `refactor: checkPermission skill branch uses evaluate()`

10. **Refactor**: wire `evaluate()` into the built-in tool and other-tool branches.
    Run full test suite.
    `refactor: checkPermission tool branches use evaluate()`

11. **Refactor**: wire `evaluate()` into the `bash` surface branch (calling `evaluate()` from `checkPermission()`, keeping `BashFilter` alive for now).
    Run full test suite.
    `refactor: checkPermission bash branch uses evaluate()`

12. **Refactor**: wire `evaluate()` into the `mcp` surface branch (loop over candidates).
    Run full test suite.
    `refactor: checkPermission mcp branch uses evaluate()`

13. **Verify**: run `pnpm run build` (typecheck) and `npx vitest run` (full suite).
    Confirm no regressions.
    `chore: verify clean build after evaluate() extraction`

14. **Docs**: update `docs/architecture/target-architecture.md` to mark #55 as complete in the refactoring sequence diagram.
    `docs: mark #55 complete in target architecture`

## Risks and Mitigations

| Risk                                                               | Mitigation                                                                                                                                                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Semantic drift during refactor (different match result)            | Each surface branch is wired one at a time with full test suite between steps. `evaluate()` uses the same `wildcardMatch` logic as the existing `findCompiledWildcardMatch`.                                                          |
| Could this silently weaken a permission?                           | No new `"allow"` path is introduced. `evaluate()` falls back to `getDefaultAction()` which returns `"ask"` (least privilege). Each `checkPermission()` call site still applies its own default from `merged.defaultPolicy` as before. |
| Performance regression from `compiledToRuleset()` array allocation | Negligible — called once per `checkPermission()` invocation, patterns are already in memory. Profiling deferred to #56 which removes the intermediate step entirely.                                                                  |
| MCP baseline auto-allow logic could be accidentally removed        | The MCP branch is the most complex; it retains its bespoke logic **after** the `evaluate()` call fails to match. Existing MCP tests explicitly cover the baseline auto-allow path.                                                    |
| `wildcardMatch` convenience function compiles a regex per call     | Only used by `evaluate()` for small rulesets. Once #56 normalizes config into pre-compiled rulesets, this path is optimized away. For now the per-call cost is acceptable (< 1μs per pattern).                                        |

## Open Questions

- **Should `evaluate()` accept a `defaultAction` override parameter instead of calling `getDefaultAction()`?**
  Leaning yes — `checkPermission()` already has the merged `defaultPolicy` and should pass it through.
  Defer final decision to implementation; the test surface covers both behaviors.
- **Should we add a `compiledEvaluate()` variant that takes pre-compiled patterns?**
  Defer to #56 where compiled patterns become the primary representation.
  For now, `evaluate()` operates on string patterns and compiles on the fly.
