---
issue: 304
issue_title: "Consolidate bash command analysis behind a single parsed representation and a candidate-combination helper"
---

# Retro: #304 — Consolidate bash command analysis

## Stage: Planning (2026-06-01T20:26:00Z)

### Session summary

Issue #304 was created during the planning session for #301 in response to the question "what architectural changes would make this easier?".
While planning the #301 bash command-chain fix, the friction analysis surfaced two structural gaps in the bash permission path: no shared parsed-bash representation (three independent tree-sitter parses) and a duplicated most-restrictive candidate-selection loop across the two bash gates.
The owner chose Beck-style "refactor first, then a trivial fix", so #304 captures the behavior-preserving enabler and #301 becomes a follow-up that builds on it.

### Observations

- Scope was deliberately trimmed from the issue's high-level framing.
  The issue text mentioned a dual-strategy combinator (`first-non-default` / `most-restrictive`); the plan narrows #2 to a result-level `pickMostRestrictive` only, because `first-non-default` lives at the rule level (`evaluateFirst`) one layer below and merging the two layers is out of scope.
  Adding an unused strategy parameter would be a speculative export (fallow would flag it).
- The two bash gates share a most-restrictive core but wrap it in different filters — the path gate's #58 backward-compat ("token matching only the universal default is unrestricted") plus session-coverage, and the external-directory gate's "uncovered = `state !== allow`".
  So `pickMostRestrictive` is the right shared seam; the filters stay gate-specific.
  The external-directory gate is a clean drop-in; the path gate needs care to preserve #58 and loses its deny short-circuit (output-identical, slightly more in-memory `checkPermission` calls).
- `BashProgram` (#1) is honestly the lower-leverage of the two enablers near-term: the two extractors already share the AST walker, so #1's win is cohesion and an extensible seam for #301, not fewer parses.
  Parse-once-and-inject across gates was deferred — it changes gate signatures and drifts into the deferred gate-consolidation enabler (#4).
- Kept the existing extractor exports (`extractTokensForPathRules`, `extractExternalPathsFromBashCommand`) as thin facades over `BashProgram` specifically to avoid rewriting the 900-line `test/bash-external-directory.test.ts` (lift-and-shift / large-test-file rule).
- Risk flagged: moving the parse/walk primitives into `bash-program.ts` to avoid a circular import is the largest single edit; it is mechanical and gated by the unchanged extractor suite + `pnpm run check`.
- Labels available are coarse (no `refactor`/`tech-debt`); filed as `enhancement` + `pkg:pi-permission-system`.

### Diagnostic details

- **Feedback-loop gap analysis** — Two steps (path-gate refactor; cross-module primitive move) are explicitly paired with `pnpm run check` in the plan because they are behavior-preserving moves that the type checker, not the test suite alone, will catch first.

## Stage: Implementation — TDD (2026-06-01T20:46:09Z)

### Session summary

Executed all four planned steps as behavior-preserving refactors: extracted `pickMostRestrictive` (`candidate-check.ts`) and migrated both bash gates onto it, introduced the `BashProgram` value object (`bash-program.ts`) owning the tree-sitter primitives with the old extractors reduced to thin facades, and updated the architecture directory listing.
Test count went from 1674 to 1686 (+12: six `pickMostRestrictive` cases, six `BashProgram` cases); the 900-line extractor suite and both bash-gate suites stayed green unchanged, confirming behavior preservation.

### Observations

- Pre-completion reviewer: PASS.
- Reviewer warnings (all non-blocking, left as-is):
  - `bash-path.ts` recovers the worst token by reference identity (`uncovered.find(({ check }) => check === worstCheck)`) after `pickMostRestrictive(uncovered.map(({ check }) => check))`.
    Correct because `.map()` does not clone; kept the helper checks-only since that is the shared seam with the external-directory gate.
  - `bash-external-directory.ts` ends with `pickMostRestrictive(...) ?? uncoveredEntries[0].check`; the fallback is logically unreachable (the empty case returns earlier) but is required because `pickMostRestrictive` returns `PermissionCheckResult | undefined` and the type checker needs the narrowing.
  - `bash-program.ts` places the tree-sitter bootstrap (`getParser` etc.) above the exported `BashProgram` class; all declarations hoist so ordering is safe.
- Baseline was not clean: a pre-existing `MD053` lint failure in the `0301` plan (a self-referential `[#301]:` link definition left by the prior planning session) was fixed first as `docs: remove self-referential issue link from #301 plan`.
- Fallow false positive: `BashProgram`'s private constructor + static `parse()` factory defeats fallow's syntactic-only analysis (no compiler), so it reports `pathTokens`/`externalPaths` as unused class members.
  Suppressed with `// fallow-ignore-next-line unused-class-member` (note: the inline issue kind is singular `unused-class-member`, even though the `.fallowrc.json` rule key is plural `unused-class-members`; the suppression line must contain only the kind — trailing prose is parsed as bogus issue kinds).
  This suppression landed as its own `refactor:` commit rather than in the trailing `docs:` commit.
- No deviations from the plan's Module-Level Changes; `v3-architecture.md` was reviewed and correctly left unchanged (historical pre-refactor narrative, does not enumerate current gate modules).
- This unblocks #301, which can now add `BashProgram.topLevelCommands()` plus a bash command gate selecting with `pickMostRestrictive`.
