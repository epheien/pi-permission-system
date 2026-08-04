---
issue: 318
issue_title: "Introduce an McpTargetList value object in mcp-targets.ts"
---

# Retro: #318 — Introduce an `McpTargetList` value object in `mcp-targets.ts`

## Stage: Planning (2026-06-02T00:00:00Z)

### Session summary

Produced the implementation plan for replacing the `pushTarget` closure in `src/mcp-targets.ts` with an `McpTargetList` value object that owns the ordered-uniqueness invariant.
This is Track C / Step 5 of the architecture roadmap (Finding 4).
The change is behavior-preserving — the existing `test/mcp-targets.test.ts` is the regression guard and candidate ordering is unchanged.

### Observations

- The design is unambiguous per the issue; only one decision needed surfacing: whether `McpTargetList` is exported with direct unit tests or kept module-private.
  Confirmed with the user via `ask_user` — chose **export + direct unit tests**, mirroring the existing `parseQualifiedMcpToolName` (exported + tested) precedent in the same module.
  This adds a new red→green cycle (Step 1) documenting the invariant in isolation.
- Both Non-Goals from the issue were preserved in the plan: no MCP-naming command methods on the list (keeps ordering+uniqueness separate from the `${server}_${tool}` spelling), and no `McpInvocation`/`deriveTargets()` class (a one-shot transform in a class costume).
- Sole production consumer is `src/input-normalizer.ts` (line 106), which spreads the result — so `toArray()` returning a defensive copy (`[...this.targets]`) instead of the live array is behavior-preserving and strictly safer.
- The two private helpers (`pushMcpToolPermissionTargets`, `addDerivedMcpServerTargets`) already took a `pushTarget` callback, so swapping it for an injected `McpTargetList` is a clean DIP-friendly substitution with no LoD / output-argument / reverse-search concerns.
- Grep confirmed no `src/`, `test/`, or skill file references the changed symbols beyond `input-normalizer` and the two test files; the architecture doc (Finding 4 / Step 5) is the only doc needing an update.
- TDD order is 3 cycles: (1) `test:` add `McpTargetList` + tests, (2) `refactor:` rewrite dispatch, (3) `docs:` mark roadmap Step 5 done.
  Next step is `/tdd-plan`.

## Stage: Implementation — TDD (2026-06-02T17:10:00Z)

### Session summary

Completed all 3 TDD cycles from the plan: (1) exported `McpTargetList` class with 6 focused unit tests, (2) rewrote `createMcpPermissionTargets`, `pushMcpToolPermissionTargets`, and `addDerivedMcpServerTargets` to construct and tell an `McpTargetList` instead of threading a `pushTarget` callback, (3) updated `docs/architecture/architecture.md` to mark Finding 4 and Step 5 as ✅ resolved.
Test count rose from 1753 to 1759 (+6 new `McpTargetList` invariant tests).
All deterministic checks (check, lint, test, fallow dead-code) passed throughout.

### Observations

- No deviations from the plan.
  The two private helpers (`addDerivedMcpServerTargets`, `pushMcpToolPermissionTargets`) already accepted a `pushTarget` callback, making the swap to an injected `McpTargetList` mechanical — exactly as anticipated.
- `toArray()` returning a defensive copy (`[...this.targets]`) was confirmed safe: the sole consumer (`input-normalizer.ts`) spreads the result, so the copy is behavior-invisible.
- Pre-completion reviewer: **PASS**.
  One WARN noted: the stepdown ordering in `src/mcp-targets.ts` has private helpers listed above the exported caller (`createMcpPermissionTargets`) — this is pre-existing (not introduced by this PR) and left for a future cleanup.
- Next step is `/ship-issue #318`.

## Stage: Final Retrospective (2026-06-02T22:09:04Z)

### Session summary

Shipped the `McpTargetList` value-object extraction across three stages (Planning → TDD → Ship) with zero deviations and a PASS pre-completion review.
The `pushTarget` closure in `src/mcp-targets.ts` was replaced by an exported value object owning the ordered-uniqueness invariant; the per-mode dispatch now tells the list instead of asking the array via `includes`.
CI landed green on `efee1b20`, issue #318 was closed, and no release-please PR appeared (expected — the change is `refactor:`/`test:`/`docs:` only, no `feat:`).

### Observations

#### What went well

- The single planning `ask_user` gate (export `McpTargetList` + direct tests vs. keep module-private) was the one genuine judgment call, and resolving it up front shaped the TDD order — it added the dedicated Step 1 red→green cycle that documents the invariant in isolation.
  A small, well-placed decision gate paid off downstream.
- Verification ran incrementally rather than only at the end: green baseline (`check`/`lint`/`test`) before any code, per-file `vitest run test/mcp-targets.test.ts` after each red and green, then the full suite + `check` + `lint` + `fallow dead-code` after the last step.
  The red phase was genuinely observed (6 failures: `McpTargetList is not a constructor`) before implementing — a real TDD loop, not a retrofit.
- Scope discipline held: the pre-completion reviewer flagged a pre-existing stepdown-ordering WARN (private helpers above their exported caller), and it was correctly left alone rather than opportunistically fixed inside a behavior-preserving refactor PR.

#### What caused friction (agent side)

- `other` — the `test:` (`6d4da354`) and `refactor:` (`f527ba7c`) commit subjects omitted the `(#318)` issue ref, while the surrounding `docs:` commits carried it.
  These followed the plan's suggested commit messages verbatim, which themselves lacked the ref.
  Impact: minor — at ship time the `git log --grep='#318'` filter missed two commits, so the close-comment commit list had to be built from the push range (`d509e960..HEAD`) instead.
  No rework, no wrong artifact; the `git push` output already gave the exact range.

#### What caused friction (user side)

- None.
  User involvement was limited to the one planning decision gate and stage transitions; no mid-stage corrections or redirects were needed.

### Diagnostic details

- **Model-performance correlation** — one subagent dispatch (`pre-completion-reviewer`) ran on judgment-heavy review work (acceptance criteria, code design, conventional commits, Mermaid render check) and returned a thorough, correctly-scoped PASS with one accurate pre-existing WARN.
  Appropriate task/model match; no mismatch.
- **Feedback-loop gap analysis** — no gap.
  Verification was incremental at every step (baseline before TDD, per-file after each red/green, full gate after the last step); nothing was deferred to the end that should have run earlier.
- **Escalation-delay / unused-tool** — not applicable; no `rabbit-hole` or `missing-context` friction points arose.

### Changes made

1. Appended this Final Retrospective entry to `packages/pi-permission-system/docs/retro/0318-introduce-mcp-target-list.md`.
   No `AGENTS.md` or `.pi/prompts/` changes — the session surfaced no friction justifying a rule change (the one cosmetic commit-ref gap is self-healing via the ship flow's push-range recovery).
