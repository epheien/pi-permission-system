---
issue: 581
issue_title: "pi-permission-system: decision record for the case-by-case model judge (ModelTriageAuthorizer)"
---

# Retro: #581 — decision record for the case-by-case model judge (ModelTriageAuthorizer)

## Stage: Planning (2026-07-14T00:00:00Z)

### Session summary

Planned Phase 11 Step 7: a documentation-only ADR (`docs/decisions/0007-model-triage-authorizer.md`) recording the six settled `ModelTriageAuthorizer` parameters (ask-only surface, decorator shape, fail-closed delegation, `origin: "authorizer:model"` audit tagging, live-only non-persistence, ruleset-expressible bounded delegation).
The design was already fully settled in the architecture doc's `Discriminating delegation` section; the plan transcribes it into an ADR, marks Step 7 complete, and leaves [#472] open with a linked ADR.
Next stage is `/build-plan` (no test cycles).

### Observations

- Authored by the operator (`gotgenes`) and unambiguous (settled architecture-doc design), so the `ask-user` gate was skipped.
- One genuine design choice existed — non-persistence as live-only vs. quarantined-for-review.
  Settled as **live-only** (matching the architecture doc's stated preference; quarantine is parenthetical there), with quarantine recorded as a rejected-for-now alternative and a named future extension.
- Flagged an implementation seam deferred to [#472]: a model grant is non-persistent, so `origin: "authorizer:model"` may ride the review-log entry rather than the `RuleOrigin` enum (unlike `"yolo"`, which becomes a real `Rule`).
  The ADR settles the *decision* (audited + distinguishable); the mechanism is [#472]'s.
- `Release: independent` per the roadmap — docs-only `docs:` commits, no batch, cuts no release on its own.
- Grep confirmed `ModelTriageAuthorizer` appears only in `architecture.md` — no `src/`/`test/`/README surface references the not-yet-built symbol, so no code or user-doc edits are in scope.
- Build stage must mark Step 7 `✅` on both the heading and the `S7` Mermaid node, and link the ADR from the `Discriminating delegation` section, in the implementation commit (not deferred to ship).

## Stage: Implementation — Build (2026-07-14T00:00:00Z)

### Session summary

Executed the docs-only plan in three commits: authored `docs/decisions/0007-model-triage-authorizer.md` (the six settled parameters, rejected alternatives, accepted limitations), marked Phase 11 Step 7 `✅` (heading + `S7` Mermaid node) with an ADR link in the `Discriminating delegation` section and a refreshed [#472] deferral reference, then reconciled a stale non-persistence parenthetical the pre-completion reviewer flagged.
No `src/`/`test/` changes; `pnpm run lint` and `rumdl` green throughout.
Next stage is `/ship-issue`.

### Observations

- Pre-completion reviewer: **WARN** (1 non-blocking finding), now resolved.
  Reviewer warning: the architecture doc's `Discriminating delegation` non-persistence bullet still offered `(or is persisted quarantined for human review)`, which ADR 0007 §5 explicitly rejects — fixed in commit `a9831a4a` (`it stays live-only, per ADR 0007`).
  This was exactly the cross-doc consistency the plan's `Invariants at risk` section named; the parenthetical lived at line 627, outside the section the plan's grep targeted.
- Deviation from plan scope: **Phase 11 close deferred.**
  All 7 Phase 11 steps are now `✅`, but the plan scoped this build to marking Step 7 only.
  Flipping the Phase 11 heading to `(complete)` and extracting its details to a `history/phase-11-*.md` file (the pattern Phases 9–10 follow) is a distinct phase-close activity the plan did not include — now unblocked as a follow-up, best done at `/retro` or a dedicated phase-close pass.
- Step 3 (comment on [#472] linking the ADR) is deferred to `/ship-issue` per the plan — no code change.
- Mermaid `S7` node render verified by the reviewer (`mmdc` rendered all 4 diagrams cleanly).

## Stage: Final Retrospective (2026-07-14T23:11:31Z)

### Session summary

The plan/build/ship stages took Phase 11 Step 7 from plan through ship, authoring ADR 0007 by transcribing the architecture doc's settled `ModelTriageAuthorizer` prose and marking the roadmap step `✅`.
The retro then reversed all of it: the operator pointed out that #581 was a *decision-making* task and I had treated it as *transcription*, and a live design conversation surfaced two concrete use cases (auto-denying errant typo paths; adjudicating opaque bash) that revealed the real design is broader than — and in one respect contradicts — the prose I had committed.
Outcome: ADR 0007 and the Step 7 completion were reverted, [#581] was reopened and closed `not_planned` as superseded, and [#591] was filed capturing the tool-augmented, deny-first, extensible design for `/plan-issue`.

### Observations

#### What went well

- **Scope discipline at the phase boundary.**
  The build stage recognized that completing Step 7 finishes all 7 Phase 11 steps, but deliberately did *not* scope-creep into the phase-close (heading `(complete)` + `history/phase-11-*.md` extraction).
  It flagged the close as a follow-up, and the ship stage correctly routed it to `/finish-phase` — the archival is a distinct activity, not an implicit rider on the last step.
- **Release attribution was precise.**
  The ship stage did not trust the plan's `Release: ship independently` marker blindly — it checked `exclude-paths` and correctly concluded that `docs/decisions` + `docs/architecture` changes cut no release, skipping the release-please merge.
  The two axes (roadmap batching vs. whether a release physically cuts) were kept distinct.
- **The pre-completion reviewer earned its keep on a docs-only change.**
  It rendered all four Mermaid diagrams, ran the deterministic gates, and caught the one real defect — validating that the reviewer is worth dispatching even when no code changed.
- `wrong-abstraction` (headline) — I treated a decision-record task as a transcription task.
  Because the architecture doc already articulated six `ModelTriageAuthorizer` parameters, planning judged the design "settled" and skipped the `Decide` / `ask-user` gate, then build reformatted the prose into ADR shape.
  But an ADR's entire value is the deliberation behind it; #581 was asking me to *think*, not to reshape existing text.
  Impact: a full plan→build→ship cycle (6 commits, a closed issue, a roadmap `✅`) landed on `main` and then had to be reverted.
  Not caught by any deterministic gate — the ADR was internally consistent and faithful to the prose; only the operator's judgment caught that the prose itself was the wrong input.
- `premature-convergence` — the one design choice I *did* notice as open (non-persistence: live-only vs. quarantine) I resolved unilaterally by deferring to the architecture doc's parenthetical lean, rather than surfacing it.
  The conversation showed the real forks were far larger (deny vs. allow verdict range; tool-augmented vs. verdict vs. classifier; in-package vs. extensible) — none of which I put to the operator before committing.
- `missing-context` (secondary, now moot) — the build missed the quarantine parenthetical at `architecture.md:627` when reconciling the `Discriminating delegation` section, costing a pre-completion `WARN` round and a follow-up commit (`a9831a4a`).
  A downstream symptom of the same root cause; the whole ADR is now reverted, so the specific miss no longer matters.

#### What caused friction (user side)

- **Bidirectional-feedback opportunity, not a fault.**
  The operator's redirection was the pivotal intervention of the session — but it landed at `/retro`, after a full cycle had shipped.
  The two use cases that reframed everything (errant paths; opaque bash) were context the operator held from the start; had the `Decide` gate not been skipped, an `ask-user` at plan time would have surfaced them before any commit.
  The lesson is on the agent side (don't skip the gate for a decision-record issue), but the earliest-possible unlock was a plan-time conversation.

### Diagnostic details

- **Model-performance correlation** — One subagent dispatched: `pre-completion-reviewer` (187.9s, 25 tool uses) on a judgment-appropriate task (ADR fidelity, Mermaid render, doc consistency).
  No mismatch.
  `tidy-first-assessor` was correctly skipped (docs-only).
  Planning dispatched no Explore/Plan subagents — but this was a *symptom* of the root error, not a virtue: I accepted `architecture.md`'s prose as settled instead of probing whether the decisions held, so no exploration felt necessary.
- **Escalation-delay tracking** — No rabbit holes.
  The one lint issue (MD057 forward-reference link to the not-yet-created ADR, at plan time) was resolved in a single edit (link → code span).
  No sequence exceeded 1 tool call on any error.
- **Unused-tool detection** — the tool left unused at plan time was `ask-user` itself: the `Decide` gate exists precisely to surface open design choices, and skipping it (not a too-narrow grep) is the true root cause.
  The secondary grep miss at `architecture.md:627` was preventable with `grep -n "quarantine\|live-only\|non-persist" architecture.md`, but it is moot now that the ADR is reverted.
- **Feedback-loop gap analysis** — `rumdl`/`lint` ran incrementally after each doc edit in every stage; the pre-completion reviewer ran once at the end per protocol.
  No end-loaded-verification gap.

### Changes made

1. Deleted `packages/pi-permission-system/docs/decisions/0007-model-triage-authorizer.md` (the premature ADR).
2. Reverted `packages/pi-permission-system/docs/architecture/architecture.md`: un-`✅`'d Phase 11 Step 7 (heading + `S7` Mermaid node, now noting supersession by [#591]), removed the ADR-link sentence from `Discriminating delegation`, restored the original non-persistence parenthetical, rewrote the [#472] sweep-disposition to record the revert, and added the `[#591]` reference-link definition.
3. Filed [#591] (`pi-permission-system: design the model-assisted permission judge`) capturing both use cases and the tool-augmented / deny-first / extensible architecture; supersedes [#581], design gate for [#472].
4. Reopened [#581] and closed it `not_planned` with a superseded-by-[#591] comment; added a design-gate pointer comment on [#472].
5. Added a decision-record/ADR carve-out to `.pi/prompts/plan-issue.md`'s `Decide` gate: do not skip the `ask-user` gate just because a design is already written down (Refs #581).
6. Wrote this Final Retrospective entry.
