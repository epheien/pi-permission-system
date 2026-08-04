---
issue: 385
issue_title: "pkg:pi-permission-system — Respect pi default active tool set instead of activating all non-denied tools"
---

# Retro: #385 — Respect pi default active tool set instead of activating all non-denied tools

## Stage: Planning (2026-06-11T21:43:29Z)

### Session summary

Planned the fix for `AgentPrepHandler.handle()` activating pi's off-by-default tools (`find`/`grep`/`ls`) in every session.
The fix switches the base set from `pi.getAllTools()` to `pi.getActiveTools()`, making the permission system purely restrict-only.
Evaluated the issue author's reference PR [#386] and adopted its approach with two improvements: typing `getActive(): string[]` to match the real SDK contract (PR used `unknown[]`) and adding an explicit regression test.

### Observations

- Confirmed via the SDK `.d.ts` that `getActiveTools()` returns `string[]` while `getAllTools()` returns `ToolInfo[]`.
  PR #386's test mocks return objects for `getActive`, which pass only because `getToolNameFromValue` tolerates both shapes — a fidelity gap the plan fixes by returning bare strings everywhere.
- `PermissionGateHandler` keeps `getAll()` for `validateRequestedTool` (registration checks must see the full registry); only `AgentPrepHandler` switches to `getActive()`.
  This leaves a latent ISP seam (disjoint consumer slices of `ToolRegistry`) — recorded as track-and-watch, not split now.
- Classified as **breaking** (confirmed with the user via `ask_user`): the main session's effective tool set changes on upgrade without a user edit, so `fix!:` + `BREAKING CHANGE:` footer.
  The restrict-only contract means users wanting `find`/`grep`/`ls` active must enable them via pi's own `activeTools` config.
- Verified idempotence: starting from the active set makes the operation purely subtractive toward a fixed point, so no oscillation across repeated `before_agent_start` fires.
- Key risk flagged for TDD: confirm `getActiveTools()` is already populated with pi's defaults when `before_agent_start` fires (lifecycle timing).
  PR #386's existence suggests the reporter validated this empirically.
- Credit: Ben Tang (@0xbentang) reported #385 and authored reference PR [#386].
  The plan records a `Co-authored-by: Ben Tang <bentang@fastmail.com>` trailer for the implementation commits so the credit lands in git history.

## Stage: Implementation — TDD (2026-06-11T22:05:26Z)

### Session summary

Completed all three planned TDD cycles: (1) added `getActive(): string[]` to `ToolRegistry` and wired it to `pi.getActiveTools()` plus every fixture/fake; (2) added a regression test and switched `AgentPrepHandler.handle()` from `getAll()` to `getActive()` (the breaking `fix!:`); (3) clarified the restrict-only contract in `docs/configuration.md`.
Test count went from 1921 to 1922 (+1 regression test); `check`, `lint`, and `fallow dead-code` all green.

### Observations

