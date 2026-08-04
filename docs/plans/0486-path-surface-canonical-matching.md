---
issue: 486
issue_title: "pi-permission-system: should the path surface match the canonical (symlink-resolved) form like external_directory?"
---

# Make the `path` surface match the canonical (symlink-resolved) form

## Release Recommendation

**Release:** ship independently

Issue #486 is a follow-on filed and deferred during Phase 6 ([#478]); it is not a member of any active roadmap batch, and Phase 6 is closed.
It is a self-contained behavior change to one surface, so it ships on its own — and because it is breaking (see Goals), it warrants its own major-bump release rather than batching.

## Problem Statement

The `path` and `external_directory` surfaces match against different value sets today:

- `path` matches the **lexical** aliases only — the as-typed form and its cwd/effective-base absolute resolution (`getPathPolicyValues`).
- `external_directory` matches the lexical aliases **plus the canonical (symlink-resolved) form** (`AccessPath.matchValues()`), the [#418] fix: a rule keyed on `/tmp/*` matches even when the access resolves to `/private/tmp`.

This asymmetry means a `path` deny on a sensitive spelling (`*.env`, `~/.ssh/*`) can be evaded through a symlink alias, whereas the same rule on `external_directory` cannot.
The operator has decided (issue thread) that `path` **should** also match the canonical form, so a `path` deny on `/etc/passwd` catches a symlink to it.
After this change the two surfaces match the identical value set and the asymmetry dissolves.

## Goals

- Make the `path` surface match the lexical aliases **plus** the canonical (symlink-resolved) form — the same set `AccessPath.matchValues()` already computes — across **both** producers (the tool path gate and the bash-path gate), so no new tool-vs-bash asymmetry is introduced.
- Route both `path` producers through `AccessPath` (the "full" scope the operator chose), pulling the bash-path `AccessPath` migration forward from [#487].
- Collapse the now-unproduced emitted `path-values` `AccessIntent` variant, completing one item the [#487] direction listed.
- Preserve the [#393] unknown-base behavior (a relative bash token after a non-literal `cd` keeps its literal value only — no canonical, no spurious absolute) and the [#418] / [#382] external-directory invariants.

This is a **breaking change**: adding the canonical alias to the `path` match set alters which rules fire on upgrade with no user edit.
A symlink whose resolved target matches a `path` deny (or allow) pattern now matches it where it previously did not.
The suggested commit for the behavior step is `feat(pi-permission-system)!:` with a `BREAKING CHANGE:` footer.

## Non-Goals

- No migration of config-pattern or prompt-input path handling onto `AccessPath` — those remain the residual [#487] scope after this change.
- No change to what `external_directory` matches (it already matches lexical ∪ canonical); this change only brings `path` to parity.
- No change to dedup/approval-key identity: keys continue to derive from the **lexical** form (`AccessPath.value()`), so existing session approvals stay stable.
- No principal identity on `AccessIntent`; cross-session path portability stays deferred.

## Background

Relevant modules (all in `packages/pi-permission-system/`):

- `src/access-intent/access-path.ts` — `AccessPath` value object.
  `matchValues()` returns lexical aliases ∪ canonical; `boundaryValue()` the canonical form; `value()` the lexical absolute form.
  Built today via the private constructor through `forExternalDirectory(pathValue, cwd)`.
- `src/access-intent/access-intent.ts` — the `AccessIntent` emitted union (`tool` | `path-values` | `access-path`) and the `ResolvedAccessIntent` manager-consumed union (`tool` | `path-values`).
- `src/permission-resolver.ts` — `toResolvedIntent` unwraps an `access-path` intent to `path-values` via `matchValues()` before handing it to the manager; the manager stays string-based.
- `src/permission-manager.ts` — `check(intent)`: the `path-values` branch evaluates `intent.values` directly against `intent.surface`; the `tool` branch normalizes raw input via `normalizeInput` → `normalizePathSurfaceValues` → `getPathPolicyValues` (lexical only).
- `src/handlers/gates/path.ts` — tool path gate.
  Emits `{ kind: "tool", surface: "path", input: { path } }`; the manager normalizes it lexically.
- `src/handlers/gates/bash-path.ts` — bash path gate.
  Emits `{ kind: "path-values", surface: "path", values }`, the values coming from `BashProgram.pathRuleCandidates()`.
- `src/access-intent/bash/cwd-projection.ts` — `projectRuleCandidates` builds `BashPathRuleCandidate[]` (`{ token, policyValues }`); `getPolicyValuesForRuleCandidate` returns lexical values, and for an unknown base + relative candidate returns the literal only ([#393]).
- `src/handlers/gates/external-directory.ts`, `src/access-intent/bash/cwd-projection.ts` (`projectExternalPaths`) — the existing `forExternalDirectory` callers (the external-directory surface).

Key constraint (AGENTS.md / SKILL): the manager stays string-based and never imports `AccessPath`; the resolver does the `matchValues()` unwrap.
This change preserves that — both `path` producers emit `access-path`, the resolver unwraps, the manager is untouched.

The reason the asymmetry exists is documented in `docs/architecture/architecture.md` (the access-path narrative) and in the [#478] retro: forcing bash-path through `AccessPath` would inject a canonical alias the `path` surface did not match — a behavior change deferred to this issue.
That behavior change is now wanted.

## Design Overview

### The match set is already single-sourced

`AccessPath.matchValues()` returns exactly `lexical aliases ∪ canonical` — the set the `path` surface should now match.
The resolver already unwraps an `access-path` intent through `matchValues()`.
So the change is: make both `path` producers emit `access-path` instead of their lexical-only forms.
No manager change is needed.

### Factory: generalize `forExternalDirectory` to a surface-neutral `forPath`, add `forLiteral`

`forExternalDirectory(pathValue, cwd)` is no longer external-directory-specific.
Generalize and rename it to a surface-neutral factory that also supports a cd-resolved base for bash candidates:

```typescript
// access-path.ts
static forPath(
  pathValue: string,
  options: { cwd: string; resolveBase?: string },
): AccessPath {
  const { cwd, resolveBase = cwd } = options;
  return new AccessPath(
    normalizePathForComparison(pathValue, resolveBase),
    getPathPolicyValues(pathValue, { cwd, resolveBase }),
    canonicalNormalizePathForComparison(pathValue, resolveBase),
  );
}

// literal-only: the #393 unknown-base case — no absolute, no canonical
static forLiteral(literal: string): AccessPath {
  return new AccessPath(literal, literal ? [literal] : [], "");
}
```

`forPath(p, { cwd })` (resolveBase defaults to cwd) is behavior-identical to the old `forExternalDirectory(p, cwd)`: `getPathPolicyValues(p, { cwd, resolveBase: cwd })` equals `getPathPolicyValues(p, { cwd })` because `resolveBase` already defaults to `cwd` inside `getAbsolutePathPolicyValues`.
So renaming the external-directory callers preserves their behavior.

`forLiteral` produces `matchValues() === [literal]`, `boundaryValue() === ""`, `value() === literal` — exactly the conservative unknown-base shape (`matchValues()` already collapses to the aliases when `canonical` is `""`).

### Tool path gate (`path.ts`)

Build an `AccessPath` and emit an `access-path` intent on the `path` surface; derive the approval pattern from `accessPath.value()` (the lexical absolute, identical to today's `normalizePathForComparison(filePath, tcc.cwd)`):

```typescript
const accessPath = AccessPath.forPath(filePath, { cwd: tcc.cwd });
const check = resolver.resolve({
  kind: "access-path",
  surface: "path",
  path: accessPath,
  agentName: tcc.agentName ?? undefined,
});
if (check.state === "allow") return null;
if (check.matchedPattern === undefined) return null; // #58 backward-compat guard, unchanged
const pattern = deriveApprovalPattern(accessPath.value());
```

The [#58] guard (skip when only the universal default fired) is preserved — the resolved check still carries `matchedPattern`.
Prompt/log/decision/denialContext keep using the raw `filePath`.

### Bash path candidates (`cwd-projection.ts` → `bash-path.ts`)

`BashPathRuleCandidate` carries an `AccessPath` instead of precomputed lexical `policyValues`, keeping the raw `token` for prompts/logs/approvals:

```typescript
export interface BashPathRuleCandidate {
  readonly token: string;
  readonly path: AccessPath;
}
```

`projectRuleCandidates` builds each candidate's `AccessPath`, preserving the [#393] unknown-base branch via `forLiteral`:

```typescript
const path =
  base.kind === "unknown" && isRelativeCandidate(candidate)
    ? AccessPath.forLiteral(normalizePathPolicyLiteral(candidate))
    : AccessPath.forPath(candidate, {
        cwd,
        resolveBase: base.kind === "known" ? resolve(cwd, base.offset) : cwd,
      });
if (path.matchValues().length === 0) continue;
const key = path.matchValues().join("\0"); // dedup identity preserved
```

`getPolicyValuesForRuleCandidate` is dissolved into `projectRuleCandidates` (its sole caller) — its lexical/literal branching moves into the `AccessPath` construction above.

`bash-path.ts` emits `access-path` per candidate and derives the approval base from `path.value()`:

```typescript
for (const { token, path } of candidates) {
  const check = resolver.resolve({
    kind: "access-path",
    surface: "path",
    path,
    agentName: tcc.agentName ?? undefined,
  });
  // ...existing #58 guard, deny short-circuit, ask accumulation unchanged...
}
// approval base:
const approvalBase = worstEntry.path.value();
```

This honors Tell-Don't-Ask (the resolver asks the `AccessPath` for `matchValues()`) and keeps the manager string-based — identical to how the external-directory gates already work.

### Collapse the emitted `path-values` variant

After both producers emit `access-path`, no gate emits `path-values`.
Remove `PathValuesAccessIntent` from the emitted `AccessIntent` union while keeping it in `ResolvedAccessIntent` (the resolver still produces it internally via `toResolvedIntent`, and the manager still consumes it):

```typescript
export type AccessIntent = ToolAccessIntent | AccessPathAccessIntent;
export type ResolvedAccessIntent = ToolAccessIntent | PathValuesAccessIntent;
```

`toResolvedIntent` now maps `access-path → path-values` and `tool → tool`; its prior `path-values` passthrough case is gone.

### Edge cases

- **Not a symlink:** `matchValues()` already collapses to the lexical aliases when canonical equals one of them — no spurious extra value.
- **Unresolvable path (empty / ELOOP / EACCES):** `canonicalNormalizePathForComparison` falls back to the lexical form; `forLiteral` yields `boundaryValue() === ""`.
  No new match introduced beyond today's lexical behavior.
- **`#58` no-`path`-key configs:** unchanged — the `matchedPattern === undefined` guard still short-circuits.
- **Dedup / session approvals:** keys derive from `value()` (lexical), unchanged.

## Module-Level Changes

- `src/access-intent/access-path.ts` — rename/generalize `forExternalDirectory(pathValue, cwd)` → `forPath(pathValue, { cwd, resolveBase? })`; add `forLiteral(literal)`.
  Update the class doc comment (it names `forExternalDirectory`).
- `src/access-intent/access-intent.ts` — remove `PathValuesAccessIntent` from the emitted `AccessIntent` union (keep the interface and its place in `ResolvedAccessIntent`); update doc comments that describe `path-values` as an emitted variant.
- `src/permission-resolver.ts` — `toResolvedIntent` drops the `path-values` passthrough branch (now `tool | access-path` input only).
- `src/handlers/gates/path.ts` — build `AccessPath.forPath`, emit `access-path` on `path`, derive pattern from `accessPath.value()`.
- `src/handlers/gates/bash-path.ts` — consume `{ token, path }` candidates, emit `access-path` per candidate, derive `approvalBase` from `path.value()`.
- `src/access-intent/bash/cwd-projection.ts` — `BashPathRuleCandidate` becomes `{ token, path: AccessPath }`; `projectRuleCandidates` builds `AccessPath` (via `forPath` / `forLiteral`); inline and remove `getPolicyValuesForRuleCandidate`.
  Rename the existing `projectExternalPaths` `forExternalDirectory` call sites (2) to `forPath`.
- `src/access-intent/bash/program.ts` — re-exports `BashPathRuleCandidate` (shape change flows through; verify no other change needed).
- `src/handlers/gates/external-directory.ts` — rename the `forExternalDirectory` call to `forPath`.

Documentation (grep-verified — symbol/behavior is named in prose):

- `docs/configuration.md` — `path` Surface section: update "matches as the agent references it" framing to state it now also matches the symlink-resolved form; add a `path`-surface symlink note (or generalize the existing `external_directory` "Symlinked paths" note at line ~465 to cover both surfaces).
- `docs/architecture/architecture.md` — update: the `access-path.ts` module entry (factory name/desc, line ~670), the `bash-path.ts` entry (line ~696, now emits `access-path`), the `cwd-projection.ts` entry (`pathRuleCandidates()` returns `AccessPath`-backed candidates), the `access-intent.ts` entry (emitted union no longer carries `path-values`), and the Phase 6 follow-on note (line ~760: #486 implemented, #487 narrowed to config-pattern/prompt-input migration).
  Verify the inline `Rule`/`Ruleset` type listings are untouched (they are — no rule-type field changes here).
- `.pi/skills/package-pi-permission-system/SKILL.md` — update the gate-fixtures/intent notes (lines ~150–152): the bash path gate now emits `access-path` on `path` (not `path-values`); the `makeHandler` adapter and `makePathDispatchResolver` descriptions; and any "`path` matches lexical only" framing.
- `README.md` — add that a `path` deny now also resists symlink-alias evasion (lines ~20 / ~71 describe `path` denies for sensitive files).

## Test Impact Analysis

1. **New tests the change enables:**
   - `AccessPath.forPath` with an explicit `resolveBase` (cd-folded base) and `AccessPath.forLiteral` (literal-only, empty boundary) — unit-testable directly.
   - The `path` tool gate denying a symlink whose canonical target matches a `path` deny pattern.
   - The bash-path gate matching a `path` rule against a symlinked token's canonical form.
2. **Tests that become redundant:** none removed; existing lexical-match assertions stay valid (lexical aliases are still in `matchValues()`).
3. **Tests that must stay as-is:** the [#393] unknown-base test in `test/access-intent/bash/program.test.ts` (non-literal `cd` → literal only) — it now pins `forLiteral` behavior and must keep asserting no canonical/absolute leakage.

Existing tests to migrate (interface/shape changes, same package, type-level breaks):

- `test/access-intent/access-path.test.ts` — `forExternalDirectory` → `forPath`; add `forLiteral` cases.
- `test/permission-resolver.test.ts`, `test/handlers/gates/external-directory-policy.test.ts` — `forExternalDirectory` → `forPath`.
- `test/access-intent/bash/program.test.ts` — `pathRuleCandidates()` shape (`policyValues` → `path: AccessPath`); assert via `path.matchValues()` / `path.value()`.
- `test/handlers/gates/bash-path*` and any `path.ts` gate tests — assert the emitted `access-path` intent and `path.value()`-derived approval base.

## Invariants at risk

This change touches surfaces Phase 6 refactored.
Documented invariants and their pinning tests:

- **[#418] external-directory matches lexical ∪ canonical** — preserved by the `forPath` rename (behavior-identical when `resolveBase` defaults to `cwd`).
  Pinned by `test/handlers/gates/external-directory-policy.test.ts` and `test/access-intent/access-path.test.ts`.
- **[#393] unknown-base bash token keeps literal only** — preserved by routing that case through `forLiteral`.
  Pinned by the non-literal-`cd` case in `test/access-intent/bash/program.test.ts` (extend it to assert `matchValues()` carries no canonical/absolute).
- **[#382] canonical is win32-lowercased** — `forPath` uses `canonicalNormalizePathForComparison` (unchanged).
  Pinned by `access-path.test.ts`.
- **[#478] single `resolve(intent)` entry point** — unchanged; both producers still emit one intent through `resolve`.

## TDD Order

1. **`feat(pi-permission-system): add AccessPath.forPath and forLiteral factories`** Test surface: `test/access-intent/access-path.test.ts`.
   Add `forPath(pathValue, { cwd, resolveBase })` (generalized rename of `forExternalDirectory`) and `forLiteral(literal)`; migrate the existing `forExternalDirectory` tests to `forPath` and update the three production call sites in the same commit (`external-directory.ts`, `cwd-projection.ts` ×2) — removing an export breaks all importers at the type level, so fold them together.
   Cover `forLiteral` (matchValues `[literal]`, empty boundary) and `forPath` with an explicit `resolveBase`.
   Also update `test/permission-resolver.test.ts` and `test/handlers/gates/external-directory-policy.test.ts` (rename) in this commit.

2. **`feat(pi-permission-system)!: match the canonical form on the path tool gate`** Test surface: the `path.ts` gate tests.
   Migrate `path.ts` to build `AccessPath.forPath` and emit `access-path` on `path`; derive the approval pattern from `value()`.
   Red: a tool reading a symlink whose canonical target matches a `path` deny is now denied.
   Breaking — `feat!:` with `BREAKING CHANGE:` footer.

3. **`feat(pi-permission-system)!: match the canonical form on the bash-path gate`** Test surface: `test/access-intent/bash/program.test.ts` + bash-path gate tests.
   Change `BashPathRuleCandidate` to `{ token, path: AccessPath }`, rebuild candidates in `projectRuleCandidates` (inline/remove `getPolicyValuesForRuleCandidate`, preserve the `forLiteral` unknown-base branch), and migrate `bash-path.ts` to emit `access-path` and derive the approval base from `path.value()`.
   The `projectRuleCandidates` return-type change and its `bash-path.ts` consumer + tests break together — one commit.
   Red: a bash token symlinked to a `path`-denied target is denied; the [#393] unknown-base case still yields literal-only matches.
   Breaking — `feat!:`.

4. **`refactor(pi-permission-system): drop the unproduced path-values emitted variant`** Test surface: type-level + fixtures.
   Remove `PathValuesAccessIntent` from the emitted `AccessIntent` union (keep in `ResolvedAccessIntent`); simplify `toResolvedIntent`; update `gate-fixtures.ts` (`makePathDispatchResolver`, `makeHandler` adapter) to the `tool | access-path` emitted surface.
   `tsc` confirms no remaining emitter.

5. **`docs(pi-permission-system): document canonical path-surface matching`** Update `docs/configuration.md`, `docs/architecture/architecture.md`, `.pi/skills/package-pi-permission-system/SKILL.md`, and `README.md` per Module-Level Changes.
   No release impact on its own (rides the breaking feat).

## Risks and Mitigations

- **Risk: the rename silently changes external-directory behavior.**
  Mitigation: `forPath(p, { cwd })` is behavior-identical (proved above); the external-directory-policy and access-path tests pin it and run unchanged-in-intent.
- **Risk: the [#393] unknown-base case regresses to over-matching (spurious canonical/absolute).**
  Mitigation: route it through `forLiteral`; extend the existing program test to assert `matchValues()` carries only the literal.
- **Risk: dedup or session-approval keys shift, invalidating in-flight approvals.**
  Mitigation: keys derive from `value()` (lexical), which is unchanged; covered by existing approval/dedup tests.
- **Risk: an existing user config's `path` rule starts matching a previously-unmatched symlinked path on upgrade.**
  This is the intended breaking behavior; mitigation is the `BREAKING CHANGE:` note and the docs update describing the new symlink-resistant matching.

## Open Questions

- None blocking.
  The residual [#487] scope (config-pattern and prompt-input `AccessPath` migration) is unaffected; this plan narrows it by completing the bash-path migration and the `path-values` collapse it listed.
  No new follow-up issue is filed (no new work is deferred — work is pulled forward).

[#58]: https://github.com/gotgenes/pi-packages/issues/58
[#382]: https://github.com/gotgenes/pi-packages/issues/382
[#393]: https://github.com/gotgenes/pi-packages/issues/393
[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#478]: https://github.com/gotgenes/pi-packages/issues/478
[#487]: https://github.com/gotgenes/pi-packages/issues/487
