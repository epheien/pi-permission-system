---
issue: 350
issue_title: "~ and $HOME patterns footgun"
---

# Home-expand path values before matching

## Problem Statement

Permission pattern keys for path surfaces are home-expanded at match time: a key like `~/.ssh/*` is compiled to `/Users/me/.ssh/*` by `compileWildcardPattern` (via `expandHomePath`).
The tool-call and bash *values* matched against those compiled patterns are **not** expanded — they flow through `normalizeInput` verbatim.
So a `read` whose `input.path` is `~/.ssh/config` is matched as the literal string `~/.ssh/config` against the regex for `/Users/me/.ssh/*`, which never matches.

The result is a silent permission bypass: a user who declares `"~/.ssh/*": "deny"` (exactly as the docs recommend) sees the tool call proceed.
This is under-matching on a `deny` rule — the most dangerous failure mode for a least-privilege gate.

The bug is uniform across every path surface that passes raw values through `normalizeInput`:

- the cross-cutting `path` surface for tool calls (`describePathGate`) — the reported case;
- the cross-cutting `path` surface for bash tokens (`bash-path.ts`, which passes raw `pathTokens()`);
- per-tool path patterns (e.g. `"read": { "~/.ssh/*": "deny" }`).

A secondary gap: `normalizePathForComparison` (used by the `external_directory` gate, bash external-path extraction, and skill-read) expands `~` but **not** `$HOME`, so `$HOME`-prefixed values miss there.

## Goals

- Home-expand path **values** symmetrically with how path **patterns** are already expanded, so that `~/...`, `$HOME/...`, and the fully-expanded `/Users/me/...` forms all match a `~/.ssh/*` (or `$HOME/.ssh/*`) pattern.
- Close the silent `deny`-bypass for the cross-cutting `path` surface (tool calls and bash) and for per-tool path patterns.
- Extend `$HOME` expansion to `normalizePathForComparison` so the `external_directory` surface reaches `$HOME` parity with `~`.
- Keep the docs example (`"~/.ssh/*": "deny"`) valid — fix the code, not the docs.

## Non-Goals

- No change to cwd-resolution semantics.
  Patterns are home-expanded but **not** resolved relative to cwd today, so glob patterns like `*.env` match anywhere.
  Values will be home-expanded only (not resolved to absolute), preserving that behavior and avoiding any regression to relative patterns (`*.env`, `src/secret`). (User-confirmed: home-expand only, not full canonicalization.)
- No change to how patterns are stored or displayed — approval dialogs and logs keep showing the pattern/value as written (`~/.ssh/*`).
- No new config fields, schema entries, or surfaces.
- No change to bash external-path resolution heuristics beyond the `$HOME` expansion already covered by routing through `expandHomePath`.

## Background

Relevant modules:

- `src/expand-home.ts` — `expandHomePath(pattern)`: expands `~`, `~/`, `~\`, `$HOME`, `$HOME/`, `$HOME\` prefixes to `homedir()`; returns all other strings unchanged (so a literal `~foo` filename is untouched).
- `src/wildcard-matcher.ts` — `compileWildcardPattern` runs the **pattern** through `expandHomePath` before building its regex.
  `wildcardMatch(pattern, value)` is the generic matcher used by `evaluate` for **all** surfaces (bash, skill, mcp, path, …), so expansion must **not** happen inside `wildcardMatch` — only path-surface *values* should be home-expanded.
- `src/rule.ts` — `evaluate(surface, value, rules)` calls `wildcardMatch(r.pattern, value)`; last-match-wins.
- `src/input-normalizer.ts` — `normalizeInput(toolName, input, mcpServerNames)` is the single choke point that builds the `values[]` array fed to `evaluate`.
  Path values flow through three branches: `SPECIAL_PERMISSION_KEYS` (`path`, `external_directory`) and the path-bearing-tools branch (`read`, `write`, `edit`, `find`, `grep`, `ls`).
- `src/path-utils.ts` — `normalizePathForComparison(pathValue, cwd)` strips quotes/`@`, expands `~` inline (lines 19–26), then `resolve(cwd, …)` to an absolute path.
  Used by the `external_directory` gate (passes the normalized absolute path as its resolver input), bash external-path extraction, skill-read, and skill-prompt sanitization.
- `src/handlers/gates/path.ts` (`describePathGate`) and `src/handlers/gates/bash-path.ts` both call `resolver.resolve("path", { path }, …)` with a **raw** value, then route through `permissionManager.checkPermission` → `normalizeInput`.

Constraint from AGENTS.md / package skill:

- Keep schema, example config, `docs/configuration.md`, `README.md`, and types/loaders aligned — but this change touches none of those (no new field).
- "Wildcard matching must be explicit and tested — silent over-matching is a permission bypass."
  This fixes the inverse (silent **under**-matching).
- `expandHomePath` reads `homedir()` (a `node:os` global) internally; this is an established, tested pattern in this codebase (already used by `wildcard-matcher.ts`), so reusing it in `normalizeInput` and `normalizePathForComparison` is consistent.

## Design Overview

Two coordinated, single-line-ish production changes, both reusing the existing `expandHomePath`.

### Fix 1 — `normalizeInput` home-expands path values

In the path branches of `normalizeInput`, run the extracted path through `expandHomePath` before placing it in `values`.
The `"*"` fallback (missing / non-string path) is **not** expanded.

```typescript
// SPECIAL_PERMISSION_KEYS branch (path, external_directory)
const pathValue = typeof record.path === "string" ? record.path : null;
return {
  surface: toolName,
  values: [pathValue === null ? "*" : expandHomePath(pathValue)],
  resultExtras: {},
};

