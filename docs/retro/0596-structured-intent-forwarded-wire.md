---
issue: 596
issue_title: "pi-permission-system: carry the structured access intent onto the forwarded-permission wire"
---

# Retro: #596 — carry the structured access intent onto the forwarded-permission wire

## Stage: Planning (2026-07-18T15:25:00Z)

### Session summary

Planned Phase 12 Track A Step 2 — thread the child-fixed access facts from the raising gate through the escalation edge and onto the forwarded wire as the `ForwardedAccessIntent` field ADR 0008 (Step 1) specified.
The plan is a `feat:` sequence of six small cycles (wire type + tolerant read; edge serialization; four gate-emission steps) plus a `docs:` completion step, filed at `packages/pi-permission-system/docs/plans/0596-structured-intent-forwarded-wire.md`.
Skipped the `ask_user` gate: the issue is the operator's own and its proposed change is fully constrained by the already-accepted ADR 0008.

### Observations

- **Fact / identity split drove the design.**
  ADR 0008 groups a forwarded ask into *what is accessed* (fixed at the child gate) and *who/where requests* (a requester-session property).
  The plan mirrors that: the **gate emits** `{ surface, matchValues, boundaryValue }` (only it can produce the match set off the `AccessPath`), and the **escalation edge (`ParentAuthorizer`) stamps** `requesterCwd` + `principal`.
  This avoids threading cwd into every gate and localizes principal-stamping to the one layer that owns session identity.
- **`ForwarderContext` gains `cwd`** (from `ExtensionContext.cwd`, already present) so `ParentAuthorizer` sources `requesterCwd` at the edge — the one shared-interface tightening.
  Its fixture blast radius is contained by the central `makeForwarderContext` factory (`test/helpers/forwarding-fixtures.ts`); inline `ForwarderContext` fakes must add `cwd` in the same commit (the AGENTS.md tightened-shared-type fixture-grep rule).
- **No `GateDescriptor` change needed.**
  `GateDescriptor.promptDetails` is `Omit<PromptPermissionDetails, "requestId">`, and the runner spreads `promptDetails` into `escalate(...)`, so adding `accessIntent?` to `PromptPermissionDetails` makes it ride through every descriptor automatically — the facts land on `promptDetails`, satisfying the issue's "onto the descriptor/details" target without a structural edit to `descriptor.ts`.
- **ADR-0002 string boundary held explicitly.**
  Each gate converts its `AccessPath` to strings (`matchValues()`/`boundaryValue()`) at emit; the wire carries `string[]`, never an `AccessPath`.
  A Step-1 test asserts the serialized shape is strings only; the existing `permission-manager.ts` import lint is untouched.
