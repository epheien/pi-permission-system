---
issue: 597
issue_title: "pi-permission-system: serving resolves the forwarded access intent at gate parity"
---

# Serving resolves the forwarded access intent at gate parity

## Release Recommendation

**Release:** ship now — batch "cross-session-intent" tail (this issue completes the batch)

This is Phase 12 Track A Step 3 ([#597]), the tail of the `cross-session-intent` batch (Steps 1 [#595], 2 [#596], 3 [#597]).
Steps 1 and 2 already landed on `main` as `docs:`/`feat:` without cutting a release (Step 1 is docs-only; Step 2 deferred as mid-batch).
This step carries a `feat:` behavior change and is the batch tail, so it cuts the release that ships all three steps together.

## Problem Statement

Serving a forwarded permission request still re-derives the child's path from a bare display string through the **parent's** `PathNormalizer` and cwd.
`ServingPolicy.check(surface, value)` in `forwarded-request-server.ts` builds an `AccessIntent` via `buildAccessIntentForSurface(surface, value, session.getPathNormalizer(), undefined)` — the path's meaning is re-interpreted at the wrong node.
Because a subagent in a worktree resolves paths against a different root, a parent `allow` that would match the child's alias set can silently miss (and vice versa), and any multi-alias fidelity floors to `ask`.
This is [#565] item 3 (single-`(surface, value)` re-resolution lossiness) and item 2 (undefined agent-scope semantics — serving resolves with `agentName` undefined).

Step 2 ([#596]) already put the structured `ForwardedAccessIntent` on the wire (child-fixed `matchValues` ∪ `boundaryValue`, `requesterCwd`, `principal`), read tolerantly by `forwarding-io.ts`.
This step makes the serving node **consume** that intent: resolve the parent's recorded authority directly against the values the child fixed, agent-scoped to the requester, at parity with the child's own gate.

## Goals

- Serving resolves a forwarded request against the child-fixed `matchValues` from `request.accessIntent`, never re-derived through the parent's `PathNormalizer`/cwd (ADR 0008 §1, §2).
- Serving is **agent-scoped**: it resolves against the parent's ruleset scoped to `principal.agentName`, applying the parent's per-agent overrides for the requesting agent (ADR 0008 §3).
  This is a deliberate `feat:` behavior change (confirmed non-breaking, per the [#557] serving-is-resolution precedent): it changes an outcome only when the parent holds per-agent rules for that agent, and is a strict superset of the agent-neutral serving it replaces (identical configs still prompt).
- `ForwardedAccessIntent` is the **sole** resolution path: a request without it floors to `ask` → escalate (ADR 0008 §4).
  The legacy display-only `(surface, value)` resolution branch and the `hasDisplayFields` floor are retired.
- `grep -c ForwardedAccessIntent packages/pi-permission-system/src/authority/forwarded-request-server.ts` goes 0 → ≥ 1.
- Mark Phase 12 Track A Step 3 complete in `docs/architecture/architecture.md` (step heading `✅`, Mermaid node `✅`, `Landed:` note).

## Non-Goals

- **Closing [#565].**
  Step 3 structurally dissolves [#565] items 2–3, but [#565] stays open through Phase 12 by roadmap decision and closes at phase end (after Track B) with the item-1 best-effort note.
- **Track B (the Authorizer chain, Steps 4–6 / [#598]–[#600]).**
  Disjoint files; not touched here.
- **The local `LocalPermissionsService` path query.**
  `permissions-service.ts` keeps using `buildAccessIntentForSurface` for the `Symbol.for()` service (#503) — it answers against the parent's own cwd for a local query, which is correct; only the *serving* closure in `index.ts` stops re-deriving.
- **Editing ADR 0005.**
  ADR 0008 §3 already records that it revises ADR 0005's "agent-neutral resolution" section; an accepted ADR is a historical record superseded by ADR 0008, not edited in place.
- **The two ADR-0008-deferred edges** — the single-surface fact set ([#565] item 3's multi-surface case still floors to `ask`) and multi-hop principal identity.
  Both recorded in ADR 0008; no code here.
- **No config, schema, example, or default change** — the wire and its tolerant read shipped in Step 2; this step only changes how serving consumes them.

## Background

Relevant modules and how they relate:

- `src/authority/forwarded-request-server.ts` — `ForwardedRequestServer` (the serving-down role).
  `processInbox` → `processSingleForwardedRequest` → `resolveDecision`, which today calls `this.policy.check(request.surface, request.value)` gated on `hasDisplayFields`, then escalates `ask`/field-less requests through `AskEscalator`.
  `ServingPolicy` is the narrow recorded-authority seam (`check(surface, value)`).
- `src/index.ts` — the composition root builds `const resolver = new PermissionResolver(...)` and wires `servingPolicy` as a closure over `resolver.resolve` + `buildAccessIntentForSurface(..., session.getPathNormalizer(), undefined)` (the re-derivation this step removes).
- `src/permission-resolver.ts` — `PermissionResolver.resolve(intent: AccessIntent)` reduces a gate-emitted `AccessIntent` (`tool | access-path`) to a `ResolvedAccessIntent` (`tool | path-values`) via `toResolvedIntent`, composing the session ruleset, then calls `manager.check`.
  The `access-path` → `path-values` unwrap (`matchValues()`) is the ADR-0002 string boundary.
- `src/access-intent/input-normalizer.ts` — `buildAccessIntentForSurface(surface, value, normalizer, agentName)` (the re-derivation builder) and the private `buildInputForSurface(surface, value)` (builds a surface-appropriate `tool` input); `PATH_SURFACES` classifies path surfaces.
- `src/authority/permission-forwarding.ts` — `ForwardedAccessIntent` (`{ surface, matchValues, boundaryValue, requesterCwd, principal: { sessionId, agentName } }`) and the optional `accessIntent` field on `ForwardedPermissionRequest`.
- `src/authority/forwarding-io.ts` — `asForwardedAccessIntent` already reconstructs `accessIntent` on the tolerant read (Step 2); no change needed here.

Constraints from AGENTS.md / package SKILL that apply:

- **ADR-0002 string boundary** — the manager stays string-based (`no-restricted-imports` on `permission-manager.ts`); the wire carries strings, and serving feeds pre-fixed `matchValues` as a `path-values` intent — no `AccessPath` reconstruction.
- **Mark the roadmap step complete in the implementation doc-update commit** — `✅` on both the step heading and its Mermaid node, plus the `Landed:` note (not deferred to ship).
- **Architecture module-tree entries describe current behavior** — update the `forwarded-request-server.ts`, `permission-resolver.ts`, and `access-intent.ts` entries.
- **Least privilege** — a request without resolvable facts floors to `ask`, never a silent grant.

## Design Overview

### Decision model

Per ADR 0008, *the child owns the facts; the parent owns the judgment*.
Serving resolves the forwarded request as:

```text
resolveDecision(request):
  state = request.accessIntent ? policy.resolve(request.accessIntent).state : "ask"
  allow → auto-approve
  deny  → auto-deny
  ask   → escalate through AskEscalator  (also the missing-intent floor)
```

The single change to the branch condition: gate on `request.accessIntent` presence, not `hasDisplayFields(request)`.
The display fields (`request.surface`/`request.value`) survive only for the escalated prompt's disclosure (`buildForwardedAskDetails`, unchanged).

### `ServingPolicy` becomes intent-shaped

```typescript
// src/authority/forwarded-request-server.ts
export interface ServingPolicy {
  /**
   * Resolve a forwarded access intent against the serving node's recorded
   * authority, agent-scoped to the requester (ADR 0008 §3). Match values are
   * used as fixed by the child — never re-derived through the parent's
   * PathNormalizer/cwd.
   */
  resolve(intent: ForwardedAccessIntent): PermissionCheckResult;
}
```

`ForwardedAccessIntent` is a cohesive fact value object, not a dependency bag — the closure reads `surface`, `matchValues`, and `principal.agentName`; `boundaryValue`/`requesterCwd` ride for provenance/disclosure.
`boundaryValue` is not needed for rule matching: `matchValues()` already contains the canonical form (absolute ∪ cwd-relative ∪ canonical), so `evaluateAnyValue` matches the parent's rules — including a `/tmp/**` `external_directory` allow — against the child's aliases directly.

### The composition-root wiring (Tell-Don't-Ask, no re-derivation)

The serving closure hands the child-fixed values straight to the resolver:

```typescript
// src/index.ts — the servingPolicy closure
const servingPolicy: ServingPolicy = {
  resolve: (intent) =>
    resolver.resolve(
      buildResolvedIntentFromMatchValues(
        intent.surface,
        intent.matchValues,
        intent.principal.agentName,
      ),
    ),
};
```

No `session.getPathNormalizer()` read, no `buildAccessIntentForSurface` — the deferred-binding comment and the normalizer re-derivation both go away.

### The wire → resolved-intent mapping

A new sibling of `buildAccessIntentForSurface` in `input-normalizer.ts`, taking primitives (no `ForwardedAccessIntent` import, keeping `access-intent/` decoupled from `authority/`):

```typescript
// src/access-intent/input-normalizer.ts
export function buildResolvedIntentFromMatchValues(
  surface: string,
  matchValues: readonly string[],
  agentName: string,
): ResolvedAccessIntent {
  if (PATH_SURFACES.has(surface)) {
    return {
      kind: "path-values",
      surface,
      values: [...matchValues],
      agentName,
    };
  }
  return {
    kind: "tool",
    surface,
    input: buildInputForSurface(surface, matchValues[0]),
    agentName,
  };
}
```

A path surface produces a `path-values` intent carrying the child's fixed aliases as-is (this is the whole point — the parent never rebuilds an `AccessPath`).
A non-path surface (bash command, MCP target, skill name) produces a `tool` intent from its single portable value.
`agentName` is always `principal.agentName` (ADR 0008 §3, agent-scoped).

### Resolver accepts a pre-fixed `path-values` intent

`buildResolvedIntentFromMatchValues` returns a `ResolvedAccessIntent` (`tool | path-values`), but `PermissionResolver.resolve` today accepts only `AccessIntent` (`tool | access-path`).
Widen the concrete `PermissionResolver.resolve` (and the module-private `toResolvedIntent`) parameter to `AccessIntent | PathValuesAccessIntent`; the `path-values` case falls through `toResolvedIntent`'s existing else-branch unchanged (it is already a `ResolvedAccessIntent`).

The gate-facing `ScopedPermissionResolver` interface **stays narrow** (`resolve(intent: AccessIntent)`): gates never emit `path-values`, and implementing with a wider parameter still satisfies the narrower interface.
The serving closure holds the concrete `PermissionResolver` (`const resolver = new PermissionResolver(...)`), so it can pass `path-values`.

This makes the forwarded-serving wire a second, legitimate producer of pre-fixed match values — coherent with ADR-0002: the wire crosses as strings and stays strings; the manager still consumes `ResolvedAccessIntent` and never imports `AccessPath`.

Call-site sketch (extracted-module upstream check): `resolve` delegates to `manager.check(toResolvedIntent(intent), sessionRules.getRuleset())` — no reverse-search, no output argument, no Tell-Don't-Ask violation carried in; the `path-values` branch is a pure passthrough.

### Edge cases

- **Missing `accessIntent`** (older child, version skew) → `resolveDecision` floors to `ask` → escalate (ADR 0008 §4).
- **Malformed `accessIntent`** → `asForwardedAccessIntent` (Step 2) already yields `undefined` on any malformed shape, so it is indistinguishable from absent and floors to `ask`.
- **Empty `principal.agentName`** → agent-scoped resolution with an empty agent name resolves against the base ruleset (no per-agent override), which is the safe agent-neutral outcome.
- **`external_directory` surface** → resolves the parent's `external_directory` rules against the child-fixed `matchValues` (the containment decision was already made at the child gate; serving only matches recorded authority).

## Module-Level Changes

- `src/access-intent/input-normalizer.ts`
  - **Add** exported `buildResolvedIntentFromMatchValues(surface, matchValues, agentName): ResolvedAccessIntent`.
  - Import `ResolvedAccessIntent` from `./access-intent`.
    `PATH_SURFACES` and the private `buildInputForSurface` are already present.
- `src/permission-resolver.ts`
  - Widen `PermissionResolver.resolve` parameter to `AccessIntent | PathValuesAccessIntent`; widen the private `toResolvedIntent` parameter identically (the `path-values`/`tool` else-branch already returns a `ResolvedAccessIntent`).
  - Import `PathValuesAccessIntent` from `./access-intent/access-intent`.
  - Update the `resolve` doc comment to note the pre-fixed `path-values` acceptance (the forwarded-serving producer).
  - `ScopedPermissionResolver` interface unchanged (stays `resolve(intent: AccessIntent)`).
- `src/authority/forwarded-request-server.ts`
  - Change `ServingPolicy` from `check(surface, value)` to `resolve(intent: ForwardedAccessIntent)`; import `ForwardedAccessIntent`.
  - `resolveDecision`: gate on `request.accessIntent` (call `this.policy.resolve(request.accessIntent)`); floor to `"ask"` when absent.
  - **Remove** the private `hasDisplayFields` type guard (sole call site removed) and its now-unused type import if any.
  - Update the class-level and `resolveDecision` doc comments (recorded authority now via `ServingPolicy.resolve` against child-fixed facts).
- `src/index.ts`
  - Rewire `servingPolicy` to `resolve: (intent) => resolver.resolve(buildResolvedIntentFromMatchValues(intent.surface, intent.matchValues, intent.principal.agentName))`.
  - **Remove** the `buildAccessIntentForSurface` import (no longer used here — still used by `permissions-service.ts`) and the `getPathNormalizer`-deferral comment; add the `buildResolvedIntentFromMatchValues` import.
- `test/helpers/forwarding-fixtures.ts`
  - `makeServerDeps` default `policy` changes from `{ check: vi.fn(...) }` to `{ resolve: vi.fn(() => makeCheckResult({ state: "ask" })) }`.
  - **Add** a `makeForwardedAccessIntent(overrides?)` builder returning a well-formed `ForwardedAccessIntent` for request/policy fixtures.
- `test/authority/forwarded-request-server.test.ts` — rewritten per Test Impact Analysis (mock `policy.resolve`; requests carry `accessIntent`).
- `test/access-intent/input-normalizer.test.ts` (or the existing input-normalizer test file) — new unit tests for `buildResolvedIntentFromMatchValues`.
- `test/permission-resolver.test.ts` — new test for the `path-values` passthrough.
- `docs/architecture/architecture.md` — doc updates (below), landed in the implementation commit.

### Documentation updates (implementation commit)

- **Module-tree** `forwarded-request-server.ts` entry (line ~775): `ServingPolicy` is intent-shaped (`resolve(intent)` against child-fixed facts), no `(surface, value)` re-derivation.
- **Module-tree** `permission-resolver.ts` entry (line ~669): `resolve` also accepts a pre-fixed `path-values` intent (the forwarded-serving producer), not only a gate-emitted `AccessIntent`.
- **Module-tree** `access-intent.ts` entry (line ~678): `path-values` is produced by the resolver's `access-path` unwrap **and** the forwarded-serving wire — still not gate-emitted, still the ADR-0002 boundary.
- **Step 3 heading** (line ~867): append `✅`; add a `Landed:` note recording the serving-read metric moved 0 → ≥ 1 and the agent-scoped/ask-floor behavior.
- **Mermaid node** `S3` (line ~918): prefix `✅`.
- Do **not** edit the fixed `Baseline (2026-07-15)` health-metric column.

Grep confirmation performed at plan time: `ServingPolicy`/`servingPolicy` appears only in `src/index.ts`, `src/authority/forwarded-request-server.ts`, the architecture doc, prior plans/retros, and ADRs; no other `src/` consumer of `ServingPolicy.check`.

## Test Impact Analysis

1. **New lower-level tests the change enables:**
   - `buildResolvedIntentFromMatchValues` unit tests: a path surface → `path-values` with `values === matchValues` (multi-alias) and the given `agentName`; a non-path surface (bash/skill/external_directory/extension) → `tool` with the right input shape; `agentName` threaded in every case.
   - `PermissionResolver.resolve` passthrough test: a `path-values` intent reaches `manager.check` unchanged (no `matchValues()` unwrap, since there is no `AccessPath`), with the composed session ruleset.
2. **Existing tests that change:**
   - `forwarded-request-server.test.ts` — every `policy: { check }` mock becomes `policy: { resolve }`, and the resolve/auto-deny/ask tests attach a well-formed `accessIntent` to the written request (via `makeForwardedAccessIntent`).
     Assertions shift from `expect(check).toHaveBeenCalledWith("bash", "git status")` to `expect(resolve).toHaveBeenCalledWith(<intent>)`.
     The "floors a request without display fields" test becomes "floors a request without `accessIntent`" (write a request with `surface`/`value` but no `accessIntent`; assert `resolve` not called, escalate called).
     Grant-scope, one-hop-canary, and inbox-mechanics tests keep their intent — add `accessIntent` where they must reach the resolve branch, or leave it off where they exercise escalation.
3. **Tests that must stay as-is (they exercise the layer being resolved):**
   - The composition-root `forwarded grant-scope selection round-trip` tests exercise the real end-to-end serving path (real `ParentAuthorizer` stamps `accessIntent`; real `ForwardedRequestServer` resolves it).
     They use the `demo` surface with parent config `{ "*": "allow", demo: "ask" }` and no per-agent rules, so agent-scoped resolution lands on the same `ask` → prompt as today; they must stay green unchanged as the behavior-parity anchor.
   - The `service path queries evaluate the supplied path (#503)` composition-root test exercises `LocalPermissionsService` (a Non-Goal path), untouched.

## Invariants at risk

This step touches the serving surface [#557] (Phase 9 Step 3) and [#558] (grant-scope) refactored.
Documented outcomes to preserve, and the test that pins each:

- **Serving is resolution: recorded `allow` auto-approves, `deny` auto-denies, `ask` escalates** ([#557] `Outcome:` — zero yolo checks outside the composed ruleset).
  Pinned by `forwarded-request-server.test.ts` "recorded-authority resolution" describe block — kept (adapted to `policy.resolve` + `accessIntent`).
- **Whole-session grant records into the serving `SessionRules`; subagent-only grant passes through** ([#558]).
  Pinned by the `grant-scope selection` describe block (unit) and the composition-root round-trip (e2e) — both kept; the round-trip is the cross-consumer anchor.
- **One-hop canary warns on a multi-hop/misrouted requester** ([#557]).
  Pinned by the `one-hop canary` describe block — unchanged (independent of the resolution branch).
- **A field-less request never silently grants** — was `hasDisplayFields`-floored to `ask`; now `accessIntent`-floored to `ask`.
  The renamed floor test pins the same least-privilege invariant.

## TDD Order

1. **`buildResolvedIntentFromMatchValues` + resolver `path-values` acceptance** (`test:` → `feat:`).
   - Red: add `test/access-intent/input-normalizer.test.ts` cases for `buildResolvedIntentFromMatchValues` (path surface → `path-values` with the alias set + agentName; non-path surfaces → `tool` with correct input; agentName threaded).
     Add `test/permission-resolver.test.ts` case: `resolver.resolve` on a `path-values` intent calls `manager.check` with that intent unchanged + the composed ruleset.
   - Green: add `buildResolvedIntentFromMatchValues` to `input-normalizer.ts`; widen `PermissionResolver.resolve` + `toResolvedIntent` to accept `AccessIntent | PathValuesAccessIntent`.
   - Both new symbols are exercised by the new tests (no dead code); `ScopedPermissionResolver` stays narrow.
   - Commit: `feat(pi-permission-system): accept pre-fixed path-values intents for forwarded serving`.
   - Run `pnpm run check` after this step (shared-signature widening).
2. **Serving resolves the forwarded intent, agent-scoped; retire the legacy branch** (atomic `feat:`).
   - This step changes the `ServingPolicy` interface, `resolveDecision`, `index.ts` wiring, the `makeServerDeps` default, and the `forwarded-request-server.test.ts` suite together — the interface rename cascades and cannot land across separate commits.
   - Red: update `forwarding-fixtures.ts` (`makeServerDeps` → `policy: { resolve }`; add `makeForwardedAccessIntent`); rewrite `forwarded-request-server.test.ts` to mock `policy.resolve` and attach `accessIntent` to requests, and rename the floor test to key on a missing `accessIntent`.
   - Green: change `ServingPolicy` to `resolve(intent: ForwardedAccessIntent)`; rework `resolveDecision` to gate on `request.accessIntent`; remove `hasDisplayFields`; rewire `index.ts` `servingPolicy` via `buildResolvedIntentFromMatchValues` and drop the `buildAccessIntentForSurface` import + normalizer-deferral comment.
   - Commit: `feat(pi-permission-system): serving resolves the forwarded access intent at gate parity (#597)`.
   - Run `pnpm run check` after this step.
3. **Architecture doc: mark Step 3 complete + refresh module-tree entries** (`docs:`).
   - Update the three module-tree entries; append `✅` + `Landed:` to the Step 3 heading; `✅` the `S3` Mermaid node.
   - Commit: `docs(pi-permission-system): mark Phase 12 Step 3 complete (#597)`.
   - Note: a `docs:` commit is `hidden`; it does not itself cut a release — the Step-2 `feat:` above is what cuts the batch release.

Full-suite + root `lint` + `fallow dead-code` run after Step 2 and again before push.

## Risks and Mitigations

- **Risk: the atomic Step 2 rewrite drops a test assertion silently.**
  Mitigation: the composition-root round-trip tests are untouched and exercise the real serving path end-to-end, catching a resolution-branch regression `tsc` would miss; run the full suite after Step 2.
- **Risk: agent-scoped serving loosens a decision unexpectedly.**
  Mitigation: it changes an outcome only when the parent holds per-agent rules for the requesting agent (ADR 0008 §3, verified against the manager's `agentName` composition); identical configs still prompt, pinned by the round-trip anchor.
- **Risk: widening `PermissionResolver.resolve` leaks `path-values` into gate call sites.**
  Mitigation: the gate-facing `ScopedPermissionResolver` interface stays narrow; only the concrete class accepts the wider union, and only the serving closure (holding the concrete type) passes `path-values`.
- **Risk: `boundaryValue` is silently needed for `external_directory` matching.**
  Mitigation: `matchValues()` already includes the canonical alias; `evaluateAnyValue` matches the parent's rules against it.
  A new `input-normalizer` test asserts the multi-alias `values` array is preserved.
- **Risk: a stale doc claims serving re-derives from display strings.**
  Mitigation: the plan enumerates the three module-tree entries plus the roadmap step-mark; the pre-completion reviewer checks doc staleness.

## Open Questions

None outstanding.

Two design decisions were resolved at plan time via the operator `ask_user` gate, because the issue body and the accepted ADR 0008 conflicted:

- **Legacy `(surface, value)` fallback** — the issue body said "keep it for version skew"; ADR 0008 §4 retired it with an `ask` floor.
  Resolved: **follow ADR 0008** — retire the legacy branch; a request missing the intent floors to `ask`.
- **Commit type / breaking classification** — agent-scoped serving can change a decision on upgrade without a config edit.
  Resolved: ship as **`feat:`** (non-breaking), per the [#557] serving-is-resolution precedent that shipped the analogous serving behavior change as `feat:`.

No follow-up issues filed — Track B ([#598]–[#600]) already exists, and ADR 0008 records the two deferred edges.

[#557]: https://github.com/gotgenes/pi-packages/issues/557
[#558]: https://github.com/gotgenes/pi-packages/issues/558
[#565]: https://github.com/gotgenes/pi-packages/issues/565
[#595]: https://github.com/gotgenes/pi-packages/issues/595
[#596]: https://github.com/gotgenes/pi-packages/issues/596
[#597]: https://github.com/gotgenes/pi-packages/issues/597
[#598]: https://github.com/gotgenes/pi-packages/issues/598
[#600]: https://github.com/gotgenes/pi-packages/issues/600
