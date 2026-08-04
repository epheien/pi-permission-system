---
issue: 289
issue_title: "Decompose bash-path-extractor.ts: shared token rejection + collect* complexity"
---

# Decompose `bash-path-extractor.ts`

## Problem Statement

`src/handlers/gates/bash-path-extractor.ts` is the largest file in the package at 670 LOC, and `fallow` flags two convergent debts in it.
The two token classifiers (`classifyTokenAsPathCandidate` and `classifyTokenAsRuleCandidate`) share an identical rejection prelude — a 31-line production clone — and diverge only in their final acceptance gate.
Separately, the two AST walkers are complexity hotspots: `collectPathCandidateTokens` (cognitive 37) mixes node-type dispatch with the generic-extraction body, and `collectPatternCommandTokens` (cognitive 33) carries an inline flag-handling state machine.

This is Phase 2 Step 4 of the improvement roadmap in `packages/pi-permission-system/docs/architecture/architecture.md` (the `bash-path-extractor` track).
The change is behavior-preserving: the existing integration suites must stay green without modification.

## Goals

- Remove the 31-line rejection-prelude clone by extracting a single `rejectNonPathToken(token)` predicate; each classifier keeps only its distinct acceptance gate.
- Move the pure token-classification helpers into a new `bash-token-classification.ts` module with a public API, shrinking the largest file and making the classifiers directly unit-testable.
- Add dedicated unit tests for the extracted classifiers (every rejection branch and every acceptance branch).
- Reduce `collectPathCandidateTokens` (37) and `collectPatternCommandTokens` (33) below the `fallow` complexity target by extracting node-type handlers and a flag-classification helper.
- Convert the `collect*` functions from an output-argument accumulator to return-based (`string[]`), eliminating the mutated-accumulator pattern.
- Keep behavior identical — all existing integration tests pass unmodified.

## Non-Goals

