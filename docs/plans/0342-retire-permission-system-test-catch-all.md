---
issue: 342
issue_title: "Retire the permission-system.test.ts catch-all"
---

# Retire the `permission-system.test.ts` catch-all

## Problem Statement

`test/permission-system.test.ts` is a 2,785-line legacy catch-all holding ~80 flat `test()` blocks across ~10 unrelated concerns plus a dozen internal clone groups (duplicated `createToolCallHarness` / `createMockContext` / config-writing setup).
Every one of those concerns already has a dedicated, co-located test file now that the Phase 4 production refactor (Steps 1-8, [#334]-[#341]) made the collaborators independently constructable.
This step redistributes the catch-all's tests into the co-located files and deletes the emptied shell, so the suite is fully co-located and the clone groups vanish with the monolith.

## Goals

- Move every catch-all test that has a clear co-located home into that file, behavior-preserving.
- Drop catch-all end-to-end async tests that are already covered by existing handler / composition-root tests; move only genuinely-unique async cases.
- Delete `test/permission-system.test.ts` and its now-orphaned local helpers.
- Keep the full suite green at every commit (no red phase — this is a lift-and-shift, not new behavior).
- Mark roadmap Step 9 (#342) complete in `docs/architecture/architecture.md`.

## Non-Goals

- No production source changes.
  This is a test-only redistribution.
- No assertion strengthening, no new test cases, no coverage additions beyond what the catch-all already exercises.
- No refactor of the destination files' existing tests or their local helpers (e.g. `permission-manager-unified.test.ts`'s `makeManagerWithConfig` stays as-is; we reuse the shared `createManager` for moved tests rather than rewriting existing ones).
- No consolidation of `createManager` vs `makeManagerWithConfig` — that is a separate fixture-hygiene concern.

## Background

Relevant existing modules and their co-located test files:

- Shared fixtures live in `test/helpers/` (`manager-harness.ts` `createManager`, `make-fake-pi.ts` `makeFakePi`, `handler-fixtures.ts` `makeHandler` / `makeCtx`, `session-fixtures.ts`).
- The catch-all uses three local helpers the rest of the suite has moved past: `createToolCallHarness` (builds the whole extension via `piPermissionSystemExtension(pi)` and fires `pi.fire("tool_call", …)` end-to-end), `createMockContext`, `runToolCall`, `withIsolatedSubagentEnv`, and `createManagerWithProject`.
- The existing handler integration files (`test/handlers/external-directory-integration.test.ts`, `test/handlers/external-directory-session-dedup.test.ts`) already cover the same external-directory and session-dedup scenarios through the lighter `makeHandler` fixture.
- `test/composition-root.test.ts` (via `makeFakePi`) already covers full-factory wiring, the shutdown teardown chain, and session-state visibility end-to-end.

Constraints from AGENTS.md and the package skill that apply:

- Run the full suite (`pnpm --filter @gotgenes/pi-permission-system exec vitest run`) before each commit when shared helpers change — moving tests touches `manager-harness.ts`.
- When a roadmap step ships, append `✓ complete` to the step line in `docs/architecture/architecture.md`.
- Use Conventional Commits; test moves are `test:`.

This step depends on the full production refactor; [#341] (Step 8) is closed, so all prerequisites are met.

## Design Overview

### Two test families, two strategies

The catch-all splits cleanly by fixture:

1. Synchronous config-resolution / pure-unit tests (use `createManager`, `createManagerWithProject`, `new PermissionManager`, or no fixture at all).
   These have unambiguous co-located homes and move verbatim (imports adjusted).
2. End-to-end async tests (use `createToolCallHarness`, firing `tool_call` / `session_shutdown` through the whole extension).
   Per the issue's intent — "now that the collaborators are independently constructable, reusing the now-simpler fixtures" — these are handled drop-redundant / move-unique (decision recorded below).

### Decisions (recorded from planning interview)

- Async integration tests: drop the ones already covered by existing `makeHandler`-based handler tests and `composition-root.test.ts`; move only genuinely-unique cases, rewritten onto `makeHandler` (or `makeFakePi` for the shutdown-lifecycle case).
- Assertion fidelity: behavior-preserving, not byte-for-byte.
  When a moved test lands on a different fixture, its assertions may adapt to that fixture's shape provided the behavior under test is identical — no coverage added or dropped.

### Per-test redundancy rule for the async family

For each `createToolCallHarness` test, before moving it:

1. Grep the candidate destination handler file for an `it`/`test` asserting the same behavior (same policy state × surface × outcome).
2. If an equivalent exists, drop the catch-all test (it is one of the clone groups the issue targets).
3. If none exists, rewrite the catch-all test onto `makeHandler` in the destination handler file (or `makeFakePi` in `composition-root.test.ts` when it needs the full session-shutdown lifecycle).

Presumptive redundancy from the inventory (verified during execution, not assumed):

- `external_directory` `tool_call` integration (5 tests, lines 1801-1934) — covered by `external-directory-integration.test.ts` (path scope, allow/deny/ask, confirmation-unavailable).
- bash `external_directory` integration (5 tests, lines 1935-2057) — covered by `external-directory-integration.test.ts` + `bash-external-directory.test.ts`.
- generic ask-prompt serialization (line 2060) — covered by `tool-input-preview.test.ts`.
- session approval (5 tests, lines 2179-2429) — four covered by `external-directory-session-dedup.test.ts`; one (`session_shutdown clears session approvals`, line 2287) exercises the shutdown-clears lifecycle end-to-end and is the likely-unique case → rewrite onto `makeFakePi` in `composition-root.test.ts` (its `shutdown teardown chain` describe) only if no equivalent already asserts re-prompt-after-shutdown.

### Promoted fixture

`createManagerWithProject` (catch-all local, lines 1118-1171) is used by five moved project-scope tests.
Promote it to `test/helpers/manager-harness.ts` alongside `createManager`, mirroring its signature (`config`, `agentFiles`, `options` with `projectConfig` / `projectAgentFiles`), returning `{ manager, cleanup }`.
This is a test fixture, not a production seam — no Tell-Don't-Ask or Law-of-Demeter concern, and no production interface changes, so the `design-review` checklist does not apply.

## Module-Level Changes

New files:

- `test/status.test.ts` — home for `getPermissionSystemStatus` (1 test).
- `test/logging.test.ts` — home for `createPermissionSystemLogger` debug-toggle / review-log-default (1 test).
- `test/before-agent-start-cache.test.ts` — home for `shouldApplyCachedAgentStartState` / `createActiveToolsCacheKey` / `createBeforeAgentStartPromptStateKey` (2 tests).

Changed (tests appended; imports extended only as needed):

- `test/helpers/manager-harness.ts` — add and export `createManagerWithProject`.
- `test/yolo-mode.test.ts` — yolo auto-approve, `canResolveAskPermissionRequest`, yolo-bypasses-delegated-ask (3 tests).
- `test/system-prompt-sanitizer.test.ts` — sanitizer removal cases (3 tests).
- `test/skill-prompt-sanitizer.test.ts` — multi-block regression tests (3 tests).
- `test/tool-registry.test.ts` — `getToolNameFromValue` / `checkRequestedToolRegistration` (2 tests).
- `test/permission-forwarding.test.ts` — forwarding target resolution, routing, sentinel rejection (6 tests).
- `test/permission-manager-unified.test.ts` — the largest bucket: built-in / bash / mcp / skill / tool resolution, `getToolPermission`, `external_directory` config resolution + frontmatter pattern maps, `PI_CODING_AGENT_DIR`, `getConfigIssues`, project/per-agent scope precedence, and session-aware `checkPermission` source-`session` tests (~50 tests, routed into existing `describe` blocks).
- `test/config-store.test.ts` — `getResolvedPolicyPaths` files-exist / files-missing (2 tests).
- `test/handlers/external-directory-integration.test.ts` and/or `test/handlers/external-directory-session-dedup.test.ts` — only genuinely-unique async cases, rewritten onto `makeHandler`.
- `test/composition-root.test.ts` — the shutdown-clears-approvals case if unique.
- `docs/architecture/architecture.md` — append `✓ complete` to the Step 9 (#342) line.

Removed:

- `test/permission-system.test.ts` — deleted, along with its orphaned local helpers (`createToolCallHarness`, `createMockContext`, `runToolCall`, `withIsolatedSubagentEnv`, `createManagerWithProject`, `createToolCallHarness` types, the trailing `PermissionState` no-op import suppressor at line 2783).

## Test Impact Analysis

This issue is itself a test-cleanup, so the three lenses read as:

1. New lower-level tests enabled: none beyond relocation.
   The collaborators are already independently tested in their co-located files; this step removes the duplicate higher-level catch-all coverage, it does not add a layer.
2. Tests that become redundant: the ~16 end-to-end async tests in the external-directory, bash-external-directory, generic-ask, and session-dedup clone groups, which the existing `makeHandler` / `makeFakePi` handler and composition-root tests already cover.
   These are dropped, not moved.
3. Tests that must stay (as moved, not dropped): every synchronous config-resolution test (built-ins, bash, mcp, skill, tool, scope precedence, external_directory policy, session-rule source derivation, forwarding, sanitizers, cache, logger, status).
   They genuinely exercise the `PermissionManager` / pure-function layers and have no equivalent in the destination files; they move verbatim.

## Migration Order (move → verify → commit)

There is no red phase: the suite stays green throughout.
Each step moves a concern, runs the full suite (`pnpm --filter @gotgenes/pi-permission-system exec vitest run`), and commits.
Recommend executing with `/build-plan` rather than `/tdd-plan` — there are no failing-test cycles.

1. New homeless-module files — create `status.test.ts`, `logging.test.ts`, `before-agent-start-cache.test.ts`; move their 4 tests.
   `test: co-locate status, logging, and before-agent-start-cache tests (#342)`
2. Sanitizer concerns — move the 3 system-prompt-sanitizer tests and 3 skill-prompt-sanitizer regression tests into their existing files.
   `test: co-locate system-prompt and skill-prompt sanitizer tests (#342)`
3. Yolo + tool-registry + forwarding — move yolo (3), tool-registry (2), and permission-forwarding (6) tests.
   `test: co-locate yolo, tool-registry, and forwarding tests (#342)`
4. Promote `createManagerWithProject` + move scope-precedence tests — add the helper to `manager-harness.ts`; move the 5 project/per-agent precedence tests into `permission-manager-unified.test.ts`'s multi-scope `describe`.
   `test: promote createManagerWithProject; co-locate scope-precedence tests (#342)`
5. Move surface-resolution tests into unified — built-ins / bash / mcp / skill / tool / `getToolPermission` / `external_directory` config + frontmatter pattern maps / `PI_CODING_AGENT_DIR` / `getConfigIssues` (~30 tests) into the matching `describe` blocks, reusing `createManager`.
   `test: co-locate PermissionManager surface-resolution tests (#342)`
6. Move session-aware `checkPermission` tests into unified — the source-`session` tests (~13) into the existing `checkPermission — session rules` describe.
   `test: co-locate session-aware checkPermission tests (#342)`
7. Move `getResolvedPolicyPaths` tests — into `config-store.test.ts` (2 tests).
   `test: co-locate getResolvedPolicyPaths tests (#342)`
8. Resolve the async family — for each `createToolCallHarness` test, apply the drop-redundant / move-unique rule; rewrite any unique case onto `makeHandler` (handler files) or `makeFakePi` (`composition-root.test.ts`).
   `test: redistribute or drop end-to-end tool_call tests (#342)`
9. Delete the shell — remove `test/permission-system.test.ts` and confirm no orphaned helpers remain; run `pnpm run check`, `pnpm run lint`, the full suite, and `pnpm fallow dead-code`; append `✓ complete` to the Step 9 line in `architecture.md`.
   `test: delete the permission-system.test.ts catch-all (#342)`

## Risks and Mitigations

- Re-introducing duplication by moving a redundant async test instead of dropping it.
  Mitigation: the per-test grep-the-destination rule in step 8; `pnpm fallow dead-code` / duplication check in step 9.
- Losing end-to-end coverage by dropping an async test whose behavior is only superficially covered.
  Mitigation: drop only when an existing destination test asserts the same policy-state × surface × outcome; otherwise rewrite, do not drop.
- Orphaned local helpers left behind after the shell is partially emptied.
  Mitigation: defer all helper deletion to the final step (step 9) where the whole file is removed; fallow confirms no dangling references.
- Helper drift between `createManager` and the unified file's `makeManagerWithConfig`.
  Mitigation: moved tests use the shared `createManager`; existing unified tests are untouched (Non-Goal).
- A moved test relies on the catch-all's `withIsolatedSubagentEnv` env isolation.
  Mitigation: only the forwarding tests touch subagent env; verify they pass under the destination file's setup, adding local isolation if the destination lacks it.

## Open Questions

- Exact destination for the unique `session_shutdown clears session approvals` case — `composition-root.test.ts` (full lifecycle via `makeFakePi`) vs a handler-level rewrite.
  Defer to step 8; pick whichever already has the shutdown-firing harness so no new fixture is introduced.
- Whether `getResolvedPolicyPaths` belongs in `config-store.test.ts` or `policy-loader.test.ts` (both already exercise it).
  Defer to step 7; route to whichever already drives a real `PermissionManager` with on-disk config.

[#334]: https://github.com/gotgenes/pi-packages/issues/334
[#341]: https://github.com/gotgenes/pi-packages/issues/341
