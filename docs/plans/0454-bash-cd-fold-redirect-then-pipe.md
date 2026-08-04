---
issue: 454
issue_title: "Bash external_directory gate: cd-fold projection drops the running directory across a redirect-then-pipe, causing false external-path prompts"
---

# Recover bash operator precedence so a `cd` fold persists across a redirect-then-pipe

## Release Recommendation

**Release:** ship independently

This is a standalone false-positive bug fix in `BashProgram.externalPaths`.
No architecture-roadmap step references [#454], so it belongs to no release batch and ships on its own.

## Problem Statement

The bash `external_directory` gate over-prompts on commands that never leave the working directory.
When an earlier `&&`-chained statement contains a redirect immediately followed by a pipe (`pnpm x 2>&1 | tail`), `BashProgram.externalPaths(cwd)` drops the running-directory fold contributed by a preceding current-shell `cd`.
A later `cd ..` then resolves against the original `cwd` instead of the folded directory, so the projection reports phantom paths one or more levels above where bash actually goes — and the gate prompts for external-directory access the real command never requests.

This is a false positive (over-prompting), not a bypass: the projection errs restrictive, so no gate is weakened.
But it surfaces a permission prompt for a command that stays entirely inside the working directory.

## Goals

- Fold a leading current-shell `cd` prefix across a redirect-then-pipe statement, so the running directory persists to following current-shell commands.
- Resolve the issue's five isolated reproductions to their expected outputs (the three currently-correct cases stay correct; the two buggy cases return `[]`).
- Preserve the fail-closed direction: the terminal piped command (the actual pipe stage, a subshell) must **not** fold, so a `cd` in that position still flags a later escaping path.
- This is a non-breaking bug fix (`fix:`): it removes false-positive external-path prompts; it changes no default, config, or output shape.

## Non-Goals

- No change to `pathRuleCandidates`, `commands()`, the `external_directory` gate descriptor, or any config/schema surface.
- No change to the deferred conservative tiers documented in #307 (interior `cd` folding inside command/process substitutions, subshell-interior leakage).
- No new general bash-precedence model beyond the redirect-then-pipe structural quirk this issue targets; true multi-stage pipelines (`A | B | C`) keep their subshell-per-stage semantics.

## Background

`BashProgram` (`src/handlers/gates/bash-program.ts`) parses a bash command once with tree-sitter-bash and projects a running effective working directory across the AST by folding current-shell `cd` commands (#307).
The walker is `walkForCandidates(node, base, out)`, which returns the `EffectiveBase` in force *after* a node.
Current-shell sequence containers (`program`, `list`, `redirected_statement`) route through `walkCurrentShellSequence`, which threads the fold left-to-right through children.
Everything else — `pipeline`, control-flow bodies, substitution interiors — falls into the `default` case, which collects tokens against the input `base` and returns `base` **unchanged** (no fold).

Returning `base` unchanged is correct for a *true* pipeline: each stage of `A | B | C` runs in a subshell, so a `cd` inside any stage must not leak.
The bug is a tree-sitter-bash grammar quirk interacting with that rule.

### The structural quirk (confirmed against the real parser and real bash)

In bash, `|` binds tighter than `&&`/`||`/`;`, so `cd a/b && pnpm x 2>&1 | tail` is `cd a/b && (pnpm x 2>&1 | tail)` — `cd a/b` runs in the current shell and folds.
Real `bash -c 'cd a/b && pwd 2>&1 | tail -1; echo after=$(pwd)'` confirms the shell ends in `a/b`.

But tree-sitter-bash mis-groups the redirect-bearing logical list into the pipeline's first stage:

```text
pipeline  «cd a/b && pnpm x 2>&1 | tail»
  redirected_statement  «cd a/b && pnpm x 2>&1»
    list  «cd a/b && pnpm x»
      command  «cd a/b»
      &&
      command  «pnpm x»
    file_redirect  «2>&1»
  |
  command  «tail»
```

The whole `cd a/b && pnpm x` list is buried inside the `pipeline`, which the walker treats as a non-folding subshell context — so the `cd a/b` fold is discarded.
Without the redirect, tree-sitter parses the same input as `list[command(cd a/b), &&, pipeline(pnpm x | tail)]`, where `cd a/b` is a direct list child and folds correctly — which is why `pnpm x | tail` (pipe, no redirect) and `pnpm x 2>&1` (redirect, no pipe) both already behave.

The redirect is the trigger: it wraps the `&&` list in a `redirected_statement` that becomes the pipe's left operand.

### Fail-closed boundary (also confirmed against real bash)

Only the **leading** commands of the first pipe stage fold.
The terminal command of that stage is the actual first pipe stage and runs in a subshell, so it must not fold.
Real `bash -c 'cd a/b && cd c 2>&1 | tail -1; echo after=$(pwd)'` ends in `a/b`, not `a/b/c` — the trailing `cd c` is the pipe stage and does not change the parent shell.
Folding it would under-flag a later escaping path, a fail-open regression the package forbids ("silent over-matching is a permission bypass").

## Design Overview

Add a `pipeline` case to `walkForCandidates` that recovers bash operator precedence for the first pipe stage, while keeping every downstream stage and the terminal piped command as non-folding subshells.

Decision model for a `pipeline` node, in source order:

1. The first named, non-skip child is the first pipe stage.
   - If it is a `list` or `redirected_statement` (the redirect-then-pipe quirk), fold its **leading** current-shell commands and collect — but do not fold — its **terminal** command (the real pipe stage); collect any redirect targets against the folded base.
   - If it is a bare `command` (a true pipeline first stage, e.g. `cd nested | cat ../b`), it is a subshell: collect its tokens, do not fold.
2. Every subsequent stage (after a `|`) is a downstream subshell stage: collect its tokens against the folded base, do not fold.
3. Return the folded base so it persists to following current-shell siblings (`; cd ..`).

The folded base is what fixes the bug; returning it (rather than the unchanged input `base`) lets `cd a/b` persist across the pipeline to the trailing `cd ..`.

### Effective-base flow sketch

For `cd a/b && pnpm x 2>&1 | tail ; cat ../b` with `cwd = /projects/my-app`:

```text
program → walkCurrentShellSequence
  pipeline → walkPipeline(base = cwd)
    first stage = redirected_statement → foldPipelineFirstStage
      inner list → foldListExceptTerminal
        cd a/b   → fold → cwd/a/b      (leading current-shell command)
        pnpm x   → collect, no fold    (terminal = the real pipe stage)
      file_redirect 2>&1 → no path token
    returns cwd/a/b
    | tail → downstream stage: collect against cwd/a/b, no fold
  returns cwd/a/b                       ← persists past the pipeline
  ; cat ../b → ../b against cwd/a/b = cwd/b (inside) → not flagged
externalPaths = []                      ✓
```

The new helpers each return an `EffectiveBase` (real behavior, not procedure-splitting): `walkPipeline` returns the post-pipeline base; `foldPipelineFirstStage` and `foldListExceptTerminal` return the base after folding the leading current-shell commands.

### Reproduction parity

All five isolated reproductions from the issue reach their expected output (verified by tracing the parse against the new walker):

| Command (suffix `; cd .. && cd ..` unless noted) | Today            | After |
| ------------------------------------------------ | ---------------- | ----- |
| `cd a/b && pnpm x \| tail`                       | `[]`             | `[]`  |
| `cd a/b && pnpm x 2>&1 \| tail`                  | phantom paths    | `[]`  |
| `cd a/b && pnpm x 2>&1`                          | `[]`             | `[]`  |
| `cd a/b && pnpm x 2>&1 \| tail ; cd ..`          | one phantom path | `[]`  |
| `cd a/b ; cd .. && cd ..`                        | `[]`             | `[]`  |

## Module-Level Changes

- `src/handlers/gates/bash-program.ts`
  - Add `case "pipeline": return walkPipeline(node, base, out);` to `walkForCandidates`.
  - Add `walkPipeline(node, base, out): EffectiveBase` — iterate the pipeline's named, non-skip children; route the first stage through `foldPipelineFirstStage`; collect each downstream stage's tokens (`collectPathCandidateTokens`) against the folded base without folding; return the folded base.
  - Add `foldPipelineFirstStage(node, base, out): EffectiveBase` — `list`/`redirected_statement` route to the leading-fold logic (recursing into a `redirected_statement`'s inner statement and collecting its redirect targets via the existing `collectRedirectTokens` path); a bare `command` (or any other node) collects tokens and returns `base` unchanged.
  - Add `foldListExceptTerminal(node, base, out): EffectiveBase` — fold every named, non-skip child except the last via `walkForCandidates`; collect the terminal child's tokens without folding; return the folded base.
  - Update the `externalPaths` doc comment to note the redirect-then-pipe precedence recovery alongside the existing subshell/pipeline/backgrounded-command scoping notes.
- `docs/architecture/architecture.md`
  - Extend the `bash-program.ts` `externalPaths` description (the "scoping subshells / pipelines / backgrounded commands" clause) to mention recovering bash operator precedence so a leading current-shell `cd` folds across a redirect-then-pipe that tree-sitter mis-groups ([#454]).

No exported symbol is added, renamed, or removed (`externalPaths(cwd): string[]` is unchanged), so no consumer, test import, or `SKILL.md` reference needs updating.
The new functions are private helpers in the same file, per the stepdown rule (placed below `walkCurrentShellSequence`).

## Test Impact Analysis

This is a behavior fix, not an extraction, so no existing test becomes redundant and none is removed.

- **New unit tests enabled** — `externalPaths` projection cases for the redirect-then-pipe shape, which the current walker gets wrong:
  - fold persistence across a redirect-then-pipe (the primary bug);
  - the trailing-`cd` reproduction from the issue (the fold must survive to a later `cd ..`);
  - the fail-closed terminal-`cd` case (a `cd` as the pipe stage does not fold, so a later escape is still flagged);
  - a downstream stage's relative token resolving against the folded base.
- **Existing tests that must stay as-is** — the projection suite in `bash-program.test.ts` genuinely exercises the walker being changed; in particular `"does not fold a cd inside a pipeline"` (`cd nested | cat ../b`) pins the true-pipeline first-stage subshell semantics the new `pipeline` case must preserve.
- **No redundant tests** — the new lower-level cases cover a structure (`redirected_statement` inside a `pipeline`) no existing case reaches.

## Invariants at risk

- **#452 A3 — never-weaker (`bash-command-metamorphic.test.ts`)** — that property pins the bash *command* gate (`resolveBashCommandCheck` over `commands()`), a different slice than `externalPaths`.
  This change touches only `externalPaths` (the `external_directory` gate), and the metamorphic wrappings use no redirect-then-pipe, so the property is untouched.
  No edit to that test is needed.
- **#307 / #418 — fail-closed external-directory projection** — removing false positives must not introduce a fail-open.
  The terminal-`cd` test (a `cd` in the pipe-stage position still flags a later escaping relative path) pins the fail-closed direction directly; without it the leading-fold change could silently fold the pipe-stage `cd` and under-flag.

## TDD Order

1. **Red → Green — fold a leading `cd` across a redirect-then-pipe.**
   In `bash-program.test.ts`, under `describe("effective working directory projection")`, add cases (`cwd = "/projects/my-app"`):
   - `"folds a leading current-shell cd across a redirect-then-pipe"` — `cd a && pnpm x 2>&1 | tail ; cat ../b` ⇒ `externalPaths` length 0 (without the fix the base resets to `cwd` and `../b` flags `/projects/b`).
   - `"persists the fold past a redirect-then-pipe to a later cd"` (the issue reproduction) — `cd a/b && pnpm x 2>&1 | tail ; cd .. && cd ..` ⇒ length 0.
   - `"does not fold the terminal piped command of the first stage"` (fail-closed) — `cd a && cd b 2>&1 | tail ; cat ../../x` ⇒ contains `/projects/x` (the pipe-stage `cd b` must not fold; with the correct base `cwd/a`, `../../x` escapes).
   - `"resolves a downstream pipe stage against the folded base"` — `cd a && pnpm x 2>&1 | cat foo` ⇒ length 0 (`foo` against `cwd/a`).
   Then implement `walkPipeline` / `foldPipelineFirstStage` / `foldListExceptTerminal` and wire the `pipeline` case in `walkForCandidates`; update the `externalPaths` doc comment.
   Run the full `bash-program.test.ts` suite to confirm the existing `"does not fold a cd inside a pipeline"` case still passes.
   Commit `fix(pi-permission-system): fold cd across redirect-then-pipe in external-directory projection` with a `Refs #454` footer (blank line before it).

2. **Docs — architecture narrative.**
   Update the `bash-program.ts` `externalPaths` line in `docs/architecture/architecture.md` to mention recovering bash operator precedence across a redirect-then-pipe ([#454]); add the `[#454]` reference-link definition if absent.
   Commit `docs(pi-permission-system): note redirect-then-pipe cd-fold recovery in architecture`.

Run `pnpm --filter @gotgenes/pi-permission-system exec vitest run` and `pnpm run check` after step 1.

## Risks and Mitigations

- **Under-flag regression (fail-open).**
  Folding the terminal piped `cd` would resolve a later relative path against the wrong base and miss an escape.
  Mitigation: `foldListExceptTerminal` excludes the terminal command from folding; the fail-closed terminal-`cd` test pins it.
- **Breaking a true pipeline's subshell semantics.**
  A bare-`command` first stage (`cd nested | cat ../b`) must keep not folding.
  Mitigation: `foldPipelineFirstStage` folds only `list`/`redirected_statement` first stages; the existing `"does not fold a cd inside a pipeline"` test guards the bare-command path.
- **Tree-shape assumptions.**
  The fix relies on the observed `pipeline → redirected_statement → list` grouping.
  Mitigation: the AST was dumped from the bundled tree-sitter-bash and the bash semantics confirmed with `bash -c`; the helper falls back to the safe non-folding `default` behavior for any first-stage shape that is neither `list` nor `redirected_statement`.

## Open Questions

- Whether to also fold interior `cd`s of a downstream pipe stage's own subshell — deferred; out of scope and already covered by the #307 conservative-tier deferral.

[#454]: https://github.com/gotgenes/pi-packages/issues/454
