---
issue: 509
issue_title: "Bash bare-filename arguments bypass the path permission surface"
---

# Bash bare-filename arguments — rule-driven promotion into the path surface

## Release Recommendation

**Release:** ship independently

This issue is a standalone bug fix.
It is not a member of any architecture-roadmap release batch (the roadmap's remaining batch is `"symlink-resistant-path-matching"`, which #509 is not part of), so it ships on its own once landed.

## Problem Statement

A `path` permission rule (e.g. `"id_rsa": "deny"`, `"*.pem": "deny"`) gates a file when it is read through the `read` tool or through a bash command that uses a prefixed path (`cat ./id_rsa`, `cat ~/.ssh/id_rsa`), but not when the same file is referenced by a bare filename (`cat id_rsa`).
The broad bash classifier `classifyTokenAsRuleCandidate` accepts a token only if it starts with `.`, contains `/`, contains `..`, or is a Windows drive-letter absolute path.
A bare filename has none of these shapes, so it is dropped before rule evaluation and bypasses the `path` surface — an inconsistency with the `read`/`write` tools, which evaluate `input.path` directly.

The bare-token exclusion is deliberate: in bash, most argument tokens are not file paths (`git status`, `npm run build`, `grep id_rsa secrets.txt`), so promoting all bare tokens would produce pattern false positives and — under a broad `"*"` rule — turn every bash argument into a prompt.
The fix must close the bypass without reintroducing that blow-up.

## Goals

- Gate a bash bare-filename argument by a `path` rule when the token matches an active, specific (non-`*`) `path` deny/ask pattern, so the permission decision for a file is the same across the `read` tool and bash.
- Preserve the current behavior exactly when no `path` rules are configured (the default), and never promote against the universal `"*"` fallback.
- Keep bare tokens that do not match a specific `path` rule dropped, as today (`status`, `main`, `build`, `pods` stay untouched).

This is not a breaking change: it only tightens gating for configs that already declare specific `path` deny/ask rules, and it never loosens an existing decision.
No config field, default, or output shape changes.

## Non-Goals

- Argument-position / per-command awareness (knowing that `grep PATTERN FILE`'s first argument is a search pattern, or that `git checkout BRANCH` names a branch).
  Rule-driven promotion still matches `git grep id_rsa` against an `id_rsa` rule and produces a spurious prompt; this is accepted as a fail-safe (it prompts, never silently allows).
  Closing that gap needs per-command file-argument knowledge and is out of scope.
- Backslash-relative Windows tokens (`dir\file`, no `/`, no leading `.`, not a drive-letter absolute) — a shape-recognition gap rather than a promotion gap.
  Deferred to [#520].
- Session-rule-driven promotion: promotion is decided from the composed **config** ruleset only (session approvals are allow-shaped and do not gate).
- The strict `external_directory` classifier (`classifyTokenAsPathCandidate`) is unchanged — this issue concerns the `path` surface only.

## Background

The relevant modules and their current relationships:

- `src/access-intent/bash/token-classification.ts` — pure, synchronous classifiers.
  `classifyTokenAsRuleCandidate` is the broad `path`-rule shape gate; it shares the private `rejectNonPathToken` prelude (flags, env assignments, URLs, `@scope` packages, regex metachars) with the strict classifier.
- `src/access-intent/bash/bash-path-resolver.ts` — `BashPathResolver` walks the AST once, tags each token with its cd-folded effective base, and projects two slices: `projectExternalPaths` (strict) and `projectRuleCandidates` (broad).
  It holds a `PathNormalizer` (platform + cwd baked in) as its sole collaborator.
- `src/access-intent/bash/program.ts` — `BashProgram.parse(command, normalizer)` constructs the resolver and eagerly resolves both slices so the three bash gates share one parse.
- `src/handlers/gates/bash-path.ts` — `describeBashPathGate` reads `bashProgram.pathRuleCandidates()`, resolves each against the `path` surface, and gates on the most restrictive.
  It already treats a token whose only match is the universal default (`matchedPattern === undefined`) as unrestricted ([#58]), but a real `"*"` config pattern would still fire — which is why promotion must exclude `"*"` before evaluation.
- `src/handlers/gates/tool-call-gate-pipeline.ts` — `ToolCallGatePipeline.evaluate` performs the single `BashProgram.parse` and holds `ScopedPermissionResolver` + `ToolCallGateInputs` (satisfied by `PermissionSession`).
- `src/permission-manager.ts` — `PermissionManager` owns the composed ruleset and the injected `platform`; `getComposedConfigRules(agentName?)` already exposes config-layer rules, and `PATH_SURFACES`/`pathMatchOptions` encode the Windows case-and-separator fold for path matching.

Constraint from AGENTS.md / the package skill: do not read `process.platform` inside `src/` — the Windows case fold must be decided where the platform already lives (the manager), not re-derived in the bash layer.
The manager must stay string-based and must not import `AccessPath` (guarded by a `no-restricted-imports` lint rule); this change adds only a `wildcardMatch`-based query and does not touch that boundary.

## Design Overview

### Decision model

Promotion is a two-part decision, kept in layers that already own each concern:

1. **Which patterns can promote** (policy) — the composed config ruleset, filtered to `path`-surface rules whose pattern is not `"*"` and whose action is `deny` or `ask`.
   This filtering, and the platform-correct wildcard match, live in `PermissionManager`, which already holds the ruleset and the injected `platform`.
2. **Which tokens are shape-eligible** (shape) — a token that survives `rejectNonPathToken` (not a flag, env assignment, URL, `@scope`, or regex pattern).
   This stays in the pure classifier.

The manager hands the bash layer a ready predicate (Tell-Don't-Ask): "is this bare token promotable?"
The bash layer never sees the patterns or re-implements matching, so the Windows fold has a single home.

```typescript
// New shared predicate type (src/types.ts)
export type PathRuleTokenMatcher = (token: string) => boolean;
```

### Manager: build the promotion predicate

```typescript
// PermissionManager (implements ScopedPermissionManager)
getPromotablePathTokenMatcher(agentName?: string): PathRuleTokenMatcher {
  const { composedRules } = this.resolvePermissions(agentName);
  const patterns = composedRules
    .filter(
      (r) =>
        r.layer === "config" &&
        r.surface === "path" &&
        r.pattern !== "*" &&
        r.action !== "allow",
    )
    .map((r) => r.pattern);
  if (patterns.length === 0) return NO_PROMOTION; // module const: () => false
  const options =
    this.platform === "win32"
      ? { caseInsensitive: true as const, windowsSeparators: true as const }
      : undefined;
  return (token) => patterns.some((p) => wildcardMatch(p, token, options));
}
```

A pattern containing `/` (e.g. `secrets/config`) can never match a bare token (no separator), so no extra filtering is needed — such patterns simply never fire during promotion, and prefixed-path tokens continue to be handled by the existing shape gate.
The Windows fold mirrors `pathMatchOptions` so promotion agrees with the later path-surface evaluation (`cat ID_RSA` matches an `id_rsa` deny rule on win32).

### Threading the predicate to the bash layer

The predicate flows manager → session → pipeline → `BashProgram.parse` → `BashPathResolver`, mirroring how `getPathNormalizer` already threads:

```typescript
// ToolCallGatePipeline.evaluate
const isPromotable = this.inputs.getPromotablePathTokenMatcher(
  tcc.agentName ?? undefined,
);
const bashProgram =
  tcc.toolName === "bash" && command
    ? await BashProgram.parse(command, normalizer, isPromotable)
    : null;
```

`BashProgram.parse(command, normalizer, isPromotable?)` gains an optional third parameter defaulting to a no-op matcher, so the other caller (`bash-path-extractor.ts`, which only reads `externalPaths()`) is unaffected — promotion touches only the rule-candidate slice.

### Resolver: promote at projection time

`BashPathResolver` gains the matcher as an injected collaborator (constructor DI, default no-op):

```typescript
constructor(
  private readonly normalizer: PathNormalizer,
  private readonly isPromotablePathToken: PathRuleTokenMatcher = () => false,
) {}
```

`projectRuleCandidates` falls back to a promoted classification when the broad shape gate rejects a token:

```typescript
const candidate =
  classifyTokenAsRuleCandidate(token) ??
  classifyPromotedRuleCandidate(token, this.isPromotablePathToken);
if (!candidate) continue;
// unchanged: buildRuleCandidatePath(candidate, base), dedup, push
```

A promoted token then flows through the existing `buildRuleCandidatePath` → `normalizer.forPath("id_rsa", { resolveBase })`, producing an `AccessPath` whose `matchValues()` include the raw `id_rsa` alias — so `describeBashPathGate` resolves it against the `path` surface, matches `id_rsa: deny`, and gates it, using the raw token in prompts/logs exactly as for a prefixed path.
The `#393` unknown-base rule (a token after a non-literal `cd` stays literal-only) applies to promoted tokens too, since it lives in `buildRuleCandidatePath`.

### Classifier: the promoted shape gate

```typescript
// token-classification.ts — reuses the private rejectNonPathToken prelude
export function classifyPromotedRuleCandidate(
  token: string,
  isPromotable: PathRuleTokenMatcher,
): string | null {
  if (rejectNonPathToken(token)) return null;
  return isPromotable(token) ? token : null;
}
```

Keeping the reject prelude here means a flag or regex-shaped token that happens to match a pattern (e.g. `-id_rsa`, or a pattern with metachars) is still refused, and the predicate is pure (patterns are captured in the closure passed in).

### Consumer call-site verification (Law of Demeter / Tell-Don't-Ask)

- Pipeline → session: `this.inputs.getPromotablePathTokenMatcher(agentName)` — one call, no reach-through into the ruleset.
- Session → manager: `this.permissionManager.getPromotablePathTokenMatcher(agentName)` — a straight delegate, matching the existing `getInfrastructureReadDirs`/`getPathNormalizer` shape on `PermissionSession`.
- Resolver → predicate: `this.isPromotablePathToken(token)` — invokes an injected function; the resolver never learns of patterns, platform, or the manager.

## Module-Level Changes

- `src/types.ts` — add `export type PathRuleTokenMatcher = (token: string) => boolean;` (neutral shared home; no import cycle).
- `src/permission-manager.ts` — add `getPromotablePathTokenMatcher(agentName?)` to the `ScopedPermissionManager` interface and implement it on `PermissionManager`; import `wildcardMatch` and `PathRuleTokenMatcher`; add the `NO_PROMOTION` module constant.
- `src/permission-session.ts` — add `getPromotablePathTokenMatcher(agentName?)` delegating to `this.permissionManager` (satisfies the widened `ToolCallGateInputs`).
- `src/handlers/gates/tool-call-gate-pipeline.ts` — widen `ToolCallGateInputs` with `getPromotablePathTokenMatcher(agentName?)`; fetch the matcher in `evaluate` and pass it to `BashProgram.parse`.
- `src/access-intent/bash/program.ts` — add the optional `isPromotable` third parameter to `parse` and forward it to `new BashPathResolver`.
- `src/access-intent/bash/bash-path-resolver.ts` — inject the matcher (default no-op); use the promoted fallback in `projectRuleCandidates`.
- `src/access-intent/bash/token-classification.ts` — add `classifyPromotedRuleCandidate`; update the module header comment to describe the new promoted classifier alongside the two existing ones.
- Test fixtures:
  - `test/helpers/session-fixtures.ts` — add `getPromotablePathTokenMatcher: vi.fn(() => () => false)` to `makeFakePermissionManager`.
  - `test/helpers/gate-fixtures.ts` — add a `getPromotablePathTokenMatcher` override + default (`() => () => false`) to `makeGateInputs`.
- Docs:
  - `packages/pi-permission-system/docs/architecture/architecture.md` — update the `token-classification.ts` module-tree line (currently naming the two classifiers) to mention `classifyPromotedRuleCandidate`, and add a short note on the manager's `getPromotablePathTokenMatcher` predicate feeding the bash `path` gate.
  - `.pi/skills/package-pi-permission-system/SKILL.md` — the "bash `external_directory` gate only sees tokens that `classifyTokenAsPathCandidate` accepts … gated by the broader `path` surface (`classifyTokenAsRuleCandidate`)" prose now understates the `path` surface: add that a bare filename is promoted into the `path` surface when it matches a specific (non-`*`) `path` deny/ask rule, and that promotion is decided by the manager's platform-aware matcher.
  - `packages/pi-permission-system/docs/configuration.md` — add a sentence to the `path`-surface documentation noting that a specific (non-`*`) `path` deny/ask rule also gates bare-filename bash arguments (`cat id_rsa`), so the rule behaves the same across the `read` tool and bash.

No file listed here is claimed as unchanged in Non-Goals; the `external_directory` classifier and config schema are genuinely untouched.

## Test Impact Analysis

1. **New tests enabled by this change:**
   - `classifyPromotedRuleCandidate` (pure): promotes a shape-eligible token when the predicate returns true; returns `null` when it returns false; still rejects flags/URLs/env/regex tokens regardless of the predicate.
   - `PermissionManager.getPromotablePathTokenMatcher`: matches `id_rsa` against `"id_rsa": "deny"`; matches `key.pem` against `"*.pem": "ask"`; does not match against a `"*"` rule; does not match against an allow-only rule; returns a no-op when no `path` rules exist; folds case on an injected `win32` platform (`ID_RSA` → matches `id_rsa`).
   - `BashPathResolver` / `BashProgram.parse`: with a promoting matcher, `cat id_rsa` yields an `id_rsa` rule candidate; with the default no-op matcher, it yields none (regression guard for the no-config default).
2. **Redundant tests:** none.
   Existing `classifyTokenAsRuleCandidate` tests keep asserting bare tokens return `null` — that shape behavior is unchanged; promotion is an additive second layer.
3. **Tests that must stay as-is:** the existing `token-classification`, `program`, and `bash-path` gate tests that exercise prefixed/relative/absolute tokens and the `#393`/`#418` resolution invariants — they pin the unchanged path.

## Invariants at risk

This change touches `token-classification.ts` (refactored in [#475], extended in [#508]) and `bash-path-resolver.ts` (cd-projection [#475], canonical matching [#418], [#393] unknown-base rule).
The invariants that must not regress, and their pins:

- **No-config default is behavior-preserving** — with no `path` rules, no bare token is promoted.
  Pinned by a new `BashProgram.parse` test using the default no-op matcher, plus the existing default-config gate tests.
- **`#393` unknown-base literal-only** — a promoted token after a non-literal `cd` keeps only its literal value.
  Preserved structurally (promotion feeds the unchanged `buildRuleCandidatePath`); add a resolver test asserting a promoted token under an unknown base is literal-only.
- **`#418` canonical/lexical alias matching** — promoted tokens resolve through the same `forPath`/`matchValues` path as any relative token.
  Covered by the end-to-end gate test resolving a promoted token against a `path` deny rule.
- **`"*"` never storms** — a `"path": { "*": "ask" }` config does not promote every bare bash argument.
  Pinned by a `getPromotablePathTokenMatcher` test asserting no match against `"*"`.

## TDD Order

Numbered red→green→commit cycles.
The `ScopedPermissionManager` / `ToolCallGateInputs` interface widenings break their fakes at the type level, so each interface change lands with its fake update and the real implementation in one commit.

1. **Pure promoted classifier.**
   Test `classifyPromotedRuleCandidate` (promote when predicate true, reject when false, still reject flags/URLs/env/regex).
   Add the `PathRuleTokenMatcher` type in `types.ts` and the classifier in `token-classification.ts`.
   Commit: `feat(pi-permission-system): add rule-driven bare-token classifier`.

2. **Manager promotion predicate.**
   Test `PermissionManager.getPromotablePathTokenMatcher` (specific deny/ask match, `"*"` excluded, allow-only excluded, empty when no `path` rules, win32 case-fold via injected platform).
   Add the method to the `ScopedPermissionManager` interface, implement it on `PermissionManager`, and update `makeFakePermissionManager` in the same commit (interface widening breaks the fake's type).
   Commit: `feat(pi-permission-system): derive promotable path-token matcher from config`.

3. **Resolver + BashProgram promotion.**
   Test `BashProgram.parse` / `BashPathResolver`: a promoting matcher turns `cat id_rsa` into a rule candidate; the default no-op matcher yields none; a promoted token under an unknown base stays literal-only (#393).
   Inject the matcher into `BashPathResolver` (default no-op), add the optional third parameter to `BashProgram.parse`, and wire the promoted fallback into `projectRuleCandidates`.
   Commit: `feat(pi-permission-system): promote bare tokens in bash path projection`.

4. **Pipeline wiring.**
   Test `ToolCallGatePipeline` passes the session matcher into the parse (a config `id_rsa: deny` makes `cat id_rsa` resolve to deny).
   Widen `ToolCallGateInputs`, implement `getPromotablePathTokenMatcher` on `PermissionSession`, fetch-and-pass it in `evaluate`, and update `makeGateInputs` in the same commit (interface widening breaks the fixture).
   Commit: `feat(pi-permission-system): gate bash bare filenames via path rules`.

5. **End-to-end composition-root repro.**
   Test (in `composition-root.test.ts`, filesystem-backed) that with `path: { "id_rsa": "deny" }`, a bash `cat id_rsa` tool call is blocked, and `cat key.pem` under `"*.pem": "deny"` is blocked, while `git status` (bare non-matching token) is unaffected — the literal repro from the issue.
   Commit: `test(pi-permission-system): cover bash bare-filename path gating end to end`.

6. **Docs.**
   Update `architecture.md`, the package `SKILL.md`, and `configuration.md` per Module-Level Changes.
   Commit: `docs(pi-permission-system): document bash bare-filename path promotion`.

## Risks and Mitigations

- **Spurious prompts for search patterns / branch names** (`git grep id_rsa` under `id_rsa: deny`).
  Accepted per the chosen scope: it fails safe (prompts, never silently allows).
  Argument-position awareness is deferred (Non-Goals); the end-to-end test documents the fail-safe direction.
- **Windows fold divergence** — promotion matching disagreeing with path-surface evaluation.
  Mitigated by deciding the fold in the manager with the same `caseInsensitive`/`windowsSeparators` options `pathMatchOptions` uses, and by an injected-`win32` unit test.
- **Interface-widening breakage** — adding methods to `ScopedPermissionManager` / `ToolCallGateInputs` breaks fakes.
  Mitigated by folding each fake update into the same commit as its interface change (TDD steps 2 and 4).
- **Performance** — `getPromotablePathTokenMatcher` filters the composed ruleset per bash tool call.
  Bounded: it reuses the cached `resolvePermissions` result and returns a fast no-op closure when no `path` rules exist (the common case).

## Open Questions

- Argument-position / per-command file-argument awareness to eliminate the accepted search-pattern false positives — deferred; no issue filed (no concrete design yet).
  The principled successor is the `ModelTriageAuthorizer` in `docs/architecture/architecture.md` ("Discriminating delegation: a model `Authorizer`"): promotion here produces the `ask` on the ask-*producing* side of `evaluate()`, and a model `Authorizer` dismisses the false positive on the ask-*consuming* side.
  This plan is compatible with that target by construction — a promoted token emits the same structured descriptor a prefixed path does, so the authority layer needs no promotion-specific knowledge.
- Backslash-relative Windows tokens (`dir\file`) — deferred and tracked in [#520].

[#58]: https://github.com/gotgenes/pi-packages/issues/58
[#393]: https://github.com/gotgenes/pi-packages/issues/393
[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#475]: https://github.com/gotgenes/pi-packages/issues/475
[#508]: https://github.com/gotgenes/pi-packages/issues/508
[#520]: https://github.com/gotgenes/pi-packages/issues/520
