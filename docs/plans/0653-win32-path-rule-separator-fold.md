---
issue: 653
issue_title: 'Windows: path rule "/dev/null": "allow" never matches due to wildcard separator normalization asymmetry'
---

# Symmetric win32 separator fold in path-rule matching

## Release Recommendation

**Release:** ship independently

This issue is not part of any numbered roadmap step in `docs/architecture/architecture.md`, so no release batch applies.
It is a user-reported Windows bug with a self-contained fix; a `fix:` commit cuts a release on the next release-please merge.

## Problem Statement

On a win32 host the path-surface wildcard matcher folds separators in **one direction only**.
`compileWildcardPattern` rewrites `/` to `\` in the rule pattern, but `wildcardMatch` tests the value exactly as it arrives.
Every match value that still carries forward slashes is therefore unmatchable by any rule.

The reporter's case is the Git Bash device token: under `path: { "*": "ask", "/dev/null": "allow" }` on Windows, `echo hi > /dev/null` still prompts, because the rule compiles to `^\dev\null$` while the value stays `/dev/null`.
Reproduced during planning against the real pipeline:

```text
BashProgram.parse("echo hi > /dev/null", win32 normalizer)
  pathRuleCandidates: [{ token: "/dev/null", matchValues: ["/dev/null"] }]
  manager.check(path, values) with ["*": ask, "/dev/null": allow]
    → { state: "ask", matchedPattern: "*" }
