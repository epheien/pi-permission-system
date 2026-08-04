---
issue: 97
issue_title: "Document coexistence with pi-subagent extensions and their tool deny mechanisms"
---

# Document subagent extension coexistence

## Problem Statement

Three major pi-subagent extensions (nicobailon/pi-subagents, tintinweb/pi-subagents, HazAT/pi-interactive-subagents) each implement their own tool restriction mechanisms.
These compose correctly with our permission system today — subagent extensions control tool *visibility* while our extension controls tool *policy* — but users have no documentation explaining this layering.
A user might set `deny-tools: bash` in one extension and `bash: allow` in ours, or vice versa, with no guidance on how the two interact.

## Goals

- Add a "Coexistence with subagent extensions" section to `README.md`.
- Document the two-layer model: visibility (subagent extension) → policy (permission system).
- Clarify that `permission:` frontmatter is exclusive to our extension and does not conflict with `tools:`, `disallowed_tools:`, or `deny-tools:` keys.
- Note the interaction edges: hidden tools are never seen by our extension; denied tools are hidden regardless of the subagent extension's allowlist.

## Non-Goals

- Changing any runtime behavior — this is docs-only.
- Adding integration tests against third-party subagent extensions.
- Modifying frontmatter parsing to detect or warn about subagent extension keys (tracked separately in #96).

## Background

Our extension hooks into Pi's tool lifecycle at two points:

1. **Tool filtering** (`onRegisterTool`) — removes denied tools before the agent sees them and rewrites the `Available tools:` system prompt section.
2. **Permission gating** (`checkPermission`) — intercepts tool/bash/MCP/skill calls at runtime and enforces allow/ask/deny policy.

Subagent extensions operate at a different layer:

| Extension                      | Mechanism                               | Effect                                             |
| ------------------------------ | --------------------------------------- | -------------------------------------------------- |
| nicobailon/pi-subagents        | `--tools` CLI allowlist                 | Only listed tools are registered in the subprocess |
| tintinweb/pi-subagents         | `session.setActiveToolsByName()`        | Filters the active tool set in-process             |
| HazAT/pi-interactive-subagents | `PI_DENY_TOOLS` env var + `--tools` CLI | Combines denylist env var with CLI allowlist       |

The two layers do not conflict:

- If a subagent extension hides a tool, our extension never receives a registration or call event for it.
- If our extension denies a tool, it is removed from the active set regardless of what the subagent extension allowed.

## Design Overview

Add a new `### Coexistence with Subagent Extensions` subsection under the existing `## Technical Details` heading in `README.md`.
The section should:

1. Introduce the two-layer model with a brief diagram or table.
2. List the three known subagent extensions and their frontmatter keys.
3. Explain the interaction rules with concrete examples.
4. State that `permission:` frontmatter is exclusive to this extension.

No code, schema, or config changes are required.

## Module-Level Changes

| File        | Change                                                                      |
| ----------- | --------------------------------------------------------------------------- |
| `README.md` | Add `### Coexistence with Subagent Extensions` under `## Technical Details` |

No changes to `src/`, `schemas/`, `config/`, `tests/`, or `docs/architecture/`.

## TDD Order

1. **docs: document subagent extension coexistence (#97)** — Add the new README section.
   No test cycle; docs-only change.
   Verify with `markdownlint README.md` if available.

## Risks and Mitigations

| Risk                                                                       | Mitigation                                                                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Documentation becomes stale if subagent extensions change their mechanisms | Keep the section descriptive of the general two-layer model; specific extension details are secondary and link to upstream repos |
| Could this silently weaken a permission?                                   | No — this change is documentation only; no runtime behavior is altered                                                           |
| Users might misread the section as endorsing a specific subagent extension | Use neutral language; describe mechanism, not recommendation                                                                     |

## Open Questions

- None.
  The issue scope is clear and self-contained.
