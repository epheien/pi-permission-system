---
issue: 81
issue_title: "Unify checkPermission() surface branching into single evaluate path"
---

# Unify checkPermission() surface branching into single evaluate path

## Problem Statement

`PermissionManager.checkPermission()` is a ~200-line `if/else if` chain dispatching on tool name across five branches (special → skill → bash → mcp → tools).
Each branch duplicates the same pattern: extract lookup value, check session rules in a separate pass, check composed config rules, build result.
The target architecture envisions a single code path where surface-specific logic is limited to input normalization and everything else is shared.

## Goals

- Concatenate session rules into the composed ruleset so `evaluate()` handles them via last-match-wins — no separate per-branch pre-check.
- Extract surface-specific input normalization into a pure helper: `(toolName, input, configuredMcpServerNames) → NormalizedInput`.
- Reduce `checkPermission()` to: normalize → evaluate → build result.
- Extract MCP target derivation helpers to `src/mcp-targets.ts`.
- Pure refactor: no change to permission decisions, `PermissionCheckResult` shape, config format, or `Rule` type.

## Non-Goals

- Changing any permission decision output (same policy + same input = same result).
- Changing `PermissionCheckResult` shape or its `source` field semantics.
- Changing config format or `Rule` type.
- Changing the `/permission-system` slash command.
- Refactoring `getToolPermission()` (simpler, already unified enough).

## Background

### Related issues

| Issue | Title                                                        | State  | Relevance                                                                        |
| ----- | ------------------------------------------------------------ | ------ | -------------------------------------------------------------------------------- |
| #65   | Synthesize defaults into ruleset and unify the evaluate path | Closed | Unified `evaluate()` but left per-surface branching in `checkPermission()`       |
| #57   | Replace SessionApprovalCache with session Ruleset            | Closed | Changed session storage to `Ruleset` but did not concatenate into composed rules |

### Relevant modules

- `src/permission-manager.ts` — contains `checkPermission()`, `getToolPermission()`, MCP target helpers (~784 lines).
- `src/rule.ts` — `Rule`, `Ruleset`, `evaluate()`.
- `src/synthesize.ts` — `composeRuleset()`, `synthesizeDefaults()`, `synthesizeBaseline()`.
- `src/session-rules.ts` — `SessionRules` class producing `Ruleset`.
- `docs/architecture/target-architecture.md` — documents the target of session rules being concatenated.

### Permission surfaces involved

All five: tools, bash, mcp, skills, special (external_directory).

## Design Overview

### Step 1: Concatenate session rules into composed ruleset

Currently `checkPermission()` receives `sessionRules?: Ruleset` and checks it in a separate pass per branch.
After this change, session rules are appended **after** config rules in the composed array (highest priority), and `evaluate()` naturally finds them via last-match-wins.

```typescript
// In checkPermission():
const fullRules = sessionRules?.length
  ? [...composedRules, ...sessionRules]
  : composedRules;
```

This eliminates the duplicated `if (sessionRules.includes(sessionRule))` guard in every branch.

### Step 2: Extract input normalization

A pure function maps `(toolName, input, configuredMcpServerNames)` to a normalized structure:

```typescript
interface NormalizedInput {
  /** The primary surface name for evaluate(). */
  surface: string;
  /**
   * Candidate values to try, in priority order.
   * For most surfaces this is a single element; for MCP it is the multi-name candidate list.
   */
  values: string[];
  /** Extra fields to include in PermissionCheckResult (e.g. command, target). */
  resultExtras: Record<string, unknown>;
}
```

Surface dispatch becomes a simple mapping table (or small function) rather than repeated if/else blocks.

### Step 3: Single evaluate loop

```typescript
function evaluateFirst(
  surface: string,
  values: string[],
  rules: Ruleset,
): { rule: Rule; value: string } {
  for (const value of values) {
    const rule = evaluate(surface, value, rules);
    if (rule.layer !== "default") {
      return { rule, value };
    }
  }
  // Fall back to evaluating the first candidate (picks up the default).
  const fallbackValue = values[0] ?? "*";
  return { rule: evaluate(surface, fallbackValue, rules), value: fallbackValue };
}
```

MCP's multi-candidate logic becomes a natural use of this helper.
Non-MCP surfaces pass a single-element `values` array and get the same behavior.

### Step 4: Result construction

A single result builder maps `(rule, toolName, surface, resultExtras)` → `PermissionCheckResult`, replacing the per-branch construction.

```typescript
function buildResult(
  toolName: string,
  rule: Rule,
  matchedValue: string,
  extras: Record<string, unknown>,
): PermissionCheckResult {
  return {
    toolName,
    state: rule.action,
    matchedPattern: rule.layer === "config" || rule.layer === "session"
      ? rule.pattern : undefined,
    source: deriveSource(rule, toolName),
    ...extras,
  };
}
```

The `source` derivation must preserve current semantics:

- `layer: "session"` → `source: "session"`
- `layer: "config"` → surface-specific source (`"bash"`, `"mcp"`, `"skill"`, `"special"`, `"tool"`)
- `layer: "default"` → `source: "default"`
- `layer: "override"` → `source: "tool"`

### Step 5: Extract MCP target helpers to `src/mcp-targets.ts`

