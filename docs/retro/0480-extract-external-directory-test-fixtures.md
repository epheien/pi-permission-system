---
issue: 480
issue_title: "pi-permission-system: extract shared fixtures for the external-directory tests (Phase 6 Step 8)"
---

# Retro: #480 — Extract shared fixtures for the external-directory tests

## Stage: Planning (2026-06-26T00:00:00Z)

### Session summary

Planned the extraction of a shared `test/helpers/external-directory-fixtures.ts` for the external-directory handler-pipeline tests (Phase 6 Step 8).
Scoped the fixture to two files — `external-directory-integration.test.ts` and `external-directory-session-dedup.test.ts` — and explicitly excluded the third file the issue named.
The plan is a behavior-preserving `test:`-only refactor across two lift-and-shift commits plus a verification step, targeting package duplication ≤ 6.5% (currently 7.1%).

### Observations

- **File 3 (`test/bash-external-directory.test.ts`) dropped from scope** (operator decision via `ask_user`).
  It tests a different surface — the pure `extractExternalPathsFromBashCommand` function that runs *before* the gate, not the collapsed gate.
  Its bulk is the repeated system-under-test call, which the `testing` skill says not to wrap to chase a clone metric. fallow confirms it is not in the duplication families; its "880-line arrow" is a unit-size smell, not a clone family.
  No follow-up filed.
- **Discrepancy between issue and fallow:** the issue cites `test/bash-external-directory.test.ts`, but fallow's `bash-external-directory.test.ts` clone family is a *different* file under `test/handlers/gates/`.
  This reinforced that File 3's listed smell is size, not duplication.
