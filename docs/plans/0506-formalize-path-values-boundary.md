---
issue: 506
issue_title: "pi-permission-system: decide and formalize the path-values boundary (Phase 7 Step 5)"
---

# Formalize the `path-values` boundary (Phase 7 Step 5)

## Release Recommendation

**Release:** ship independently

Phase 7 Step 5 is tagged `Release: independent` in the architecture roadmap, and the Release batches subsection lists it as "independently releasable (a decision / docs change)."
It is not a member of the `symlink-resistant-path-matching` batch (Steps 1–3, already shipped).
This is a docs-and-clarity change with one lint-config addition — it carries a `docs:` commit, which auto-batches into the next release; the ADR and the roadmap completion mark are the deliverables, not a behavior change that forces a release.

## Problem Statement

After Phase 7 Steps 1–2 ([#502], [#503]), the resolver is the sole producer of the `path-values` `AccessIntent` variant: every path gate emits `access-path` (carrying an `AccessPath`), and the resolver unwraps it via `matchValues()` into a string-based `path-values` intent before the manager evaluates rules.
The roadmap's [#487] vision listed "collapse the `path-values` variant" as a goal, but the residual variant is not transitional scaffolding — it is the seam between the path-aware resolver and the deliberately string-based manager.
Whether to formalize that seam or collapse it (moving the `matchValues()` unwrap into the manager, which would then import `AccessPath`) is a genuine design decision, resolved here as an explicit choice rather than a pre-committed mechanical change.

The decision: **formalize**.
Keep `path-values` as the manager's intentional string boundary, document why, and add a durability guard so the invariant cannot silently erode.

## Goals

- Record the formalize decision as an ADR (`docs/decisions/0002-path-values-string-boundary.md`), following the `0001` format.
- Tighten the JSDoc on `access-intent.ts`, `permission-resolver.ts`, and `permission-manager.ts` to name the boundary invariant as a contract and point to the ADR.
- Add an ESLint `no-restricted-imports` guard scoped to `permission-manager.ts` forbidding an import from `access-intent/access-path`, mirroring the existing `no-restricted-syntax` `process.platform` guard — so collapsing the boundary requires an explicit, reviewed lint exception.
- Mark Phase 7 Step 5 complete in `docs/architecture/architecture.md` (step heading ✅, Mermaid node ✅, metric row, residual-handling bullet) in the same commit as the work.
- Delete the scratch tour file (`docs/0506-path-values-boundary-tour.md`) once the ADR supersedes it.

This change is **non-breaking** — no runtime behavior changes, no public type changes, no config changes.

## Non-Goals

- **Collapsing the `path-values` variant.**
  Explicitly rejected by this decision; recorded as the rejected alternative in the ADR.
- **Changing `AccessPath`, the resolver's `toResolvedIntent`, or the manager's `check()` runtime logic.**
  Only their doc comments change.
- **Touching historical plans/retros** that mention `path-values` (`docs/plans/05xx`, `docs/retro/05xx`).
  They are point-in-time records, not living docs.
- **Config-pattern / prompt-input `AccessPath` migration and principal-identity work.**
  Already out of Phase 7 scope per the roadmap Non-goals.

## Background

Relevant modules and the role each plays in the boundary:

- `src/access-intent/access-intent.ts` — declares the two unions.
  `AccessIntent = ToolAccessIntent | AccessPathAccessIntent` (gate-facing) and `ResolvedAccessIntent = ToolAccessIntent | PathValuesAccessIntent` (manager-facing).
  `AccessPathAccessIntent` legitimately imports `AccessPath` (the gate-facing variant carries the value object); `PathValuesAccessIntent` carries only `readonly string[]`.
- `src/permission-resolver.ts` — `toResolvedIntent` is the **only** function that converts `access-path` → `path-values`, calling `path.matchValues()` exactly once (the Tell-Don't-Ask unwrap site).
- `src/permission-manager.ts` — `check(intent: ResolvedAccessIntent)` evaluates `(surface, string[])` against the ruleset and has **zero** imports from `access-intent/access-path` (line 250 is a JSDoc mention, not an import).
- `eslint.config.js` — already carries a `pi-permission-system/src`-scoped `no-restricted-syntax` rule (forbidding interior `process.platform`, [#510]); the new guard follows that pattern as a per-file `no-restricted-imports` override.
- `docs/decisions/0001-project-trust-adoption.md` — the sole existing ADR; supplies the frontmatter (`status`, `date`) and section format (`## Status`, `## Context`, `## Decision`, `## Alternatives considered`).

Constraints from AGENTS.md / SKILL.md that apply:

- The architecture roadmap marker (`✅` on heading + Mermaid node + stale metric rows) lands in the implementation commit, not a deferred ship commit ([#479], [#480]).
- A `docs:` commit is a `hidden: true` changelog type that auto-batches; the Release Recommendation must not claim it cuts a release on its own.
- `docs/architecture/architecture.md` uses reference-style issue links; `[#506]` already has a definition — do not re-add it.

## Design Overview

This is a documentation-and-guard change; the only code touched is doc comments plus one ESLint rule.
The decision model is captured in the tour (`docs/0506-path-values-boundary-tour.md`) and distilled into the ADR.

### The boundary, stated as a contract

The invariant being formalized, in three parts:

1. The resolver is the **sole** `matchValues()` unwrap site (`toResolvedIntent`), so the lexical ∪ canonical alias set ([#418]) is derived once, centrally.
2. The manager is **string-based**: `check()` consumes `ResolvedAccessIntent` (`tool | path-values`) and never imports `AccessPath`.
3. Path-awareness flows downward and **stops at the resolver** — the manager is a leaf with no `access-intent/access-path` dependency.

### Why formalize (not collapse)

- **Single responsibility.**
  The manager evaluates `(surface, string[])` against a ruleset — a complete, testable contract with no path semantics.
  Collapsing grows the engine a second concern (path representation) it currently delegates away.
- **Tell-Don't-Ask wash.**
  Collapse does not remove the `matchValues()` ask; it relocates the single unwrap one layer deeper, into the busier string-matching engine.
- **Dependency direction.**
  Collapse widens the manager (a leaf) with an `AccessPath` import to save one nominal type (`PathValuesAccessIntent`) and one converter — removing a real seam for a nominal gain.

The design introduces no new collaborator and no new call site; it preserves the existing narrow `ResolvedAccessIntent` interface (ISP — the manager reads `surface` + `values`, nothing path-shaped).

### ESLint guard shape

A new flat-config object scoped to the single manager file, parallel to the `process.platform` guard:

```javascript
{
  files: ["packages/pi-permission-system/src/permission-manager.ts"],
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: ["**/access-intent/access-path", "#src/access-intent/access-path"],
            message:
              "permission-manager stays string-based: it consumes ResolvedAccessIntent (path-values) and must not import AccessPath. See docs/decisions/0002.",
          },
        ],
      },
    ],
  },
}
```

The manager currently has no such import, so the rule passes immediately on introduction; it fails only if a future change reintroduces the dependency (i.e. a collapse without an explicit exception).

### ADR shape

`docs/decisions/0002-path-values-string-boundary.md`, frontmatter `status: accepted` + `date`, then:

- **Status** — Accepted.
- **Context** — the three actors, the post-Steps-1–2 sole-producer state, the type split (`AccessIntent` vs `ResolvedAccessIntent`), distilled from the tour.
- **Decision** — formalize: keep `path-values`, name the string-boundary invariant, add the lint guard.
- **Consequences** — non-breaking; the manager stays a string leaf; the lint guard pins the invariant.
- **Alternatives considered** — collapse (moving `matchValues()` into the manager): rejected, with the SRP / TDA-wash / dependency-direction rationale.

## Module-Level Changes

- `docs/decisions/0002-path-values-string-boundary.md` — **new** ADR (per the shape above).
- `src/access-intent/access-intent.ts` — tighten the `PathValuesAccessIntent` and `ResolvedAccessIntent` JSDoc to name the boundary invariant and reference ADR-0002; no type or runtime change.
- `src/permission-resolver.ts` — tighten the `toResolvedIntent` / `resolve` JSDoc to name "sole `matchValues()` unwrap site" as a contract and reference ADR-0002.
- `src/permission-manager.ts` — tighten the `check()` JSDoc (around line 245–252) to state the manager stays string-based by design and reference ADR-0002; no logic change.
- `eslint.config.js` — add the `no-restricted-imports` guard object scoped to `permission-manager.ts`.
- `docs/architecture/architecture.md` — mark Phase 7 Step 5 complete: `✅` on the "5.
  Decide and formalize the `path-values` boundary" heading and the `S5` Mermaid node label; update the metric row "Emitted/internal path-value forms" target to reflect the resolved/documented outcome; update the residual `path-values` bullet ("survives as the manager's deliberate string boundary") to point to ADR-0002.
- `.pi/skills/package-pi-permission-system/SKILL.md` — light touch on line 154: append that the resolver-internal `path-values` boundary is now formalized as a deliberate seam (ADR-0002); the existing description is already accurate, so this is a one-clause pointer, not a rewrite.
- `docs/0506-path-values-boundary-tour.md` — **delete** (the scratch tour is superseded by the ADR).

No `src/` export is removed or renamed; no README command/feature changes; no schema/config/example changes.
The `path-values` symbol survives unchanged, so the architecture's `rule.ts` inline-type listing is unaffected.

## Test Impact Analysis

This change adds no test cycles.

1. **New tests enabled:** none — formalizing a boundary via docs + a lint rule introduces no new unit-testable behavior.
   The ESLint guard is verified by `pnpm run lint`, not a vitest case.
2. **Tests made redundant:** none.
3. **Tests that must stay as-is:** the existing resolver and manager tests (`test/permission-resolver.test.ts`, `test/permission-manager.test.ts`, composition-root wiring) genuinely exercise the unwrap and the string-based evaluation; JSDoc changes do not touch them, and they remain the behavioral pins for the boundary.

## Invariants at risk

This change touches surfaces that prior Phase 6/7 steps refactored; it must not regress their documented outcomes.

- **#478 — "the resolver exposes a single `resolve(intent)` entry point" / one unwrap site.**
  Pinned by the type system (only `toResolvedIntent` converts) and `test/permission-resolver.test.ts`.
  Unchanged here (docs only).
- **#486 / #502 / #503 — "every path gate emits `access-path`; the resolver unwraps via `matchValues()` to lexical ∪ canonical."**
  Pinned by the resolver/manager/gate tests.
  Unchanged here.
- **New invariant pinned by this change — "the manager never imports `AccessPath`."**
  Previously enforced by convention only; now pinned deterministically by the `no-restricted-imports` lint guard (verified in CI via `pnpm run lint`).

No green-suite regression of an earlier step's outcome is possible: the runtime is untouched and the new guard only tightens.

## Build Order

This is a docs/config plan (no red→green test cycles); `/build-plan` executes it.
Suggested step order and commit shape:

1. Write the ADR `docs/decisions/0002-path-values-string-boundary.md` and delete the scratch tour file.
   Verify: ADR renders, links resolve, `pnpm run lint` clean on markdown.
   Commit: `docs(pi-permission-system): record path-values string-boundary decision (ADR-0002) (#506)`.
2. Tighten the JSDoc in `access-intent.ts`, `permission-resolver.ts`, `permission-manager.ts`, and add the `eslint.config.js` `no-restricted-imports` guard.
   Verify: `pnpm run check` and `pnpm run lint` clean (the guard passes — the manager has no `access-path` import).
   Commit: `docs(pi-permission-system): name the path-values boundary contract and guard it (#506)`.
3. Mark Phase 7 Step 5 complete in `architecture.md` (heading + Mermaid node + metric row + residual bullet) and add the SKILL.md ADR pointer.
   Verify: `mmdc` parses the step diagram; `pnpm run lint` clean.
   Commit: `docs(pi-permission-system): mark Phase 7 Step 5 complete (#506)`.

Steps 1–3 may also be squashed into a single `docs:` commit if preferred — the work is small and cohesive.
Run `pnpm run check`, `pnpm run lint`, `pnpm -r run test`, and `pnpm fallow dead-code` before completion regardless.

## Risks and Mitigations

- **Risk: the lint guard pattern misses an import form (relative vs `#src/` alias).**
  Mitigation: the `group` array lists both the `#src/access-intent/access-path` alias and the `**/access-intent/access-path` relative/glob form; eslint enforces `#src/` aliases over relative paths package-wide, so the alias form is the realistic vector, but both are covered.
- **Risk: the architecture metric row or Mermaid node is left stale (the [#479]/[#480] split-marker trap).**
  Mitigation: the completion marks land in Step 3's commit alongside the work, not at ship; the pre-completion reviewer checks roadmap-marker freshness.
- **Risk: deleting the tour file loses the decision rationale.**
  Mitigation: the rationale is migrated verbatim into the ADR's Context / Alternatives sections before deletion.

## Open Questions

None.
The decision (formalize) and the documentation vehicle (ADR-0002 + tightened inline docs) were confirmed with the operator during planning.
No follow-up issues are warranted — this completes Phase 7 Step 5 and, with Steps 1–4 already shipped, closes Phase 7.

[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#479]: https://github.com/gotgenes/pi-packages/issues/479
[#480]: https://github.com/gotgenes/pi-packages/issues/480
[#487]: https://github.com/gotgenes/pi-packages/issues/487
[#502]: https://github.com/gotgenes/pi-packages/issues/502
[#503]: https://github.com/gotgenes/pi-packages/issues/503
[#510]: https://github.com/gotgenes/pi-packages/issues/510
