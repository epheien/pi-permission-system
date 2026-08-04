---
issue: 302
issue_title: "Child subagent shutdown unpublishes the parent's global PermissionsService"
---

# Retro: #302 — Child subagent shutdown unpublishes the parent's global PermissionsService

## Stage: Planning (2026-06-01T00:00:00Z)

### Session summary

Investigated the process-global `PermissionsService` slot bug surfaced by the `#297` composition-root suite and produced `docs/plans/0302-child-shutdown-preserves-parent-service.md`.
The fix defers `publishPermissionsService` from factory-init to a child-gated `session_start`, moves `emitReadyEvent` alongside it, and makes `unpublishPermissionsService` identity-scoped (compare-and-delete).
Plan is structured as four TDD steps: extract `isRegisteredSubagentChild`, breaking `unpublishPermissionsService` signature, the `session_start` publish gate, then docs.

### Observations

- Key constraint: the factory has **no `ctx` at init**, so an in-process child cannot be distinguished from a reloaded parent at init (both look like "slot already occupied").
  The registry signal needs a session id, which first appears at `session_start` — this forced the publish to move there, which in turn forced `permissions:ready` to move to preserve the `#297` ordering contract.
- Decided to gate on the **registry-only** `isRegisteredSubagentChild`, not the full `isSubagentExecutionContext`.
  The env/filesystem branches identify process-based subagents (own OS process, own `globalThis`) which *should* publish; only the registry branch marks an in-process child sharing the parent's `globalThis`.
- Rejected a stash/restore alternative (child captures the previous slot at init, restores it at `session_start`) — it is unsound under concurrent sibling children, where one sibling's restore writes back another sibling's service instead of the parent's.
- Chose identity compare-and-delete over a `didPublish` boolean for teardown: the boolean is unsafe if `/reload` re-runs the factory and the old instance's `session_shutdown` fires after the new instance's `session_start` re-publish.
  Identity comparison is order-independent.
- `ask_user` confirmed two decisions: move `permissions:ready` to `session_start` (recommended), and identity compare-and-delete with the maintainer's note "favor the breaking change if it makes a cleaner design" — so `unpublishPermissionsService` takes a **required** param (`feat!:`), not an optional one.
- Package public surface is only `src/service.ts` (the `.` export), which is why the signature change is genuinely public/breaking.
  Sole `src/` caller is the `index.ts` cleanup closure; consumers use only `getPermissionsService()`.
- Doc updates identified: `service.ts`, `permission-events.ts`, `docs/cross-extension-api.md` (events table + Ready Event section + reload notes), `docs/architecture/architecture.md`.
  Re-grep the package skill before the docs commit.

## Stage: Implementation — TDD (2026-06-01T14:00:00Z)

### Session summary

Executed all four TDD cycles from the plan: extract `isRegisteredSubagentChild` (`refactor:`), identity-scoped `unpublishPermissionsService` (`feat!:`), defer publish + `emitReadyEvent` to a child-gated `session_start` (`fix:`), and doc alignment (`docs:`).
Test count went from 1668 pass + 1 expected-fail to 1674 pass (the `it.fails` DESIRED test was replaced by a real passing assertion; net +5 new tests).
Final state: `check`, `lint`, `test`, and `pnpm fallow dead-code` (repo root) all green; lockfile unchanged.

### Observations

- Two extra tests beyond the plan's list assumed ready-at-load and broke under the moved timing: `composition-root.test.ts` "service and gate share one formatter registry" (resolved the service right after the factory) and `permission-events.test.ts` "ready event wiring" (bespoke fake `pi`).
  Both were updated to fire `session_start` first; noted in the `fix:` commit body.
  The planning sweep listed the two `composition-root` tests it knew about but missed these two because the grep focused on `getPermissionsService` call sites in `composition-root.test.ts` only — a wider grep across all test files for post-factory service resolution would have caught them during planning.
