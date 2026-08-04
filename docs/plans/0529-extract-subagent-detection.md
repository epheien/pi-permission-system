---
issue: 529
issue_title: "pi-permission-system: extract a SubagentDetection collaborator; seed src/authority/"
---

# Extract a SubagentDetection collaborator; seed src/authority/

## Release Recommendation

**Release:** ship independently

Phase 8 Step 5's roadmap annotation is `Release: independent` ("refactors; auto-batch into the next release").
The work is all `refactor:`/`docs:` commits — hidden changelog types — so it does not cut a release on its own; it lands on `main` and batches into the next `feat:`/`fix:` release.

## Problem Statement

The dep triple (`subagentSessionsDir`, `platform`, `registry`) is threaded into three constructors — `PromptingGateway`, `ForwardingManager`, and `PermissionForwarder` — solely so each can call `isSubagentExecutionContext`, which is re-evaluated up to three times per ask.
The architecture doc's authority-model target selects one Authorizer per session from three context predicates (`hasUI`, `isSubagent`, yolo); a single owner for the `isSubagent` predicate is a precondition for that selection (Phase 9).
This is Phase 8 Step 5: extract a `SubagentDetection` collaborator constructed once in `index.ts`, and seed the declared-but-unseeded `src/authority/` domain directory with it plus the moved `subagent-context.ts`.

## Goals

