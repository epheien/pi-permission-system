---
issue: 221
issue_title: "Expose subagent session registry and tool-level permission query on PermissionsService"
---

# Retro: #221 — Expose subagent session registry and tool-level permission query

## Stage: Planning (2026-05-25T18:00:00Z)

### Session summary

Filed issue #221 as a prerequisite for #101 (native permission-system awareness for in-process subagents).
Explored both `pi-permission-system` and `pi-subagents` in depth to identify the exact friction points blocking #101, then designed the registry approach and wrote the implementation plan.

### Observations

- The filesystem-based detection path (`subagentSessionsDir`) is fundamentally incompatible with pi-subagents' session directory layout (`<parent-dir>/<basename>/tasks/` vs `<agentDir>/subagent-sessions/`).
  This isn't a configuration issue — the path structures serve different purposes and cannot be aligned without breaking one package's conventions.
- `PermissionManager.getToolPermission()` already exists with clean semantics; exposing it on the service is a trivial one-line delegation.
  The real work is threading the registry through detection and forwarding.
- The `resolvePermissionForwardingTargetSessionId` function currently lacks `sessionDir` in its options — the registry lookup requires adding this parameter, which cascades through `confirmPermission` and `waitForForwardedPermissionApproval`.
  Steps 3–5 in the TDD order handle this cascade incrementally.
- Session originally started as planning for #101, but pivoted to filing and planning #221 after identifying that pi-permission-system prep work would make #101 trivial.
  Issue #101's plan is deferred until #221 is implemented.

## Stage: Implementation — TDD (2026-05-25T19:30:00Z)

### Session summary

Completed all 6 TDD steps: `SubagentSessionRegistry` class, `PermissionsService` interface extension, registry-aware subagent detection, registry-aware forwarding target resolution, threading the registry through runtime, and documentation.
Test count increased from 1,467 to 1,494 (+27 tests across 2 new and 3 updated test files).

### Observations

- The plan listed `src/runtime.ts` as a file to modify (add `subagentRegistry` to `ExtensionRuntime`), but keeping the registry as a local variable in `index.ts` was cleaner — `ExtensionRuntime` only needs fields that handlers and other modules read, not composition-root-only wiring.
  Deviation noted; no behaviour change.
- The `makeService()` helper in `service.test.ts` needed updating to include all new interface methods before the existing `checkPermission`-only inline constructions would typecheck.
  The lift-and-shift was clean: update the helper, then migrate inline objects one by one.
- `noInvalidUseBeforeDeclaration` lint error caught that `subagentRegistry` was declared after its first use in `index.ts` (after `permissionsService`, but `prompter` and `forwardingDeps` needed it earlier).
  Fixed by hoisting the declaration to just after `createExtensionRuntime()`.
- `ctx.sessionManager.getSessionDir()` returns `string | undefined` (not `null`), so `?? undefined` was redundant and caught by `@typescript-eslint/no-unnecessary-condition`.
  Removed in the same commit.
