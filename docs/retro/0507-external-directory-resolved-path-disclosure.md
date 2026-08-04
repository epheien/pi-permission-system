---
issue: 507
issue_title: "fix(pi-permission-system): external-directory prompt shows the typed path, not the resolved path that triggered the gate"
---

# Retro: #507 — external-directory prompt shows the typed path, not the resolved path that triggered the gate

## Stage: Planning (2026-06-30T00:00:00Z)

### Session summary

Planned a message-clarity fix that discloses the resolved (canonical, symlink-followed) path in the external-directory prompt and denial messages as `(resolves to '<canonical>')`, shown only when it differs from the typed path.
The plan adds an `AccessPath.resolvedAlias()` accessor as the single home for the lexical-vs-canonical comparison, a shared `resolvesToSuffix` helper plus `ExternalPathDisclosure` type in `denial-messages.ts`, and threads the resolved form through both gates into all external-directory message variants.
Filed as `packages/pi-permission-system/docs/plans/0507-external-directory-resolved-path-disclosure.md`; four TDD cycles, `Release: ship independently`.

### Observations

- Scope decision (via `ask_user`): the operator chose to cover **all** external-directory message variants (ask + deny + no-UI + user-denied), not just the four call sites the issue named — the `buildUnavailableBody` external_directory body carries the identical "inside path called outside working directory" contradiction, and once `resolvedPath` is in `DenialContext` the marginal cost is ~2 lines each.
- The comparison must be `value()` (lexical absolute) vs `boundaryValue()` (canonical absolute), **not** the raw typed relative string vs canonical — the typed string is relative and would always differ.
  Encapsulated on `AccessPath` as `resolvedAlias()`.
- Both lexical and canonical forms are win32-lowercased (`path-normalization.ts`), so a case-only Windows difference yields no spurious disclosure; `canonicalizePath` returns its input unchanged for non-symlink/unresolvable paths, so `resolvedAlias()` is `undefined` exactly when there is no distinct target.
- Non-breaking: message builders and `DenialContext` are internal (not exported from `index.ts`); gating decisions, review-log values, and session-approval patterns are unchanged.
  Kept all commits `fix:` (including the internal `resolvedAlias()` enabler) so the issue ships as one patch, not a minor bump.
- Type coupling drove the cycle boundaries: changing `DenialContext.bash_external_directory.externalPaths` to `ExternalPathDisclosure[]` breaks its sole producer + consumer + inline test constructions together, so the bash prompt/denial/gate/tests land in one commit.
- Not a roadmap step (Phase 7 complete); surfaced while investigating #493 (closed — the bypass concern was already handled by dual-match).

## Stage: Implementation — TDD (2026-06-30T20:36:00Z)

### Session summary

Implemented all four TDD cycles from the plan: added `AccessPath.resolvedAlias()`, threaded it through the tool `external_directory` gate and all three denial-message bodies, then through the bash `external_directory` gate and its bash-list rendering, and updated `architecture.md`.
Test count went from 2194 to 2207 (+13) in `pi-permission-system`; full monorepo suite, `pnpm run check`, `pnpm run lint`, and `pnpm fallow dead-code` all green.
Pre-completion reviewer returned **PASS**.

### Observations

- Caught and corrected a self-inflicted step-boundary coupling during implementation: my first edit to `external-directory-messages.ts` changed both `formatExternalDirectoryAskPrompt` (Step 2, tool) and `formatBashExternalDirectoryAskPrompt` (Step 3, bash) in one block, since they're colocated in the same file.
  Reverted the bash function's signature change and its downstream `DenialContext.bash_external_directory` / test literal changes back to `string[]` before committing Step 2, then reapplied them cleanly in Step 3 — keeping each commit's diff scoped to its own TDD cycle per the plan's step boundaries.
- `MD053` (`rumdl`) flagged `[#507]` as an unused link reference after adding the `[#507]:` definition per the plan: the two `architecture.md` mentions are inside a fenced ` ```text ` code block (the module-layout tree listing, opened at line 648), where reference-style links don't count toward MD053 usage.
  Matched the file's existing convention for issues cited only within that fence (bare `#476`/`#477`/`#486`-style, no brackets) instead of adding a body-prose usage just to satisfy the linter — dropped the `[#507]:` definition.
  Deviation flagged by the pre-completion reviewer as cosmetic/non-blocking (PASS).
