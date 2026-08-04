---
issue: 106
issue_title: "document opencode compatibility"
---

# Document OpenCode Compatibility

## Problem Statement

The upstream fork documented compatibility with OpenCode, but this repo does not mention it beyond a brief acknowledgment in `README.md` line 109.
This extension's flat permission format was directly inspired by OpenCode's permission model, and in several areas has moved closer to parity.
Users coming from OpenCode — or evaluating this extension alongside it — have no way to understand what transfers directly and where the two diverge.

## Goals

- Add a new doc page (`docs/opencode-compatibility.md`) comparing this extension's permission model with OpenCode's.
- Link to it from `README.md`'s Documentation table and from `docs/configuration.md`.
- Cover shared concepts and call out concrete divergences based on source-level analysis of both systems.

## Non-Goals

- Changing any runtime behavior to match OpenCode — divergences are documented, not resolved.
- Tracking OpenCode's rapidly evolving feature set on a rolling basis — this is a point-in-time comparison.
- Documenting OpenCode's internal architecture — only user-facing permission semantics.

## Background

OpenCode's permission system (documented at `https://opencode.ai/docs/permissions/`, source at `packages/opencode/src/permission/`) uses the same three-action model (`allow` / `ask` / `deny`), the same flat `permission` object with `*` fallback, last-match-wins evaluation, wildcard patterns, home-directory expansion, `external_directory` gating, per-agent overrides, and session-scoped "always" approvals.

This extension was designed with OpenCode's model as a reference (noted in `docs/architecture/target-architecture.md` and `docs/architecture/README.md`).

### Shared Concepts (verified from source)

1. Actions: `allow` / `ask` / `deny`.
2. Flat `permission` object with `"*"` universal fallback.
3. Granular object syntax: surface key → string (catch-all) or pattern-map object.
4. Last-match-wins evaluation order — both use `findLast` on ordered rules.
5. Wildcard `*` matches zero or more of any character.
6. Home directory expansion (`~` / `$HOME`) in patterns.
7. `external_directory` surface for out-of-cwd path gating.
8. `bash` surface with command-pattern matching.
9. `skill` surface with name-pattern matching.
10. `task` surface for subagent/delegation gating.
11. Session-scoped "always" approvals from the ask dialog (`once` / `always` / `reject`).
12. Per-agent permission overrides.
13. Tool hiding — both remove denied tools before the agent runs (OpenCode's `disabled()` function, this extension's `filterActiveTools` + system-prompt sanitization).

### Divergences (verified from source)

| Area                          | OpenCode                                                                               | This extension                                                                                                       | Notes                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Default fallback              | `"*": "allow"` (most surfaces)                                                         | `"*": "ask"` (least privilege)                                                                                       | OpenCode is permissive by default; this extension requires explicit opt-in |
| `.env` file protection        | Built-in `read: { "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" }`        | No built-in `.env` rules                                                                                             | User must configure manually                                               |
| `?` wildcard                  | Supported (matches exactly one character)                                              | Not supported (`?` is escaped as literal)                                                                            | Only `*` works in this extension                                           |
| Trailing wildcard optionality | `"ls *"` matches bare `"ls"` (trailing `*` becomes optional)                           | `"ls *"` does NOT match bare `"ls"`                                                                                  | OpenCode's `Wildcard.match` special-cases patterns ending in `*`           |
| `doom_loop` surface           | Active, defaults to `ask`                                                              | Deprecated and removed                                                                                               | Not a permission concern in Pi's architecture                              |
| File mutation surfaces        | `edit` covers `edit`, `write`, `apply_patch`                                           | Separate `write` and `edit` surfaces                                                                                 | Pi has distinct tools per operation                                        |
| Search/discovery surfaces     | `glob`, `grep`, `list` are gatable surfaces                                            | `find`, `grep`, `ls` are the Pi tool names                                                                           | Different tool names, same concept                                         |
| OpenCode-only surfaces        | `lsp`, `question`, `webfetch`, `websearch`, `todowrite`, `plan_enter`, `plan_exit`     | Not applicable                                                                                                       | Pi does not expose these tools                                             |
| `mcp` surface                 | Not a documented permission surface                                                    | First-class surface with server/tool-level granularity                                                               | Pi-specific feature                                                        |
| Top-level string shorthand    | `"permission": "allow"` sets all surfaces at once                                      | Not supported; `permission` must be an object                                                                        | Use `"permission": { "*": "allow" }` instead                               |
| External directory globs      | Uses `**` for recursive matching in docs                                               | Uses `*` (single wildcard matches across path separators)                                                            | Both `*` implementations match `/` in paths (dot-all regex flag)           |
| Bash arity table              | Built-in `arity.ts` (~100 entries) extracts "human-understandable command" from tokens | No arity table; matches against full command string                                                                  | Session approval patterns serve a similar role                             |
| Per-agent config              | `agent` key inside `opencode.json` or YAML frontmatter in `.md` files                  | YAML frontmatter in Pi agent definition `.md` files only                                                             | OpenCode supports both; this extension only uses frontmatter               |
| Config file paths             | `~/.config/opencode/opencode.json` or `.opencode/config.json`                          | `~/.pi/agent/extensions/pi-permission-system/config.json` or `<cwd>/.pi/extensions/pi-permission-system/config.json` | Completely different directory conventions                                 |
| Subagent prompt forwarding    | Not documented as explicit feature                                                     | `ask` policies work in non-UI subagent contexts via prompt forwarding                                                | Pi-specific feature                                                        |
| Pi infrastructure auto-allow  | N/A                                                                                    | Read-only tools to Pi infra dirs bypass the external_directory gate                                                  | Pi-specific feature                                                        |
| Permission review log         | No equivalent documented                                                               | Writes decisions to `logs/pi-permission-system-permission-review.jsonl`                                              | Auditability feature                                                       |

