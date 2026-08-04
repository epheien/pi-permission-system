---
issue: 352
issue_title: "Add access intent extractors for path-aware extension tools"
---

# Retro: #352 — Add access intent extractors for path-aware extension tools

## Stage: Planning (2026-06-12T02:53:21Z)

### Session summary

Planned the response to third-party PR #352 (`moekyo`) — the issue number is itself an open PR (branch `feature/path-aware-extension-tools`, +1105/−52, 29 files).
The operator used `/plan-issue` as a stand-in for PR review.
After a four-question `ask_user` dialogue, the agreed direction is to **adopt the capability with a simplified design**, default-on, minimal scope: close the path-gating bypass for extension/MCP tools via the cross-cutting `path` and `external_directory` surfaces, expose `registerToolAccessExtractor()` on the cross-extension service, and defer per-tool path maps.
Produced `docs/plans/0352-access-intent-extractors-path-aware-tools.md` with five TDD cycles.

### Observations

- The real gap: path gating only recognizes six hardcoded built-ins (`PATH_BEARING_TOOLS`); `getPathBearingToolPath` returns `null` for everything else, so the `path` and `external_directory` gates skip extension/MCP path tools — a genuine permission bypass.
- Key design critique of the PR that drove the simplification: its `ToolAccessIntent` envelope carries `resource` / `operation` / `confidence` / `source` / `toolName`, but **only `.value` is ever consumed** by a gate (`resource` and `confidence` each have a single inhabitant).
  The package skill flags exactly this ("any declared config field not read at runtime is a maintenance trap"), so the plan collapses the envelope to a value-only extractor `(input) => string | undefined`.
- Detection is by **convention, not registration**: replacing `getPathBearingToolPath`'s early `return null` with an `input.path` fallback makes any non-bash tool path-aware automatically; `registerToolAccessExtractor` is only the escape hatch for non-standard input shapes (MCP `arguments.path` is handled inline).
  Confirmed with the operator that this needs no cooperation from extensions.
- Scope decision (operator-driven): start with the cross-cutting `path`/`external_directory` surfaces only and **defer per-tool path maps** (`"ffgrep": { "*.env": "deny" }`).
  Verified this is cleanly additive later — the per-tool feature only adds threading through `normalizeInput`/`PermissionManager`, reusing the same registry, extractor type, and service API with no rework.
  This keeps the change out of the hot `normalizeInput`/`PermissionManager` path and its large test surface.
- Minimal-scope blast radius is concentrated: `getPathBearingToolPath` stays unchanged (still used by `tool.ts` for cosmetic suggestion/log values); a new `getToolInputPath` is consumed only by the two cross-cutting gates, threaded via the pipeline exactly like the existing `customFormatters`.
- The registry mirrors the proven `ToolInputFormatterRegistry` one-for-one (ISP `Lookup`/`Registrar` split, dup-throw, identity-guarded disposer, one instance shared between `LocalPermissionsService` registrar and pipeline lookup) — idiomatic, low-risk plumbing.
- Classified **breaking** (`feat!:` + `BREAKING CHANGE:` footer): extension/MCP path tools previously ungated become gated on upgrade without a user edit.
  It is a security fix; the schema `markdownDescription` and `docs/configuration.md` document it.
- No new config field (registration is a runtime API), so the loader / `PermissionSystemExtensionConfig` / merge intermediate are untouched — avoids the #332/#347 merge-drop bug class entirely.
- Follow-up to file: per-tool path maps for extension tools (deferred); reference it in the PR #352 close comment.
- Attribution is required and encoded in the plan's `## Attribution` section: since we re-implement rather than merge, every implementation/docs commit carries `Co-authored-by: moekyo <shigotods@outlook.com>` (from the PR's commit authorship), and the ship-stage close comment thanks `@moekyo` by name and links the implementing SHA(s).

## Stage: Implementation — TDD (2026-06-12T03:20:40Z)

### Session summary

Implemented all five TDD cycles cleanly: the lean `ToolAccessExtractorRegistry`, `getToolInputPath`, the default-on `feat!` gate change threaded into `ToolCallGatePipeline` + both cross-cutting gates, the `registerToolAccessExtractor` service API, and the docs/schema updates.
Test count went 1922 → 1951 (+29); full suite, `check`, `lint`, and `fallow dead-code` all green.
Every implementation/docs commit carries the `Co-authored-by: moekyo <shigotods@outlook.com>` trailer.

### Observations

