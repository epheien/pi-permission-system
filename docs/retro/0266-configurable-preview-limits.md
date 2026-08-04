---
issue: 266
issue_title: "Configurable input preview length + smart formatters for known MCP tools"
---

# Retro: #266 — Configurable input preview length + smart formatters for known MCP tools

## Stage: Planning and Phase 1 Improvement Roadmap (2026-05-30T12:00:00Z)

### Session summary

Started with `/plan-issue #266` but the user steered the session toward identifying prerequisite structural work before writing a plan.
Through Socratic questioning ("What work would make this easier?", "What other collaborators are missing?"), the session produced a Phase 1 improvement roadmap for pi-permission-system focused on making #266 easy to implement.
Created two new issues (#282: extract `ToolPreviewFormatter`, #283: formatter extension seam) and updated #266 with the implementation plan.

### Observations

#### What went well

- The user's Socratic steering (strategic questions before artifact production) shaped the output into a focused improvement roadmap rather than a standard plan file.
  This produced a better dependency-ordered result than the standard `/plan-issue` flow would have.
- Explore subagent dispatch to study pi-subagents' extension surface model was appropriate — claude-haiku-4-5 for a read-only architecture doc exploration, completed in 37s with a thorough summary.

#### What caused friction (agent side)

1. `scope-drift` — when the improvement-round prompt was invoked, I began a generic fallow analysis (full suite, entire architecture doc, trace from `index.ts` outward) instead of recognizing that the prior conversation had already established the target area and goals.
   The user redirected at entry 44: "Use the initial conversation to set the clear goal of what should become easy."
   Impact: ~5 wasted tool calls on generic analysis before the redirect.
   User-caught.
2. `missing-context` — used bare `#NNN` issue references in the architecture doc without checking the project's established convention.
   The user prompted me to check `packages/pi-subagents/docs/architecture/architecture.md`, which uses reference-style links with full URLs.
   Impact: one follow-up commit (`docs(pi-permission-system): use reference-style issue links in roadmap`).
   User-caught.
3. `missing-context` — forgot to `git push` after committing.
   The user had to ask "Everything is committed and pushed?"
   Impact: minor delay, no rework.
   User-caught.
4. `wrong-abstraction` — tried `pnpm fallow:health` (a package-level script alias that doesn't exist in pi-permission-system) instead of `pnpm fallow health` (the root-level fallow command with subcommand).
   Impact: 2 wasted tool calls discovering the correct invocation.

#### What caused friction (user side)

- The improvement-round prompt's commit block had `docs(pi-subagents)` hardcoded instead of using the package name parameter.
  This would have produced wrong commit message scopes for any non-pi-subagents package.
  Fixed in this retro session.

### Diagnostic details

- **Model-performance correlation** — Explore subagent (entry 29) ran on claude-haiku-4-5 for read-only architecture doc exploration; appropriate match for the task.
- **Unused-tool detection** — the `missing-context` around link conventions (friction #2) could have been prevented by grepping the sibling architecture doc before writing links.
  The improvement-discovery skill says to "search sibling packages for the established convention" for code patterns; the same principle applies to doc formatting.

### Changes made

1. Added reference-style link convention rule to `.pi/skills/markdown-conventions/SKILL.md`.
2. Added `git push` to `.pi/prompts/plan-improvements.md` commit step.
3. Fixed hardcoded `docs(pi-subagents)` to `docs($1)` in `.pi/prompts/plan-improvements.md` commit message template.

## Stage: Planning (2026-05-30T16:00:00Z)

### Session summary

Wrote the implementation plan (`packages/pi-permission-system/docs/plans/0266-configurable-preview-limits.md`) for the now-narrowed scope of #266: make `toolInputPreviewMaxLength` and `toolTextSummaryMaxLength` configurable.
The prior session already extracted `ToolPreviewFormatter` (#282, closed) and deferred the smart formatters / extension seam to #283 (open), so this plan covers only Phase 1 roadmap steps 3–4.

### Observations

- Scope was already disambiguated by the prior session: the `ctx_batch_execute` smart formatter and the `registerToolInputFormatter()` seam live in #283, not here.
  The plan treats both as explicit Non-Goals and links them.
- The `ToolPreviewFormatter` is constructed fresh inside `handleToolCall`, and `session.config` returns refreshed config at call time — so no "reconstruct on config refresh" wiring is needed; reading config at construction time suffices.
- Chose to introduce a pure `resolveToolPreviewLimits(config)` helper in `tool-preview-formatter.ts` (narrow `Pick` parameter for ISP) rather than inlining the `?? DEFAULT` fallbacks in the handler — gives a unit-testable seam without standing up the handler.
- Validation decision: `normalizeOptionalPositiveInt` requires a positive integer; invalid/absent values fall back to the existing constants.
  No upper cap — a large value is the intended "never truncate" escape hatch.
- `toolInputLogPreviewMaxLength` (1000) is left hardcoded — the issue only asks for the two prompt-facing limits.
- Schema (`additionalProperties: false`) forces the schema + example update into the same commit as the type change; folded into TDD step 1.
- One open question left for implementation: whether `config.example.json` shows the issue's illustrative `400`/`120` or echoes the `200`/`80` code defaults.

## Stage: Implementation — TDD (2026-05-30T23:08:00Z)

### Session summary

Completed all 3 TDD cycles from the plan: (1) `normalizeOptionalPositiveInt` helper + two new optional config fields in `extension-config.ts`, schema, and example config; (2) `resolveToolPreviewLimits()` in `tool-preview-formatter.ts` + handler wiring in `permission-gate-handler.ts`; (3) docs update to `docs/configuration.md` and roadmap.
Test count grew from 1527 to 1544 (+17 tests across `extension-config.test.ts` and `tool-preview-formatter.test.ts`).

### Observations

- Deviation from plan: four handler test factories (`external-directory-integration`, `external-directory-session-dedup`, `tool-call`, `tool-call-events`) needed `config: DEFAULT_EXTENSION_CONFIG` added because `handleToolCall` now reads `this.session.config` — the plan's "Module-Level Changes" listed only production files, not these test files.
  The fix was mechanical (same 2-line addition to each mock) and landed in the same commit as step 2.
- Open question from planning (example values `400`/`120` vs. `200`/`80`) resolved: `config.example.json` uses the illustrative `400`/`120` values; the Runtime Knobs table documents the `200`/`80` code defaults accurately.
- Pre-completion reviewer: WARN (resolved before retro commit).
  Finding: `package-pi-permission-system/SKILL.md` alignment guideline omitted `docs/configuration.md`.
  Fix: skill updated in a follow-up commit (`3bd6ffda`).

## Stage: Final Retrospective (2026-05-31T03:44:40Z)

### Session summary

Shipped #266 end-to-end across three workflow stages in one session: planning (claude-opus-4-8), TDD implementation (claude-sonnet-4-6), and shipping (deepseek-v4-flash).
Added `toolInputPreviewMaxLength` and `toolTextSummaryMaxLength` config fields, wired them through `resolveToolPreviewLimits()` into `ToolPreviewFormatter`, released `pi-permission-system-v8.1.0`, and closed the issue.
Test count grew from 1527 to 1544.

### Observations

#### What went well

1. Clean cross-stage handoff via the retro file — the TDD session opened by reading the planning-stage notes and inherited the `resolveToolPreviewLimits` design and the `400`/`120`-vs-`200`/`80` open question without re-deriving them.
2. Model assignment matched task difficulty at every stage: opus for scope/design judgment, sonnet for implementation, deepseek-flash for mechanical ship orchestration (`ci_find`/`ci_watch`/`release_pr_merge`).
   No mismatches.
3. Incremental verification caught the mock breakage immediately — `pnpm run check` then `pnpm run test` ran right after the step-2 wiring change, surfacing the 60 failures at the exact commit that introduced them rather than at the end.

#### What caused friction (agent side)

1. `missing-context` — the plan wired `handleToolCall` to read `this.session.config`, but the four handler test mock factories (`makeSession` / `makeStatefulSession` in `external-directory-integration`, `external-directory-session-dedup`, `tool-call`, `tool-call-events`) build the session via `{ ... } as unknown as PermissionSession` and never stubbed `config`.
   The cast erased the missing member, so `tsc` passed but 60 tests threw at runtime (`Cannot read properties of undefined (reading 'toolInputPreviewMaxLength')`).
   Impact: ~20 tool calls (entries 67–89) to diagnose, locate, read, and patch the four factories; resolved cleanly inside the step-2 commit.
   The plan's Module-Level Changes listed only production files.
2. `missing-context` — first attempt to run a single test file used `pnpm vitest run <path>` from the repo root (as the `tdd-plan` prompt and `testing` skill both instruct), which fails in this pnpm workspace (`Command "vitest" not found`).
   Self-corrected to `pnpm --filter @gotgenes/pi-permission-system exec vitest run test/...`.
   Impact: 1 wasted tool call.
3. `instruction-violation` (self-caught) — the plan file initially included a `[#266]:` link-reference definition for the doc's own issue number, which `markdown-conventions` explicitly forbids; markdownlint MD053 caught it.
   Impact: one extra edit during planning.

#### What caused friction (user side)

1. The agent stalled after editing the fourth mock factory (entry 87 produced no tool call); the user had to send "Continue."
   Mechanical nudge, not strategic — no rework.

### Diagnostic details

- **Model-performance correlation** — planning (claude-opus-4-8), TDD (claude-sonnet-4-6), ship (deepseek-v4-flash), retro (claude-opus-4-8); all appropriate.
  The pre-completion-reviewer subagent (entry 102) returned a substantive WARN, indicating its model handled the judgment-heavy review correctly.
- **Feedback-loop gap analysis** — no gap; per-file `vitest` runs after each red/green plus a full-suite + `check` immediately after the step-2 wiring change surfaced the mock breakage at its origin commit.
- **Unused-tool detection** — the mock breakage (friction #1) was a planning-time grep gap, not a missing subagent; a grep for the consumer's mock factories during planning would have pre-empted it.

### Changes made

1. Fixed the single-file test command in `.pi/prompts/tdd-plan.md` to `pnpm --filter @gotgenes/<pkg> exec vitest run <test-path>` (plain `pnpm vitest run` fails at the repo root).
2. Fixed the "Running tests" commands in `.pi/skills/testing/SKILL.md` to the same `--filter ... exec` form for both single-file and full-suite runs.
