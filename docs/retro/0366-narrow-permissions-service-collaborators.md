---
issue: 366
issue_title: "Narrow `LocalPermissionsService` collaborators to interfaces"
---

# Retro: #366 — Narrow `LocalPermissionsService` collaborators to interfaces

## Stage: Planning (2026-06-10T00:00:00Z)

### Session summary

Produced the implementation plan for narrowing `LocalPermissionsService`'s three constructor parameters from concrete classes (`PermissionManager`, `SessionRules`, `ToolInputFormatterRegistry`) to abstractions.
Confirmed against the source that the design is fully prescribed by both the issue and the Phase 5 Track C roadmap in `docs/architecture/architecture.md`: reuse `ScopedPermissionManager`, `Pick<SessionRules, "getRuleset">`, and a new `{ register }` interface.
Skipped the `ask-user` gate — the proposed change is unambiguous.

### Observations

- The change is type-only and non-breaking; `src/index.ts` (the sole production construction site) needs no edit because the concrete instances structurally satisfy the narrower parameter types.
- New write-side interface `ToolInputFormatterRegistrar` mirrors the existing read-side `ToolInputFormatterLookup` in `tool-input-formatter-registry.ts`; the concrete registry gains it in its `implements` clause.
- ISP tradeoff noted: `ScopedPermissionManager` declares 5 methods but the service calls only 2.
  Reuse is a deliberate, documented decision (consistency with `PermissionSession` / `PermissionResolver`); the testability goal still holds because the test mock factory return type is a `Pick` of the two exercised methods.
- Planned as a single Red→Green→Commit cycle (`refactor:`): removing the three `as unknown as` casts in `permissions-service.test.ts` fails `tsc` until the constructor types are narrowed, so the test simplification and production narrowing land in one commit.
- The roadmap `✓ complete` mark on Track C Step 5 is deferred to ship time, per the package skill — not part of this plan's commits.

## Stage: Implementation — TDD (2026-06-10T09:35:00Z)

### Session summary

Implemented the narrowing across three commits (the plan's single cycle was decomposed at the user's request — "make the change that makes the change easy").
No test-count change: `permissions-service.test.ts` still has 7 tests (1902 package-wide), now with zero `as unknown as` casts.
All deterministic gates pass: `check`, `lint`, full `test`, and `fallow dead-code`.

### Observations

- Deviation from plan: the single planned `refactor:` commit became three — (A) `feat:` add `ToolInputFormatterRegistrar` (pure addition + `implements`); (B) `test:` reuse the shared `makeFakePermissionManager()` fixture in place of the hand-rolled 2-method stub (kept the cast temporarily); (C) `refactor:` narrow the three constructor params and drop all casts.
  Kent-Beck tidy-first sequencing: A and B are behavior-preserving preparation that shrank C to an 18-line diff.
- Considered but rejected option C from discussion (narrowing the manager param to `Pick<ScopedPermissionManager, "checkPermission" | "getToolPermission">`): kept the full `ScopedPermissionManager` per the plan/roadmap consistency decision.
  Reusing the shared `makeFakePermissionManager()` (5-method fake) made the full interface free of extra hand-rolled stubs.
- `makeFakePermissionManager`'s default `checkPermission` return differs from the old local stub's `makeCheckResult()`, but no test in the file asserts that default (the relevant test overrides via `mockReturnValue`), so the swap was safe.
- The pre-completion reviewer's WARN (two stale `architecture.md` lines describing the injected collaborators and the registry module) was addressed in this session with a `docs:` commit, not deferred — only the roadmap `✓ complete` mark remains for ship time.
- Pre-completion reviewer: PASS (ready for `/ship-issue`).
  Reviewer warnings: two `architecture.md` staleness items — both now fixed in commit `docs: reflect narrowed LocalPermissionsService collaborators in architecture (#366)`.

## Stage: Final Retrospective (2026-06-10T10:30:00Z)

### Session summary

