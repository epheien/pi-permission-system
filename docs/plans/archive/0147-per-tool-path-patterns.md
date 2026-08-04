---
issue: 147
issue_title: "Per-tool path patterns for path-bearing tools"
---

# Per-tool path patterns for path-bearing tools

## Problem Statement

Path-bearing Pi tools (`read`, `write`, `edit`, `find`, `grep`, `ls`) currently match permissions against the tool name only.
`normalizeInput` returns `values: ["*"]` for all of them, so the actual file path is never evaluated against permission patterns.
Rules like `"read": { "*.env": "deny" }` have no effect — `evaluate()` only ever sees the literal string `"*"` as the match value.

There is no way to express path-level restrictions such as "allow reads except `.env` files," "allow writes only inside `src/`," or "deny edits to `*.lock` files."

## Goals

- Make path-bearing tool permission rules match against the actual file path.
- Maintain full backward compatibility: `"read": "allow"` (shorthand for `{ "*": "allow" }`) behaves identically because `"*"` matches any path.
- Subsume the motivating use case from #144 (allow external reads, prompt for external writes) without special-casing `external_directory`.
- Update schema, example config, README, and architecture docs.

## Non-Goals

- Changing bash permission semantics — bash path-aware rules are tracked in #148.
- Adding a universal `path` surface — deferred pending experience with per-tool patterns.
- Changing `external_directory` behavior or semantics.
- Classifying bash commands as read/write operations.
- Changing the `getToolPermission` evaluation used for tool injection decisions — that must remain tool-level (no path) to avoid hiding tools that are only path-restricted.

## Background

### Permission surfaces involved

`tools` — specifically the subset of built-in tools in `PATH_BEARING_TOOLS`: `read`, `write`, `edit`, `find`, `grep`, `ls`.

### How `checkPermission` works today for tool surfaces

1. `normalizeInput(toolName, input, mcpServerNames)` returns `{ surface: toolName, values: ["*"], resultExtras: {} }` for all non-special, non-bash, non-mcp, non-skill surfaces.
2. `evaluateFirst(surface, values, fullRules)` calls `evaluate(surface, "*", rules)` — last-match-wins against the composed ruleset.
3. Because the value is always `"*"`, only the surface-level catch-all (e.g., `"read": "allow"`) ever fires.
   Path-specific patterns like `"*.env": "deny"` are in the ruleset but never match because `"*.env"` does not wildcard-match `"*"`.

### How `checkPermission` works for bash (the model to follow)

1. `normalizeInput("bash", input, ...)` returns `{ surface: "bash", values: [command], ... }`.
2. `evaluateFirst("bash", [command], rules)` evaluates the actual command string against patterns like `"git *"` and `"rm *"`.
3. Per-pattern matching works because the match value is the real input, not a placeholder.

### Key constraint: `getToolPermission`

`getToolPermission()` is called at agent start to decide whether to inject each tool.
It evaluates `evaluate(toolName, "*", composedRules)` — deliberately using `"*"` to get the surface-level catch-all.
This must remain unchanged: a tool with `"read": { "*": "allow", "*.env": "deny" }` should still be injected (the tool is not blanket-denied).

### Existing path extraction

`getPathBearingToolPath(toolName, input)` in `src/path-utils.ts` already extracts `input.path` for tools in `PATH_BEARING_TOOLS`.
The external-directory gate uses it.
`normalizeInput` can use the same function.

## Design Overview

### Change summary

Change `normalizeInput` so that path-bearing tools return the file path as the match value instead of `"*"`.

### Before (current)

```typescript
// Tool surfaces (read, write, edit, grep, find, ls, extension tools)
return { surface: toolName, values: ["*"], resultExtras: {} };
```

### After (proposed)

```typescript
// Path-bearing tools: use the file path as the match value.
if (PATH_BEARING_TOOLS.has(toolName)) {
  const path = getPathBearingToolPath(toolName, input);
  return {
    surface: toolName,
    values: [path ?? "*"],
    resultExtras: {},
  };
}

// Extension tools (non-path-bearing): unchanged.
return { surface: toolName, values: ["*"], resultExtras: {} };
```