- One construction site for subagent detection: a `SubagentDetection` class built once in `index.ts` with (`subagentSessionsDir`, `platform`, `registry`).
- `PromptingGateway`, `ForwardingManager`, and `PermissionForwarder` drop the threaded dep triple and take a narrow `SubagentDetector` seam.
- `PermissionServiceLifecycle` drops its raw `SubagentSessionRegistry` field and takes a narrow `RegisteredChildDetector` seam, so **all** subagent-detection predicates have one owner (operator-confirmed scope widening beyond the issue's three constructors).
- Move `src/subagent-context.ts` → `src/authority/subagent-context.ts`, seeding `src/authority/`.
- Non-breaking: no config, command, or observable-behavior change; all commits are `refactor:`/`docs:`.

## Non-Goals

- **The Phase 9 spine.**
  No `Authorizer` interface, no `canConfirm()` dissolution — this step only produces the single-owner predicate the spine's selection will consume.
- **Step 6 ([#530]).**
  `PermissionForwarder` keeps both roles and its `forwarded-permissions/` location; only its detection deps change here.
- **Absorbing the pure functions.**
  `isSubagentExecutionContext` and `isRegisteredSubagentChild` stay exported pure functions; the class holds the deps and delegates (operator-confirmed).
  Their 372-LOC test file moves with the module but is not rewritten.
- **Moving `subagent-registry.ts` or `permission-forwarding.ts`.**
  The directory sketch defers those to Phase 9.
- **Migrating `forwarding-manager.test.ts` onto the forwarding harness.**
  Step 4 ([#528]) deliberately left it off; this plan only removes its `vi.mock("../src/subagent-context")` module mock, which the rewire obsoletes.

No follow-up issues need filing — Step 6 ([#530]) already exists.

## Background

- `src/subagent-context.ts` exports `SubagentDetectionContext` (narrow `{ sessionManager: { getSessionId; getSessionDir } }` context), `normalizeFilesystemPath`, `isRegisteredSubagentChild(ctx, registry)`, and `isSubagentExecutionContext(ctx, subagentSessionsDir, platform, registry?)` (registry → env hints → filesystem fallback, in priority order — the [#296]/[#298] regression class is pinned by `test/subagent-context.test.ts`).
- Four `src/` consumers today:
  - `src/prompting-gateway.ts` — `canConfirm()` = `hasUI ∨ isSubagentExecutionContext(...)` (the Step 3 / [#527] outcome).
  - `src/forwarding-manager.ts` — `start(ctx)` refuses to poll when the context is a subagent.
  - `src/forwarded-permissions/permission-forwarder.ts` — `requestApproval` (deny when not a subagent and no UI) and `waitForForwardedApproval` (the `isSubagent` field of target resolution); it **also** uses `registry` directly for `resolvePermissionForwardingTargetSessionId`, so `registry` stays a forwarder dep.
  - `src/service-lifecycle.ts` — `activate()` calls `isRegisteredSubagentChild(ctx, registry)` (the [#302] child-gated publish); its only use of its `registry` field.
- `index.ts` currently threads `paths.subagentSessionsDir` + `hostPlatform` + `subagentRegistry` into the three ask-path constructors, and `subagentRegistry` into `PermissionServiceLifecycle` and `subscribeSubagentLifecycle` (the latter keeps needing the raw registry).
- Sibling-module convention: files inside `src/` subdirectories import siblings via `#src/` aliases (eslint-enforced), e.g. `src/forwarded-permissions/permission-forwarder.ts`.
- Test tree mirrors `src/` subdirectories (`test/access-intent/`, `test/handlers/`, `test/forwarded-permissions/`), so the moved module's test goes to `test/authority/`.
- AGENTS.md / skill constraint: mark the roadmap step complete (heading ✅, Mermaid node ✅, stale metric rows) in this implementation's doc-update commit, not at ship time.

## Design Overview

New module `src/authority/subagent-detection.ts`:

```typescript
import {
  isRegisteredSubagentChild,
  isSubagentExecutionContext,
  type SubagentDetectionContext,
} from "#src/authority/subagent-context";
import type { SubagentSessionRegistry } from "#src/subagent-registry";

/** Narrow seam for the ask-path consumers (ISP: one method). */
export interface SubagentDetector {
  isSubagent(ctx: SubagentDetectionContext): boolean;
}

/** Narrow seam for the service-publication guard (#302). */
export interface RegisteredChildDetector {
  isRegisteredChild(ctx: SubagentDetectionContext): boolean;
}

export interface SubagentDetectionDeps {
  subagentSessionsDir: string;
  platform: NodeJS.Platform;
  registry?: SubagentSessionRegistry;
}

export class SubagentDetection
  implements SubagentDetector, RegisteredChildDetector
{
  constructor(private readonly deps: SubagentDetectionDeps) {}

  isSubagent(ctx: SubagentDetectionContext): boolean {
    return isSubagentExecutionContext(
      ctx,
      this.deps.subagentSessionsDir,
      this.deps.platform,
      this.deps.registry,
    );
  }

  isRegisteredChild(ctx: SubagentDetectionContext): boolean {
    return this.deps.registry
      ? isRegisteredSubagentChild(ctx, this.deps.registry)
      : false;
  }
}
```

Decision model:

- **Delegate, don't absorb** — the pure functions keep the detection logic and their tests; the class owns the deps.
  This preserves the "pure functions, IO/deps at the edges" convention and avoids rewriting the 372-LOC `subagent-context.test.ts`.
- **Two ISP seams** — the ask-path consumers read only `isSubagent`; `PermissionServiceLifecycle` reads only `isRegisteredChild`.
  Neither seam carries the other's method, so a one-field fake satisfies each consumer's tests without casts.
- **`registry` stays optional** on the deps, mirroring the current consumer signatures; `isRegisteredChild` with no registry is `false` (not a registered child) — consistent with `isSubagentExecutionContext`'s registry-optional behavior.
  `index.ts` always passes the real registry from `getSubagentSessionRegistry()`.
- **`SubagentDetectionContext` stays the parameter type** — both `ExtensionContext` and `ForwarderContext` already satisfy it structurally; `isSubagent` reads `getSessionDir` + `getSessionId`, `isRegisteredChild` reads `getSessionId`, so the type carries no unused surface worth splitting.

Consumer call sites (Tell-Don't-Ask / LoD verified — one hop, no reach-through):

```typescript
// PromptingGateway.canConfirm()
if (this.context === null) return false;
return this.context.hasUI || this.deps.detection.isSubagent(this.context);

// ForwardingManager.start(ctx)
if (!ctx.hasUI || this.detection.isSubagent(ctx)) {
  this.stop();
  return;
}

// PermissionServiceLifecycle.activate(ctx)
if (!this.detection.isRegisteredChild(ctx)) {
  publishPermissionsService(this.service);
}
```

Composition root (`index.ts`), constructed once alongside the other collaborators:

```typescript
const subagentDetection = new SubagentDetection({
  subagentSessionsDir: paths.subagentSessionsDir,
  platform: hostPlatform,
  registry: subagentRegistry,
});
```

The raw `subagentRegistry` remains in `index.ts` for `subscribeSubagentLifecycle` and for `PermissionForwarderDeps.registry` (forwarding-target resolution) — those are registry-as-data uses, not detection.

Edge cases:

- `PermissionForwarder` calls `isSubagent` at two sites (`requestApproval`, `waitForForwardedApproval`); both become `this.detection.isSubagent(ctx)`.
  Re-evaluation within one ask still happens (twice inside the forwarder) — collapsing that to a per-session selection is exactly Phase 9's job, not this step's.
- The moved `src/authority/subagent-context.ts` switches its internal imports to `#src/` aliases (`#src/permission-forwarding`, `#src/subagent-registry`) per the subdirectory convention.

## Module-Level Changes

| File                                                                        | Change                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/subagent-context.ts` → `src/authority/subagent-context.ts`             | `git mv`; internal imports become `#src/` aliases; exports unchanged                                                                                                                                                                                                                                                                                                                                                 |
| `src/authority/subagent-detection.ts`                                       | **New** — `SubagentDetector`, `RegisteredChildDetector`, `SubagentDetectionDeps`, `SubagentDetection`                                                                                                                                                                                                                                                                                                                |
| `src/prompting-gateway.ts`                                                  | `PromptingGatewayDeps` drops `subagentSessionsDir`/`platform`/`registry`, gains `detection: SubagentDetector`; `canConfirm()` delegates                                                                                                                                                                                                                                                                              |
| `src/forwarding-manager.ts`                                                 | Constructor `(detection: SubagentDetector, forwarder: InboxProcessor)`; drops the triple; `start()` delegates                                                                                                                                                                                                                                                                                                        |
| `src/forwarded-permissions/permission-forwarder.ts`                         | `PermissionForwarderDeps` drops `subagentSessionsDir`/`platform`, gains `detection: SubagentDetector`; keeps `registry` (target resolution); two call sites delegate                                                                                                                                                                                                                                                 |
| `src/service-lifecycle.ts`                                                  | Constructor takes `RegisteredChildDetector` instead of `SubagentSessionRegistry`; import of `isRegisteredSubagentChild` removed                                                                                                                                                                                                                                                                                      |
| `src/index.ts`                                                              | Constructs `SubagentDetection` once; passes it to the four consumers; stops threading the triple                                                                                                                                                                                                                                                                                                                     |
| `test/subagent-context.test.ts` → `test/authority/subagent-context.test.ts` | `git mv`; import path `#src/authority/subagent-context`; content otherwise intact                                                                                                                                                                                                                                                                                                                                    |
| `test/authority/subagent-detection.test.ts`                                 | **New** — class-level tests (see TDD Order)                                                                                                                                                                                                                                                                                                                                                                          |
| `test/prompting-gateway.test.ts`                                            | `makeDeps` injects a fake `detection`; env-stub subagent case becomes a fake-detector case                                                                                                                                                                                                                                                                                                                           |
| `test/forwarding-manager.test.ts`                                           | `vi.mock("../src/subagent-context")` module mock **removed**; fake `{ isSubagent: vi.fn() }` injected; constructor-threading test replaced by a delegation assertion                                                                                                                                                                                                                                                 |
| `test/service-lifecycle.test.ts`                                            | Injects a fake `RegisteredChildDetector` instead of a real/fake registry                                                                                                                                                                                                                                                                                                                                             |
| `test/helpers/forwarding-fixtures.ts`                                       | `makeForwarderDeps` drops `subagentSessionsDir`/`platform` defaults, gains `detection` default (`isSubagent` → `false`)                                                                                                                                                                                                                                                                                              |
| `test/permission-forwarder.test.ts`                                         | Call sites needing the forwarded path pass `detection` returning `true` instead of relying on env/dir heuristics                                                                                                                                                                                                                                                                                                     |
| `docs/architecture/architecture.md`                                         | Line-424 path → `src/authority/subagent-context.ts`; module-layout tree gains an `authority/` subtree (`subagent-detection.ts`, `subagent-context.ts`) replacing the old `subagent-context.ts` line; Step 5 heading + Mermaid node `S5` marked ✅ with a `Landed:` bullet (documenting the `isRegisteredChild`/service-lifecycle scope widening); metrics row "Subagent-detection dep-triple constructors" marked ✅ |

Checked and unchanged:

- `.pi/skills/package-pi-permission-system/SKILL.md` — references `isSubagentExecutionContext()` (still exported) and the `subagent-context.ts` leaf by module name, not path; both stay accurate.
- `docs/subagent-integration.md` — names `isSubagentExecutionContext()` only; still accurate.
- `src/subagent-registry.ts` — its doc comment names `isSubagentExecutionContext()`; still accurate.
- `README.md` — no references to the moved/changed symbols.
- `test/composition-root.test.ts` — exercises the real factory end-to-end; no direct `subagent-context` import.

## Test Impact Analysis

1. **New unit tests enabled:** `SubagentDetection` is directly testable — one construction, both predicates, the no-registry fallback — without going through a consumer.
   The consumers' detection-permutation tests collapse to "delegates to the detector" cases with a one-field fake, removing the last `vi.mock` module mock in `forwarding-manager.test.ts`.
2. **Tests that become redundant:** `prompting-gateway.test.ts`'s env-hint `canConfirm` case duplicates coverage owned by `subagent-context.test.ts`; it is replaced by a fake-detector case (the disjunction itself stays covered).
   `forwarding-manager.test.ts`'s "passes subagentSessionsDir from the constructor" threading test is obsolete — the constructor no longer carries the triple; replaced by an `isSubagent`-called-with-ctx assertion.
3. **Tests that stay as-is:** `test/authority/subagent-context.test.ts` (moved, content intact) — it pins the registry → env → filesystem priority order and the [#298] sibling-eviction guarantee, which live in the pure functions this class delegates to.
   `test/composition-root.test.ts` stays untouched and keeps end-to-end coverage of real detection through the factory (including the subagent-registry-sharing round-trip).

## Invariants at risk

| Invariant (source)                                                                | Pinned by                                                          | Risk handling                                                                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `canConfirm()` = `hasUI ∨ isSubagent` — no yolo arm (Step 3 / [#527] `Landed:`)   | `test/prompting-gateway.test.ts` `canConfirm` suite                | Rewire preserves the disjunction; adapted tests assert both operands                                               |
| Child-gated service publish (Step outcome of [#302])                              | `test/service-lifecycle.test.ts` + `test/composition-root.test.ts` | `activate()` logic unchanged; only the collaborator type narrows                                                   |
| Registry-first detection priority; sibling disposal cannot evict ([#296], [#298]) | `test/subagent-context.test.ts`                                    | Pure functions untouched; test file moves intact                                                                   |
| Forwarding-harness consolidation (Step 4 / [#528] `Landed:`)                      | `test/helpers/forwarding-fixtures.ts` consumers                    | `makeForwarderDeps` updated in place; `forwarding-manager.test.ts` stays off the harness per that plan's Non-Goals |

## TDD Order

1. **Move `subagent-context` into `src/authority/` (mechanical, no behavior change).**
   `git mv src/subagent-context.ts src/authority/subagent-context.ts` and `git mv test/subagent-context.test.ts test/authority/subagent-context.test.ts`; switch the moved module's internal imports to `#src/` aliases; update the four `src/` importers' paths, the moved test's `#src/authority/subagent-context` import, and `forwarding-manager.test.ts`'s `vi.mock` path.
   Verify: `pnpm run check` + full suite green.
   Commit: `refactor(pi-permission-system): move subagent-context into src/authority/ (#529)`.
2. **Red → green: `SubagentDetection`.**
   New `test/authority/subagent-detection.test.ts`: `isSubagent` true/false via registry, env hint, and filesystem fallback (thin — delegation smoke, not a re-test of the matrix); `isRegisteredChild` true/false; `isRegisteredChild` → `false` when constructed without a registry.
   Then implement `src/authority/subagent-detection.ts` as sketched.
   Commit: `refactor(pi-permission-system): add SubagentDetection collaborator (#529)`.
3. **Rewire `PromptingGateway`.**
   Red: adapt `makeDeps` in `test/prompting-gateway.test.ts` to inject `detection` (fake, default `isSubagent` → `false`); replace the env-hint case with a fake-detector case.
   Green: `PromptingGatewayDeps` swap + `canConfirm()` delegation; `index.ts` constructs `subagentDetection` once and passes it.
   Commit: `refactor(pi-permission-system): rewire PromptingGateway onto SubagentDetection (#529)`.
4. **Rewire `ForwardingManager`.**
   Red: drop the `vi.mock` module mock in `test/forwarding-manager.test.ts`; inject a fake detector; replace the constructor-threading test with a delegation assertion.
   Green: constructor `(detection, forwarder)`; `index.ts` call site.
   Commit: `refactor(pi-permission-system): rewire ForwardingManager onto SubagentDetection (#529)`.
5. **Rewire `PermissionForwarder`.**
   Red: update `makeForwarderDeps` (drop `subagentSessionsDir`/`platform`, add `detection`); adapt any `permission-forwarder.test.ts` case that reaches the forwarded path to pass `detection` returning `true`.
   Green: `PermissionForwarderDeps` swap, two call-site delegations; `index.ts` `forwardingDeps`.
   Commit: `refactor(pi-permission-system): rewire PermissionForwarder onto SubagentDetection (#529)`.
6. **Rewire `PermissionServiceLifecycle`.**
   Red: `test/service-lifecycle.test.ts` injects a fake `RegisteredChildDetector`.
   Green: constructor swap (`RegisteredChildDetector` for `SubagentSessionRegistry`), drop the `isRegisteredSubagentChild` import; `index.ts` call site.
   Commit: `refactor(pi-permission-system): rewire service lifecycle onto RegisteredChildDetector (#529)`.
7. **Docs.**
   `docs/architecture/architecture.md` updates listed in Module-Level Changes (✅ Step 5 heading, Mermaid `S5`, metrics row, `Landed:` bullet, path reference, module tree `authority/` subtree).
   Verify with `pnpm run lint` (rumdl) and a Mermaid render check per the `mermaid` skill.
   Commit: `docs(pi-permission-system): mark Phase 8 Step 5 complete (#529)`.

Steps 3–6 each fold the consumer change, its test, and the `index.ts` call site into one commit — the type checker forbids splitting them.

## Risks and Mitigations

- **Silent behavior drift in a consumer rewire** — each consumer's decision logic is a one-line delegation swap; the adapted per-consumer tests assert the same outcomes (poll/no-poll, confirm/deny, publish/skip), and `test/composition-root.test.ts` plus the forwarding round-trip test cover the real wiring end-to-end.
- **`makeForwarderDeps` default flips a test's path** — the fake detector defaults to `isSubagent` → `false`, matching today's default fixture environment (no env hints, non-subagent dirs); tests needing the forwarded path opt in explicitly, which is more legible than the current implicit env/dir coupling.
- **Import-path churn misses a consumer** — step 1 is mechanical and verified by `tsc` (`pnpm run check`); the grep inventory above found exactly four `src/` importers, three test files, and one fixture.
- **Doc staleness** — the architecture-doc updates are enumerated file-by-file above and land in the implementation's own docs commit per the package skill's roadmap-marker rule.

## Open Questions

None — both design forks (detection scope; delegate vs. absorb) were resolved with the operator before planning.

[#296]: https://github.com/gotgenes/pi-packages/issues/296
[#298]: https://github.com/gotgenes/pi-packages/issues/298
[#302]: https://github.com/gotgenes/pi-packages/issues/302
[#527]: https://github.com/gotgenes/pi-packages/issues/527
[#528]: https://github.com/gotgenes/pi-packages/issues/528
[#530]: https://github.com/gotgenes/pi-packages/issues/530
