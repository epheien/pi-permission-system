---
issue: 591
issue_title: "pi-permission-system: design the model-assisted permission judge (tool-augmented, deny-first, extensible)"
---

# Retro: #591 — design the model-assisted permission judge (tool-augmented, deny-first, extensible)

## Stage: Planning (2026-07-15T15:59:02Z)

### Session summary

Planned Phase 11 Step 7 as `docs/plans/0591-model-judge-authorizer-chain-adr.md`: a documentation-only ADR (0007) settling the full design of the model-assisted permission judge across both use cases (auto-deny errant typo paths; adjudicate opaque bash), superseding the reverted [#581] ADR.
The design was settled interactively over four `ask_user` rounds rather than transcribed — this is the [#581] carve-out (a decision-record issue's deliberation *is* the deliverable, so the `Decide` gate is not skipped).
Next stage is `/build-plan` (no test cycles).

### Observations

- The operator's Chain-of-Responsibility mental model reframed and *improved* my initial "terminal leaf + decorators" framing: one role (`Authorizer` = decide-or-defer), one invariant (the terminal cannot defer, enforced at the type level via a distinct `TerminalAuthorizer` returning only `allow | deny`).
  The verdict range is `allow | deny | defer` — a superset of the reverted ADR's ask-only allow-or-escalate, driven by use case 1 being deny-first.
- Three of my design pushbacks were accepted over the operator's first-pass preferences: (1) inject a narrow session-scoped `PermissionQuery` into each link rather than have the judge reach for `PermissionsService` via `Symbol.for()` (LoD/ISP); (2) split config so this package owns only the bounded-delegation policy it enforces and the downstream extension owns model/provider/prompt (the "declared-but-unread config is a trap" priority); (3) opt-in activation — `registerAuthorizer(name, fn)` only *offers* a capability, and a link decides nothing until the operator names it in `authorizerChain`, so installing an extension grants no authority by itself.
- Key security invariants recorded in the plan: config order (not registration order) is authoritative for the security-relevant chain order; skipping any unregistered non-terminal link is always fail-safe (more prompting, never less); the bounded-delegation enforcement checkpoint lives in the chain owner, so a buggy external judge cannot exceed policy.
- Two-slice sequencing is a capability gradient on one `ModelTriageAuthorizer` link, not two mechanisms: slice 1 (`deny`/`defer`, always safe, minimal envelope) ships first; slice 2 adds `allow` behind the full envelope, whose residual risk is decomposition infidelity (obfuscation).
- `Release: independent`, but docs-only across `docs/decisions` + `docs/architecture` (release-please excluded paths), so it cuts no physical release on its own — the same distinction [#581] drew.
- `ModelTriageAuthorizer` was grep-confirmed to live only in `docs/` (live architecture doc plus frozen history/plans/retros); no `src/`/`test/`/README/config/schema surface references the not-yet-built symbols, so the plan is docs-only.
- Filed no follow-up issues: [#472] stays the implementation umbrella carrying the ADR; the next `/plan-improvements` pass sequences its decomposition (chain infra, slice 1, slice 2) plus the dogfood extension into roadmap steps and files the extension issue there.
- A post-commit amendment recorded the operator's **dogfooding objective**: slice 1 is accepted by a first-party monorepo package (e.g. `packages/pi-permission-model-judge`) implementing the deny-first typo-path reviewer — a design safeguard making `registerAuthorizer` born consumed (the `#267` vacant-surface guard) and exercising the config split end to end.
  Settled via `ask_user`: monorepo package (not external repo); issue filed by `/plan-improvements`, not now.
- The build stage's chief risk is the [#581] failure mode: an internally consistent ADR that contradicts un-reconciled architecture-doc prose.
  The plan's `Invariants at risk` section prescribes a whole-file grep (`ask-only|allow-or-escalate|escalate|ModelTriageAuthorizer|quarantine`) rather than a single-section sweep, since [#581] missed a parenthetical at line ~627 by targeting one section.

## Stage: Implementation — Build (2026-07-15T16:51:03Z)

### Session summary

Executed the docs-only plan in two commits: authored `docs/decisions/0007-model-judge-authorizer-chain-adr.md` (the Chain-of-Responsibility model judge — `allow | deny | defer` verdict, type-level non-deferring terminal, injected `PermissionQuery`, opt-in named `registerAuthorizer`, config split, two-slice gradient, dogfooding as slice-1 acceptance), then reconciled `architecture.md` (rewrote `Discriminating delegation`, subsumed the pluggable-escalation seam, reconciled the recursion/aspirational passages, marked Phase 11 Step 7 `✅` on both the heading and the `S7` Mermaid node with the ADR linked).
No `src/`/`test/` changes; `rumdl`, `lint`, `check`, `test`, and `fallow dead-code` all green; the four Mermaid diagrams render under `mmdc`.
Next stage is `/ship-issue`.

### Observations

- Pre-completion reviewer: **WARN** (1 non-blocking finding).
  Reviewer warning: the plan's Open Questions names the dogfood-extension follow-up but it carries no recorded issue number — an intentional, explicitly-reasoned deferral to the next `/plan-improvements` pass, not an oversight.
  No action taken; flagged so it is not lost before that pass runs.
- The [#581] failure mode was actively guarded, not just avoided: the reviewer ran the plan's whole-file grep and confirmed the exact reverting miss — the `or is persisted quarantined for human review` non-persistence parenthetical — is gone, along with the `ModelTriageAuthorizer(inner)` decorator framing.
  Remaining grep hits are all intentional (the reconciled chain framing, the explicit `a superset of the earlier allow-or-escalate framing` supersession callout, and the `ModelTriageAuthorizer` anchor label the plan said to leave).
- Deviation from plan scope: **none.**
  Both build steps ran as written; the frozen history/plan/retro files listed in the plan's `Not edited` section were left untouched.
- Phase 11 close (heading `(complete)` + `history/phase-11-*.md` extraction) is deliberately out of scope — all seven steps are now `✅`, but the archival is a distinct `/finish-phase` activity, as with [#581].

## Stage: Final Retrospective (2026-07-15T17:03:07Z)

### Session summary

This single session took [#591] from plan through ship: four `ask_user` rounds derived the model-judge design interactively (Chain of Responsibility, `allow | deny | defer`, type-level non-deferring terminal, injected `PermissionQuery`, opt-in named registration, config split, two-slice gradient), then two docs commits authored ADR 0007 and reconciled `architecture.md` (Step 7 `✅`), and ship closed the issue with no release (all touched paths are release-please-excluded).
The defining outcome: the corrective [#581]'s retro installed — the `/plan-issue` `Decide`-gate ADR carve-out — worked one issue later, converting a task that was reverted-as-transcription into a clean interactive design.

### Observations

#### What went well

- **A retro-driven fix validated itself one issue later (novel win).**
  [#581] shipped a full plan→build→ship cycle and was reverted because it *transcribed* the architecture prose instead of *deciding*; its retro added an ADR/decision-record carve-out to `/plan-issue`'s `Decide` gate (do not skip `ask_user` just because a design is written down).
  This session hit exactly that trigger and ran four `ask_user` rounds instead of transcribing — the plan and ADR landed clean, no revert.
  This is direct evidence the corrective works, and it argues *against* adding more rules here.
- **`ask_user` as a genuine design gate, not a formality.**
  The four rounds produced real bidirectional design: three of my pushbacks were accepted over the operator's first-pass preferences (inject a narrow `PermissionQuery` vs. reach for `PermissionsService`; split config; opt-in activation), and the operator reframed my "terminal leaf + decorators" into a cleaner single-role chain.
  The deliberation an ADR exists to carry actually happened in the dialogue, then flowed into the ADR's rejected-alternatives section.
- **The [#581] failure mode was actively guarded at build, not merely avoided.**
  The plan's `Invariants at risk` prescribed a whole-file grep, and the pre-completion reviewer confirmed the exact reverting miss (the `quarantined for human review` parenthetical and the `ModelTriageAuthorizer(inner)` decorator framing) was gone — closing the loop the earlier miss opened.
- **Clean ship discipline.**
  Ship correctly separated the two release axes: the plan's `Release: ship independently` marker vs. whether a commit physically cuts a release.
  It read `exclude-paths` from `release-please-config.json`, confirmed every touched path (`docs/decisions`/`docs/plans`/`docs/retro`/`docs/architecture`) is excluded, and skipped the release-please merge — matching the same finding [#581] drew.

#### What caused friction (agent side)

- No agent-side friction of note.
  No rabbit holes, no instruction violations, no scope drift; both build steps ran as written with zero deviations; verification was incremental (`rumdl` after each doc edit, package `lint` after each step, `mmdc` render before the reconciliation commit, pre-completion reviewer at the end).

#### What caused friction (user side)

- **Bidirectional-feedback opportunity — the dogfooding objective surfaced post-commit.**
  After the plan and planning-retro were already committed, the operator raised a held-from-the-start objective ("a clear objective I have in mind is that we dogfood this" via a first-party typo-path extension) plus the architecture/`/plan-improvements` handoff question.
  This required a third plan-amendment commit (`4eb4f72f docs: record dogfooding objective in plan for #591`).
  Impact: one extra clean commit (2 files), no rework — but the objective shapes the ADR's Consequences (acceptance criterion for slice 1), so surfacing it during the planning `ask_user` rounds would have folded it into the first plan.
  Not a fault on either side; the earliest-possible unlock was a planning-time "downstream objectives / acceptance criteria" question for a decision-record issue.

### Diagnostic details

- **Model-performance correlation** — one subagent dispatch: the `pre-completion-reviewer` (`anthropic/claude-sonnet-5` per its agent frontmatter), a judgment-appropriate task (ADR cross-doc consistency, Mermaid render, deterministic gates); no mismatch.
  `tidy-first-assessor` was correctly skipped (docs-only).
  The session switched models frequently and was operator-steered (`opus-4-8` ↔ `sonnet-5`, with `deepseek-v4-flash`, `fable-5`, `haiku-4-5` also appearing): ship ran on `sonnet-5` (mechanical git/CI/close — appropriate), and the design/build turns finished on `opus-4-8` (appropriate for architecture judgment).
  No turn-by-turn attribution was done given the switch volume, but no output-quality degradation was observable at any stage.
- **Escalation-delay tracking** — no rabbit holes; no error sequence exceeded 1–2 tool calls (the lone stumble, a `wc -c` double-check of a 40-char SHA, resolved in one call).
- **Unused-tool detection** — none applicable; symbol searches used exact `grep`/`bash` (correct for known tokens like `ModelTriageAuthorizer` and section anchors), not `colgrep`, and the planning code-reads (`authorizer.ts`, `service.ts`, `permissions-service.ts`, targeted `architecture.md` sections) were sufficient to ground the design pushbacks without an Explore dispatch.
- **Feedback-loop gap analysis** — no end-loaded-verification gap; gates ran incrementally in every stage.

### Changes made

1. Appended this Final Retrospective stage entry to `packages/pi-permission-system/docs/retro/0591-model-judge-authorizer-chain-adr.md`.
2. No prompt or `AGENTS.md` change — operator chose observations-only.
   The one candidate (extend `.pi/prompts/plan-issue.md:103` so a decision-record issue also surfaces downstream objectives / acceptance criteria) was rejected as a single-occurrence with minimal impact; the existing [#581] ADR carve-out is validated as working by this session.