Shipped #366 end-to-end across Planning, TDD, and Ship stages: `LocalPermissionsService` now depends on `ScopedPermissionManager`, `Pick<SessionRules, "getRuleset">`, and the new `ToolInputFormatterRegistrar` instead of concrete classes, with all three `as unknown as` casts removed.
Released as `pi-permission-system-v10.9.0`; issue closed.
The defining moment was a mid-TDD user intervention ("make the change that makes the change easy") that turned a planned single atomic commit into a clean tidy-first decomposition.

### Observations

#### What went well

- The tidy-first decomposition, once prompted, executed cleanly: a pure-addition interface commit (`feat:`), a test-fixture migration commit (`test:`), then an 18-line main `refactor:` diff — a textbook Kent Beck sequence with `pnpm run check` + targeted test run after each commit.
- The `pre-completion-reviewer` subagent caught two stale `architecture.md` lines (the injected-collaborator description and the `tool-input-formatter-registry.ts` module listing) that the plan had not flagged — the plan deferred only the `✓ complete` roadmap mark.
  The agent correctly recognized post-step #7 obligated fixing them in-session, converting latent doc-staleness into a `docs:` commit before shipping.

#### What caused friction (agent side)

- `premature-convergence` — During TDD the agent began executing the plan's single-commit cycle literally (the first Red-step edit to `permissions-service.test.ts`) without considering whether preparatory tidyings would shrink the change; the better structure emerged only after the user invoked Kent Beck.
  Root cause is upstream in planning: the plan locked in a "single atomic type change" in its TDD Order and never weighed a tidy-first split.
  Impact: one premature edit reverted via `git checkout`, then re-done as three clean commits — minimal rework (~1 reverted edit), but the cleaner outcome depended on user intervention rather than a proactive planning heuristic.
  User-caught (strategic redirect, not an error correction).
- `other` (tooling) — Ship stage used `grep -oP` (Perl regex), which macOS BSD `grep` rejects; self-corrected to `grep -oE` on the next call.
  Impact: 1 extra tool call, no rework.
- `other` (minor) — Planning emitted plan markdown that tripped markdownlint MD053 (reference-link definition without a matching body reference), fixed with one follow-up edit before committing.
  Impact: 1 extra edit, no rework.

#### What caused friction (user side)

- The "make the change that makes the change easy" intervention was high-leverage judgment delivered at exactly the right moment — before the messy single-commit landed.
  Opportunity (not criticism): encoding tidy-first decomposition as a planning heuristic would let the decomposition surface proactively at plan time rather than relying on the user to catch it mid-implementation.

### Diagnostic details

- Model-performance correlation — Planning ran on `claude-opus-4-8` (judgment-heavy design) — appropriate.
  TDD opened on `claude-sonnet-4-6` (the premature single-commit Red edit happened here); the strategic A/B/C decomposition ran on `claude-opus-4-8` after the user nudge — heavier reasoning for the harder call.
  Ship ran on `deepseek-v4-flash` (mechanical push/CI/close/merge) — an appropriate tier, though it produced the `grep -oP` misfire.
  The `pre-completion-reviewer` ran as a separate subagent (model set by its own frontmatter, not visible in the parent transcript).
- Escalation-delay — No rabbit-holes; the single tooling error resolved in 1 retry, well under the 5-call threshold.
- Unused-tool — The `premature-convergence` gap was a planning-heuristic gap, not a missing-tool gap; no Explore/`colgrep` dispatch would have surfaced the tidy-first split — only proactive consideration would.
- Feedback-loop — Verification was incremental: `check` + targeted test after each of commits A/B/C, then full suite + `lint` + `fallow dead-code` at the end.
  No end-only-verification gap.

### Changes made

1. Added a `### Preparatory refactoring (tidy first)` subsection to the Structural Design section of `.pi/skills/code-design/SKILL.md` — encodes the Kent Beck "make the change that makes the change easy" heuristic so a preparatory split (pure-addition interface, shared-fixture migration) is considered proactively at plan time rather than relying on a mid-implementation user nudge.