- The design held exactly as planned — no rework.
  Keeping `getPathBearingToolPath` (built-in only, for `tool.ts`'s cosmetic suggestion/log values) and adding a separate `getToolInputPath` for the two cross-cutting gates kept the blast radius tight and left the per-tool surface (`normalizeInput`/`PermissionManager`) untouched as scoped.
- One deviation beyond the plan's file list: `test/service-lifecycle.test.ts` also constructs a `PermissionsService` fake, so adding `registerToolAccessExtractor` to the interface required adding `registerToolAccessExtractor: vi.fn()` there too (folded into Cycle 4).
  The plan listed the other fakes but missed this one — the interface-breaks-all-implementers rule caught it.
- Cycle 3 commit churn: the pre-commit `eslint` hook auto-removed `(x as string)` assertions (unnecessary after `typeof` narrowing) and `biome` reflowed the resulting ternary, aborting the commit twice.
  Resolved by removing the redundant parens and re-staging the formatted output.
  Worth pre-empting next time: write `typeof x === "string" ? x : undefined` (no cast) from the start.
- The full suite (not just the affected files) was run before the `feat!` Cycle 3 commit since it changes shared gate behavior — caught nothing, but the right call for a breaking change.
- Pre-completion reviewer verdict: WARN (no FAILs).
  Two non-blocking findings: (1) the `package-pi-permission-system` skill was stale — fixed in commit `30824366` (added the extractor-registry / default-on note + testing bullet); (2) the two planning-stage docs commits (`d7e881ac`, `1eece29b`) lack the `Co-authored-by` trailer — accepted as-is, since moekyo did not author the plan prose and all five implementation commits plus the eventual close comment carry the attribution.

## Stage: Final Retrospective (2026-06-12T03:33:14Z)

### Session summary

Shipped #352 end-to-end (TDD → Ship): closed the path-gating bypass for extension/MCP tools, released `pi-permission-system-v12.0.0` (a major bump from the `feat!`), and closed the PR-issue with an explicit `@moekyo` credit comment.
The ship stage was clean (CI green, release-please `UNSTABLE`-no-checks case handled correctly).
The attribution mechanics worked: every implementation/docs commit carried the `Co-authored-by: moekyo <shigotods@outlook.com>` trailer and the close comment thanked `@moekyo` by name and linked the SHAs.

### Observations

#### What went well

- The plan's simplified design held through implementation and ship with **zero rework** — the lean value-only extractor and the decision to leave `normalizeInput`/`PermissionManager` untouched kept the diff tight and reviewable for a security-sensitive package.
- The third-party attribution workflow (encode `Co-authored-by` in the plan → carry on every commit → credit in the close comment) executed cleanly and is a reusable template for adopting external contributions without merging them.
- Release automation handled the major version bump (`12.0.0`) correctly from the `feat!` + `BREAKING CHANGE:` footer; the `UNSTABLE`/empty-rollup `GITHUB_TOKEN` merge case was recognized and merged without blocking.

#### What caused friction (agent side)

- `other` (Edit tool-schema misuse) — repeatedly included a non-schema `endText` property in `Edit` calls (4+ times this session, plus earlier in the broader work); each was rejected and retried.
  Impact: ~1–2 wasted tool calls per occurrence, no code impact.
  No project-doc remedy — this is tool-call hygiene, not a convention gap.
- `other` (linter/hook churn) — in Cycle 3, a redundant `(x as string)` after a `typeof x === "string"` narrowing in test mocks was auto-stripped by ESLint's `no-unnecessary-type-assertion`, then `biome` reflowed the resulting ternary, aborting the pre-commit hook twice.
  Impact: ~4 extra tool calls (paren cleanup + two re-stage/re-commit cycles).
  Repeatable gotcha worth a one-line AGENTS.md note (proposed).

#### What caused friction (user side)

- None blocking.
  The earlier "no `/pr-review` template" remark surfaced a real structural gap (below) rather than friction.

### Follow-ups

- A dedicated `/pr-review` (or contribution-triage) prompt template: third-party PRs arriving as issues is now a recurring pattern (`#389` graelo, `#352` moekyo), and `/plan-issue` is being overloaded as a stand-in.
  A purpose-built template would standardize the evaluate-vs-adopt decision, the attribution mechanics, and the simplified-re-implementation path.
  Substantive (a new prompt) — open an issue and run `/plan-issue`, do not add inline here.

### Diagnostic details

- **Feedback-loop** — clean and incremental: `pnpm run check` / `biome` ran after each interface-touching cycle (3, 4), and the full suite ran before the `feat!` Cycle 3 commit (correct for a breaking change).
  No end-only verification gap.
- **Escalation-delay** — the Cycle 3 hook churn was 2 aborted commits / ~4 tool calls, under the 5-call threshold; resolved by removing the cast rather than fighting the hook.
- **Model-performance** — one subagent (pre-completion-reviewer) on `claude-sonnet-4-6`, appropriate for judgment-heavy review; returned WARN with two correct findings.

### Changes made

1. Created `.pi/prompts/pr-review.md` — a new `/pr-review` slash-command template (operator-directed, using #352 as the worked example).
   It evaluates a third-party PR, separates the underlying problem from the implementation, runs a required third-party `ask-user` direction gate (adopt-as-is / adopt-with-simplified-design / decline), bakes in the `Co-authored-by` + close-comment attribution mechanics, and — in the common case — records a triage note and hands off to `/plan-issue` rather than merging.
2. Added a `PR review` row to the session-naming table in `AGENTS.md` (`#N PR Review — <title>`) so the convention table stays consistent with the new template's `set_session_name` call.
3. Did **not** add the redundant-cast gotcha to `AGENTS.md` (the other ask-user option) — the operator redirected to building `/pr-review`; left here as a recorded observation only.
