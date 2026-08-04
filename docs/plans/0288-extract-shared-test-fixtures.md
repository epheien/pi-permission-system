---
issue: 288
issue_title: "Extract shared test fixtures to cut permission-system test duplication"
---

# Extract shared test fixtures to cut permission-system test duplication

## Problem Statement

The `pi-permission-system` test tree carries the package's single largest health-score deduction.
`fallow dupes` reports 9.1% duplication across 122 clone groups, and the clones are almost entirely repeated handler/session setup, gate-descriptor construction, and config-manager harness code copied verbatim across test files.
The same `makeCtx` / `makeSession` / `makeToolRegistry` / `makeCheckResult` factories are redefined in five-plus files, and a 120-line setup block is duplicated between the two external-directory test files.
This is mechanical copy-paste, not intentional per-file divergence, so it can be consolidated into shared fixtures without changing what any test asserts.

## Goals

- Extract the duplicated test setup into focused modules under `test/helpers/`, mirroring the `pi-subagents/test/helpers/` convention.
- Migrate the top clone families to the shared fixtures incrementally, one family per commit, keeping the full suite green at every step.
- Reduce `fallow dupes` clone-group count and the duplication deduction in the package health score.
- Preserve every existing assertion — this is a pure test refactor with the existing suite as the safety net.

## Non-Goals

