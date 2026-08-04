---
issue: 595
issue_title: "pi-permission-system: ADR 0008 — forwarded access-intent portability and principal identity"
---

# Retro: #595 — ADR 0008 forwarded access-intent portability and principal identity

## Stage: Planning (2026-07-17T23:56:20Z)

### Session summary

Planned Phase 12 Step 1 (Track A) — a docs-only ADR (`docs/decisions/0008-cross-session-access-intent.md`) that settles the cross-session access-intent contract before Steps 2–3 change the wire.
Because the deliverable is a decision, ran the `ask_user` gate over the three deliberative parameters and confirmed all three with the operator.
Wrote `packages/pi-permission-system/docs/plans/0595-adr-0008-cross-session-access-intent.md` and committed it.

### Observations

- **Three decisions confirmed with the operator** (two `ask_user` rounds — the first surfaced the parameters, the second tightened them after grounding in the code):
  1. **Agent-scoped serving** — `requesterAgentName` graduates from display-only to decision-participating; the parent resolves against its own ruleset scoped to the requester's agent name.
     Clarified the operator's double-apply worry: forwarding up means the child landed on `ask` (unresolved), and the parent applies a *different* ruleset — a strict superset of agent-neutral, no double-application.
  2. **Child-fixed match set** — ship `matchValues()` ∪ `boundaryValue()`; the parent never re-derives through its own `PathNormalizer`/cwd.
  3. **Required field, floor to `ask` on absence** — `ForwardedAccessIntent` is the sole resolution path (legacy `(surface, value)` branch retired in Step 3); a request missing it floors to `ask`, never a hard deny or silent grant.
- **Key grounding finding that resolved the operator's portability uncertainty**: `AccessPath.matchValues()` already carries a **cwd-relative alias** (via `getCwdRelativePathPolicyValues`), not just absolute + canonical.
  So the worktree scenario resolves correctly without re-derivation — a relative parent rule (`src/**`) matches the child's relative alias across cwds, while an absolute rule matches only co-located paths (least privilege).
  Canonicalization does *not* bridge cwds (git worktrees are real dirs, not symlinks); the relative alias is the bridge.
