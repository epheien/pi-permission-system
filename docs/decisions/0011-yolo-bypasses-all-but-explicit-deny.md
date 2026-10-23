---
status: accepted
date: 2026-10-24
---

# 0011 — yolo bypasses every check except an explicit `deny`

## Status

Accepted.
This decision fixes what `yoloMode` means.
Before it, "yolo" was documented as an ask→allow rewrite that "preserves hard denies" — which was true of the ruleset, but not of the extension as a whole: four entry points synthesized a decision outside rule evaluation and kept blocking a yolo session.

## Context

`yoloMode` was implemented as one composition-stage rewrite: every `ask` rule in the composed ruleset becomes `allow`, tagged `origin: "yolo"`.
Explicit `deny` rules are not `ask`, so they survived — hence the summary "yolo suppresses prompts but preserves hard denies".

That summary described `PermissionManager.check` only.
Four paths decide without reaching it:

| Path                                                      | Why it escaped the rewrite                                                                                               |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| bash wrapper floor (`bash -c`, `sudo`, `env`, `xargs`, …) | `resolveBashCommandCheck` floors an `allow` to a synthetic `ask` **after** the resolver returned                         |
| unparseable bash command                                  | the same function synthesizes `{ state: "ask", matchedPattern: "<unparseable-bash-command>" }` with no evaluation at all |
| unknown / missing tool name                               | `validateRequestedTool` hard-blocks before any policy is consulted                                                       |
| internal gate failure                                     | `createFailClosedToolCall` catches the throw and hard-blocks                                                             |

For a user who deliberately turns yolo on, all four are still interruptions, and none of them can discover a `deny` rule the user wrote — the wrapper path degraded an already-decided allow, the unparseable path never evaluated, and the other two concern names/errors that no rule could match.

The alternative reading — "yolo should also override `deny`" — was rejected by the user. `deny` is the one thing a yolo session still honors.

## Decision

While yolo is on, the extension blocks a tool call **only** when it matches an explicit `deny` rule.

### What bypasses

1. Every `ask` in the composed ruleset (unchanged: rewritten to `allow`, `origin: "yolo"`).
2. The fail-closed `allow → ask` clamp for an invalid non-global scope: the clamp still runs, the rewrite then releases it.
3. The bash wrapper floor: under yolo an allowed wrapper is returned as `allow`, tagged `origin: "yolo"` so the review log records the bypass rather than a policy allow.
4. The unparseable-command sentinel: the whole command string is resolved instead.
   This is a *best-effort* `deny` check — a `deny` on a sub-command that only a successful parse would isolate cannot match.
   Accepted: yolo is an explicit opt-out, and an unparseable command cannot be decomposed.
5. Unknown / missing tool names: the call passes, recorded as `permission_request.auto_approved` with `bypassedCheck: "unregistered-tool"`, because Pi itself rejects unknown tools.
6. Internal gate failures: the boundary returns allow, and **still** writes `permission_request.blocked` with `resolution: "gate_error"` plus `yoloBypass: true`.

### What does not change

- `deny` rules, at every layer and on every surface (global, project, agent, session; `path`, `external_directory`, per-tool, `bash`, `mcp`, `skill`).
- The process-lifetime, never-persisted lifecycle; the `ctrl+alt+y` shortcut; `/permission-system yolo`; the red status-bar indicator.
- Display surfaces (`getComposedConfigRules`, `getToolPermission`) and `before_agent_start` tool injection stay yolo-free — a `deny`-ed tool is still never offered to the agent.
- The public config service surface: no new field, no compatibility switch. `yoloMode`'s meaning is upgraded in place; a second mode is not introduced.

### Auditing is part of the decision

A bypass that leaves no trace is indistinguishable from a bug.
Every path above writes a review-log entry, and `GateRunner`'s existing yolo fast path (`check.origin === "yolo"`) already emits `permission_request.auto_approved` with `resolution: "auto_approved"`.

## Consequences

- A yolo session's only enforceable guardrails are explicit `deny` rules.
  Configs that relied on `"*": "ask"` plus wrapper flooring to slow the agent down get none of that under yolo — which is the point.
- `deny` must be written as `deny`.
  A `path` or `external_directory` value of `ask` is not a guardrail under yolo.
- The unparseable-command degradation is a real gap, documented rather than papered over: `deny` matching on an unparsed string can miss a sub-command's rule.
- A mode that also overrides `deny` remains a *different*, deliberately named operation (a trailing `{ surface: "*", pattern: "*", action: "allow" }` rule).
  It is still not built, and it is still never called yolo.

Refs: #526 (yolo as recorded authority), #452 (unparseable-command sentinel), #481/#490 (wrapper floors), #646 (fail-closed clamp).
