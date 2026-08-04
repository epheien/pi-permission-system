---
issue: 1
issue_title: "Add integration tests for external_directory tool_call enforcement"
---

# Retro: #1 — Add integration tests for external_directory tool_call enforcement

## Final Retrospective (2026-05-08T17:36:00-06:00)

### Session summary

Planned, implemented, and shipped 35 integration tests for the `external_directory` `tool_call` enforcement gate in 5 TDD cycles.
No production code was changed.
The session covered `/plan-issue`, `/tdd-plan`, and `/ship-issue` with one minor plan re-commit (MD060 table separator) and one `Edit` mismatch after autoformat.

### Observations

#### What went well

- The plan-to-TDD-to-ship pipeline executed end-to-end in a single session with zero rework on production code.
- The surface-aware `makeCheckPermission` helper cleanly isolated the `external_directory` gate from the tool gate, making each test focused and readable.
- All 5 TDD cycles passed on first run (no red→debug loops needed), indicating the plan's test matrix was well-scoped against the existing architecture.

#### What caused friction (agent side)

- `instruction-violation` — Used `|---|---|---|` table separators in the plan instead of `| --- | --- |` required by MD060 compact style.
  The `markdown-conventions` skill was loaded and documents this rule.
  Impact: one failed pre-commit hook, one fixup edit, one re-commit.
  Self-identified (caught by hook, not user).
- `missing-context` — In cycle 2, attempted an `Edit` using pre-autoformat `oldText` after Biome had reformatted the file (specifically `it.each(OPTIONAL_PATH_TOOLS)(` was reflowed).
  Impact: one failed `Edit` call, one `tail` read to get actual text, then successful edit.
  Added ~10 seconds of friction, no rework.

#### What caused friction (user side)

- None observed.
  The user's issue was detailed with an explicit test matrix, acceptance criteria, and suggested implementation approach, which made planning straightforward.
