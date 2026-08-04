# Upstream Issue Template

Template text for proposing the `permission:` frontmatter convention to subagent extension repositories.
Customize the placeholders (`{{...}}`) for each target repo.

---

## Issue Title

> Proposal: document `permission:` frontmatter for per-agent permission policy

## Issue Body

````markdown
## Context

Users of both `{{your-extension}}` and [`pi-permission-system`](https://github.com/gotgenes/pi-permission-system) currently configure tool restrictions in two places:

1. **Tool visibility** via `{{your-key}}` in agent frontmatter (consumed by your extension)
2. **Permission policy** via `permission:` in the same frontmatter (consumed by pi-permission-system)

These two layers compose correctly today — there is no conflict — but users may not realize they can combine them in the same agent file.

## Proposal

Document the `permission:` key as an optional companion to `{{your-key}}` in your agent authoring docs.
This is purely a documentation change — no code dependency on pi-permission-system is needed.

### What `permission:` provides

- **Three-state policy**: `allow`, `ask` (prompt the user), or `deny` — richer than binary allow/deny
- **Multiple surfaces**: tools, bash commands (glob patterns), MCP operations, skills, external directories
- **Prompt forwarding**: `ask` decisions in headless child agents surface in the parent session's UI
- **Service accessor API**: other extensions can query policy at runtime via a `Symbol.for()`-backed accessor, with only a dynamic `import()` and no required peer dependency

### Example

```yaml
---
# {{your-extension}}: restrict visible tools
{{your-key}}: {{example-value}}

# pi-permission-system (optional): policy within the visible set
permission:
  "*": ask
  read_file: allow
  bash:
    "*": ask
    "git *": allow
---
```

### Two-layer model

```text
Layer 1 – Visibility ({{your-extension}})
  → Controls which tools are registered before the session starts

Layer 2 – Policy (pi-permission-system)
  → Controls allow/ask/deny decisions on every tool call, bash command, etc.
```

A tool hidden by Layer 1 is never evaluated by Layer 2.
A tool denied by Layer 2 cannot be restored by Layer 1.
Both mechanisms are additive — a tool blocked by either stays blocked.

### What adoption requires from you

1. Add a section to your README noting that `permission:` is an optional key consumed by pi-permission-system
2. Show a combined example with `{{your-key}}` + `permission:`
3. Link to the [convention guide](https://github.com/gotgenes/pi-permission-system/blob/main/docs/guides/permission-frontmatter-for-subagent-extensions.md) for full details

No code changes, no new dependency, no schema enforcement.

## References

- [Convention guide](https://github.com/gotgenes/pi-permission-system/blob/main/docs/guides/permission-frontmatter-for-subagent-extensions.md)
- [Subagent integration docs](https://github.com/gotgenes/pi-permission-system/blob/main/docs/subagent-integration.md)
- [Cross-extension API docs](https://github.com/gotgenes/pi-permission-system/blob/main/docs/cross-extension-api.md)
````

---

## Per-Repository Customization

### nicobailon/pi-subagents

| Placeholder          | Value                       |
| -------------------- | --------------------------- |
| `{{your-extension}}` | `pi-subagents`              |
| `{{your-key}}`       | `tools`                     |
| `{{example-value}}`  | `bash,read_file,write_file` |

### tintinweb/pi-subagents

| Placeholder          | Value              |
| -------------------- | ------------------ |
| `{{your-extension}}` | `pi-subagents`     |
| `{{your-key}}`       | `disallowed_tools` |
| `{{example-value}}`  | `write_file,bash`  |

Additional note for tintinweb: since this extension runs subagents in-process via `createAgentSession()`, mention the [service accessor](https://github.com/gotgenes/pi-permission-system/blob/main/docs/cross-extension-api.md#service-accessor) as an optional runtime integration path for querying policy without spawning a subprocess.

### HazAT/pi-interactive-subagents

| Placeholder          | Value                      |
| -------------------- | -------------------------- |
| `{{your-extension}}` | `pi-interactive-subagents` |
| `{{your-key}}`       | `deny-tools`               |
| `{{example-value}}`  | `write_file,bash`          |

Additional note for HazAT: this extension already uses `PI_DENY_TOOLS` env var for subprocess tool denial.
The `permission:` frontmatter provides the same effect via `tool_name: deny` but adds `ask` as an intermediate option and covers surfaces beyond tools.
