---
issue: 528
issue_title: "pi-permission-system: extract a shared forwarded-permission test harness"
---

# Extract a shared forwarded-permission test harness

## Release Recommendation

**Release:** ship independently

Phase 8 Step 4 is tagged `Release: independent` in the roadmap (`docs/architecture/architecture.md`, "Release batches": "Independently releasable: Steps 1, 4 (test-only; hidden changelog type)").
The change is test-only and lands under the `test:` conventional type, which is a `hidden: true` changelog type — it cuts no release on its own and auto-batches into the next `feat:`/`fix:` release.

## Problem Statement

The forwarder-family test files repeat the same forwarding scaffolding.
`test/permission-forwarder.test.ts` builds the same temp forwarding directory four times: `mkdtempSync` → `createPermissionForwardingLocation` → `mkdirSync` for `requests/` and `responses/` → `writeFileSync` of a `ForwardedPermissionRequest` JSON, all wrapped in a `try/finally` with `rmSync` cleanup (the roadmap's "43-line clone ×2 plus 6 groups / 110 lines").
It also inlines the `PermissionForwarderDeps` builder, the `ForwarderContext` builder, the `{ emit, on }` events mock, and the `{ approved: true, state: "approved" }` UI decision repeatedly.
Extracting these into `test/helpers/forwarding-fixtures.ts` collapses the duplication and gives Phase 8 Step 6 ([#530]) a harness to migrate its split-out per-class tests onto, instead of copying the scaffolding a fifth time.

## Goals

- Add `test/helpers/forwarding-fixtures.ts` exposing: a temp forwarding-directory fixture (handle + `cleanup`), a forwarded-request writer, a `PermissionForwarderDeps` builder, a `ForwarderContext` builder, and a UI-decision builder.
- Fully migrate `test/permission-forwarder.test.ts` onto the harness — remove its local `makeDeps` / `makeCtx` and every inline temp-dir `try/finally` block.
- Opportunistically migrate `test/permission-forwarding.test.ts` where scaffolding is genuinely shared (subagent-registry setup), leaving the pure-function option objects — which are the test subjects' inputs — inline.
- Keep every behavioral assertion byte-identical: this is arrangement-only refactoring, the suite stays green throughout.
- No production change.

## Non-Goals

- **`test/forwarding-manager.test.ts` is left unchanged.**
  Despite the issue's "Why" listing it, its scaffolding does not overlap the harness: it casts a minimal `{ hasUI, sessionManager: { getSessionId }, cwd }` to `ExtensionContext` (not `ForwarderContext`), does no temp-dir or request/response I/O, mocks `subagent-context`, and exercises fake-timer polling.
  Its `makeCtx` / `makeForwarder` / `makeManager` are file-local, not cross-file clones.
  Forcing it onto a shared context builder would require a cast and a `getSessionId` override on a general-purpose builder for a single caller — net negative. (Operator confirmed opportunistic scope over force-all-three.)
- **Migrating the composition-root round-trip test.**
  `test/composition-root.test.ts` writes a `ForwardedPermissionResponse` to `responses/` — the only place the disk-response side is exercised.
  The three forwarder-family files never write responses, so a disk-response writer is out of scope; the harness's "response builder" is the in-memory UI decision (`makeUiDecision`), which is what these files actually repeat.
- **The `PermissionForwarder` split itself** — that is Phase 8 Step 6 ([#530]); this step only prepares the harness it will consume.

## Background

Relevant modules:

- `src/forwarded-permissions/permission-forwarder.ts` — defines `ForwarderContext` and `PermissionForwarderDeps`, the two interfaces the fixtures build.
- `src/permission-forwarding.ts` — defines `ForwardedPermissionRequest`, `PermissionForwardingLocation`, and `createPermissionForwardingLocation(forwardingRootDir, sessionId)`; the fixture wraps the latter.
- `src/permission-dialog.ts` — defines `PermissionPromptDecision` (the `{ approved, state }` shape `requestPermissionDecisionFromUi` resolves), the type `makeUiDecision` returns.
- `src/subagent-registry.ts` — `SubagentSessionRegistry`, constructed in `permission-forwarding.test.ts`'s registry-resolution describe.

Existing conventions to follow (`test/helpers/`):

- `handler-fixtures.ts` already exports `makeEvents()` returning exactly `{ emit: vi.fn(), on: vi.fn().mockReturnValue(() => undefined) }` — the same events mock `permission-forwarder.test.ts` inlines four times.
  Reuse it via `#test/helpers/handler-fixtures`; do not re-implement it in the new module.
- `external-directory-fixtures.ts` establishes the module style: a header docstring naming the consumers, `#src/` and `#test/helpers/` import aliases, and small JSDoc'd factory functions.
- `manager-harness.ts` (#525, Phase 8 Step 1) is the precedent for extracting a fixture module from a forwarder-family test in this exact phase.

AGENTS.md / skill constraints that apply:

- Testing skill — "Do not wrap the system-under-test call in a helper to eliminate a duplication-metric clone — the repeated act is the test subject."
  The temp-dir setup, deps, ctx, request JSON, and registry are *arrangement*, so extracting them is correct; the `resolvePermissionForwardingTargetSessionId({...})` option objects and `createPermissionForwardingLocation(...)` calls in `permission-forwarding.test.ts` are the *act's inputs* and stay inline.
- Testing skill — factory return types stay unannotated so callers keep `Mock<...>` access; where a factory must structurally satisfy a production interface (`PermissionForwarderDeps`, `ForwarderContext`), give each `vi.fn()` a typed implementation rather than a bare `vi.fn()`.
- Package skill — mark the completed roadmap step (`✅` on the Step 4 heading and the `S4` Mermaid node) in the implementation doc-update commit, not a deferred ship commit.

## Design Overview

New module `test/helpers/forwarding-fixtures.ts`.

### Temp forwarding directory (handle + `cleanup`)

Operator chose the handle form over a callback wrapper.

```typescript
import type { ForwardedPermissionRequest } from "#src/permission-forwarding";

export interface ForwardingTempDir {
  /** Absolute path passed as `forwardingDir` to `PermissionForwarderDeps`. */
  forwardingDir: string;
  /** The parent session's request/response location under `forwardingDir`. */
  location: PermissionForwardingLocation;
  /** Writes a `ForwardedPermissionRequest` JSON into `location.requestsDir`. */
  writeRequest(overrides?: Partial<ForwardedPermissionRequest>): ForwardedPermissionRequest;
  /** `rmSync(root, { recursive, force })`; register in `afterEach`. */
  cleanup(): void;
}

export function createForwardingTempDir(
  sessionId: string,
  options?: { createResponsesDir?: boolean },
): ForwardingTempDir;
```

- `mkdtempSync(join(tmpdir(), "permission-forwarding-"))` → `root`; `forwardingDir = join(root, "forwarding")`; `location = createPermissionForwardingLocation(forwardingDir, sessionId)`.
- Always `mkdirSync(location.requestsDir, { recursive: true })`.
- `options.createResponsesDir` defaults to `true`; the "recreates a missing `responses/`" race test passes `{ createResponsesDir: false }` so the fixture deliberately omits it.
- `writeRequest` defaults: `{ id: "req-forwarded", createdAt: Date.now(), requesterSessionId: "child-session", targetSessionId: sessionId, requesterAgentName: "Explore", message: "Allow git push?" }`, shallow-merged with `overrides`, `writeFileSync(join(location.requestsDir, `${id}.json`), JSON.stringify(request), "utf-8")`, returns the merged request.
  The two rich/auto variants override `id` (+ `source`/`surface`/`value` for the rich case).

Consumer call-site sketch (Tell-Don't-Ask: the fixture owns the I/O; the test tells it what request to stage and asserts on the forwarder's behavior):

```typescript
let temp: ForwardingTempDir;
afterEach(() => temp?.cleanup());

test("emits a UI prompt event before showing a forwarded permission dialog", async () => {
  temp = createForwardingTempDir("parent-session");
  temp.writeRequest({ id: "req-forwarded" });
  const events = makeEvents();
  const forwarder = new PermissionForwarder(
    makeForwarderDeps({ forwardingDir: temp.forwardingDir, events }),
  );
  await forwarder.processInbox(
    makeForwarderContext({ hasUI: true, sessionId: "parent-session" }),
  );
  expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", /* ... */);
});
```

### Deps, context, and UI-decision builders

```typescript
export function makeForwarderDeps(
  overrides?: Partial<PermissionForwarderDeps>,
): PermissionForwarderDeps; // current makeDeps defaults; requestPermissionDecisionFromUi defaults to a resolved makeUiDecision()

export function makeForwarderContext(
  overrides?: { hasUI?: boolean; ui?: ForwarderContext["ui"]; sessionId?: string;
    sessionManager?: Partial<ForwarderContext["sessionManager"]> },
): ForwarderContext; // current makeCtx, plus a `sessionId` shortcut that sets getSessionId

export function makeUiDecision(
  overrides?: Partial<PermissionPromptDecision>,
): PermissionPromptDecision; // default { approved: true, state: "approved" }
```

- `makeForwarderContext` adds a `sessionId` convenience over the current `makeCtx`: `sessionId` populates `getSessionId`, collapsing the repeated `sessionManager: { getSessionId: vi.fn(() => "parent-session") }`.
  An explicit `sessionManager` override still merges last for the tests that stub other readers.
- `makeUiDecision` is the "response builder" the issue names — the in-memory UI decision, not a disk `ForwardedPermissionResponse`.

### Opportunistic registry helper (`permission-forwarding.test.ts`)

The registry-resolution describe repeats `new SubagentSessionRegistry()` + `register(childSessionId, entry)`.
A thin `makeSubagentRegistry(childSessionId, entry?)` collapses the arrangement; the `resolvePermissionForwardingTargetSessionId({...})` option objects stay inline (test subjects).

```typescript
export function makeSubagentRegistry(
  childSessionId: string,
  entry?: { parentSessionId?: string },
): SubagentSessionRegistry;
```

This is borderline (a 2-line pattern); include it only if it reads cleaner across the ~5 call sites, otherwise leave `permission-forwarding.test.ts` untouched.

### Edge cases

- Race test: `createResponsesDir: false` reproduces the "requests/ exists, responses/ removed by a concurrent cleanup" condition.
- Version-skew (rich vs. degraded request): handled by `writeRequest` overrides adding `source`/`surface`/`value`.
- Yolo auto-approve test: overrides `config` on `makeForwarderDeps` (`{ ...DEFAULT_EXTENSION_CONFIG, yoloMode: true }`) and passes a bare `vi.fn()` for `requestPermissionDecisionFromUi` — the builder's default is override-replaced, no special support needed.

## Module-Level Changes

- **NEW `test/helpers/forwarding-fixtures.ts`** — header docstring naming consumers (`permission-forwarder.test.ts`, `permission-forwarding.test.ts`, and forward-looking [#530]); exports `ForwardingTempDir`, `createForwardingTempDir`, `makeForwarderDeps`, `makeForwarderContext`, `makeUiDecision`, and (conditionally) `makeSubagentRegistry`.
  Imports `ForwarderContext` / `PermissionForwarderDeps` from `#src/forwarded-permissions/permission-forwarder`, `ForwardedPermissionRequest` / `PermissionForwardingLocation` / `createPermissionForwardingLocation` from `#src/permission-forwarding`, `PermissionPromptDecision` from `#src/permission-dialog`, `DEFAULT_EXTENSION_CONFIG` from `#src/extension-config`, `SubagentSessionRegistry` from `#src/subagent-registry`.
- **CHANGED `test/permission-forwarder.test.ts`** — delete local `makeDeps` and `makeCtx`; import `makeForwarderDeps` / `makeForwarderContext` / `makeUiDecision` / `createForwardingTempDir` from `#test/helpers/forwarding-fixtures` and `makeEvents` from `#test/helpers/handler-fixtures`.
  Replace the four `processInbox` `try/finally` temp-dir blocks with a describe-scoped `let temp` + `afterEach(() => temp?.cleanup())` + `createForwardingTempDir(...)` / `temp.writeRequest(...)`.
  Replace inline `{ emit, on }` mocks with `makeEvents()` and inline `{ approved: true, state: "approved" }` with `makeUiDecision()`.
  Keep every `expect(...)` unchanged.
- **CHANGED (opportunistic) `test/permission-forwarding.test.ts`** — if `makeSubagentRegistry` is adopted, import it and replace the registry-resolution describe's `new SubagentSessionRegistry()` + `register(...)` pairs; all `resolvePermissionForwardingTargetSessionId(...)` / `createPermissionForwardingLocation(...)` calls stay inline.
  Otherwise no change.
- **UNCHANGED `test/forwarding-manager.test.ts`** — see Non-Goals.
- **DOC `docs/architecture/architecture.md`** — mark Phase 8 Step 4 complete: `✅` on the " **Extract a shared forwarded-permission test harness.**
  " step heading and the `S4` node in the step-dependency Mermaid diagram; add a `Landed:` line to the step.
  No metric-table row flips (the "Duplication ≤ 5.5%" target is Phase-8-wide, reached at phase close, not per-step).

No `src/` symbol is removed or renamed, so no `src/` / README / skill grep for a removed symbol is required.
The only doc touch is the roadmap step-completion marker.

## Test Impact Analysis

1. **New unit tests enabled?**
   None.
   This extracts *test scaffolding*, not production code — no production seam moves, so no previously-impractical lower-level test becomes possible.
   Test-helper modules are not themselves unit-tested (consistent with `manager-harness.ts` / `external-directory-fixtures.ts`).
2. **Tests made redundant?**
   None removed.
   The same behaviors are asserted with identical `expect`s; only arrangement is deduplicated.
3. **Tests that must stay as-is:** every assertion in all three files.
   The migration must not weaken or alter any `expect`; a diff that changes only imports, arrangement, and the temp-dir/`cleanup` mechanics is the success condition.

## Invariants at risk

No earlier Phase 8 step refactored these files (#525 touched `permission-manager-unified.test.ts`; #526/#527 touched production yolo paths).
The invariants at risk are the behavioral assertions themselves — the forwarder's UI-prompt emission, the non-UI deny path, the yolo auto-approve suppression, and the missing-`responses/` recreation.
Each is already pinned by an existing test in `permission-forwarder.test.ts`; the migration preserves them verbatim.
Verification: run the full `pi-permission-system` suite after each step and confirm the assertion count and outcomes are unchanged (green throughout — no red phase, this is refactoring).

## TDD Order

These are refactor cycles, not red→green: the suite stays green after every step (esbuild runs the migrated tests; `pnpm run check` type-checks the fixtures against the production interfaces).

1. **Add `forwarding-fixtures.ts` and fully migrate `permission-forwarder.test.ts`.**
   Create the helper module and rewrite `permission-forwarder.test.ts` onto it in the same commit (a helper with no consumer would trip `pnpm fallow dead-code`).
   Verify: `pnpm --filter @gotgenes/pi-permission-system exec vitest run test/permission-forwarder.test.ts` green, `pnpm run check` clean, `pnpm fallow dead-code` clean (fixtures are consumed).
   Commit: `test(pi-permission-system): extract forwarding fixtures; migrate forwarder tests (#528)`.
2. **(Opportunistic) migrate `permission-forwarding.test.ts` registry setup.**
   Only if `makeSubagentRegistry` reads cleaner across its call sites; add the export and migrate the registry-resolution describe.
   Verify: `pnpm --filter @gotgenes/pi-permission-system exec vitest run test/permission-forwarding.test.ts` green, `pnpm fallow dead-code` clean.
   Commit: `test(pi-permission-system): use shared subagent-registry fixture in forwarding tests (#528)`.
   Skip this step (and the `makeSubagentRegistry` export) if the extraction does not improve readability.
3. **Mark Phase 8 Step 4 complete in the roadmap.**
   Add `✅` to the Step 4 heading and the `S4` Mermaid node; add a `Landed:` line.
   Verify: full suite green (`pnpm --filter @gotgenes/pi-permission-system exec vitest run`), `pnpm run lint` clean (rumdl on the doc).
   Commit: `docs(pi-permission-system): mark Phase 8 Step 4 complete (#528)`.

Run the full suite before the final commit, not just the per-file runs, since the fixtures are shared.

## Risks and Mitigations

- **Risk: a hidden assertion change during arrangement extraction.**
  Mitigation: extract arrangement only; diff each migrated test to confirm the `expect(...)` lines are byte-identical, and rely on the green suite as the backstop.
- **Risk: unused-export / dead-code from an over-eager fixture surface.**
  Mitigation: export only what a consumer uses in the same commit; run `pnpm fallow dead-code` (CI gates on it) and Biome `noUnusedImports` after each step.
- **Risk: `makeForwarderContext`'s `sessionId` shortcut colliding with an explicit `sessionManager` override.**
  Mitigation: merge order — apply the `sessionId`-derived `getSessionId` first, then spread the explicit `sessionManager` override last so a test that stubs other readers wins.
- **Risk: the race test losing its "no `responses/`" precondition.**
  Mitigation: the `createResponsesDir: false` option is exercised by exactly that test; assert `logger.review` was not called with `permission_forwarding.error` as before.

## Open Questions

- Whether `makeSubagentRegistry` earns its place (Step 2) is deferred to implementation — a judgment call made against the actual call sites, per the operator's opportunistic-scope choice.
  No follow-up issue is warranted; the decision is local to this plan's Step 2.

[#530]: https://github.com/gotgenes/pi-packages/issues/530