- No change to the two public entry points' signatures (`extractExternalPathsFromBashCommand(command, cwd)`, `extractTokensForPathRules(command)`) or return contracts.
- No change to the tree-sitter parser lifecycle, `resolveNodeText`, `extractCommandName`, the `cd`-resolution helpers (`extractLeadingCdTarget`, `computeEffectiveResolveBase`, `findFirstCommand`), or the `PATTERN_FIRST_COMMANDS` config.
- No change to the gate consumers (`bash-external-directory.ts`, `bash-path.ts`).
- No new permission surface, config field, or schema entry.
- Phase 2 Steps 5 ([#290]) and 6 ([#288]) are separate issues and out of scope.

## Background

### Current module surface

`bash-path-extractor.ts` exports exactly two functions:

- `extractExternalPathsFromBashCommand(command, cwd): Promise<string[]>` — used by `bash-external-directory.ts`.
- `extractTokensForPathRules(command): Promise<string[]>` — used by `bash-path.ts`.

Every other function is private to the module.
A grep across `src/`, `test/`, and `.pi/skills/package-pi-permission-system/SKILL.md` confirms no external consumer references `classifyTokenAsPathCandidate`, `classifyTokenAsRuleCandidate`, `collectPathCandidateTokens`, `collectPatternCommandTokens`, or `rejectNonPathToken` — the integration tests in `test/bash-external-directory.test.ts` reach them only through the two public functions.
This means the extraction has no external blast radius.

### The clone

`classifyTokenAsRuleCandidate` (lines 439–466) and `classifyTokenAsPathCandidate` (lines 468–512) both run the same rejection prelude before diverging:

- empty token
- leading `-` (flag)
- `FOO=/bar` env assignment (`=` before any `/`)
- URL (`URL_PATTERN`)
- `@scope/package` (leading `@` but not `@/`)
- bare-slash (`/^\/+$/`)
- regex metacharacters (`REGEX_METACHAR_PATTERN`)

They diverge only in the acceptance gate:

- path candidate: accepts leading `/`, leading `~/`, or contains `..`.
- rule candidate: also accepts leading `.` (dot-files, `./`) and any token containing `/` (relative paths).

### The two hotspots

`collectPathCandidateTokens` (37) is a recursive walker that dispatches on node type (`command` vs `file_redirect` vs everything else) and inlines the entire generic-command extraction loop in the `command` branch.

`collectPatternCommandTokens` (33) walks a pattern-first command's children with an inline state machine over `nextArgAction` (skip/extract), `pastEndOfFlags`, `positionalsSeen`, and `hasExplicitScript`.

### Constraints from AGENTS.md

- TypeScript, ES2024 target, `pnpm` only.
- Within the package, import siblings via the `#src/` alias, not relative paths.
- Biome bans `x!` and ESLint auto-fixes `x as T` back to `x!` — avoid assertions; prefer a discriminated union that narrows naturally.
- Only export symbols a production consumer imports — `fallow dead-code` flags speculative exports.
- Keep modules SDK-independent; these are pure helpers with no Pi SDK imports.

## Design Overview

### New module: `src/handlers/gates/bash-token-classification.ts`

Pure, synchronous, SDK-free.
It owns the two regex patterns and the shared rejection predicate, and exports the two acceptance classifiers consumed by the walker.

```typescript
const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;
const REGEX_METACHAR_PATTERN = /\.\*|\.\+|\\\||\\\(|\\\)|\[.*?\]|\^\//;

/** Shared rejection prelude: true when a token can never be a filesystem path. */
function rejectNonPathToken(token: string): boolean {
  if (!token) return true;
  if (token.startsWith("-")) return true;
  const eqIndex = token.indexOf("=");
  const slashIndex = token.indexOf("/");
  if (eqIndex !== -1 && (slashIndex === -1 || eqIndex < slashIndex)) return true;
  if (URL_PATTERN.test(token)) return true;
  if (token.startsWith("@") && !token.startsWith("@/")) return true;
  if (/^\/+$/.test(token)) return true;
  if (REGEX_METACHAR_PATTERN.test(token)) return true;
  return false;
}

/** External-directory gate: strict path-shape acceptance. */
export function classifyTokenAsPathCandidate(token: string): string | null {
  if (rejectNonPathToken(token)) return null;
  if (token.startsWith("/")) return token;
  if (token.startsWith("~/")) return token;
  if (token.includes("..")) return token;
  return null;
}

/** Cross-cutting `path` rules: broader acceptance (dot-files, relative paths). */
export function classifyTokenAsRuleCandidate(token: string): string | null {
  if (rejectNonPathToken(token)) return null;
  if (token.startsWith(".")) return token;
  if (token.includes("/")) return token;
  if (token.startsWith("~/")) return token;
  if (token.includes("..")) return token;
  return null;
}
```

`rejectNonPathToken` stays private to the module — it has two in-module callers and needs no external export.
Both classifiers are exported because `bash-path-extractor.ts` imports them; that satisfies the "one consumer per export" rule and avoids a `fallow` dead-export flag.

### Walker conversion to return-based (`bash-path-extractor.ts`)

The mutually recursive walkers (`collectPathCandidateTokens` ↔ `collectPatternCommandTokens`) and both public entry points share the accumulator at the type level, so the conversion is a single atomic change.

`collectPathCandidateTokens` becomes a thin dispatcher:

```typescript
function collectPathCandidateTokens(node: TSNode): string[] {
  if (SKIP_SUBTREE_TYPES.has(node.type)) return [];
  if (node.type === "command") return collectCommandTokens(node);
  if (node.type === "file_redirect") return collectRedirectTokens(node);

  const tokens: string[] = [];
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child) tokens.push(...collectPathCandidateTokens(child));
  }
  return tokens;
}
```

`collectCommandTokens` selects the strategy; `collectGenericCommandTokens` holds the extracted generic loop; `collectRedirectTokens` holds the redirect-destination loop (its inline node-type set is exactly `ARG_NODE_TYPES`, so it reuses that set — a behavior-identical tidy):

```typescript
function collectCommandTokens(node: TSNode): string[] {
  const commandName = extractCommandName(node);
  const config = commandName ? PATTERN_FIRST_COMMANDS.get(commandName) : undefined;
  return config
    ? collectPatternCommandTokens(node, config)
    : collectGenericCommandTokens(node);
}
```

### Flag classification helper

The inline flag state machine in `collectPatternCommandTokens` becomes a value-returning helper that maps a flag word to a directive, leaving the loop to apply the directive.
The discriminated union narrows `nextArgAction` without a non-null assertion (avoiding the Biome/ESLint conflict):

```typescript
type PatternCommandFlagDirective =
  | { kind: "end-of-flags" }
  | { kind: "regular-flag" }
  | { kind: "consume-arg"; nextArgAction: "skip" | "extract"; setsExplicitScript: boolean };

function classifyPatternCommandFlag(
  text: string,
  config: PatternCommandConfig,
): PatternCommandFlagDirective {
  if (text === "--") return { kind: "end-of-flags" };
  if (config.argConsumingFlags.has(text)) {
    return {
      kind: "consume-arg",
      nextArgAction: "skip",
      setsExplicitScript: text === "-e" || text === "-f",
    };
  }
  if (config.fileConsumingFlags.has(text)) {
    return { kind: "consume-arg", nextArgAction: "extract", setsExplicitScript: true };
  }
  return { kind: "regular-flag" };
}
```

`collectPatternCommandTokens` returns `string[]`, recurses via `collectPathCandidateTokens(child)` for non-argument children, and applies the directive in a `switch`:

```typescript
if (!pastEndOfFlags && child.type === "word" && text.startsWith("-") && text.length > 1) {
  const directive = classifyPatternCommandFlag(text, config);
  switch (directive.kind) {
    case "end-of-flags":
      pastEndOfFlags = true;
      break;
    case "consume-arg":
      nextArgAction = directive.nextArgAction;
      if (directive.setsExplicitScript) hasExplicitScript = true;
      break;
    case "regular-flag":
      break;
  }
  continue;
}
```

`classifyPatternCommandFlag` stays private — it is a walker detail tied to `PatternCommandConfig`, fully covered by the existing per-command integration tests (sed/grep/awk/rg/sd), and exporting it only for tests would risk a `fallow` dead-export.

### Public entry points

Both exported functions drop the pre-allocated accumulator and assign the returned array, then classify via the imported pure functions:

```typescript
// extractExternalPathsFromBashCommand
let tokens: string[] = [];
try {
  cdTarget = extractLeadingCdTarget(tree.rootNode);
  tokens = collectPathCandidateTokens(tree.rootNode);
} finally {
  tree.delete();
}
// ... classifyTokenAsPathCandidate(token) per token, dedup unchanged
```

```typescript
// extractTokensForPathRules
let tokens: string[] = [];
try {
  tokens = collectPathCandidateTokens(tree.rootNode);
} finally {
  tree.delete();
}
// ... classifyTokenAsRuleCandidate(token) per token, dedup unchanged
```

Token ordering is preserved (children are still visited left-to-right and spread in iteration order); deduplication stays in the entry points and is untouched.

### Design verification

The new module is a pure collaborator: the entry points call `classifyTokenAsPathCandidate(token)` / `classifyTokenAsRuleCandidate(token)` directly — Tell-Don't-Ask, no reach-through, no shared state.
The extracted walker handlers (`collectCommandTokens`, `collectGenericCommandTokens`, `collectRedirectTokens`) each return a fresh `string[]` and call only existing upstream helpers (`resolveNodeText`, `extractCommandName`, `PATTERN_FIRST_COMMANDS.get`); the return-based conversion removes the prior output-argument mutation rather than carrying it into the new functions.
`classifyPatternCommandFlag` returns a value (the directive), so it moves the flag-semantics decision onto data instead of merely relocating statements.

### Edge cases (all behavior-preserving)

- Empty / flag-only / env-assignment tokens: rejected identically by `rejectNonPathToken`.
- `--` end-of-flags marker, `-e`/`-f` explicit-script flags, `sd`'s two pattern positionals: unchanged — the directive encodes the same transitions.
- Command substitution and other non-argument children: still recurse through `collectPathCandidateTokens`.
- `heredoc_body` / `heredoc_end` / `comment` subtrees: still skipped at the dispatcher.

## Module-Level Changes

| File                                                    | Change                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/handlers/gates/bash-token-classification.ts`       | New — `URL_PATTERN`, `REGEX_METACHAR_PATTERN`, private `rejectNonPathToken`, exported `classifyTokenAsPathCandidate` and `classifyTokenAsRuleCandidate`                                                                                                                                                                                                     |
| `src/handlers/gates/bash-path-extractor.ts`             | Remove the two classifiers and the two regex constants; import the classifiers from the new module; convert `collectPathCandidateTokens`/`collectPatternCommandTokens` to return `string[]`; extract `collectCommandTokens`, `collectGenericCommandTokens`, `collectRedirectTokens`, and `classifyPatternCommandFlag`; update both entry points' call sites |
| `test/handlers/gates/bash-token-classification.test.ts` | New — direct unit tests for both classifiers                                                                                                                                                                                                                                                                                                                |
| `docs/architecture/architecture.md`                     | Add `bash-token-classification.ts` to the gates module listing; refresh the `bash-path-extractor.ts` description; mark Phase 2 Step 4 complete; update health metrics if remeasured                                                                                                                                                                         |

No barrel changes: `src/handlers/gates/` has no `index.ts`, and `src/index.ts` does not re-export these internals.
No symbol named in `.pi/skills/package-pi-permission-system/SKILL.md` is removed — no skill update needed.

## Test Impact Analysis

1. New unit tests enabled — `test/handlers/gates/bash-token-classification.test.ts`.
   The classifiers were previously private and reachable only through async tree-sitter parsing, so they could not be tested in isolation.
   As pure synchronous functions they can now be tested branch-by-branch: every rejection (empty, flag, env-assignment, URL, `@scope/package`, bare-slash, regex metacharacter) and every acceptance (path: `/`, `~/`, `..`; rule: leading `.`, contains `/`, `~/`, `..`).
   This also pins the shared `rejectNonPathToken` behavior via both classifiers.

2. Tests that become partially redundant — several `bash-external-directory.test.ts` integration cases assert classification outcomes indirectly (URLs skipped, `@scope/package` skipped, bare-slash skipped, regex-not-a-path, flags skipped, env assignments skipped).
   The new unit tests now cover that logic directly.
   They are not removed: the issue requires the integration suites stay unmodified, and each still exercises the full parse → resolve → classify path (not just the predicate), so they retain integration value.

3. Tests that must stay as-is — the entire `extractExternalPathsFromBashCommand`, `extractTokensForPathRules`, command-aware (sed/grep/awk/rg/sd), redirect, deduplication, and `leading cd` suites in `bash-external-directory.test.ts`.
   They are the only coverage of the AST walkers being refactored (`collectPathCandidateTokens`, `collectPatternCommandTokens`, and the new handlers/flag helper, which get no dedicated unit tests), so they are the behavior-preservation safety net for Steps 2 and 3 below.

## TDD Order

1. `test:` Add `test/handlers/gates/bash-token-classification.test.ts` covering `classifyTokenAsPathCandidate` and `classifyTokenAsRuleCandidate` — every rejection branch and every acceptance branch, including the rule-vs-path divergence (dot-files and relative paths accepted only by the rule classifier).
   Red: the module does not exist yet.
   Commit: `test: add bash token classification unit tests`

2. `refactor:` Create `src/handlers/gates/bash-token-classification.ts` (regex patterns + private `rejectNonPathToken` + the two exported classifiers).
   Remove the two classifier functions and the `URL_PATTERN`/`REGEX_METACHAR_PATTERN` constants from `bash-path-extractor.ts`; import the classifiers from the new module.
   Green: new unit tests pass and the unchanged integration suites stay green.
   This removes the 31-line clone — `rejectNonPathToken` is now the single source for the shared prelude.
   Commit: `refactor: extract shared token rejection into bash-token-classification`

3. `refactor:` Convert `collectPathCandidateTokens` and `collectPatternCommandTokens` to return `string[]`; extract `collectCommandTokens`, `collectGenericCommandTokens`, `collectRedirectTokens` (reusing `ARG_NODE_TYPES`), and the value-returning `classifyPatternCommandFlag`; update both public entry points' call sites in the same commit (the mutual recursion and shared accumulator break at the type level otherwise).
   No test file changes — the `bash-external-directory.test.ts` integration suites guard behavior and must stay green.
   Commit: `refactor: reduce collect-token complexity in bash-path-extractor`

4. `docs:` Update `docs/architecture/architecture.md` — add `bash-token-classification.ts` to the gates listing, refresh the `bash-path-extractor.ts` description, mark Phase 2 Step 4 complete, and update the metrics table if remeasured with `fallow`.
   Commit: `docs: mark Phase 2 step 4 complete in permission-system architecture`

## Risks and Mitigations

- Risk: the verbatim classifier split silently changes a rejection or acceptance branch.
  Mitigation: Step 1's unit tests encode current behavior before the move; the prelude is copied line-for-line into `rejectNonPathToken`; integration tests remain unmodified.
- Risk: the return-based conversion alters token order or breaks dedup.
  Mitigation: children are still visited left-to-right and spread in order; dedup stays in the (untouched) entry points; the deduplication and ordering integration tests cover this.
- Risk: a Biome/ESLint assertion loop on the directive type.
  Mitigation: the `consume-arg` variant carries a non-optional `nextArgAction`, so the `switch` narrows without `!` or `as`.
- Risk: a speculative export trips `fallow dead-code`.
  Mitigation: export only the two classifiers (imported by `bash-path-extractor.ts`); keep `rejectNonPathToken` and `classifyPatternCommandFlag` private.
- Risk: `collectRedirectTokens` reusing `ARG_NODE_TYPES` subtly changes the accepted set.
  Mitigation: the inline redirect set is exactly `["word","concatenation","string","raw_string"]`, identical to `ARG_NODE_TYPES`; verified before substitution.

## Open Questions

- Whether to additionally export and unit-test `classifyPatternCommandFlag`.
  Deferred: the per-command integration tests already cover its transitions, and exporting it solely for tests risks a `fallow` dead-export.
- Whether the new metrics warrant updating the roadmap's "Refactoring targets" count (currently 4) in the same `docs:` commit — confirm by running `fallow health --targets` after Step 3.

[#288]: https://github.com/gotgenes/pi-packages/issues/288
[#290]: https://github.com/gotgenes/pi-packages/issues/290
