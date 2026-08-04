---
issue: 521
issue_title: "Is it possible to setup allow for all read-only commands?"
---

# Retro: #521 — Is it possible to setup allow for all read-only commands?

## Stage: Planning (2026-07-12T00:00:00Z)

### Session summary

Planned Phase 10, Step 6 of the pi-permission-system roadmap: a documentation-only recipe adding a "Read-Only Bash Command Allowlist" to `docs/configuration.md`.
The issue is third-party (`johnsyin-nextbe`), so the `ask-user` gate ran; it confirmed an in-doc recipe only (no shippable example config) with a conservative curated allowlist.
The plan is a single-commit build (`/build-plan`), landing the recipe and the roadmap `✅` marker together.

### Observations

- The issue's second question — allow `find *` while `-exec` and chains still `ask` — is **already fully implemented**: `find`/`fd` with an exec flag is floored `allow` → `ask` (indirection-wrapper floor, [#490]), and chains decompose to most-restrictive.
  The recipe documents this rather than building it.
- The owner had already scoped the direction in `docs/architecture/architecture.md` (Phase 10, Step 6, `Release: independent`, `Cause: none (documentation)`), so the third-party `ask-user` gate served to resolve genuine scope ambiguity (artifacts + breadth) rather than whether to build.
- `ask-user` initially returned "broad with caveats" for breadth; the operator immediately corrected to **conservative**.
  Final: in-doc recipe only, conservative allowlist.
