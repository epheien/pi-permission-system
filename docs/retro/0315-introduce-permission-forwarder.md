---
issue: 315
issue_title: "Introduce a PermissionForwarder collaborator that owns forwarding state"
---

# Retro: #315 — Introduce a PermissionForwarder collaborator that owns forwarding state

## Stage: Planning (2026-06-02T11:40:00Z)

### Session summary

Produced the implementation plan for Phase 3, Step 2 of the package roadmap — the first of a three-issue lift-and-shift (#315 → #316 → #317).
The plan introduces a `PermissionForwarder` class that owns the forwarding dependency set and delegates to the existing `polling.ts` free functions, wires `ForwardingManager` to it, and constructs the single forwarder in `index.ts`.

### Observations

- Decided to **reuse `PermissionForwardingDeps` as the constructor parameter** rather than define a parallel `PermissionForwarderDeps` interface.
  The eight bag members are exactly what the delegated free functions still need this issue; a parallel interface would duplicate them field-for-field and be deleted in #317.
  The "owns individual fields" end state is realized in #317 when the bag is dismantled.
- Decided `ForwardingManager` should depend on a **narrow `InboxProcessor` seam** (only `processInbox`), not the concrete `PermissionForwarder`.
  This mirrors the existing `ForwardingController` convention, follows the code-design/design-review guidance (narrow interface over concrete class), and lets `forwarding-manager.test.ts` drop its `as unknown as PermissionForwardingDeps` cast.
- `requestApproval` is introduced now but stays unused by production until #316, when `PermissionPrompter` consumes it via a separate narrow `ApprovalRequester` interface.
- Plan said no architecture-doc edit was required; that was revisited during TDD (see below).
- Tooling note: the repo enforces markdown with **rumdl**, not `markdownlint` — the convention skill phrases rules using markdownlint IDs, which is misleading.

## Stage: Implementation — TDD (2026-06-02T12:00:00Z)

### Session summary

Completed both planned TDD cycles.
Step 1 added `PermissionForwarder` + `InboxProcessor` (`permission-forwarder.ts`) with delegation tests; Step 2 rewired `ForwardingManager` and `index.ts` and migrated `forwarding-manager.test.ts` onto an injected `InboxProcessor` mock.
Test count went from 1753 → 1756 (+3 from the new forwarder suite); the full suite, `check`, `lint`, and `fallow dead-code` are all green.

### Observations

- Both implementation commits are `refactor:` (behavior-preserving), not `feat:` — the suggested commit types in the plan matched.
- The `forwarding-manager.test.ts` rewrite replaced the `vi.mock("../src/forwarded-permissions/polling")` setup with a hoisted `mockProcessInbox` injected as `{ processInbox }`.
  Typed the stub as `vi.fn((): Promise<void> => Promise.resolve())` so it satisfies `InboxProcessor` without a cast, and re-seeded `mockResolvedValue(undefined)` in `beforeEach` (after `mockReset()` the manager's `.finally()` would otherwise call `.finally` on `undefined`).
- Deviation from the plan: the plan stated no architecture-doc edit was required, but Step 1 (#314) is marked `✅` in the roadmap, so for consistency (and to pre-empt a doc-staleness flag) I marked Phase 3 Step 2 `✅` in `architecture.md` with a past-tense outcome and a forward reference to #317.
  Committed separately as `docs:`.
- The `git describe --tags` base (`pi-permission-system-v10.0.0`) predates several already-merged PRs (#314, #292), so `tag..HEAD` diffs include unrelated files; scoped the reviewer to the four #315 commits.
- Pre-completion reviewer: **PASS** — all deterministic checks green, 5/5 acceptance criteria code-verified, no design or dead-code concerns, all 6 Mermaid diagrams parsed.

## Stage: Final Retrospective (2026-06-02T16:25:59Z)

### Session summary

Delivered Phase 3, Step 2 of the roadmap (#315) end-to-end in one session: plan, two behavior-preserving `refactor:` TDD cycles, a roadmap-status `docs:` update, and a `PASS` pre-completion review.
The `PermissionForwarder` collaborator and its narrow `InboxProcessor` seam landed clean (+3 tests, 1753 → 1756), with no rework across stages.

### Observations

#### What went well

1. The narrow `InboxProcessor` seam decided at planning time (over passing the concrete `PermissionForwarder`) paid off directly: `forwarding-manager.test.ts` shed its `as unknown as PermissionForwardingDeps` cast and injects a plain `{ processInbox }` mock.
   The `design-review` guidance was applied proactively in the plan rather than retrofitted after a smell appeared.
2. The `mockReset()`-then-`.finally()`-on-`undefined` hazard was anticipated: `mockResolvedValue(undefined)` was re-seeded in `beforeEach` so the manager's `void this.forwarder.processInbox(ctx).finally(...)` never dereferences `undefined`.
   A clean application of the `testing` skill's mock-reset rules with no red-herring debugging.
3. Verification ran incrementally — baseline `check`/`lint`/`test`, then per-file `vitest run` on red and green, `check` after the interface change, full suite after the wiring change — so nothing surfaced late.

#### What caused friction (agent side)

1. `missing-context` — during planning I reached for `markdownlint-cli2` (`pnpm exec markdownlint-cli2 ...` → "Command not found"), then grepped for a markdownlint config, before the user pointed out the repo enforces markdown with `rumdl`.
   Root cause: the `markdown-conventions` skill and the `AGENTS.md` markdown section express every rule using markdownlint rule IDs (MD029, MD036, MD053, …) and never name `rumdl` as the actual enforcer.
   Caught by: **user** ("We use rumdl.
   Why are you looking for markdownlint?").
   Impact: ~2 wasted tool calls and one user correction; no rework — the reference-link fix was valid under `rumdl` (same rule family) and the pre-commit `rumdl fmt` hook validated the file.
2. `missing-context` (minor, planning-side) — the plan asserted "no architecture-doc edit is required," but Step 1 (#314) is marked `✅` in the same roadmap, so the status convention implied Step 2 should be ticked too.
   Caught by: **self**, during TDD step 7.
   Impact: none beyond one extra `docs:` commit (`0827277a`); the deviation was documented in the TDD stage notes.

#### What caused friction (user side)

1. The `rumdl`-vs-`markdownlint` gap was a documentation issue, not a user-knowledge gap — the user's one-line correction was the fastest possible redirect.
   The opportunity is upstream: encode the enforcer name in the skill so no correction is needed next time.

### Diagnostic details

- **Model-performance correlation** — the only subagent dispatch was the `pre-completion-reviewer` on `anthropic/claude-sonnet-4-6` (222 s, 23 tool uses) for judgment-heavy acceptance-criteria and design review; model class is appropriate for the task, no mismatch.
- **Escalation-delay tracking** — no `rabbit-hole` friction; the markdownlint detour was 2 tool calls, well under the 5-call escalation threshold.
- **Feedback-loop gap analysis** — no gap; verification tools ran after every change, not only at the end.

### Changes made

1. Appended this Final Retrospective entry to `packages/pi-permission-system/docs/retro/0315-introduce-permission-forwarder.md`.
2. Added a two-line enforcer note to the top of the `## Formatting rules` section in `.pi/skills/markdown-conventions/SKILL.md`, naming `rumdl` (via `pnpm run lint:md`) as the markdown enforcer and clarifying that the `MDxxx` IDs are for reference, not a `markdownlint-cli2` invocation.
