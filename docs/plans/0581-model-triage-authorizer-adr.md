---
issue: 581
issue_title: "pi-permission-system: decision record for the case-by-case model judge (ModelTriageAuthorizer)"
---

# ADR 0007 — decision record for the case-by-case model judge (`ModelTriageAuthorizer`)

## Release Recommendation

**Release:** ship independently

Phase 11 Step 7 is tagged `Release: independent` in the roadmap, and it is not a member of any release batch (the only Phase 11 batch is "shell-tool-aliases": Steps 2, 3).
This is a documentation-only step — a `docs:` ADR plus a roadmap-completion doc update — so it carries no code change and gates nothing.

## Problem Statement

Issue [#472] (a case-by-case model judge beyond `yoloMode`) has been deferred by name in Phases 9 and 10.
The repeat-deferral rule requires an explicit decision this phase rather than a third silent re-defer.
The `ModelTriageAuthorizer` design is already settled in the architecture doc's [Discriminating delegation](../architecture/architecture.md#discriminating-delegation-a-model-authorizer) section; what stands between "designed" and "schedulable" is committing the open parameters to a decision record.

This is documentation only.
It does **not** implement the judge — [#472] stays open, tracking the implementation, and gains a linked ADR.

## Goals

- Write `docs/decisions/0007-model-triage-authorizer.md` recording the settled design parameters of `ModelTriageAuthorizer`:
  - **Decision surface** — ask-only (the judge sees `ask`, never `allow`/`deny`), preserving the deny-preserving boundary.
  - **Shape** — a decorator, `ModelTriageAuthorizer(inner)`, not a fourth channel.
  - **Failure behavior** — fail-closed delegation to `inner` on model-unreachable / timeout / low-confidence, never an auto-allow.
  - **Audit tagging** — a model grant is distinguished in the review log as `origin: "authorizer:model"` (with model version and structured intent), mirroring how yolo grants carry `origin: "yolo"`.
  - **Non-persistence** — a model verdict stays live-only; it does not silently become recorded authority.
  - **Bounded delegation** — which surfaces the model may auto-allow is itself ruleset-expressible, with `external_directory` and secret-shaped `path` rules excluded so they always reach the human.
- Mark Phase 11 Step 7 complete in `docs/architecture/architecture.md` (step heading `✅` + Mermaid node `✅`), and link the new ADR from the `Discriminating delegation` section.
- Leave [#472] open with a comment linking the ADR, so it becomes schedulable in a future phase on its own merits.

This change is **not breaking** — it adds a decision record and a doc-completion marker; no config, schema, behavior, or default changes.

## Non-Goals

- Implementing `ModelTriageAuthorizer` — that is [#472]'s scope, gated on this ADR.
  No `src/` change, no `RuleOrigin` enum extension, no config field, no schema regeneration.
- Deciding the model provider, prompt, confidence-threshold value, or timeout duration — those are implementation parameters for [#472], deliberately left to that issue.
- The non-deterministic access-intent **classifier** (a model shaping the intent before `evaluate()`) — a distinct, more distant direction the architecture doc already flags as warranting its own future ADR.
- Multi-hop escalation, grant-scope selection, and yolo inheritance — already settled in ADRs 0005 / 0006 and the architecture's `Resolved direction` section; the ADR references them but does not re-decide them.

## Background

Relevant existing surfaces:

- `src/authority/authorizer.ts` — the `Authorizer` interface (`authorize(details): Promise<PermissionPromptDecision>`) and `selectAuthorizer`, which picks `LocalUserAuthorizer` / `ParentAuthorizer` / `DenyingAuthorizer` once per session activation.
  The ADR's decorator wraps whichever of these is selected — this is the interface the future `ModelTriageAuthorizer(inner)` implements and composes over.
- `src/rule.ts` — `RuleOrigin` (currently `global | project | agent | project-agent | builtin | baseline | session | yolo`) and `rewriteAsksToYolo`, the composition-stage `ask`→`allow` rewrite tagged `origin: "yolo"`.
  The audit-tagging decision names `"authorizer:model"` as the model-grant analogue; whether that lands as a `RuleOrigin` member or a separate review-log field is an implementation detail deferred to [#472] (a model grant is non-persistent, so it does not necessarily become a `Rule`).
- ADR 0005 (`docs/decisions/0005-serving-authorizer-provenance.md`) — establishes that an `Authorizer` is live authority and never touches `evaluate()`; the non-determinism principle governs recorded authority only.
  This is the precedent the model-judge ADR extends: `LocalUserAuthorizer` is already a non-deterministic oracle (the human), so a model holding the same role is consistent with the existing model.

Constraints from AGENTS.md and the package skill that apply:

- ADR numbering is per-package; next free is `0007` (existing run `0001`–`0006`).
- `docs/architecture/architecture.md` is shipped in the npm tarball allowlist and inline-copies core `rule.ts` types — but this ADR adds no `rule.ts` field, so that listing needs no edit.
- Mark the roadmap step complete in the **implementation** doc-update commit (this build), not a deferred `/ship-issue` commit — `✅` on both the step heading and its Mermaid node.
- Reference GitHub issues in long-lived docs with reference-style links (`[#N]` + a file-scoped `[#N]:` definition).

## Design Overview

This is a documentation change; the "design" is the ADR's decision content and its faithfulness to the settled architecture-doc section.

### ADR structure

Follow the established ADR template (0005 / 0006): YAML frontmatter (`status: accepted`, `date`), `# 0007 — <title>`, then `## Status`, `## Context`, `## Decision`, `## Consequences` (with `### Accepted limitations`), and reference-link definitions.

The `## Decision` section records six settled parameters as numbered decisions:

1. **Ask-only decision surface.**
   The judge sees only `ask`.
   Denies are decided by recorded authority (`evaluate()`) and structurally never reach an `Authorizer`, so the model *cannot* grant a hard deny — the safeguard for a sensitive resource stays an explicit `deny` rule, which survives the model exactly as it survives the yolo rewrite.
   Where yolo rewrites every `ask` to `allow`, the model resolves only the asks it is confident about and escalates the rest: a discriminating, deny-preserving yolo, a middle rung between prompt-everything and allow-everything.

2. **Decorator shape, not a fourth channel.**
   `ModelTriageAuthorizer(inner)` wraps whichever `Authorizer` `selectAuthorizer` produced (`LocalUser` / `Parent` / `Denying`) and implements the same one-method interface.
   It is the recursion "a node's `Authorizer` is its own parent" with the model's parent being `inner`.
   Rejected alternative: a distinct fourth selection channel alongside the three-way dispatch — rejected because it duplicates the escalation wiring the decorator gets for free.

3. **Fail-closed delegation.**
   Model unreachable, timeout, or low confidence delegates to `inner` (the human, `ParentAuthorizer`, or `DenyingAuthorizer`), never an auto-allow.
   Under a headless `DenyingAuthorizer` inner, an uncertain model verdict therefore denies — the fail-safe direction.

4. **Audit tagging.**
   A model grant is distinguished in the review log as `origin: "authorizer:model"`, carrying the model version and the structured intent, mirroring `origin: "yolo"`.
   Note the implementation seam (deferred to [#472]): a model grant is non-persistent, so unlike yolo it does not become a `Rule` in the ruleset — the tag rides the review-log entry / decision source, not necessarily the `RuleOrigin` enum.
   The ADR settles the *decision* (model grants are audited and distinguishable); the mechanism is [#472]'s.

5. **Non-persistence — live-only.**
   A model verdict stays live-only; it does *not* silently become recorded authority.
   Unlike a human's "for this session" ruling, a probabilistic judgment never hardens into durable config.
   Rejected alternative: persist model grants *quarantined* for later human review.
   Rejected for this ADR as added machinery with no present consumer — live-only is the simpler fail-safe default; a quarantine store can be a named future extension if a review workflow ever wants it.

6. **Bounded delegation, ruleset-expressible.**
   Which surfaces the model may auto-allow is itself expressed as ruleset config, with `external_directory` and secret-shaped `path` rules excluded so they always reach the human.
   This keeps the delegation boundary reviewable in the same config the rest of the policy lives in, honoring the package principle "prefer config patterns over new runtime mechanisms."

### Relationship to `evaluate()` and [#509]

The ADR situates the model judge as the ask-*consuming* side of the boundary, distinct from the ask-*producing* side (`evaluate()` and rule-driven promotion, [#509]).
A promoted bare filename (`git grep id_rsa` prompts) is a deliberate fail-safe false positive on the producing side; `ModelTriageAuthorizer` dismisses such a false positive on the consuming side without hard-coding per-command file-argument tables.
The ADR notes this is the principled successor to the per-command argument-position work deferred from [#509], and that the two compose cleanly because a promoted token emits the same structured descriptor a prefixed path does — the `Authorizer` needs no promotion-specific knowledge.

### No new collaborator to sketch

The ADR introduces no code and no runtime collaborator in this change.
The decorator's call site is the existing `selectAuthorizer` return value wrapped as `new ModelTriageAuthorizer(selected)`, exercising the already-shipped one-method `Authorizer` interface — a Tell-Don't-Ask shape (`authorize(details)` returns a decision; the caller does not inspect the authorizer's state).
The concrete wiring is [#472]'s to build and test.

## Module-Level Changes

Documentation only.

- **New:** `packages/pi-permission-system/docs/decisions/0007-model-triage-authorizer.md` — the ADR described in Design Overview.
- **Changed:** `packages/pi-permission-system/docs/architecture/architecture.md`:
  - Mark Phase 11 Step 7 complete: `✅` on the `#### Step 7:` heading and on the `S7[...]` Mermaid node in the step-dependency diagram.
  - Add a link to the new ADR from the `### Discriminating delegation: a model Authorizer` section (a "Decision recorded in ADR 0007 (`docs/decisions/0007-model-triage-authorizer.md`)" note), and update the [#472]/Step-7 deferral references so they point at the recorded decision rather than an open deferral.
  - No edit to the inline `rule.ts` type listing — this change adds no `RuleOrigin` member.
- **No change** to `src/`, `test/`, `schemas/`, `config/`, `README.md`, `docs/configuration.md`, or the package allowlist — the ADR ships via the already-listed `docs/decisions` path, and no user-facing config or command changes.

Grep confirmation performed during planning: `ModelTriageAuthorizer` appears only in `docs/architecture/architecture.md` (design narrative) — no `src/` or `test/` occurrence, no README/configuration mention — so no code or user-doc surface references the not-yet-built symbol.

## Test Impact Analysis

None.
This is a documentation-only change with no test surface — it goes through `/build-plan`, not `/tdd-plan`.
The verification gate is `pnpm exec rumdl check` on the new and edited markdown plus the standard `pnpm run lint` / link-reference checks; the `pre-completion-reviewer` covers Mermaid-diagram validity for the edited node.

## Invariants at risk

None.
No prior phase step's code invariant is touched — the change adds a decision record and a completion marker.
The one cross-doc invariant to preserve is internal consistency: the architecture doc's `Discriminating delegation` narrative and the new ADR must not disagree on any of the six parameters.
The build step verifies this by re-reading both after editing.

## Build Order

This is a docs/config change (no red→green test cycles); execute as an ordered build.

1. **Write the ADR.**
   Create `docs/decisions/0007-model-triage-authorizer.md` per Design Overview.
   Lint with `pnpm exec rumdl check <file>`.
   Commit: `docs(pi-permission-system): record ADR 0007 for the model triage authorizer (#581)`.
2. **Update the architecture roadmap.**
   Mark Step 7 `✅` (heading + Mermaid node), link the ADR from the `Discriminating delegation` section, and refresh the [#472] deferral references.
   Lint the file.
   Commit: `docs(pi-permission-system): mark Phase 11 Step 7 complete and link ADR 0007 (#581)`.
3. **Comment on [#472].**
   Post a comment linking the recorded ADR so the issue is schedulable on its own merits (done at ship time via the normal flow, or noted here for the ship step — no code change).

The two doc commits may be squashed into one if preferred; both are `docs:` (a `hidden` changelog type) and neither cuts a release on its own.

## Risks and Mitigations

- **Risk: the ADR drifts from the settled architecture-doc design.**
  Mitigation: the ADR is transcribed directly from the `Discriminating delegation` section; the build step re-reads both for consistency, and the pre-completion reviewer checks documentation coherence.
- **Risk: over-specifying implementation detail the ADR should leave to [#472].**
  Mitigation: the ADR records *decisions* (surface, shape, failure mode, tagging, persistence, bounds), and explicitly defers mechanism (model choice, threshold values, `RuleOrigin`-vs-log-field) to [#472] in an `Accepted limitations` / open-implementation note.
- **Risk: marking Step 7 complete implies the judge is built.**
  Mitigation: Step 7's `Outcome` is explicitly "carries a linked ADR and becomes schedulable … no code change"; the completion marker and the retained-open [#472] together make the docs-only nature unambiguous.

## Open Questions

- **Audit-tag mechanism** — whether `origin: "authorizer:model"` lands as a `RuleOrigin` enum member or a distinct review-log field is deferred to [#472]; the ADR settles only that model grants are audited and distinguishable.
- **Quarantine persistence** — the ADR settles live-only and records quarantined-for-review as a rejected-for-now alternative; if a human-review workflow later wants it, that is a named future extension, not reopened here.

[#472]: https://github.com/gotgenes/pi-packages/issues/472
[#509]: https://github.com/gotgenes/pi-packages/issues/509
