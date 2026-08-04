---
issue: 78
issue_title: "Fix README per-agent frontmatter example (nested → flat) and add missing frontmatter tests"
---

# Fix README per-agent frontmatter example and add missing frontmatter tests

## Problem Statement

The README's "Global Per-Agent Overrides" section shows the old nested permission format (`permission.tools.*`, `permission.skills`) which is invalid in the current flat config system.
Additionally, several agent-frontmatter permission surfaces lack test coverage: `skill` patterns, `external_directory` with pattern maps, and global-agent-vs-project-agent frontmatter precedence for these surfaces.

## Goals

- Fix the README example to use the flat permission format (tool names directly under `permission`, `skill:` not `skills:`).
- Fix the `permission.tools.mcp` reference to `permission.mcp`.
- Add tests for `skill` patterns in agent frontmatter.
- Add tests for `external_directory` pattern maps in agent frontmatter.
- Add tests for global-agent-frontmatter vs project-agent-frontmatter merge precedence for `skill` and `external_directory`.

## Non-Goals

- Changing any runtime behavior — this is docs + tests only.
- Reworking the frontmatter parser or merge logic.
- Adding new permission surfaces or config fields.

## Background

The flat permission format (introduced in #66) puts tool names and surface keys directly under `permission`:

```yaml
permission:
  read: allow
  write: deny
  mcp: allow
  bash:
    git status: allow
    git *: ask
  skill:
    "*": ask
```

Existing frontmatter tests cover:

- Tool names in flat format (`find`, `task`, `mcp`) — line 1059
- MCP catch-all in agent frontmatter — line 998
- `bash` patterns in agent frontmatter — line 1404
- `external_directory` scalar override in agent frontmatter — line 1784
- Project-agent overriding system-agent for tools — line 1446

Missing coverage:

- `skill` pattern maps in agent frontmatter
- `external_directory` pattern maps (e.g., `~/Downloads: allow`) in agent frontmatter
- Global-agent vs project-agent frontmatter precedence for `skill` and `external_directory`

The `createManagerWithProject` helper (line 1315) supports `agentFiles` (global agents) and `options.projectAgentFiles` (project agents), which is exactly what's needed.

## Design Overview

No runtime changes.
README edits are straightforward text corrections.
Tests follow existing patterns in `tests/permission-system.test.ts`.

## Module-Level Changes

| File                              | Change                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                       | Fix the YAML example at line ~172: remove nested `tools:` wrapper, rename `skills:` → `skill:`, fix MCP behavior note to reference `permission.mcp` |
| `tests/permission-system.test.ts` | Add 4–5 tests near the existing frontmatter/precedence block (~line 1800)                                                                           |

No schema, config, or architecture doc changes needed — this issue is docs + tests only.

## TDD Order

1. **docs: fix README per-agent frontmatter example to flat format (#78)** Fix the YAML code block under "Global Per-Agent Overrides" to use flat keys.
   Fix `skills:` → `skill:`.
   Fix `permission.tools.mcp` → `permission.mcp` in the MCP behavior note.

2. **test: skill patterns in agent frontmatter (#78)** Red: test that `skill` pattern map in agent frontmatter overrides global `skill` policy (e.g., global `skill: deny`, agent frontmatter `skill: { "pi-*": allow }`).
   Green: should pass immediately — no runtime changes needed, this is coverage for existing behavior.

3. **test: external_directory pattern map in agent frontmatter (#78)** Red: test that `external_directory` with a pattern map in agent frontmatter works (e.g., `external_directory: { "~/Downloads": allow }`).
   Green: should pass immediately.

4. **test: global-agent vs project-agent frontmatter precedence for skill and external_directory (#78)** Red: test using `createManagerWithProject` with both `agentFiles` (global) and `projectAgentFiles` (project) defining `skill` and `external_directory` rules, verifying project-agent wins.
   Green: should pass immediately.

Since all tests exercise existing runtime behavior (no code changes), steps 2–4 can be combined into a single commit:

- `test: add missing frontmatter tests for skill and external_directory (#78)`

## Risks and Mitigations

| Risk                                                           | Mitigation                                                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| README fix introduces a subtly wrong example                   | Compare against `config/config.example.json` and `schemas/permissions.schema.json` to verify surface names  |
| Tests pass trivially without actually exercising the code path | Each test should assert both the `state` and `source`/`matchedPattern` to confirm the right resolution path |
| Could this silently weaken a permission?                       | No — no runtime changes, docs + tests only                                                                  |

## Open Questions

None.
