---
issue: 317
issue_title: "Remove PermissionForwardingDeps; inline polling logic as forwarder methods"
---

# Retro: #317 — Remove PermissionForwardingDeps; inline polling logic as forwarder methods

## Stage: Planning (2026-06-02T00:00:00Z)

### Session summary

Produced the implementation plan for the final step (3 of 3) of the forwarding lift-and-shift: inline the `polling.ts` free functions (`confirmPermission`, `waitForForwardedPermissionApproval`, `processForwardedPermissionRequests`) as private `PermissionForwarder` methods reading `this`, dissolve the `PermissionForwardingDeps` bag into constructor-injected fields, and delete `polling.ts`.
Verified prerequisites [#315] and [#316] are already landed, audited every consumer of the removed symbols, and identified the doc/skill references that name them.

### Observations

- Decisive design call: dissolve the bag into individual `private readonly` fields rather than keeping `this.deps`, driven by the architecture doc's Step 2 note ("a later step … removes the bag").
  The lower-churn `this.deps.<field>` alternative was considered and rejected.
- The constructor gains a new `PermissionForwarderDeps` interface (same shape as the deleted `PermissionForwardingDeps`) consumed at exactly one site (`index.ts`); the `index.ts` object literal is unchanged, only its type annotation.
- Type coupling forces a single `refactor:` commit: deleting `polling.ts` breaks `index.ts`, `permission-forwarder.test.ts`, `permission-forwarding.test.ts`, and a stale `vi.mock` in `runtime.test.ts` simultaneously.
  That stale mock in `runtime.test.ts` is provably unused (`runtime.ts` has no polling import) but must be removed in the same commit to keep module resolution valid.
- `getSessionId` and `formatForwardedPermissionPrompt` are exported from `polling.ts` but have no external consumers — they become module-private functions in the forwarder (verify with `pnpm fallow dead-code`).
- Three doc surfaces reference removed symbols and need updating in a follow-up `docs:` commit: `architecture.md` (mark Phase 3 Step 4 done), `permission-prompter.md` (stale `PermissionForwardingDeps` sentence), and `.pi/skills/package-pi-permission-system/SKILL.md` (the `confirmPermission` testing note).
- The decomposition (`buildForwardedRequest`, `pollForForwardedResponse`, `processSingleForwardedRequest`) clears the code-design bar — the first two return values, the third owns a cohesive per-request workflow reading `this` — so it is genuine design, not procedure-splitting.
- Behavior-preservation safety net: `composition-root.test.ts` "subagent registry sharing" round-trip plus the migrated forwarder behavior tests; this is a `refactor:` cycle (keep green), not red→green.

## Stage: Implementation — TDD (2026-06-02T16:31:00Z)

### Session summary

Completed the single refactor commit in one TDD cycle: rewrote `permission-forwarder.ts` to own the forwarding behavior as private methods, deleted `polling.ts`, updated `index.ts` type annotation, rewrote `permission-forwarder.test.ts` with 5 real behavior tests, pruned 5 stale tests from `permission-forwarding.test.ts`, removed the dead `vi.mock` from `runtime.test.ts`, and committed the follow-up `docs:` commit updating `architecture.md`, `permission-prompter.md`, and `SKILL.md`.
Test count: 1756 → 1753 (removed 8 delegation/free-function tests, added 5 behavior tests).
Pre-completion reviewer returned **PASS**.

### Observations

- The plan's `currentSessionId` parameter on `processSingleForwardedRequest` was not in the plan's sketch (which showed 4 params) but was added to avoid calling `getSessionId(ctx)` twice per request loop; clean and correct.
- A trailing blank line introduced by the Python-based block deletion caused a Biome format failure; fixed with `pnpm exec biome check --write`.
- The `getContextSystemPrompt` helper passes `null` as logger to `logPermissionForwardingWarning`, swallowing the warning silently — the reviewer noted this as a deliberate trade-off documented in an inline comment, not a smell.
- Pre-completion reviewer verdict: PASS.
  No WARN findings.

## Stage: Final Retrospective (2026-06-02T17:00:00Z)

### Session summary

One continuous session carried issue #317 from planning through TDD, shipping, and this retrospective.
The `refactor:` landed in a single commit (`80028585`) plus a `docs:` follow-up (`f03be193`), CI passed, and the ship stage closed the entire stacked sequence (#314–#317).
The session ran end-to-end without user correction.

### Observations

#### What went well

- Plan→execution fidelity: the plan predicted the exact type-coupling breakage set (`index.ts`, `permission-forwarder.test.ts`, `permission-forwarding.test.ts`, and the stale `runtime.test.ts` mock) and folded them into one `refactor:` commit; TDD reproduced it with zero rework and a clean pre-completion PASS.
- The planning symbol-usage audit (grepping `getSessionId` and `formatForwardedPermissionPrompt`) correctly predicted they would become module-private with no `fallow` dead-code fallout — confirmed green at ship.
- Ship cleanly closed the full stacked sequence #314–#317 with tailored per-issue comments, and correctly reasoned that no release-please PR would appear because every commit since `pi-permission-system-v10.0.0` is `refactor:`/`docs:`.

#### What caused friction (agent side)

- `other` (self-identified) — when removing the two migrated `describe` blocks from `permission-forwarding.test.ts`, I first renamed them to placeholder names (`_placeholder_to_be_removed`, `_confirmPermission_placeholder`) before realizing they needed wholesale deletion, then cut from a marker to EOF with a Python script.
  Impact: ~2 wasted tool calls (the rename `Edit`); no rework to the final file.
- `other` (self-identified) — the Python marker-to-EOF cut left a trailing blank line that failed Biome formatting; fixed with `pnpm exec biome check --write`.
  Impact: one extra fix step, caught by the lint gate before commit; no rework.

#### What caused friction (user side)

- None — the workflow prompts and the pre-completion reviewer carried verification end-to-end with no user intervention needed.

#### Process observation (not a friction point)

- Issues #314, #315, #316 were still open when #317 shipped, so this ship session closed all four at once.
  The mechanism is already in the `ship-issue` prompt (step 5 closes stacked issues because release-please omits `refactor:` from the changelog), and it worked as designed.
  Worth confirming whether the earlier ship sessions left their own target issues open intentionally (batched closure for the lift-and-shift sequence) or by omission.

### Changes made

1. Appended this Final Retrospective stage entry to `packages/pi-permission-system/docs/retro/0317-remove-permission-forwarding-deps.md`.
2. No `AGENTS.md` or prompt changes — the user confirmed retro-only; the two minor friction points were self-corrected by existing verification gates and do not generalize into rules.
