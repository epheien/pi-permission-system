---
issue: 490
issue_title: "pi-permission-system: floor other indirection wrappers (sudo/env/xargs/find -exec) to ask"
---

# Floor indirection wrappers to ask

## Release Recommendation

**Release:** ship independently

This is Phase 10, Step 5 of the architecture roadmap, tagged `Release: independent` there (the "Release batches" subsection lists Steps 3–6 as independently releasable; only Steps 1–2 form the "tool-kind-dispatch" batch).
It is a `fix:` behavior change (a bypass fix that tightens gating), so it cuts a release on its own once landed.

## Problem Statement

[#481] closed the env-var-prefix and inline-shell (`bash -c`/`eval`) bypasses: it strips a leading `variable_assignment` prefix from each bash command unit and floors an opaque-payload wrapper's `allow` up to `ask`.
It deliberately scoped the floor to inline-shell payloads only.
Other common indirection wrappers still let an inner command evade the rule that should gate it, because the wrapper is the `command_name` and the inner command is a plain argument:

- `sudo <cmd>` — runs `<cmd>` as another user; the unit text is `sudo <cmd>`, so a `<cmd> *` rule never matches.
- `env VAR=x <cmd>` — `env` is a real command; the inner `<cmd>` is an argument.
- `xargs <cmd>`, `find … -exec <cmd> …` — run `<cmd>` per input / per match (the actual command is constructed at runtime).
- `time`, `nohup`, `timeout <dur>`, `nice` — prefix wrappers that run a following command.
- `fd -x <cmd>` / `fd --exec <cmd>` (and `-X`/`--exec-batch`) — the modern `find` rewrite's per-result exec.

The AST confirms the structural obstacle: every one of these parses as a **flat `command` node** — the wrapper is `command_name`, the inner command and its arguments are sibling `word` nodes, with no boundary marking where the wrapper's own options end and the inner command begins.

## Goals

- Floor each listed indirection wrapper's decision to at least `ask`, mirroring [#481]'s opaque-payload floor: an `allow` (including a permissive top-level `*`) is clamped up to `ask`, while an explicit `deny` or `ask` rule on the wrapper passes through unchanged.
- Cover the always-invoking wrappers by `command_name` basename: `sudo`, `env`, `xargs`, `time`, `nohup`, `timeout`, `nice`.
- Cover the search tools `find` and `fd` **only when an exec flag is present** (`find` with `-exec`/`-execdir`/`-ok`/`-okdir`; `fd` with `-x`/`--exec`/`-X`/`--exec-batch`), so a bare `find`/`fd` search — which runs no subcommand and is extremely common — is not floored.
- Keep the wrapper name/flag sets as documented, easily-extensible constants so adding a tool later (see [#575]) is a one-line change.
- Keep the fix fail-safe and deterministic — it only ever tightens a decision, never loosens one.

This is a behavior change on upgrade with no config edit: a command that was silently auto-allowed (e.g. `sudo aws …` under `aws *: allow`, or `env FOO=bar aws …` under a permissive top-level `*`) will now prompt.
Following the [#481] precedent, it is classified `fix:` (not `fix!:`): it only closes a bypass and never weakens an existing decision — there is no prior intended behavior to preserve, the old behavior was the bug.

## Non-Goals

- **Re-targeting** any wrapper at its inner command (the alternative the issue floated for prefix wrappers).
  The operator confirmed the floor-all direction on 2026-07-12, superseding the roadmap's earlier 2026-07-10 "re-target prefix wrappers" note.
  Re-targeting would require a per-wrapper option-arity table (`sudo -u www-data`, `env -u NAME`, `nice -n 10`, `timeout 10` each take a value that a naive scan would mistake for the inner command name); a wrong table silently under-matches, which is exactly the "silent over-/under-matching is a permission bypass" class the package warns against.
  The floor needs no option tables and is complete and uniform.
- **Re-parsing** `xargs`/`find -exec`/`fd -x` payloads to match inner commands against inner rules — floored instead, like the opaque wrappers.
- **A force-allow escape valve for wrappers.**
  As with [#481]'s opaque floor, there is no way to auto-allow a floored wrapper (an explicit `allow` is clamped to `ask`); this is the accepted cost of the floor-all direction (see Risks) and is the intended safety posture.
- **Surveying other modern CLI rewrites** (GNU `parallel`, `rust-parallel`, `sad`, …) beyond `fd` — filed as follow-up [#575]; the constants are structured to make each addition trivial.
- Collecting path candidates from inside wrapper payloads for the `path` / `external_directory` surfaces — the whole wrapper is floored to `ask`, so the human is prompted and sees the full command.

## Background

The relevant code lives in `src/access-intent/bash/` and `src/handlers/gates/`:

- `command-enumeration.ts` — `collectCommands(node)` walks the parsed AST and emits one `BashCommand` per command unit.
  [#481] added the `opaque?: boolean` flag to `BashCommand`, the private `isOpaqueWrapperCommand(node)` detector, the `SHELL_WRAPPER_NAMES` set, and `commandUnitText(node)` (which strips the leading `variable_assignment` prefix).
  `makeUnit(text, context, opaque?)` attaches `opaque` only when true (to keep `toEqual` fixtures clean).
- `handlers/gates/bash-command.ts` — `resolveBashCommandCheck(command, commands, agentName, resolver)` resolves each unit on the `bash` surface and combines them with `pickMostRestrictive` (`deny > ask > allow`).
  It already floors an `opaque` unit's `allow` up to a synthetic `ask` with the `<opaque-bash-wrapper>` sentinel, and fails closed to `<unparseable-bash-command>` for a non-empty command that parses to zero units ([#452]).
- `program.ts` — `BashProgram.commands()` re-exports `BashCommand` and returns the enumerated units.
- `bash-advisory-check.ts` — `resolveBashAdvisoryCheck` routes advisory `bash` service queries through the same shared `resolveBashCommandCheck`, so the floor applies to the advisory surface automatically ([#309]); no separate change is needed there.

Constraints from the package skill / AGENTS:

- Default to least privilege — when in doubt, prompt; the floor-to-`ask` design follows this directly.
- Wildcard matching must be explicit and tested — silent over- or under-matching is a permission bypass.
- `docs/architecture/architecture.md` names the enumerator's internal symbols (`isOpaqueWrapperCommand`, `SHELL_WRAPPER_NAMES`, the `opaque` flag) in prose and records the [#490] roadmap step's direction; the package skill `SKILL.md` describes the opaque floor in prose.
  All must be updated when the enumeration semantics and the recorded direction change.
- `docs/configuration.md` and `README.md` document the `bash` fail-closed behavior; update them for the new wrapper floor.

## Design Overview

### Generalize the flag to a wrapper-kind discriminant

[#481]'s `opaque?: boolean` means "floor this unit's `allow` to `ask`, with the `<opaque-bash-wrapper>` sentinel."
The new wrappers floor identically but deserve a distinct audit sentinel — `sudo` is not an *opaque* payload, so labeling it `<opaque-bash-wrapper>` in the review log would be misleading.
Both reasons floor for exactly one cause, so model it as a discriminant rather than two mutually-exclusive booleans (which would make an illegal `{ opaque, indirection }` state representable):

```typescript
export type WrapperKind = "opaque-payload" | "indirection";

export interface BashCommand {
  readonly text: string;
  readonly context?: BashCommandContext;
  /**
   * Set when this unit is a floored wrapper: `"opaque-payload"` for
   * `bash -c`/`eval` (#481), `"indirection"` for sudo/env/xargs/find -exec/… (#490).
   * Its decision is floored to at least `ask`; the kind selects the audit sentinel.
   */
  readonly wrapperKind?: WrapperKind;
}
```

The enumerator owns the structural classification (which kind, if any); resolution owns the decision policy (the `ask` floor) and the sentinel mapping — the same separation of concerns [#481] established.

### Classification (enumerator)

Replace `isOpaqueWrapperCommand(node): boolean` with `classifyWrapperCommand(node): WrapperKind | undefined`.
It reads only the `command` node's own named children (the same shallow walk the existing detector uses): skip leading `variable_assignment` children, take the first remaining child's basename as the `command_name`, and collect the rest as argument texts.
Then, in order:

```typescript
function classifyWrapperCommand(node: TSNode): WrapperKind | undefined {
  const { commandName, args } = readWrapperCommand(node);
  if (commandName === undefined) return undefined;
  if (commandName === "eval") return "opaque-payload";
  if (SHELL_WRAPPER_NAMES.has(commandName) && hasShortFlagC(args)) {
    return "opaque-payload";
  }
  if (INDIRECTION_WRAPPER_NAMES.has(commandName)) return "indirection";
  const execFlags = EXEC_CONDITIONAL_WRAPPERS.get(commandName);
  if (execFlags && args.some((arg) => execFlags.has(arg))) return "indirection";
  return undefined;
}
```

New constants (documented, one-line-extensible):

```typescript
// Always invoke an inner command; floored by command name alone.
const INDIRECTION_WRAPPER_NAMES = new Set([
  "sudo", "env", "xargs", "time", "nohup", "timeout", "nice",
]);

// Search tools that exec a subcommand only when an exec flag is present.
const EXEC_CONDITIONAL_WRAPPERS = new Map<string, ReadonlySet<string>>([
  ["find", new Set(["-exec", "-execdir", "-ok", "-okdir"])],
  ["fd", new Set(["-x", "--exec", "-X", "--exec-batch"])],
]);
```

`hasShortFlagC(args)` preserves the exact [#481] short-flag-cluster semantics (a word before `--` that starts with `-`, is not `--`, and includes `c`), factored out of the old inline loop.
`SHELL_WRAPPER_NAMES` is unchanged.

Detection order matters: `sudo bash -c "…"` classifies as `"indirection"` (its `command_name` is `sudo`), which is correct — the whole unit is floored regardless.

### Floor (resolution)

Map the kind to its sentinel and apply the existing clamp:

```typescript
const WRAPPER_SENTINEL: Record<WrapperKind, string> = {
  "opaque-payload": "<opaque-bash-wrapper>",
  "indirection": "<indirection-bash-wrapper>",
};

const floored =
  cmd.wrapperKind && base.state === "allow"
    ? { ...base, state: "ask" as const, matchedPattern: WRAPPER_SENTINEL[cmd.wrapperKind] }
    : base;
return cmd.context ? { ...floored, commandContext: cmd.context } : floored;
```

`deny`/`ask` pass through unchanged, so an explicit `sudo *: deny` still denies and `pickMostRestrictive` keeps `deny > ask > allow`.
The `<opaque-bash-wrapper>` sentinel is byte-for-byte preserved, so [#481]'s tests and docs stay green.

### Edge cases (accepted, documented)

- A bare `env`/`time`/`sudo -l` with no inner command is still floored (it matches by name).
  Erring toward `ask` is the least-privilege posture; the minor prompt is accepted.
- `time`/`sudo` in a compound form (`time { …; }`, `time (subshell)`) may parse with a different `command_name`; then the wrapper is not flagged, but the inner command/subshell is still enumerated and gated normally — never-weaker.
- A clustered `fd` short flag (`-ux`) or an `--exec=`-style token is not detected by the exact-token match; missing it does not floor, which is an incomplete fix, not a new bypass (the command resolves through normal rules).
- A non-literal `command_name` (`$SHELL -c`, `"$(which sudo)" …`) is not classified — never-weaker.

## Module-Level Changes

- `src/access-intent/bash/command-enumeration.ts`
  - Add and export `WrapperKind`; replace `BashCommand.opaque?: boolean` with `wrapperKind?: WrapperKind`; update `makeUnit`'s third parameter to `wrapperKind?: WrapperKind` (attach only when defined).
  - Replace `isOpaqueWrapperCommand` with `classifyWrapperCommand`; extract `readWrapperCommand(node)` (command_name basename + arg texts) and `hasShortFlagC(args)` helpers.
  - Add `INDIRECTION_WRAPPER_NAMES` and `EXEC_CONDITIONAL_WRAPPERS` constants; keep `SHELL_WRAPPER_NAMES` and `basename`.
  - Update the `collectCommands` JSDoc to describe the generalized wrapper flagging.
- `src/handlers/gates/bash-command.ts` — add the `WRAPPER_SENTINEL` map keyed by `WrapperKind`; import `WrapperKind`; floor on `cmd.wrapperKind` instead of `cmd.opaque`; update the function JSDoc to cover indirection wrappers and the `<indirection-bash-wrapper>` sentinel.
- `src/access-intent/bash/program.ts` — no code change; update the `commands()` JSDoc from "flags opaque-payload wrappers with `opaque: true`" to the `wrapperKind` discriminant covering both kinds. (Re-export of `WrapperKind` is optional; `bash-command.ts` imports it from `command-enumeration.ts` directly.)
- `test/access-intent/bash/program.test.ts` — migrate the existing `opaque: true` literals to `wrapperKind: "opaque-payload"`; add an `indirection` `describe` block: each always-invoke wrapper is flagged `wrapperKind: "indirection"`; a bare `find`/`fd` is not flagged; `find … -exec …` / `fd -x …` / `fd --exec …` / `fd -X …` are flagged; a plain `ls`/`aws` is not; an env-prefixed `AWS_PROFILE=x sudo aws …` is stripped to `sudo aws …` and flagged.
- `test/access-intent/bash/sync-commands.test.ts` — migrate the `opaque: true` literal to `wrapperKind: "opaque-payload"`.
- `test/handlers/gates/bash-command.test.ts` — migrate the `opaque: true` literals to `wrapperKind: "opaque-payload"`; add an indirection-floor `describe`: allow→ask with `<indirection-bash-wrapper>`, explicit deny stays, explicit ask stays, a non-wrapper allow is not floored.
- `test/bash-advisory-check.test.ts` — asserts sentinels only (no `opaque` literal); no change required, but add an advisory indirection-floor case for parity.
- `docs/configuration.md` — in "Fail-closed behavior", add a bullet for the indirection-wrapper floor: list the always-invoke wrappers and the `find`/`fd` exec-flag condition, the `<indirection-bash-wrapper>` sentinel, the allow→ask clamp, and that an explicit `deny` still denies.
- `README.md` — line 22: extend "an opaque `bash -c`/`eval` wrapper" to also mention indirection wrappers (`sudo`/`env`/`xargs`/`find -exec`/…) prompting.
- `docs/architecture/architecture.md`
  - Step 5 ([#490]) section: retitle to the floor-all direction, replace the "Direction confirmed 2026-07-10: re-target …" line with a note that the 2026-07-12 decision floors all listed wrappers (superseding the earlier hybrid), extend **Target** to include `handlers/gates/bash-command.ts` + the doc files, update **Outcome**, and mark the step `✅` (heading + the `S5` Mermaid node).
  - Health-metrics table row "Indirection-wrapper coverage": change the Phase 10 target from "prefix wrappers re-targeted, `xargs`/`find -exec` floored" to "all listed wrappers floored to `ask`".
  - `command-enumeration.ts` module listing (the `access-intent/bash/` tree): replace `isOpaqueWrapperCommand`/`opaque` with `classifyWrapperCommand`/`wrapperKind` and note the new `INDIRECTION_WRAPPER_NAMES`/`EXEC_CONDITIONAL_WRAPPERS` tables.
  - `program.ts` module listing: replace "flags opaque-payload wrappers (`bash -c`/`eval`) with `opaque: true`" with the `wrapperKind` discriminant covering indirection wrappers ([#490]).
- `.pi/skills/package-pi-permission-system/SKILL.md` — reword the opaque-floor paragraph (the "An opaque-payload wrapper … is flagged `opaque` … `<opaque-bash-wrapper>`" line) to describe the `wrapperKind` discriminant and the sibling `<indirection-bash-wrapper>` floor for the [#490] wrappers.

No removed or renamed **exports** (`collectCommands`, `BashCommand`, `resolveBashCommandCheck` are unchanged); `WrapperKind` is a new export.
The renamed symbols (`isOpaqueWrapperCommand` → `classifyWrapperCommand`) and the `BashCommand.opaque` → `wrapperKind` field are private/internal; a grep confirms their only references are within `command-enumeration.ts`, `bash-command.ts`, the four test files above, `architecture.md`, and `SKILL.md` — all listed here.

## Test Impact Analysis

1. **New tests enabled.**
   The `wrapperKind` flag is observable on `BashProgram.commands()`, so each wrapper's classification is unit-testable directly in `program.test.ts` without going through the full gate.
   The floor is unit-testable in `bash-command.test.ts` against a mocked resolver, and on the advisory surface in `bash-advisory-check.test.ts`.
2. **Redundant tests.**
   None removed — this is additive plus a mechanical field rename.
   The existing opaque-wrapper cases stay (renamed to `wrapperKind: "opaque-payload"`); they still pin the [#481] behavior, which is unchanged.
3. **Tests that must stay as-is.**
   The chain/substitution/subshell enumeration cases and `bash-command-metamorphic.test.ts` (which wraps with a `cd` prefix, not these wrappers) continue to exercise the un-floored path and the `deny > ask > allow` combination.

## Invariants at risk

- **[#481] opaque floor** — `bash -c`/`sh -c`/`eval` (etc.) still floor to `ask` with the byte-identical `<opaque-bash-wrapper>` sentinel.
  Pinned by the existing `bash-command.test.ts` opaque-floor cases and `bash-advisory-check.test.ts:101`; the discriminant migration keeps the sentinel string and these tests green.
- **[#481] env-prefix strip** — `commandUnitText` still strips a leading `variable_assignment` prefix; it is untouched and composes with the new floor (`AWS_PROFILE=x sudo aws …` → `sudo aws …` → floored).
  Pinned by the existing prefix-strip cases in `program.test.ts` plus a new composition case.
- **[#452] fail-closed** — a non-empty command parsing to zero units still resolves to `ask` (`<unparseable-bash-command>`); the floor adds a sibling sentinel and does not touch the empty-units branch.
  Pinned by the existing fail-closed tests.
- **[#306] never-weaker nested enumeration** — the enclosing command and each nested command are still emitted; the `wrapperKind` flag and floor can only tighten.
  Pinned by `bash-command-metamorphic.test.ts` and the substitution/subshell cases.
- **[#393] no spurious widening** — the floor only narrows (`allow` → `ask`); it never relaxes a `deny`/`ask`.
  Pinned by the new deny-/ask-stays floor cases.

## TDD Order

1. **Generalize the wrapper flag to a `wrapperKind` discriminant (behavior-preserving refactor).**
   Surfaces: `command-enumeration.ts`, `bash-command.ts`, and the four test files.
   Red — migrate every `opaque: true` literal in `program.test.ts`, `sync-commands.test.ts`, and `bash-command.test.ts` to `wrapperKind: "opaque-payload"` (the type change makes the old literals excess-property errors, so all call sites move in this one step).
   Green — add `WrapperKind`, replace `BashCommand.opaque` with `wrapperKind`, rename `isOpaqueWrapperCommand` → `classifyWrapperCommand` (opaque-payload arm only, extracting `readWrapperCommand`/`hasShortFlagC`), and switch the floor to the `WRAPPER_SENTINEL` map (opaque-payload key only).
   Same sentinel, same behavior; the suite stays green.
   Commit: `refactor(pi-permission-system): model bash wrapper floor as a kind discriminant (#490)`.
2. **Floor always-invoke indirection wrappers to `ask`.**
   Surfaces: `test/access-intent/bash/program.test.ts` (flag) and `test/handlers/gates/bash-command.test.ts` (floor).
   Red — flag cases: `sudo aws s3 ls`, `env FOO=bar aws s3 ls`, `xargs rm`, `time aws …`, `nohup aws …`, `timeout 10 aws …`, `nice -n 10 aws …`, `/usr/bin/sudo …` (basename) → `wrapperKind: "indirection"`; a plain `aws s3 ls`/`ls` → unflagged; `AWS_PROFILE=x sudo aws …` stripped then flagged.
   Floor cases: an indirection unit resolving to `allow` becomes `ask` with `matchedPattern: "<indirection-bash-wrapper>"`; a `deny` rule stays `deny`; an `ask` rule stays `ask`; a non-wrapper `allow` is untouched.
   Green — add `INDIRECTION_WRAPPER_NAMES`, extend `classifyWrapperCommand`, add the `"indirection"` sentinel to `WRAPPER_SENTINEL`.
   Commit: `fix(pi-permission-system): floor sudo/env/xargs/time/nohup/timeout/nice to ask (#490)`.
3. **Floor `find`/`fd` only with an exec flag.**
   Surfaces: `program.test.ts` (flag) and `bash-command.test.ts` (floor).
   Red — `find . -name '*.py' -exec rm {} \;` / `find . -execdir …` / `find . -ok …` → `"indirection"`; a bare `find . -name '*.py'` → unflagged; `fd -x rm` / `fd --exec rm` / `fd -X rm` / `fd --exec-batch rm` → `"indirection"`; a bare `fd pattern` → unflagged.
   Green — add `EXEC_CONDITIONAL_WRAPPERS`, extend `classifyWrapperCommand`.
   Commit: `fix(pi-permission-system): floor find/fd exec wrappers to ask (#490)`.
4. **Document the new behavior and mark the roadmap step complete.**
   Update `docs/configuration.md`, `README.md`, `docs/architecture/architecture.md` (Step 5 direction + `✅` on heading and `S5` node, the health-metrics row, and the `command-enumeration.ts`/`program.ts` listings), and `.pi/skills/package-pi-permission-system/SKILL.md`.
   Commit: `docs(pi-permission-system): document indirection-wrapper floor and mark roadmap step 5 (#490)`.

## Risks and Mitigations

- **Risk:** a benign wrapped command (`sudo apt list`, `env`, `timeout 5 curl …`) now prompts where a permissive policy auto-allowed it, and there is no way to force-allow the wrapper.
  **Mitigation:** intended trade-off (fail-safe over convenience), the same posture as [#481]'s opaque floor; documented in `docs/configuration.md`.
  A user who trusts the inner command can gate it via an explicit `deny`-free specific rule on the whole wrapper string only up to `ask` — force-allow is deliberately unavailable.
- **Risk:** over-broad name matching floors an unrelated command that happens to share a wrapper name.
  **Mitigation:** the always-invoke names are specific commands (`sudo`/`env`/`xargs`/`time`/`nohup`/`timeout`/`nice`); `find`/`fd` require an exec flag, so a bare search is unaffected.
- **Risk:** the `opaque` → `wrapperKind` rename silently drops a floor if a literal migration is missed.
  **Mitigation:** the field rename is a type change, so every stale `opaque: true` literal is a compile error caught in Step 1; `pnpm run check` gates it.
- **Risk:** the recorded roadmap direction (2026-07-10 hybrid) and this floor-all plan diverge, confusing a future reader.
  **Mitigation:** Step 4 rewrites the roadmap Step 5 note to record the 2026-07-12 supersession explicitly.

## Open Questions

- **Other exec-capable modern rewrites** (GNU `parallel`, `rust-parallel`, `sad`, …) — filed as follow-up [#575]; deferred so this change ships the confirmed set.
- **Force-allow escape valve for trusted wrappers** — deliberately omitted; revisit only if the floor proves too coarse in practice (the same deferral [#481] made for precise inner-command matching).

[#306]: https://github.com/gotgenes/pi-packages/issues/306
[#309]: https://github.com/gotgenes/pi-packages/issues/309
[#393]: https://github.com/gotgenes/pi-packages/issues/393
[#452]: https://github.com/gotgenes/pi-packages/issues/452
[#481]: https://github.com/gotgenes/pi-packages/issues/481
[#490]: https://github.com/gotgenes/pi-packages/issues/490
[#575]: https://github.com/gotgenes/pi-packages/issues/575
