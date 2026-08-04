---
issue: 304
issue_title: "Consolidate bash command analysis behind a single parsed representation and a candidate-combination helper"
---

# Consolidate bash command analysis

## Problem Statement

Three concerns derive information from a bash command string, and each parses the command independently with tree-sitter:

- `bash` command-pattern matching — matches the whole command string (the bug tracked in [#301]).
- `path` rules — `extractTokensForPathRules()` walks the AST for path-candidate tokens.
- `external_directory` — `extractExternalPathsFromBashCommand()` walks the AST for paths resolving outside CWD (cd-aware).

There is no shared parsed representation, so adding a new bash-derived concern (such as the per-sub-command list [#301] needs) means yet another standalone extractor with no guarantee the decompositions agree.
Separately, the "evaluate several candidate values against a surface and combine the results" loop is copied across the two bash gates rather than abstracted: `describeBashPathGate` and `describeBashExternalDirectoryGate` each re-implement the same most-restrictive selection, and [#301] would copy it a third time.

This is the "make the change easy, then make the easy change" prerequisite for [#301].
It is a behavior-preserving refactor: same decisions, same outputs, less duplication, and a representation that [#301] can extend with one slice instead of a fourth parse and a fourth walker.

## Goals

- Introduce a single parsed-bash value object (`BashProgram`) that parses once and exposes typed slices (`pathTokens()`, `externalPaths(cwd)`), so future bash-derived concerns add a method rather than a standalone extractor.
- Introduce a reusable most-restrictive selection helper (`pickMostRestrictive`) over `PermissionCheckResult`s and migrate both bash gates' selection onto it.
- Keep behavior identical, verified by the existing suite staying green.
- Leave [#301] as a roughly two-step change on top of this work.

## Non-Goals

- No behavior change of any kind.
  The chain-evaluation fix lands in [#301].
- Do not change `PermissionManager.checkPermission()`, `PermissionsService`, or the event-bus RPC.
- Do not parse-once-and-inject a shared `BashProgram` into the gates from the handler.
  That changes gate signatures and the gate pipeline — it belongs to the deferred gate-consolidation follow-up.
  This refactor keeps each gate's existing parse call; the win here is the representation and the selection helper, not parse-sharing across gates.
- Do not merge the rule-level combinators (`evaluateFirst`, `evaluateMostRestrictive` in `rule.ts`).
  Those operate on `Rule`s one layer below; `pickMostRestrictive` operates on `PermissionCheckResult`s at the gate layer.
- Do not touch `bash-arity.ts`, `pattern-suggest.ts`, the wildcard matcher, config schema, or `docs/configuration.md` (no config/behavior change).

## Background

Relevant modules:

- `src/handlers/gates/bash-path-extractor.ts` — the tree-sitter-bash parser and AST walker.
  Private primitives `getParser` (lazy WASM init), `resolveNodeText`, `collectPathCandidateTokens`, `extractLeadingCdTarget`, `computeEffectiveResolveBase`; classification via `classifyTokenAsPathCandidate` (strict) and `classifyTokenAsRuleCandidate` (broad) from `bash-token-classification.ts`.
  Exports `extractExternalPathsFromBashCommand(command, cwd)` and `extractTokensForPathRules(command)`.
  The two exports already share the walker; they differ only in classification and the external-path resolve/filter step.
- `src/handlers/gates/bash-path.ts` — `describeBashPathGate`: loops `checkPermission("path", { path: token })` per token, with a #58 backward-compat filter (a token whose only match is the universal default is treated as unrestricted) and session-coverage detection, then keeps the most-restrictive uncovered result (deny short-circuit, then ask).
- `src/handlers/gates/bash-external-directory.ts` — `describeBashExternalDirectoryGate`: loops `checkPermission("external_directory", { path })`, filters to uncovered (`state !== "allow"`), then picks `worstCheck = first deny ?? first uncovered`.
- `src/rule.ts` — rule-level `evaluate`, `evaluateFirst`, `evaluateMostRestrictive` (out of scope; a layer below).
- `test/bash-external-directory.test.ts` — large (900+ line) suite that exercises `extractExternalPathsFromBashCommand` and `extractTokensForPathRules` directly.
  These exports must keep working unchanged (lift-and-shift: keep them as thin facades; do not rewrite this file).

Constraint from `AGENTS.md` / package skill that applies: behavior-preserving refactors must keep schema/example/docs aligned (no change needed here since behavior is unchanged), and extractions must have real consumers (no speculative exports — fallow will flag dead code).

## Design Overview

### `BashProgram` value object

One parse, two derived slices.
The two existing extractors become thin facades over it (so the large extractor test suite stays green), and [#301] later adds a `topLevelCommands()` method as a third slice.

```typescript
// src/handlers/gates/bash-program.ts  (parse/walk primitives move here from bash-path-extractor.ts)

export class BashProgram {
  private constructor(
    private readonly rawTokens: string[],
    private readonly leadingCdTarget: string | undefined,
  ) {}

  /** Parse a bash command once into a reusable representation. */
  static async parse(command: string): Promise<BashProgram>;

  /** Broad path-candidate tokens for `path` rules (dot-files, relative paths). */
  pathTokens(): string[];

  /** Strict path candidates resolving outside `cwd` (cd-aware). */
  externalPaths(cwd: string): string[];

  // [#301] will add: topLevelCommands(): string[]
}
```

`bash-path-extractor.ts` keeps its public surface as facades:

```typescript
export async function extractTokensForPathRules(command: string): Promise<string[]> {
  return (await BashProgram.parse(command)).pathTokens();
}
export async function extractExternalPathsFromBashCommand(
  command: string,
  cwd: string,
): Promise<string[]> {
  return (await BashProgram.parse(command)).externalPaths(cwd);
}
```

To avoid a circular import, the parse/walk primitives (`getParser`, `resolveNodeText`, `collectPathCandidateTokens`, `extractLeadingCdTarget`, `computeEffectiveResolveBase`, `extractCommandName`, `findFirstCommand`) move into `bash-program.ts` alongside `BashProgram`; `bash-path-extractor.ts` imports `BashProgram` and exposes the facades.
The big test file's import path (`#src/handlers/gates/bash-path-extractor`) is unchanged.

### `pickMostRestrictive` selection helper

The common core of both bash gates' selection — deny > ask > allow, first occurrence wins on ties — extracted as a pure function over results.
The gates keep their surface-specific filters (session-coverage, #58 backward-compat, uncovered) and call the helper for the final pick.

```typescript
// src/handlers/gates/candidate-check.ts

/** deny > ask > allow; first occurrence wins on ties. undefined for an empty list. */
export function pickMostRestrictive(
  results: readonly PermissionCheckResult[],
): PermissionCheckResult | undefined;
```

Fit check against each gate (confirms the seam is correct, not forced):

- External-directory gate: `worstCheck = uncoveredEntries.find(deny)?.check ?? uncoveredEntries[0].check` is exactly `pickMostRestrictive(uncoveredEntries.map(e => e.check))`.
  Clean drop-in.
- Path gate: keep the per-token loop that classifies each token (allow / session-covered / #58-unrestricted / uncovered) and the `allSessionCovered` bypass; replace the final `worstCheck` accumulation with `pickMostRestrictive(uncoveredChecks)`.
  Behavior identical; the existing path-gate tests pin it.
  Note: the path gate currently short-circuits on the first deny; collecting uncovered results and then picking is output-identical (the picked deny is the same), at the cost of a few extra in-memory `checkPermission` calls — acceptable for a behavior-preserving refactor.

This gives `pickMostRestrictive` two consumers in this issue (both bash gates); [#301] is the third.

### Why both, honestly

`pickMostRestrictive` (#2) is the change that most directly removes duplication [#301] would otherwise repeat.
`BashProgram` (#1) centralizes the growing set of bash-derived slices into one cohesive object and is the seam [#301] extends; its parse-sharing payoff is realized later by the deferred gate-consolidation work.
The existing extractors already share the walker, so #1's near-term win is cohesion and extensibility rather than fewer parses.

## Module-Level Changes

- `src/handlers/gates/bash-program.ts` — new module: `BashProgram` class plus the parse/walk primitives moved from `bash-path-extractor.ts`.
- `src/handlers/gates/bash-path-extractor.ts` — reduced to the two facade functions delegating to `BashProgram`; imports `BashProgram`.
  Public exports unchanged.
- `src/handlers/gates/candidate-check.ts` — new module: `pickMostRestrictive`.
- `src/handlers/gates/bash-external-directory.ts` — replace the `worstCheck` selection with `pickMostRestrictive`.
- `src/handlers/gates/bash-path.ts` — replace the `worstCheck` accumulation with `pickMostRestrictive` over the uncovered-token results; keep the #58 and session-coverage logic.
- `docs/architecture/architecture.md` — update the directory listing: add `bash-program.ts` (`BashProgram`) and `candidate-check.ts` (`pickMostRestrictive`), and revise the `bash-path-extractor.ts` entry to "facades over `BashProgram`".
  Review `v3-architecture.md` for the same.
- No changes to config schema, example config, `docs/configuration.md`, or `README.md` (behavior unchanged).

## Test Impact Analysis

1. New unit tests enabled:
   - `test/handlers/gates/bash-program.test.ts` — `BashProgram.parse().pathTokens()` and `.externalPaths(cwd)` at the value-object level (a subset mirroring the existing extractor cases, plus that one parse yields both slices).
   - `test/handlers/gates/candidate-check.test.ts` — `pickMostRestrictive`: deny > ask > allow, first-wins on ties, empty → `undefined`.
2. Existing tests that stay as-is (the behavior-preservation guard):
   - `test/bash-external-directory.test.ts` — still exercises the facades; unchanged behavior.
   - `test/handlers/gates/bash-path.test.ts`, `test/handlers/gates/bash-external-directory.test.ts` — gate behavior unchanged; these are the migration's safety net.
3. No tests become redundant; new tests are additive at lower levels.

## TDD / Refactor Order

Each step is behavior-preserving and leaves the full suite green.

1. `refactor: extract pickMostRestrictive and use it in the bash external-directory gate`
   - Add `src/handlers/gates/candidate-check.ts` with a new `test/handlers/gates/candidate-check.test.ts`.
   - Migrate `describeBashExternalDirectoryGate`'s `worstCheck` onto it (its existing tests stay green).
   - Lands the helper with a real consumer immediately (no speculative export).
2. `refactor: select most-restrictive bash path result via pickMostRestrictive`
   - Refactor `describeBashPathGate` to collect uncovered-token results and call `pickMostRestrictive`, preserving the #58 backward-compat and session-coverage logic.
   - Run the path-gate suite and `pnpm run check` immediately (subtle logic).
3. `refactor: introduce BashProgram and reduce extractors to facades`
   - Add `src/handlers/gates/bash-program.ts` (`BashProgram` + moved primitives) with `test/handlers/gates/bash-program.test.ts`.
   - Reimplement `extractTokensForPathRules` / `extractExternalPathsFromBashCommand` as facades over `BashProgram`.
   - The large `test/bash-external-directory.test.ts` stays green unchanged.
   - Run `pnpm run check` (cross-module move).
4. `docs: document BashProgram and the most-restrictive selection helper`
   - Update `docs/architecture/architecture.md` (and `v3-architecture.md` if needed).
   - Docs-only commit.

After this issue ships, [#301] becomes: add `BashProgram.topLevelCommands()`, add a bash command gate that evaluates each top-level command via `checkPermission` and selects with `pickMostRestrictive`, wire it into the tool-gate producer, and update `docs/configuration.md`.

## Risks and Mitigations

- Moving the parse/walk primitives between modules is the largest single edit.
  Mitigation: it is a mechanical move with no logic change, gated by the unchanged extractor test suite and `pnpm run check` in step 3.
- The path-gate refactor touches subtle #58 and session-coverage logic.
  Mitigation: preserve the surrounding loop and filters; only the final selection moves to `pickMostRestrictive`; run the path-gate tests in the same step.
- Losing the path gate's deny short-circuit slightly changes work done (not output).
  Mitigation: acceptable for a behavior-preserving refactor; output is identical and inputs are small.

## Open Questions

- Should `bash-path-extractor.ts` be renamed to reflect that it is now a thin facade layer (e.g. fold the facades into `bash-program.ts` and retire the file)?
  Deferred; renaming touches the large test file's import line and a few gate imports.
  Track and revisit if the facades lose value once [#301] lands.
- Is parse-once-and-inject (a single `BashProgram` per tool_call shared by all bash gates) worth a follow-up alongside the gate-consolidation work?
  Deferred to that follow-up.

[#301]: https://github.com/gotgenes/pi-packages/issues/301