Move `parseQualifiedMcpToolName`, `addDerivedMcpServerTargets`, `pushMcpToolPermissionTargets`, and `createMcpPermissionTargets` into a focused module.
This is purely a file-move with re-export.

## Module-Level Changes

| File                                       | Action                                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `src/mcp-targets.ts`                       | **New** — MCP target derivation helpers extracted from `permission-manager.ts`                          |
| `src/input-normalizer.ts`                  | **New** — `normalizeInput()` pure function + `NormalizedInput` type                                     |
| `src/permission-manager.ts`                | **Changed** — `checkPermission()` reduced to ~30 lines; MCP helpers removed; imports from new modules   |
| `src/synthesize.ts`                        | **Unchanged** — `composeRuleset()` signature stays the same; session concatenation happens at call site |
| `src/rule.ts`                              | **Unchanged**                                                                                           |
| `tests/mcp-targets.test.ts`                | **New** — unit tests for extracted MCP helpers                                                          |
| `tests/input-normalizer.test.ts`           | **New** — unit tests for input normalization                                                            |
| `tests/permission-manager-unified.test.ts` | **New** — integration tests verifying identical decisions before/after refactor                         |
| `tests/session-rules.test.ts`              | **Unchanged** — existing tests continue to pass                                                         |
| `tests/handlers/tool-call.test.ts`         | **Verify** — existing handler tests pass without modification                                           |
| `docs/architecture/target-architecture.md` | **Updated** — mark session concatenation as ✅ implemented                                              |

## TDD Order

### 1. Extract MCP target helpers

- **Test surface**: `tests/mcp-targets.test.ts`
- **Covers**: `parseQualifiedMcpToolName`, `addDerivedMcpServerTargets`, `createMcpPermissionTargets` — port existing implicit coverage into explicit unit tests.
- **Commit**: `refactor: extract MCP target derivation to src/mcp-targets.ts`

### 2. Input normalization — non-MCP surfaces

- **Test surface**: `tests/input-normalizer.test.ts`
- **Covers**: special/external_directory, skill, bash, and tool surfaces produce correct `NormalizedInput`.
- **Commit**: `feat: add input normalizer for non-MCP surfaces`

### 3. Input normalization — MCP surface

- **Test surface**: `tests/input-normalizer.test.ts` (extend)
- **Covers**: MCP input produces multi-candidate `values[]` matching current `createMcpPermissionTargets` output.
- **Commit**: `feat: add MCP input normalization to input-normalizer`

### 4. evaluateFirst helper

- **Test surface**: `tests/rule.test.ts` (extend) or inline in `tests/input-normalizer.test.ts`
- **Covers**: multi-candidate evaluation stops at first non-default match; falls back to default on all-default.
- **Commit**: `feat: add evaluateFirst multi-candidate evaluate helper`

### 5. Session rules concatenation

- **Test surface**: `tests/permission-manager-unified.test.ts`
- **Covers**: session rules appended after composed rules; session rule wins over config rule for same surface/pattern; session rule with narrower pattern does not shadow broader config allow.
- **Commit**: `feat: concatenate session rules into composed ruleset`

### 6. Unified checkPermission

- **Test surface**: `tests/permission-manager-unified.test.ts` (extend)
- **Covers**: all five surfaces produce identical `PermissionCheckResult` as current implementation (snapshot-style comparison against known inputs).
  Verify `source` field derivation.
- **Commit**: `refactor: unify checkPermission into single evaluate path`

### 7. Remove dead code and verify full suite

- **Test surface**: full `npx vitest run`
- **Covers**: old per-branch code deleted; all existing tests pass; no regressions.
- **Commit**: `refactor: remove legacy per-branch checkPermission code`

### 8. Update architecture docs

- **Test surface**: N/A (docs only)
- **Covers**: mark session concatenation and unified evaluate path as ✅ in `docs/architecture/target-architecture.md`.
- **Commit**: `docs: mark unified checkPermission as implemented in target architecture`

## Risks and Mitigations

| Risk                                                                                 | Mitigation                                                                                                                                                                          |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session rule concatenation changes evaluation order, silently weakening a permission | Step 5 includes snapshot tests comparing old vs. new decisions for a matrix of inputs. Session rules go last (highest priority) — same semantics as the current separate pre-check. |
| MCP multi-candidate logic subtly differs after refactor                              | Step 3 tests `createMcpPermissionTargets` output directly; Step 6 runs MCP permission checks through the unified path and compares results.                                         |
| `source` field in `PermissionCheckResult` changes for some edge case                 | Step 6 explicitly tests `source` derivation for each layer type. The `deriveSource()` function is unit-testable.                                                                    |
| Extracting MCP helpers breaks imports elsewhere                                      | Grep for all import sites before extracting; re-export from `permission-manager.ts` if needed during transition.                                                                    |

## Open Questions

- Should `evaluateFirst` live in `src/rule.ts` (alongside `evaluate`) or in `src/input-normalizer.ts`?
  Leaning toward `src/rule.ts` since it's a pure evaluation helper.
  Decide during implementation.
- Should the `NormalizedInput.resultExtras` carry typed fields per surface, or is `Record<string, unknown>` sufficient?
  Start with the record; refine if type-safety issues arise.
