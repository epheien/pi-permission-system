---
issue: 530
issue_title: "pi-permission-system: split PermissionForwarder by direction of authority flow"
---

# Retro: #530 — pi-permission-system: split PermissionForwarder by direction of authority flow

## Stage: Planning (2026-07-07T00:00:00Z)

### Session summary

Planned Phase 8 Step 6: splitting the 578-line dual-role `PermissionForwarder` into `ApprovalEscalator` (escalation-up, `ApprovalRequester`) and `ForwardedRequestServer` (serving-down, `InboxProcessor`), relocating the forwarding subsystem into `src/authority/` and dissolving `src/forwarded-permissions/`.
The plan is a non-breaking `refactor:` sequenced as three tidy-first extraction commits plus a doc-update commit, filed at `packages/pi-permission-system/docs/plans/0530-split-permission-forwarder-by-direction.md`.

### Observations

- The 7-field `PermissionForwarderDeps` bag partitions cleanly by role: `detection`/`registry` are escalation-only, `config`/`events` are serving-only, and `forwardingDir`/`logger`/`requestPermissionDecisionFromUi` are shared — so each new deps interface is a strict 5-field narrowing.
  Confirmed the escalation UI fast path does **not** emit a UI event (the prompter does), which is why the escalator drops `events`.
- The issue's proposed change lists 3 target files but omits where the shared `ForwarderContext` type + `getSessionId` helper live (both classes and both seams need them).
  Asked the operator; confirmed a dedicated `src/authority/forwarder-context.ts` over folding into `forwarding-io.ts` or duplicating across the sibling classes.
- Consumers are well-contained: only `permission-prompter.ts` (`ApprovalRequester`), `forwarding-manager.ts` (`InboxProcessor`), and `index.ts` import the split symbols; `composition-root.test.ts` reaches forwarding via the real factory, not direct imports.
- Doc-staleness sweep found `docs/architecture/architecture.md` (module tree, Step 6 marker, metrics row), `docs/architecture/permission-prompter.md`, and `.pi/skills/package-pi-permission-system/SKILL.md` naming the old symbols; the frozen `docs/architecture/history/` phase docs are intentionally left as-is.
- Roadmap tags Steps 4–6 `Release: independent` with no batch; as a hidden `refactor:` type this lands and auto-batches into the next release rather than cutting one — Release Recommendation worded accordingly.
- Next step is `/tdd-plan` (pure-refactor cycles: relocate code + tests, keep the suite green).

## Stage: Implementation — TDD (2026-07-07T10:50:00Z)

### Session summary

Executed all 4 planned steps as 4 commits: (1) renamed `io.ts` → `forwarding-io.ts` and extracted the shared `ForwarderContext` + `getSessionId` into a new `forwarder-context.ts`; (2) extracted `ForwardedRequestServer` (serving-down role) into `src/authority/`, narrowing `PermissionForwarderDeps` to escalation-only fields; (3) renamed the remaining `PermissionForwarder` → `ApprovalEscalator` and dissolved both `src/forwarded-permissions/` and `test/forwarded-permissions/`; (4) updated `architecture.md`, `permission-prompter.md`, the package `SKILL.md`, and two doc comments (`session-logger.ts`, `subagent-detection.ts`).
Test count: 112 → 113 test files (one new file, `forwarded-request-server.test.ts`), 2300 → 2300 tests (no net change — pure relocation/split, no new or removed test cases).
All deterministic checks (`pnpm run check`, `pnpm run lint`, `pnpm run test`, `pnpm fallow dead-code`) passed clean at the end.

### Observations

- No deviations from the plan.
  The dependency partition predicted in planning (5-field `ApprovalEscalatorDeps` / 5-field `ForwardedRequestServerDeps`) held exactly as designed; no unplanned coupling surfaced.
- One planning gap surfaced during Step 2: the two `requestApproval` tests in the escalator's test file passed an `events` mock into deps purely to assert `events.emit` was never called — but `ApprovalEscalatorDeps` no longer has an `events` field.
  Fixed by keeping the `events` mock as a standalone assertion target (not injected into deps), preserving the "escalator never emits UI events" documentation value of the test without a type error.
