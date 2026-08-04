---
issue: 531
issue_title: "pi-permission-system: remove the deprecated permissions:rpc:check / permissions:rpc:prompt event-bus channel"
---

# Retro: #531 — Remove the deprecated `permissions:rpc:check` / `permissions:rpc:prompt` event-bus channel

## Stage: Planning (2026-07-07T16:00:48Z)

### Session summary

Planned Phase 8 Step 7: the subtractive removal of the event-bus RPC subsystem (`permissions:rpc:check` + `permissions:rpc:prompt`) in favor of the surviving `Symbol.for()` `PermissionsService` accessor.
Wrote `docs/plans/0531-remove-deprecated-event-bus-rpc.md` with an atomic code+test removal step, a docs-repoint step (including marking the roadmap step ✅), and a `#309` scope-narrowing comment.
Release recommendation: ship independently as its own `feat(pi-permission-system)!:` major bump.

### Observations

- The issue and roadmap both say "remove `permissions:rpc:check` / `permissions:rpc:prompt`", but only the **check** channel/types carry `@deprecated` JSDoc in code — the **prompt** channel is not marked deprecated and its types (`PermissionsPromptRequest`, `PermissionsPromptReplyData`, `PermissionsRpcReply`, `PERMISSIONS_RPC_PROMPT_CHANNEL`) are publicly re-exported from `service.ts`.
  The roadmap's Findings section treats the prompt handler as a deprecated third elicitation path, so removal is intended; the plan removes both and notes the larger-than-labeled public-API break, subsumed by the major bump.
- Resolved two dead-code cascade calls per code-design's remove-dead-code rule: (1) `PERMISSIONS_PROTOCOL_VERSION` and `PermissionsRpcReply` are RPC-only (surviving broadcasts explicitly carry no `protocolVersion`), so both are removed; (2) `buildRpcUiPrompt` / `RpcPromptInput` and the `"rpc_prompt"` member of `PermissionUiPromptSource` (plus the `UI_PROMPT_SOURCES` whitelist entry in `authority/forwarding-io.ts`) are dead once the prompt handler is gone.
  Verified the file-based forwarded inbox never persisted `"rpc_prompt"`, so narrowing the union cannot orphan a stored request.
- "Unwire from `PermissionServiceLifecycle`" is a slight misnomer: `service-lifecycle.ts` takes the subscription list as an opaque `readonly (() => void)[]` and has no RPC reference — the actual edit is dropping the two `rpcHandles.unsub*` handles at the `index.ts` construction site.
- Removal is atomic by necessity: dropping the public exports from `permission-events.ts` breaks `service.ts`, the deleted handler, and all consumer tests at the type level in one commit — folded into a single `feat!` step per AGENTS.md guidance.
- Grep confirmed zero cross-package RPC consumers and no RPC references in `README.md` / `configuration.md` / schema / example config.
  The only remaining references after the change live in the frozen `docs/architecture/history/*.md` files, intentionally left unchanged.
- This is a pure narrowing change, so the `design-review` checklist (aimed at added/widened interfaces) finds nothing to fix — noted rather than run field-by-field.
- No follow-up issues filed; Open Questions is empty.
  The `#309` comment is an implementation action, not a new issue.

## Stage: Implementation — TDD (2026-07-07T17:45:00Z)

### Session summary