- Plan deviation (benign): the plan's Module-Level Changes listed `test/handlers/external-directory-session-dedup.test.ts` and `test/handlers/tool-call.test.ts` as needing `getActive` edits, but both consume the shared `makeToolRegistry` factory, which now supplies a default `getActive`.
  Neither file needed touching — TypeScript passing at both call sites confirms the interface is satisfied.
  This is a small simplification over reference PR [#386], which added redundant `getActive` stubs to those files.
- The regression test (`does not activate registered tools pi left inactive (find/grep/ls)`) sets `getActive` to the default four and `getAll` to a seven-tool superset, asserting `setActive` is called with exactly the four.
  It failed cleanly on the old `getAll()` handler (called with all seven) and passed after the switch — the canonical guard for #385.
- Pre-completion reviewer: PASS.
  One non-blocking WARN: the `allTools` variable in `before-agent-start.ts` now holds pi's active subset, so the name misled.
  Renamed it to `activeTools` and folded the rename into the `fix!:` commit (via `git reset --soft` + `--amend`, unpushed) rather than a follow-up.
- The `fix!:` and `feat:` commits both carry the `Co-authored-by: Ben Tang <bentang@fastmail.com>` trailer (verified it survived the amend).

## Stage: Final Retrospective (2026-06-11T22:39:40Z)

### Session summary

Shipped #385 across planning, TDD, and ship stages: `pi-permission-system` v11.0.0 released with the restrict-only `before_agent_start` fix.
The dominant lesson is a `missing-context` failure — I asserted a non-existent "pi `activeTools` config" as the breaking-change remediation, which the user had to correct with a follow-up commit (`58db6f81`); the wrong guidance still ships in the v11.0.0 CHANGELOG and the issue close comment.

### Observations

#### What went well

- Reference-PR evaluation: reading PR [#386] alongside the issue, then adopting its approach but improving on it (typing `getActive(): string[]` instead of the PR's `unknown[]`, adding the missing regression test) and crediting the author via `Co-authored-by:` trailers.
  A clean "accept-and-improve" flow rather than rubber-stamping or rewriting.
- The regression test design (`getActive` returns the four defaults, `getAll` returns a seven-tool superset, assert `setActive` called with exactly the four) was a precise guard: red on the old `getAll()` handler, green after the switch.
- Incremental verification cadence: per-file `vitest` after each red/green, `pnpm run check` before the interface-touching commits, full suite + `lint` + `fallow dead-code` at the end.

#### What caused friction (agent side)

- `missing-context` (high impact, user-caught) — Asserted "pi's own `activeTools` configuration" as the way users re-enable `find`/`grep`/`ls`, without verifying pi's actual tool-activation surface.
  The real mechanism is the `--tools` / `-t` CLI flag (or `createAgentSession({ tools: [...] })`); there is no persistent config-file key.
  The error propagated to the plan, the `fix!:` `BREAKING CHANGE:` footer, and the issue close comment.
  Impact: the user pushed a correction commit (`58db6f81`) to the plan; the wrong guidance still ships in the v11.0.0 `CHANGELOG.md` (release-please-owned, generated from the commit footer — not editable) and the GitHub issue #385 close comment.
- `other` (low-medium, self-identified) — Commit-split surgery during the crediting sub-task: `git reset --soft HEAD~2` left both the plan and retro changes staged, so the first recommit swallowed both files; a second attempt split the retro across both commits; a third (`git reset --soft HEAD~2` then mixed `git reset`) finally separated them.
  Impact: ~2 redo cycles, no shipped defect.
- `other` (low, self-identified) — An `Edit` batch on `session-start.test.ts` was rejected because the two fake `ExtensionAPI` blocks are identical and my first `oldText` pair was not uniquely anchored; re-anchored on the enclosing `test(...)` names.
  Impact: one retry.

#### What caused friction (user side)

- The credit request ("I'd like to give credit to 0xbentang, too") arrived after the plan was already committed, which forced the retroactive commit-split surgery above.
  Opportunity (not criticism): surfacing co-authorship intent during planning would have folded the trailers into the normal commit flow.
- The `activeTools` → `--tools` correction was delivered as a direct commit between sessions rather than as a redirect.
  A one-line "verify how pi activates tools" nudge during planning would have caught the error before it reached the immutable CHANGELOG.

### Diagnostic details

- **Unused-tool detection** — for the `missing-context` finding, `code_search` and `web_search` were available and never used.
  A single `code_search "pi coding agent tool activation --tools CLI flag"` would have surfaced the real mechanism before the wrong guidance shipped.
  I used the SDK `.d.ts` to confirm `getActiveTools(): string[]` but never checked the user-facing activation path.
- **Model-performance correlation** — one subagent dispatched (`pre-completion-reviewer`, default model): judgment-heavy review work, 42 tool uses, returned PASS plus a real naming WARN (`allTools` → `activeTools`).
  Appropriate model-to-task fit; no mismatch.
- **Feedback-loop gap analysis** — no gap; verification ran incrementally per TDD step, not only at the end.
- **Escalation-delay tracking** — no single-error sequence exceeded five consecutive tool calls; the commit-split retries were distinct strategies, not one repeated error.

### Changes made

1. `AGENTS.md` (Commits section) — added a rule to verify a breaking-change migration mechanism (CLI flag, config key, API call) against the real surface before asserting it, noting the note ships to the uneditable CHANGELOG and the close comment.
2. `AGENTS.md` (git guidance) — appended a one-line note that `git reset --soft HEAD~N` stages all N commits together, so re-splitting needs a mixed `git reset` first.
3. GitHub issue #385 close comment — corrected the `activeTools` config reference to the `--tools` / `-t` CLI flag (and `createAgentSession({ tools })`), with an inline correction note.
4. Known erratum (not fixed): the v11.0.0 `CHANGELOG.md` `BREAKING CHANGE` entry still says "activeTools configuration" — it is generated from the `fix!:` commit footer and owned by release-please, so it was left as-is rather than hand-edited.
5. Closed reference PR [#386] (superseded by the shipped commits) with a comment crediting @0xbentang and noting the two improvements folded in; the `Co-authored-by:` trailers preserve the credit in history.

[#386]: https://github.com/gotgenes/pi-packages/pull/386
