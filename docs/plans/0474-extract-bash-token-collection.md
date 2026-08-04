---
issue: 474
issue_title: "pi-permission-system: extract bash token collection from bash-program.ts (Phase 6 Step 2)"
---

# Extract bash token collection from `bash-program.ts` (Phase 6 Step 2)

## Release Recommendation

**Release:** mid-batch — defer (batch "bash-program-decomposition"); confirm at ship time

This is Step 2 of the three-step bash-program decomposition track (Steps 1–3, [#473]/[#474]/[#475]).
The roadmap tags it `Release: batch "bash-program-decomposition"`, whose tail is Step 3 ([#475]).
Step 1 has already landed on `main` (commits `999dc52`/`02058e3`/`7626425`) with its release deferred; Step 2 lands the same way and ships together with Step 3.
All three commits are `refactor:` (non-bumping under `release-please-config.json`), so the batch produces no release until Step 3 carries a `feat:`/`fix:` commit — flagged for the Step 3 ship decision, not this one.

## Problem Statement

`bash-program.ts` is the package's #1 churn × complexity hotspot (1,143 LOC at Phase 5 close; 1,045 LOC after Step 1).
It mixes several concerns behind the `BashProgram` value object: argument/flag tokenization, command enumeration, and the `cd`-fold projection.
Argument and flag tokenization — deciding which tokens of a command are filesystem paths versus inline patterns/scripts (`sed`, `awk`, `grep`, `rg`, `sd`) — is a distinct concern from the `BashProgram` API.
It is the single largest cohesive block in the file (~350 LOC), so moving it is the biggest single reduction in the decomposition.

## Goals

- Extract the pattern-first command table, the flag classifier, and the token collectors into a focused `src/access-intent/bash/token-collection.ts`.
- Relocate the `ARG_NODE_TYPES` grammar set into `node-text.ts` (alongside its peer `SKIP_SUBTREE_TYPES`).
- Leave `bash-program.ts` importing the collectors it still drives from the cwd-projection walk.
- Pure lift-and-shift: no behavior change.
- Add direct unit tests for the newly-isolated collectors (a testability win the extraction enables).

This change is **not breaking** — it relocates private internals with no public-API, config, schema, or behavior change.

## Non-Goals

- Command enumeration (`collectCommands` / `collectCommandsInto` / substitution descent) and the `cd`-fold projection (`collectPathCandidates`, `walkCurrentShellSequence`, `walkPipeline`, `foldCd`, helpers) stay in `bash-program.ts` — that is Step 3 ([#475]).
- Relocating `bash-program.ts` itself out of `handlers/gates/` — Step 3.
- Renaming `extractCommandName` — it stays a bash-domain command-identity query under its current name (see Design Overview).
- Any change to the `PATTERN_FIRST_COMMANDS` contents, flag arity, or tokenization semantics.

## Background

After Step 1, `bash-program.ts` already imports two leaf modules from the seeded `src/access-intent/bash/` domain directory:

- `parser.ts` — `getParser`, exported `TSNode` type.
- `node-text.ts` — `resolveNodeText`, `SKIP_SUBTREE_TYPES`.

The block this step moves currently sits between the `BashProgram` class and the command-enumeration section.
It comprises (current line numbers in `src/handlers/gates/bash-program.ts`):

- `PatternCommandConfig` (interface) + `PATTERN_FIRST_COMMANDS` (table) — lines 238–337.
- `ARG_NODE_TYPES` (grammar node-type set) — lines 339–344.
- `extractCommandName` (command-node → basename query) — lines 346–357.
- `PatternCommandFlagDirective` (type) + `classifyPatternCommandFlag` — lines 369–401.
- `collectPatternCommandTokens` — lines 419–494.
- `collectGenericCommandTokens` — lines 497–533.
- `collectRedirectTokens` — lines 535–549.
- `collectCommandTokens` — lines 552–561.
- `collectPathCandidateTokens` — lines 573–584.
- The "Token classification is delegated to `bash-token-classification.ts`" note — lines 586–588.

An orphan `// ── AST walker ──` section header at line 234 (emptied when Step 1 removed the parser/node-text it labeled) sits directly above this block.

**Shared-dependency constraint (the crux of this extraction).**
Two symbols in the block are also used by code that stays behind (the cwd-projection that Step 3 extracts):

- `extractCommandName` — used by `collectCommandTokens` (moves) **and** `foldCd` (stays, line 973).
- `ARG_NODE_TYPES` — used by the collectors (move) **and** `cdLiteralTarget` (stays, line 996).

Neither can stay in `bash-program.ts`: `token-collection.ts` will import the collectors' dependencies, and if `extractCommandName`/`ARG_NODE_TYPES` stayed in `bash-program.ts` while `token-collection.ts` imported them, `bash-program.ts` would import the collectors back — a circular import.

Three collectors are consumed by the staying cwd-projection walk and so must be **exported** from the new module:

- `collectCommandTokens` — `walkForCandidates`, line 760.
- `collectRedirectTokens` — `foldPipelineFirstStage`, line 871.
- `collectPathCandidateTokens` — `walkForCandidates`/`walkPipeline`/`foldPipelineFirstStage`/`foldListExceptTerminal`, lines 785/844/881/909.

A repo-wide grep (`src/`, `test/`, `.pi/skills/package-pi-permission-system/SKILL.md`) confirms **no external consumer** references any moved symbol — the collectors are exercised only through `BashProgram`'s public slices.
The SKILL has no reference to these internals and needs no edit.

AGENTS.md / SKILL constraints that apply:

- `docs/architecture/architecture.md` carries a layout listing that names the affected modules — it must be updated (see Module-Level Changes).
- Mark the roadmap step complete (`✅` on the Step 2 heading **and** the Mermaid `S2` node) as part of this change once the code lands — do not defer the marker.

## Design Overview

### Layer the two shared symbols by meaning, not by mechanics

`extractCommandName` and `ARG_NODE_TYPES` are different *kinds* of thing, and they go to different homes:

- `ARG_NODE_TYPES` is **tree-sitter grammar mechanics** — "which node types are argument values," a direct peer of `SKIP_SUBTREE_TYPES`.
  It carries no bash-program meaning, so it sinks into `node-text.ts` alongside its peer.
- `extractCommandName` answers a **bash-program-domain** question — "what command is being invoked here?"
  That it is *implemented* by calling `resolveNodeText` + `basename` is incidental mechanics, not its identity.
  It belongs with the bash command-interpretation logic (`token-collection.ts`, whose `collectCommandTokens` is its primary consumer), and it keeps its name — a `resolve*` rename would falsely advertise it as a generic tree-sitter primitive and pull it toward the wrong layer.

This split is justified by layer, not convenience: it creates **no new module dependency edge**.
The staying cwd-projection already depends on `token-collection.ts` (for the three exported collectors) and on `node-text.ts` (for `SKIP_SUBTREE_TYPES`), so it simply imports `extractCommandName` and `ARG_NODE_TYPES` along edges that already exist.

### Module dependency graph after this step

```text
parser.ts ──┐
            ├─► token-collection.ts ──► bash-program.ts (BashProgram + enumeration + cwd-projection)
node-text.ts┘            ▲                     │
   (resolveNodeText,     └─────────────────────┘
    SKIP_SUBTREE_TYPES,        bash-program imports collectors + extractCommandName
    ARG_NODE_TYPES)            from token-collection; ARG_NODE_TYPES from node-text
```

`token-collection.ts` is a leaf-plus-one: it depends only on `parser.ts` and `node-text.ts`, never on `bash-program.ts`.
`bash-program.ts` depends on `token-collection.ts`.
No cycle.

### `token-collection.ts` public surface and call site

```typescript
// token-collection.ts — exported surface
export function extractCommandName(node: TSNode): string | undefined;
export function collectCommandTokens(node: TSNode): string[];
export function collectRedirectTokens(node: TSNode): string[];
export function collectPathCandidateTokens(node: TSNode): string[];
// private: PatternCommandConfig, PATTERN_FIRST_COMMANDS,
//          PatternCommandFlagDirective, classifyPatternCommandFlag,
//          collectPatternCommandTokens, collectGenericCommandTokens
```

The staying cwd-projection in `bash-program.ts` consumes them exactly as today (Tell-Don't-Ask: each takes a `TSNode` and returns a value; no shared mutable bag, no output arguments):

```typescript
// bash-program.ts — walkForCandidates (unchanged behavior)
case "command":
  tagTokens(collectCommandTokens(node), base, out);   // imported
  return foldCd(node, base);                           // foldCd calls extractCommandName (imported)
// ...
default:
  tagTokens(collectPathCandidateTokens(node), base, out); // imported
  return base;
```

### Design-review pass (extraction checklist)

- **Dependency width.**
  All four exported functions take a single `TSNode` and return `string[]` (or `string | undefined`).
  No options bag, no per-consumer field subset.
- **Law of Demeter / output arguments.**
  The collectors were already converted to return-based `string[]` (no accumulator output argument) by [#289]; this move carries that property forward unchanged.
- **Tell-Don't-Ask.**
  Walking a `TSNode` is intrinsic AST traversal, not a reach-through into a stranger collaborator.
- **Missing abstraction.**
  `token-collection.ts` is the cohesive concept (argument/flag tokenization); `extractCommandName` is its command-identity primitive; `ARG_NODE_TYPES` is a grammar primitive that belongs with `node-text.ts`'s existing grammar set.
  No new intermediate abstraction is warranted for a lift-and-shift.

No structural smells are introduced; the fixes are inline (this PR).

## Module-Level Changes

### `src/access-intent/bash/node-text.ts`

- **Add** `export const ARG_NODE_TYPES` (`new Set(["word", "concatenation", "string", "raw_string"])`) with a short doc comment, placed beside `SKIP_SUBTREE_TYPES`.

### `src/access-intent/bash/token-collection.ts` (new)

- **Add** the moved block: `PatternCommandConfig`, `PATTERN_FIRST_COMMANDS`, `extractCommandName`, `PatternCommandFlagDirective`, `classifyPatternCommandFlag`, `collectPatternCommandTokens`, `collectGenericCommandTokens`, `collectRedirectTokens`, `collectCommandTokens`, `collectPathCandidateTokens`.
- **Export** `extractCommandName`, `collectCommandTokens`, `collectRedirectTokens`, `collectPathCandidateTokens`; keep the rest private.
- **Imports**: `basename` from `node:path`; `type TSNode` from `#src/access-intent/bash/parser`; `resolveNodeText`, `SKIP_SUBTREE_TYPES`, `ARG_NODE_TYPES` from `#src/access-intent/bash/node-text`.
- Order the file per the stepdown rule: public collectors first, then the private helpers/table they call.

### `src/handlers/gates/bash-program.ts`

- **Remove** the moved block (lines 238–588) and the orphan `// ── AST walker ──` header (line 234), but **leave `ARG_NODE_TYPES`'s usage** at `cdLiteralTarget` (now imported).
- **Add** import: `{ collectCommandTokens, collectPathCandidateTokens, collectRedirectTokens, extractCommandName }` from `#src/access-intent/bash/token-collection`.
- **Update** the `node-text` import: drop now-unused `resolveNodeText` (every call site moved); keep `SKIP_SUBTREE_TYPES` (used by the staying walk at lines 805/836/898); add `ARG_NODE_TYPES`.
- **Update** the `node:path` import: drop `basename` (its only call site, `extractCommandName`, moved); keep `isAbsolute`, `join`, `resolve`.
- Keep `getParser` + `type TSNode` (`parser`) — both still used by the staying code.

### `docs/architecture/architecture.md`

- **Layout tree**: add a `token-collection.ts` entry under `access-intent/bash/`; update the `node-text.ts` entry to note it now also exports `ARG_NODE_TYPES`; update the `bash-program.ts` entry to note the collectors + `extractCommandName` are imported from `access-intent/bash/token-collection.ts` and `ARG_NODE_TYPES` from `access-intent/bash/node-text.ts`.
- **Steps**: mark Step 2 complete — `✅` on the `#### 2.` heading and on the Mermaid `S2` node.
- **Step 2 prose tidy**: the entry's prose names the target file `bash-token-collection.ts` while its bullet (and #475) name it `token-collection.ts`; correct the prose to `token-collection.ts` to match the actual filename.
  Note the `ARG_NODE_TYPES → node-text.ts` and `extractCommandName → token-collection.ts (kept name)` layering in the Step 2 entry so the roadmap reflects what shipped.

No `README.md`, schema, config, or `SKILL.md` change — none reference these internals or any user-facing command.
Historical references in `docs/plans/archive/`, prior plans, and retros are not edited.

## Test Impact Analysis

1. **New tests the extraction enables.**
   A new `test/token-collection.test.ts` can directly unit-test the collectors, which today are reachable only through `BashProgram`'s public slices:
   - `extractCommandName` — basename of `/usr/bin/sed` → `sed`; `undefined` for a variable-expansion command name.
   - `collectCommandTokens` dispatch — pattern-first command (`sed -e 's/x/y/' file.txt` collects `file.txt`, skips the script positional), generic command, `sd`'s two pattern positionals, `--` end-of-flags, arg-consuming vs file-consuming flags.
   - `collectRedirectTokens` — redirect-destination tokens from a `file_redirect` node.
   - `collectPathCandidateTokens` — skips `SKIP_SUBTREE_TYPES` subtrees (heredoc/comment), recurses into substitutions.

   These tests parse a command via `getParser()` and pass the resulting node, mirroring the Step 1 `node-text.test.ts` pattern.
   **Testability win**: `token-collection.ts` imports only `parser.ts` + `node-text.ts` (not `#src/canonicalize-path`), so its tests run without the canonicalize mock that any `bash-program.ts` importer needs (retro 0345) — the same isolation Step 1 gained.

2. **Tests that become redundant.**
   None.
   The existing bash suites (`test/bash-arity.test.ts`, `test/bash-external-directory.test.ts`, `test/detect-permissive-bash-fallback.test.ts`) exercise the collectors only *indirectly* through `BashProgram.externalPaths` / `pathRuleCandidates` / `commands`.
   The new unit tests are strictly lower-level; the integration tests remain the behavior-preservation net and are not simplified or removed here.

3. **Tests that must stay as-is.**
   All existing bash integration tests — they pin the end-to-end tokenization → policy behavior that this lift-and-shift must not change.

## Invariants at risk

This is a behavior-preserving lift-and-shift; the risk is a silent behavior change in tokenization or in the staying `cd`-fold walk.

- **Step 1 invariant** ([#473]): `bash-program.ts` imports the parser and node-text resolver; behavior unchanged.
  Adding `ARG_NODE_TYPES` to `node-text.ts` extends that module without altering `resolveNodeText`/`SKIP_SUBTREE_TYPES` — pinned by `test/node-text.test.ts` (parser/resolver behavior) and the bash integration suites.
- **Tokenization behavior** ([#289] decomposition, [#307] cwd-projection, [#454] redirect-then-pipe fold): the candidate set and order, and the projected effective base at each token, must be identical.
  Pinned by `test/bash-external-directory.test.ts`, `test/bash-arity.test.ts`, and `test/detect-permissive-bash-fallback.test.ts`.
  The invariant lives in tests, not only prose — run the full bash suite after the extraction commit, not just the new file.

No new test is required to protect an otherwise-unpinned invariant; run `pnpm run check` + the full suite after each cycle.

## TDD Order

1. **`refactor:` — move `ARG_NODE_TYPES` to `node-text.ts`.**
   Add the exported set (with doc comment) to `node-text.ts`; import it back into `bash-program.ts` and delete the local definition in the **same commit** (Biome `noRedeclare` / `noUnusedImports` gate the two-step add-then-remove order).
   The still-resident collectors and `cdLiteralTarget` reference the imported constant.
   Run `pnpm --filter @gotgenes/pi-permission-system run check` + the full package suite.
   Commit: `refactor(pi-permission-system): move ARG_NODE_TYPES grammar set to node-text.ts (#474)`.

2. **`refactor:` — extract the token collectors to `token-collection.ts` (atomic).**
   Write `test/token-collection.test.ts` first importing from `#src/access-intent/bash/token-collection` (red: module absent → `tsc`/import failure).
   Then create `token-collection.ts` with the moved block (exporting the four symbols), and in the **same commit** rewire `bash-program.ts`: add the `token-collection` import, remove the moved block + orphan `AST walker` header, drop the now-dead `basename` and `resolveNodeText` imports.
   Removing the local definitions and exporting from the new module must land together — `tsc` will not allow the export/removal and the consumer rewire in separate commits.
   Run `pnpm run check` + the full suite (green).
   Commit: `refactor(pi-permission-system): extract bash token collection to access-intent/bash/token-collection.ts (#474)`.

3. **`docs:` — record the extraction and mark the roadmap step complete.**
   Update `docs/architecture/architecture.md`: layout tree (`token-collection.ts` entry, `node-text.ts` `ARG_NODE_TYPES` note, `bash-program.ts` import note), `✅` on the Step 2 heading + Mermaid `S2` node, and the `bash-token-collection.ts` → `token-collection.ts` prose tidy with the layering note.
   Run `pnpm run lint` (rumdl).
   Commit: `docs(pi-permission-system): record token-collection extraction in architecture (#474)`.

The pre-completion-reviewer subagent runs after Cycle 3 per the `pre-completion` skill.

## Risks and Mitigations

- **Silent tokenization change.**
  Mitigation: pure relocation — no logic edits; the full bash integration suite (run after Cycles 1 and 2) pins the candidate set, order, and projected base.
- **Circular import between `bash-program.ts` and `token-collection.ts`.**
  Mitigation: `extractCommandName` moves *into* `token-collection.ts` (not left behind), so the dependency is strictly `bash-program → token-collection`, never back.
- **Dropped-import false green.**
  `tsc` does not error on a leftover unused `import type`, but `basename`/`resolveNodeText` are value imports — Biome `noUnusedImports` flags them, and the autoformatter runs after each edit.
  Mitigation: re-read the `bash-program.ts` import block after Cycle 2 and confirm `basename` and `resolveNodeText` are gone while `SKIP_SUBTREE_TYPES`/`ARG_NODE_TYPES`/`TSNode`/`getParser` remain.
- **LOC target.**
  Removing ~355 lines lands `bash-program.ts` at ~690 LOC — slightly above the roadmap's "≤ 670" estimate for this step, but the projection is approximate and the remainder clears in Step 3 (target ≤ 350).
  Not a blocker for a behavior-preserving move; note the actual figure in the retro.

## Open Questions

None.
The shared-symbol placement (the only design ambiguity) is resolved above: `ARG_NODE_TYPES` → `node-text.ts`, `extractCommandName` → `token-collection.ts` (name kept).
No follow-up issues are needed — command enumeration and cwd-projection extraction are already tracked by [#475].

[#289]: https://github.com/gotgenes/pi-packages/issues/289
[#307]: https://github.com/gotgenes/pi-packages/issues/307
[#454]: https://github.com/gotgenes/pi-packages/issues/454
[#473]: https://github.com/gotgenes/pi-packages/issues/473
[#474]: https://github.com/gotgenes/pi-packages/issues/474
[#475]: https://github.com/gotgenes/pi-packages/issues/475