- The empty `test/forwarded-permissions/` directory (left over from Step 1's file move) had to be `rmdir`'d explicitly in Step 3 — git does not track empty directories, so the Step 1 commit left a stray empty dir on disk that only became visible once Step 3 tried to remove the sibling `src/forwarded-permissions/`.
- Updated the "What it consolidates" bullet in the Target authority-model section (not explicitly named in the plan's Module-Level Changes) to stop describing the split as future Phase 9 work, since Phase 8 Step 6 already completed it — judged this was within the plan's "verify no current-state prose still claims the class is unsplit" instruction rather than scope creep.
- Pre-completion reviewer: **PASS**.
  No findings; verified the dependency partition, doc updates, cross-step invariants (Step 4 `#528` harness, Step 5 `#529` `SubagentDetector` seam), Mermaid diagrams, and planned follow-up issues (`#531`, `#532`) all check out.

## Stage: Final Retrospective (2026-07-07T15:15:00Z)

### Session summary

Shipped Phase 8 Step 6 across three stages (plan → TDD → ship) with zero rework: the plan's dependency partition and 4-commit sequence held exactly as designed, the pre-completion reviewer returned PASS with no findings, and the release cut `pi-permission-system` 19.0.1.
The only friction was external and transient — a live GitHub Actions incident (Jul 7 2026, ~15:06 UTC: 500 errors on Actions runners / Codespaces REST APIs, "retries may be successful") degraded the CI runners during the ship window, causing three intermittent failures that each cleared on re-run before the push and the release-please PR could land.

### Observations

#### What went well

- Clean plan-to-execution fidelity: the planning-stage dependency partition (5-field `ApprovalEscalatorDeps` / 5-field `ForwardedRequestServerDeps`, shared `ForwarderContext` + `getSessionId`) landed verbatim, with no unplanned coupling and no deviations across the four TDD commits.
- The single planning-stage `ask_user` gate (dedicated `forwarder-context.ts` vs. folding into `forwarding-io.ts` vs. duplication) resolved the one genuine design fork up front, so the TDD stage never had to stop for a structural decision.
- Incremental verification during TDD: `pnpm run check` plus the affected test file ran after each of the four steps, not just at the end — the type-level break from narrowing `PermissionForwarderDeps` (Step 2) surfaced immediately rather than at end-of-cycle.

#### What caused friction (agent side)

- `other` (external platform incident) — CI failed three times on 5000ms `testTimeout` timeouts in `pi-session-tools` (`read-session.test.ts`, `read-session-file.test.ts`, `read-parent-session.test.ts` — a different test each run), a package untouched by `#530`.
  Root cause was a live GitHub Actions incident (500s on Actions runners, "retries may be successful") degrading runner I/O during the window: those tests run in ~150ms healthy but exceeded 5000ms under the degraded runner, a >30× slowdown that a `testTimeout` bump would not reliably survive.
  Impact: three re-run cycles (one on the `main` push, two on release-please PR #552) plus two `ask_user` operator round-trips before the release could land; no code rework.
- `missing-context` (self-corrected, user-caught) — during the retro I first attributed the failures to thin-margin flaky tests and drafted a `pi-session-tools` follow-up issue, reasoning from a `fetch_content` of githubstatus.com that returned a stale/cached view (the live Jul 7 Actions incident was absent, showing June 25 as latest).
  The operator supplied the live incident text, correcting the attribution.
  Impact: two extra retro round-trips and a nearly-misfiled follow-up issue; the retro's friction attribution was corrected before landing.
  Lesson: when a CI failure might be platform-related, treat "retries succeed" plus failures confined to I/O-heavy tests as a strong transient-infra signal, and verify against the status page's **active** incidents (or the status API) rather than a possibly-cached page fetch.

#### What caused friction (user side)

- The operator was pulled into three mechanical re-run confirmations during ship, then had to correct the retro's root-cause attribution — oversight and fact-correction rather than strategic judgment.
  Opportunity: none actionable — the trigger was a transient GitHub platform incident, outside this repo's control.

### Follow-ups

- **Correction (added post-commit, same day):** a fourth CI failure recurred hours later (Jul 7 ~19:21 UTC, `read-parent-session.test.ts`) with `githubstatus.com` reporting all systems operational — falsifying "transient GitHub incident" as the sole/durable explanation above.
  Re-diagnosed: every failure across all four runs is the **first `it()` block** in one of `read-session.test.ts` / `read-session-file.test.ts` / `read-parent-session.test.ts`, each of which does `await import("#src/index")` inside the test body.
  `#src/index.ts` transitively pulls in `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` / `@earendil-works/pi-tui`; Vitest isolates each test file's module registry, so the cold-import cost is paid on the first call per file and races the 5000ms default `testTimeout` under CI parallel-package contention.
  A fourth file, `list-session-files.test.ts`, rides the same edge (3.5–4.9s observed, never yet crossed).
  The Jul 7 15:06 UTC Actions incident (500s on runners) likely was real and made the first three failures *more* likely that day, but the underlying vulnerability is independent of it and reproduces on a clean platform.
  Filing a `pi-session-tools` issue to fix this is warranted after all: the dynamic per-test `import()` is unnecessary (Vitest hoists `vi.mock("node:fs", ...)` above all imports automatically, so a static top-level `import sessionTools from "#src/index"` would receive the mock and pay the cost once during collection instead of racing a per-test timer) — see the issue filed for the fix.
  Lesson for future incident-attribution: a single external corroborating signal (a status-page incident) can still leave a *coincidental* co-occurrence undiagnosed; the recurrence check (does it reproduce absent the external cause?) is what actually distinguishes platform-caused from test-caused flakiness, not the initial correlation alone.
  Filed as [#554](https://github.com/gotgenes/pi-packages/issues/554) with the full timing evidence and a candidate fix (replace the per-test dynamic `import("#src/index")` with a static top-level import — `vi.mock` hoisting makes the dynamic form unnecessary).
