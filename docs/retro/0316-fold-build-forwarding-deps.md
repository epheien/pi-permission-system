---
issue: 316
issue_title: "Fold PermissionPrompter.buildForwardingDeps() into the injected forwarder"
---

# Retro: #316 — Fold `PermissionPrompter.buildForwardingDeps()` into the injected forwarder

## Stage: Planning (2026-06-02T17:34:23Z)

### Session summary

Produced the implementation plan for Phase 3, Step 3 of the package roadmap — the second issue in the forwarding lift-and-shift (#315 → #316 → #317).
Confirmed #315 has landed (`PermissionForwarder` + `InboxProcessor` exist, `requestApproval` already present but unused by production).
The plan injects the single forwarder into `PermissionPrompter` via a new narrow `ApprovalRequester` seam, deletes `buildForwardingDeps()` and its second `PermissionForwardingDeps` synthesis, and narrows `PermissionPrompterDeps` from 7 fields to 4.

### Observations

- Decided `ApprovalRequester` lives in `permission-forwarder.ts` next to `InboxProcessor`, mirroring the #315 seam convention — the prompter imports the type, never the concrete `PermissionForwarder` (design-review check 1/6 satisfied: no test casts, every remaining dep field is read).
- Identified one genuine behavioral nuance worth flagging, not an ambiguity: the deleted `buildForwardingDeps()` supplied a **no-op `writeDebugLog`** and `shouldAutoApprove: () => false`, whereas the shared forwarder carries the real `runtime.writeDebugLog` and yolo policy.
  `shouldAutoApprove` is inert on the `confirmPermission` path (never invoked there), but the real `writeDebugLog` means the subagent forwarding path now emits debug-level log lines it previously swallowed.
  Treated as the intended resolution of the "trace-level forwarding debug deferred" open question from #315, so no `ask_user` was needed — the issue's proposed change is otherwise unambiguous.
- Concluded the change is **one atomic TDD cycle**: narrowing `PermissionPrompterDeps` and removing `buildForwardingDeps()` break `index.ts` (excess properties) and the prompter test (missing `forwarder`) at the type level simultaneously, so production + `index.ts` wiring + test migration cannot be split.
  The test migration is mechanical (swap `mockConfirmPermission` module mock → injected `mockRequestApproval`, shift argument matchers by one position), not a logic rewrite, so the single-step constraint on large test files does not bite.
- Doc-update scope: `docs/architecture/permission-prompter.md` (deps interface, "Relationship to PermissionForwardingDeps" section, wiring) plus marking Phase 3 Step 3 `✅` in `architecture.md` — folded into a separate `docs:` commit following the #315 precedent.
- Commit types: cycle 1 is `refactor:` (behavior-preserving), cycle 2 is `docs:`.

## Stage: Implementation — TDD (2026-06-02T18:07:18Z)

### Session summary

Completed both TDD cycles in one session.
Cycle 1 swapped the prompter onto the injected `ApprovalRequester` seam: added the interface to `permission-forwarder.ts`, narrowed `PermissionPrompterDeps` from 7 to 4 fields, replaced the `confirmPermission(…, this.buildForwardingDeps(), …)` call with `this.deps.forwarder.requestApproval(…)`, deleted `buildForwardingDeps()` and all orphaned imports, rewired `index.ts` to construct the forwarder before the prompter, and migrated `permission-prompter.test.ts` from the polling module mock to an injected `mockRequestApproval`.
Cycle 2 updated `permission-prompter.md` (4-field deps, new "Relationship to the forwarder" section, wiring snippet) and marked Phase 3 Step 3 `✅` in `architecture.md`.
Test count: unchanged at 1756 (no net additions — the prompter suite is the same 21 tests, now with a simpler mock surface).

### Observations

- The two independent edits to `permission-prompter.ts` (imports + interface, and the `confirmPermission` call body) were applied in two separate `Edit` calls after the first batch unexpectedly required re-inspection — the first `Edit` call targeting three changes only applied the `buildForwardingDeps()` deletion, leaving imports and interface unchanged.
  Root cause: the autoformatter ran between tool calls and the stored file state diverged from what the first multi-edit expected.
  Resolution: re-read the file, applied the two remaining edits individually; no extra commits needed.
- Red phase verified: 15/21 tests failed after the test migration but before the production changes landed (polling module unmocked, `mockRequestApproval` never called by the old `confirmPermission` path).
- The argument-position shift (dropping the deps-bag positional argument) was mechanical and caught cleanly by test failures during the red phase — no stale matchers survived to green.
- `composition-root.test.ts` stayed green without modification: the forwarder-before-prompter reorder in `index.ts` did not perturb any wiring expectation.
- Pre-completion reviewer: **PASS** — all deterministic checks green, conventional commits verified, docs forward/reverse staleness clean, code design pass, 6 Mermaid diagrams parsed without errors.

## Stage: Final Retrospective (2026-06-02T18:11:49Z)

### Session summary

Delivered Phase 3, Step 3 of the roadmap (#316) across three stages — plan, two-cycle TDD (`refactor:` + `docs:`), and a `PASS` pre-completion review — then began shipping.
The forwarder injection landed clean (`PermissionPrompterDeps` narrowed 7 → 4 fields, `buildForwardingDeps()` deleted, test count steady at 1756).
During the ship stage the commits were pushed to `main` and CI was started, but the user interrupted to **batch the release with #317** rather than release #316 on its own — so the issue stays open and no release-please PR was merged.

### Observations

#### What went well

1. The #315 retro served as an effective cross-session context bridge: the `ApprovalRequester`-next-to-`InboxProcessor` seam placement, the atomic-single-cycle conclusion, and the `rumdl`-not-`markdownlint` enforcer note were all carried forward into planning without re-deriving them.
2. The incremental verification loop was textbook: red verified per-file (15/21 failing), green per-file, `check` after the interface change, full suite, `lint`, then `fallow dead-code` — no late surprises, and the pre-completion reviewer returned `PASS` on the first dispatch.
3. The behavioral nuance (real `writeDebugLog` replacing the no-op on the subagent forwarding path) was identified at planning time and flagged as intended convergence, so it never surfaced as a surprise during TDD or review.

#### What caused friction (agent side)

1. `other` (tooling) — the first multi-edit `Edit` call on `permission-prompter.ts` failed atomically because one edit (`edits[3]`, the `// ── Private helpers ──` em-dash separator block) did not match, so **none** of its four edits applied; a follow-up narrower `Edit` then deleted `buildForwardingDeps()`, and the agent proceeded as if the imports/interface/call-body edits had also landed.
   `pnpm run check` caught the gap (three `forwarder does not exist` errors) before any commit.
   Impact: ~2 extra `Edit` calls and one re-read; no wasted commits, no rework after commit.
   Lesson: when an `Edit` call returns an error, treat **all** its edits as unapplied and re-read before continuing — a multi-edit call is all-or-nothing.

#### What caused friction (user side)

1. The release-batching decision for the #315 → #316 → #317 lift-and-shift surfaced only after the ship stage had already pushed and started CI.
   The signal was available earlier — the plan frontmatter and body explicitly frame #316 as "step 2 of 3" — but `ship-issue.md` reads only commit subjects, not the plan, so it charged toward close + release-PR merge without pausing.
   Opportunity: a checkpoint after CI passes but before the irreversible close/merge steps, triggered when the issue belongs to a stacked sequence, would let the batch-vs-release-now decision be made without an interrupt.
   Impact: minimal — one user interrupt, a cancelled `ci_watch` (~15s), no rework; the push itself was correct and unavoidable.

### Diagnostic details

- **Model-performance correlation** — the only subagent dispatch was the `pre-completion-reviewer` (233s, 26 tool uses) for judgment-heavy acceptance/design review; model class appropriate, no mismatch.
  The parent session bounced across `claude-opus-4-8`, `claude-sonnet-4-6`, and `deepseek-v4-flash` between stages, but no judgment-heavy step (planning design decisions, the atomic-cycle call) showed degraded output attributable to the lighter model.
- **Feedback-loop gap analysis** — no gap; `check`/`test`/`lint`/`fallow` ran incrementally after each change, not only at the end.
- **Escalation-delay / unused-tool** — no `rabbit-hole` or `missing-context` friction; the `Edit`-tool hiccup was 2–3 tool calls, well under the 5-call escalation threshold.

### Changes made

1. Added a `## 4b. Check for a stacked release` checkpoint to `.pi/prompts/ship-issue.md`, between CI verification (step 4) and closing the issue (step 5): when the plan frames the issue as part of a multi-issue sequence, ask once whether to release now or batch, and skip the close/merge steps if batching.
