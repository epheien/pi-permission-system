---
issue: 476
issue_title: "pi-permission-system: introduce the AccessPath value object (Phase 6 Step 4)"
---

# Introduce the `AccessPath` value object (Phase 6 Step 4)

## Release Recommendation

**Release:** mid-batch — defer (batch "access-path-unification"); confirm at ship time

This is Step 4 of the Phase 6 access-intent roadmap, and the **head** of release batch "access-path-unification" (Steps 4, 5).
Step 4 alone leaves both the new `AccessPath` type and the old free helpers' boundary primitive in place — a transitional state where the two external-directory gates each still re-derive their own match values — so it ships with the batch tail, Step 5 ([#477]), which collapses both gates onto one shared `AccessPath` policy check.
Do not cut a release for Step 4 on its own; hold the release-please PR open until Step 5 lands.

## Problem Statement

Today a single `string` carries a path's two distinct meanings: the **lexical** (as-typed, normalized but not symlink-resolved) form used for `external_directory` pattern matching, and the **canonical** (symlink-resolved) form used for the outside-CWD boundary decision.
This conflation produced a real bug — [#418], where both external-directory gates matched config patterns against the symlink-resolved path instead of the typed path, defeating a configured `/tmp/*` allow.
The [#418] fix added two free helpers (`getExternalDirectoryPolicyValues`, `canonicalNormalizePathForComparison`) and a docstring convention, but the misuse — passing a boundary value where a match value belongs — is still expressible.
The architecture doc names this pairing as "the embryo of the access-path value object": an `AccessPath` holding both forms behind distinct accessors would make the misuse a **compile error** rather than a convention.

## Goals

- Add `src/access-intent/access-path.ts` with an `AccessPath` value object exposing `matchValues(): string[]` (the lexical alias union ∪ canonical, the #418 match set), `boundaryValue(): string` (the canonical form), and `value(): string` (the lexical display form).
- Route the single-tool external-directory gate (`describeExternalDirectoryGate`) through `AccessPath` for its match values and infra-read canonical.
- Change `BashProgram.externalPaths()` to return `AccessPath[]` instead of lexical strings, and route the bash external-directory gate (`describeBashExternalDirectoryGate`) through `AccessPath`.
- Fold `getExternalDirectoryPolicyValues` entirely into `AccessPath.matchValues()` and remove it.
- Behavior-preserving: the same paths are flagged, the same patterns match, the same boundary decisions hold.
  Not a breaking change — no user-facing config, output, or default changes.

## Non-Goals

- **Collapsing the two external-directory gates onto one shared policy check** — that is Step 5 ([#477]).
  Step 4 wires both gates onto `AccessPath` individually; each still re-derives its own match values.
  The boundary-logic single-sourcing happens in Step 5.
- **Narrowing `ScopedPermissionResolver` to `resolve(intent)`** — Step 6 ([#478]).
- **Giving `AccessPath` a boundary-decision method** (`isOutsideWorkingDirectory()`).
  Per the operator's decision, Step 4 keeps `AccessPath` to accessors only; `isPathOutsideWorkingDirectory` stays a free function.
  Pulling the containment decision onto the value object would overlap Step 5's gate collapse.
- **Removing `canonicalNormalizePathForComparison`.**
  Per the operator's decision, it is retained as the shared boundary primitive: the `AccessPath` factory composes it, and `isPathOutsideWorkingDirectory` still calls it (on both the path and the cwd).
  Only `getExternalDirectoryPolicyValues` is fully folded and removed.
- **Principal identity / cross-session path portability** — deferred follow-ups named in the architecture's "Remaining design work", not in Phase 6 scope.

## Background

Relevant modules and their current shapes:

- `src/path-utils.ts` — owns `getExternalDirectoryPolicyValues(pathValue, cwd): string[]` (lexical aliases ∪ canonical), `canonicalNormalizePathForComparison(pathValue, cwd): string` (symlink-resolved + win32-lowercased), `getPathPolicyValues(pathValue, opts): string[]` (lexical alias union), `normalizePathForComparison(pathValue, cwd): string` (absolute lexical), and `isPathOutsideWorkingDirectory(pathValue, cwd): boolean` (boundary decision, canonicalizes both path and cwd).
- `src/handlers/gates/external-directory.ts` — `describeExternalDirectoryGate`: calls `isPathOutsideWorkingDirectory` (applicability), `canonicalNormalizePathForComparison` (infra-read containment), and `getExternalDirectoryPolicyValues` (match values for `resolver.resolvePathPolicy(..., "external_directory")`).
- `src/handlers/gates/bash-external-directory.ts` — `describeBashExternalDirectoryGate`: reads `bashProgram.externalPaths()` (lexical strings) and calls `getExternalDirectoryPolicyValues(p, tcc.cwd)` per path for the policy check.
- `src/access-intent/bash/program.ts` — `BashProgram.externalPaths(): string[]` (parameter-free getter, born-ready since [#475]); the field is `resolvedExternalPaths: readonly string[]`, populated at `parse(command, cwd)` from `projectExternalPaths`.
- `src/access-intent/bash/cwd-projection.ts` — `projectExternalPaths(candidates, cwd): string[]`; already computes both `lexical` (absolute, cd-aware) and `canonical` per candidate, pushes the `lexical` string, dedups on `canonical`.
- `src/handlers/gates/bash-path-extractor.ts` — `extractExternalPathsFromBashCommand(command, cwd): Promise<string[]>`, a thin test-facing facade over `BashProgram.externalPaths()`.

Constraints from AGENTS.md / package skill that apply:

- `docs/architecture/architecture.md` tracks Phase 6 as a numbered step list plus a Mermaid graph; mark Step 4 ✅ (heading + node) as part of this change.
- The win32 case-folding behavior (`PATH_SURFACES`, [#382]) must be preserved — the `AccessPath` factory must recompute the canonical via `canonicalNormalizePathForComparison` (which lowercases on win32), not reuse a raw `canonicalizePath` output that skips lowercasing.
- `fallow dead-code` gates CI: a newly-added export with no production consumer fails it, so `AccessPath` must land **with** its first consumer in the same commit, and `getExternalDirectoryPolicyValues` must be removed in the same commit its last consumer migrates.

## Design Overview

### `AccessPath` value object

A path-representation value object that holds the two forms behind type-distinct accessors.
The core of the #418 fix is that `matchValues()` returns `string[]` while `boundaryValue()` returns `string` — so the gate cannot accidentally pass the canonical boundary string to `resolvePathPolicy(string[])`; the misuse is a type error.

```typescript
export class AccessPath {
  private constructor(
    private readonly lexical: string, // as-typed, normalized, NOT symlink-resolved (display/pattern)
    private readonly matchAliases: readonly string[], // lexical alias union (getPathPolicyValues output)
    private readonly canonical: string, // symlink-resolved + win32-folded; "" when unresolvable
  ) {}

  /**
   * Pattern-match values for the `external_directory` surface: the lexical
   * alias union plus the canonical alias, so a config pattern on either the
   * typed form (`/tmp/*`) or the resolved form (`/private/tmp/*`) matches (#418).
   * Collapses to the lexical aliases when the canonical equals one of them.
   */
  matchValues(): string[] {
    return this.canonical
      ? [...new Set([...this.matchAliases, this.canonical])]
      : [...this.matchAliases];
  }

  /** Canonical (symlink-resolved) form, for the outside-CWD boundary and infra-read containment. */
  boundaryValue(): string {
    return this.canonical;
  }

  /** Lexical (as-typed, normalized) form, for display, approval patterns, decision values, and logs. */
  value(): string {
    return this.lexical;
  }

  /** An external-directory tool/bash path resolved against `cwd`. */
  static forExternalDirectory(pathValue: string, cwd: string): AccessPath {
    return new AccessPath(
      normalizePathForComparison(pathValue, cwd),
      getPathPolicyValues(pathValue, { cwd }),
      canonicalNormalizePathForComparison(pathValue, cwd),
    );
  }
}
```

`matchValues()` is exactly the body of today's `getExternalDirectoryPolicyValues` — `getPathPolicyValues(pathValue, { cwd })` ∪ `canonicalNormalizePathForComparison(pathValue, cwd)` — so it is behavior-identical.

### Single-tool gate call site (Tell-Don't-Ask check)

```typescript
const accessPath = AccessPath.forExternalDirectory(externalDirectoryPath, tcc.cwd);

const canonicalExtPath = accessPath.boundaryValue(); // was canonicalNormalizePathForComparison(...)
if (isPiInfrastructureRead(tcc.toolName, canonicalExtPath, infraDirs, tcc.cwd)) { ... }

const preCheck = resolver.resolvePathPolicy(
  accessPath.matchValues(), // was getExternalDirectoryPolicyValues(externalDirectoryPath, tcc.cwd)
  tcc.agentName ?? undefined,
  "external_directory",
);
```

The gate keeps the raw `externalDirectoryPath` string for messages, decision values, logs, and the applicability call `isPathOutsideWorkingDirectory(externalDirectoryPath, tcc.cwd)` — none of those move onto `AccessPath` in Step 4.
The approval pattern derivation `deriveApprovalPattern(normalizePathForComparison(externalDirectoryPath, tcc.cwd))` is left as-is (it equals `accessPath.value()`, but keeping the explicit call avoids any behavior drift; an optional simplification, not required).

### Bash gate + projection (extracted-module interaction check)

`projectExternalPaths` already computes `lexical` and `canonical` for its dedup/boundary loop; only the **return value** changes from the `lexical` string to an `AccessPath`.
The internal dedup `seen` set and the containment checks stay keyed on the raw `canonical` exactly as today — no behavior change there.
Each pushed path is wrapped via the factory, which recomputes the match aliases + canonical from the `lexical` string against `cwd` — identical to what the bash gate did before with `getExternalDirectoryPolicyValues(p, tcc.cwd)`.

```typescript
// cwd-projection.ts — projectExternalPaths now returns AccessPath[]
seen.add(canonical);
externalPaths.push(AccessPath.forExternalDirectory(lexical, cwd));
```

`forExternalDirectory(lexical, cwd)` recomputes the canonical via `canonicalNormalizePathForComparison` (win32-folded), preserving [#382] behavior — it does **not** reuse projection's raw `canonicalizePath` output (which skips win32 lowercasing).
This costs one extra `realpathSync` per external path inside the factory, but the bash gate previously paid the same call in `getExternalDirectoryPolicyValues`; net realpath calls are unchanged.

```typescript
// bash-external-directory.ts
const externalPaths = bashProgram.externalPaths(); // AccessPath[]
for (const p of externalPaths) {
  const check = resolver.resolvePathPolicy(
    p.matchValues(), // was getExternalDirectoryPolicyValues(p, tcc.cwd)
    tcc.agentName ?? undefined,
    "external_directory",
  );
  if (check.state !== "allow") uncoveredEntries.push({ path: p, check });
}
const uncoveredPaths = uncoveredEntries.map(({ path }) => path.value()); // string[] for messages/denial/log
```

The downstream message, denial-context, decision, and log shapes stay `string[]` (`uncoveredPaths`), so `external-directory-messages.ts` and `denial-messages.ts` are untouched.
The all-allowed bypass log (currently `externalPaths` in its details) must map to `externalPaths.map((p) => p.value())` since the variable is now `AccessPath[]`.

### Facade (`bash-path-extractor.ts`)

`extractExternalPathsFromBashCommand` is a test-only facade (its sole consumers are `bash-external-directory.test.ts` assertions).
Keep its `Promise<string[]>` contract by mapping `.value()`:

```typescript
return (await BashProgram.parse(command, cwd)).externalPaths().map((p) => p.value());
```

This preserves the ~90 projection-correctness assertions in `bash-external-directory.test.ts` unchanged (lift-and-shift; AGENTS.md guidance against rewriting a large test file wholesale).

## Module-Level Changes

- `src/access-intent/access-path.ts` — **new**.
  `AccessPath` class (`matchValues`, `boundaryValue`, `value`, private ctor, `forExternalDirectory` factory).
  Imports `getPathPolicyValues`, `normalizePathForComparison`, `canonicalNormalizePathForComparison` from `#src/path-utils`.
- `src/path-utils.ts` — **remove** `getExternalDirectoryPolicyValues` (folded into `AccessPath.matchValues()`).
  `canonicalNormalizePathForComparison`, `getPathPolicyValues`, `normalizePathForComparison`, `isPathOutsideWorkingDirectory` all **retained**.
- `src/handlers/gates/external-directory.ts` — build an `AccessPath`; replace the `canonicalNormalizePathForComparison` call with `boundaryValue()` and the `getExternalDirectoryPolicyValues` call with `matchValues()`.
  Drop those two imports; add the `AccessPath` import.
  Keep `isPathOutsideWorkingDirectory`, `normalizePathForComparison`, `getToolInputPath`, `isPiInfrastructureRead` imports.
- `src/handlers/gates/bash-external-directory.ts` — consume `AccessPath[]` from `externalPaths()`; use `p.matchValues()` / `p.value()`; map the all-allowed log `externalPaths` to `.value()`.
  Drop the `getExternalDirectoryPolicyValues` import; add `import type { AccessPath }` (for `uncoveredEntries`'s `path` field type).
- `src/access-intent/bash/cwd-projection.ts` — `projectExternalPaths` return type `string[]` → `AccessPath[]`; push `AccessPath.forExternalDirectory(lexical, cwd)` in both branches (the unknown-base relative branch and the resolved branch).
  Add the `AccessPath` import.
- `src/access-intent/bash/program.ts` — `resolvedExternalPaths: readonly string[]` → `readonly AccessPath[]`; `externalPaths(): string[]` → `externalPaths(): AccessPath[]`; update the constructor param type and the getter doc comment.
  Re-export `AccessPath` is **not** needed (consumers import from `#src/access-intent/access-path`).
- `src/handlers/gates/bash-path-extractor.ts` — map `.value()` to keep the `Promise<string[]>` contract; update the doc comment.
- `test/access-intent/access-path.test.ts` — **new**.
  Unit tests for `AccessPath` (migrating the `getExternalDirectoryPolicyValues` cases from `path-utils.test.ts` as `matchValues()` cases, plus `boundaryValue()` / `value()` / factory cases incl. symlink resolution and the unresolvable-canonical collapse).
- `test/path-utils.test.ts` — remove the `getExternalDirectoryPolicyValues` describe block and its import.
  Keep the `canonicalNormalizePathForComparison` describe block (helper retained).
- `test/access-intent/bash/program.test.ts` — adapt `externalPaths()` assertions to map `.value()` (~25 sites: `expect(program.externalPaths().map((p) => p.value())).toContain(...)` / `.toHaveLength(...)` stays on the array length).
- `test/handlers/gates/tool-call-gate-pipeline.test.ts` — update the `externalPaths` mock type from `vi.fn<() => []>` to `vi.fn<() => AccessPath[]>` (still returns `[]`).
- `docs/architecture/architecture.md` — update the `program.ts` tree-listing line (`externalPaths(): string[]` → `externalPaths(): AccessPath[]`); add an `access-path.ts` entry under the `access-intent/` tree; mark Step 4 ✅ on the step heading and the `S4` Mermaid node; update the "External-directory gate duplication" / metrics rows only if a value changes (the duplication row is Step 5's target — leave it).

No `SKILL.md` references the removed symbol or the `externalPaths()` return type (verified by grep), so no package-skill edit is needed.
Historical `docs/plans/` and `docs/retro/` files that mention these symbols are immutable history and are not edited.

## Test Impact Analysis

1. **New tests enabled** — `AccessPath` is now unit-testable in isolation (`test/access-intent/access-path.test.ts`): `matchValues()` dedup/union, `boundaryValue()` canonical, `value()` lexical, and factory symlink resolution.
   Previously these behaviors were only reachable through `getExternalDirectoryPolicyValues` + `canonicalNormalizePathForComparison` as separate free-function tests.
2. **Redundant tests** — the `getExternalDirectoryPolicyValues` describe block in `path-utils.test.ts` (the typed+symlink alias union, the dedup-when-equal case, the in-cwd relative-alias case) becomes redundant and migrates to `access-path.test.ts` as `matchValues()` cases.
3. **Tests that must stay as-is** — the `canonicalNormalizePathForComparison` describe block in `path-utils.test.ts` (helper retained); the external-directory integration tests (`external-directory-integration.test.ts`, `external-directory-session-dedup.test.ts`, `bash-external-directory.test.ts`) that genuinely exercise the #418 symlink-alias matching end-to-end through the gates — these pin the behavior-preservation and must stay green with only the facade's string view unchanged.

## Invariants at risk

This step retypes a surface that Step 3 ([#475]) just settled.

- **#475 outcome — `BashProgram` born-ready, parameter-free getters, `cwd` narrowed to `string`.**
  Step 4 changes only the `externalPaths()` return element type (`string` → `AccessPath`); the parameter-free, born-ready, eager-resolution shape is preserved.
  Pinned by `test/access-intent/bash/program.test.ts` (adapted to `.value()`).
- **#418 outcome — a config pattern on the typed path matches even when the path is a symlink.**
  Pinned by the migrated `matchValues()` tests in `access-path.test.ts` **and** the gate-level symlink-alias tests in `bash-external-directory.test.ts` / `external-directory-integration.test.ts`.
  These must stay green; the `AccessPath.matchValues()` body is the literal old helper body, so the alias union is unchanged.
- **#382 outcome — win32 case-folding on path surfaces.**
  Preserved by having the factory recompute the canonical through `canonicalNormalizePathForComparison` (win32-lowercasing) rather than a raw `canonicalizePath`.

## TDD Order

1. **Introduce `AccessPath` and route the single-tool external-directory gate through it.**
   Red: `test/access-intent/access-path.test.ts` — `matchValues()` (union, dedup-when-equal, in-cwd relative aliases), `boundaryValue()` (canonical, win32-fold, unresolvable → `""`), `value()` (lexical).
   Green: add `src/access-intent/access-path.ts`; rewire `external-directory.ts` to build an `AccessPath` and call `boundaryValue()` + `matchValues()`.
   `AccessPath` lands with a production consumer (no dead-code flag); `getExternalDirectoryPolicyValues` retains its bash consumer so it is not yet dead.
   Existing external-directory integration tests stay green (behavior-preserving).
   Commit: `feat(pi-permission-system): introduce AccessPath value object`
2. **Return `AccessPath[]` from `BashProgram.externalPaths`, route the bash gate, and remove `getExternalDirectoryPolicyValues`.**
   One atomic commit (the type-checker couples the `externalPaths()` return-type change to its consumers, and `fallow dead-code` couples `getExternalDirectoryPolicyValues`'s removal to its last consumer's migration).
   Red/adapt: `program.test.ts` assertions map `.value()`; migrate the `getExternalDirectoryPolicyValues` cases out of `path-utils.test.ts` into `access-path.test.ts`; update the `tool-call-gate-pipeline.test.ts` mock type.
   Green: change `projectExternalPaths` return type + push `AccessPath`; retype `program.ts` field/getter; rewire `bash-external-directory.ts` (use `matchValues()`/`value()`, map the bypass log); map `.value()` in `bash-path-extractor.ts`; remove `getExternalDirectoryPolicyValues` from `path-utils.ts`.
   Run `pnpm run test` + `pnpm fallow dead-code` to confirm no consumer was missed and nothing is newly dead.
   Commit: `refactor(pi-permission-system): return AccessPath[] from externalPaths and remove getExternalDirectoryPolicyValues`
3. **Update the architecture doc.**
   Update the `program.ts` tree line (`externalPaths(): AccessPath[]`), add the `access-path.ts` tree entry, and mark Step 4 ✅ (heading + `S4` node).
   No test cycle.
   Commit: `docs(pi-permission-system): record AccessPath value object in Phase 6 architecture`

## Risks and Mitigations

- **Win32 canonical drift** — reusing projection's raw `canonicalizePath` output (no lowercasing) in the match set would regress [#382].
  Mitigation: the factory recomputes via `canonicalNormalizePathForComparison`; explicit note in Design Overview and an invariant entry.
- **Silent dead-code / false-green from a missed consumer** — removing an export and retyping a getter can leave a stubbed test path passing `allow`.
  Mitigation: Step 2 runs `pnpm run test` + `pnpm fallow dead-code` before commit; the package-skill warns that `makeSurfaceCheck` stubs must route `resolvePathPolicy` — the integration tests (not just the edited file) gate this.
- **Large test-assertion churn in `program.test.ts`** — ~25 `.value()` adaptations.
  Mitigation: mechanical mapping, single step; no logic change.
- **Transitional duplication between the two gates** — Step 4 leaves each gate deriving its own `AccessPath`.
  Mitigation: intentional and tracked — Step 5 ([#477]) collapses them; release is deferred to the batch tail so the transitional state never ships alone.

## Open Questions

- None blocking.
  The two design forks (accessors-only vs. boundary-method; retain vs. remove `canonicalNormalizePathForComparison`) were resolved with the operator: **accessors-only** and **retain the primitive**.
  Whether `AccessPath` eventually grows a boundary-decision method is a Step 5 ([#477]) consideration, not Step 4.

[#382]: https://github.com/gotgenes/pi-packages/issues/382
[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#475]: https://github.com/gotgenes/pi-packages/issues/475
[#477]: https://github.com/gotgenes/pi-packages/issues/477
[#478]: https://github.com/gotgenes/pi-packages/issues/478
