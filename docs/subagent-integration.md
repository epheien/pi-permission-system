# Subagent Integration

## Native integration with `@gotgenes/pi-subagents`

[`@gotgenes/pi-subagents`](https://github.com/gotgenes/pi-subagents) is the only subagent extension with native permission-system integration.
It publishes a child-execution lifecycle on `pi.events`; this package subscribes (see `src/authority/subagent-lifecycle-events.ts`) and registers every in-process child session with the `SubagentSessionRegistry` on the `subagents:child:session-created` event — emitted before `bindExtensions()` fires — and unregisters it on `subagents:child:disposed`.
Because the event bus dispatches synchronously, the synchronous registration completes before binding proceeds.
This inverts the former dependency direction: the core no longer looks up this package's service ([ADR-0002] / pi-subagents [#261]).

The `SubagentSessionRegistry` is backed by a process-global singleton (`globalThis` + `Symbol.for()`), accessed via `getSubagentSessionRegistry()` in `src/authority/subagent-registry.ts`.
This is necessary because each session's `ResourceLoader` creates its own `pi.events` bus: the parent emits `subagents:child:session-created` on the parent's bus, and only the parent's permission-system instance receives it.
The child's jiti instance runs on a separate bus and never receives the event — but because both instances call `getSubagentSessionRegistry()`, they share the same store, so the parent's registration is visible to the child.

The integration enables:

1. **Deterministic child detection** — `isSubagentExecutionContext()` hits the process-global registry on the first check, no env-var or filesystem heuristics needed.
2. **Per-agent policy enforcement** - the permission system's `before_agent_start` handler resolves the agent name from the `<active_agent>` system-prompt tag and applies per-agent `permission:` frontmatter overrides.
3. **`ask`-state forwarding** - when a child triggers an `ask` permission, the request forwards to the parent session's UI through the existing polling mechanism.
   The parent approves or denies, and the child resumes.
   When the parent approves "for this session," it chooses a scope: **this subagent only** (the least-privilege default) records the grant on the requesting child, while **the whole session** records it on the serving parent so the parent and all its subagents resolve it without re-prompting.

No configuration is required - the integration is automatic when both extensions are installed.
When `@gotgenes/pi-permission-system` is not installed, `@gotgenes/pi-subagents` emits its lifecycle events with no subscriber - a harmless no-op.

## Permission Forwarding

When a delegated or routed subagent runs without direct UI access, `ask` permissions can still be enforced by forwarding the confirmation request through Pi session directories.
The main interactive session polls for forwarded requests, shows the confirmation prompt, writes the response, and the subagent resumes once that decision is available.
A parent `allow`/`deny` rule governs a child's escalation directly (the serving node resolves it as recorded authority before prompting), and a "whole session" grant recorded on the parent auto-approves later forwards of the same pattern.

This keeps `ask` policies usable even when the original permission check happens inside a non-UI execution context.

For in-process child sessions, detection and forwarding use the event-driven registration described above.

---

## Coexistence with Other Subagent Extensions

Subagent extensions implement their own tool restriction mechanisms.
These compose correctly with the permission system because the two operate at different layers: **visibility** (subagent extension) and **policy** (permission system).

### The Two-Layer Model

```text
┌─────────────────────────────────────────────────────┐
│  Layer 1 - Visibility  (subagent extension)          │
│  Controls which tools are registered / active        │
│  before the agent session starts.                    │
├─────────────────────────────────────────────────────┤
│  Layer 2 - Policy  (pi-permission-system)            │
│  Controls allow / ask / deny decisions on every      │
│  tool call, bash command, MCP operation, etc.        │
└─────────────────────────────────────────────────────┘
```

### Known Subagent Extensions

| Extension                                                                           | Type       | Permission integration           | Frontmatter key                    |
| ----------------------------------------------------------------------------------- | ---------- | -------------------------------- | ---------------------------------- |
| [@gotgenes/pi-subagents](https://github.com/gotgenes/pi-subagents)                  | in-process | ✓ Native (registry + forwarding) | `disallowed_tools:` (CSV denylist) |
| [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)                 | in-process | ✗ No registration                | `disallowed_tools:` (CSV denylist) |
| [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)               | subprocess | ✗ Missing env vars               | `tools:` (CSV allowlist)           |
| [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) | subprocess | ✗ Missing env vars               | `deny-tools:` (CSV denylist)       |

Process-based subagent extensions (nicobailon, HazAT) spawn child processes but do not set the `PI_SUBAGENT_PARENT_SESSION` env var that the permission system needs for `ask`-state forwarding.
Without that env var, `ask` permissions in child processes are auto-denied.
See [guides/permission-frontmatter-for-subagent-extensions.md](guides/permission-frontmatter-for-subagent-extensions.md) for the convention that subagent extension authors should follow.

The upstream `tintinweb/pi-subagents` (which `@gotgenes/pi-subagents` forks) does not publish the `subagents:child:session-created` lifecycle event, so it lacks deterministic child detection and `ask`-state forwarding.

### Interaction Rules

1. **Hidden tool → permission system never sees it.**
   If a subagent extension removes a tool from the active set, the permission system receives no registration or call event for that tool.
   The permission policy for that tool is irrelevant - it is already gone.

2. **Denied tool → hidden regardless of the subagent extension's allowlist.**
   If the permission system denies a tool (via `deny` policy or tool filtering), it is removed from the active set before the agent starts.
   A `tools:` allowlist in a subagent extension cannot restore a tool that the permission system has already hidden.

3. **The two denylist mechanisms are additive, not conflicting.**
   A tool blocked by either layer stays blocked.
   Neither layer can silently re-enable what the other has blocked.

### `permission:` Frontmatter is Exclusive to This Extension

The `permission:` key in an agent's YAML frontmatter is read exclusively by `pi-permission-system`.
It has no interaction with the `tools:`, `disallowed_tools:`, or `deny-tools:` keys consumed by subagent extensions.
You can freely use both in the same agent file:

```yaml
---
# Subagent extension: allow only bash and read in the child session
tools: bash,read
# pi-permission-system: still enforce ask on bash within those allowed tools
permission:
  bash: ask
---
```

In this example the subagent extension restricts visibility to `bash` and `read`, and the permission system then gates every `bash` call with an `ask` prompt - both rules apply independently.

[ADR-0002]: https://github.com/gotgenes/pi-packages/blob/main/packages/pi-subagents/docs/decisions/0002-extensions-on-a-minimal-core.md
