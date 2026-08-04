---
issue: 122
issue_title: "Support `?` single-character wildcard in permission patterns"
---

# Support `?` single-character wildcard

## Problem Statement

OpenCode supports `?` as a single-character wildcard (matches exactly one character) in permission patterns, but this extension treats `?` as a literal character.
Users porting OpenCode configs that use `?` patterns get unexpected behavior silently — the pattern matches nothing instead of acting as a single-char wildcard.

## Goals

- Support `?` as a single-character wildcard in `compileWildcardPattern` (matches exactly one character, including path separators).
- Add tests covering `?` matching (single-char match, no match on zero chars, no match on multiple chars, interaction with `*`).
- Update `docs/configuration.md` to document `?` wildcard.
- Update `docs/opencode-compatibility.md` to move `?` from divergences to shared concepts.

## Non-Goals

- Escaping `?` (e.g., `\?` to match a literal question mark) — follow-up if needed.
- Character classes (`[abc]`) or other glob features — out of scope.

## Background

### Permission surface

This change is surface-agnostic — it affects `src/wildcard-matcher.ts`, which underlies all permission surfaces (tools, bash, mcp, skills, special, external_directory).

### Current implementation

`compileWildcardPattern` splits the pattern on `*`, escapes each segment with `escapeRegExp` (which escapes `?` to `\?`), then joins with `.*`.
Because `?` is inside the escaped segments, it is currently treated as a literal `?`.

### OpenCode prior art

OpenCode's `packages/opencode/src/util/wildcard.ts` uses `.replace(/\?/g, ".")` to convert `?` to `.` in the regex.

## Design Overview

The fix is localized to `compileWildcardPattern` in `src/wildcard-matcher.ts`.

**Strategy:** After splitting on `*` and escaping each part, replace escaped `\?` with `.` (match exactly one character) in each segment.
This preserves the existing escape-then-patch approach used for `*`.

Concretely, after the `.map((part) => escapeRegExp(part))` step, chain `.map((part) => part.replace(/\\\\?/g, "."))` — but since `escapeRegExp` produces `\?` (two chars: backslash + question mark), the replacement target is the literal string `\\?`.

The regex `.` already matches any character including path separators because the pattern uses the `s` (dotAll) flag.

No type changes are needed.
No config schema changes are needed — `?` is valid in JSON string values.

### JSDoc update

The `wildcardMatch` docblock should mention `?` alongside `*`:

```typescript
/**
 * Test whether `value` matches `pattern` using wildcard rules.
 * `*` matches any sequence of characters (including empty).
 * `?` matches exactly one character.
 */
```

## Module-Level Changes

### `src/wildcard-matcher.ts`

- In `compileWildcardPattern`, after the `escapeRegExp` map, replace `\?` → `.` in each segment.
- Update the `wildcardMatch` JSDoc to mention `?`.

### `tests/wildcard-matcher.test.ts`

- Add a `describe("? single-character wildcard")` block with tests:
  1. `?` matches exactly one character.
  2. `?` does not match zero characters.
  3. `?` does not match two or more characters.
  4. Multiple `?` in a pattern (e.g., `f??` matches `foo` but not `fo` or `fooo`).
  5. `?` combined with `*` (e.g., `git?*` matches `git status` but not `git`).
  6. `?` matches path separators and special characters.
  7. Literal `?` in a value still matches `?` pattern (a `?` wildcard matches any single char, including `?` itself).

### `docs/configuration.md`

- Add `?` to the wildcard documentation (near the `*` explanation).

### `docs/opencode-compatibility.md`

- Move the `?` wildcard row from the "Where They Diverge" table to the "What Transfers Directly" table.
- Remove or update any prose that mentions `?` as unsupported.

### Architecture docs

- No architecture doc changes needed — `docs/architecture/architecture.md` does not describe wildcard syntax at the character level.

## Test Impact Analysis

1. **New unit tests:** The `?` wildcard tests are purely additive — they test new behavior that was previously impossible.
2. **No existing tests become redundant** — all current `*` wildcard tests remain valid and necessary.
3. **No existing tests break** — `?` was previously escaped as a literal, and no existing test patterns contain `?`.

## TDD Order

1. **Red:** Add `describe("? single-character wildcard")` tests in `tests/wildcard-matcher.test.ts` — all should fail because `?` is currently a literal.
   Commit: `test: add ? single-character wildcard tests (#122)`

2. **Green:** Update `compileWildcardPattern` in `src/wildcard-matcher.ts` to replace `\?` → `.` after escaping.
   Update JSDoc.
   Commit: `feat: support ? single-character wildcard in permission patterns (#122)`

3. **Docs:** Update `docs/configuration.md` and `docs/opencode-compatibility.md`.
   Commit: `docs: document ? wildcard and update OpenCode compatibility (#122)`

## Risks and Mitigations

| Risk                                                | Mitigation                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Could this silently weaken a permission?            | No — `?` is currently escaped to `\?` (literal). No existing pattern uses `?` as a wildcard. The change is purely additive.                                                                                                                                                  |
| Over-matching: `?` matching more than one character | The regex `.` matches exactly one character. Tests explicitly verify zero-char and multi-char non-matches.                                                                                                                                                                   |
| Interaction with trailing wildcard optionality      | The `( .*)?` suffix only applies to trailing `*`. A trailing `?` is not `*` and won't trigger this path. A combined pattern like `git ?*` works correctly — `?` becomes `.`, `*` becomes `.*`.                                                                               |
| Breaking existing literal `?` in patterns           | Unlikely in practice — `?` is not meaningful in tool names, bash commands, or file paths. If a user has a literal `?` in a pattern today, it would only match a literal `?` in the value — the new behavior matches any single character instead, which is strictly broader. |

## Open Questions

- Should `\?` be supported as an escape sequence for a literal `?`?
  Deferred — OpenCode does not support this either, and the need is unlikely given `?` does not appear in tool names or common paths.