- **The ~288 lines of clones in Files 1 & 2 alone hit the ≤ 6.5% target** — so excluding File 3 does not jeopardize the roadmap outcome.
- **No-speculative-export constraint shaped the TDD order:** each migration commit lands the fixture pieces *and* their sole consumer together, so no fixture-only commit leaves dead exports for fallow to flag.
- **Invariant guard:** the dedup `check(intent)` mock (`makeExtDirDedupCheck`) must preserve `intent.kind === "path-values"` dispatch ([#478] / [#418]) or external-directory false-greens to `allow`; moved verbatim, and the re-prompt assertions catch a regression.
- **Release nuance:** roadmap tag is `Release: independent`, but a `test:`-only change is `hidden: true` and will not cut a release on its own — it auto-batches into the next release.
  Recorded in the plan's Release Recommendation rationale.

[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#478]: https://github.com/gotgenes/pi-packages/issues/478

## Stage: Implementation — TDD (2026-06-26T21:30:00Z)

### Session summary

Completed all three TDD steps in a single session across two lift-and-shift commits.
Created `test/helpers/external-directory-fixtures.ts` and migrated both handler-pipeline test files onto it, dissolving the 43-line wiring duplicate in the session-dedup file's inline shutdown test.
Package duplication dropped from 7.1% to exactly 6.5% — the roadmap Step 8 target.

### Observations

- **Duplication hit exactly 6.5%** — the two major clone families (21 groups/214 lines and 3 groups/74 lines) no longer appear as top-level families in `pnpm fallow dupes`.
  Residual clones (17 groups/133 lines in the integration file; 2 groups/14 lines in the dedup file) are the test-act repetitions the `testing` skill says not to wrap.
- **`pi-autoformat` converted `makeEvents` to `type makeEvents`** in the first fixture write (correctly: only used in a type position at that point).
  Adding `makeDedupWiring` in Step 2 reintroduced a value-position use of `makeEvents`, so the import had to be changed back to a value import.
  The `Edit` approach for the Step 2 update handled this cleanly in the imports edit.
- **`makeSessionApprovingPrompter` kept private** — not exported, since File 2 never uses it directly; `makeDedupWiring` builds the default prompter internally.
  This avoids a fallow dead-export flag while keeping the approval semantics encapsulated.
- **Event-shape preservation** — File 2 uses `toolName:` (not `name:`) in event literals; the new `makeExtDirToolEvent` / `makeExtDirBashEvent` builders match that shape exactly so `getToolNameFromValue` behavior is unchanged.
- **Pre-completion reviewer verdict: WARN** (non-blocking).
  All WARN items are `architecture.md` roadmap markers (`✅` on Step 7 + Step 8 headings and Mermaid nodes, Track C flip to `✅ complete`, Step 8 `Target:` description update to remove the scoped-out `bash-external-directory.test.ts`) — all explicitly deferred to ship time per the plan.

## Stage: Final Retrospective (2026-06-26T22:15:00Z)

### Session summary

Shipped #480 across a clean three-stage arc (plan → TDD → ship): the shared `external-directory-fixtures.ts` landed, both handler-pipeline test files migrated, package duplication hit the 6.5% target exactly, and Phase 6 of the `pi-permission-system` roadmap completed.
The one recurring friction — surfaced across this issue and #479 — is that the roadmap-completion `✅` marker keeps getting deferred to ship time, where it either falls through entirely (#479) or lands as a post-CI commit that triggers a second CI cycle (#480).

### Observations

#### What went well

- **`ask_user` File-3 scoping caught a real divergence (novel win).**
  The issue's "Proposed change" named three files; the planning `ask_user` gate surfaced that `test/bash-external-directory.test.ts` tests a different surface (the pure path-extraction function) whose bulk is the SUT-call act the `testing` skill says not to wrap.
  Scoping it out up front prevented wasted migration work and still hit the duplication target from Files 1 & 2 alone.
- **Prediction accuracy.**
  The plan predicted duplication would drop to ≤ 6.5% from Files 1 & 2 alone; it landed at exactly 6.5%, and the test count was unchanged (2124 → 2124) as designed for a behavior-preserving refactor.
- **Incremental verification (no feedback-loop gap).**
  The TDD stage ran the affected file plus the full suite after each of Steps 1 and 2, then `check` / `lint` / `dead-code` / `fallow dupes` before finishing — verification was paced per-change, not deferred to the end.

#### What caused friction (agent side)

- `instruction-violation` (self-identified, but recurring) — the **roadmap-completion `✅` marker was deferred to ship time** instead of landing in the implementation doc-update commit (`/tdd-plan` step 7).
  The package skill says to mark it "as part of the shipping change ... using the completion-marker convention from the implementation prompts ... do not leave it for a later session" — an internally contradictory phrasing that two consecutive planning sessions (#479 and #480) both read as "defer to `/ship-issue`."
  Impact: #479's ship never applied its `✅` (it fell through — the `/ship-issue` prompt has no step for it), so #480's ship had to clean up both issues' markers in a separate post-CI commit (`92f9fc99`), triggering a **second full push + CI cycle (~150 s)**.
  This is the dominant cross-session pattern and the only finding worth a guidance change.
- `other` (minor) — two `architecture.md` `Edit` `oldText` match failures during ship, because the replacement text was constructed from the plan's quoted prose rather than the live file (the roadmap heading read `Split the` with backticks, not `Split`).
  Impact: two extra `Read` calls and one retry; recovered immediately by reading the exact region.
  No rework beyond the retries.

#### What caused friction (user side)

- None.
  The operator's only interactive input was the planning `ask_user` File-3 scoping decision, which was strategic and well-timed.

### Diagnostic details

- **Model-performance correlation** — the sole subagent dispatch (`pre-completion-reviewer`) ran on `anthropic/claude-sonnet-4-6`, appropriate for judgment-heavy review; it produced an accurate WARN (correctly flagging the deferred `✅` items and the `dead-code` self-consumption nuance).
  Main work ran on opus.
  No mismatch.
- **Escalation-delay tracking** — no rabbit-holes; the longest retry sequence was the two `architecture.md` edit attempts, well under the 5-call threshold.
- **Feedback-loop gap analysis** — none; verification ran incrementally (see "What went well").

### Changes made

1. `.pi/skills/package-pi-permission-system/SKILL.md` — reworded the roadmap-completion guidance: the `✅` step/Mermaid marker (plus stale health-metric/target rows) now lands in the implementation doc-update commit (`/tdd-plan` step 7 / `/build-plan`), not a deferred `/ship-issue` commit.
   Added a `Refs #479, #480` justification.
