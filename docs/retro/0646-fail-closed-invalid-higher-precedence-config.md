---
issue: 646
issue_title: "pi-permission-system: invalid higher-precedence config inherits lower-scope allow rules"
---

# Retro: #646 — pi-permission-system: invalid higher-precedence config inherits lower-scope allow rules

## Stage: Planning (2025-06-12T00:00:00Z)

### Session summary

Planned the fix for the cross-scope fail-open: an invalid higher-precedence scope (project / agent / project-agent) becomes an empty scope, so `mergeScopesWithOrigins` inherits the lower scope's rules unchanged and a global `allow` survives a higher scope meant to `deny`/`ask` it.
The issue is third-party (author `marcoscale98`), so the `ask_user` gate confirmed direction and design: an always-on `allow`→`ask` flooring overlay, triggered by non-global scopes only, shipped as a breaking `fix!:`.
Wrote a 4-step TDD plan (`0646-...`) and committed it.

### Observations

- The `#547` strict-validation "fail-closed" is only correct for a **single** scope in isolation — an invalid scope's *missing* surfaces fall to universal `ask`, but a lower scope's **explicit** `allow` still wins.
  So #646 is a real, unfixed gap, and the `strict-config-validation.md` migration doc's "falls back to ask — never allow" line is misleading for the cross-scope case (flagged for a doc update).
- Clean symmetry hook: `rewriteAsksToYolo` (ask→allow, `origin: "yolo"`) is the exact mirror of the planned `floorAllowsToAsk` (allow→ask, `origin: "fail-closed"`).
  `deriveSource` keys on `rule.layer` + tool kind, not `origin`, so adding a `"fail-closed"` `RuleOrigin` does not ripple into source derivation — only `rule.ts` and the `architecture.md` inline `RuleOrigin` copy need touching.
- The invalid-scope signal is carried by a new optional `ScopeConfig.invalid` field; the loader is the single decision point.
  For agent scopes, `getFileStamp === "missing"` distinguishes an absent file (not invalid) from a present-but-unreadable one (invalid) — important so a missing agent file is not mis-clamped.
- Apply the overlay at **composition** (`resolvePermissions`), not at `check()`, so `getToolPermission` / `getComposedConfigRules` reflect the clamp; a floored `allow`→`ask` keeps the tool **visible** rather than silently allowed.
- yolo neutralizes the clamp (floored `ask` → `allow` at check time).
  This is intentional (yolo is an explicit full-permissive opt-in) and pinned with an invariant test rather than left implicit.
- Rejected the harder "refuse to activate / universal deny" option and the opt-out config knob per the operator's `ask_user` answers — proportionate `ask`, always-on.

## Stage: Implementation — TDD (2025-06-12T18:00:00Z)

### Session summary

Executed the 4-step plan across 6 commits (2 Tidy-First prep + 3 TDD + 1 docs); the full `pi-permission-system` suite went 2535 → 2555 tests (+20), all green, with `check`/`lint`/`fallow dead-code` clean.
The fix lands as designed: `floorAllowsToAsk` mirrors `rewriteAsksToYolo`, the loader marks a present-but-unloadable non-global scope `ScopeConfig.invalid`, and `resolvePermissions` floors `allow`→`ask` (origin `fail-closed`) when any non-global scope is invalid, with a strengthened `getConfigIssues` notice.
Pre-completion reviewer returned PASS.

### Observations

- The `tidy-first-assessor` recommended two test-only prep commits, both taken: hoisting the shared `Rule` fixtures out of the `rewriteAsksToYolo` `describe` in `test/rule.test.ts` (renamed to `overlay*` at module scope to sidestep a name collision with differently-shaped block-scoped consts elsewhere in the file), and widening the yolo test's `makeManager` to accept an optional `project` scope for the fail-closed-under-yolo invariant test.
  Both kept the `feat`/`fix!` test diffs to new assertions only.
