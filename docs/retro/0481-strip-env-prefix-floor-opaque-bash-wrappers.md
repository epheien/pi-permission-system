---
issue: 481
issue_title: "pi-permission-system: env-var prefix and bash -c/eval bypass bash command-pattern rules"
---

# Retro: #481 — pi-permission-system: env-var prefix and bash -c/eval bypass bash command-pattern rules

## Stage: Planning (2026-06-26T00:00:00Z)

### Session summary

Produced a numbered TDD plan for two bash command-pattern bypasses reported by a third-party author (`0xbentang`): a leading `variable_assignment` env-var prefix defeating rule matching, and opaque `-c`/`eval` payloads riding a permissive `allow`.
Confirmed direction and scope with the operator via `ask_user` (the issue is third-party, so the direction gate was required).
Filed follow-up [#490] for other indirection wrappers and committed the plan at `packages/pi-permission-system/docs/plans/0481-strip-env-prefix-floor-opaque-bash-wrappers.md`.

### Observations

- Both bypasses are fixed in this plan, but via two different mechanisms decided with the operator:
  - Part 1 strips the env-var prefix from the emitted command unit (re-targets matching at the real command).
  - Part 2 floors opaque shell wrappers (`bash`/`sh`/`dash`/`zsh`/`ksh -c`, plus `eval`) to at least `ask` rather than re-parsing the payload.
- The operator explicitly preferred the floor-to-`ask` approach over the issue's "ideally re-parse `-c`/`eval`" suggestion — it is fail-safe, far simpler, and avoids the path-candidate asymmetry that re-parsing would leave (inner paths would still miss the `path`/`external_directory` surfaces).
- Floor semantics: `allow` clamps up to `ask` with an `<opaque-bash-wrapper>` sentinel; an explicit `deny` rule still wins.
  Mirrors the existing `<unparseable-bash-command>` sentinel ([#452]).
- Classified `fix:` not `fix!:` — it only tightens decisions (closes a bypass), never weakens one; the old behavior was the bug, so there is no intended behavior to preserve.
- Wrapper set scoped to inline shells + `eval`; other indirection wrappers (`sudo`, `env VAR=x cmd`, `xargs`, `find -exec`, `time`, `nohup`, `timeout`, `nice`) deferred to [#490].
- Implementation note for the next stage: Part 1 needs `startIndex` added to the minimal `TSNode` interface (`parser.ts`) to slice verbatim text; this makes it a required field, so the `makeNode` literal builder in `test/access-intent/bash/node-text.test.ts` must set `startIndex: 0` in the same commit (typecheck coupling).
- The metamorphic totality test (`bash-command-metamorphic.test.ts`) wraps with a `cd` prefix, not `bash -c`, so the opaque floor does not disturb it.
- `#481` is not in the architecture roadmap (Phase 6 is complete) → ship independently.

## Stage: Implementation — TDD (2026-06-26T22:30:00Z)

### Session summary

Implemented all three planned TDD steps across two `fix:` commits and supporting docs: stripping the leading `variable_assignment` prefix from each bash command unit, and flooring opaque `-c`/`eval` wrappers (`bash`/`sh`/`dash`/`zsh`/`ksh -c` + `eval`) from `allow` to `ask` with a `<opaque-bash-wrapper>` sentinel.
Test count went from 2124 → 2145 (+21) in `pi-permission-system`; full suite, `pnpm run check`, root lint, and `pnpm fallow dead-code` all green.
Pre-completion reviewer returned PASS.

### Observations

- Established the green baseline by fixing two pre-existing lint failures first (a separate `docs:` commit): the `0481` plan wrapped its `[#NNN]` reference links in backticks (MD053 unused-definition), and the archived `phase-6` history doc pointed at a `#directory-organization-forward-looking` anchor that was consolidated into `## Module structure` (MD051).
- Step 1 coupling held as the plan predicted: adding the required `startIndex` field to `TSNode` forced the `makeNode` literal builder in `node-text.test.ts` to set `startIndex: 0` in the same commit.
- The opaque detector (`isOpaqueWrapperCommand`) matches the `command_name` basename against a shell set (`bash`/`sh`/`dash`/`zsh`/`ksh`) plus `eval`, and recognizes `-c` inside a short-flag cluster (`-c`/`-ec`/`-xc`); `grep -c` is unaffected because `grep` is not a shell.
  The detector skips the same leading `variable_assignment` prefix as `commandUnitText`, so an env-prefixed `AWS_PROFILE=x bash -c "…"` is both stripped and flagged.
- The `eslint` pre-commit hook auto-fixed one optional-chain in step 2 (`!child || !child.isNamed` → `!child?.isNamed`); `biome` separately flagged a second optional-chain in `commandUnitText` that eslint left, landed as a `style:` commit.
- Minor plan deviation: the plan listed a `program.ts` `commands()` JSDoc update; I initially updated only the `collectCommands` JSDoc, then added the `commands()` JSDoc in a follow-up `docs:` commit.
- Pre-completion reviewer: PASS.
  Reviewer warnings (addressed in a follow-up `docs:` commit, not deferred): the README "Fails closed" bullet and the `package-pi-permission-system` skill Debugging section named only `<unparseable-bash-command>` and now also mention the sibling `<opaque-bash-wrapper>` sentinel.

## Stage: Final Retrospective (2026-06-27T03:00:00Z)

### Session summary

Shipped #481 end-to-end across planning, TDD, and ship stages: two `fix:` commits closing the env-var-prefix and opaque-wrapper bash-gate bypasses, released as `pi-permission-system-v16.2.1`.
The pipeline ran cleanly — third-party direction gate honored in planning, pre-completion reviewer PASS, CI green, release-please PR merged by rebase.
The only rework was a baseline-cleanup commit at the start of TDD to fix markdown-lint failures the planning stage introduced into its own plan file.

### Observations

#### What went well

- The two-`ask_user` planning gate for a third-party issue worked as intended: the first call settled scope + commit classification, and when the operator answered a scoping question with a counter-question ("don't we punt opaque payloads to ask?"), a second `ask_user` converged on the floor-to-`ask` design and wrapper set before any code was planned.
  This avoided building the heavier re-parse approach the issue author suggested.
- Incremental verification held throughout TDD: `pnpm run check` ran immediately after the step-1 `TSNode` interface change (a shared-type edit), the full suite ran after every step, and `pnpm run lint` + `pnpm fallow dead-code` ran before the ship push — no end-of-session surprise.
- The ship prompt's step-6.4 guidance paid off: release PR #491 had a CI `check` still `IN_PROGRESS`, and the flow correctly waited for it to finish rather than falling back to `gh pr merge` while a check was running, then merged by rebase.

#### What caused friction (agent side)

- `instruction-violation` (self-identified) — the planning stage wrote issue cross-references as backticked `` `[#452]` `` / `` `[#306]` `` / `` `[#393]` `` in the plan body, which renders them as code spans, not link references; the `[#N]:` definitions at the file foot then had no matching reference and tripped MD053.
  This surfaced at the TDD green-baseline lint check and forced a separate `docs:` cleanup commit (5915260d) before TDD could start.
  Impact: one extra commit and a baseline detour; no wrong code.
  The `markdown-conventions` skill already states "every `[#N]:` definition must have a matching `[#N]` reference," but does not warn that backticks disqualify the reference — the exact failure mode here.
- `scope-drift` (minor) — the plan listed a `program.ts` `commands()` JSDoc update that the first TDD pass missed (only the `collectCommands` JSDoc was updated); caught during the Module-Level-Changes cross-check and fixed in a follow-up `docs:` commit (18920980).
  Impact: one extra small commit; no rework.
- `other` (tooling) — the `eslint` pre-commit hook auto-fixed one optional-chain in step 2, but `biome` independently flagged a second optional-chain in `commandUnitText` that only surfaced at the end-of-step root lint, landing as a separate `style:` commit (8cef1c88).
  Impact: one extra commit; the two linters do not agree on which optional-chains they auto-fix at commit time.

#### What caused friction (user side)

- None.
  The operator's counter-question during planning was a net positive — it redirected toward the simpler, fail-safe design before code was written, exactly the kind of early strategic intervention the workflow wants.

### Diagnostic details

- **Model-performance correlation** — the single subagent dispatch (`pre-completion-reviewer`) ran on `anthropic/claude-sonnet-4-6`, appropriate for the judgment-heavy review (acceptance criteria, design, cross-step invariants); no mismatch.
- **Escalation-delay tracking** — no `rabbit-hole` friction; no error or approach occupied more than two consecutive tool calls.
- **Unused-tool detection** — none warranted; exact-symbol exploration (`grep`/`Read`) was the right fit for tracing `collectCommandsInto` / `makeUnit` / `variable_assignment`, and the one judgment task was correctly delegated to the reviewer subagent.
- **Feedback-loop gap analysis** — no gap; verification was incremental (typecheck after the interface change, full suite per step, lint + fallow before push) rather than end-loaded.

### Changes made

1. `.pi/skills/markdown-conventions/SKILL.md` — added a rule to the "Issue references" subsection: a `[#N]` wrapped in backticks is a code span, not a link reference, so the `[#N]:` definition still trips MD053; write `[#N]` as plain text, including inside other formatting.

[#452]: https://github.com/gotgenes/pi-packages/issues/452
[#490]: https://github.com/gotgenes/pi-packages/issues/490