When a tool call has no path (e.g., `read` with missing input), the value falls back to `"*"`, matching the surface-level catch-all — same as today.

### Evaluation flow

With config:

```jsonc
"read": { "*": "allow", "*.env": "deny" }
```

- `read` with `input.path = "src/main.ts"` → `evaluate("read", "src/main.ts", rules)` → `"*"` matches (allow), `"*.env"` does not → **allow**
- `read` with `input.path = ".env"` → `evaluate("read", ".env", rules)` → `"*"` matches (allow), `"*.env"` matches (deny) → **deny** (last-match-wins)

### Backward compatibility

- `"read": "allow"` → shorthand for `{ "*": "allow" }` → `evaluate("read", anyPath, rules)` → `"*"` matches → allow.
  Identical to today.
- `"read": "deny"` → shorthand for `{ "*": "deny" }` → same as today (and `getToolPermission` hides the tool at injection time).
- Existing configs without path patterns behave identically because all their rules use `"*"` as the pattern, which matches any path value.

### Merge precedence

Unchanged.
Global → project → per-agent frontmatter, deep-shallow merge on the `permission` object.
A project config can override a global `"read"` rule with path-specific patterns:

```jsonc
// global: "read": "allow"
// project: "read": { "*": "allow", "*.env": "deny" }
// merged: "read": { "*": "allow", "*.env": "deny" }
```

### How this addresses #144

With per-tool path patterns:

- `"read": "allow"` — permits reads everywhere, including external paths that pass the `external_directory` gate.
- `"write": "ask"` — restricts writes everywhere, including external paths.
- `external_directory` remains as a separate safety gate for "is this path outside CWD?"
- No tool-type keys needed in `external_directory`.

### Edge cases

1. **Missing `input.path`**: `getPathBearingToolPath` returns `null` → `normalizeInput` falls back to `"*"` → surface-level catch-all applies.
2. **Empty `input.path`**: `getPathBearingToolPath` calls `getNonEmptyString`, which returns `null` for empty strings → same fallback.
3. **Extension tools** (non-path-bearing): unchanged — `values: ["*"]` as today.
4. **`getToolPermission`**: unchanged — evaluates `"*"` pattern, not file paths.
   A config like `"read": { "*": "allow", "*.env": "deny" }` still returns `"allow"` for tool injection, which is correct — the tool should be available; only specific paths are restricted.
5. **Session approvals**: the `suggestSessionPattern` function in `pattern-suggest.ts` currently returns `"*"` for non-bash, non-mcp tools.
   With path-based evaluation, the session approval pattern should include the path for path-bearing tools so that "approve for session" grants a path-scoped approval rather than a blanket tool approval.

## Module-Level Changes

### Changed files

| File                                | Change                                                                                                                                                    |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/input-normalizer.ts`           | Add `PATH_BEARING_TOOLS` import; return `input.path` as the match value for path-bearing tools instead of `"*"`.                                          |
| `src/pattern-suggest.ts`            | For path-bearing tools, derive a session approval pattern from the file path (e.g., directory prefix) instead of returning `"*"`.                         |
| `src/handlers/gates/helpers.ts`     | Update `deriveDecisionValue` to return the file path for path-bearing tools (currently returns `toolName`).                                               |
| `schemas/permissions.schema.json`   | Update the `examples` array and the `"read"` example to show path patterns. Add `markdownDescription` noting path-pattern support for path-bearing tools. |
| `config/config.example.json`        | Add a `"read"` entry with path patterns (e.g., `"*.env": "deny"`) alongside the existing `"read": "allow"`.                                               |
| `README.md`                         | Document per-tool path patterns, show examples, note backward compatibility.                                                                              |
| `docs/architecture/architecture.md` | Update the input normalization section to reflect path-bearing tool changes.                                                                              |

### Changed test files

| File                                       | Change                                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/input-normalizer.test.ts`           | Update "tool surfaces" tests: path-bearing tools now return file path from `input.path` instead of `"*"`. Add tests for missing/empty path fallback. |
| `tests/permission-manager-unified.test.ts` | Add integration tests: path-pattern matching for `read`/`write`/`edit` tools (allow, deny, ask by path).                                             |
| `tests/handlers/gates/tool.test.ts`        | Verify `describeToolGate` produces correct decision values when the check result includes path-specific patterns.                                    |
| `tests/pattern-suggest.test.ts`            | Add tests for path-bearing tool session approval patterns.                                                                                           |