- The new constructor-dep order chosen for `SessionLifecycleHandler` is `(session, activateService, cleanupRpc)`, matching the plan snippet; the sole production instantiation and the `lifecycle.test.ts` `makeHandler` were updated in the same `fix:` commit (type-level break).
- The multi-instance characterization test was consolidated into one comprehensive test (`keeps the parent's service published across the child's lifecycle`) asserting identity (`toBe(parentService)`) at mid-run and after the child's shutdown — stronger than the plan's separate "survives" + "mid-run" assertions.
- Firing `session_start` through the real `SessionLifecycleHandler` in composition-root tests required a `ctx` with `cwd` (a real tmpdir, for `createPermissionManagerForCwd`), `sessionManager.getSessionId/getSessionDir/getEntries`, and `ui.setStatus`; the existing `makeChildCtx` / `makeUiCtx` helpers supplied these without modification.
- Pre-completion reviewer: WARN (no blocking issues).
  Reviewer warnings: (1) `isRegisteredSubagentChild` accepts the full `ExtensionContext` but reads only `getSessionId()` — left as-is for ISP consistency with the sibling `isSubagentExecutionContext` in the same file; (2) `activateServiceForSession` both publishes and emits ready — left as one closure since the two are co-temporal (ready must follow publish) and live at the composition root.

## Stage: Final Retrospective (2026-06-01T18:10:44Z)

### Session summary

Shipped issue #302 end-to-end across three stages (plan → TDD → ship) with zero rework commits and zero CI failures.
The fix scopes the process-global `PermissionsService` slot to the publishing instance: publish defers to a child-gated `session_start`, `permissions:ready` moves alongside it, and `unpublishPermissionsService(service)` becomes an identity compare-and-delete.
Released as `pi-permission-system-v9.0.0` (major bump for the `feat!:` signature change).

### Observations

#### What went well

- The cross-issue `it.fails` handoff worked exactly as the #297 suite designed it: the `it.fails("DESIRED: the parent's service survives a child's shutdown")` characterization test planted by #297 flipped to a real passing assertion in this fix, validating test-driven continuity between sibling issues.
- One `ask_user` call in planning bundled the two genuinely-coupled design decisions (`permissions:ready` timing + teardown mechanism) and the maintainer's reply ("favor the breaking change if it makes a cleaner design") directly shaped the design toward a required param over a muddier optional one.
- Verification ran incrementally, not just at the end: each TDD step ran its affected test file (red then green) plus `pnpm run check`, with the full suite re-run after the shared-signature step (2) and the wiring step (3).
  The runtime-breaking test (see friction) was caught by the post-step-3 full-suite run, not deferred to ship.

#### What caused friction (agent side)

- `missing-context` — the plan's Test Impact Analysis under-counted affected tests.
  The planning grep keyed on specific test names in `composition-root.test.ts` rather than on the behavior "resolves the service right after the factory," so it missed `composition-root.test.ts` "service and gate share one formatter registry" and `permission-events.test.ts` "ready event wiring" — both assumed ready/publish-at-load.
  Impact: two extra test updates folded into the `fix:` commit; no extra commits and no CI failures because the full-suite run caught them, but the plan's Test Impact Analysis was incomplete.
  These break at runtime (full suite), not at typecheck, so `pnpm run check` would never have flagged them.

#### What caused friction (user side)

- None material.
  The maintainer's breaking-change tolerance arrived at the right moment (the planning `ask_user`) and unblocked the cleaner design; stating that tolerance as a standing repo norm would have pre-empted the question, but that is a minor optimization, not friction.

### Diagnostic details

- **Model-performance correlation** — the only subagent dispatch was the `pre-completion-reviewer` on `anthropic/claude-sonnet-4-6`, a reasoning-capable model appropriate for judgment-heavy review (acceptance criteria, code design, doc staleness).
  No mismatch.
- **Escalation-delay tracking** — no `rabbit-hole` friction points; no error sequence exceeded one tool call before resolution.
- **Unused-tool detection** — no tool gap.
  The grep miss was a scope-of-query problem (symbol-name grep vs. behavioral grep), not a missing tool; `colgrep` for "tests that consume the published service" could have surfaced the two missed tests during planning.
- **Feedback-loop gap analysis** — no gap; verification was incremental (per-step affected file + `check`, full suite after the two highest-risk steps).
  This is the intended loop, not a deferral.

### Changes made

1. `.pi/skills/testing/SKILL.md` — added a TDD-planning rule: when a change moves *when* a value/service becomes available (e.g. factory-init → `session_start`), grep all test files for consumers that resolve it, since the break is at runtime (full suite), not at typecheck.
