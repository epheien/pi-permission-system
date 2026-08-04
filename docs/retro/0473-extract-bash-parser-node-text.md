---
issue: 473
issue_title: "pi-permission-system: extract the tree-sitter parser and AST node-text resolver from bash-program.ts (Phase 6 Step 1)"
---

# Retro: #473 — Extract the tree-sitter parser and AST node-text resolver from `bash-program.ts`

## Stage: Planning (2026-06-25T00:00:00Z)

### Session summary

Produced a three-cycle plan for Phase 6 Step 1: lift the lazy tree-sitter parser (`getParser`, `TSNode`, `TSParser`, `initParser`) into `src/access-intent/bash/parser.ts` and the quote-aware node-text resolver (`resolveNodeText`, `SKIP_SUBTREE_TYPES`) into `src/access-intent/bash/node-text.ts`, leaving `bash-program.ts` importing both.
Pure lift-and-shift, non-breaking; the plan seeds the package's first domain directory and adds the unit tests the extraction newly enables.

### Observations

- Verified the extraction is legitimate SRP decomposition, not metric-gaming procedure-splitting: the parser **owns state** (memoized singleton + retry semantics) and `resolveNodeText` **returns a value** (pure AST transform), both leaf utilities with zero dependency on the rest of the file.
- `TSNode` must be **exported** from `parser.ts` (used pervasively in `bash-program.ts` and by `node-text.ts`); `TSParser` and `initParser` stay **private** to avoid a fallow dead-code flag for an export with no importer.
- `SKIP_SUBTREE_TYPES` is not used by `resolveNodeText` itself — it is consumed by walkers that stay in `bash-program.ts` — but per the issue it moves into `node-text.ts` and is imported back.
- `createRequire` (`node:module`) and `memoizeAsyncWithRetry` (`#src/async-cache`) are used only by the parser block (grep-verified), so both imports become dead in `bash-program.ts` after Cycle 1 and must be removed in the same commit.
- Testability win: neither new module imports `#src/canonicalize-path`, so their unit tests skip the canonicalize mock that any test transitively importing `bash-program.ts` needs (retro 0345).
- Doc/skill staleness enumerated: `docs/architecture/architecture.md` layout tree + `async-cache.ts` line, and `.pi/skills/package-pi-permission-system/SKILL.md` jiti note all name the parser's old home and need updating (Cycle 3).
- Commit type is `refactor:` (behavior-preserving).
  Flagged for the Step 3 ship decision: `refactor` is `hidden`/non-bumping under `release-please-config.json`, so the all-`refactor:` batch "bash-program-decomposition" produces no release unless Step 3 carries a `feat:`/`fix:` commit.