### Unchanged files

| File                                            | Reason                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/permission-manager.ts`                     | `checkPermission` and `getToolPermission` are unchanged — the path-bearing logic is fully contained in `normalizeInput`. |
| `src/rule.ts`                                   | `evaluate` and `evaluateFirst` are unchanged — they already support arbitrary pattern matching.                          |
| `src/normalize.ts`                              | `normalizeFlatConfig` already converts `{ "*.env": "deny" }` into rules correctly.                                       |
| `src/wildcard-matcher.ts`                       | Wildcard matching already handles path patterns.                                                                         |
| `src/handlers/gates/external-directory.ts`      | External directory gate is unaffected — it has its own path evaluation.                                                  |
| `src/handlers/gates/bash-external-directory.ts` | Bash path extraction is unaffected.                                                                                      |

## Test Impact Analysis

1. **New tests enabled:**
   - `tests/input-normalizer.test.ts`: path-bearing tools return file paths — the core behavioral change.
   - `tests/permission-manager-unified.test.ts`: end-to-end path-pattern matching (e.g., `"read": { "*.env": "deny" }` blocks `read` of `.env`).
   - `tests/pattern-suggest.test.ts`: session approval patterns include file paths for path-bearing tools.

2. **Existing tests that need updating:**
   - `tests/input-normalizer.test.ts`: the "uses `'*'` as the lookup value for built-in tools" test currently asserts `values: ["*"]` for `read`, `write`, `edit`, `grep`, `find`, `ls`.
     With the change, these tools return the file path when `input.path` is present, and `"*"` only when it's missing.
     The test must split into "returns file path when input.path is present" and "falls back to `'*'` when input.path is missing."

3. **Existing tests that stay as-is:**
   - `tests/rule.test.ts` — `evaluate` and `evaluateFirst` are unchanged.
   - `tests/normalize.test.ts` — config normalization is unchanged.
   - `tests/handlers/gates/external-directory.test.ts` — external directory gate is unaffected.
   - `tests/permission-manager-unified.test.ts` — existing tests remain valid; new tests are additive.

## TDD Order

### Step 1 — Red: `normalizeInput` returns file path for path-bearing tools

1. In `tests/input-normalizer.test.ts`, update the "tool surfaces" describe block:
   - Change existing tests for path-bearing tools (`read`, `write`, `edit`, `grep`, `find`, `ls`) to expect `values: [inputPath]` when `input.path` is present.
   - Add tests for missing `input.path` (expect `values: ["*"]` fallback).
   - Add tests for empty `input.path` (expect `values: ["*"]` fallback).
   - Keep extension tool tests unchanged (still expect `["*"]`).
2. Run tests — they fail (red) because `normalizeInput` still returns `["*"]`.

Commit: `test: expect normalizeInput to return file path for path-bearing tools (#147)`

### Step 2 — Green: implement the `normalizeInput` change

1. In `src/input-normalizer.ts`, add a `PATH_BEARING_TOOLS` import from `path-utils` and `getPathBearingToolPath`.
2. Before the final tool-surfaces return, add a branch: if the tool is path-bearing, extract the path and return it as the value.
3. Run tests — step 1 tests pass (green).

Commit: `feat: normalizeInput returns file path for path-bearing tools (#147)`

### Step 3 — Integration tests: path-pattern matching in `checkPermission`

1. In `tests/permission-manager-unified.test.ts`, add a new describe block for path-bearing tool path patterns:
   - `"read": { "*": "allow", "*.env": "deny" }` denies `read` of `.env`.
   - `"write": { "*": "deny", "src/*": "allow" }` allows `write` of `src/main.ts`.
   - `"read": "allow"` still allows `read` of any path (backward compatibility).
   - `"read": "deny"` still denies `read` of any path (backward compatibility).
   - Session rule for a specific path overrides config deny.
2. Run tests — they pass (already green from step 2).

Commit: `test: add integration tests for per-tool path patterns (#147)`

### Step 4 — Update session approval patterns for path-bearing tools

1. In `tests/pattern-suggest.test.ts`, add tests: path-bearing tools produce a path-scoped session approval pattern (e.g., directory-prefixed wildcard) instead of `"*"`.
2. In `src/pattern-suggest.ts`, update the suggestion logic for path-bearing tools to derive a pattern from the file path.
3. Run tests — pass.

Commit: `feat: path-scoped session approvals for path-bearing tools (#147)`

### Step 5 — Update `deriveDecisionValue` for path-bearing tools

1. In `tests/handlers/gates/tool.test.ts` (or `tests/handlers/gates/helpers.test.ts`), add tests: `deriveDecisionValue` returns the file path for path-bearing tools.
2. In `src/handlers/gates/helpers.ts`, update `deriveDecisionValue` to check `PATH_BEARING_TOOLS` and return the path from the check result.
3. Run tests — pass.

Commit: `feat: decision events include file path for path-bearing tools (#147)`

### Step 6 — Update schema, example config, and docs

1. Update `schemas/permissions.schema.json`: add path-pattern examples for `read`/`write`/`edit`.
2. Update `config/config.example.json`: show a `"read"` entry with path patterns.
3. Update `README.md`: document per-tool path patterns with examples.
4. Update `docs/architecture/architecture.md`: update the input normalization section.
5. Run `pnpm run build` to verify no type errors.

Commit: `docs: document per-tool path patterns (#147)`

## Risks and Mitigations

| Risk                                     | Mitigation                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Could this silently weaken a permission? | No — existing configs use `"*"` patterns (surface-level catch-alls) which match any path value. The change only makes previously-inert path patterns active; it cannot make a deny rule stop matching.                                                            |
| `getToolPermission` returns wrong state  | `getToolPermission` evaluates with `"*"` pattern (unchanged), so `"read": { "*": "allow", "*.env": "deny" }` still returns `"allow"` for tool injection. This is correct — the tool is available; only specific paths are restricted.                             |
| Session approvals become too narrow      | Step 4 updates session approval patterns to be path-scoped. A "for this session" approval on `read /outside/file.txt` should approve that path, not all reads. The `deriveApprovalPattern` function already handles path-based patterns for `external_directory`. |
| Path normalization inconsistency         | `getPathBearingToolPath` returns the raw `input.path` string. Wildcard matching is case-sensitive on Unix. This is consistent with how `external_directory` path patterns work — no new normalization is introduced.                                              |
| Extension tools break                    | Extension tools are not in `PATH_BEARING_TOOLS` and continue to return `values: ["*"]`. No change.                                                                                                                                                                |

## Open Questions

1. **Should `normalizePathForComparison` be applied before matching?**
   The external-directory gate normalizes paths (resolve relative, expand `~`).
   For per-tool path patterns, should `normalizeInput` also normalize, or match against the raw `input.path`?
   Recommendation: start with raw `input.path` to keep the change minimal.
   Normalization can be added in a follow-up if users report that `~/file` patterns don't match `input.path` values.
   If normalization is added, it must use `cwd` — which `normalizeInput` does not currently receive.
   The external-directory gate has `cwd` available in `ToolCallContext`, so passing it through is feasible but increases the change scope.

2. **Should `find` and `grep` match against `input.path` or a different field?**
   Both tools accept a `path` field in their input.
   `getPathBearingToolPath` already handles them uniformly.
   This plan treats them the same as `read`/`write`/`edit`.
