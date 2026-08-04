---
issue: 476
issue_title: "pi-permission-system: introduce the AccessPath value object (Phase 6 Step 4)"
---

# Retro: #476 — introduce the AccessPath value object (Phase 6 Step 4)

## Stage: Planning (2026-06-25T00:00:00Z)

### Session summary

Planned Phase 6 Step 4: a new `AccessPath` value object (`src/access-intent/access-path.ts`) holding a path's lexical and canonical forms behind `matchValues()` / `boundaryValue()` / `value()` accessors, making the [#418] match-vs-boundary conflation a compile error.
Both external-directory gates and `BashProgram.externalPaths()` route through it; `getExternalDirectoryPolicyValues` is folded into `matchValues()` and removed, while `canonicalNormalizePathForComparison` is retained as the shared boundary primitive.
Three TDD steps, behavior-preserving, release deferred to the batch tail (Step 5, [#477]).

### Observations

- **Two design forks resolved via `ask_user`** (operator's own roadmap issue): (1) **accessors-only** `AccessPath` (not a boundary-decision method) — confirmed as the representation to carry forward, with the gate/boundary consolidation deferred to Step 5; (2) **retain** `canonicalNormalizePathForComparison` as a shared primitive rather than force-removing it (it is still used by `isPathOutsideWorkingDirectory` on both path and cwd, so removal would drag boundary logic into Step 4 and overlap [#477]).
- **The issue's literal `BashProgram.externalPaths(cwd)` is stale** — Step 3 ([#475]) already made it the parameter-free `externalPaths()` getter (cwd supplied at `parse()`).
  The plan retypes the return element only (`string` → `AccessPath`), preserving the born-ready shape.
- **Win32 trap flagged** — the factory must recompute the canonical via `canonicalNormalizePathForComparison` (which lowercases on win32, [#382]), not reuse `cwd-projection.ts`'s raw `canonicalizePath` output (which skips lowercasing).
  Captured as an invariant + risk.
- **Dead-code / type-checker coupling drove the 2-code-step split**: `AccessPath` must land with its first consumer (single-tool gate) in step 1, and `getExternalDirectoryPolicyValues`'s removal must ride with its last consumer's migration (bash gate) in step 2 — both forced by `fallow dead-code` + `tsc`.
- **Test churn contained by lift-and-shift**: the ~90-assertion `bash-external-directory.test.ts` is left untouched by keeping the `extractExternalPathsFromBashCommand` facade's `string[]` contract (map `.value()`); only `program.test.ts` (~25 sites) adapts to `.value()`.
- **No follow-ups filed** — Steps 5–8 already exist as [#477]–#480; all deferred work maps to them.

[#382]: https://github.com/gotgenes/pi-packages/issues/382
[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#475]: https://github.com/gotgenes/pi-packages/issues/475
[#477]: https://github.com/gotgenes/pi-packages/issues/477

## Stage: Implementation — TDD (2026-06-26T14:00:00Z)

### Session summary

All three TDD steps completed: introduced `AccessPath` value object and wired the single-tool gate (step 1); retypecd `BashProgram.externalPaths()` to `AccessPath[]`, routed the bash gate, and removed `getExternalDirectoryPolicyValues` in one atomic commit (step 2); updated `architecture.md` (step 3).
Test count rose from 2104 to 2111 (+7 net: 10 new `access-path.test.ts` tests minus the 3 migrated `getExternalDirectoryPolicyValues` cases).
Pre-completion reviewer returned **WARN** with two stale `architecture.md` entries; both fixed before writing this note.

### Observations

- **`pi-autoformat` reflowed `path-utils.test.ts`** after the describe-block removal, causing the orphaned `getExternalDirectoryPolicyValues` import to survive a first edit attempt — required a second targeted `Edit` to remove it after re-reading the file.
- **Atomic step 2 constraint held exactly as planned**: `tsc` coupling (`externalPaths(): string[]` → `AccessPath[]` cascade) and `fallow dead-code` coupling (`getExternalDirectoryPolicyValues` removal tied to its last consumer) forced all five production-file edits and four test-file adaptations into a single commit — no opportunity to split further.
- **WARN findings**: reviewer flagged two `architecture.md` stale references — (1) the `path-utils.ts` tree-listing still mentioned `getExternalDirectoryPolicyValues` after the step 3 docs commit; (2) the "Remaining design work" narrative described the `externalPaths(): string[]` conflation in present tense after it was resolved.
  Both fixed by amending the docs commit before writing this note.
- **Pre-completion reviewer verdict**: WARN (fixed inline — no unresolved findings at close).

## Stage: Final Retrospective (2026-06-26T16:00:00Z)

### Session summary

Shipped Phase 6 Step 4 across one continuous session spanning plan → TDD → ship → retro: pushed four implementation commits, CI green, closed issue #476, and held release-please PR #485 open per the plan's `mid-batch — defer` marker (batch "access-path-unification", tail is Step 5 / [#477]).
The implementation was clean and behavior-preserving (2104 → 2111 tests); the only rework was a one-amend fix for two stale `architecture.md` references the pre-completion reviewer flagged as WARN.

### Observations

#### What went well

- **`ask_user` gated both reversible decisions cleanly** — the planning design forks (accessors-only `AccessPath`; retain `canonicalNormalizePathForComparison`) and the ship-time `mid-batch — defer` release decision were each a single focused question with the recorded answer driving the work.
  No re-asking, no drift.
- **Incremental `pnpm run check` caught the atomic-batch drop immediately** — when the multi-edit on `path-utils.test.ts` was rejected (one `oldText` failed to match after a `pi-autoformat` reflow) and silently dropped the import-removal half, the post-edit `check` surfaced the orphaned import as `TS2305` before it could reach a commit.
  The documented "re-apply every intended edit, then run `pnpm run check`" recovery worked exactly as written.
- **The plan's coupling predictions held precisely** — `tsc` + `fallow dead-code` forced the `externalPaths(): string[]` → `AccessPath[]` cascade and the `getExternalDirectoryPolicyValues` removal into one atomic commit, exactly as the plan's TDD Order anticipated.
  No mid-step surprises.

#### What caused friction (agent side)

- `missing-context` — the plan's Module-Level Changes enumerated only three `architecture.md` edits (the `program.ts` tree line, the new `access-path.ts` entry, the ✅ markers), so the TDD step-3 docs commit missed two further stale references: `getExternalDirectoryPolicyValues` in the `path-utils.ts` tree line and the `externalPaths(): string[]` conflation described in present tense in the "Remaining design work" narrative.
  The planning grep had surfaced both lines but the plan did not convert them into doc-update action items.
  Impact: one pre-completion WARN and one `git commit --amend` to fix; caught by the reviewer, not by the implementer.
  No push or release rework (not yet pushed at the time).

#### What caused friction (user side)

- None.
  The two `ask_user` gates were the right interventions at the right moments; no earlier context would have changed the outcome.

### Diagnostic details

- **Feedback-loop gap analysis** — the architecture-doc staleness had no automated gate: `pnpm run check`/`test`/`lint` all stayed green with the stale prose, and only the pre-completion reviewer's doc-staleness lens caught it.
  This is the single verification gap of the session and maps directly to the proposed `plan-issue.md` grep extension.
  All code-level verification ran incrementally (per-file `vitest`, `check` after each interface change, `fallow dead-code` before the atomic commit).
- **Model-performance correlation** — one subagent dispatch (the `pre-completion-reviewer`) ran on its frontmatter model and produced a correctly-scoped judgment-heavy review (it caught the doc-staleness WARN).
  The session's transient `model_change` selections (`deepseek-v4-flash`, `glm-5.2`, `kimi-k2.6`) carried no attributed assistant turns.
  No mismatch.
- **Escalation-delay / unused-tool lenses** — nothing notable: no `rabbit-hole`, no sequence over five tool calls on one error, no point where an un-dispatched subagent or tool would have helped.

### Proposed follow-up

Extend the removed-symbol grep guidance in `.pi/prompts/plan-issue.md` (Module-Level Changes) to name `packages/<PKG>/docs/architecture/` alongside `src/`, `test/`, and `SKILL.md`, noting that architecture docs name internal symbols in narrative prose (`Remaining design work`, `Target:`), not only tree listings — the seam this session's WARN fell through.

### Changes made

1. `.pi/prompts/plan-issue.md` — extended the removed-symbol grep rule (Module-Level Changes) to add `packages/<PKG>/docs/architecture/` to the grep targets (alongside `src/`, `test/`, and `SKILL.md`), with a parenthetical noting architecture docs name internal symbols in narrative prose, not only tree listings (`Refs #476`).