- Key safety insight for the recipe: a curated read-only bash allowlist is safe *because of* four existing nets — the exec-flag floor ([#490]), the wrapper floor ([#481]), chain most-restrictive decomposition, and redirect targets being gated by the `path` surface (not `bash`).
  The one real hole to warn about is the redirect (`cat x > y` writes `y`), mitigated by shipping the recipe with `write`/`edit` denied and a `path` deny block.
- `git *` is deliberately never used — only specific read subcommands (`git status`, `git diff *`, `git log *`, etc.), since `git` has mutating subcommands.
  Exact patterns keep `git branch -D` falling through to `ask`.
- `echo`/`printf`/`tee`/`sort`/`sed`/`awk` excluded from the conservative set (redirect payloads, `-o`/`-i` in-place writes).
- Release: ship independently — unhidden `docs:` change, cuts its own release.

### Diagnostic details

- **Model-performance correlation** — planning ran entirely in the main session; no subagents dispatched (docs-only, small surface).
- **Feedback-loop gap analysis** — an early `Read` on `config.example.json` / `configuration.md` failed on a wrong absolute path (missing the `pi-packages/` segment); corrected on the next call.
  Minor, no rework.

## Stage: Implementation — Build (2026-07-12T00:00:00Z)

### Session summary

Executed the single-step build plan: added the "Read-Only Bash Command Allowlist" recipe to `packages/pi-permission-system/docs/configuration.md` (conservative curated allowlist + four safety-net cross-references) and marked roadmap Phase 10, Step 6 complete in `docs/architecture/architecture.md` (heading `✅`, Mermaid node `✅`, `Landed:` line).
Landed in one `docs:` commit (`6e9710fb`).
No `src/`/`test/` changes.

### Observations

- Verified the recipe's JSONC config block parses (comments stripped), the Step 6 Mermaid node renders via `mmdc`, and `rumdl` + package lint are clean.
- Followed the plan exactly; no deviations to the recipe content or the excluded-command set (`echo`/`printf`/`tee`/`sort`/`sed`/`awk` omitted as planned).
- Cross-reference anchors used: `#read-only-mode` (the sibling tool-level recipe) and `#fail-closed-behavior` (the wrapper/exec floor section) — both confirmed present.
- **Pre-completion reviewer: WARN** (1 non-blocking finding).
  All deterministic checks passed (`check`, `lint`, `test`, `fallow dead-code`).
- **Reviewer warnings:** Step 6 is the last of Phase 10's six steps, so Phase 10 is now fully `✅` but the doc lacks phase-level completion — missing `(complete)` suffix on the phase heading, stale "nine completed phases" count (should be ten), no `history/phase-10-*.md`, no phase-table row.
  This condensation is a materially larger, deliberate phase-close operation (mirrors Phases 7–9) and was intentionally out of the Step 6 recipe scope.
  Filed as tracked follow-up [#577] to avoid the untracked-deferral (`#479`/`#480`) failure mode.

## Stage: Final Retrospective (2026-07-13T01:51:49Z)

### Session summary

Shipped issue #521 across three clean stages (plan, build, ship): the read-only bash allowlist recipe landed in `docs/configuration.md`, pi-permission-system released as `v20.4.2`, and the issue closed with a close comment answering both of the reporter's questions.
The ship session navigated the nuanced release-please `UNSTABLE`-with-running-check merge path correctly, and the pre-completion review's one WARN (Phase 10 phase-close staleness) was already tracked as [#577] before ship.

### Observations

#### What went well

- **Correct handling of the `UNSTABLE` release PR with an in-progress check.**
  `release_pr_merge` first refused (`merge_state: UNSTABLE`); the `statusCheckRollup` showed a non-empty rollup with `check` still `IN_PROGRESS` (not the empty-rollup `GITHUB_TOKEN` case), so the session polled the rollup to `COMPLETED`/`SUCCESS` and retried `release_pr_merge` rather than falling back to `gh pr merge` mid-check.
  This is exactly the branch `/ship-issue` step 6.4 warns about, exercised end-to-end without a misstep.
- **Deterministic release decision up front.**
  The `**Release:** ship independently` marker was read from the plan before any push, and the stacked-release check correctly reasoned that `docs/configuration.md` is *not* in `exclude-paths` (unlike `docs/architecture`, `docs/plans`, `docs/retro`), so the `docs:` commit cuts a release — confirmed against the actual `release-please-config.json`, not from memory.
- **Cross-session continuity via the retro breadcrumbs.**
  The planning and build stage notes carried the third-party framing, the four-safety-net rationale, and the [#577] follow-up forward, so the ship close comment and this retro needed no re-derivation.

#### What caused friction (agent side)

- `other` — phantom SHA-length concern: after `git rev-parse HEAD` returned `6df37113…cab2`, the session claimed the hash "appears to have 41" characters and ran a `wc -c` check to confirm it was 40.
  Impact: one extra verification tool call, no rework — mildly aligned with the ship prompt's "paste the SHA exactly" caution, but triggered by a miscount rather than a real risk.
- `missing-context` (user-caught) — completing issue #521 completed the *last* step of Phase 10, which triggers the repo's phase-close (condense the phase into `history/phase-10-*.md`, add the `(complete)` suffix, a phase-table row, bump the "nine completed phases" intro count).
  That close has a dedicated manual command, `/finish-phase <PKG>` (`.pi/prompts/finish-phase.md`), which is hard-gated on every step issue being closed and does the archive + reconcile in one pass.
  At build time the pre-completion reviewer flagged the staleness and recommended *filing a follow-up issue*, and the build session did — [#577].
  That was the wrong mechanism: the phase-close is not tracked as a GitHub issue, it is a manual `/finish-phase` run the agent should **recommend** at the end of `/ship-issue` and `/retro`.
  The operator caught this during the retro.
  Impact: one spurious tracking issue ([#577], closed not-planned during this retro); no code rework.
  Root cause: neither `/ship-issue`, `/retro` step 10, nor the package skill points at `/finish-phase` when a ship completes a phase's last step, so the reviewer's generic "file a follow-up" suggestion filled the vacuum.

### Diagnostic details

- **Model-performance correlation** — the ship session ran entirely in the main session; the only subagent across all stages was the build stage's `pre-completion-reviewer`, appropriately dispatched for fresh-context judgment work.
- **Escalation-delay tracking** — no `rabbit-hole` points; the longest same-target sequence was the release-PR rollup poll loop (a bounded, intentional wait, not a stuck retry).
- **Feedback-loop gap analysis** — pre-push `lint` and `fallow dead-code` ran from the repo root before the push, and CI was watched to `success` before closing the issue; verification was correctly ordered, not deferred.

### Changes made

1. Closed [#577] as not-planned (the phase-close is a manual `/finish-phase` run, not a tracked issue) with a comment pointing at `/finish-phase pi-permission-system` as the correct next action.
2. `.pi/prompts/retro.md` step 10 — when the shipped issue completed the phase's **last** step, recommend `/finish-phase <PKG>` (then `/plan-improvements <PKG>`) instead of a successor `/plan-issue`, and stated the phase-close is never a filed issue.
3. `.pi/prompts/ship-issue.md` step 7 (final report) — added a bullet to flag phase completion and point at `/finish-phase <PKG>` (run after `/retro`), keeping `/retro` as the single next step.
4. Corrected this retro's friction entry to record that filing [#577] was the mis-step and `/finish-phase` is the established phase-close mechanism.