- Simulating a present-but-unreadable agent file: `mkdirSync` a directory at the agent's `.md` path — `statSync` succeeds (stamp is not `"missing"`) but `readFileSync` throws `EISDIR`, deterministically exercising the invalid-scope catch branch without `chmod` flakiness.
- No deviations from the plan; every planned Module-Level Changes file was touched, no schema or lockfile changes, and `#646` is not a roadmap step so no `✅` mark was needed.
- Repo-wide `pnpm run test` shows 2 unrelated FAILs in `@gotgenes/pi-autoformat` (`test/acceptance.test.ts`, `test/acceptance-event-bus.test.ts`) — e2e tests that spawn a real `pi` CLI via RPC and time out at 30s; environmental, zero overlap with this change's files.
- Pre-completion reviewer: PASS (no WARN findings).
- The `#526` yolo deny-preservation and `#547` single-scope fail-closed invariants are both pinned by tests in this change (fail-closed-under-yolo cases; the untouched `#547` tests still pass).

## Stage: Final Retrospective (2026-07-24T16:52:42Z)

### Session summary

Reviewed the Ship and Retrospective stages together.
Ship landed the code cleanly (CI green, issue closed, release-please PR merged), but the release-please CI job failed on a transient GitHub API error *after* it had already tagged `pi-permission-system-v21.0.0` — GitHub's default `needs:`-skip-on-failure behavior silently dropped the downstream `publish` job, so the version was tagged/released on GitHub but never published to npm.
The user caught the discrepancy externally, and this session diagnosed the cascade, guided a manual `pnpm publish` recovery, and manually replicated the skipped `last-release-sha` write-back.

### Observations

#### What went well

- The third-party protocol held end-to-end across all three prior stages: authorship check (`gh api user` vs. issue `author.login`) correctly triggered the Planning-stage `ask_user` gate, and the plan's Goals/Design were driven by the operator's answers rather than transcribed from the issue body.
  Confirmed this explicitly when the user asked about it mid-retro, by reading the Planning stage notes rather than relying on memory.
- The CI-failure diagnosis was methodical rather than reactive: confirmed the GitHub API rate limit was healthy before concluding "transient hiccup" (not a rate-limit issue), inspected step-level (not just job-level) conclusions to isolate `release-please` as the failing step, and read the attempt-1 logs before choosing a non-destructive recovery (no force-push, no re-tagging, no speculative retries).
- The `last-release-sha` write-back gap was caught proactively as a second-order consequence of the same root cause — not left for a future session to rediscover when the baseline drifted further.

#### What caused friction (agent side)

- `missing-context` — told the user `npm login` was "the one legitimate exception to the pnpm-only rule" without first checking whether `pnpm` has its own native `login`/`whoami`/`publish` commands (it does; no exception is needed).
  Impact: incorrect guidance the user had to correct; would have propagated a wrong command into `AGENTS.md` if not caught here.
- `missing-context` (minor, self-corrected) — reflexively ran `npm view`/`npm whoami` before the repo's pnpm-only guard blocked it, then switched to `pnpm view`/`pnpm whoami` in the same turn.
  Impact: one wasted tool call, no rework.

#### What caused friction (user side)

- The Ship session's final report declared the release fully landed based on `release_watch` returning the tag, but a `release-please` job can fail *after* completing its main side effect (tagging), and `publish` silently skips as a result.
  `/ship-issue` had no step that would have caught this — the user had to notice externally and open a new message to report it.
  This is a genuine gap in the prompt's verification coverage, not a user-process gap: the flow verified "CI passed on the shipped commit" and "tag landed," but never "the push-triggered CI run following the release-please merge itself succeeded."

### Changes made

1. `AGENTS.md` — corrected the first-release manual-publish command (`pnpm login` + `pnpm publish`, dropped the incorrect `--otp <code>`) and added a new paragraph documenting the release-please-fails-after-tagging recovery procedure (manual publish + manual `last-release-sha` advance), referencing this issue.
2. `.pi/prompts/ship-issue.md` — added step `6b` ("Verify the release-triggered CI run"): captures the release merge commit SHA, runs `ci_find`/`ci_watch` on it, and stops before the Final report if `release-please` or `publish` failed or was unexpectedly skipped.
   Also added a matching bullet to the Constraints section.
