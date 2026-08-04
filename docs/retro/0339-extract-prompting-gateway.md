---
issue: 339
issue_title: "Extract a context-owning PromptingGateway; collapse the prompt twins"
---

# Retro: #339 — Extract a context-owning PromptingGateway; collapse the prompt twins

## Stage: Planning (2026-06-07T14:21:40Z)

### Session summary

Produced the implementation plan for Phase 4 Step 6: extracting a `PromptingGateway` collaborator out of `PermissionSession` and collapsing the `canPrompt`/`canConfirm` and `prompt`/`promptPermission` twins into a single context-bound pair.
Confirmed the prerequisite Step 1 ([#334]) is closed and the issue only depends on it; Steps 7/8 ([#340]/[#341]) are downstream.
Plan filed at `packages/pi-permission-system/docs/plans/0339-extract-prompting-gateway.md`.

### Observations

- Two design choices surfaced via `ask_user`: (1) rename `GatePrompter.promptPermission` → `prompt` (chosen, matches the issue's literal `prompt(details)`); (2) full clean end state via lift-and-shift for the test fixtures (chosen over a minimal bridge).
- Decided the gateway absorbs the can-prompt policy (`canResolveAskPermissionRequest` + `isSubagentExecutionContext`), not just a relayed closure, so the `index.ts` `canRequestPermissionConfirmation` closure disappears (index closures 11 → 10, matching the roadmap claim at architecture.md line 669).
  Trade-off: gateway deps widen to 4 fields (`config`, `subagentSessionsDir`, `registry`, `prompter`), all used.
- Key constraint identified: the session still needs `this.context` for `getRuntimeContext`/`reload`/`logResolvedConfigPaths`, so this step accepts a transitional dual context store (session copy + gateway copy), synchronized through the single `activate`/`deactivate` path.
  Consolidation deferred to Step 8.
- The session forwards `activate`/`deactivate` to the gateway, mirroring the existing `forwarding.start/stop` pattern — this keeps the production change inside the four target files (`prompting-gateway.ts`, `permission-session.ts`, `runner.ts`, `index.ts`) since every existing `session.activate(ctx)` call site inherits gateway activation.
- Heaviest area is test migration: `MockGateHandlerSession` is the shared pivot; removing its `GatePrompter` fields breaks every constructor at once.
  The `promptPermission` → `prompt` rename also collides with the session's own `prompt(ctx, details)` until the session drops `GatePrompter`, so the rename must land *after* the rewire (cycle 3, not cycle 1).
  `input.test.ts` asserts on `session.promptPermission` directly, and `external-directory-session-dedup.test.ts` has its own local `makeStatefulSession`/`makeHandlerForSession` — both require migration.
- Plan uses a 9-cycle lift-and-shift: add gateway → rewire + bridge → rename → migrate 5 handler suites → drop bridge.
  Small adjacent suites may be grouped.

[#334]: https://github.com/gotgenes/pi-packages/issues/334
[#340]: https://github.com/gotgenes/pi-packages/issues/340
[#341]: https://github.com/gotgenes/pi-packages/issues/341

## Stage: Implementation — TDD (2026-06-07T14:57:32Z)

### Session summary

Completed all 9 TDD cycles: added `PromptingGateway` (cycle 1), wired it into production and shed the session's prompting role with a transitional bridge (cycle 2), renamed `GatePrompter.promptPermission` → `prompt` (cycle 3), migrated 5 handler test suites to steer via the `prompter` mock (cycles 4–8), and removed the bridge and all `undefined as unknown as ExtensionContext` casts (cycle 9).
Test count held at 87 files / 1,823 tests throughout (net zero: the 14 new gateway tests replaced the 4 prompting `describe` blocks removed from `permission-session.test.ts`, plus prior tests migrated rather than added).
Pre-completion reviewer returned WARN with one finding (roadmap Step 6 not marked complete) and one non-blocking lint note (unused `beforeEach` import); both fixed before stage notes.

### Observations

- The cycle 2 → cycle 9 split worked exactly as planned: `MockGateHandlerSession` kept its prompting extras until cycle 9; no handler test case needed touching until its own migration cycle.
- One deviation from the plan: `external-directory-integration.test.ts` had a latent `session.prompt` use in the `"external_directory — allow external reads"` describe block that the plan didn’t list explicitly; it was caught and fixed in cycle 9 when `pnpm run check` rejected the stale session field.
- `GatePrompter` rename sequencing worked cleanly: cycle 3 renamed the interface only after the session dropped it in cycle 2, avoiding the collision with the session’s own `prompt(ctx, details)` method.
- `makeHandlerForSession` in `external-directory-session-dedup.test.ts` was redesigned in cycle 8 to accept an optional `GatePrompter` and return `{ handler, prompter }`, which kept the final cycle 9 cleanup contained to one function.
- Pre-completion reviewer: WARN (resolved before commit — Step 6 marked `✓ complete` in `architecture.md`; unused `beforeEach` import removed from `test/prompting-gateway.test.ts`).

## Stage: Final Retrospective (2026-06-07T15:09:29Z)

### Session summary

Shipped #339 across four stages (plan on `claude-opus-4-8`, TDD on `claude-sonnet-4-6`, ship on `deepseek-v4-flash`, retro on `claude-opus-4-8`): `pi-permission-system-v10.4.0` is released, the issue is closed, and release-please PR #348 is merged.
The 9-cycle lift-and-shift landed with zero rework to production code and the test count held at 1,823 throughout.
The execution was unusually clean — the only friction was mechanical `Edit`-tool match failures caused by `pi-autoformat` reflowing code between edits.

### Observations

#### What went well

- The lift-and-shift bridge choreography (keep prompting extras on `MockGateHandlerSession`, migrate handler suites one per cycle, drop the bridge last) executed exactly as planned — no handler test case broke before its own migration cycle, and the plan's foresight meant only one unplanned spot surfaced (the latent `session.prompt` in `external-directory-integration.test.ts`), caught instantly by `pnpm run check`.
- Cost-appropriate model routing: the ship stage ran end-to-end on `opencode-go/deepseek-v4-flash` (cheap) for purely mechanical orchestration — push, CI watch, the stacked-release `ask_user` gate, issue close, release-please merge — and executed flawlessly, while judgment-heavy planning/retro stayed on `claude-opus-4-8` and implementation on `claude-sonnet-4-6`.
- The `pre-completion-reviewer` subagent caught both loose ends (roadmap Step 6 not marked `✓ complete`; unused `beforeEach` import) before they reached CI; both were fixed pre-push.
- Incremental verification was textbook: `pnpm run check` ran after nearly every cycle (turns 50, 64, 73, 99, 111, 118, 125, 135, 152, 156), per-file tests after each cycle, full suite before each commit boundary.

#### What caused friction (agent side)

- `other` (tooling) — `Edit` `oldText` match failures from `pi-autoformat` reflow.
  Four edits failed (turns 85, 87, 95, 140) because the agent built multi-line `oldText` from the layout it had just written, but `pi-autoformat` had reflowed that region (e.g. `const prompter: GatePrompter =\n    overrides?.prompter ?? {` collapsed onto one line).
  Each recovered within 2–3 calls (re-read or `grep`, then retry; turn 97 fell back to `sed`).
  Impact: ~8–10 extra tool calls across a ~210-turn session; no code rework.
- `missing-context` — colgrep skill not loaded in planning.
  Turn 4 guessed `.pi/skills/colgrep/SKILL.md` (the path pattern of the other five skills) and errored; the skill actually lives at `packages/pi-colgrep/skills/colgrep/SKILL.md` (the path is in the system `<available_skills>` list).
  The agent proceeded with `grep`/`find` and explored correctly, so the grep-vs-colgrep decision table was simply never consulted.
  Impact: no rework this session; recurring latent miss across sessions.

#### What caused friction (user side)

- None.
  Two `Continue.` nudges (turns 72, 110) were routine continuation prompts after the agent paused mid-cycle, not corrections.

### Diagnostic details

- **Model-performance correlation** — all four stage assignments were appropriate; no mismatches.
  The ship stage on `deepseek-v4-flash` is the ideal case (cheap model on deterministic tool orchestration), not a reasoning-weak-on-judgment mismatch.
  The `pre-completion-reviewer` subagent ran on its configured `claude-sonnet-4-6` — appropriate for judgment-heavy review.
- **Escalation-delay tracking** — no `rabbit-hole`; no sequence exceeded 5 consecutive tool calls on one error.
  The longest stall was 3 calls (turn 140→143) re-locating reflowed `oldText`.
- **Unused-tool detection** — colgrep was available but never loaded (path guess, above); it would have added the grep-vs-colgrep decision table but the grep-based exploration was already sufficient.
- **Feedback-loop gap analysis** — no gaps; verification ran incrementally after every cycle, not just at the end.

### Changes made

1. `AGENTS.md` — extended the `### Tool-injected messages` note: `pi-autoformat` reflows what you just wrote, so an `oldText` built from the emitted layout can fail to match; re-read a just-edited region before editing it again.
2. `packages/pi-permission-system/docs/retro/0339-extract-prompting-gateway.md` — added this Final Retrospective stage entry.