- Release marker: mid-batch — defer (batch "bash-program-decomposition", tail = Step 3 [#475]).
- Skipped the `ask-user` gate: operator's own issue, unambiguous proposal with exact line targets and target paths.

## Stage: Implementation — TDD (2026-06-25T11:23:00Z)

### Session summary

Completed all three planned TDD cycles: extracted the tree-sitter parser block to `src/access-intent/bash/parser.ts` (Cycle 1), extracted the node-text resolver and `SKIP_SUBTREE_TYPES` to `src/access-intent/bash/node-text.ts` (Cycle 2), and updated `docs/architecture/architecture.md` plus `.pi/skills/package-pi-permission-system/SKILL.md` (Cycle 3).
`bash-program.ts` dropped from 1,143 → 1,045 LOC; test count rose from 2,069 (98 files) to 2,086 (100 files) with 17 new tests across 2 new files.

### Observations

- Cycle 1 removed the `createRequire` and `memoizeAsyncWithRetry` imports from `bash-program.ts` in the same commit — confirmed dead by prior grep; the autoformatter's `noUnusedImports` check validated the removal immediately.
- The import-then-delete order (add new import, autoformat fires `noRedeclare`, then remove old definitions) was the correct two-step sequence given how `pi-autoformat` runs after each edit; the intermediate lint error from `noRedeclare` resolved cleanly once the old block was removed.
- Autoformatter reordered the new imports in `bash-program.ts` alphabetically (`node-text` before `parser`), which is fine — both use the `#src/access-intent/bash/` alias.
- `SKIP_SUBTREE_TYPES` in `node-text.ts` was reformatted from a single-line `new Set([...])` to a multi-line form by the autoformatter; content preserved, no behavior change.
- Pre-completion reviewer: WARN (non-blocking).
  - Reviewer warnings: (1) Mermaid diagram node `S1` was missing `✅` — the heading carried it but AGENTS.md requires both; fixed by amending the docs commit; (2) `node-text.test.ts` had two Biome `noTemplateCurlyInString` warnings for the intentional literal `"${VAR}"` strings — fixed with a `biome-ignore` comment; both resolved before writing stage notes.
- `bash-program.ts` LOC fell 98 lines (1,143 → 1,045), slightly more than the plan's ~120 projection because the decorative `// ── AST walker ──` section header was also removed when the walker block emptied.
- No deviations from the plan's Module-Level Changes list.

## Stage: Final Retrospective (2026-06-25T15:35:54Z)

### Session summary

Shipped Phase 6 Step 1 end-to-end in a single conversation spanning four stages (plan → TDD → ship → retro): a behavior-preserving lift-and-shift of the tree-sitter parser and node-text resolver into `src/access-intent/bash/`, seeding the package's first domain directory.
`bash-program.ts` dropped 1,143 → 1,045 LOC; +17 tests across 2 new files; CI green; release deferred per the mid-batch marker.
The execution was clean — the only reviewer findings were two minor doc/test-authoring gaps, both fixed before shipping.

### Observations

#### What went well

- The plan's explicit "import-then-delete" sequencing plus grep-verified dead-import removal made Cycles 1 and 2 mechanical; the autoformatter's `noRedeclare` / `noUnusedImports` checks acted as an immediate correctness gate the moment the old block lingered.
- The plan's Test Impact Analysis correctly predicted the testability win: neither new module pulls in `#src/canonicalize-path`, so `node-text.test.ts` runs in isolation without the canonicalize mock that any `bash-program.ts` importer needs (retro 0345).
- The pre-completion reviewer caught the Mermaid `✅` gap that both planning and implementation missed — the fresh-context backstop worked exactly as designed.
- Verification was incremental throughout: `pnpm run check` + per-file `vitest` after each cycle, then full suite + lint + `fallow dead-code` before the reviewer.
  No end-only verification gap.

#### What caused friction (agent side)

- `instruction-violation` (reviewer-caught) — the plan's Cycle 3 said "append `✓ complete` to the roadmap Step 1 heading line," missing the Mermaid diagram node and using the wrong marker (`✓ complete` vs `✅`).
  Root cause: the `package-pi-permission-system` skill (line 21) says "append `✓ complete` to the step line," which is inconsistent with `tdd-plan.md` step 7 ("prefix `✅` on both the step heading and its Mermaid diagram node"); planning followed the skill.
  Impact: one extra fix + a commit amend; no rework beyond that.
- `other` (edit construction) — the first Cycle 3 architecture-doc edit batch failed with "edits overlap" because it tried to flip the `bash-token-classification.ts` tree connector (`├──`→`└──`) unnecessarily alongside the `bash-program.ts` description edit.
  Impact: one rejected batch + one re-read; corrected by dropping the spurious connector change.
- `other` (tool mechanics) — the Cycle 2 import-then-delete two-step surfaced intermediate `noRedeclare` / `noUnusedImports` errors after the import was added but before the old definitions were removed.
  Anticipated and handled, but it generated error noise mid-cycle.
  Impact: a few extra tool calls; inherent to how `pi-autoformat` runs after each `Edit`.
- `missing-context` (minor) — planning used the wrong absolute path (`/Users/chris/development/pi/pi-permission-system/...`, dropping `pi-packages/packages/`) for one `read`, hitting an external-directory denial; self-corrected on the next call.
  Impact: one wasted tool call.
- `other` (markdown-conventions) — the plan was first drafted with a bracketed `[#473]` self-reference (violating MD052/MD053); self-caught, but the corrective edit batch failed to match on the first try and took ~3 grep/read calls to reapply.
  Impact: ~4 extra tool calls, no content rework.

#### What caused friction (user side)

- None.
  The two user interjections ("Continue." and "Are we ready for ship-issue?") were lightweight oversight checkpoints, not corrections; the flow was largely autonomous and no earlier-context opportunity was missed.

### Diagnostic details

- **Model-performance correlation** — Planning ran on `claude-opus-4-8` (judgment-appropriate), TDD on `claude-sonnet-4-6` (implementation-appropriate), and Ship on `opencode-go/deepseek-v4-flash`.
  The ship stage's stacked-release analysis (release-please `exclude-paths` + component-mapping reasoning) is judgment-heavy; the flash model spent 7 exploratory `grep` calls on `release-please-config.json` reaching a correct but meandering conclusion (the defer decision and stacked-release note were both accurate).
  Mild mismatch — a stronger model would have been more direct — but no rework resulted.
- **Escalation-delay tracking** — no `rabbit-hole`; no sequence exceeded 5 consecutive tool calls on the same error.
  The longest single-task run was the ship stacked-release investigation (7 grep calls), which was exploration, not stuck-on-an-error.
- **Unused-tool detection** — no `missing-context` friction warranted a subagent; the touched code was small and already understood from planning.
- **Feedback-loop gap analysis** — none; verification was incremental after every cycle, not deferred to the end.

### Changes made

1. `.pi/skills/package-pi-permission-system/SKILL.md` — de-duplicated the roadmap-completion instruction: removed the stale `✓ complete`-on-the-step-line restatement and pointed it at the canonical completion-marker convention in the implementation prompts (`✅` on both the step heading and its Mermaid diagram node), keeping only the package-specific "mark during shipping, do not defer" nuance.
   Root cause of the original reviewer WARN: the skill's wording conflicted with `tdd-plan.md` step 7, and planning followed the skill.
2. `packages/pi-permission-system/docs/retro/0473-extract-bash-parser-node-text.md` — added this Final Retrospective stage entry.
