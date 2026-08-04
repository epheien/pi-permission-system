---
issue: 52
issue_title: "Bash command arity table for smart approval pattern suggestions"
---

# Bash command arity table for smart approval pattern suggestions

## Problem Statement

When a user approves a bash command "for this session," the system suggests a wildcard pattern via `suggestBashPattern()`.
Currently that function uses a naive first-word heuristic (`git status --short` → `git *`), which is too broad for commands like `git` where the subcommand is semantically significant.
A curated arity dictionary would let us suggest `git checkout *` instead of `git *`, and `npm run dev*` instead of `npm *`.

## Goals

- Add a curated arity dictionary mapping command prefixes to their token depth.
- Expose a `prefix(tokens: string[]): string[]` function that returns the meaningful prefix for a tokenized command.
- Replace the naive first-word heuristic in `suggestBashPattern()` with arity-aware logic.
- Longest matching prefix wins; unknown commands default to arity 1.
- Cover common CLI tools: git, npm, npx, pnpm, yarn, docker, cargo, pip, go, kubectl, etc.

## Non-Goals

- Shell-quoting-aware tokenization (already handled by `src/input-normalizer.ts` / #72).
- Persisting session approvals across sessions.
- Changing how other surfaces (mcp, skill, tool) suggest patterns.
- Comprehensive coverage of every CLI tool — the dictionary is extensible and good-enough coverage suffices.

## Background

### Current state

`src/pattern-suggest.ts` contains `suggestBashPattern(command: string): string`:

```typescript
const spaceIndex = trimmed.indexOf(" ");
if (spaceIndex === -1) return trimmed;
return `${trimmed.slice(0, spaceIndex)} *`;
```

This produces `git *` for any git command — overly permissive.

### Permission surface

This change affects the **bash** surface only, specifically the pattern suggestion fed into session rules.
It does not change permission evaluation, only what pattern is suggested to the user.

### References

- `src/pattern-suggest.ts` — existing suggestion logic.
- `src/session-rules.ts` — `SessionRules.approve()` stores the pattern.
- OpenCode `packages/opencode/src/permission/arity.ts` — prior art with ~150 entries.

## Design Overview

### New module: `src/bash-arity.ts`

```typescript
/**
 * Curated arity dictionary.
 * Keys are space-joined command prefixes; values are the arity (token count).
 * Multi-level entries allow `npm run` (arity 3) alongside `npm` (arity 2).
 */
const ARITY: Record<string, number> = {
  "git": 2,        // git <subcommand> *
  "npm run": 3,    // npm run <script>*
  "npm": 2,        // npm <subcommand> *
  "docker": 2,     // docker <subcommand> *
  "cargo": 2,      // cargo <subcommand> *
  // ... ~50-150 entries
};

/**
 * Return the semantically meaningful prefix tokens for a command.
 * Longest matching prefix wins.
 *
 * @param tokens - The command split by whitespace.
 * @returns The prefix tokens (length = arity value from dictionary, or 1 for unknown commands).
 */
export function prefix(tokens: string[]): string[];
```

### Lookup algorithm

1. Iterate from longest possible prefix down to 1 token.
2. Join tokens with space, look up in `ARITY`.
3. First (longest) match wins — return `tokens.slice(0, arity)`.
4. No match → default arity 1 → return `[tokens[0]]`.

### Integration with `suggestBashPattern`

```typescript
import { prefix } from "./bash-arity";

export function suggestBashPattern(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return "";
  const tokens = trimmed.split(/\s+/);
  const meaningful = prefix(tokens);
  if (meaningful.length >= tokens.length) {
    // The entire command IS the prefix — no wildcard needed.
    return trimmed;
  }
  // If the next token after the prefix exists and is part of the original,
  // append it with a trailing wildcard for tighter matching.
  return `${meaningful.join(" ")} *`;
}
```

Result examples:

| Command               | Prefix tokens  | Suggested pattern                                   |
| --------------------- | -------------- | --------------------------------------------------- |
| `git checkout main`   | `git checkout` | `git checkout *`                                    |
| `npm run dev`         | `npm run dev`  | `npm run dev*` (exact, arity=3 covers all 3 tokens) |
| `rm -rf node_modules` | `rm`           | `rm *`                                              |
| `cat file.txt`        | `cat`          | `cat *`                                             |
| `ls`                  | `ls`           | `ls` (exact, no args)                               |
| `unknown-tool --flag` | `unknown-tool` | `unknown-tool *`                                    |

Wait — for `npm run dev`, arity is 3 so `prefix(["npm","run","dev"])` returns `["npm","run","dev"]`.
Since `meaningful.length >= tokens.length`, we return the exact command `npm run dev`.
But the issue says it should suggest `npm run dev*` (trailing wildcard to match `npm run dev:watch` etc.).

Refinement: when `meaningful.length === tokens.length`, append `*` to the last token (no space) to allow suffix variants:

```typescript
if (meaningful.length >= tokens.length) {
  return `${trimmed}*`;
}
return `${meaningful.join(" ")} *`;
```

This gives:

- `npm run dev` → `npm run dev*` (matches `npm run dev`, `npm run dev:watch`)
- `git checkout main` → `git checkout *` (arity 2 < 3 tokens → space wildcard)
- `ls` → `ls*` (matches `ls`, but that's fine — single command with no args)

Edge case: single token with no args, e.g. `ls`.
With the above, `ls` → `ls*` which is slightly broader than exact.
Better: only append trailing `*` when arity equals token count AND there are args beyond the base command.
Simplest: keep the original behavior for single-token no-arg commands.

```typescript
if (tokens.length === 1) return trimmed; // exact match for bare commands
if (meaningful.length >= tokens.length) return `${trimmed}*`;
return `${meaningful.join(" ")} *`;
```

### Dictionary structure considerations

- Keys are lowercase, space-joined prefixes.
- Lookup normalizes the first N tokens to lowercase for case-insensitive matching.
- The dictionary is a plain object — no runtime loading, no config file.
- Exported for testability.

## Module-Level Changes

### `src/bash-arity.ts` (new)

- `ARITY` dictionary (exported for testing).
- `prefix(tokens: string[]): string[]` function.

### `src/pattern-suggest.ts` (modified)

- `suggestBashPattern()` refactored to use `prefix()` from `bash-arity.ts`.
- Existing behavior preserved for edge cases (empty string, single token).

### `tests/bash-arity.test.ts` (new)

- Unit tests for `prefix()` covering multi-level lookups, longest-match-wins, unknown commands.

### `tests/pattern-suggest.test.ts` (modified)

- Update `suggestBashPattern` tests to reflect arity-aware patterns.
- Add new cases for multi-level commands (git checkout, npm run, docker compose).

## TDD Order

1. **test: arity prefix lookup for known and unknown commands**
   - Red: tests for `prefix(["git","checkout","main"])` → `["git","checkout"]`, `prefix(["npm","run","dev"])` → `["npm","run","dev"]`, `prefix(["unknown","--flag"])` → `["unknown"]`.
   - Green: implement `src/bash-arity.ts` with dictionary and `prefix()`.
   - Commit: `feat: add bash arity table with prefix lookup (#52)`

2. **test: suggestBashPattern uses arity-aware logic**
   - Red: update existing `suggestBashPattern` tests — `npm run build` should now produce `npm run *` (not `npm *`), `git status --short` produces `git status *` (not `git *`).
   - Green: refactor `suggestBashPattern()` to call `prefix()`.
   - Commit: `feat: integrate arity table into suggestBashPattern (#52)`

3. **test: suggestSessionPattern bash cases reflect arity**
   - Red: update `suggestSessionPattern` bash tests to expect arity-refined patterns.
   - Green: already works via `suggestBashPattern` change.
   - Commit: `test: update session pattern tests for arity-aware bash suggestions (#52)`

4. **docs: document arity table and contribution guidelines**
   - Add a brief section to README explaining the arity dictionary and how to extend it.
   - Commit: `docs: document bash arity table (#52)`

## Risks and Mitigations

| Risk                                                                 | Mitigation                                                                                                                                                                                          |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arity entry too high → pattern too narrow (user still gets prompted) | Safe direction — prompts more, not less. User can still approve exact command.                                                                                                                      |
| Arity entry too low → pattern too broad                              | Same risk as current code. Mitigated by showing pattern in dialog label. User sees what they approve.                                                                                               |
| Could this silently weaken a permission?                             | No. The arity table only affects the **suggested** pattern shown in the dialog. The user must explicitly approve. If anything, it produces tighter patterns than before (reducing what's approved). |
| Dictionary maintenance burden                                        | Start with ~50-80 common commands. Dictionary is static and easy to extend via PRs.                                                                                                                 |
| Case sensitivity — `Git` vs `git`                                    | Normalize to lowercase during lookup.                                                                                                                                                               |

## Open Questions

- Should the arity dictionary be user-configurable (e.g., in `config.json`)?
  Leaning no — keep it curated in code.
  User can always decline the suggestion and rely on exact-match session rules.
- Should flags (tokens starting with `-`) be skipped when counting arity tokens?
  E.g., `rm -rf node_modules` — the meaningful prefix is `rm`, not `rm -rf`.
  Leaning yes — skip flag tokens when matching against the dictionary.
  But this adds complexity; defer to a follow-up if the simple approach works well enough.
