---
issue: 145
issue_title: "Add Symbol.for()-backed service accessor, deprecate permissions:rpc:check"
---

# Retro: #145 — Add Symbol.for()-backed service accessor

## Final Retrospective (2026-05-14T16:45:00Z)

### Session summary

Planned, implemented, shipped, and released (v5.18.0) the `Symbol.for()`-backed service accessor for cross-extension policy queries.
The implementation added `src/service.ts`, extracted `buildInputForSurface` to `src/input-normalizer.ts`, wired publish/unpublish in the extension lifecycle, added `exports` to `package.json`, deprecated `permissions:rpc:check` types, and documented the new API.
Eight new tests in `tests/service.test.ts`; all 1435 tests green.

### Observations

#### What went well

- The TDD cycle was clean: 6 steps, each landing in a single commit with no rework.
  The plan's step ordering (accessor module → extraction → wiring → exports → deprecation → docs) avoided any mid-step type breakage.
- The user's domain insight during planning — that `/reload` re-initializes all extensions, making the Proxy delegate unnecessary — eliminated an entire design option and simplified the plan.
  This saved implementation complexity and avoided a runtime overhead that wasn't needed.
- The `biome-ignore` suppression issue was self-caught during the final lint pass, before the user saw it.

#### What caused friction (agent side)

1. `scope-drift` — During the docs step (step 6), I renamed `docs/event-api.md` → `docs/cross-extension-api.md` without plan coverage.
   This required updating 5 cross-reference files (`README.md`, `docs/subagent-integration.md`, `docs/guides/upstream-issue-template.md`, `docs/guides/permission-frontmatter-for-subagent-extensions.md`) and introduced a URL-breaking change for external links.
   The user flagged the rename, and it was kept by explicit choice, but the decision should have been surfaced via `ask-user` before executing.
   Impact: one extra `ask-user` round plus the user needing to evaluate an unplanned change.

2. `missing-context` — When the user asked "Is this a breaking change and if so did we indicate it in our commit messages?", I initially interpreted it as being about the doc rename rather than the `permissions:rpc:check` deprecation.
   This required a clarification round.
   Impact: added friction but no rework — the answer (deprecation is non-breaking) was correct once the question was understood.

#### What caused friction (user side)

- The user had to ask a clarifying question about whether the deprecation was breaking — something the ship summary should have preemptively addressed.
  The `/ship-issue` close comment did eventually state "No breaking changes" but this came after the user's question, not before.
