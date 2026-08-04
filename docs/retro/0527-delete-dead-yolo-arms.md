---
issue: 527
issue_title: "pi-permission-system: delete dead yolo arms from the prompt path; dissolve yolo-mode.ts"
---

# Retro: #527 — delete dead yolo arms from the prompt path; dissolve `yolo-mode.ts`

## Stage: Planning (2026-07-05T00:00:00Z)

### Session summary

Planned Phase 8 Step 3: a pure narrowing that deletes the two unreachable yolo branches Step 2 ([#526]) left behind (the `PermissionPrompter` auto-approve arm and `PromptingGateway.canConfirm()`'s yolo arm), dissolves `src/yolo-mode.ts` by moving `isYoloModeEnabled` into `extension-config.ts`, and drops the now-dead `config` dependency from `PermissionPrompterDeps` and `PromptingGatewayDeps`.
The plan is four commits (three `refactor:` cycles plus a `docs:` completion commit) and is the tail of the "yolo-recorded-authority" release batch, so it ships now.

### Observations

- The issue text says only "move `isYoloModeEnabled`"; tracing the two `shouldAutoApprovePermissionState` call sites showed the prompter arm is the only caller passing a variable `state` — once it is removed, the serve arm always passes `"ask"`, so `shouldAutoApprovePermissionState` collapses to `isYoloModeEnabled` and is deleted rather than moved.
  The serve arm re-points at `isYoloModeEnabled` (behavior-identical), keeping `test/permission-forwarder.test.ts` green as the invariant pin.
- Removing the `config` field from both dependency bags is a dependency-width *narrowing*, so the design-review checklist confirmed no new structural smell — the fixes are inline, not a follow-up.
- The safety of deleting the prompter arm rests on the exhaustive reachability trace recorded in the [#526] retro (no `ask` reaches the prompter under yolo); cited it in "Invariants at risk" rather than re-deriving it.
- `test/yolo-mode.test.ts` is deleted outright: its two subjects are removed, and its lone `resolvePermissionForwardingTargetSessionId` assertion duplicates an existing case in `test/permission-forwarding.test.ts` ("isSubagent=true, no candidates set returns null"), so no relocation is needed.
- Doc sweep targets: `docs/architecture/architecture.md` (module tree line, `prompting-gateway.ts` description, two metric rows, Step 3 `✅` marker + Mermaid node) and `docs/architecture/permission-prompter.md` (the [#526] retro flagged this one rides with #527).
  No `README.md` command-surface change.

[#526]: https://github.com/gotgenes/pi-packages/issues/526

## Stage: Implementation — TDD (2026-07-05T00:00:00Z)

### Session summary

Executed all four planned commits: removed `PermissionPrompter`'s dead auto-approve arm, reduced `PromptingGateway.canConfirm()` to `hasUI ∨ isSubagent` and deleted `canResolveAskPermissionRequest`/`AskPermissionResolutionOptions`, dissolved `src/yolo-mode.ts` (moved `isYoloModeEnabled` into `extension-config.ts`, deleted `shouldAutoApprovePermissionState`, re-pointed the forwarded-inbox serve arm), then updated `architecture.md` (Step 3 ✅ marker, Mermaid node, module tree, two metric rows) and `permission-prompter.md`.
Test count moved 2299 → 2283 (removed 4 prompter yolo tests, 1 gateway yolo test, 8 `yolo-mode.test.ts` tests; added 3 `isYoloModeEnabled` tests in `extension-config.test.ts`).
The `pre-completion-reviewer` returned PASS on the first dispatch.

### Observations

- No deviations from the plan — all four TDD steps landed exactly as designed, including the dependency-bag narrowing (`config` dropped from both `PermissionPrompterDeps` and `PromptingGatewayDeps`) and the serve-arm re-point to `isYoloModeEnabled` with the Phase 9 retention comment.
- Followed the plan's metrics-table guidance by prefixing `✅` on the Target-column values for "yolo checks on the ask path" and "canConfirm() predicates" (matching the precedent in `docs/architecture/history/phase-7-accesspath-universal-representation.md`) rather than mutating the frozen "Phase 7 close" baseline column.
- The `test/permission-forwarder.test.ts` serve-arm test needed no edit — confirmed the plan's claim that `isYoloModeEnabled` is behavior-identical to the old `shouldAutoApprovePermissionState("ask", …)` call it replaced.
- Pre-completion reviewer: PASS.
  Reviewer warnings: one non-blocking note — `architecture.md`'s "Target: the authority model" section (~line 500) still names `yolo-mode.ts` in a "today these concerns are spread across…" sentence; this was outside the plan's declared doc-sweep scope (module tree, Step 3 marker, two metric rows, `permission-prompter.md`) and is left for a future spine-related doc pass.
- Batch status: this is the tail of "yolo-recorded-authority" (Steps 2, 3) — `/ship-issue` should now merge the release-please PR left open by [#526]'s `mid-batch — defer` marker.

## Stage: Final Retrospective (2026-07-06T00:45:00Z)

### Session summary

Shipped Phase 8 Step 3 across three stages (plan, TDD, ship) that ran essentially without rework: the plan matched the implementation exactly (four commits, zero deviations), the `pre-completion-reviewer` returned PASS on the first dispatch, CI was green on push, and the batch-tail release (`pi-permission-system-v18.2.0`) merged cleanly, closing both [#526] and [#527].
The only friction was three minor, self-caught tool-usage slips in the ship/TDD stages, none of which caused rework or commit churn.

### Observations

#### What went well

- Zero-deviation execution: the plan's four-commit TDD order landed verbatim, the design-review "narrowing" call held (dropping `config` from `PermissionPrompterDeps` and `PromptingGatewayDeps` introduced no smell), and the pre-completion reviewer passed first try.
  This is the payoff of a plan that did the hard reasoning up front (the reachability trace, the `shouldAutoApprovePermissionState`-collapses-to-`isYoloModeEnabled` insight).
- Cross-session context bridge worked as designed: the [#526] retro's exhaustive reachability trace ("no `ask` reaches the prompter under yolo") was cited directly in the plan's "Invariants at risk" and reused by the pre-completion reviewer, so the prompter-arm deletion was never re-litigated.
- Batch-tail release coordination was frictionless: the plan's `**Release:**` marker drove the ship decision with no operator prompt, and `/ship-issue` closed both batch members ([#526] deferred from a prior session, [#527] this session) against the single `v18.2.0` release.
- Incremental verification cadence: `pnpm run check` ran immediately after each interface-narrowing step, the affected test file after each red/green, and the full suite + lint + `fallow dead-code` before the pre-completion dispatch — no end-only verification gap.

#### What caused friction (agent side)

- `other` (tool-arg misuse) — during the release-PR merge, passed a `$(gh pr view 545 --json headRefOid -q .headRefOid)` shell substitution as `ci_find`'s `expected_sha`.
  `ci_find` is not a shell, so it received the literal string and timed out after ~125s / 7 retries.
  Recovered automatically from the timeout's `last_seen_sha: e5eca3c (run 28760232176)` hint, feeding the run id straight to `ci_watch`.
  This was also a minor deviation from `/ship-issue` step 6.4, which prescribes re-polling `gh pr view --json statusCheckRollup` for a release PR's in-progress check rather than reaching for `ci_find`/`ci_watch`.
  Impact: ~2 min wait, no rework.
  Self-identified.
- `other` (careless multi-edit) — a step-2 `Edit` on `prompting-gateway.ts` inserted a stray `// eslint-disable-next-line no-restricted-syntax -- placeholder removed below` line above `prompt(details:`.
  Caught it on the immediate re-read and removed it before the commit.
  Impact: one extra `Edit`, no commit churn.
  Self-identified.
- `other` (tool-schema slip) — twice included an invalid `newText_note` key inside an `Edit` `edits[]` entry (the forwarder import edit and the `architecture.md` metrics edit); both were rejected with "must not have additional properties" and retried immediately with the key removed.
  Impact: 2 rejected calls, no rework.
  Self-identified.

#### What caused friction (user side)

- None — the issue was the operator's own, well-specified, and required no mid-session correction or clarification.

### Diagnostic details

- **Model-performance correlation** — one subagent dispatch (`pre-completion-reviewer`) on judgment-heavy review work; appropriate assignment, PASS first try.
  No reasoning-weak-model-on-judgment or high-cost-model-on-mechanical mismatch.
- **Feedback-loop gap analysis** — verification ran incrementally throughout TDD (per-step `check` + affected test file), not only at the end; no gap to flag.
- **Escalation-delay / unused-tool** — no `rabbit-hole` or `missing-context` friction; the `ci_find` timeout was a single tool call (its 7 retries are internal), so no >5-call escalation and no subagent/`colgrep` opportunity was missed.

### Changes made

1. Added this Final Retrospective stage entry to `packages/pi-permission-system/docs/retro/0527-delete-dead-yolo-arms.md`.
2. No `AGENTS.md` or prompt changes — the operator confirmed retro-only; the one substantive slip (`ci_find` on a release-PR in-progress check) is already covered by `/ship-issue` step 6.4's `statusCheckRollup` re-poll guidance.
