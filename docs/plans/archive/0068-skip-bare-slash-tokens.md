---
issue: 68
issue_title: "False positive external-directory prompt when bash command contains //"
---

# Skip bare-slash tokens in bash external-directory extraction

## Problem Statement

`extractExternalPathsFromBashCommand` fires a spurious external-directory prompt whenever a bash command contains the token `//` (e.g. a JavaScript comment in a heredoc).
`classifyTokenAsPathCandidate` accepts any token starting with `/`, and `path.normalize("//")` returns `/` (root), which is always outside CWD.
The user sees a confusing prompt referencing path `/`.

## Goals

- Eliminate false-positive external-directory prompts for bare-slash tokens (`/`, `//`, `///`, etc.).
- Add regression tests covering the reproducer and edge cases.

## Non-Goals

- Rewriting the tokenizer to use a real shell parser (acknowledged as a broader limitation in the issue; deferred to a follow-up issue — see Open Questions).
- Fixing the `stripQuotedStrings` escaped-quote limitation (separate issue).

## Background

- **Permission surface**: `external_directory` (bash variant).
- **Module**: `src/external-directory.ts` — `classifyTokenAsPathCandidate` is the gatekeeper that decides which tokens are path candidates.
- **Tests**: `tests/bash-external-directory.test.ts` covers `extractExternalPathsFromBashCommand` with sections for absolute paths, flags, URLs, safe system paths, etc.

The fix is a single early-return guard in `classifyTokenAsPathCandidate`.

## Design Overview

Add a check before the existing `token.startsWith("/")` branch:

```typescript
// Skip bare-slash tokens (// JS comments, lone /, etc.) — they resolve to root
// and are never meaningful path arguments in practice.
if (/^\/+$/.test(token)) return null;
```

This rejects any token composed entirely of forward slashes (`/`, `//`, `///`, …).
Tokens like `/etc/hosts` still pass because they contain non-slash characters.

No config, schema, or merge-precedence changes involved.

## Module-Level Changes

| File                                    | Change                                                                                          |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `src/external-directory.ts`             | Add `/^\/+$/` guard in `classifyTokenAsPathCandidate` before the `startsWith("/")` branch.      |
| `tests/bash-external-directory.test.ts` | Add a "bare-slash tokens" `describe` block with tests for `//`, `/`, `///`, and mixed commands. |

## TDD Order

1. **test: add failing tests for bare-slash false positives (#68)**
   - Add tests in `tests/bash-external-directory.test.ts` under a new `describe("bare-slash tokens are skipped")` block:
     - `//` token → empty result.
     - `/` token → empty result.
     - `///` token → empty result.
     - `echo // hello` → empty result.
     - `// comment` alongside a real external path → only the real path reported.
   - Tests fail (red).

2. **feat: skip bare-slash tokens in classifyTokenAsPathCandidate (#68)**
   - Add the `/^\/+$/` guard in `classifyTokenAsPathCandidate`.
   - All new tests pass (green).
   - Run full suite to confirm no regressions.

3. **docs: document bare-slash fix in plan retro (#68)**
   - Optional: add a retro note if anything surprising surfaces during implementation.

## Risks and Mitigations

| Risk                                                  | Mitigation                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Could this silently weaken a permission?              | No — bare-slash tokens resolve to `/` (root), which is never a meaningful path argument. Skipping them only removes false positives; real paths like `/etc/hosts` are unaffected because they contain non-slash characters.                                                     |
| Regex too broad?                                      | `/^\/+$/` only matches tokens that are *entirely* slashes. Any token with a non-slash character still goes through the existing path-candidate logic.                                                                                                                           |
| Edge case: lone `/` as a real argument (e.g. `ls /`)? | `ls /` would list root. Skipping it means no external-directory prompt for root listing. This is acceptable — the bash permission gate itself still applies, and root-listing is a read-only operation. If a user wants to block `ls /` they can deny the bash command pattern. |

## Open Questions

- **Follow-up: replace regex tokenizer with a proper parser.**
  OpenCode uses `web-tree-sitter` + `tree-sitter-bash` for full AST-based path extraction.
  `shell-quote` (23KB, zero deps, 47M downloads) is a lighter alternative that properly handles quoting, operators, and comments.
  Either would eliminate the entire class of tokenizer edge-case bugs.
  File a follow-up issue after this fix lands.