Executed both TDD Order steps as two commits: `feat(pi-permission-system)!: remove deprecated event-bus RPC channel` (atomic removal of `src/permission-event-rpc.ts`, its test, and all RPC symbols/consumers) and `docs(pi-permission-system): repoint cross-extension docs off the removed RPC channel` (docs repoint + roadmap Step 7 marked ✅).
Posted the scope-narrowing comment on [#309](https://github.com/gotgenes/pi-packages/issues/309).
Test count dropped from 2300 to 2272 (28 removed: the whole `permission-event-rpc.test.ts` file plus trimmed RPC-only blocks in three surviving test files) with zero new tests, matching the plan's Test Impact Analysis (pure removal, no new lower-level surface).
Pre-completion reviewer: initial **WARN** (one finding), resolved and re-reviewed to final **PASS**.

### Observations

- The removal was clean and matched the plan's atomic-step design: `pnpm run check` caught every dangling import from the type removal in `permission-events.ts` (three test files failed to compile; `src/` compiled clean on the first pass), confirming the plan's "tsc catches any missed importer" verification claim.
- One doc-comment cleanup not explicitly itemized in the plan: `src/service.ts`'s `PermissionsService` JSDoc said "Mirrors the simplified RPC signature" — reworded to drop the now-dead RPC reference since it was directly in the file already being edited for this step.
- **Real plan gap, caught by `pnpm run lint` from the repo root**: `docs/subagent-integration.md` had a `[Prompt Forwarding RPC](cross-extension-api.md#prompt-forwarding-rpc)` link.
  Root-level `rumdl`'s cross-file `MD051` fragment-link check failed after the RPC section was deleted from `cross-extension-api.md` — exactly the AGENTS.md warning that package-scoped lint misses this class of issue.
  Fixed by deleting the now-untrue sentence (file-based forwarding is the sole remaining mechanism).
- **Real plan gap, caught by a post-implementation repo-wide grep** (not lint): `docs/guides/permission-frontmatter-for-subagent-extensions.md` — a shipped, README-linked guide — had a full "Runtime Integration (Optional)" section with working RPC code examples (`permissions:rpc:check`, `permissions:rpc:prompt`) that the plan's Module-Level Changes never enumerated.
  The plan's Background section listed only `docs/cross-extension-api.md` and `docs/architecture/architecture.md` as doc touch points; a narrower `docs/cross-extension-api.md`-only grep during planning missed this sibling guide.
  Rewrote the section to the real `getPermissionsService()` dynamic-import pattern.
- **Real plan gap, caught by the pre-completion reviewer** (WARN → fixed → PASS): `docs/guides/upstream-issue-template.md` — also shipped — had an "Event Bus RPC" bullet and a link to the now-deleted `cross-extension-api.md#policy-query-rpc-deprecated` anchor, in a template meant for filing docs proposals against upstream subagent-extension repos.
  This is the third doc surface the plan's grep missed; three misses in one `docs/guides/` directory suggests a directory-level grep (`docs/guides/*.md` for the mechanism name) would have caught all three at plan time instead of trickling out across lint, a manual grep, and the reviewer.
- Takeaway for future RPC/mechanism-removal plans: when Module-Level Changes lists specific doc files by name, also run one unscoped `grep -rn <mechanism-name> docs/` before finalizing the plan — the reworked-mechanism grep guidance in AGENTS.md says to grep the mechanism name, but doing it file-by-file (as this plan did) missed siblings in the same directory as the one file that was checked.
- No steps remain — both TDD Order steps and the `#309` comment are complete.

## Stage: Final Retrospective (2026-07-07T19:16:59Z)

### Session summary

Shipped Phase 8 Step 7 end-to-end (plan → TDD → ship) in one session: pushed the atomic `feat!` removal plus docs repoint, closed #531, merged release-please PR #553, and cut `pi-permission-system-v20.0.0` (major, breaking).
The removal itself was mechanically clean — `tsc` caught every dangling import, the pre-completion reviewer caught one real doc-staleness WARN, and the ship flow self-corrected a post-merge CI flake.
The dominant cross-session pattern was a doc-grep scope gap at plan time: three shipped `docs/` surfaces referencing the RPC mechanism were missed and trickled out across three separate detection points.

### Observations

#### What went well

- The atomic-removal design held: dropping the public exports from `permission-events.ts` broke `service.ts` and three consumer test files at the type level in one commit, and `pnpm run check` surfaced all of them at once — the plan's "tsc catches any missed importer" claim proved exact, with `src/` compiling clean on the first pass.
- The pre-completion reviewer earned its keep: it caught a shipped, README-linked doc (`docs/guides/upstream-issue-template.md`) with a dead `#policy-query-rpc-deprecated` anchor that neither lint nor the manual grep had flagged — a genuine WARN → fix → PASS cycle, not a rubber stamp.
- The ship flow diagnosed and cleared a post-merge CI flake without user help: `ci_find` on the release-merge SHA showed the `check` job failed, `--log-failed` identified two unrelated `pi-session-tools` timeouts, and `gh run rerun --failed` unblocked the release tag in one retry (2 diagnostic tool calls, no rabbit-hole).

#### What caused friction (agent side)

- `missing-context` — the plan's Module-Level Changes enumerated only `docs/cross-extension-api.md` and `docs/architecture/architecture.md` as doc touch-points; a repo-wide `grep -rn permissions:rpc docs/` at plan time was never run, so three sibling docs referencing the removed mechanism (`docs/subagent-integration.md`, `docs/guides/permission-frontmatter-for-subagent-extensions.md`, `docs/guides/upstream-issue-template.md`) were missed.
  Impact: doc fixes trickled out across three detection points during TDD/ship — root `rumdl` (`MD051` fragment link), a post-implementation manual grep, and the pre-completion reviewer's WARN — costing one extra amend cycle on the docs commit instead of one clean pass.
- `missing-context` — the package skill (`.pi/skills/package-pi-permission-system/SKILL.md`) still names the deleted `permission-event-rpc.ts` handler (line 125) and lists "RPC" as a live `pi.events` channel (line 120) after the ship.
  The existing `/plan-issue` rule to "grep `.pi/skills/package-*/SKILL.md` for every removed symbol" would have caught `permission-event-rpc.ts`, but it was not applied at plan or TDD time, and the pre-completion reviewer's doc sweep did not cover `.pi/skills/`.
  Impact: the skill shipped stale — a factual error the next reader of that skill inherits; fixed in this retro.

#### What caused friction (user side)

- None — the entire plan → TDD → ship → retro arc ran autonomously with no user correction or redirection.
  The one moment where earlier context could have helped is orthogonal to this issue: the flaky `pi-session-tools` timeouts are a pre-existing infrastructure gap the operator may already know about, but nothing about this issue's flow depended on it.

### Diagnostic details

- **Feedback-loop gap analysis** — verification ran incrementally and caught most issues at the right layer (`pnpm run check` after the atomic removal; root `pnpm run lint` for the cross-file `MD051`).
  The one gap: no `.pi/skills/` grep ran at any stage, so the stale skill references slipped past both the TDD-time symbol grep and the pre-completion reviewer, surfacing only in this retro.
- **Escalation-delay / unused-tool** — no rabbit-holes; the CI-flake diagnosis was 2 tool calls.
  The doc-grep gap was a grep-*scope* miss, not a missing-tool miss — a single unscoped `grep -rn` would have closed it, no subagent needed.

### Follow-up (not implemented here)

- The `pi-session-tools` tests `test/read-parent-session.test.ts` and `test/read-session-file.test.ts` timed out at 5000ms on the release-merge commit, blocking the release tag until a rerun.
  These are flaky, unrelated to #531, and live in a different package — worth a separate GitHub issue against `pi-session-tools` (raise the `testTimeout` or fix the dynamic-`import("#src/index")` slow path), then `/plan-issue` on it.
  Out of scope for this retro.

### Changes made

1. `.pi/skills/package-pi-permission-system/SKILL.md` — dropped the two stale RPC references left by #531: the `pi.events` bullet no longer lists "RPC" (now names the three surviving broadcasts), and the `LocalPermissionsService` paragraph no longer cites the deleted `permission-event-rpc.ts` handler; added a one-line note that #531 removed the RPC channel and the `Symbol.for()` accessor is the sole cross-extension surface.
2. `.pi/prompts/plan-issue.md` — extended the Module-Level Changes removed-export grep guidance: when the removed export is a public or cross-extension API surface, also grep the whole `packages/<PKG>/docs/` tree, not just `docs/architecture/` (Refs #531).
