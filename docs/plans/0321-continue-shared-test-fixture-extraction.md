---
issue: 321
issue_title: "Continue shared test-fixture extraction for the largest clone families"
---

# Continue shared test-fixture extraction for the largest clone families

## Problem Statement

`fallow dupes` reports 7.6% duplication, entirely in the test tree — the single largest health deduction in `pi-permission-system`.
Phase 2 ([#288]) cut it from 9.1% to 7.1% by extracting `test/helpers/` fixtures, but tests added since have pushed it back up.
This is Phase 3, Step 16 (Track E) of the improvement roadmap: migrate the four largest remaining clone families onto the existing shared fixtures, extending those helpers where a shape is not yet covered.

The four families are:

- `test/handlers/external-directory-integration.test.ts` — 17 groups, 164 lines.
- `test/handlers/gates/bash-path.test.ts` — 6 groups, 61 lines.
- `test/handlers/gates/runner.test.ts` — 11 groups, 119 lines.
- `test/handlers/tool-call.test.ts` — 6 groups, 108 lines.

All four already import from `test/helpers/`, so the remaining clones are not "files that never adopted the fixtures."
They split into two kinds:

1. Duplicate factory definitions — local `makeSession`/`makeHandler`/`makeToolRegistry`/`makeCheckPermission` in `external-directory-integration.test.ts` and local `makeDenialContextDescriptor` in `runner.test.ts` that re-implement shapes the shared helpers already cover (or nearly cover).
2. Repeated override expressions — the 6-line `resolve: vi.fn().mockReturnValue(makeCheckResult({ state: "ask", matchedPattern: "*" }))` block (~8 occurrences in `runner.test.ts`), surface-dispatching `checkPermission` mocks (`external-directory-integration.test.ts`, `tool-call.test.ts`), and redundant `makeTcc({ input: { command: "cat .env" } })` calls that merely restate the factory default.

## Goals

- Migrate the four named clone families onto the shared `test/helpers/` fixtures.
- Delete the local duplicate factory definitions, routing them through the shared helpers.
- Add convenience shortcuts to the shared fixtures for the recurring override expressions (per the user's confirmed "both" scope decision): a surface-dispatching check factory, a `makeGateRunner` resolve-result shortcut, a path-dispatching resolver, a denial-context descriptor factory, and a `tools` shortcut on the handler factory.
- Keep every assertion unchanged — this is a pure test refactor; the suite must stay green at the same test count throughout.
- Drive duplication 7.6% → under 6%, shrinking the test-duplication health deduction below -2.0.

## Non-Goals

- No `src/` changes.
  No production behavior changes.
  No new assertions.
- Do not migrate `external-directory-session-dedup.test.ts` (a fifth family that shares the local-`makeSession` clone with the in-scope ext-dir file).
  It is outside the issue's named four-file scope; see Open Questions for the conditional follow-up.
- Do not extract co-located tests for the new helpers — per the [#288] decision, shared fixtures are covered transitively by the tests that consume them.
- Do not touch `permission-system.test.ts` (its intra-file clones were addressed in [#288]) or the bash-command-regex dispatch logic that is genuine per-test intent.
- Do not change the `/permission-system` command, config schema, or any policy surface.

## Background

Shared fixtures live in `test/helpers/`:

- `handler-fixtures.ts` — `makeCtx`, `makeEvents`, `makeSession`, `makeToolRegistry`, `makeToolCallEvent`, `makeCheckResult` (neutral default), `makeHandler` (returns `{ handler, events, session, toolRegistry }`), `getDecisionEvents`, and the `MockGateHandlerSession` type.
- `gate-fixtures.ts` — `makeDescriptor`, `makeGateRunner` (`{ runner, deps }`), `makeReporter`, `makeResolver`, `makeTcc` (bash defaults: `input: { command: "cat .env" }`), `makeGateCheckResult` (path-surface defaults), `makeGateInputs`, `makeSkillInputInputs`, `makeNotifier`.
- `manager-harness.ts` — `createManager`.

Relevant facts confirmed by reading the files:

- The local `makeSession`/`makeHandler` in `external-directory-integration.test.ts` are byte-for-byte the shared `makeSession`/`makeHandler` except for two defaults: the local `makeSession` defaults `getInfrastructureReadDirs` to `[]` (shared: `["/test/agent", "/test/agent/git"]`) and `checkPermission` to `makeCheckPermission("deny")` (shared: neutral allow); the local `makeToolRegistry` returns the path-bearing tool set plus `bash` (shared: `read` + `bash` only).
- `makeTcc()` already defaults `input` to `{ command: "cat .env" }`, so the many `makeTcc({ input: { command: "cat .env" } })` calls in `bash-path.test.ts` are redundant and collapse to `makeTcc()`.
- `runner.test.ts`'s local `makeDenialContextDescriptor` is `makeDescriptor` with `surface: "write"`, a caller-supplied `denialContext`, and write-shaped `promptDetails`/`logContext`/`decision`.
- The production refactors this step is "best sequenced after" ([#314], [#317], [#318], [#319], [#320]) have all landed — the shared fixtures already import `PermissionResolver`, `GateRunner`, `ToolCallGatePipeline`, `SkillInputGatePipeline`, and `GateDecisionReporter`.
  No soft dependency is outstanding; the step can proceed.

Constraints from AGENTS.md and the package skill that apply:

- Within the package, import siblings via `#src/` / `#test/` aliases, never relative paths.
- Do not annotate mock-bag factories with the production interface — it erases `Mock<...>` methods (`mockReturnValue`, `mock.calls`).
  `makeNotifier`, `makeResolver`, and `makeGateRunner` already follow this; new factories must too.
- Adding an unused export to a helper file will be flagged by `fallow dead-code`.
  Therefore each new helper is introduced in the same step that first consumes it — never as a standalone additive commit.
- This is a migrate → full-suite-green → commit cycle (no red→green), so the next stage is `/build-plan`, not `/tdd-plan`.

## Design Overview

The migration is a behavior-preserving consolidation.
No data shapes change; the only new surface is convenience factories that build existing mock shapes from fewer arguments.

### New shared helpers

`gate-fixtures.ts`:

```typescript
// Collapses the 6-line `resolve: vi.fn().mockReturnValue(...)` override.
// `makeGateRunner({ resolveResult: makeCheckResult({ state: "ask", matchedPattern: "*" }) })`
export function makeGateRunner(
  overrides: {
    resolveResult?: PermissionCheckResult; // wraps resolve in a vi.fn returning this
    resolve?: PermissionResolver["resolve"]; // still accepted for mockImplementation cases
    recordSessionApproval?: SessionApprovalRecorder["recordSessionApproval"];
    canConfirm?: GatePrompter["canConfirm"];
    promptPermission?: GatePrompter["promptPermission"];
    reporter?: Partial<DecisionReporter>;
  } = {},
): { runner: GateRunner; deps: { /* unchanged */ } };

// `makeDescriptor` variant with write-surface defaults + caller-supplied denialContext.
export function makeDenialDescriptor(
  denialContext: DenialContext,
  overrides?: Partial<GateDescriptor>,
): GateDescriptor;

// Resolver whose `resolve` dispatches on `input.path`, falling back to a default.
// `makePathDispatchResolver({ ".env": makeGateCheckResult({ state: "deny", matchedPattern: "*.env" }) }, makeGateCheckResult())`
export function makePathDispatchResolver(
  byPath: Record<string, PermissionCheckResult>,
  defaultResult: PermissionCheckResult,
): PermissionResolver;
```

`handler-fixtures.ts`:

```typescript
// Surface-dispatching checkPermission mock. Replaces ext-dir's local
// `makeCheckPermission` and tool-call's inline path-gate dispatch.
// Per-surface source/origin default to production-realistic values; override per surface.
export function makeSurfaceCheck(
  bySurface: Record<string, Partial<PermissionCheckResult> & { state: PermissionState }>,
  defaultResult?: Partial<PermissionCheckResult> & { state: PermissionState },
): Mock<MockGateHandlerSession["checkPermission"]>;

// Bash-surface check whose state depends on a command regex. Replaces the
// three near-identical mockImplementation blocks in tool-call.test.ts.
export function makeBashCommandCheck(opts: {
  deny: RegExp;
  denyMatched: string;
  allowMatched?: string;
}): Mock<MockGateHandlerSession["checkPermission"]>;

// `tools` shortcut: build the toolRegistry getAll mock from a name list.
export function makeHandler(overrides?: {
  session?: Partial<MockGateHandlerSession>;
  toolRegistry?: Partial<ToolRegistry>;
  tools?: string[]; // sugar for toolRegistry.getAll → names.map(name => ({ name }))
}): { handler; events; session; toolRegistry };
```

### Consumer call-site sketch (verifies the interaction pattern)

`external-directory-integration.test.ts` after migration — the local `makeSession`/`makeHandler`/`makeToolRegistry`/`makeCheckPermission` are gone:

```typescript
import { makeHandler, makeSurfaceCheck, makeCtx, makeToolCallEvent } from "#test/helpers/handler-fixtures";

const PATH_BEARING = ["read", "write", "edit", "find", "grep", "ls"];
const denyExtDir = () =>
  makeSurfaceCheck(
    { external_directory: { state: "deny" }, path: { state: "allow", source: "special" } },
    { state: "allow" },
  );

const { handler } = makeHandler({ tools: [...PATH_BEARING, "bash"], session: { checkPermission: denyExtDir() } });
const event = makeToolCallEvent("read", { input: { path: EXTERNAL_PATH } });
expect(await handler.handleToolCall(event, makeCtx())).toMatchObject({ block: true });
```

This keeps the interaction Tell-Don't-Ask: the test hands the handler a fully-built collaborator and asks for a decision; it does not reach through the session to assemble pipeline internals (the shared `makeHandler` owns that wiring).

`runner.test.ts` after migration:

```typescript
const { runner, deps } = makeGateRunner({
  resolveResult: makeCheckResult({ state: "ask", matchedPattern: "*" }),
  promptPermission: vi.fn().mockResolvedValue({ approved: false, state: "denied" }),
});
const result = await runner.run(makeDenialDescriptor(ctx), null, "tc-1");
```

### What stays inline (genuine per-test intent)

Per the code-design "structural reasons before extracting duplication" heuristic, these are kept as-is — extracting them would create a discriminator-laden leaky abstraction:

- The per-agent `agentAwareCheck` in `external-directory-integration.test.ts` (dispatches on `agentName`, sets `origin` per agent) — a one-off.
- The `resolver.resolve.mockImplementation` blocks in `bash-path.test.ts` that dispatch on *multiple* path values with bespoke per-token logic — covered by `makePathDispatchResolver` only where the dispatch is a simple path→result map; the multi-condition ones stay inline.
- Events that use the `toolName` alias field (skill-read gate tests) rather than `name` — they deliberately exercise the alias-resolution path, so they keep their inline event literals instead of `makeToolCallEvent` (which emits `name`).
- The bash command-regex dispatch's *regex and matched-pattern values* remain per-test; only the surrounding boilerplate moves into `makeBashCommandCheck`.

### Edge cases

- `makeSurfaceCheck` must reproduce the source/origin defaults the ext-dir assertions read (`external_directory` → `source: "tool"`, `origin: "builtin"`; `path` → `source: "special"`).
  Decision-event assertions check `result`, `resolution`, `origin`, `agentName` — the factory's defaults must satisfy them without per-call overrides.
- The shared `makeSession`'s non-empty `getInfrastructureReadDirs` default (`["/test/agent", …]`) does not intersect any ext-dir test path (`/test/project/*`, `/outside/project/*`), so adopting the shared default cannot trigger an infra-read bypass.
  Verified by the full-suite green gate; if any test flips, pass `getInfrastructureReadDirs: () => []` at that call site.

## Module-Level Changes

- `test/helpers/gate-fixtures.ts` — add `resolveResult` option to `makeGateRunner`; add `makeDenialDescriptor`; add `makePathDispatchResolver`.
  Import `DenialContext` from `#src/denial-messages` and `GateDescriptor` from `#src/handlers/gates/descriptor` (the latter already imported).
- `test/helpers/handler-fixtures.ts` — add `makeSurfaceCheck`, `makeBashCommandCheck`, and the `tools` option on `makeHandler`.
- `test/handlers/gates/runner.test.ts` — replace ~8 `resolve: vi.fn().mockReturnValue(...)` overrides with `resolveResult:`; replace local `makeDenialContextDescriptor` with `makeDenialDescriptor`; remove the now-unused local definition and any imports it alone required.
- `test/handlers/gates/bash-path.test.ts` — collapse redundant `makeTcc({ input: { command: "cat .env" } })` to `makeTcc()`; replace the simple-map `resolver.resolve.mockImplementation` blocks with `makePathDispatchResolver`; keep the local `describeGate` parse-once helper (single-file use).
- `test/handlers/tool-call.test.ts` — replace inline `name`-form event literals with `makeToolCallEvent`; replace the path-gate dispatch mocks with `makeSurfaceCheck`; replace the three bash command-regex dispatch blocks with `makeBashCommandCheck`; use the `tools` shortcut for `toolRegistry`.
- `test/handlers/external-directory-integration.test.ts` — delete local `makeSession`, `makeHandler`, `makeToolRegistry`, `makeCheckPermission`; import the shared `makeHandler`/`makeSurfaceCheck`; use the `tools` shortcut for the path-bearing set; keep the regression-guard import of `formatExternalDirectoryAskPrompt` and `EXTENSION_TAG`; keep the inline `agentAwareCheck`.
- `docs/architecture/architecture.md` — mark Phase 3 Step 16 ([#321]) complete with the realized duplication metric; update any health-deduction figure in the duplication track.
- `.pi/skills/package-pi-permission-system/SKILL.md` — extend the Testing section's `gate-fixtures.ts`/`handler-fixtures.ts` inventories with `makeSurfaceCheck`, `makeBashCommandCheck`, `makeDenialDescriptor`, `makePathDispatchResolver`, the `makeGateRunner` `resolveResult` option, and the `makeHandler` `tools` shortcut.

## Test Impact Analysis

1. New unit tests enabled: none.
   The new helpers are fixtures, not production units; per the [#288] decision they are covered transitively by every test that consumes them.
   No standalone helper tests are added (and adding unused exports would trip `fallow dead-code`).
2. Existing tests made redundant: none.
   This is a pure setup refactor — every assertion is preserved verbatim, the test count is unchanged, and no test is deleted.
3. Tests that must stay as-is: all of them.
   The genuine-per-test-intent cases (agent-aware check, `toolName`-alias events, multi-condition path dispatch, bash regex/pattern values) keep their inline setup so the abstraction does not leak a discriminator.

## Build Order

Each step is a migrate → `pnpm run check` + full `vitest run` green → commit cycle.
Run the **full** suite (not just the touched file) after every step, because each step mutates a shared `test/helpers/` module.
Add each new helper in the same commit as its first consumer to avoid an unused-export `fallow dead-code` flag.

1. `runner.test.ts`: add `resolveResult` to `makeGateRunner` and `makeDenialDescriptor` to `gate-fixtures.ts`; migrate `runner.test.ts`; delete local `makeDenialContextDescriptor` and reconcile its now-unused imports.
   Commit: `test: migrate runner gate tests onto shared fixtures (#321)`.
2. `bash-path.test.ts`: add `makePathDispatchResolver` to `gate-fixtures.ts`; collapse redundant `makeTcc(...)` to `makeTcc()`; migrate the simple path-dispatch resolvers.
   Commit: `test: dedupe bash-path gate test setup (#321)`.
3. `tool-call.test.ts`: add `makeSurfaceCheck`, `makeBashCommandCheck`, and the `tools` option on `makeHandler` to `handler-fixtures.ts`; migrate `tool-call.test.ts` (events via `makeToolCallEvent`, path/bash dispatch via the new factories).
   Commit: `test: migrate tool-call handler tests onto shared fixtures (#321)`.
4. `external-directory-integration.test.ts`: delete the local `makeSession`/`makeHandler`/`makeToolRegistry`/`makeCheckPermission`; reuse the shared `makeHandler` + `tools` shortcut + `makeSurfaceCheck` (added in step 3); keep the regression guard and inline `agentAwareCheck`.
   Commit: `test: migrate external-directory integration tests onto shared fixtures (#321)`.
5. Docs refresh: update `architecture.md` Step 16 status + duplication metric (run `fallow dupes` to capture the realized figure) and the package `SKILL.md` Testing inventory.
   Commit: `docs: record test-fixture extraction phase 3 and new helpers (#321)`.

Reconcile imports after every deletion: grep each removed symbol (e.g. `makeCheckPermission`, `makeDenialContextDescriptor`) across the file before committing — a stale value import passes `tsc` and the `lint` exit code but is a biome warning the reviewer will flag (the recurring slip from the [#288] retro).

## Risks and Mitigations

- Divergent factory defaults (the primary correctness risk).
  The local ext-dir `makeSession` defaulted `getInfrastructureReadDirs` to `[]` and `checkPermission` to deny; the shared one differs.
  Mitigation: ext-dir tests pass explicit `checkPermission` everywhere (default moot), and the shared infra-dirs default does not intersect any test path (edge-case analysis above).
  The full-suite green gate after step 4 confirms it; if a test flips, add a `getInfrastructureReadDirs: () => []` override at that site.
- `makeSurfaceCheck` source/origin defaults drifting from what assertions read.
  Mitigation: seed the factory's per-surface defaults from the values the deleted `makeCheckPermission` produced (`external_directory`/`path`/default branches), then run the full suite.
- Over-extraction creating a leaky abstraction.
  Mitigation: the "What stays inline" list keeps genuine per-test logic out of the shared helpers; only mechanical boilerplate moves.
- Stale imports after deleting local factories (the [#288] recurring friction).
  Mitigation: grep each removed symbol before committing each step; run `pnpm run lint` and read biome warnings, not just the exit code.
- Target miss (lands at ~6% rather than under).
  Mitigation: if `fallow dupes` after step 5 still shows ≥6%, the session-dedup follow-up (Open Questions) is the next lever — but it is out of the issue's named scope and should be a separate issue, not scope creep here.

## Open Questions

- Should `external-directory-session-dedup.test.ts` be migrated too?
  It shares the local-`makeSession`/`makeToolRegistry` clone with the in-scope ext-dir file (the cross-file family `ext-dir + session-dedup + handler-fixtures`).
  Defer: it is a fifth family outside the issue's four-file scope.
  If the <6% target is not met after step 5, file a follow-up issue rather than expanding this one.
- Final home of `bash-path.test.ts`'s `describeGate` parse-once helper.
  Keep it local for now (single-file use); promote to `gate-fixtures.ts` only if a second consumer appears.

[#288]: https://github.com/gotgenes/pi-packages/issues/288
[#314]: https://github.com/gotgenes/pi-packages/issues/314
[#317]: https://github.com/gotgenes/pi-packages/issues/317
[#318]: https://github.com/gotgenes/pi-packages/issues/318
[#319]: https://github.com/gotgenes/pi-packages/issues/319
[#320]: https://github.com/gotgenes/pi-packages/issues/320
[#321]: https://github.com/gotgenes/pi-packages/issues/321