```

The device token is not the only casualty — it is the shape with no workaround.
`AccessPath` match values on win32 mix separator conventions: the absolute and cwd-relative aliases come out of `win32.resolve` / `win32.relative` with backslashes, while the as-typed literal alias, `forDevice`, and `forLiteral` keep forward slashes.
[#533] already hit this once and worked around it by hand-attaching a backslash **match alias** to the non-mount POSIX absolute literal (`/tmp/foo` also matches as `\tmp\foo`), which is the same bug patched at one call site instead of at the fold.

## Goals

- Make the win32 `windowsSeparators` fold symmetric: the same separator normalization applies to the rule pattern and to the matched value.
- Make `path: { "/dev/null": "allow" }` (and any other forward-slash path rule) match on Windows, on both the config and session-approval layers.
- Make the fold structurally impossible to half-apply, so this class of bug cannot return through a new call site.
- Remove the [#533] backslash match alias, now redundant.
- Correct `docs/configuration.md`, which claims the safe device paths "never trigger the gate" when the exclusion only covers `external_directory`.

This is **not** a breaking change.
It affects win32 only, and it makes rules that were silently inert start matching as documented.
Deny rules gain reach in the same direction as allow rules, so the change is fail-safe, never a bypass.

## Non-Goals

- **Exempting safe system devices from the `path` surface.**
  `isSafeSystemPath` exempts `/dev/null` from `external_directory` only; the cross-cutting `path` gate resolves the token like any other, on POSIX as well.
  That behavior is correct — an explicit `path` rule remains the lever, and a user running `path: { "*": "deny" }` should keep full strictness.
  The documentation is what over-claims; this plan corrects the prose, not the gate.
- **`deriveApprovalPattern`'s ambient `node:path` read.**
  It reads `dirname`/`sep` from the host rather than the injected `PathFlavor`, so a session approval for `/dev/null` on a real Windows host yields the mixed pattern `/dev\*`.
  It matches once the fold is symmetric, so it is not a blocker.
  Filed as [#655] with a design sketch for the missing collaborator.
- **The `caseInsensitive` half of `WildcardMatchOptions`.**
  It is applied through the regex `i` flag and is already symmetric; it stays as-is.
- **Non-path surfaces.**
  `pathMatchOptions` (`src/rule.ts`) hands `flavor.matchOptions` only to `PATH_SURFACES`, so `bash`, tool-name, `mcp`, and `skill` matching keeps its exact, unfolded semantics.
- **MSYS mount mapping.**
  [ADR 0003]'s rejection of `cygpath` shell-outs and `/tmp` → `%TEMP%` mapping stands untouched; only the alias workaround it introduced goes away.

## Background

Relevant modules:

- `src/wildcard-matcher.ts` — `compileWildcardPattern` expands `~`, applies the `windowsSeparators` rewrite, escapes, and builds the regex; `wildcardMatch` compiles a pattern and calls `.regex.test(value)`.
  `CompiledWildcardPattern<TState>` exposes the raw `regex`, and `findCompiledWildcardMatch` calls `p.regex.test(name)` directly.
- `src/rule.ts` — `pathMatchOptions(surface, flavor)` returns `flavor.matchOptions` for `PATH_SURFACES` and `undefined` otherwise; `ruleMatches` is the sole path-rule match site.
- `src/path/path-flavor.ts` — `win32PathFlavor.matchOptions` is `{ caseInsensitive: true, windowsSeparators: true }`; the POSIX flavor's is `undefined`.
- `src/access-intent/access-path.ts` — `matchValues()` is the lexical alias union ∪ canonical; `forLiteral(literal, matchAliases?)` carries the [#533] alias; `forDevice(devicePath)` preserves an MSYS device verbatim across all three representations.
- `src/path-normalizer.ts` — `forBashToken` dispatches on `flavor.bashTokenShape(token)`: `device` → `AccessPath.forDevice`, `drive-mount` → translated `forPath`, `posix-absolute` → `forLiteral` **plus a hand-built backslash alias**, `plain` → `forPath`.

Constraints from `AGENTS.md` and the package skill that apply:

- `PathFlavor` owns the one win32-vs-POSIX decision; no `src/` module reads `process.platform` (ESLint-guarded).
  This change adds no platform read — it consumes the already-resolved `matchOptions`.
- Wildcard matching must be explicit and tested; silent over-matching is a permission bypass.
  The fold widens matching symmetrically for allow and deny, and only within the platform's own separator equivalence.
- `docs/architecture/architecture.md` module-tree entries describe current behavior and cite an issue only for an active constraint.

## Design Overview

### The fold is one relation, applied to two sides

`windowsSeparators` expresses a single fact: on Windows `/` and `\` are the same separator, so two strings differing only in separators name the same path.
An equivalence relation has to be applied to both operands.
Today it is applied to one, so the matcher answers "different" for two spellings of the same path.

The fix is to normalize both sides through one named helper:

```typescript
function foldSeparators(value: string, options?: WildcardMatchOptions): string {
  return options?.windowsSeparators ? value.replaceAll("/", "\\") : value;
}
```

`compileWildcardPattern` applies it to the expanded pattern (where the existing inline `replaceAll` lives); `wildcardMatch` applies it to the value before testing.

### The missing collaborator: the compiled pattern should own matching

Folding the value inside `wildcardMatch` fixes the live path, but it leaves the same trap set for the next caller.
`compileWildcardPattern` bakes half the fold into a regex and then hands out the raw `regex`, so any consumer that calls `.test(value)` re-opens the asymmetry — which is exactly what `findCompiledWildcardMatch` does today (harmlessly, since nothing compiles it with options yet).

So the compiled pattern takes over matching and the raw regex stops being part of the shape:

```typescript
export interface CompiledWildcardPattern<TState> {
  readonly pattern: string;
  readonly state: TState;
  /** Test a value, applying the same folding the pattern was compiled with. */
  matches(value: string): boolean;
}
```

Call sites become `p.matches(name)` and `compileWildcardPattern(pattern, null, options).matches(value)`.
Both halves of the fold now live on one object, and there is no API left that can apply one without the other.

This is a small surface: `regex` has two production readers (both in `wildcard-matcher.ts`) and four test readers.

### The [#533] alias becomes redundant

With the fold symmetric, a forward-slash literal is matchable as typed, so `forBashToken`'s `posix-absolute` branch reduces to the plain literal:

```typescript
case "posix-absolute": {
  // A non-mount POSIX absolute (`/tmp`, `/usr`) has an install-dependent
  // Windows target this package cannot know, so it is kept literal.
  return this.forLiteral(normalizePathPolicyLiteral(token));
}
```

`PathNormalizer.forLiteral` and `AccessPath.forLiteral` then drop their `matchAliases` parameter — no caller supplies one.
The `matchAliases` constructor field stays: `forPath` still builds `matchValues()` from the `getPathPolicyValues` union.

Verified during planning: with the fold in place and the alias removed, the full 2594-test suite passes except the two assertions that spell the alias out, and the [#533] end-to-end guarantee (`test/permission-manager-unified.test.ts`, "a /tmp* allow rule suppresses a Git Bash /tmp path") stays green on the matcher alone.

### Rejected alternative: normalize separators when building match values

The other place to close the gap is `AccessPath` — emit backslash-normalized aliases for every win32 match value at construction.
Rejected: it scatters the fold across the value-construction sites (`getPathPolicyValues`, `forDevice`, `forLiteral`) while the pattern half stays in the matcher, which is how [#533]'s alias came about in the first place.
It also misses `wildcardMatch`'s other consumer, `isPiInfrastructureRead`, which matches a configured directory glob against a boundary value rather than an `AccessPath` alias union.
Keeping both halves of the relation in the matcher is the single-home option.

## Module-Level Changes

Source:

1. `src/wildcard-matcher.ts` — add `foldSeparators`; call it from `compileWildcardPattern` (replacing the inline `replaceAll`) and from the new `matches` implementation.
   Replace `regex` on `CompiledWildcardPattern<TState>` with `matches(value: string): boolean`.
   Route `findCompiledWildcardMatch` and `wildcardMatch` through `matches`.
   Update the `WildcardMatchOptions.windowsSeparators` doc comment — it currently says the rewrite applies "in the expanded pattern".
2. `src/path-normalizer.ts` — `forBashToken`'s `posix-absolute` branch returns `this.forLiteral(literal)`; drop the `matchAliases` parameter from `forLiteral` and the alias rationale from the `forBashToken` doc comment.
3. `src/access-intent/access-path.ts` — drop the `matchAliases` parameter and its doc paragraph from `static forLiteral`; keep the private `matchAliases` field (still populated by `forPath`).

Tests:

1. `test/wildcard-matcher.test.ts` — add the symmetric-fold cases; migrate the four `.regex.test(...)` call sites (lines 189, 190, 214, 417) to `.matches(...)`.
2. `test/rule.test.ts` — add the win32 path-surface case (forward-slash rule vs forward-slash value) beside the existing "a forward-slash external_directory pattern matches a backslash value" test, plus a negative pinning that the `bash` surface stays unfolded.
3. `test/permission-manager-unified.test.ts` — add the end-to-end `/dev/null` repro; update the [#533] test's comment, which currently explains the pass by "the literal carries a backslash match alias".
4. `test/path-normalizer.test.ts` — "forBashToken keeps a non-mount POSIX absolute as a literal": `matchValues()` becomes `["/tmp/foo"]`; update the explanatory comment.
5. `test/access-intent/bash/program.test.ts` — "keeps a non-mount POSIX absolute as a literal rule candidate": same assertion change.

Docs:

1. `docs/decisions/0003-git-bash-posix-path-semantics.md` — rewrite the Consequences bullet that documents the backslash match alias: the matcher now folds both the rule pattern and the match value, so a forward-slash literal is matchable as typed and no alias is carried.
2. `docs/architecture/architecture.md` — the `wildcard-matcher.ts` module-tree entry gains the active constraint (the win32 fold applies to both pattern and value; matching goes through `CompiledWildcardPattern.matches()` so it cannot be half-applied).
   The `access-path.ts` entry drops the `forLiteral(literal, matchAliases?)` signature and its parenthetical about the win32 backslash alias.
3. `docs/configuration.md` — the Windows-matching paragraph states that the fold applies to the rule pattern **and** the matched value; the Git Bash device bullet scopes its "never trigger the gate" claim to `external_directory` and says the `path` surface still governs the device token, which a rule written as typed (`path: { "/dev/null": "allow" }`) now matches.
4. `.pi/skills/package-pi-permission-system/SKILL.md` — replace the "carries a backslash alias … when adding another literal-only path shape on win32, give it a backslash match alias" guidance with the symmetric-fold rule.

No roadmap step-mark (`✅`) applies — this issue is not a numbered phase step.
`README.md` was grepped for `/dev/null` and separator wording: no hits, no change.

## Test Impact Analysis

1. **Newly enabled tests.**
   Matcher-level symmetry is now assertable directly (`wildcardMatch("/dev/null", "/dev/null", { windowsSeparators: true })`), and the reported repro becomes a manager-level test that runs on POSIX CI via `win32PathFlavor` — the whole path from `BashProgram.parse` through `PermissionManager.check`, which no existing test covers for the device shape.
2. **Tests that become redundant.**
   None are removed.
   The two alias assertions (`path-normalizer.test.ts`, `program.test.ts`) are *updated*, not deleted — they still pin that a non-mount POSIX absolute stays literal-only with no canonical.
   The [#533] manager test is deliberately kept: after this change it pins the guarantee at the matcher rather than at the alias, which is the stronger statement.
3. **Tests that must stay as-is.**
   `test/path/path-flavor.test.ts` (`matchOptions` composition), `test/rule.test.ts`'s existing win32 case-fold and backslash-value cases, and `test/access-intent/bash/msys-bash-tokens.test.ts` (shape classification) all exercise layers this change does not touch.

## Invariants at risk

| Invariant                                                               | Source             | Pinned by                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| A natural `/tmp*` allow rule suppresses a Git Bash `/tmp` path on win32 | [#533], [ADR 0003] | `test/permission-manager-unified.test.ts` — "win32: a /tmp* allow rule suppresses a Git Bash /tmp path"                    |
| A non-mount POSIX absolute is never fabricated into `C:\tmp\foo`        | [#533]             | `test/path-normalizer.test.ts` (`value()` / `boundaryValue()`), `test/access-intent/bash/program.test.ts`                  |
| Win32 path matching folds case                                          | [#382]             | `test/rule.test.ts`, `test/permission-manager-unified.test.ts`                                                             |
| The `bash` surface stays case- and separator-sensitive                  | [#382]             | `test/rule.test.ts` — "win32: bash surface stays case-sensitive (not a path surface)"; extended here with a separator case |
| Safe devices never reach `external_directory`                           | [#533]             | `test/bash-external-directory.test.ts`, `test/path/path-containment.test.ts`                                               |

The first is the one at genuine risk, since step 3 removes the mechanism its comment credits.
Planning verified it stays green on the matcher fold alone; the step's verify criterion names it explicitly.

No quantitative invariant (token budget, byte-identical prefix, latency) is involved.

## TDD Order

1. **Symmetric separator fold.**
   Test surface: `test/wildcard-matcher.test.ts`, `test/rule.test.ts`, `test/permission-manager-unified.test.ts`.
   Red — a forward-slash pattern matches a forward-slash value under `windowsSeparators` (`/dev/null`, `/dev/*`, `src/*` against `src/foo.ts`); the fold stays off by default; a win32 `path` rule `/dev/null` matches the value `/dev/null` while a `bash` rule does not fold; end to end, a win32 manager with `["*": ask, "/dev/null": allow]` answers `allow` for the match values `BashProgram.parse("echo hi > /dev/null", winNormalizer)` produces, and `ask` without the rule.
   Green — extract `foldSeparators` and apply it to the value in `wildcardMatch` as well as the expanded pattern.
   Verify: full suite green (confirmed during planning — 2594 tests, no regressions).
   Commit: `fix(pi-permission-system): fold separators on both sides of a win32 path match (#653)`
2. **Matching moves onto the compiled pattern.**
   Test surface: `test/wildcard-matcher.test.ts`.
   Red — compile with `{ windowsSeparators: true }` and assert `compiled.matches("/dev/null")`; the method does not exist.
   Green — replace `regex` with `matches(value)` on `CompiledWildcardPattern`, route `findCompiledWildcardMatch` and `wildcardMatch` through it, and migrate the four `.regex.test(...)` test call sites in the same commit (the type change breaks them immediately).
   Verify: `pnpm run check` — the removed `regex` field must have no surviving reader.
   Commit: `refactor(pi-permission-system): let the compiled wildcard pattern own matching (#653)`
3. **Drop the redundant backslash match alias.**
   Test surface: `test/path-normalizer.test.ts`, `test/access-intent/bash/program.test.ts`.
   Red — change both `matchValues()` assertions to `["/tmp/foo"]`; they fail while the alias is still attached.
   Green — `forBashToken`'s `posix-absolute` branch returns `this.forLiteral(literal)`; drop the `matchAliases` parameter from `PathNormalizer.forLiteral` and `AccessPath.forLiteral` in the same commit (a single call site, so the type checker will not accept them split).
   Verify: the [#533] manager test stays green (confirmed during planning).
   Commit: `refactor(pi-permission-system): drop the win32 literal backslash match alias (#653)`
4. **Documentation.**
   No test surface.
   Update [ADR 0003]'s Consequences bullet, the two `architecture.md` module-tree entries, the two `configuration.md` passages, and the package skill's alias guidance.
   Verify: `pnpm exec rumdl check` on the edited files, plus a grep for `match alias` / `backslash alias` across `docs/` and `.pi/skills/` to confirm no stale claim survives.
   Commit: `docs(pi-permission-system): record the symmetric win32 separator fold (#653)`

## Risks and Mitigations

- **Broader matching could surprise a Windows user.**
  A forward-slash rule that was silently inert starts matching.
  For `allow` that is the reported fix; for `deny` and `ask` it is strictly more restrictive, so the failure mode is a prompt, never a bypass.
  Mitigation: the behavior change is win32-only, stated in the `fix:` commit body, and both directions are covered by tests.
- **Removing the [#533] alias regresses its guarantee.**
  Mitigation: step 3 lands only after step 1, its verify criterion names the [#533] manager test, and the combination was spiked during planning (both changes applied, full suite run: only the two alias assertions failed).
- **Replacing `regex` with `matches` touches a semi-public shape.**
  `CompiledWildcardPattern` is not re-exported from the package entry point and has no cross-extension consumer; its only production readers are inside `wildcard-matcher.ts`.
  Mitigation: `pnpm run check` in step 2, and the migration of all four test readers in the same commit.
- **The doc correction could read as a behavior regression.**
  `configuration.md` currently promises that `echo hi > /dev/null` does not prompt.
  Mitigation: the corrected prose names the lever explicitly — the device is exempt from `external_directory`, and a `path` rule written as typed governs it — so a reader hitting a prompt finds the fix in the same paragraph.

## Open Questions

- Should safe system devices be exempt from the `path` surface as well as `external_directory`?
  Decided out of scope for this issue (documentation corrected instead); revisit only if a user reports that an explicit `path` rule is an unreasonable requirement for `/dev/null`.
- `_compileWildcardPatterns`, `compileWildcardPatternEntries`, and `findCompiledWildcardMatchForNames` have no production callers today — only tests.
  Not addressed here; `pnpm fallow dead-code` reports the package clean, so any pruning needs its own justification.
- [#655] carries the `deriveApprovalPattern` design question (ambient `node:path` read, and whether the derivation belongs on `PathNormalizer`, `AccessPath`, or `SessionApproval`).

[#382]: https://github.com/gotgenes/pi-packages/issues/382
[#533]: https://github.com/gotgenes/pi-packages/issues/533
[#655]: https://github.com/gotgenes/pi-packages/issues/655
[ADR 0003]: ../decisions/0003-git-bash-posix-path-semantics.md
