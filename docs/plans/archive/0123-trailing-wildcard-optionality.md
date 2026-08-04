---
issue: 123
issue_title: "Support trailing wildcard optionality (`command *` matches bare `command`)"
---

# Trailing wildcard optionality

## Problem Statement

A pattern like `"git *"` only matches commands with arguments (e.g., `"git status"`), not the bare command `"git"`.
Users must write two rules (`"git"` and `"git *"`) to cover both cases.
OpenCode treats the trailing `*` as optional, and users naturally read `"git *"` as "git with anything, including nothing."

## Goals

- Make `compileWildcardPattern` treat a trailing `*` (space + wildcard) as optional, so `"git *"` also matches bare `"git"`.
- Align with OpenCode's behavior for this specific case.
- Update docs to reflect the new behavior.

## Non-Goals

- Supporting the `?` single-character wildcard (separate divergence).
- Changing non-trailing `*` behavior — `"g*t"` still requires content between `g` and `t`.

## Background

The wildcard matcher lives in `src/wildcard-matcher.ts`.
`compileWildcardPattern` splits on `*`, escapes each segment, and joins with `.*`.
The compiled regex is used across all permission surfaces (bash, tools, MCP, skills, special) via `findCompiledWildcardMatch` and `wildcardMatch`.

The change is isolated to one function — `compileWildcardPattern` — because all surfaces use it.

`docs/opencode-compatibility.md` explicitly documents this as a divergence (line 44, line 85–105).
`docs/configuration.md` uses `"git *"` in examples that would benefit from the new behavior.

## Design Overview

In `compileWildcardPattern`, after building the escaped regex string, check if it ends with `.*`.
If so, replace the trailing `.*` with `( .*)?` to make the space-and-arguments portion optional.

```typescript
// After joining escaped segments with ".*":
if (escaped.endsWith(" .*")) {
  escaped = escaped.slice(0, -3) + "( .*)?";
}
```

This matches OpenCode's implementation exactly.

Edge cases:

- `"git*"` (no space before `*`) — unaffected, still matches `"git"` and `"gitfoo"`.
- `"*"` (lone wildcard) — unaffected, the escaped string is `.*` not `.*`.
- `" *"` (space-only prefix + wildcard) — escaped is `.*`, becomes `( .*)?`, matching empty string and `anything`.
  This is an unlikely pattern but harmless.
- `"git status *"` — trailing `.*` becomes optional, so matches both `"git status"` and `"git status --short"`.
  Correct.

This broadens existing patterns.
A user who wrote `"rm *": "deny"` would now also block bare `rm`.
This matches user intent and is consistent with the principle that `deny` should err on the side of blocking more.

## Module-Level Changes

### `src/wildcard-matcher.ts`

- In `compileWildcardPattern`: after building the escaped regex string, add the trailing `.*` → `( .*)?` transformation.

### `tests/wildcard-matcher.test.ts`

- Add tests for trailing wildcard optionality:
  1. `"git *"` matches `"git"` (bare command).
  2. `"git *"` matches `"git status"` (with arguments — existing behavior preserved).
  3. `"git *"` matches `"git status --short"` (multiple arguments).
  4. `"git *"` does not match `"npm install"` (different prefix).
  5. `"git status *"` matches bare `"git status"`.
  6. Non-trailing `*` is unaffected: `"g*t"` does not match `"g"` or `"t"`.
  7. `"git*"` (no space) still matches `"git"` — unchanged behavior.
  8. `"*"` alone still matches everything — unchanged behavior.
- Update existing test `"glob pattern matches with wildcard"` assertion for `"git *"` against `"git"` (previously `false`, now `true` — or add a new test alongside).

### `docs/opencode-compatibility.md`

- Move "Trailing wildcard optionality" from divergences table to shared concepts.
- Remove the workaround section (lines 85–105) or replace it with a note that the behavior now matches.

### `docs/configuration.md`

- Remove the need for duplicate `"git"` + `"git *"` rules in examples where trailing wildcard optionality applies.

## Test Impact Analysis

1. **New tests enabled**: Direct unit tests for the trailing optionality behavior — straightforward additions to the existing `wildcardMatch` and `findCompiledWildcardMatch` describe blocks.
2. **Existing tests that may break**: The test `"glob pattern matches with wildcard"` currently asserts `"git *"` does NOT match bare `"git"` implicitly (the test checks `"git status"` and `"git push origin main"` but not `"git"`).
   No existing assertion should break since none test `"git *"` against `"git"`.
   However, review all tests to confirm.
3. **Existing tests that stay**: All other wildcard tests (exact match, last-match-wins, regex escaping, home path expansion, multiline) are unaffected.

## TDD Order

1. **Red**: Add tests for trailing wildcard optionality (`"git *"` matches `"git"`, `"git status *"` matches `"git status"`, non-trailing `*` unaffected).
   Commit: `test: add trailing wildcard optionality cases (#123)`

2. **Green**: Update `compileWildcardPattern` to apply the `( .*)?` transformation.
   Commit: `feat: support trailing wildcard optionality (#123)`

3. **Docs**: Update `docs/opencode-compatibility.md` and `docs/configuration.md` to reflect the new behavior.
   Commit: `docs: update wildcard optionality docs (#123)`

## Risks and Mitigations

| Risk                                                                            | Mitigation                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broadens existing `deny` patterns (e.g., `"rm *": "deny"` now blocks bare `rm`) | This matches user intent — bare `rm` is also dangerous. Aligns with least-privilege principle.                                                                                                                                  |
| Could silently weaken a permission?                                             | No — the change only broadens what a pattern *matches*, not what decision it produces. A `deny` pattern matching more commands is *more* restrictive, not less. An `allow` pattern matching bare commands is what users expect. |
| Breaks users who rely on `"cmd *"` NOT matching bare `"cmd"`                    | Unlikely — the current behavior is unintuitive and requires a workaround. The workaround (`"cmd": "allow"` alongside `"cmd *": "allow"`) still works after the change.                                                          |

## Open Questions

None — the implementation matches OpenCode's approach exactly and the issue is fully specified.
