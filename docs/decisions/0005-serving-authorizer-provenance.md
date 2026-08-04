---
status: accepted
date: 2026-07-09
---

# 0005 — Serving a forwarded permission is resolution; provenance rides the ask

## Status

Accepted.

## Context

A subagent with no UI escalates an `ask` decision up the tree by writing a forwarded-permission request file; the parent (serving) session drains its inbox and answers each request.
Before this decision, the serving node answered with bespoke logic — its own yolo check (the last one outside the composed ruleset) and a direct UI dialog — and never ran `evaluate()`.
So a parent `allow`/`deny` rule could not govern a child's escalation: the parent was prompted for actions its own policy had already decided ([#557], Phase 9 resolved direction 1).

Rerouting the prompt naively through the serving session's selected `Authorizer` (`LocalUserAuthorizer`) would have silently re-degraded the `permissions:ui_prompt` broadcast to `forwarding: null`, reversing the deliberate [#292] contract hardening (`docs/cross-extension-api.md`: "Forwarded prompts are not degraded"), which no in-monorepo consumer exercises and a green test suite would not catch.

## Decision

Serving a forwarded request is identical to resolving a local action:

1. **Recorded authority first.**
   A request carrying a concrete `(surface, value)` display projection resolves against the serving node's composed ruleset via a narrow `ServingPolicy.check(surface, value)` seam (an access-intent build plus `resolver.resolve`, the same primitives `LocalPermissionsService` composes).
   `allow` (including a yolo-rewritten `allow`) auto-approves; `deny` auto-denies.
2. **Escalate `ask`.**
   An `ask`, or a request without display fields, escalates through the `AskEscalator` seam to the serving session's selected `Authorizer` — the human at the root today, a further hop up once multi-hop lands.
3. **Provenance is data on the ask, not a second emission path.**
   The escalated ask carries its forwarded provenance (requester agent/session, the child's original `source`/`surface`/`value`) as fields on `PromptPermissionDetails`.
   `LocalUserAuthorizer` — now the single `permissions:ui_prompt` emit site — renders it (populated `forwarding` context, the child's display projection, the "(Subagent)" dialog title), so the broadcast stays non-degraded ([#292]) with no server-side emission.

The serving node's yolo check and its `ConfigReader` dependency are removed; yolo inheritance falls out of the yolo-rewritten ruleset for free (a yolo `ask`→`allow` rewrite auto-approves at step 1, an explicit `deny` survives it).

### Base ruleset (agent-neutral resolution)

`ServingPolicy.check` resolves with `agentName` undefined — the serving node's own base policy.
The requesting subagent's agent name is display-only.
Rationale: the child already applied its own per-agent overrides before forwarding, and cross-session agent-name semantics are undefined until principal identity lands in the access-intent domain.
Revisited post-ship in [#565].

### Rejected alternatives

- **Server-side event emission with a decision-only `Authorizer` call.**
  Rejected: it splits the emit-then-dialog pairing `LocalUserAuthorizer` owns, needs an emit-suppressed `authorize` variant (a genuine control flag), and keeps two `permissions:ui_prompt` emit sites that can drift.
- **A per-request decorator `Authorizer` that adds forwarding presentation.**
  Rejected: authorizers are selected once per session; a per-request decorator is the same data flow dressed in object ceremony.
- **Route `ask` through the `Authorizer` and accept the degraded broadcast.**
  Rejected: it reverses the [#292] hardening for the exact consumer (notification extensions) it was built for, undocumented as a considered trade-off.

## Consequences

- Parent `allow`/`deny` rules govern children's escalations; a recorded `allow` suppresses the prompt, a recorded `deny` auto-denies.
- An explicit `deny` now wins under yolo on the serving path (previously the bespoke yolo check approved everything), matching documented yolo semantics.
- A legacy/version-skew request without `(surface, value)` escalates to a prompt instead of auto-approving under yolo — the fail-safe direction; the fields have been carried since [#292].
- A request the recorded policy decides emits no `permissions:ui_prompt`; the event fires only when a human is about to be asked (the notify-now contract's intent).
- An escalated forwarded ask now also flows through the `PermissionPrompter` bracketing (`permission_request.waiting`/`approved`/`denied`) alongside the serving lifecycle's `forwarded_permission.*` entries — the uniform-escalation shape [#556] chose.

### Accepted limitations

- **Single-surface re-resolution is best-effort.**
  A forwarded request carries one `(surface, value)` pair, so the serving node cannot perfectly reproduce a child decision that layered multiple surfaces (e.g. an `external_directory` check over a `path`).
  An imperfect resolution lands on `ask` → prompt, never a silent grant.
- **No real notification consumer exercises the non-degraded broadcast in-repo.**
  The [#292] fidelity is pinned by unit tests (the `LocalUserAuthorizer` forwarded-details render plus the server's details mapping) but not an end-to-end consumer.

Post-ship validation of all three — base-agent-scope, single-surface fidelity, and real-consumer fidelity — is tracked in [#565].

[#292]: https://github.com/gotgenes/pi-packages/issues/292
[#556]: https://github.com/gotgenes/pi-packages/issues/556
[#557]: https://github.com/gotgenes/pi-packages/issues/557
[#565]: https://github.com/gotgenes/pi-packages/issues/565
