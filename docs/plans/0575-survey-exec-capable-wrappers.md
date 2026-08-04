---
issue: 575
issue_title: "pi-permission-system: survey other exec-capable CLI rewrites for indirection-wrapper flooring"
---

# Survey exec-capable CLI rewrites for indirection-wrapper flooring

## Release Recommendation

**Release:** ship independently

Phase 11 Step 6 carries `Release: independent` in `docs/architecture/architecture.md` — it is not a member of the "shell-tool-aliases" batch (Steps 2–3) and cuts its own release as a `fix:` bash-surface hardening, exactly as its predecessor [#490] did.

## Problem Statement

[#490] floored a fixed inventory of indirection wrappers (`sudo`/`env`/`xargs`/`time`/`nohup`/`timeout`/`nice`, plus `find`/`fd` carrying a per-result exec flag) to at least `ask`, so an inner command cannot ride a permissive `allow` on the wrapper text.
That inventory was seeded from a fixed list; any exec-capable tool outside it can still launder a payload under a permissive `allow` — the fail-safe floor is only as good as its inventory ([#575]).
This issue surveys other modern core-tool rewrites and parallelizers that run an inner command per input or as a subcommand, and extends the wrapper sets with the exec-capable ones.

## Goals

- Survey the candidate tools and classify each as exec-capable (floor) or not (reject), recording the decision in the plan.
- Extend `INDIRECTION_WRAPPER_NAMES` (`src/access-intent/bash/command-enumeration.ts`) with the adopted always-invoke wrappers: `parallel`, `rust-parallel`, `rush`, `doas`, `setsid`, `stdbuf`, `watch`, `flock`.
- Add classifier tests pinning each new wrapper's `wrapperKind: "indirection"` flag.
- Keep the enumerated inventory in `docs/configuration.md` and the package skill in sync with the new set.
- Mark Phase 11 Step 6 complete in `docs/architecture/architecture.md` in the same doc-update commit.

This is a behavior-tightening `fix:` — a command like `parallel rm ::: *` that previously matched a permissive `allow` now prompts (`ask`).
As with [#490], the floor only ever makes a decision **more** restrictive (`allow` → `ask`) and never overrides an explicit `deny`, so it is not classified breaking (matching the [#490] `fix:` precedent).

## Non-Goals

- Re-targeting matching at the inner command (stripping the wrapper prefix).
  [#490] settled on floor-all after an AST probe showed every wrapper parses as a flat `command` node with no wrapper/inner-command boundary; that decision stands.
- Adopting `gargs` (a Go xargs alternative, `brentp/gargs`).
  It is exec-capable but declined this round (niche; low prevalence).
  It can be added later as a one-line set edit if it becomes relevant.
- Adding any exec-flag-conditional wrapper to `EXEC_CONDITIONAL_WRAPPERS`.
  None of the adopted tools is flag-gated the way `find`/`fd` are — each always invokes its inner command as its primary purpose — so all adopted entries go into `INDIRECTION_WRAPPER_NAMES`.
- Changing the floor mechanism, the `<indirection-bash-wrapper>` sentinel, or the advisory path — all reused unchanged from [#490].

## Background

The relevant code all lives in `src/access-intent/bash/command-enumeration.ts`:

- `INDIRECTION_WRAPPER_NAMES: Set<string>` — always-invoke wrappers floored by command-name basename alone.
- `EXEC_CONDITIONAL_WRAPPERS: Map<string, ReadonlySet<string>>` — search tools (`find`/`fd`) floored only when an exec flag is present.
- `classifyWrapperCommand(node)` — reads a `command` node's basename + args, returns `"indirection"` for a member of `INDIRECTION_WRAPPER_NAMES`, or for a `EXEC_CONDITIONAL_WRAPPERS` tool carrying a matching exec flag.
- The `BashCommand.wrapperKind` discriminant flows to `WRAPPER_SENTINEL` in `src/handlers/gates/bash-command.ts`, where `resolveBashCommandCheck` floors an `allow` up to `ask` and stamps the `<indirection-bash-wrapper>` review-log pattern.

Per the [#490] retro, the floor half needs no code change once the classifier emits `"indirection"` — the `WRAPPER_SENTINEL` map already has the `indirection` key, and the advisory surface (`resolveBashAdvisoryCheck`) reuses the shared `resolveBashCommandCheck`, so the floor applies to both the gate and the advisory answer for free.
The entire change is therefore: add 8 strings to one `Set`, plus tests and docs.

Constraint from the package skill (Debugging section): `INDIRECTION_WRAPPER_NAMES` and `EXEC_CONDITIONAL_WRAPPERS` are documented, easily-extensible constants — this issue exercises exactly that extension point.
Constraint from the package skill (roadmap-marking rule): mark the completed roadmap step `✅` on both the heading and its Mermaid node in the implementation doc-update commit, not a deferred ship commit.

## Design Overview

### Survey results

Each candidate was checked against the criterion "does it run an inner command per input or as a subcommand?"

Adopt into `INDIRECTION_WRAPPER_NAMES` (always-invoke; floored by basename):

| Tool            | Why it execs                                                               |
| --------------- | -------------------------------------------------------------------------- |
| `parallel`      | GNU parallel: runs a command per input line (like `xargs`).                |
| `rust-parallel` | Rust `parallel`/`xargs` rewrite; runs commands from stdin/args/`:::`.      |
| `rush`          | `shenwei356/rush`: Go parallel command runner (like GNU parallel/`gargs`). |
| `doas`          | OpenBSD `sudo` rewrite; runs a mandatory command as another user.          |
| `setsid`        | Runs a following command in a new session.                                 |
| `stdbuf`        | Runs a following `COMMAND` with modified stream buffering.                 |
| `watch`         | Executes a command periodically.                                           |
| `flock`         | `flock <file> <cmd>` wraps a lock around command execution.                |

Reject (not exec-capable — no per-result or subcommand exec):

| Tool      | Why rejected                                                                            |
| --------- | --------------------------------------------------------------------------------------- |
| `sad`     | Batch file search-and-replace (a `sed` alternative); edits files, execs nothing.        |
| `fselect` | SQL-like file search; its interactive "queries" are internal, no per-result subcommand. |
| `runiq`   | Line dedupe filter; execs nothing.                                                      |
| `gargs`   | Exec-capable, but declined this round (see Non-Goals).                                  |

Notes on the adopted set:

- All parse as flat `command` nodes with the inner command visible as arguments, identical to the existing `env`/`nice`/`timeout` entries — so basename flooring is correct and no per-wrapper option-arity table is needed.
- `rust-parallel` contains a hyphen; `basename("rust-parallel")` returns the whole string and matches the set entry exactly (`basename` only splits on `/`).
- `flock` has a bare-fd form (`flock <number>`) that runs no command; basename flooring over-floors that rare shell-script form to `ask`.
  This is the accepted least-privilege posture, consistent with [#490]'s accepted edge that a bare `env`/`sudo -l` is floored too.
- `parallel`/`rust-parallel`/`rush` take options and templates but always invoke a command; there is no bare read-only mode to preserve (unlike `find`/`fd`), so they are always-invoke, not exec-conditional.

### Code change

A single edit to the set literal:

```typescript
const INDIRECTION_WRAPPER_NAMES = new Set([
  "sudo",
  "env",
  "xargs",
  "time",
  "nohup",
  "timeout",
  "nice",
  // Added #575 — exec-capable rewrites and prefix wrappers
  "parallel",
  "rust-parallel",
  "rush",
  "doas",
  "setsid",
  "stdbuf",
  "watch",
  "flock",
]);
```

No other production code changes.
`classifyWrapperCommand`, `WRAPPER_SENTINEL`, `resolveBashCommandCheck`, and the advisory path are unchanged.

## Module-Level Changes

Production code:

- `src/access-intent/bash/command-enumeration.ts` — add the 8 strings to `INDIRECTION_WRAPPER_NAMES` (with a `#575` comment marker).

Tests:

- `test/access-intent/bash/program.test.ts` — extend the `describe("indirection wrappers")` `it.each` table with one row per new wrapper (each asserting `wrapperKind: "indirection"`), following the existing `sudo aws s3 ls` pattern.

Docs (same commit, doc-update step):

- `docs/configuration.md` (line ~329) — the hard-enumerated indirection-wrapper list (`sudo`, `env`, `xargs`, `time`, `nohup`, `timeout`, `nice`, …) gains the 8 new names.
  This is the authoritative user-facing list; it must stay complete.
- `.pi/skills/package-pi-permission-system/SKILL.md` (Debugging section, `INDIRECTION_WRAPPER_NAMES = sudo/env/xargs/time/nohup/timeout/nice`) — extend the enumeration to match the code.
- `docs/architecture/architecture.md` — mark Phase 11 Step 6 `✅` on both the `#### Step 6:` heading and the `S6` Mermaid node; update the Step 6 **Outcome** to record the adopted inventory (`parallel`/`rust-parallel`/`rush`/`doas`/`setsid`/`stdbuf`/`watch`/`flock`) and the rejected candidates (`sad`/`fselect`/`runiq` non-exec; `gargs` declined).

Docs deliberately **not** edited (already correct):

- `README.md` line 22, `src/handlers/gates/bash-command.ts:29`, `src/access-intent/bash/program.ts:100`, and `docs/architecture/architecture.md` lines 756/761 all reference the inventory with a trailing `…` ellipsis or a single example (`such as sudo`), so they remain accurate without enumerating the new names.
- Historical records (`docs/plans/0490-*`, `docs/plans/0481-*`, `docs/plans/0521-*`, the `docs/retro/*`, and `docs/architecture/history/phase-10-*`) are frozen and are not edited.

## Test Impact Analysis

1. **New tests enabled:** eight new classifier rows in `program.test.ts` — one per adopted wrapper — pinning `wrapperKind: "indirection"`.
   These are the distinguishing coverage: they prove each new name reaches the floor.
2. **Redundant tests:** none.
   No existing test is invalidated; the change is purely additive to a `Set`.
3. **Tests that must stay as-is:** the existing `sudo`/`env`/`xargs`/`time`/`nohup`/`timeout`/`nice` rows and the `find`/`fd` exec-conditional block continue to exercise the unchanged classification paths.
   No new floor-behavior test in `bash-command.test.ts` is needed: once a wrapper flags `"indirection"`, the floor is the identical code path already covered by [#490]'s `sudo` floor test — the only genuinely new behavior (name membership) is covered by the `program.test.ts` classifier rows.

## Invariants at risk

Phase 10 Step 5 ([#490]) established the indirection-floor invariant: a wrapper unit flags `wrapperKind: "indirection"` and its `allow` is clamped to `ask` via `WRAPPER_SENTINEL`.
This change extends the set that triggers that invariant without altering the invariant itself.
The existing `program.test.ts` `describe("indirection wrappers")` and `bash-command.test.ts` floor tests pin it; the new rows sit alongside them.
No earlier step's `Outcome:` is regressed — the change only adds set members.

## TDD Order

1. **`fix:` — floor the adopted exec-capable wrappers.**
   Test surface: `test/access-intent/bash/program.test.ts` `describe("indirection wrappers")`.
   Red: add one `it.each` row per new wrapper (`parallel rm ::: x`, `rust-parallel echo`, `rush echo`, `doas aws s3 ls`, `setsid aws s3 ls`, `stdbuf -oL aws s3 ls`, `watch ls`, `flock /tmp/lock aws s3 ls`), each expecting `{ text, wrapperKind: "indirection" }` — fails because the names are not in the set.
   Green: add the 8 strings to `INDIRECTION_WRAPPER_NAMES`.
   Commit: `fix(pi-permission-system): floor additional exec-capable indirection wrappers (#575)`.
2. **`docs:` — sync the enumerated inventory and mark the roadmap step complete.**
   Update `docs/configuration.md` and `.pi/skills/package-pi-permission-system/SKILL.md` enumerations; mark Phase 11 Step 6 `✅` (heading + `S6` Mermaid node) and record the survey outcome in `docs/architecture/architecture.md`.
   Commit: `docs(pi-permission-system): record exec-capable wrapper survey and mark Phase 11 Step 6 complete (#575)`.

## Risks and Mitigations

- **Risk: over-flooring a legitimate non-exec form (e.g. `flock <fd>`, `watch`-less usage).**
  Mitigation: accepted least-privilege posture, consistent with [#490]'s bare-`env`/`sudo -l` edge; an `allow` is only clamped to `ask` (a prompt), never denied, so the user retains one keypress to proceed.
- **Risk: a hyphenated command name (`rust-parallel`) not matching.**
  Mitigation: `basename` splits only on `/`, so `rust-parallel` matches the set entry verbatim; a classifier test row pins it.
- **Risk: the enumerated docs drifting from the code set.**
  Mitigation: the doc-update step edits `configuration.md` and the package skill in the same change; the pre-completion reviewer checks documentation staleness.

## Open Questions

None.
The inventory was confirmed with the operator (adopt the 8 always-invoke wrappers; decline `gargs`; reject `sad`/`fselect`/`runiq`; plan-only rejection notes).

[#490]: https://github.com/gotgenes/pi-packages/issues/490
[#575]: https://github.com/gotgenes/pi-packages/issues/575
