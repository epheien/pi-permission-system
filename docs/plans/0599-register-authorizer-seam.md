---
issue: 599
issue_title: "pi-permission-system: registerAuthorizer seam, authorizerChain config, and enforcement checkpoint"
---

# registerAuthorizer seam, authorizerChain config, and enforcement checkpoint

## Release Recommendation

**Release:** ship now — batch "authorizer-chain" tail (this issue completes the batch)

Step 5 is the tail of the two-step "authorizer-chain" batch (Steps 4–5) per the Phase 12 roadmap's `Release batches` subsection.
Step 4 ([#598]) landed on `main` with its release-please PR held open mid-batch; shipping Step 5 releases both together.
This step carries `feat:` commits (the seam, the config field, the checkpoint), so it cuts the release on its own.

## Problem Statement

Step 4 ([#598]) reshaped the live-authority layer into a Chain of Responsibility (`Authorizer` links returning `allow | deny | defer`, ending at a `TerminalAuthorizer`), but `AuthorizerSelection.activate` composes `composeAuthorizerChain([], terminal)` — a literal empty link list, registering nothing.
For a downstream extension to offer a link, and for the operator (not the extension) to decide whether and where it sits, the chain needs a registration surface and a config-driven ordering.
ADR 0007 (`docs/decisions/0007-model-judge-authorizer-chain-adr.md`, accepted) fixes three invariants this step honors: config order (not registration order) fixes the security-relevant chain order; a missing configured link is skipped fail-safe (more prompting, never less); registration alone grants no authority — a link decides nothing until the operator names it in `authorizerChain`.
The enforcement checkpoint caps any link's authority so a buggy or over-eager external judge cannot exceed the operator's policy.

## Goals

- Add `registerAuthorizer(name, authorize)` to `PermissionsService`, returning a disposer, mirroring the `registerToolAccessExtractor` / `registerToolInputFormatter` precedent; back it with a new `AuthorizerRegistry`.
- Add an optional `authorizerChain: string[]` config field, carried through the schema, `extension-config.ts`, and `mergeUnifiedConfigs()`, with a regenerated `schemas/permissions.schema.json`.
- Inject a narrow, session-scoped `PermissionQuery` into each link (`Authorizer.authorize(details, query)`) per ADR 0007 §3 — the query capability Step 4 deferred here.
- Resolve the configured chain in `AuthorizerSelection.activate`: registered links in **config order**, unregistered names skipped with a warning (fail-safe), each wrapped in the enforcement checkpoint, then composed ahead of the terminal.
- Add the enforcement checkpoint: a link's `allow` on an **excluded surface** downgrades to `defer`.
  For this step the excluded set is the whole `path` surface plus `external_directory` (conservative; see Design Overview).
- Document the surface in `config/config.example.json`, `docs/configuration.md`, and `README.md`, and expose the link-author types (`Authorizer`, `AuthorizerVerdict`, `PermissionQuery`, `PromptPermissionDetails`) from the public `service.ts` entry.

This change is **not breaking**.
No observable behavior, output shape, or default changes on upgrade: `authorizerChain` defaults to empty and no first-party link registers until Step 6 ([#600]), so `AuthorizerSelection` still composes an empty chain (terminal identity) exactly as today.

## Non-Goals

- The allow-capable opaque-bash adjudicator (ADR 0007 §6 slice 2) — filed as [#620].
  It owns consuming the injected `PermissionQuery` (decomposing an opaque command and querying per sub-command), refining the checkpoint's whole-`path` exclusion down to a **secret-shaped** exclusion, and the `origin:"authorizer:model"` audit provenance.
- A hard-coded secret-path denylist in the checkpoint.
  There is no formal secrets model in the codebase, so this step excludes the whole `path` surface rather than shipping a speculative denylist ahead of any allow-capable consumer; the refinement is [#620]'s to make.
- A configurable `modelDelegation` block (ADR 0007 §5's `allowedSurfaces`/`excludedSurfaces`).
  The excluded set is fixed for this step; a config-driven envelope belongs with the allow-capable slice ([#620]) that needs it.
- The first-party dogfood link (`@gotgenes/pi-permission-model-judge`) — Step 6 ([#600]).

## Background

Relevant modules:

- `src/service.ts` — the public cross-extension entry (the `.` export; `dist/public.d.ts` is rolled from it by `rollup.dts.config.mjs`).
  Declares `PermissionsService` (`checkPermission`, `getToolPermission`, `registerToolInputFormatter`, `registerToolAccessExtractor`) and the `getPermissionsService()` / `publishPermissionsService()` accessors.
- `src/permissions-service.ts` — `LocalPermissionsService`, the in-process implementation: `checkPermission` routes bash through `resolveBashAdvisoryCheck` and path-shaped surfaces through `buildAccessIntentForSurface` + the shared `PermissionResolver`, so it answers at gate parity and against the live session cwd ([#503]).
- `src/tool-access-extractor-registry.ts` — the registration precedent: a `Map`-backed registry with ISP `Registrar` (write) / `Lookup` (read) interfaces, throw-on-duplicate, and an identity-guarded disposer.
- `src/authority/authorizer.ts` — `AuthorizerVerdict`, the non-terminal `Authorizer` (`authorize(details): Promise<AuthorizerVerdict>`), `TerminalAuthorizer`, `AuthorizerSelectionDeps`, and `selectAuthorizer`.
- `src/authority/authorizer-chain.ts` — `composeAuthorizerChain(links, terminal)`: folds links ahead of the terminal; empty links returns the terminal instance (identity).
- `src/authority/authorizer-selection.ts` — `AuthorizerSelection` (the `AskEscalator`): `activate` runs `selectAuthorizer` and composes the chain; its constructor bag is `AuthorizerSelectionDeps & { prompter }` and already carries a `registry?: SubagentSessionRegistry` (name collision — the authorizer registry dep must be named `authorizerRegistry`).
- `src/authority/permission-prompter.ts` — `PromptPermissionDetails`, which carries `accessIntent?: ForwardedAccessFacts` (the gate-computed `surface` + match set, present for every gate surface on a raised ask) and a `surface?: string | null` override — the checkpoint's source of the ask's surface.
- `src/config-schema.ts`, `src/extension-config.ts`, `src/config-loader.ts` (`mergeUnifiedConfigs`) — the config source-of-truth chain; `scripts/verify-public-types.sh` gates the packaged public surface against a symbol allowlist.

AGENTS.md / skill constraints that apply:

- Adding a config field means: define it in `unifiedConfigSchema` with `.meta`, regenerate the schema (`pnpm run gen:schema`), carry it through `PermissionSystemExtensionConfig` + `normalizePermissionSystemConfig` + `mergeUnifiedConfigs()`.
  A field on the runtime type but not the merge intermediate is silently dropped (the [#332]/[#347] class); post-[#356] the compiler flags the `normalizePermissionSystemConfig` gap.
  Do not add the optional field to `DEFAULT_EXTENSION_CONFIG` with an explicit `undefined` (breaks `deepEqual` tests).
- A parity test (`config-schema.test.ts`) fails if the committed JSON schema drifts.
- Mark the completed roadmap step `✅` (heading + Mermaid node) with a `Landed:` note in the implementation doc-update commit, not a deferred ship commit.
- Architecture-doc module-tree entries describe **current behavior**; cite an issue only for an active constraint.
- The public surface is bundled from `src/service.ts`; new link-author types must be exported there and added to `verify-public-types.sh`'s symbol list (`dist` is untracked, built at prepack — no committed artifact to regenerate).

## Design Overview

### The registration seam

`registerAuthorizer` mirrors `registerToolAccessExtractor` exactly: a named capability on the published service, one registration per name, throw-on-duplicate, identity-guarded disposer.
It stores the link's `authorize` callback (not an `Authorizer` object), matching `registerToolAccessExtractor(name, extractor)` where the value is the function.

```typescript
// service.ts — added to PermissionsService
registerAuthorizer(name: string, authorize: Authorizer["authorize"]): () => void;
```

A new `src/authority/authorizer-registry.ts` provides the storage, mirroring `tool-access-extractor-registry.ts`:

```typescript
export interface AuthorizerRegistrar {
  register(name: string, authorize: Authorizer["authorize"]): () => void;
}
export interface AuthorizerLookup {
  get(name: string): Authorizer["authorize"] | undefined;
}
export class AuthorizerRegistry implements AuthorizerLookup, AuthorizerRegistrar {
  private readonly links = new Map<string, Authorizer["authorize"]>();
  // register: throw-on-duplicate, identity-guarded disposer (as ToolAccessExtractorRegistry)
  // get: this.links.get(name)
}
```

The registry is storage only.
The config-order resolution, the fail-safe skip-with-warning, and the enforcement-checkpoint wrapping live in `AuthorizerSelection` (the composition policy), keeping the registry single-responsibility.

`index.ts` constructs one `AuthorizerRegistry` and injects it into both `LocalPermissionsService` (as `AuthorizerRegistrar`, for `registerAuthorizer`) and `AuthorizerSelection` (as `AuthorizerLookup`, for resolution) — the same instance, so a registration is visible to composition.

### The injected PermissionQuery

ADR 0007 §3 injects a narrow, session-scoped query into each link rather than letting a link reach for `PermissionsService` via `Symbol.for()` (a Law-of-Demeter reach-through to a global).
`PermissionQuery` is the two read methods `PermissionsService` already exposes, split into a narrower contract:

```typescript
// service.ts
export interface PermissionQuery {
  checkPermission(surface: string, value?: string, agentName?: string): PermissionCheckResult;
  getToolPermission(toolName: string, agentName?: string): PermissionState;
}
export interface PermissionsService extends PermissionQuery {
  registerAuthorizer(name: string, authorize: Authorizer["authorize"]): () => void;
  registerToolInputFormatter(/* … */): () => void;
  registerToolAccessExtractor(/* … */): () => void;
}
```

The link signature widens (the query Step 4 deferred):

```typescript
// authorizer.ts
export interface Authorizer {
  authorize(details: PromptPermissionDetails, query: PermissionQuery): Promise<AuthorizerVerdict>;
}
```

`TerminalAuthorizer.authorize(details)` stays one-arg — the terminal never queries.

The injected query **is** the shared `LocalPermissionsService`, narrowed to `PermissionQuery`: it already routes bash through `resolveBashAdvisoryCheck` and paths through the shared resolver at gate parity and against the live session cwd, so reusing it (rather than rebuilding a query object) keeps gate parity by construction and avoids duplicating that routing.
The link sees only the two `PermissionQuery` methods (ISP satisfied at the type level).

`composeAuthorizerChain` threads the query to each link at ask time:

```typescript
export function composeAuthorizerChain(
  links: readonly Authorizer[],
  terminal: TerminalAuthorizer,
  query: PermissionQuery,
): TerminalAuthorizer {
  if (links.length === 0) return terminal; // identity preserved
  return {
    async authorize(details) {
      for (const link of links) {
        const verdict = await link.authorize(details, query);
        const decision = decideFromVerdict(verdict);
        if (decision) return decision;
      }
      return terminal.authorize(details);
    },
  };
}
```

With empty links the `query` is unused and the terminal instance is returned — the Step 4 identity that keeps behavior byte-identical until a link registers.

### The enforcement checkpoint

The chain owner caps every link's verdict so a link cannot exceed the operator's policy.
A new `src/authority/delegation-envelope.ts` wraps a link's `authorize`: if the verdict is `allow` and the ask's surface is excluded, it returns `defer` instead.

```typescript
export const DELEGATION_EXCLUDED_SURFACES: ReadonlySet<string> = new Set([
  "external_directory",
  "path",
]);

export function encloseInDelegationEnvelope(
  authorize: Authorizer["authorize"],
): Authorizer["authorize"] {
  return async (details, query) => {
    const verdict = await authorize(details, query);
    if (verdict.kind === "allow" && isExcludedSurface(details)) {
      return { kind: "defer" };
    }
    return verdict;
  };
}

function isExcludedSurface(details: PromptPermissionDetails): boolean {
  const surface = details.accessIntent?.surface ?? details.surface ?? undefined;
  // Fail-safe: an ask whose surface the checkpoint cannot determine is treated
  // as excluded (more prompting, never less — ADR 0007 invariant 2).
  return surface === undefined || DELEGATION_EXCLUDED_SURFACES.has(surface);
}
```

The excluded set is the whole `path` surface plus `external_directory`.
The issue names "secret-shaped path", but there is no secrets model to key that on, and the checkpoint is dormant this batch (the deny-first dogfood link, [#600], returns only `deny`/`defer` — it never allows), so the conservative whole-`path` exclusion ships now and [#620] refines it to secret-only when an allow-capable link makes that distinction meaningful.
An unknown surface is treated as excluded (fail-safe): a link's `allow` on an ask the checkpoint cannot classify falls through to the terminal (a prompt), never past it.

### Config-driven chain resolution

`AuthorizerSelection.activate` resolves the configured names, wraps each in the envelope, and composes:

```typescript
activate(ctx: ExtensionContext): void {
  const terminal = selectAuthorizer(ctx, this.deps);
  const links = this.resolveConfiguredLinks();
  this.selected = composeAuthorizerChain(links, terminal, this.deps.getPermissionQuery());
}

private resolveConfiguredLinks(): Authorizer[] {
  const links: Authorizer[] = [];
  for (const name of this.deps.getAuthorizerChain()) {
    const authorize = this.deps.authorizerRegistry.get(name);
    if (authorize === undefined) {
      this.deps.logger.review(/* fail-safe: skip unregistered name with a warning */);
      continue;
    }
    links.push({ authorize: encloseInDelegationEnvelope(authorize) });
  }
  return links;
}
```

Iterating `getAuthorizerChain()` (the config order) — not the registry's insertion order — makes chain order deterministic operator policy (ADR invariant 1).
An unregistered name is skipped with a warning (invariant 2), leaving the ask to reach the terminal.
An empty or all-unregistered chain yields `[]` → terminal identity, so the seam ships vacant-safe until [#600].

`AuthorizerSelection`'s constructor bag gains three deps (on the class's own intersection type, **not** `AuthorizerSelectionDeps` — `selectAuthorizer` must not widen): `authorizerRegistry: AuthorizerLookup`, `getAuthorizerChain: () => string[]`, `getPermissionQuery: () => PermissionQuery`.
`getPermissionQuery` is a thunk because `permissionsService` is constructed after `authorizerSelection` in `index.ts`; the thunk runs at `session_start` (activate), well after assignment.

### Design-review checklist

- **Dependency width** — the three new `AuthorizerSelection` deps are each read once in `activate`; no wide shared bag (`AuthorizerSelectionDeps`, `selectAuthorizer`'s input, is untouched).
- **Law of Demeter** — a link talks only to its injected `query`; the checkpoint reads `details.accessIntent?.surface` (one hop into a value object it is handed), not a reach-through to a collaborator.
- **Output arguments** — the envelope and the registry return values; nothing is written back into a received bag.
- **Repeated discriminators** — the `verdict.kind` switch stays a single dispatch point in `composeAuthorizerChain`; the checkpoint's surface test is one predicate.
- **Test mock depth** — `PermissionQuery` is a two-method stub; the registry is a `Map`; no `as unknown as` casts.

No structural smells; the change is fit for one PR across the TDD steps below.

## Module-Level Changes

Source:

- `src/service.ts` — add `PermissionQuery` interface; make `PermissionsService extends PermissionQuery` (move `checkPermission` + `getToolPermission` into `PermissionQuery`); add `registerAuthorizer(name, authorize)`; re-export the link-author types `Authorizer`, `AuthorizerVerdict` (from `./authority/authorizer`), and `PromptPermissionDetails` (from `./authority/permission-prompter`) so `dist/public.d.ts` carries them.
- `src/permissions-service.ts` — `LocalPermissionsService` gains a constructor param `authorizerRegistry: AuthorizerRegistrar` and the `registerAuthorizer` method delegating to it.
- `src/authority/authorizer.ts` — widen `Authorizer.authorize(details, query: PermissionQuery)`; import `PermissionQuery` from `#src/service`.
- `src/authority/authorizer-registry.ts` — **new**: `AuthorizerRegistrar` / `AuthorizerLookup` / `AuthorizerRegistry` (mirrors `tool-access-extractor-registry.ts`).
- `src/authority/authorizer-chain.ts` — widen `composeAuthorizerChain(links, terminal, query)`; pass `query` to `link.authorize(details, query)`; empty-links identity unchanged.
- `src/authority/delegation-envelope.ts` — **new**: `DELEGATION_EXCLUDED_SURFACES`, `encloseInDelegationEnvelope`.
- `src/authority/authorizer-selection.ts` — add `authorizerRegistry` / `getAuthorizerChain` / `getPermissionQuery` to the constructor bag; `activate` resolves configured links (config order, skip-unregistered+warn, envelope-wrap) and passes the query to `composeAuthorizerChain`; import `encloseInDelegationEnvelope` and the registry/query types.
- `src/config-schema.ts` — add `authorizerChain: z.array(z.string().min(1)).optional().meta({ … })` to `unifiedConfigSchema`.
- `src/extension-config.ts` — add `authorizerChain?: string[]` to `PermissionSystemExtensionConfig`; carry it in `normalizePermissionSystemConfig` (`if (raw.authorizerChain !== undefined) …`); do **not** add to `DEFAULT_EXTENSION_CONFIG`.
- `src/config-loader.ts` — merge `authorizerChain` in `mergeUnifiedConfigs()` (array override-replaces-base, as `piInfrastructureReadPaths`).
- `src/index.ts` — construct `new AuthorizerRegistry()`; pass it to `LocalPermissionsService` and to `AuthorizerSelection` (as `authorizerRegistry`); add `getAuthorizerChain: () => configStore.current().authorizerChain ?? []` and `getPermissionQuery: () => permissionsService` to the `AuthorizerSelection` deps.

Generated / gates:

- `schemas/permissions.schema.json` — regenerate via `pnpm run gen:schema` (the `authorizerChain` field; the parity test enforces it).
- `scripts/verify-public-types.sh` — add `registerAuthorizer`, `Authorizer`, `AuthorizerVerdict`, `PermissionQuery`, `PromptPermissionDetails` to the symbol allowlist grep.

Tests (`test/`):

- `test/authority/authorizer-registry.test.ts` — **new**: register/get, throw-on-duplicate, identity-guarded disposer.
- `test/authority/delegation-envelope.test.ts` — **new**: `allow` on `path`/`external_directory`/unknown → `defer`; `allow` on `bash`/a tool surface passes; `deny`/`defer` pass through unchanged on every surface.
- `test/authority/authorizer-chain.test.ts` — update the seven existing cases for the `(links, terminal, query)` signature; add an assertion that a link receives the injected `query` (`toHaveBeenCalledWith(details, query)`).
- `test/authority/authorizer-selection.test.ts` — add: resolves configured links in config order; skips an unregistered name with a warning; envelope caps an excluded-surface `allow`; empty/all-unregistered chain preserves the `expect.any(LocalUserAuthorizer)` terminal identity.
- `test/permissions-service.test.ts` — `registerAuthorizer` delegates to the injected registrar and returns its disposer.
- `test/extension-config.test.ts` / config-merge test — `authorizerChain` normalizes and merges (override-replaces-base).
- `test/config-schema.test.ts` — parity test picks up the regenerated schema automatically.
- `test/composition-root.test.ts` — assert the same `AuthorizerRegistry` instance backs both `registerAuthorizer` and chain resolution (a registration is visible to composition); default (no config, no registration) still composes the terminal identity.

Docs:

- `config/config.example.json` — add `"authorizerChain": []` (empty = no links, the safe default), alongside `piInfrastructureReadPaths`.
- `docs/configuration.md` — document `authorizerChain`, the `registerAuthorizer` cross-extension seam, the three ADR invariants (config order, fail-safe skip, opt-in activation), and the enforcement checkpoint (excluded surfaces).
- `README.md` — add `authorizerChain` to the config surface and note the `registerAuthorizer` seam.
- `.pi/skills/package-pi-permission-system/SKILL.md` — add `registerAuthorizer` to the cross-extension service surface description and `authorizerChain` to the config-field list.
- `docs/architecture/architecture.md` — mark Step 5 `✅` (the `#### Step 5:` heading and the `S5` Mermaid node) with a `Landed:` note; add module-tree entries for `authorizer-registry.ts` and `delegation-envelope.ts`; update the `authorizer.ts` (query param), `authorizer-chain.ts` (query param), `service.ts` (`PermissionQuery` + `registerAuthorizer`), and `authorizer-selection.ts` (config-driven resolution) tree entries to current behavior.
  Do not edit the fixed `Baseline (2026-07-15)` column or the health-metrics target values.

No `package.json` `exports` path changes (the entry stays `src/service.ts`); the new public types flow through the existing rollup bundle.

## Test Impact Analysis

1. **New tests the change enables** — `AuthorizerRegistry` and `encloseInDelegationEnvelope` are pure units, testable in isolation (registration semantics; the verdict cap per surface).
   `AuthorizerSelection`'s config-driven resolution (order, skip-warn, envelope, identity) is newly assertable now that it reads a registry and config.
2. **Redundant existing tests** — none.
   The Step 4 `authorizer-chain.test.ts` cases are **migrated** (signature widened), not removed; they still pin the verdict→decision mapping and the empty-links identity.
3. **Tests that must stay** — `authorizer-selection.test.ts`'s `expect.any(LocalUserAuthorizer)` identity assertion and `authorizer.test.ts`'s per-context terminal selection are the behavior pins proving the seam ships vacant-safe (empty chain ⇒ terminal identity).
   They must stay green.

## Invariants at risk

Step 4 ([#598]) documented: "behavior is identical with zero registered links, pinned by the existing authorizer-selection tests; `composeAuthorizerChain([], terminal)` returns the terminal instance (identity)."
Step 5 widens `composeAuthorizerChain`'s signature and replaces the literal `[]` with resolved links — it must not regress that outcome.

| Invariant                                                                                                         | Pinned by                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Empty/all-unregistered chain ⇒ terminal identity (behavior byte-identical)                                        | `authorizer-selection.test.ts` (`expect.any(LocalUserAuthorizer)`); a `composeAuthorizerChain([], t, q) === t` case in `authorizer-chain.test.ts` |
| One terminal selected per activation by context                                                                   | `authorizer.test.ts` (`instanceof` per context) — unchanged                                                                                       |
| Verdict→decision mapping (`allow`→approved non-persistent; `deny`→`createDeniedPermissionDecision`; `defer`→next) | `authorizer-chain.test.ts` (migrated to the query signature)                                                                                      |
| `escalate` rejects before activate / after deactivate                                                             | `authorizer-selection.test.ts` — unchanged                                                                                                        |

## TDD Order

1. **Inject `PermissionQuery` and widen the link signature.**
   Red — update `authorizer-chain.test.ts` to the `(links, terminal, query)` signature and add a `link.authorize` called-with-`query` assertion; keep the `composeAuthorizerChain([], t, q) === t` identity case.
   Green — add `PermissionQuery` + `PermissionsService extends PermissionQuery` in `service.ts`; widen `Authorizer.authorize(details, query)`; widen `composeAuthorizerChain(links, terminal, query)`; add `getPermissionQuery: () => permissionsService` to `AuthorizerSelection` and pass it through `activate` (still `[]` links); wire `getPermissionQuery` in `index.ts`.
   This is one commit — widening the exported `Authorizer` type and `composeAuthorizerChain` breaks every caller at compile time, so the interface change and its consumers land together.
   Commit: `feat(pi-permission-system): inject a session-scoped PermissionQuery into chain links (#599)`
2. **Add `AuthorizerRegistry` and `registerAuthorizer`.**
   Red — `authorizer-registry.test.ts` (register/get/throw-on-dup/disposer) and a `permissions-service.test.ts` case (`registerAuthorizer` delegates + returns the disposer).
   Green — `authorizer-registry.ts`; `registerAuthorizer` on `PermissionsService` + `LocalPermissionsService` (new constructor param); re-export the link-author types from `service.ts`; construct + inject the registry in `index.ts`; add the new symbols to `verify-public-types.sh`.
   Commit: `feat(pi-permission-system): add registerAuthorizer cross-extension seam (#599)`
3. **Add the `authorizerChain` config field.**
   Red — `extension-config.ts` normalize test + `mergeUnifiedConfigs` test for `authorizerChain`; the schema parity test after regeneration.
   Green — `config-schema.ts` field + `.meta`; `pnpm run gen:schema`; `PermissionSystemExtensionConfig` + `normalizePermissionSystemConfig`; `mergeUnifiedConfigs`.
   Commit: `feat(pi-permission-system): add authorizerChain config field (#599)`
4. **Add the enforcement checkpoint.**
   Red — `delegation-envelope.test.ts` (excluded-surface `allow`→`defer`; unknown surface fail-safe; non-excluded surface and non-`allow` verdicts pass through).
   Green — `delegation-envelope.ts`.
   Commit: `feat(pi-permission-system): cap link verdicts with the delegation envelope (#599)`
5. **Resolve the configured chain in `AuthorizerSelection`.**
   Red — `authorizer-selection.test.ts` (config-order resolution; skip-unregistered+warn; envelope applied; empty/all-unregistered identity) and a `composition-root.test.ts` case (shared registry instance backs both surfaces; default composes the terminal identity).
   Green — `AuthorizerSelection` gains `authorizerRegistry` + `getAuthorizerChain`; `activate` resolves + wraps + composes; `index.ts` passes the shared registry and `getAuthorizerChain`.
   Commit: `feat(pi-permission-system): resolve the configured authorizer chain (#599)`
6. **Docs and Step 5 completion.**
   `config/config.example.json`, `docs/configuration.md`, `README.md`, the package skill, and the architecture Step-5 `✅` + `Landed:` note + module-tree entries.
   Commit: `docs(pi-permission-system): document registerAuthorizer + authorizerChain and mark Phase 12 Step 5 complete (#599)`

## Risks and Mitigations

- **A silent behavior change from replacing `[]` with resolved links.**
  Mitigation: with no config and no registration, `resolveConfiguredLinks()` returns `[]` and `composeAuthorizerChain([], t, q)` returns the terminal instance; the `expect.any(LocalUserAuthorizer)` identity assertion and the default composition-root case pin it.
- **A dropped `import type` in the atomic Step 1 reshape (`tsc` passes on an unused type import).**
  Mitigation: after Step 1, re-read `service.ts` / `authorizer.ts` / `authorizer-chain.ts` and run `pnpm --filter @gotgenes/pi-permission-system run check` + `run lint` (lint flags unused imports).
- **The checkpoint mis-reads the ask's surface (a bypass).**
  Mitigation: read the gate-authoritative `details.accessIntent?.surface` first; treat an undetermined surface as excluded (fail-safe); the envelope only ever *downgrades* `allow`, never upgrades, so a mis-read causes more prompting, never less.
- **A vacant public param ([`PermissionQuery`] with no day-one consumer).**
  Mitigation: the injection is ADR 0007 §3's seam shape and [#620] is filed to consume it; the param is exercised by tests now (a link asserts it receives the query), so it is not dead.
- **Schema drift.**
  Mitigation: regenerate with `pnpm run gen:schema` in Step 3 and let `config-schema.test.ts` gate it; run `pnpm fallow dead-code` before pushing (the new registry/envelope are consumed by `AuthorizerSelection`).

## Open Questions

- **Whole-`path` vs. secret-shaped exclusion.**
  This step excludes the whole `path` surface; [#620] refines it to secret-shaped once an allow-capable link makes the distinction meaningful (and can key it on operator `path` rules rather than a hard-coded denylist).
  Recorded as a Non-Goal, not an oversight.
- **`origin:"authorizer:model"` audit provenance and session-scoped grant shape.**
  The envelope currently maps a link `allow` to a non-persistent `approved` decision (Step 4's mapping); the audited/`origin`-tagged shape for an allow-capable grant is [#620]'s envelope work per ADR 0007 §6.

[#332]: https://github.com/gotgenes/pi-packages/issues/332
[#347]: https://github.com/gotgenes/pi-packages/issues/347
[#356]: https://github.com/gotgenes/pi-packages/issues/356
[#503]: https://github.com/gotgenes/pi-packages/issues/503
[#598]: https://github.com/gotgenes/pi-packages/issues/598
[#600]: https://github.com/gotgenes/pi-packages/issues/600
[#620]: https://github.com/gotgenes/pi-packages/issues/620