- No production-code changes under `src/`.
  This work is orthogonal to the decomposition issues (#285–#289) and touches only `test/`.
- No co-located helper tests.
  The factories are simple object builders exercised transitively by the migrated suites; we do not add `test/helpers/*.test.ts` files (unlike pi-subagents).
- No attempt to eliminate every one of the 122 clone groups.
  We target the named families; long-tail single-line clones are out of scope.
- No change to the `vitest.config.ts` alias setup — `#test/*` already resolves to `test/`.

## Background

Relevant existing structure:

- `vitest.config.ts` aliases `#test` → `test/` and `#src` → `src/`; `tsconfig.json` and `package.json` mirror `#test/*` and `#src/*`.
  Shared helpers can be imported via relative paths (the pi-subagents convention) or `#test/helpers/...`.
- `pi-subagents/test/helpers/` is the established sibling convention: focused files by concern (`make-deps.ts`, `make-subagent.ts`, `mock-session.ts`, `stub-ctx.ts`, `ui-stubs.ts`).
  This plan follows the focused-files layout but omits the co-located helper tests that pi-subagents adds.

Confirmed clone families (from `fallow dupes`):

| Family             | Files                                                                                                                            | Shared factories                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Handler fixtures   | `handlers/tool-call-events.test.ts`, `handlers/tool-call.test.ts`, `handlers/input-events.test.ts`, `permission-session.test.ts` | `makeCtx`, `makeEvents`, `makeSession`, `makeToolRegistry`, `makeToolCallEvent`, `makeCheckResult`, `makeHandler` |
| External-directory | `handlers/external-directory-integration.test.ts`, `handlers/external-directory-session-dedup.test.ts`                           | the 120-line block: `makeCheckPermission`, `makeCtx`, `makeToolCallEvent`, plus handler fixtures                  |
| Gate fixtures      | `handlers/gates/runner.test.ts`, `handlers/gates/bash-path.test.ts`, `handlers/gates/path.test.ts`                               | `makeDescriptor`, `makeRunnerDeps`, `makeTcc`, `makeCheckResult`                                                  |
| Manager harness    | `permission-system.test.ts` (intra-file groups, e.g. lines 891-943)                                                              | `createManager`, extension-harness builder, config/ruleset builders                                               |
| Lifecycle setup    | `handlers/before-agent-start.test.ts`, `handlers/lifecycle.test.ts`                                                              | shared `before-agent-start` ctx/state setup                                                                       |

AGENTS.md constraints that apply:

- Lift-and-shift rule: never rewrite a large test file in one step.
  Introduce the shared fixture alongside the existing inline copies, migrate file-by-file, and delete the inline copies last.
- When a fix changes shared helper functions, run the full suite before committing (testing skill).

Critical divergence to preserve (testing skill — "diff defaults before consolidating"): the `makeCheckResult` copies do **not** share defaults.

- `handlers/gates/runner.test.ts`: `{ state, toolName: "read", source: "tool", origin: "builtin", matchedPattern: "*" }`.
- `handlers/gates/bash-path.test.ts`: `{ toolName: "path", state, source: "special", origin: "global" }` (no `matchedPattern`).
- `handlers/tool-call.test.ts` `makePermissionResult`: `{ state, toolName: "read", source: "tool", origin: "builtin" }` (no `matchedPattern`).

Per the #288 design decision, the shared factory uses **one** `makeCheckResult` with a single neutral default; each migrated call site passes the fields it currently relies on as explicit overrides so behavior is unchanged.

## Design Overview

Three focused helper modules under `test/helpers/`, plus the harness module:

- `test/helpers/handler-fixtures.ts` — handler-level mocks and builders.
- `test/helpers/gate-fixtures.ts` — gate descriptor / runner-deps / tool-call-context builders.
- `test/helpers/manager-harness.ts` — filesystem-backed `PermissionManager` harness and config builders for `permission-system.test.ts`.

`makeCheckResult` shape (single neutral default, override-driven):

```typescript
import { vi } from "vitest";
import type { PermissionCheckResult } from "#src/types";

export function makeCheckResult(
  overrides: Partial<PermissionCheckResult> = {},
): PermissionCheckResult {
  return {
    state: "allow",
    toolName: "read",
    source: "tool",
    origin: "builtin",
    ...overrides,
  };
}
```

Migration discipline: at each `makeCheckResult(...)` call site, pass exactly the fields the original local copy hard-coded.
For example, the bash-path sites migrate to `makeCheckResult({ toolName: "path", source: "special", origin: "global" })`, and runner sites that depended on `matchedPattern: "*"` pass it explicitly.

Factory signature notes (testing skill):

- Return types annotated with the production interface (`PermissionCheckResult`, `GateDescriptor`, `GateRunnerDeps`) — these are plain data builders whose callers do not need `Mock<...>` accessors on the returned object.
- `makeHandler` / `makeRunnerDeps` return objects whose `vi.fn()` members are configured by tests; keep the returned mock objects' types inferred (do not annotate the bag with the production interface) so callers retain `.mockReturnValue` access on the stub fields, matching the existing inline copies.
- Reuse the existing `Partial<...> = {}` override style already present in the inline copies — no new override semantics.

The `makeSession` variants differ slightly: `input-events.test.ts` takes a positional `state` argument, others take only an overrides bag, and `input-events` includes `createPermissionRequestId` while the others include `getInfrastructureDirs`/`getActiveSkillEntries`.
The shared `makeSession` takes an overrides bag containing the union of mocked methods (each defaulted), and the `input-events` call sites pass `checkPermission` overrides explicitly instead of a positional `state`.

Edge cases:

- `external-directory-integration.test.ts` has a documented regression guard that imports the four external-directory message helpers so the file fails to load if any is removed.
  Keep that import in the file after migration — do not move it into a helper.
- `permission-system.test.ts` mixes real filesystem harness setup (`mkdtempSync`, `writeFileSync`) with env isolation; extract only the repeated `createManager` + config-builder clones, leaving `withIsolatedSubagentEnv` and the env-key handling in place.

## Module-Level Changes

New files:

- `test/helpers/handler-fixtures.ts` — `makeCtx`, `makeEvents`, `makeSession`, `makeToolRegistry`, `makeToolCallEvent`, `makeCheckResult`, `makeHandler`, and the external-directory `makeCheckPermission` builder.
- `test/helpers/gate-fixtures.ts` — `makeDescriptor`, `makeRunnerDeps`, `makeTcc`, plus a gate-flavored `makeCheckResult` re-export or the shared one with override presets passed at the call site.
- `test/helpers/manager-harness.ts` — `createManager` and the repeated config/ruleset builders from `permission-system.test.ts`.

Changed files (remove inline copies, import from helpers):

- `test/handlers/tool-call-events.test.ts`
- `test/handlers/tool-call.test.ts`
- `test/handlers/input-events.test.ts`
- `test/handlers/input.test.ts`
- `test/permission-session.test.ts`
- `test/handlers/external-directory-integration.test.ts`
- `test/handlers/external-directory-session-dedup.test.ts`
- `test/handlers/gates/runner.test.ts`
- `test/handlers/gates/bash-path.test.ts`
- `test/handlers/gates/path.test.ts`
- `test/permission-system.test.ts`
- `test/handlers/before-agent-start.test.ts`, `test/handlers/lifecycle.test.ts` (lifecycle family — only if step 5 is in scope)

Docs:

- `docs/architecture/architecture.md` — the duplication track in the Phase 2 roadmap references this work; update the duplication figure / mark the item progressed once the families are migrated.
  Check for a clone-count or health-score table that names these test files and refresh it.

No `src/` changes, no schema/config/README changes (this issue touches no permission surface).

## Test Impact Analysis

This is a test-refactor issue, so the standard extraction questions invert:

1. New tests enabled: none required.
   The decision (#288) is to skip co-located helper tests; the migrated suites cover the factories transitively.
2. Tests becoming redundant: the duplicated inline factory definitions are the redundancy being removed.
   No assertion-bearing test becomes redundant — only setup boilerplate is deleted.
3. Tests that must stay as-is: every assertion in every migrated file.
   The migration must not alter a single `expect(...)`; only the construction of inputs moves to shared factories.
   The external-directory regression-guard import stays in its file.

Verification at each step is "full suite stays green," not red→green — the existing suite is the safety net for the refactor.

## Migration Order (refactor cycles)

Each step: create or extend a helper module, migrate one clone family's call sites to it, delete the now-dead inline copies, run the **full** suite (`pnpm --filter @gotgenes/pi-permission-system exec vitest run`) and `pnpm run check`, then commit.
No production behavior changes, so commits use `test:`.

1. Handler fixtures + first consumers.
   Create `test/helpers/handler-fixtures.ts` with the neutral-default factories.
   Migrate `tool-call-events.test.ts`, `tool-call.test.ts`, `input-events.test.ts`, `input.test.ts`, and the `makeSession` clone in `permission-session.test.ts`.
   Convert positional-`state` `makeSession` call sites to override-bag form.
   Commit: `test: extract shared handler fixtures (#288)`.

2. External-directory family.
   Move the 120-line shared block (`makeCheckPermission`, ext-dir `makeCtx`/`makeToolCallEvent`) into `handler-fixtures.ts` (or a `test/helpers/external-directory-fixtures.ts` if it does not generalize cleanly).
   Migrate `external-directory-integration.test.ts` and `external-directory-session-dedup.test.ts`, keeping the regression-guard import in the integration file.
   Commit: `test: dedupe external-directory integration fixtures (#288)`.

3. Gate fixtures.
   Create `test/helpers/gate-fixtures.ts` with `makeDescriptor`, `makeRunnerDeps`, `makeTcc`.
   Migrate `gates/runner.test.ts`, `gates/bash-path.test.ts`, `gates/path.test.ts`, passing each surface's defaults as explicit `makeCheckResult` overrides.
   Commit: `test: extract shared gate fixtures (#288)`.

4. Manager harness.
   Create `test/helpers/manager-harness.ts` with `createManager` and the repeated config/ruleset builders.
   Migrate the intra-file clone groups in `permission-system.test.ts` (e.g. lines ~891-943), leaving env-isolation helpers in place.
   Commit: `test: extract permission-manager test harness (#288)`.

5. Lifecycle setup (optional, scope permitting).
   Extract the shared `before-agent-start` ctx/state setup used by `before-agent-start.test.ts` and `lifecycle.test.ts`.
   Commit: `test: dedupe before-agent-start lifecycle setup (#288)`.

6. Docs refresh.
   Update the duplication track in `docs/architecture/architecture.md` with the new clone-group count from a fresh `fallow dupes` run.
   Commit: `docs: update duplication track after fixture extraction (#288)`.

## Risks and Mitigations

- Risk: consolidating `makeCheckResult` copies with divergent defaults silently changes inputs and breaks (or worse, weakens) assertions.
  Mitigation: single neutral default + explicit per-call overrides preserving each original copy's values; full-suite green gate after every step.
- Risk: annotating a mock-bag factory with the production interface erases `Mock<...>` methods, breaking `.mockReturnValue` call sites (testing skill).
  Mitigation: leave `makeHandler`/`makeRunnerDeps` return types inferred; only annotate plain-data builders.
- Risk: rewriting the 2839-line `permission-system.test.ts` at once.
  Mitigation: lift-and-shift — extract harness alongside inline copies, migrate the targeted intra-file groups only, delete inline copies last.
- Risk: removing the external-directory regression-guard import breaks its intended coverage.
  Mitigation: explicitly keep that import in the file; do not relocate it into a helper.

## Open Questions

- Whether step 5 (lifecycle setup) lands in this issue or is deferred — decide during implementation based on how cleanly the `before-agent-start` setup generalizes.
- Whether the ext-dir block belongs in `handler-fixtures.ts` or its own module — defer until the migration reveals how much it shares with the generic handler fixtures.