- **Revises ADR 0005** — the "agent-neutral resolution" section of `0005-serving-authorizer-provenance.md` is the exact decision being changed; the ADR must cross-link and state what 0005 behavior is preserved (recorded-authority-first, escalate-`ask`, provenance-on-the-ask).
- **ADR 0002 boundary** — the wire schema carries strings (`matchValues: string[]`), never `AccessPath` instances, keeping the manager string-based.
- **Release**: mid-batch — defer (batch "cross-session-intent", tail = Step 3 / #597).
  Both plan-execution commits are `docs:` (hidden), so this step cuts no release on its own.
- **No follow-up issues filed** — Steps 2 (#596) and 3 (#597) already exist as the implementation of this contract.
- Next stage is `/build-plan` (docs-only, no test cycles).

## Stage: Planning revision (2026-07-18T00:47:18Z)

### Session summary

The operator raised a meta-level doubt — whether the decisions felt hard due to a comprehension gap or a missing reframe — and an advisory dialogue surfaced the unifying principle: **the child owns the facts; the parent owns the judgment**.
The plan was amended (commit `88d2c886`) to restructure the ADR principle-first, add a composition section, and name two explicitly deferred edges.

### Observations

- **The reframe was real, not over-application.**
  The principle retro-explains decisions made independently — ADR 0005's serving-is-resolution (judgment repeats at each node) and ADR 0007's chain (plurality of judges within a node) — and derives all three previously confirmed parameters (child-fixed match set = facts at origin; agent-scoped serving = parent's judgment; `ask` floor = no facts → no judgment → escalate).
  Three independent confirmations distinguished a genuine reframe from a concept stretched too far.
- **The unified model** (validated against `authorizer.ts` / `authorizer-selection.ts`): authorization is a walk up a session tree; at each node an ordered sequence of judges (recorded authority → Track B chain links → terminal) examines the same fixed facts; the only inter-node operation is the courier move (`ParentAuthorizer`), which carries facts and never judgment.
  Key clarification for the operator's mental model: `ask` is *recorded authority's* non-definitive outcome, not an Authorizer's — today each session selects exactly one Authorizer, and every Authorizer answers definitively; the "set of Authorizers that may defer" is the Track B future (ADR 0007), which the operator's intuition anticipated.
- **`ParentAuthorizer` is a courier, not a judge** — it occupies the `Authorizer` slot structurally but exercises no judgment; this explains *why* ADR 0005 made serving re-run resolution.
- **Synergy consequence recorded**: once Tracks A and B both land, a serving node's chain links (e.g. the model judge) review forwarded asks against the child-fixed fact set — honest evidence, not a parent-side re-derivation.
- **Two guards against over-application baked into the plan**: the composition section is descriptive-only (cites `docs/decisions/0007-model-judge-authorizer-chain-adr.md` by path, decides nothing new), and the deferred-edges section names where the model is known-incomplete (single-surface fact set — #565 item 3; multi-hop principal identity).
- **For the `/build-plan` stage**: the ADR's Decision section leads with the principle; the four former "decisions" are now consequences derived from it; the two deferred edges belong in `## Consequences`, not silently omitted.

## Stage: Implementation — Build (2026-07-18T01:00:00Z)

### Session summary

Executed the docs-only plan in two `docs:` commits: wrote `docs/decisions/0008-cross-session-access-intent.md` (the principle-first ADR) and marked Phase 12 Step 1 complete in `docs/architecture/architecture.md` (heading `✅` + Mermaid `S1` node `✅` + a `Landed:` note).
No `src/`/`test/`/schema/config changes, matching the plan's Non-Goals.
Pre-completion reviewer returned PASS.

### Observations

- **ADR structure landed principle-first** as planned: `## Decision` leads with *the child owns the facts; the parent owns the judgment*, then four numbered consequences (path portability, wire schema, agent-scoped serving, version skew), a `### Composition` subsection situating the record against ADR 0007, and a `### Explicitly deferred edges` subsection.
- **Deviation from the plan (cosmetic)**: the plan's Module-Level Changes placed the two deferred edges under `## Consequences`; the shipped ADR keeps them in a `### Explicitly deferred edges` subsection under `## Decision`, grouped with the four consequences and the composition section.
  The reviewer flagged this as a WARN but judged it "arguably better organized"; kept as-is to avoid churn on a cohesive structure.
- **Recorded the resolved decisions in the architecture `Landed:` note** — the pre-decision Target bullet framed open questions ("tolerant read"; "whether `requesterAgentName` participates or serving stays agent-neutral"), which the ADR resolved (required field with `ask` floor; agent-scoped serving).
  The `Landed:` note explicitly states it supersedes that speculative framing so the roadmap is not left misleading.
- **Pre-completion reviewer: PASS** — lint clean (Biome/ESLint/rumdl over docs); all four Mermaid blocks parse via `mmdc`; ADR cross-links to ADR 0005 ("Base ruleset (agent-neutral resolution)") and ADR 0007 (chain verdict range, terminal split, enforcement checkpoint) verified accurate against source; no scope creep into re-deciding ADR 0007; the one present-tense "is retired ([#597])" phrase is correctly `[#597]`-qualified, not a false implementation claim.
- **Reviewer warnings**: one non-blocking WARN (deferred-edges subsection placement under `## Decision` vs. the plan's `## Consequences`); cosmetic only.
- **Release**: mid-batch — defer (batch "cross-session-intent", tail = Step 3 / #597).
  Both commits are `docs:` (hidden), so this step cuts no release on its own; the batch ships when #597 lands.
- Next step is `/ship-issue`.

## Stage: Final Retrospective (2026-07-18T15:03:31Z)

### Session summary

Shipped issue #595 end to end in one continuous session: planned the ADR, ran two `ask_user` rounds to settle three parameters, then — prompted by the operator's meta-doubt — held an advisory dialogue that surfaced a unifying principle (*the child owns the facts; the parent owns the judgment*), restructured the plan and ADR around it, built the two `docs:` commits, and shipped with the release deferred to the batch tail (#597).
The issue closed on `main`; no release cut (docs-only on `exclude-paths`).
A clean session whose standout event was the reframe dialogue that changed the deliverable's structure, not its decisions.

### Observations

#### What went well

- **Advisory reframe that grounded doubt in code, then generalized (novel win).**
  The operator said the decisions "feel difficult… I can't tell if it's a comprehension gap or a missing reframe."
  Rather than push forward, each open parameter was grounded in the actual source first: the worktree portability worry dissolved on finding that `AccessPath.matchValues()` already carries a **cwd-relative alias** (via `getCwdRelativePathPolicyValues` in `path-normalization.ts`), so relative parent rules stay portable across cwds without re-derivation.
  That grounding then generalized into the principle *child owns the facts; parent owns the judgment*, validated against `authorizer.ts`/`authorizer-selection.ts` — it retro-explained ADR 0005 (serving-is-resolution) and ADR 0007 (the chain) and derived all three confirmed parameters.
  The reframe reshaped the ADR (principle-first + a composition section) without changing a single decision.
- **Two-round `ask_user` gate for an ADR issue.**
  Round 1 surfaced the three deliberative parameters; round 2 tightened them after grounding in the code (e.g. reframing version-skew from "tolerant read" to "required field + `ask` floor").
  The pattern fit the ADR-issue rule in `/plan-issue` exactly and produced decisions the operator could stand behind.
- **Guards against over-application, baked into the artifact.**
  When a unifying model is attractive there is a real risk of stretching it; the ADR's composition section was kept descriptive-only (cites ADR 0007 by path, decides nothing new) and a deferred-edges section named exactly where the model is incomplete (single-surface fact set #565 item 3; multi-hop principal identity).
  The pre-completion reviewer confirmed no scope creep into re-deciding ADR 0007.
- **Clean incremental verification.**
  `rumdl check` ran after each doc write (not just at the end); the green baseline (`check` + `lint`) was confirmed before any edit; pre-completion returned PASS.

#### What caused friction (agent side)

- `other` (self-caught, no rework) — the plan-restructure `Edit` call carried a stray `"newText2": null` key on its first entry (the `oldText2`/`newText2` anti-pattern AGENTS.md documents).
  The tool reported "12 block(s)" for 11 intended edits; caught immediately by counting reported blocks against intended edits and re-reading the regions — the exact mitigation AGENTS.md prescribes (Refs #605).
  Impact: none — the value was `null` (harmless) and the existing guard worked; evidence the rule is doing its job, not a gap.
- `other` (minor accuracy) — the Build stage note used a rounded placeholder timestamp (`2026-07-18T01:00:00Z`) instead of a real `date -u` value.
  Impact: cosmetic; the breadcrumb ordering is still correct, but a real timestamp is trivially better for the cross-session trail.

#### What caused friction (user side)

- **None — the meta-doubt intervention was the session's highest-leverage moment.**
  The operator committed the plan, then reopened it with "these decisions feel difficult."
  That redirect (a question, not a correction) is exactly the strategic-judgment intervention the workflow wants: it arrived before the ADR was written, when restructuring was cheap, and it produced a materially better artifact.
  Nothing to change; recorded as a model of good bidirectional feedback.

### Diagnostic details

- **Model-performance correlation** — the session switched models frequently (operator-driven), with `claude-opus-4-8` and `claude-sonnet-5` present for the heavy reasoning stretches and lighter models (`claude-haiku-4-5`, `claude-fable-5`, `deepseek-v4-flash`) elsewhere.
  The one subagent dispatch (`pre-completion-reviewer`) ran on its configured model — judgment-appropriate.
  No mismatch to flag: the judgment-heavy reframe work had strong models available.
- **Escalation-delay tracking** — no `rabbit-hole` friction; longest same-target streak was benign (verifying the multi-edit block count).
- **Unused-tool detection** — no `missing-context` gaps; `grep`/`sed`/`Read` grounded every claim in source (the cwd-relative alias finding came from reading `path-normalization.ts` directly).
- **Feedback-loop gap analysis** — verification was incremental: baseline `check`+`lint` before edits, `rumdl check` after each doc write, `lint` + `fallow dead-code` at pre-push, CI watched to green.

### Changes made

1. `packages/pi-permission-system/docs/retro/0595-adr-0008-cross-session-access-intent.md` — appended this Final Retrospective stage entry.
   No `AGENTS.md` or prompt changes: the operator confirmed landing the retro file only, since the session's friction was already covered by existing rules (the `newText2` block-count guard, Refs #605) or too trivial to encode (a placeholder timestamp).
