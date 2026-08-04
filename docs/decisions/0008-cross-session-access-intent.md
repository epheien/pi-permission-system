---
status: accepted
date: 2026-07-18
---

# 0008 — Cross-session access intent: the child owns the facts, the parent owns the judgment

## Status

Accepted.
This decision settles the cross-session access-intent contract; it does not implement it.
It is Phase 12 Track A Step 1 ([#595]); Steps 2 ([#596]) and 3 ([#597]) implement the wire and serving changes this record decides.
It revises the "Base ruleset (agent-neutral resolution)" section of `docs/decisions/0005-serving-authorizer-provenance.md` and composes with the Authorizer chain of `docs/decisions/0007-model-judge-authorizer-chain-adr.md`.

## Context

A subagent child with no UI escalates an `ask` decision up the session tree by writing a forwarded-permission request file; the parent (serving) session drains its inbox and answers each request.
`docs/decisions/0005-serving-authorizer-provenance.md` settled that serving a forwarded request *is* resolution: the serving node runs the request against its own composed ruleset (recorded authority first), escalates a residual `ask` through the `AskEscalator` seam, and carries provenance as data on the ask.

But the escalation edge loses the gate's structured product.
`ForwardedPermissionRequest` carries a pre-rendered `message` plus *display-only* `surface`/`value` strings, so the serving node's `ServingPolicy.check(surface, value)` re-derives an intent from that bare string through the **parent's** `PathNormalizer` and cwd.
Two consequences follow, both named in [#565] (items 2–3) and accepted as failure modes at [#557] ship time pending exactly this spine:

- **Path meaning is re-interpreted at the wrong node.**
  A child in a worktree resolves paths against a different root than the parent, so the child's lexical ∪ canonical alias set — the [#418]/[#486] match contract — never crosses the wire.
  A parent `allow` can silently miss what the child's own gate would have matched, and vice versa.
- **Agent-scope semantics are undefined.**
  `ServingPolicy.check` resolves with `agentName` undefined; `requesterAgentName` is display-only, with no decided meaning.
  ADR 0005 explicitly deferred this "until principal identity lands in the access-intent domain."

These questions are unanswerable in code because they were never decided.
The value of an ADR is the deliberation behind it, so the decision is the first deliverable — the wire and serving changes ([#596], [#597]) implement this contract rather than deciding it inline.

## Decision

### The principle — the child owns the facts; the parent owns the judgment

A forwarded ask separates cleanly into two parts:

- **Facts** — what is being accessed, in every form the origin gate would recognize, and by whom.
- **Judgment** — what a policy says about those facts.

The contract:

1. Facts are **fixed at the origin child** — computed where the action was requested — and carried unchanged through every hop.
2. Judgment is **exercised anew at each node** against that node's own ruleset.
3. **No node ever re-derives facts.**
   A node that receives a forwarded request treats the carried facts as given; it never reconstructs them through its own `PathNormalizer`/cwd.

The four consequences below are derivations of this principle, not independent parameters.

### 1. A path-shaped ask's meaning is fixed at the child

A path's portable meaning is the alias set computed where the path was typed (the child), never re-derived at the parent.
The child ships the `AccessPath`'s `matchValues()` (the absolute ∪ cwd-relative ∪ canonical alias set) and `boundaryValue()` (the canonical form) as fixed strings.
The parent matches its own ruleset against those fixed values through the ordinary `evaluateAnyValue` evaluator — it does not rebuild an `AccessPath` from a bare string.

This is portable across cwds because `matchValues()` already carries a **cwd-relative alias**.
A child in `/worktree/issue-42` typing `src/foo.ts` ships `{ /worktree/issue-42/src/foo.ts, src/foo.ts, <canonical> }`:

- A **relative** parent rule (`path: { "src/**": allow }`) matches the child's `src/foo.ts` relative alias, so the parent's authority stays relevant across worktrees and differing cwds.
- An **absolute** parent rule (`/main-checkout/src/**`) matches only co-located paths, so a different worktree's file is correctly *not* covered — least privilege.

Canonicalization does not bridge cwds: a git worktree is a real directory, not a symlink, so the canonical form of a worktree path stays under the worktree.
The cwd-relative alias, not canonicalization, is what makes cross-cwd matching work.

### 2. The `ForwardedAccessIntent` wire schema

A required field on the forwarded request carries the child-fixed facts.
This record fixes the field names and semantics; [#596] owns the exact declaration site and serialization mechanics.

```typescript
interface ForwardedAccessIntent {
  /** The gate surface the child evaluated: "path", "external_directory", "bash", a tool name, a skill name, or an MCP target. */
  surface: string;
  /**
   * The child-fixed match set. For a path surface: AccessPath.matchValues()
   * (absolute ∪ cwd-relative ∪ canonical), computed at the child. For a
   * non-path surface: the already-portable single value (bash command, MCP
   * target, skill name) as a one-element array. Strings only.
   */
  matchValues: string[];
  /** Canonical boundary form (AccessPath.boundaryValue()) for a path surface; null for a non-path surface. */
  boundaryValue: string | null;
  /** The requester's cwd, for provenance and prompt disclosure — never for parent re-derivation. */
  requesterCwd: string;
  /** Principal identity: who is requesting. */
  principal: {
    sessionId: string; // carried today as requesterSessionId
    agentName: string; // decision-participating (§3)
  };
}
```

The field carries **strings**, never `AccessPath` instances: `docs/decisions/0002-path-values-string-boundary.md` keeps the manager string-based, and the wire honors that boundary.
Non-path surfaces (a bash command pattern, an MCP target, a skill name) are already portable — they carry their single value as a one-element `matchValues` with `boundaryValue: null`.

### 3. Agent-scoped serving evaluation

`requesterAgentName` graduates from display-only to **decision-participating**.
The serving node resolves the forwarded intent against its own base ruleset scoped to the requester's agent name (`principal.agentName`), applying the parent's per-agent overrides for that agent.

This is not double-application.
Forwarding up means the child's ruleset already resolved to `ask` — unresolved — so the child carries no judgment upward.
The parent then applies a **different** ruleset (its own config and project layer).
Agent-scoped serving is a strict superset of the agent-neutral serving it replaces:

- With identical parent and child configs, the parent also lands on `ask` and prompts — no regression.
- It changes the outcome only when the parent holds per-agent rules for that agent that the child's config lacked.

This revises ADR 0005's "Base ruleset (agent-neutral resolution)" section, which resolved with `agentName` undefined and deferred the semantics to "once principal identity lands."
The rest of ADR 0005 is preserved: recorded-authority-first, escalate `ask`, and provenance-as-data-on-the-ask are unchanged.

The serving node asks its resolver for a decision; it never asks the wire object (Tell-Don't-Ask):

```typescript
// Serving node, per forwarded request ([#597] shape — illustrative, not built here):
const intent = request.accessIntent; // the required field (§2)
const decision = resolver.resolve(
  buildResolvedIntentFromWire(intent),        // match values used as-is; no PathNormalizer re-derivation
  { agentName: intent.principal.agentName },  // §3 — agent-scoped
);
// allow → auto-approve; deny → auto-deny; ask → escalate through AskEscalator (unchanged).
```

### 4. Version skew — no facts, no judgment, escalate

`ForwardedAccessIntent` is the sole resolution path; the legacy display-only `(surface, value)` resolution branch in `ServingPolicy` is retired ([#597]).
A request that arrives **without** the field floors to `ask` → prompt.
It is never a hard deny (which would break a legitimate in-flight request) and never a silent grant.

Under the principle this is a derivation, not a tolerance hack: missing facts make recorded judgment impossible, so the ask goes straight to live authority.
The realistic skew window is narrow — a long-running parent process holding older code while a freshly spawned child loads newer code across a `pnpm install` version bump, or an old request file read by a newer parent.
A required field with an `ask` floor keeps the ADR 0005 fail-safe direction while shedding the permanent dual-path complexity a tolerant reader would carry.

### Composition — the decision in the authorization walk

Authorization is a walk up a session tree.
At each node an ordered sequence of judges examines the same fixed facts; the only inter-node operation is the courier move, which carries facts and never judgment.

```text
decide(node, facts):
  verdict = node.rules.resolve(facts, principal)   # recorded authority (deterministic judgment)
  if allow or deny → return verdict
  for link in node.chain:                          # non-terminal judges (Track B — ADR 0007)
    v = link.review(facts)                         #   allow* / deny / defer (* capped by the checkpoint)
    if v ≠ defer → return v
  return node.terminal.authorize(facts)            # terminal slot:
    LocalUserAuthorizer → human decides            #   terminal judgment
    ParentAuthorizer    → decide(parent, facts)    #   courier — recurse up the tree
    DenyingAuthorizer   → deny                     #   fail-safe
```

- `ParentAuthorizer` occupies the terminal slot for its own node but is a **courier**, not a judge: it carries the facts up and returns the parent node's verdict, exercising no judgment of its own.
  This is why serving must re-run recorded authority (the ADR 0005 contract) rather than treat arrival at the parent as "needs a human now."
- Track A (this record) and Track B (`docs/decisions/0007-model-judge-authorizer-chain-adr.md`) are orthogonal axes of one structure: **fidelity of facts between nodes** versus **plurality of judges within a node**.
- Once both tracks land, a serving node's chain links (for example, the model judge) review forwarded asks against the **child-fixed fact set** — honest evidence, not a parent-side re-derivation.

This section is *descriptive* of decided architecture (ADR 0005's serving flow, ADR 0007's chain) and decides nothing new about either; it exists so the two tracks are legible as halves of one picture.

### Explicitly deferred edges

The unified model is known-incomplete at two edges, recorded here rather than left silent:

- **Single-surface fact set** ([#565] item 3).
  A child decision can layer multiple surfaces — an `external_directory` check over a `path` — but `ForwardedAccessIntent` carries one surface and one match set.
  A multi-surface child decision still floors to `ask` at the parent (the safe direction).
  The fact schema may grow additional surfaces later without changing the principle.
- **Multi-hop principal identity.**
  Whether a grandchild-through-child forward carries the originator's identity or an accumulated chain is undecided; forwarding today is effectively one hop to the UI-bearing root.
  Facts-at-origin answers the path question regardless; identity accumulation is deferred until multi-hop forwarding exists.

## Rejected alternatives

- **Re-derive the path at the parent** (ship the raw typed path plus the requester cwd; the parent rebuilds an `AccessPath` with its own normalizer scoped to the child cwd).
  Rejected: it re-introduces the node-of-interpretation flaw the spine exists to remove, and the child-fixed alias set already carries a cwd-relative form, so the parent gains nothing by rebuilding.
- **Agent-neutral serving** (keep resolving with `agentName` undefined; `requesterAgentName` stays display-only).
  Rejected: it leaves [#565] item 2 permanently undecided and cannot honor a parent's per-agent rule for the requesting agent.
  Agent-scoped serving is a strict superset — identical configs still prompt — so it dominates the neutral choice.
- **Hard-reject a request missing the intent field.**
  Rejected: a hard deny breaks a legitimate in-flight request during the rare upgrade window, which is harsher than the established `ask`-floor fail-safe and grants nothing in return.
- **Tolerant dual-path** (keep the legacy `(surface, value)` resolution branch alongside the new intent path indefinitely).
  Rejected: it carries permanent dual-path complexity for a skew window that is narrow by construction; a required field with an `ask` floor is the same safety with one code path.

## Consequences

- The forwarded wire gains a required `ForwardedAccessIntent` field carrying child-fixed facts; serving resolves against it at gate parity ([#596], [#597]).
- A parent `allow`/`deny` governs a child's path ask against the **child-fixed** alias set: a `/tmp/*` allow at the parent matches exactly what the child's own gate would have matched, and a relative rule stays relevant across worktrees.
- A relative parent `allow` auto-grants a same-relative path from an unrelated child cwd — consistent with how relative rules already behave locally, and an accepted consequence of least-privilege absolute rules being available when concreteness is wanted.
- `requesterAgentName` becomes decision-participating; a serving node applies its per-agent overrides for the requesting agent.
- [#565] items 2–3 are structurally dissolved once [#597] lands.
  [#565] stays open through Phase 12 by roadmap decision and closes at phase end with a note recording that item 1 (forwarded-prompt fidelity against a real external notification consumer) stays best-effort, since no consumer exists to verify against.
- No code, config, schema, or default changes in this documentation step.

[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#486]: https://github.com/gotgenes/pi-packages/issues/486
[#557]: https://github.com/gotgenes/pi-packages/issues/557
[#565]: https://github.com/gotgenes/pi-packages/issues/565
[#595]: https://github.com/gotgenes/pi-packages/issues/595
[#596]: https://github.com/gotgenes/pi-packages/issues/596
[#597]: https://github.com/gotgenes/pi-packages/issues/597
