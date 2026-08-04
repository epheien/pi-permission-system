---
issue: 480
issue_title: "pi-permission-system: extract shared fixtures for the external-directory tests (Phase 6 Step 8)"
---

# Extract shared fixtures for the external-directory tests

## Release Recommendation

**Release:** ship independently

Per the Phase 6 roadmap, Step 8 ([#480]) carries `Release: independent` — it has no batch siblings (Steps 6, 7, 8 are independently releasable).
The realistic nuance: this is a test-only change, so every commit is a `test:` type, which is a `hidden: true` changelog entry.
A `test:`-only landing does not cut a release on its own — it lands on `main` and auto-batches into the next `feat:`/`fix:`/unhidden-`docs:` release.
"Ship independently" therefore means "no batch to wait for," not "this PR cuts a release."

## Problem Statement

The external-directory test suite duplicates setup heavily. fallow reports the two handler-pipeline test files as the worst clone family in the package after the Phase 6 Step 5 gate unification:

- `test/handlers/external-directory-integration.test.ts` — 21 clone groups, 214 lines.
- `test/handlers/external-directory-session-dedup.test.ts` — 3 clone groups, 74 lines (including a 43-line whole-wiring duplicate between `makeDeduplicatingHandler` and the inline shutdown test).

Each file hand-rolls the same `checkPermission`/`check(intent)` routing mocks, prompter literals, handler wiring, tool-call event shapes, and decision-event/review-log query patterns.
Now that Step 5 ([#477]) collapsed the two external-directory gates into a single policy check, a shared fixture can target that one collapsed gate rather than two parallel gates.

## Goals

- Add `test/helpers/external-directory-fixtures.ts` carrying the shared setup and query helpers for the collapsed external-directory gate.
- Migrate `test/handlers/external-directory-integration.test.ts` and `test/handlers/external-directory-session-dedup.test.ts` onto it.
- Eliminate the 43-line whole-wiring duplicate inside the session-dedup file (the inline shutdown test re-implements `makeDeduplicatingHandler`).
- Drive package duplication from 7.1% down to ≤ 6.5% (the roadmap's Step 8 outcome target).

This change is **not** breaking — it touches `test/` only, no runtime behavior, output shape, or default changes.

## Non-Goals

- `test/bash-external-directory.test.ts` is **out of scope** (operator decision, this session).
  It tests a different surface — the pure `extractExternalPathsFromBashCommand` function, which runs *before* the gate, not the collapsed gate itself.
  Its bulk is the repeated system-under-test call (`await extractExternalPathsFromBashCommand(cmd, cwd)` + `expect`), which the `testing` skill says not to wrap to chase a clone metric. fallow does not list it among the duplication families; its "880-line arrow" is a unit-size smell, not a clone family, and is not addressable by fixture extraction.
  No follow-up issue is filed for it.
- The other external-directory test files (`external-directory-symlink-acceptance.test.ts`, `test/handlers/gates/*`) are not migrated — they are not part of the issue's named clone family.
- No production (`src/`) changes — this is a test-only refactor.

## Background

Relevant existing fixtures (`test/helpers/`):

- `handler-fixtures.ts` — `makeHandler` (builds a real `PermissionSession` + `PermissionResolver` wired into the handler and pipelines exactly as `index.ts`), `makeSurfaceCheck` (surface-dispatching `check` mock), `makeToolCallEvent`, `makeCtx`, `makeEvents`, `makeToolRegistry`, `getDecisionEvents`.
  File 1 already builds on `makeHandler` + `makeSurfaceCheck` (via its local `makeExtDirCheck`).
- `session-fixtures.ts` — `makeRealSession`, `makeRealResolver`, and per-collaborator fakes.
  File 2 builds on these directly with manual `GateRunner`/`GateDecisionReporter`/pipeline wiring.

Both files dispatch the unified `permissionManager.check(intent)` (the single resolution entry point since [#478]).
An inline handler that mocks `check` must dispatch on `intent.kind` (`path-values` carries `values`, `tool` carries `input`) and `intent.surface`, or external-directory checks false-green to `allow` — the new fixture must preserve this dispatch faithfully.

Constraints from AGENTS.md / skills that apply:

- `testing` skill — do not wrap the system-under-test call in a helper to eliminate a clone (the act is the test subject); group shared *arrangement* in fixtures, keep the *act* explicit.
- `testing` skill — Biome `noUnusedImports` is warning-level (exit 0); after migrating, re-check each file's imports for orphans, since lint stays green on a stray import.
- `code-design` skill — no speculative exports; a fixture export with no consumer is dead code fallow flags.
  Therefore each migration step lands the fixture pieces it consumes in the same commit (no fixture-only commit).
- `code-design` skill (preparatory refactoring) — land the fixture + migration as small, separately-reviewable `test:` commits that each leave the suite green.

## Design Overview

One new fixture module, `test/helpers/external-directory-fixtures.ts`, hosts everything the two handler-pipeline files share for the collapsed gate.
It composes the existing `handler-fixtures.ts` / `session-fixtures.ts` rather than duplicating them.

### Exports

Shared constants (currently re-declared per file):

```typescript
export const EXT_DIR_CWD = "/test/project";
export const EXTERNAL_PATH = "/outside/project/file.ts";
export const ALL_PATH_BEARING_TOOLS = ["read", "write", "edit", "find", "grep", "ls"];
export const OPTIONAL_PATH_TOOLS = ["find", "grep", "ls"];
export const ALL_TOOLS = [...ALL_PATH_BEARING_TOOLS, "bash"];
```

Setup builders:

- `makeExtDirCheck(externalDirectoryState, toolState?)` — moved verbatim from File 1.
  Wraps `makeSurfaceCheck` to route `external_directory` to the given state, `path` to a transparent `allow`/`source: "special"`, and every other surface to `toolState` (default `allow`).
- `makeApprovingPrompter()` / `makeDenyingPrompter(denialReason?)` / `makeUnavailablePrompter()` / `makeSessionApprovingPrompter()` — the repeated `GatePrompter` literals from File 1 and File 2.
  Each returns `{ canConfirm, prompt }` with the right `mockResolvedValue` (`approved`/`denied`/`approved_for_session`).
- `makeExtDirDedupCheck(permissionManager, sessionRules)` — the session-dedup `check(intent)` mock implementation, applied via `vi.mocked(permissionManager.check).mockImplementation(...)`.
  This is the 43-line block currently copy-pasted between `makeDeduplicatingHandler` and the inline shutdown test; it returns `ask` for `external_directory` unless a recorded session rule (`wildcardMatch`) covers the path, else `allow`.
- `makeDeduplicatingHandler(prompter?)` — moved from File 2.
  Builds the fully-wired `PermissionGateHandler` over `makeRealSession` + `makeRealResolver`, installs `makeExtDirDedupCheck`, and returns `{ handler, prompter }`.
  The inline shutdown test re-uses `makeExtDirDedupCheck` (and, where it needs the raw `session` for `session.shutdown()`, a sibling builder `makeDedupWiring(prompter?)` returning `{ handler, prompter, session }`).

Event builders (preserve each file's existing event shape during lift-and-shift):

- File 1 keeps `makeToolCallEvent(toolName, { input: { path } })` from `handler-fixtures.ts` (uses `name:`).
- File 2 currently builds inline `{ type: "tool_call", toolCallId, toolName, input }` literals (uses `toolName:`); add `makeExtDirToolEvent(toolName, path, toolCallId?)` and `makeExtDirBashEvent(command, toolCallId?)` matching that exact shape so behavior is unchanged.
  (`getToolNameFromValue` accepts both `name` and `toolName`; both suites are green today, so do not normalize the shape in this refactor.)

Query helpers (the repeated decision-event and review-log scans):

- `findExtDirDecision(events)` → `getDecisionEvents(events).find((d) => d.surface === "external_directory")` — File 1 repeats this scan ~12 times.
- `blockReviewEntries(logger)` → filters the `logger.review` mock calls to `permission_request.blocked` entries — File 1 repeats this ~4 times.

### Consumer call-site sketch (Tell-Don't-Ask / LoD check)

File 1, after migration — the act stays explicit, only arrangement and queries collapse:

```typescript
const { handler, events } = makeHandler({
  session: { checkPermission: makeExtDirCheck("deny") },
  tools: ALL_TOOLS,
});
await handler.handleToolCall(
  makeToolCallEvent("read", { input: { path: EXTERNAL_PATH } }),
  makeCtx(),
);
expect(findExtDirDecision(events)).toMatchObject({ result: "deny", resolution: "policy_deny" });
```

`findExtDirDecision` collapses the `getDecisionEvents(...).find(...)` reach-through into one named query — the missing abstraction the design-review checklist (LoD §2) flags when multiple callers repeat the same chain.

File 2 shutdown test, after migration — the 43-line wiring duplicate dissolves:

```typescript
const { handler, prompter, session } = makeDedupWiring();
// ... fire two calls, assert one prompt ...
session.shutdown();
// ... third call re-prompts ...
```

### Design-review checklist outcome

| Check                | Finding                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------- |
| Dependency width     | Builders take 0–2 focused params; no wide bag introduced.                                           |
| Law of Demeter       | `findExtDirDecision` / `blockReviewEntries` remove repeated reach-throughs — a net LoD improvement. |
| Output arguments     | None.                                                                                               |
| Scattered resets     | None.                                                                                               |
| Parameter relay      | None.                                                                                               |
| Test mock depth      | No new `as unknown as` casts; reuses typed `makeSurfaceCheck` / `makeRealSession`.                  |
| Missing abstractions | The collapsed gate's setup + query concepts now have one home.                                      |

No production API gap to fix upstream — the extracted helpers consume existing fixtures and the existing `check(intent)` surface unchanged.

## Module-Level Changes

| File                                                              | Change                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/helpers/external-directory-fixtures.ts`                     | **New.** Constants, setup builders (`makeExtDirCheck`, prompter builders, `makeExtDirDedupCheck`, `makeDeduplicatingHandler`, `makeDedupWiring`), event builders (`makeExtDirToolEvent`, `makeExtDirBashEvent`), query helpers (`findExtDirDecision`, `blockReviewEntries`).                                            |
| `test/handlers/external-directory-integration.test.ts`            | Remove the local `makeExtDirCheck`, constants, prompter literals, and decision/review scans; import them from the new fixture. Keep every `describe`/`it` and the helper-presence regression guard intact.                                                                                                              |
| `test/handlers/external-directory-session-dedup.test.ts`          | Remove the local `makeDeduplicatingHandler` and the inline shutdown-test wiring duplicate; import `makeDeduplicatingHandler` / `makeDedupWiring` / `makeExtDirDedupCheck` / event builders from the new fixture. Keep every `describe`/`it`.                                                                            |
| `packages/pi-permission-system/docs/architecture/architecture.md` | **At ship time (not in this plan's commits):** mark roadmap Step 8 complete (`✅` on the `#### 8.` heading and the `S8` Mermaid node), per the package skill's roadmap-completion convention. The Phase 6 metrics table's duplication target is already stated; update the realized figure if the table tracks actuals. |

No `src/` symbols are removed or renamed, so no `src/`/README/skill/architecture prose grep for removed symbols is needed.
The architecture doc references these test files only in the Step 8 narrative (already present); no stale symbol references are introduced.

## Test Impact Analysis

This is itself a test refactor, so the standard extraction lenses map as:

1. **New tests enabled** — none required; the extraction does not expose a new unit.
   The shared `makeExtDirDedupCheck` makes the dedup mock a single reviewed implementation, removing the risk that the two copies drift (the inline shutdown copy could silently diverge from `makeDeduplicatingHandler`).
2. **Tests made redundant** — none removed.
   Every `describe`/`it` in both files is preserved; only arrangement and query scaffolding is centralized.
   The act of each test stays explicit at its call site (per the `testing` skill).
3. **Tests that must stay as-is** — all of them.
   These are integration tests over the real handler pipeline through the collapsed gate; they exercise the layer the fixture sets up, so the assertions are unchanged.

## Invariants at risk

This change touches the surface Step 5 ([#477], collapse the two external-directory gates) and Step 6 ([#478], narrow resolver to `resolve(intent)`) already refactored.
The invariants those steps established and the tests that pin them:

- **The collapsed gate produces one external-directory decision per access** — pinned by the `external_directory decision event fields` / policy-state `describe`s in `external-directory-integration.test.ts`.
  The migration preserves these tests verbatim; `findExtDirDecision` reads the same decision stream.
- **The unified `check(intent)` dispatch is kind- and surface-aware** ([#478] / [#418]) — pinned by the dedup `check(intent)` mock honoring `intent.kind === "path-values"`.
  `makeExtDirDedupCheck` preserves the exact dispatch; a regression here would false-green to `allow`, which the dedup re-prompt assertions catch.
- **Session approvals clear on shutdown** — pinned by the `session shutdown clears external-directory approvals` test, kept intact via `makeDedupWiring` (which exposes the real `session`).

No invariant lives only in prose; each is pinned by a surviving test, so a later step cannot regress an earlier outcome with a green suite.

## TDD Order

This is a behavior-preserving refactor (the suite is already green), so each step is a lift-and-shift commit that keeps the full suite green — there is no red phase.
Run the **full** package suite after each step (shared-helper changes), not just the migrated file.

1. **Migrate File 1 onto the new fixture.**
   Create `test/helpers/external-directory-fixtures.ts` with exactly the pieces File 1 consumes (constants, `makeExtDirCheck`, prompter builders, `findExtDirDecision`, `blockReviewEntries`) **and** rewrite `external-directory-integration.test.ts` to import them — in one commit, so no export is unused.
   Re-check File 1's imports for orphans (Biome `noUnusedImports` is warning-level).
   Verify: `pnpm --filter @gotgenes/pi-permission-system exec vitest run test/handlers/external-directory-integration.test.ts` green, then full suite green.
   Commit: `test(permission-system): extract external-directory integration fixtures (#480)`.

2. **Migrate File 2 onto the new fixture, dissolving the wiring duplicate.**
   Add the File-2 pieces to the fixture (`makeExtDirDedupCheck`, `makeDeduplicatingHandler`, `makeDedupWiring`, `makeExtDirToolEvent`, `makeExtDirBashEvent`) **and** rewrite `external-directory-session-dedup.test.ts` — including the inline shutdown test — to consume them, in one commit.
   The inline shutdown wiring (lines ~312–363) collapses onto `makeDedupWiring` + `makeExtDirDedupCheck`, removing the 43-line duplicate.
   Re-check File 2's imports for orphans.
   Verify: `pnpm --filter @gotgenes/pi-permission-system exec vitest run test/handlers/external-directory-session-dedup.test.ts` green, then full suite green.
   Commit: `test(permission-system): extract external-directory session-dedup fixtures (#480)`.

3. **Verify duplication target and tidy.**
   Run `pnpm fallow dupes` and confirm the two external-directory clone families (21 groups/214 lines and 3 groups/74 lines) are gone and package duplication is ≤ 6.5%.
   Run `pnpm run check` and `pnpm run lint`.
   If a clone family remains above target, fold the remaining shared arrangement into the fixture in this step.
   Commit (only if a tidy edit is needed): `test(permission-system): tidy external-directory fixture imports (#480)`.

(The roadmap Step 8 completion markers in `architecture.md` land at ship time, per the package skill, not in these steps.)

## Risks and Mitigations

| Risk                                                                                                                                     | Mitigation                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The dedup `check(intent)` mock drifts from production dispatch during extraction, silently false-greening external-directory to `allow`. | `makeExtDirDedupCheck` is moved verbatim and preserves `intent.kind === "path-values"` dispatch; the re-prompt assertions (different file / different dir / after shutdown) fail loudly if it regresses. |
| A fixture export ends up unused (fallow dead-export flag).                                                                               | Each migration step lands fixture pieces and their sole consumer in the same commit; no fixture-only commit.                                                                                             |
| Orphaned imports left in the migrated files (Biome warning-level, lint stays green).                                                     | Step 1 and Step 2 each re-check imports; Step 3 runs `pnpm run lint` and a final import scan.                                                                                                            |
| Duplication does not reach ≤ 6.5% after both migrations.                                                                                 | Step 3 verifies with `pnpm fallow dupes` and folds any residual shared arrangement into the fixture before finishing.                                                                                    |
| Event-shape normalization (`name` vs `toolName`) accidentally changes behavior.                                                          | Lift-and-shift preserves each file's existing event shape; the new event builders for File 2 match its current `toolName` literals exactly.                                                              |

## Open Questions

None.
The File 3 scope question (whether to migrate `test/bash-external-directory.test.ts`) was resolved this session: leave it out of scope, no follow-up.

[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#477]: https://github.com/gotgenes/pi-packages/issues/477
[#478]: https://github.com/gotgenes/pi-packages/issues/478
[#480]: https://github.com/gotgenes/pi-packages/issues/480