- The `bash-external-directory.ts` gate correctly keeps two parallel path lists: `uncoveredPaths` (string values) for `deriveApprovalPattern` / `logContext.externalPaths` (unchanged, invariant-critical), and a new `disclosures` array (`{ path, resolvedPath }`) for the prompt/denial text only — confirmed by the reviewer as the correct separation.
- Reviewer noted one test-location deviation from the plan: the bash prompt's disclosure test landed in `test/bash-external-directory.test.ts` (alongside the existing `formatBashExternalDirectoryAskPrompt` describe block) rather than in `test/handlers/gates/external-directory-messages.test.ts`; coverage is complete either way, treated as non-blocking.
- An unrelated commit (`chore: upgrade to Sonnet 5`) landed on `main` from outside this session immediately after the docs commit — noted for the record, not part of this issue's changeset.
- Pre-completion reviewer: **PASS**.
  All deterministic checks green; cross-step invariants (#418/#486 dual-match protection, boundary/approval/log values) confirmed untouched — only message text changed.

## Stage: Final Retrospective (2026-07-01T00:59:26Z)

### Session summary

One session carried #507 through its full lifecycle — plan, four TDD cycles, ship — landing `pi-permission-system-v18.0.2` (three `fix:` commits plus a `docs:` architecture update).
The same session first ran `/plan-issue #487` and, on finding that #487's vision was already delivered by Phase 7 + #486, closed it as completed instead of fabricating a plan.
Execution was clean: two minor, self-caught friction points and no post-ship rework.

### Observations

#### What went well

- Incremental verification throughout TDD: each cycle ran its affected test file for red/green, then `pnpm run check` immediately whenever a shared type changed (`DenialContext`, the prompt signatures), then the full package suite before committing — the shared-type break in step 3 surfaced at `check` time, not end-of-session.
- `/plan-issue #487` correctly produced a non-plan outcome: the `Decide` gate treated the "Proposed change" as a hypothesis, investigation showed the three scope items were already delivered or declared non-goals, and an `ask_user` confirmed closing over fabricating a plan for done work.
- Step-boundary discipline held under a colocation hazard: `formatExternalDirectoryAskPrompt` (step 2) and `formatBashExternalDirectoryAskPrompt` (step 3) share `external-directory-messages.ts`, and the accidental joint edit was reverted and re-split so each commit's diff matched its TDD cycle.

#### What caused friction (agent side)

- `missing-context` — the plan prescribed adding a `[#507]:` reference-link definition to `architecture.md`, but both mentions live inside the ` ```text ` module-layout tree fence, where `[#N]` is not a live reference, so `MD053` rejected the orphaned definition.
  Self-identified via the lint gate; resolved in ~3 tool calls by switching to bare `#507` (matching the fence's existing `#476`/`#486` entries) and dropping the definition.
  Impact: minor in-session rework, no follow-up commit; root cause is a plan-time gap the `markdown-conventions` skill did not yet cover.
- `scope-drift` — the first edit to `external-directory-messages.ts` changed both the tool (step 2) and bash (step 3) prompt functions in one block.
  Self-identified before committing; reverted the bash signature and its downstream `DenialContext` / test changes, then reapplied them in step 3.
  Impact: added friction but no rework past the revert; no follow-up commit.

#### What caused friction (user side)

- None.
  The two `ask_user` decisions (#507 message scope → all variants; #487 → close as completed) were answered decisively and early, which kept both the plan's `Module-Level Changes` and the #487 outcome unambiguous from the start.

### Changes made

1. `.pi/skills/markdown-conventions/SKILL.md` — added a one-sentence caveat to the "Issue references" section: a `[#N]` inside a fenced code block (e.g. the `architecture.md` module-layout tree) is not a live reference, so cite issues there as bare `#N` with no `[#N]:` definition, or MD053 rejects the orphaned definition.
