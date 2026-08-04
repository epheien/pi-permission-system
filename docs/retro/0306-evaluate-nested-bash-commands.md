---
issue: 306
issue_title: "Evaluate commands inside command substitution and subshells against the permission rules"
---

# Retro: #306 — Evaluate nested bash commands (command substitution, process substitution, subshells)

## Stage: Planning (2026-06-02T00:33:17Z)

### Session summary

Planned #306 as a consumer of the #308 `BashCommand` model: extend `collectTopLevelCommandTexts` in `bash-program.ts` into a context-aware recursive enumerator that descends `command_substitution` (`$(…)`/backticks), `process_substitution` (`<(…)`/`>(…)`), and `subshell` (`( … )`), emitting each nested command as an additional `BashCommand` tagged with its execution `context`, in addition to the never-weaker whole emit.
Confirmed AST shapes with a throwaway `web-tree-sitter` probe and settled the one real design choice (the `context` field) with the owner before writing the plan.
Plan committed as a 3-step TDD sequence (enumeration descent → context tag + message surfacing → docs).

### Observations

- The owner chose to add the `context` field and surface it in the deny reason + ask prompt (`inside command substitution`), and to scope the tag to the **command-pattern** surface only — deferring per-command path/context provenance for the external-directory / bash-path surfaces to #307, which already introduces the per-command path model.
- `context` is added **with its consumers in a single commit** (step 2), not in step 1, because `pnpm fallow dead-code` flags a constructed-but-unread interface field (the exact trap the #308 retro called out for `context`/`name`/`argv`).
  Step 1 therefore keeps `BashCommand` one-field and lands the security fix (nested deny works as soon as the enumerator emits the inner units, since the handler already feeds `commands()` to the resolver).
- `context` is **optional and absent for top-level commands** (no `"top-level"` union member).
  This confines test churn: existing `commands()` and whole-`PermissionCheckResult` assertions stay green because `toEqual` treats an absent property as equal to `undefined`.
  Result-level `commandContext` is likewise only set for nested winners.
- The probe surfaced a non-obvious AST fact: when the **whole** command is a substitution (`$(a && b)` alone), `command_substitution` nests **under** `command_name`, not as a sibling argument — so the descent must search the entire `command` subtree, which `collectSubstitutionCommands` does.
- Robust delimiter skipping uses `node.isNamed` (a boolean property on `web-tree-sitter`'s node) rather than enumerating fragile anonymous token types (`$(`, `)`, `` ` ``, `(`, `<(`, …).
  This required adding `readonly isNamed: boolean` to the local `TSNode` interface.
- `BashCommandContext` is placed in `src/types.ts` (not the gate module) so `PermissionCheckResult` stays self-contained and the gate + presentation modules import it in the existing dependency direction.
- Design-review check on the shared-interface change: `PermissionCheckResult` gains one optional field read by two presentation modules and written by one resolver, riding the existing result-carries-context pattern (same as `command` / `matchedPattern`) — no new parameter threading, no LoD / output-argument smells.
- `configuration.md` documents the current limitation explicitly (nested contents "matched as part of their enclosing command rather than evaluated independently") — that prose and the "subshells … are not parsed" caveat are the required doc updates.
- Carried forward from #308: these are `feat:` commits (not `refactor:`), so #306 will appear in the changelog normally; no explicit-close caveat needed for release-please.

## Stage: Implementation — TDD (2026-06-02T00:54:01Z)

### Session summary

Implemented #306 across three TDD cycles (two `feat:` code commits + one `docs:` commit) exactly as planned: step 1 added the enumeration descent (the security fix), step 2 added the `context` field end-to-end with its message consumers in one commit, step 3 updated `configuration.md` + `architecture.md`.
Test count went 1704 → 1716 (+12: 8 enumeration tests in step 1, 4 context/message tests in step 2).
`pnpm run check`, `pnpm run lint`, `pnpm run test`, and `pnpm fallow dead-code` (repo root, 203 entry points) all green; no lockfile change.

### Observations

- No deviations from the plan — the file-by-file changes, the 3-step ordering, and the fallow-driven "field + consumer in one commit" split all held.
- The AST probe from planning paid off: `command_substitution` nesting **under** `command_name` (when the whole command is `$(…)`) is handled by `collectSubstitutionCommands` searching the full command subtree, and `node.isNamed` cleanly skips every delimiter/operator token without enumerating fragile anonymous type strings.
- Refined one planning detail during implementation: `NESTED_EXECUTION_CONTEXTS` became a `Map<string, BashCommandContext>` (node-type → context) instead of a `Set`, so `collectSubstitutionCommands` reads the context off the map rather than re-deriving it — decouples tree-sitter type strings from the union and avoids a cast.
- Step 2 threaded an optional `context` param through `collectCommandsInto` / `descendCommandChildren` and added a tiny `makeUnit(text, context)` helper so top-level units stay `{ text }` (no `context: undefined`), keeping the existing top-level `commands()` and whole-`PermissionCheckResult` assertions green under `toEqual`.
- One mechanical hiccup: an `Edit` to the `resolveBashCommandCheck` JSDoc failed because the `oldText` anchor started mid-line (`Matching the whole string…` is not a line start); re-anchored on the prior line and it applied.
  No rework.
- Pre-completion reviewer verdict: **PASS** (all deterministic checks green; code-design, docs forward/reverse, Mermaid, and dead-code all PASS; no acceptance-criteria list in the issue, so that check was SKIP).
  No warnings.

## Stage: Final Retrospective (2026-06-02T01:05:11Z)

### Session summary

Shipped #306 end-to-end in one continuous session (plan → TDD → ship → retro): three commits (two `feat:`, one `docs:`) plus stage docs, all green through CI, issue closed, and release-please PR #310 merged to cut `pi-permission-system-v9.1.0`.
The implementation matched the plan exactly — zero deviations, pre-completion **PASS** with no warnings — because two throwaway `web-tree-sitter` AST probes during planning de-risked every AST-dependent decision before any plan text was committed.

### Observations

#### What went well

- The disposable AST probes (`probe-ast.mjs`, `probe2.mjs`) run during planning were the decisive win: they surfaced the non-obvious `command_substitution`-under-`command_name` nesting and confirmed `node.isNamed` as a clean delimiter filter, so the TDD stage hit **zero** AST surprises across nine enumeration tests.
  This is the `testing` skill's "write a disposable exploratory script first to inspect the actual runtime shape" rule paying off concretely — the rule already exists and was followed.
- The fallow trap was anticipated, not discovered: planning split the work so the `context` field and its first reader land in the **same** commit (step 2), and I ran `pnpm fallow dead-code` from the repo root **before** committing step 2 rather than after — so the constructed-but-unread-field risk never materialized.
- `ask_user` was used for exactly the two genuine design decisions (whether the `context` field earns its keep; which surfaces carry it) and not for anything mechanical; both were answered cleanly and shaped the plan, and the second was preceded by a neutral surface-by-surface map per the `ask-user` "gather evidence first" handshake.
- Incremental verification was exemplary: targeted `vitest` per Red/Green sub-step, `pnpm run check` immediately after each interface change, and full `test` + `check` + `lint` + `fallow` after every step's commit — no end-of-session verification pile-up.

#### What caused friction (agent side)

- `other` (mechanical) — the batched `Edit` to `bash-command.ts` failed atomically on the first attempt because the `resolveBashCommandCheck` JSDoc anchor began mid-line (`Matching the whole string…`), which is not a unique line start.
  Impact: one re-read of the file and one retry; no rework, no wrong code.
  Self-identified immediately from the tool error.
- `other` (environment) — during shipping, `git log | grep -oP` failed because macOS BSD `grep` lacks `-P`; recovered in one retry with `grep -Eo`.
  Impact: one extra tool round-trip, no rework.

#### What caused friction (user side)

- None.
  The user ran all four workflow stages back-to-back with no mid-stage correction; involvement was mechanical oversight plus the two `ask_user` design decisions, not strategic redirection.
  Opportunity (not criticism): there was nothing to surface earlier — the two decisions genuinely needed the owner's judgment and were posed at the right moments.

### Diagnostic details

- **Model-performance correlation** — the only subagent dispatch in the whole session was the `pre-completion-reviewer` (44 tool uses, ~60k tokens) on judgment-heavy read-only code review; an appropriate match, no mismatch.
  Planning exploration was done directly (grep + `Read` + AST probes) rather than via an Explore subagent, which suited a focused single-package change.
- **Escalation-delay tracking** — no `rabbit-hole`: both friction points resolved in a single retry; no sequence exceeded five tool calls on the same error.
- **Unused-tool detection** — no gap.
  `colgrep` was loaded but unused; every search was exact-symbol (`commands()`, `resolveBashCommandCheck`, `matchedPattern`), so `grep` was the correct tool, and the AST probes covered the only genuinely unfamiliar data structure.
- **Feedback-loop gap analysis** — no gap; verification ran incrementally after each change, and the `fallow` gate ran from the repo root (203 entry points) before the at-risk commit rather than only at the end.

### Changes made

1. `packages/pi-permission-system/docs/retro/0306-evaluate-nested-bash-commands.md` — appended this Final Retrospective stage entry.
   No `AGENTS.md` or prompt changes: the owner confirmed the session had no friction justifying a process change.
   Candidates considered and rejected: an `Edit` line-anchor rule (one-off, no rework), a BSD-`grep -P` portability note (environment-specific), and a new "add an interface field with its first consumer" rule (already covered by the package skill's maintenance-trap guidance and the speculative-re-export rule).
