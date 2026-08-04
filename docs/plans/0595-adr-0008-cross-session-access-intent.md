---
issue: 595
issue_title: "pi-permission-system: ADR 0008 — forwarded access-intent portability and principal identity"
---

# ADR 0008 — forwarded access-intent portability and principal identity

## Release Recommendation

**Release:** mid-batch — defer (batch "cross-session-intent"); confirm at ship time

This issue is Step 1 of Phase 12 Track A, the first member of release batch "cross-session-intent" (Steps 1, 2, 3; tail = Step 3, [#597]).
It is a docs-only ADR — a `docs:` commit that decides the contract Steps 2–3 implement — so it does not cut a release on its own and rides the batch tail.
The whole batch ships together once [#597] lands.

## Problem Statement

When an `ask`-state permission arises in a subagent child with no UI, the extension forwards it up to the parent for a decision.
Today that escalation edge loses the gate's structured product: `ForwardedPermissionRequest` carries a pre-rendered `message` plus display-only `surface`/`value` strings, and the serving node's `ServingPolicy.check(surface, value)` re-derives an intent from that bare string through the **parent's** `PathNormalizer` and cwd.
Two failure modes follow, both named in [#565] and accepted at [#557] ship time pending this spine:

- **Path meaning is re-interpreted at the wrong node.**
  A child in a worktree resolves paths against a different root than the parent, so the child's lexical ∪ canonical alias set (the [#418]/[#486] match contract) never crosses the wire — a parent `allow` can silently miss what the child's own gate would have matched, and vice versa.
- **Agent-scope semantics are undefined.**
  Serving evaluates the base ruleset agent-neutrally; `requesterAgentName` is display-only with no decided meaning.

These questions are unanswerable in code because they were never decided.
The deliverable of this step is therefore the decision record itself: `docs/decisions/0008-cross-session-access-intent.md`, settling the cross-session access-intent contract before the wire format changes in Steps 2–3.

## Goals

- Write `docs/decisions/0008-cross-session-access-intent.md` (status `accepted`), structured **principle-first**: one decision — *the child owns the facts; the parent owns the judgment* — with three derived consequences:
  1. the **portable meaning** of a path-shaped ask (the facts are fixed at the child; the parent never re-derives);
  2. the **`ForwardedAccessIntent` wire schema** (the facts serialized: surface, match values, boundary value, requester cwd, principal identity) and its version handling;
  3. the **agent-scope semantics** of serving evaluation (the parent's judgment, fully informed by principal identity).
- Include a **composition section** situating the decision in the authorization walk (recorded authority → chain links → terminal; the courier carries facts, never judgment), citing `docs/decisions/0007-model-judge-authorizer-chain-adr.md` by path without re-deciding it.
- Name the model's **explicitly deferred edges** (single-surface fact set, multi-hop principal identity) so the ADR marks where the unified model is known-incomplete.
- Mark Phase 12 Step 1 complete in `docs/architecture/architecture.md` (heading `✅` + Mermaid node `✅` + a `Landed:` note), per the package skill's step-completion convention.
- Leave all runtime code unchanged — this step decides; Steps 2–3 ([#596], [#597]) implement.

## Non-Goals

- No code changes: `permission-forwarding.ts`, `forwarded-request-server.ts`, `forwarding-io.ts`, `approval-escalator.ts`, `permission-prompter.ts`, and `index.ts` are untouched by this step (they are Step 2/3 targets).
- No schema/config changes (`config-schema.ts`, `schemas/permissions.schema.json`).
- No change to the health-metric grep-count rows in the Phase 12 table — those targets (`ForwardedAccessIntent` counts) are moved by Steps 2–3, not Step 1.
- Track B (the Authorizer chain, Steps 4–6) implementation is out of scope; the ADR's composition section *describes* the decided chain design (citing `docs/decisions/0007-model-judge-authorizer-chain-adr.md` by path) and decides nothing new about it.
- No decision on multi-hop principal identity (originator vs. accumulated chain) or on widening the fact set to multi-surface asks — both are named in the ADR as explicitly deferred edges, not silently omitted.
- Closing [#565] is deferred to Phase 12 end (per the architecture doc's open-issue sweep disposition), not this step.

## Background

Relevant existing surfaces (read during planning):

- `src/authority/permission-forwarding.ts` — defines `ForwardedPermissionRequest` (the wire shape: `id`, `createdAt`, `requesterSessionId`, `targetSessionId`, `requesterAgentName`, `message`, optional display `source`/`surface`/`value`, optional `sessionApproval`) and `ForwardedPermissionResponse`.
- `src/authority/forwarded-request-server.ts` — the serving node: `ServingPolicy.check(surface, value)` (the narrow recorded-authority seam), `AskEscalator` escalation on `ask`, `SessionApprovalRecorder` for whole-session grants.
- `src/access-intent/access-path.ts` — the `AccessPath` value object: `matchValues()` (lexical alias union ∪ canonical), `boundaryValue()` (canonical, for containment), `value()` (lexical, for display).
  Crucially, `matchValues()` via `getPathPolicyValues` → `getAbsolutePathPolicyValues` already includes a **cwd-relative alias** (`getCwdRelativePathPolicyValues`) alongside the absolute and canonical forms.
- `src/rule.ts` — `evaluateAnyValue` matches a ruleset against every alias (last-match-wins across aliases), so a relative config rule and an absolute allowlist coexist without one masking the other.

Existing decision records this ADR builds on:

- `docs/decisions/0005-serving-authorizer-provenance.md` — serving a forwarded request *is* resolution; recorded authority first, escalate `ask`, provenance rides the ask.
  Its "Base ruleset (agent-neutral resolution)" section is the exact decision ADR 0008 revises.
- `docs/decisions/0002-path-values-string-boundary.md` — the manager stays string-based; `AccessPath` does not cross into it.
  The wire schema must carry **strings** (the match values), not `AccessPath` instances, consistent with this boundary.
- `docs/decisions/0007-model-judge-authorizer-chain-adr.md` — the Authorizer chain (Track B): config-ordered non-terminal links with `allow | deny | defer` verdicts, a terminal that cannot defer, and the enforcement checkpoint capping link authority.
  ADR 0008's composition section situates the facts/judgment decision alongside it; the two tracks are orthogonal axes of one structure (plurality of judges *within* a node vs. fidelity of facts *between* nodes).

AGENTS.md / skill constraints that apply:

- ADR numbering is per-package; cite this package's own ADRs by path, not a bare `ADR-NNNN` token.
- When the implementation completes a numbered roadmap step, mark it `✅` (heading + Mermaid node) in the same doc-update commit — do not defer the marker to ship.
- One-sentence-per-line; reference GitHub issues with reference-style `[#N]` links in long-lived docs.

## Design Overview

The ADR is structured principle-first: one decision, three derived consequences, a composition section, and named deferred edges.
All parameters were confirmed with the operator during planning (agent-scoped serving; child-fixed match set; required field with an `ask` floor on absence; principle-first restructure with the composition section).

### The decision — the child owns the facts; the parent owns the judgment

A forwarded ask separates cleanly into **facts** (what is being accessed, in every form the origin gate would recognize, and by whom) and **judgment** (what a policy says about it).
The contract: facts are fixed at the origin child and carried unchanged through every hop; judgment is exercised anew at each node against that node's own ruleset; no node ever re-derives facts.
The three consequences below are derivations of this principle, not independent parameters — the ADR presents them as such so each is justified by the principle rather than argued locally.

### Consequence 1 — the portable meaning of a path-shaped ask is fixed at the child

A path's meaning is the alias set computed **where the path was typed** (the child), never re-derived at the parent.
The child ships the `AccessPath`'s `matchValues()` (the absolute ∪ cwd-relative ∪ canonical alias set) and `boundaryValue()` (canonical) as fixed strings.
The parent matches its own ruleset against those fixed values through the ordinary `evaluateAnyValue` evaluator — it does not rebuild an `AccessPath` from a bare string through its own `PathNormalizer`/cwd.

Why this is portable across cwds (the worktree case): because `matchValues()` already carries a **cwd-relative alias**, a child in `/worktree/issue-42` typing `src/foo.ts` ships `{ /worktree/issue-42/src/foo.ts, src/foo.ts, <canonical> }`.

- A **relative** parent rule (`path: { "src/**": allow }`) matches the child's `src/foo.ts` relative alias → the parent's authority stays relevant across worktrees/cwds.
- An **absolute** parent rule (`/main-checkout/src/**`) matches only co-located paths → a different worktree's file is correctly *not* covered (least privilege).

Canonicalization does not bridge cwds (git worktrees are real directories, not symlinks); the cwd-relative alias is what makes cross-cwd matching work.
Recorded consequence: a relative parent `allow` auto-grants a same-relative path from an unrelated child cwd — consistent with how relative rules already behave locally, and the operator confirmed this is acceptable.

### Consequence 2 — the `ForwardedAccessIntent` wire schema (the facts, serialized)

A new required field on the forwarded request carries the child-fixed facts.
Shape (decided here, implemented in Step 2 — the ADR fixes the field names and semantics):

```typescript
interface ForwardedAccessIntent {
  /** The gate surface the child evaluated (e.g. "path", "external_directory", "bash", the tool name, a skill name, an MCP target). */
  surface: string;
  /**
   * The child-fixed match set. For a path surface: AccessPath.matchValues()
   * (absolute ∪ cwd-relative ∪ canonical), computed at the child. For a
   * non-path surface: the already-portable single value (bash command, MCP
   * target, skill name) as a one-element array. Strings only — the ADR 0002
   * boundary keeps AccessPath out of the wire.
   */
  matchValues: string[];
  /** Canonical boundary form (AccessPath.boundaryValue()) for a path surface; null for non-path surfaces. */
  boundaryValue: string | null;
  /** The requester's cwd, for provenance and prompt disclosure — not for parent re-derivation. */
  requesterCwd: string;
  /** Principal identity: who is requesting. */
  principal: {
    sessionId: string; // already carried today as requesterSessionId
    agentName: string; // graduates from display-only to decision-participating (Consequence 3)
  };
}
```

Non-path surfaces (bash command pattern, MCP target, skill name) are already portable — they carry their `(surface, value)` directly as a one-element `matchValues` with `boundaryValue: null`.
The field is **required** going forward: it becomes the sole resolution path, and the legacy display-only `(surface, value)` resolution branch in `ServingPolicy` is retired in Step 3.

### Consequence 3 — agent-scoped serving evaluation (the parent's judgment, fully informed)

`requesterAgentName` graduates from display-only to **decision-participating**.
The serving node resolves the forwarded intent against its **own** base ruleset **scoped to the requester's agent name** (the `principal.agentName`), applying the parent's per-agent overrides for that agent.

This is not double-application: forwarding up means the child's ruleset already resolved to `ask` (unresolved); the parent then applies a **different** ruleset (its own config/project layer).
It is a strict superset of agent-neutral serving — with identical parent/child configs the parent also lands on `ask` and prompts (no regression), and it changes the outcome only when the parent holds per-agent rules for that agent that the child's config lacked.
This revises ADR 0005's "agent-neutral resolution" section, which explicitly deferred the semantics to "once principal identity lands."

Serving-node call-site sketch (Step 3 shape, sketched here to validate the contract follows Tell-Don't-Ask — the parent asks the resolver, not the wire object, for a decision):

```typescript
// Serving node, per forwarded request (Step 3 — illustrative, not built here):
const intent = request.accessIntent; // required field, Consequence 2
const decision = resolver.resolve(
  buildResolvedIntentFromWire(intent),        // match values used as-is; no PathNormalizer re-derivation
  { agentName: intent.principal.agentName },  // Consequence 3 — agent-scoped
);
// allow → auto-approve; deny → auto-deny; ask → escalate through AskEscalator (unchanged).
```

### Consequence 4 — version-skew handling (no facts → no judgment → escalate)

`ForwardedAccessIntent` is the sole resolution path; the legacy `(surface, value)` resolution branch is dropped (Step 3).
A request that arrives **without** the field (a rare mid-upgrade skew: a long-running parent reading a newer/older child's request across a `pnpm install` version bump) floors to `ask` → prompt — never a hard deny (which would break a legitimate in-flight request) and never a silent grant.
Under the principle this is a derivation, not a tolerance hack: missing facts make recorded judgment impossible, so the ask goes straight to live authority.
This keeps the ADR 0005 fail-safe direction while shedding the permanent dual-path complexity.

### Composition — how the decision sits in the authorization walk

The ADR includes a composition section showing the unified structure the decision fits into.
Authorization is a walk up a session tree: at each node an ordered sequence of judges examines the same fixed facts, and the only inter-node operation is the courier move, which carries facts and never judgment.

```text
decide(node, facts):
  verdict = node.rules.resolve(facts, principal)   # recorded authority (deterministic judgment)
  if allow or deny → return verdict
  for link in node.chain:                          # non-terminal judges (Track B, decided in ADR 0007)
    v = link.review(facts)                         #   allow* / deny / defer (* capped by the checkpoint)
    if v ≠ defer → return v
  return node.terminal.authorize(facts)            # terminal:
    LocalUserAuthorizer → human decides            #   terminal judgment
    ParentAuthorizer    → decide(parent, facts)    #   courier — recurse up the tree
    DenyingAuthorizer   → deny                     #   fail-safe
```

What the section establishes, and its scope guard:

- `ParentAuthorizer` occupies the `Authorizer` slot structurally but is a **courier**, not a judge — it carries the facts up and exercises no judgment; that is why serving must re-run recorded authority (the ADR 0005 contract) rather than treat arrival at the parent as "needs a human now."
- Track A (this ADR) and Track B (`docs/decisions/0007-model-judge-authorizer-chain-adr.md`) are orthogonal axes: fidelity of facts *between* nodes vs. plurality of judges *within* a node.
- Recorded synergy consequence: once both tracks land, a serving node's chain links (e.g. the model judge) review forwarded asks against the **child-fixed fact set** — honest evidence, not a parent-side re-derivation.
- Scope guard: the section is *descriptive* of decided architecture (ADR 0005's serving flow, ADR 0007's chain) and decides nothing new about either; it exists so the tracks are legible as two halves of one picture.

### Explicitly deferred edges

The ADR names where the unified model is known-incomplete, so the deferrals are recorded rather than silent:

- **Single-surface fact set** ([#565] item 3) — a child decision can layer multiple surfaces (an `external_directory` check over a `path`), but `ForwardedAccessIntent` carries one surface + one match set.
  A multi-surface child decision still floors to `ask` at the parent (the safe direction); the fact schema may grow additional surfaces later without changing the principle.
- **Multi-hop principal identity** — whether a grandchild-through-child forward carries the originator's identity or an accumulated chain is undecided; today forwarding is effectively one hop to the UI-bearing root.
  Facts-at-origin answers the path question regardless; identity accumulation is deferred until multi-hop forwarding exists.

## Module-Level Changes

This is a docs-only step.

- **Add** `packages/pi-permission-system/docs/decisions/0008-cross-session-access-intent.md` — the ADR, following the 0005/0007 format: `status: accepted` / `date` frontmatter, `# 0008 — …`, `## Status`, `## Context`, `## Decision` (the principle as the lead subsection, then the four consequences), a composition subsection (the `decide()` recursion, the courier observation, the Track A/B orthogonality, the synergy consequence, and the scope guard), `## Rejected alternatives`, `## Consequences` (including the deferred [#565] close, the relative-alias auto-grant consequence, and the two explicitly deferred edges).
  Reference issues with `[#N]` reference-style links; cite sibling ADRs by path.
- **Edit** `packages/pi-permission-system/docs/architecture/architecture.md`:
  - Mark Step 1 complete: append `✅` to the `#### Step 1: ADR 0008 …` heading and to the Mermaid `S1[…]` node label, and add a `**Landed:**` note under the step recording the ADR path.
  - No other rows change: the Phase 12 health-metric grep-count targets (`ForwardedAccessIntent` in `permission-forwarding.ts` / `forwarded-request-server.ts`) are Step 2/3 outcomes and stay at their baseline here.
  - The `docs/decisions/0008-cross-session-access-intent.md` path is already named in Step 1's Target and in the findings; verify the reference resolves once the file exists (no new reference-link definition needed for an in-tree relative path).

No `src/`, `test/`, `schemas/`, `config/`, README, or configuration-doc changes.
A grep for the ADR filename and for `ForwardedAccessIntent` confirms no runtime symbol is introduced or removed by this step.

## Test Impact Analysis

None — docs-only.
No unit tests are added, changed, or made redundant.
The wire-schema and serving-resolution tests land with Steps 2 and 3, which implement the contract this ADR decides.

## Invariants at risk

- **ADR 0005's serving-is-resolution contract** — ADR 0008 *revises* one section of it (agent-neutral → agent-scoped) rather than contradicting the whole.
  The ADR must state explicitly that recorded-authority-first + escalate-`ask` + provenance-on-the-ask (0005's core) is preserved, and only the agent-scope sub-decision changes.
  This is prose-only at this step; the behavioral pin lands with Step 3's serving tests.
- **ADR 0002's string boundary** — the wire schema carries strings (`matchValues: string[]`), never `AccessPath` instances, so the manager stays string-based.
  The ADR must note this so Step 2 does not serialize an `AccessPath` onto the wire.

## Build Order

Docs-only, so no red→green cycles — a build sequence with `docs:` commits.

1. **Write the ADR.**
   Author `docs/decisions/0008-cross-session-access-intent.md` with the four decisions, rejected alternatives, and consequences.
   Verify with `pnpm exec rumdl check packages/pi-permission-system/docs/decisions/0008-cross-session-access-intent.md`.
   Commit: `docs(pi-permission-system): add ADR 0008 for cross-session access-intent (#595)`.
2. **Mark the roadmap step complete.**
   Edit `docs/architecture/architecture.md` (Step 1 heading `✅`, Mermaid node `✅`, `Landed:` note).
   Verify with `pnpm exec rumdl check packages/pi-permission-system/docs/architecture/architecture.md`.
   Commit: `docs(pi-permission-system): mark Phase 12 Step 1 complete (#595)`.

Both commits are `docs:` (hidden changelog type) and do not cut a release on their own — consistent with the mid-batch deferral.
Steps 1 and 2 may be combined into a single `docs:` commit if preferred at build time; keeping them separate keeps the ADR and the roadmap-mark independently reviewable.

## Risks and Mitigations

- **Risk: the ADR over-specifies the wire shape and boxes in Step 2.**
  Mitigation: the schema block fixes *field names and semantics* (the decision), not the exact TypeScript declaration site or serialization mechanics — Step 2 owns those.
- **Risk: the agent-scoped revision silently contradicts ADR 0005 without cross-linking.**
  Mitigation: the ADR explicitly names the 0005 section it revises and states what 0005 behavior is preserved (Invariants at risk).
- **Risk: marking Step 1 `✅` before Steps 2–3 land makes the roadmap look half-implemented.**
  Mitigation: Step 1's deliverable *is* the ADR — it is genuinely complete when the file exists; the `Landed:` note records that Steps 2–3 implement it, and the batch-tail release marker keeps the shipping story coherent.
- **Risk: the unifying model is over-applied — a concept stretched past where it earned its evidence.**
  Mitigation: the model earned its place by retro-explaining decisions made independently (ADR 0005's serving-is-resolution, ADR 0007's chain) and deriving all three confirmed parameters; the ADR bakes in two guards — the composition section is descriptive-only (decides nothing new), and the deferred-edges section names exactly where the model is known-incomplete.
- **Risk: the composition section drifts into re-deciding ADR 0007.**
  Mitigation: the scope guard is written into the section itself; the pre-completion reviewer checks the ADR introduces no new chain semantics beyond citing `docs/decisions/0007-model-judge-authorizer-chain-adr.md`.

## Open Questions

No open questions block this step — the deliberative parameters (agent scope, path portability, version-skew handling, principle-first structure) were resolved with the operator during planning.
Two edges are **explicitly deferred and recorded in the ADR** rather than left open: the single-surface fact set ([#565] item 3 — safe `ask` floor today, schema may grow) and multi-hop principal identity (undecided until multi-hop forwarding exists).
Neither needs a follow-up issue now: the first is already tracked by [#565] (open through Phase 12 by roadmap decision), and the second has no implementable surface until multi-hop forwarding is proposed.
No other follow-up issues are filed: Steps 2 ([#596]) and 3 ([#597]) already exist as the implementation of this contract.

[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#486]: https://github.com/gotgenes/pi-packages/issues/486
[#557]: https://github.com/gotgenes/pi-packages/issues/557
[#565]: https://github.com/gotgenes/pi-packages/issues/565
[#596]: https://github.com/gotgenes/pi-packages/issues/596
[#597]: https://github.com/gotgenes/pi-packages/issues/597