- **Tolerant-read touch point** ([#558]) — `readForwardedPermissionRequest` reconstructs an allowlist, so the new field is silently dropped unless `asForwardedAccessIntent` is wired in; that extension is the first cycle and is round-trip tested (well-formed / malformed / absent).
- **Scope fence against Step 3** ([#597]) — serving still re-derives from display strings; `forwarded-request-server.ts`, `index.ts`'s `servingPolicy`, the `hasDisplayFields` floor, and agent-scoped resolution are all Non-Goals.
  The serving-read metric stays 0; only the forwarded-wire metric moves to ≥ 1.
- **Non-breaking** — an additive optional field with a tolerant read; no config/schema/default/observable-decision change.
  Commits are `feat:`/`test:`/`docs:`, none breaking.
- **Release**: mid-batch — defer (batch "cross-session-intent", tail = Step 3 / #597).
  Step 2 is not the batch tail, so it cuts no release on its own.
- **No follow-up issues filed** — Step 3 (#597) already exists; ADR 0008 records the two deferred edges (single-surface fact set, multi-hop principal identity).
  One resolved-in-plan design choice: `principal` nests a self-contained copy rather than reusing the top-level `requesterSessionId`/`requesterAgentName`, because Step 3 reads `intent.principal.agentName` and a self-contained fact object is cleaner.
- Next stage is `/tdd-plan` (the plan has red→green→commit cycles).

### Diagnostic details

- **Feedback-loop gap analysis** — grounded every design claim in source before writing: read all target files (`permission-forwarding.ts`, `forwarding-io.ts`, `approval-escalator.ts`, `permission-prompter.ts`, the six gate factories, `forwarder-context.ts`, `access-path.ts`) and confirmed `ForwarderContext` lacks `cwd` while `ExtensionContext.cwd` exists (`permission-gate-handler.ts:73`), which is what made the edge-sourced `requesterCwd` viable.

## Stage: Implementation — TDD (2026-07-18T16:12:28Z)

### Session summary

Executed all seven plan steps plus two Tidy-First preparatory refactors: threaded a structured `ForwardedAccessIntent` from each permission gate, through the escalation edge, onto the forwarded wire.
Nine plan-execution commits (1 wire type + tolerant read, 1 edge serialization, 4 gate-emission steps, 1 docs) landed green; two extra commits resolved the pre-completion reviewer's WARN.
Test count 2472 → 2491 (+19); pre-completion reviewer returned WARN, both findings addressed.

### Observations

- **Tidy-First paid off exactly as scoped.**
  The `tidy-first-assessor` recommended two dependency-free prep refactors — bundling `approval-escalator.ts`'s three relayed optionals (`message`/`display`/`sessionApproval`) into one `ForwardedRequestFacts` object (the parameter-relay smell), and hoisting `describeToolGate`'s `decisionValue` into a local.
  Both landed first, so Step 2 added one field to an existing bundle instead of extending two method signatures, and Step 5 reused the local for the single-value fact form.
  The assessor also correctly declined the `ForwarderContext`/`cwd` fixture audit as near-zero blast radius — confirmed when `pnpm run check` passed after the `cwd` widening with only `makeForwarderContext` touched (all inline fakes already set `cwd` or use the factory).
- **Fact/identity split held.**
  The gate emits `{ surface, matchValues, boundaryValue }` (what's accessed, the only facts unreconstructable downstream); `ParentAuthorizer` stamps `requesterCwd` (via the new `ForwarderContext.cwd`/`getCwd`) and `principal`.
  `requesterCwd` sourced at the edge from `ctx.cwd` — the assessor's audit made this cleaner than per-gate threading (skill-input has no `tcc`).
- **`descriptor.ts` needed no change** (a plan-predicted simplification): facts ride on `promptDetails` via the `Omit<PromptPermissionDetails, "requestId">`, and the runner already spreads `promptDetails` into `escalate(...)`.
- **Fact-construction helpers folded into Step 1** per the assessor (they return the Step-1 wire type): `accessFactsFromPath`/`accessFactsFromValue` in `handlers/gates/helpers.ts`, so Steps 3–6 are one-line calls.
  ADR-0002 honored — gates convert `AccessPath` → strings at emit.
- **Two eslint frictions, both self-caught.** (1) `Partial<ForwardedAccessIntent>` types nested fields as non-null, so the tolerant reader's runtime `=== null` checks tripped `no-unnecessary-condition`; fixed by typing the candidate fields as `unknown` (the correct tolerant-read shape). (2) `boundaryValue()` returns `string`, so `|| null` is *not* flagged by `prefer-nullish-coalescing` — the pre-commit auto-fix silently stripped my speculative `eslint-disable` directive (leaving a blank line), which the reviewer flagged; removing the directive entirely was correct.
- **Pre-completion reviewer: WARN** — two non-blocking findings, both resolved before finishing: (1) stray blank line in `helpers.ts` (removed); (2) the plan's own "Invariants at risk" section asked for a test co-asserting display fields + `accessIntent` on one request, which was missing — strengthened the `approval-escalator` stamp test to assert `source`/`surface`/`value` alongside `accessIntent`, and added `helpers.test.ts` unit tests for both fact helpers including the empty-boundary→`null` edge case.
- **Reviewer note (non-issue):** a full-monorepo `pnpm run test` showed 2 pre-existing pi-autoformat acceptance flakes (real-`pi`-CLI RPC timeouts under concurrent load); zero pi-autoformat files touched, standalone re-run green.
- **Release**: mid-batch — defer (batch "cross-session-intent", tail = Step 3 / #597).
  Next step is `/ship-issue`.

## Stage: Final Retrospective (2026-07-18T17:20:47Z)

### Session summary

Shipped issue #596 end to end in one continuous session: planned Phase 12 Track A Step 2, executed six TDD cycles bracketed by two Tidy-First prep refactors, handled the pre-completion reviewer's WARN, then pushed, verified CI green, closed the issue, and deferred the release per the operator's ship-time confirmation.
The change threads a structured `ForwardedAccessIntent` from every permission gate through the escalation edge onto the forwarded wire (ADR 0008), non-breaking, test count 2472 → 2491.
An exceptionally low-friction session — the only user input across all four stages was the one release-defer decision at ship time.

### Observations

#### What went well

- **The `tidy-first-assessor`'s rejection list was as valuable as its recommendations (novel win).**
  Beyond the two prep refactors it recommended, it *pre-verified* the `ForwarderContext`/`cwd` widening's fixture blast radius as near-zero and told me not to hunt inline fakes — confirmed empirically when `pnpm run check` passed after the widening with only `makeForwarderContext` touched.
  The "Rejected as scope creep" analysis saved a speculative grep-and-edit pass across five test files the plan had flagged as candidates.
- **The pre-completion reviewer caught a plan-named invariant gap.**
  The plan's own "Invariants at risk" section asked for a test co-asserting display fields + `accessIntent` on one request; I built all the gates but never wrote that combined assertion.
  The reviewer flagged exactly that gap (WARN), and closing it strengthened the `approval-escalator` stamp test plus added `helpers.test.ts` edge-case coverage — the reviewer doing precisely its job on a self-inflicted omission.
- **Incremental verification throughout.**
  Green baseline (`check` + root `lint` + `test`) before any edit; `pnpm run check` after every shared-type change; the target test file after each red→green; full suite + root lint + `fallow dead-code` after the last step and again pre-push.
  No end-of-session verification pile-up.
- **Deferred-release path exercised cleanly.**
  `/ship-issue` read the plan's `**Release:** mid-batch — defer` marker up front, asked once, closed the issue, and skipped the release-please merge — decoupling "work is on `main`" (close) from "cut a version" (batch tail) exactly as designed.

#### What caused friction (agent side)

- `other` (speculative lint suppression) — in Step 1 I wrote `boundaryValue: path.boundaryValue() || null` with a preemptive `// eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing`.
  `boundaryValue()` returns a non-nullable `string`, so the rule never fired; the pre-commit auto-fix stripped the unused directive and left a stray blank line inside the object literal, which the reviewer flagged (WARN).
  Impact: one cosmetic reviewer WARN + a small remediation cycle (re-added the disable → eslint unused-directive error → removed it entirely).
  Self-caught by the auto-fix and reviewer; no behavior rework.
- `other` (staging/autoformat interaction) — the first Step-1 commit attempt did not finalize: pi-autoformat reflowed `helpers.ts` after it was staged (an `MM` state), and the commit ended without a log line.
  Impact: one extra `git add` + re-commit; no rework.
  Already covered by the AGENTS.md note that autoformat reflows after `Edit`/`Write`.

#### What caused friction (user side)

- **None — the session was a model of minimal, well-placed oversight.**
  The operator's single intervention (the release-defer `ask_user` at ship time) was exactly the strategic-judgment call the workflow reserves for a human; everything else ran unattended from a plan the operator had already reviewed.

### Diagnostic details

- **Model-performance correlation** — the parent session alternated `anthropic/claude-opus-4-8` and `anthropic/claude-sonnet-5` (operator-driven) across the heavy-reasoning stretches.
  The two subagent dispatches (`tidy-first-assessor`, `pre-completion-reviewer`) ran on their configured models for judgment-heavy tasks (preparatory-refactor assessment; quality review) — appropriate, no mismatch.
- **Escalation-delay tracking** — no `rabbit-hole` friction; both eslint frictions resolved within 1–2 tool calls, no sequence approached the 5-call threshold.
- **Unused-tool detection** — no `missing-context` gaps; the planning stage had already grounded every design claim in source (the `ForwarderContext` cwd finding), so implementation needed no exploratory search.
- **Feedback-loop gap analysis** — verification was incremental at every stage (see "What went well"); no lens found a deferred-verification gap.

### Changes made

1. `.pi/skills/code-design/SKILL.md` — added a `### Speculative eslint-disable directives` subsection under "Biome / ESLint linter conflicts": add a disable only after the linter reports the rule (the pre-commit auto-fix strips an unused directive and leaves a stray blank line), and a `||`-default on a non-nullable primitive does not trip `prefer-nullish-coalescing`.
2. `packages/pi-permission-system/docs/retro/0596-structured-intent-forwarded-wire.md` — appended this Final Retrospective stage entry.