// path-bearing tools branch (read, write, edit, find, grep, ls)
const path = getPathBearingToolPath(toolName, input);
return {
  surface: toolName,
  values: [path === null ? "*" : expandHomePath(path)],
  resultExtras: {},
};
```

Because both `describePathGate` and `bash-path.ts` route through `checkPermission` → `normalizeInput`, this one change fixes the cross-cutting `path` surface for tool calls *and* bash, plus per-tool path patterns — all at once.

Matching is now symmetric:

| Pattern (compiled)       | Value (expanded)                       | Match? |
| ------------------------ | -------------------------------------- | ------ |
| `~/.ssh/*` → `/H/.ssh/*` | `~/.ssh/config` → `/H/.ssh/config`     | yes    |
| `~/.ssh/*` → `/H/.ssh/*` | `$HOME/.ssh/config` → `/H/.ssh/config` | yes    |
| `~/.ssh/*` → `/H/.ssh/*` | `/H/.ssh/config` (unchanged)           | yes    |
| `*.env` (relative glob)  | `.env` (unchanged)                     | yes    |
| `src/secret` (relative)  | `src/secret` (unchanged)               | yes    |

(`/H/` = `homedir()`.) Relative and glob patterns are unaffected because `expandHomePath` only rewrites home-prefixed strings.

### Fix 2 — `normalizePathForComparison` adds `$HOME`

Replace the inline `~`-only block with a call to `expandHomePath`, then resolve as before:

```typescript
let normalizedPath = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
normalizedPath = expandHomePath(normalizedPath); // ~, ~/, $HOME, $HOME/ …
const absolutePath = resolve(cwd, normalizedPath);
```

This is a strict superset of the current behavior (same `~` handling, plus `$HOME`).
It brings the `external_directory` surface, bash external-path extraction, and skill-read to `$HOME` parity.
`expandHomePath` on an already-absolute or relative-non-home string is a no-op, so `resolve(cwd, …)` behaves exactly as today for those inputs — and the subsequent `normalizeInput` expansion (Fix 1) is a harmless no-op on the already-absolute `external_directory` value (no double expansion).

### Edge cases

- Missing / non-string path → `"*"` (never expanded).
- Literal `~foo` (no separator) → unchanged by `expandHomePath` (covered by existing `~username` test) → matched literally.
- `path === null` vs `path === ""`: `getPathBearingToolPath` returns `null` for empty/missing (via `getNonEmptyString`), so the `=== null` guard is correct and an empty string never reaches `expandHomePath`.
- Windows: `expandHomePath` already handles `~\` and `$HOME\`; behavior unchanged on POSIX.

## Module-Level Changes

- `src/input-normalizer.ts` — import `expandHomePath`; wrap the path value in the `SPECIAL_PERMISSION_KEYS` branch and the path-bearing-tools branch with `expandHomePath` (guarding the `"*"` fallback).
- `src/path-utils.ts` — replace the inline `~` expansion in `normalizePathForComparison` (lines ~19–26) with `expandHomePath(normalizedPath)`; `expandHomePath` is already imported.
  The `homedir` import becomes unused if no other reference remains — grep the file and drop the import if so (it is currently used only by that inline block).
- `docs/architecture/architecture.md` — line ~484 reads `expand-home.ts  ~/$HOME expansion for patterns`; broaden to note it now expands path **values** too (patterns and values).
  If the `normalizeInput` description (line ~277) warrants a one-line note that path values are home-expanded, add it.
- `docs/configuration.md` — the "Home Directory Expansion in Patterns" section currently says patterns are expanded "at match time"; add a sentence clarifying that path **values** (`~/…`, `$HOME/…`) supplied by tool calls and bash are expanded the same way, so all three forms match a single home-anchored pattern.
  This is a clarification, not the fix.

No changes to: `schemas/permissions.schema.json`, `config/config.example.json`, `README.md`, loaders, types — no surface or field change.

## Test Impact Analysis

This is a bug fix, not an extraction, so the analysis is narrower:

1. New coverage enabled — `normalizeInput` and `normalizePathForComparison` can now be unit-tested for home expansion directly (both are pure given a mocked `homedir`).
   End-to-end, `permission-manager-unified.test.ts` can assert the reported scenario (raw `~`/`$HOME` value vs. home-anchored deny) which was previously impossible to express as a passing assertion.
2. Existing tests that stay green unchanged — the current `input-normalizer.test.ts` path/external_directory cases use non-home values (`.env`, `/other/project`); `expandHomePath` leaves them untouched, so they pass as-is.
   The `external_directory` cases in `permission-manager-unified.test.ts` (lines ~391–451, ~2403) pass **already-absolute** values and assert `matchedPattern` is the original written pattern — unaffected.
3. Tests that must be added (not redundant) — raw-`~`/`$HOME`-value cases at the unit layer (`input-normalizer`, `path-utils`) and at the integration layer (`permission-manager-unified`), plus gate-layer characterization in `path.test.ts` / `bash-path.test.ts` to lock the fix at the surfaces users actually hit.

No existing test becomes redundant; the change only adds matches that previously (incorrectly) fell through to the default.

## TDD Order

Each cycle is red → green → commit.
`expandHomePath` reads `homedir()`, so home-expansion tests mock `node:os` exactly as `expand-home.test.ts` does (`vi.hoisted` + `vi.mock("node:os", …)` with a `default` key).

1. `fix:` — `normalizePathForComparison` expands `$HOME`.
   Surface: `test/path-utils.test.ts`.
   Red: assert `normalizePathForComparison("$HOME/.ssh/config", cwd)` resolves to `<home>/.ssh/config` (and a bare `$HOME` case); confirm the existing `~` cases still pass.
   Green: route the inline expansion through `expandHomePath`; drop the now-unused `homedir` import if applicable.
   Commit: `fix(pi-permission-system): expand $HOME in normalizePathForComparison (#350)`.

2. `fix:` — `normalizeInput` home-expands path values (the core fix).
   Surface: `test/input-normalizer.test.ts` (add `node:os` mock) **and** `test/permission-manager-unified.test.ts` (the reported scenario).
   Red:
   - `normalizeInput("path", { path: "~/.ssh/config" }, [])` → `values: ["<home>/.ssh/config"]`; same for `$HOME/.ssh/config`; `read` path-bearing branch likewise; `"*"` fallback unchanged.
   - Integration: with `permission.path = { "*": "allow", "~/.ssh/*": "deny" }`, a `path` check for raw value `~/.ssh/config` and `$HOME/.ssh/config` both resolve to `deny` with `matchedPattern === "~/.ssh/*"`; the already-absolute `<home>/.ssh/config` still denies (no regression); a non-home value (`.env`) is unchanged.
   - Per-tool: `permission.read = { "~/.ssh/*": "deny" }` denies a raw `~/.ssh/config` read.
   Green: wrap the path value with `expandHomePath` in both `normalizeInput` branches (guarding `"*"`).
   Commit: `fix(pi-permission-system): home-expand path values before matching (#350)`.
   Run `pnpm run check` after this commit (touches a shared normalizer).

3. `test:` — gate-layer characterization at the surfaces users hit.
   Surface: `test/handlers/gates/path.test.ts` and `test/handlers/gates/bash-path.test.ts`.
   These should be **green** after step 2 (no new production code) — they lock the end-to-end behavior:
   - `describePathGate` produces a `deny`/`ask` descriptor for a raw `~/.ssh/config` tool path under a `~/.ssh/*` rule.
   - `bash-path` resolves a raw `~/.ssh/config` token to the same decision.
   Commit: `test(pi-permission-system): cover raw ~/$HOME path values at the path gates (#350)`.

4. `docs:` — clarify value expansion.
   Surface: `docs/architecture/architecture.md` (expand-home line; optional `normalizeInput` note) and `docs/configuration.md` (Home Directory Expansion section).
   Commit: `docs(pi-permission-system): note path values are home-expanded for matching (#350)`.

## Risks and Mitigations

- Risk: over-expanding a value that should stay literal (e.g. a filename `~foo`).
  Mitigation: `expandHomePath` only rewrites `~`, `~/`, `~\`, `$HOME`, `$HOME/`, `$HOME\` prefixes; `~foo` is untouched (existing test asserts this).
- Risk: double expansion on the `external_directory` value (normalized to absolute by Fix 2, then passed through Fix 1's `normalizeInput`).
  Mitigation: `expandHomePath` is a no-op on absolute paths — no double expansion.
- Risk: a relative path pattern stops matching because the value changed shape.
  Mitigation: values are home-expanded only, never cwd-resolved; relative/glob patterns and non-home values pass through `expandHomePath` unchanged.
- Risk: a test mocks `node:os` for one file and leaks the mock.
  Mitigation: follow the established `vi.hoisted` + per-file `vi.mock("node:os", …)` pattern with `mockHomedir.mockClear()` in `afterEach`, as in `expand-home.test.ts`.

## Open Questions

- Should the `external_directory` `$HOME` parity (Fix 2) be split into its own issue if scope must stay minimal?
  Defer: it is a one-line change reusing `expandHomePath` and directly serves the issue title ("~ and $HOME"), so it stays in this plan unless review objects.
- Bash relative non-glob path patterns (e.g. `src/secret.txt`) already mismatch because bash external-path extraction resolves tokens to absolute while patterns stay relative.
  Out of scope here (pre-existing, unrelated to home expansion); note only.
