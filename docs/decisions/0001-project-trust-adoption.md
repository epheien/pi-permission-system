---
status: accepted
date: 2026-06-12
---

# 0001 — Adopt `ctx.isProjectTrusted()` to guard project-local config loading

## Status

Implemented in #644.
The fix landed the guard in `handleSessionStart` and `handleResourcesDiscover` as decided below, and extended it beyond the originally-scoped permission-policy path: the extension **runtime** config load (`ConfigStore.refresh` → `loadAndMergeConfigs`, which merges project `yoloMode` / `permissionReviewLog` / …) is gated on trust too, and so is the `before_agent_start` mid-session `refreshConfig`.
A skip is surfaced loudly (UI warning + a `project_trust.skipped` review-log entry).
See `docs/migration/0644-project-trust-gating.md`.

## Context

Pi SDK 0.79.x introduced a project-trust system with three extension-facing APIs:

- **`project_trust` event** — fired before project-local resources are loaded by Pi.
  Global/CLI extensions can handle it to decide, remember, or defer trust (`"yes" | "no" | "undecided"`).
- **`ctx.isProjectTrusted()`** — available on the `ExtensionContext` passed to all event handlers, including `session_start`.
  Returns the effective trust decision (including any temporary or remembered decision).
- **`defaultProjectTrust` global setting** (0.79.1) — configures whether unresolved trust automatically asks, always trusts, or never trusts.

`pi-permission-system` currently loads project-local permission config in `handleSessionStart`:

```typescript
// handlers/lifecycle.ts
handleSessionStart(event: SessionStartPayload, ctx: ExtensionContext): Promise<void> {
  this.session.refreshConfig(ctx);     // calls permissionManager.configureForCwd(ctx.cwd)
  // ... which calls loader.loadProjectConfig()  → reads {cwd}/.pi/settings.json
  //                   loader.loadProjectAgentConfig() → reads {cwd}/.pi/agents/*.md
```

This load happens unconditionally — the extension never queries `ctx.isProjectTrusted()`.

### Trust gap

The `permission-manager` merges config scopes lowest → highest precedence: `global` → `project` → `project-agent`.

Because project scope has higher precedence than global, a malicious `.pi/settings.json` in an untrusted repository could set patterns such as `"*": "allow"` and override the operator's global restrictions.
If a developer opens Pi in a checked-out directory from an untrusted source, the project permission config is loaded and applied without any trust gate.

This is inconsistent with Pi's own trust model: Pi uses `project_trust` to decide whether to load project-local skills, prompts, and agents.
`pi-permission-system` has its own read path to the same directory and bypasses that decision.

### Timing

The `project_trust` event fires before `session_start`.
By the time `handleSessionStart` is called, `ctx.isProjectTrusted()` already reflects the resolved decision — including any `defaultProjectTrust` override.
If the user grants trust after initial load, Pi fires `resources_discover` with `reason: "reload"`, which `handleResourcesDiscover` already handles by calling `session.reload()`.
This means the fix does not require a new event handler.

## Decision

**Adopt `ctx.isProjectTrusted()` in `handleSessionStart` and `handleResourcesDiscover`.**
When the project is not trusted, skip loading project-scoped permission config (project and project-agent layers).
The reload path already re-calls `configureForCwd`, so trust granted after startup picks up the project config on the next `resources_discover reload` cycle.

This is a behavior change: users who open Pi in an untrusted directory will see only global permission config until they grant trust.
The implementation is straightforward but must:

1. Guard `configureForCwd` / project-layer loading in `handleSessionStart` with `ctx.isProjectTrusted()`.
2. Verify the existing `handleResourcesDiscover` reload path picks up project config after trust is granted.
3. Add tests for the untrusted-project load path and the trust-grant reload.
4. Include a changelog entry that describes the behavior change.

No changes to the `project_trust` event handler are needed: `pi-permission-system` has no opinion about *how* trust is resolved (that is Pi's and the user's concern).
It only needs to *observe* the outcome via `ctx.isProjectTrusted()`.

## Implementation scope

Implemented in #644 with its own TDD cycles and a migration note (`docs/migration/0644-project-trust-gating.md`).

## Alternatives considered

**Listen to `project_trust` and decide trust actively.**
`pi-permission-system` could register a `project_trust` handler and return `"yes"` or `"no"` based on its own heuristics (e.g., whether a `.pi/settings.json` exists).
Rejected: the extension is a policy enforcer, not a trust oracle.
Deciding trust is Pi's and the user's responsibility.
The extension should observe the decision, not make it.

**Load project config unconditionally, sanitize the merge to be restrict-only.**
Change the merge to enforce that project config can only tighten global restrictions, not expand them.
Rejected: the merge semantics are intentional — operators who want project-specific overrides in a trusted directory should be able to set them.
Sanitizing the merge would break the override use case.
The right fix is to gate loading on trust, not constrain the merge model.

**No change — current behavior is acceptable.**
Rejected: the trust gap is real.
An untrusted project can expand permissions above the global baseline.
Even though this requires the operator to actively open Pi in a malicious directory, aligning with Pi's own trust system is the correct direction now that the SDK provides the API.