## Design Overview

This is a documentation-only change.
No code, schema, or config changes are needed.

The new doc page should:

1. Open with a brief statement that this extension's permission model was inspired by OpenCode's, referencing the OpenCode v1.1.x permission rework.
2. Present a "What transfers directly" section covering the shared concepts — users can reuse their mental model and, in many cases, similar config snippets.
3. Present a "Where they diverge" section with the comparison table and explanatory notes for the most impactful differences (default fallback, `.env` protection, `?` wildcard, trailing wildcard optionality, tool surface name mapping).
4. Include a "Porting an OpenCode config" mini-guide showing a before/after example of translating an OpenCode `permission` block to this extension's format.
   Cover: surface name renames (`edit` → `write`+`edit`, `glob` → `find`), the missing top-level string shorthand, and the default flip from `allow` to `ask`.
5. Note that this is a point-in-time comparison and link to the upstream docs for the latest.

## Module-Level Changes

### `docs/opencode-compatibility.md` — new

Full comparison page as described in Design Overview.

### `README.md` — changed

Add row to the Documentation table linking to the new page (e.g., "OpenCode compatibility — shared concepts and divergences").

### `docs/configuration.md` — changed

Add a brief "See also" note linking to the compatibility doc, likely near the top or at the end.

## Test Impact Analysis

No code changes — no test impact.

## TDD Order

This is a docs-only change; no TDD cycles apply.
Use `/build-plan`, not `/tdd-plan`.

1. `docs:` write `docs/opencode-compatibility.md` with full comparison content.
2. `docs:` update `README.md` documentation table.
3. `docs:` add cross-reference in `docs/configuration.md`.

Suggested single commit: `docs: document OpenCode compatibility (#106)`.

## Risks and Mitigations

| Risk                                              | Mitigation                                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Comparison becomes stale as OpenCode evolves      | Note the reference point (OpenCode v1.1.x permission rework, source as of 2026-05) and link to upstream docs                            |
| Could imply feature parity where it doesn't exist | Explicit divergence table with concrete differences                                                                                     |
| Could this silently weaken a permission?          | No — docs-only change, no runtime behavior affected                                                                                     |
| Inaccurate claims about OpenCode behavior         | All divergences verified from OpenCode source (`packages/opencode/src/permission/`, `src/util/wildcard.ts`, `src/config/permission.ts`) |

## Open Questions

1. Should the porting guide include a worked example for `mcp` (Pi-only surface)?
   Defer until writing — include if it clarifies, omit if it confuses.
2. Should the doc mention the `?` wildcard gap as a potential future enhancement or just document it as a difference?
   Document as a difference only — feature changes belong in a separate issue.
