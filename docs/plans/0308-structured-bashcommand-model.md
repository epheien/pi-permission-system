---
issue: 308
issue_title: "Introduce a structured BashCommand model and parse the bash command once per tool_call"
---

# Structured BashCommand model and parse-once injection

## Problem Statement

The three bash permission gates each parse the same command independently and each apply a slightly different AST descent policy, and the unit of bash command-pattern policy is a flat `string[]` re-derived per feature.
That divergence is the bug surface: [#301] arose because the command-pattern walk descended differently than the path walk, and [#306] is re-tuning that same descent.
This issue introduces a structured `BashCommand` model for the command-pattern slice and makes all three bash gates share a single parse, so the queued bash work ([#306], [#307]) becomes a consumer of one representation instead of a fourth bespoke walk.

This is the behavior-preserving enabling refactor — the same move [#304] made one level shallower.
No permission decision changes.

## Goals

- Introduce a `BashCommand` value object and `BashProgram.commands(): BashCommand[]`, replacing the flat `topLevelCommands(): string[]`, consumed by the command-pattern decomposition.
- Parse the bash command once per `tool_call` and inject the parsed `BashProgram` into all three bash gates, retiring the three independent `parse()` calls.
- Preserve every permission decision exactly — the existing suites (the 1000-line extractor suite, both gate suites, the tool-call integration suite, the manager suite) stay green unchanged.

## Non-Goals

- Changing any permission decision — strictly behavior-preserving.
- Evaluating commands nested inside command substitution, process substitution, or subshells ([#306]) — that descent lands on top of this model.
- Migrating the path / external-directory slices to per-command resolution, or effective-working-directory projection ([#307]).
- Unifying the synchronous advisory `checkPermission` / RPC path with the gate's decomposed fidelity ([#309]).
- Structured (name + argv) rule matching — bash rules remain text/glob matched against command text.
- Retiring the `extractTokensForPathRules` / `extractExternalPathsFromBashCommand` facades — they are kept as the seam exercised by `test/bash-external-directory.test.ts` (the [#304] lift-and-shift decision).
- Adding a `context`, `name`, `argv`, `pathCandidates`, or `effectiveCwd` field to `BashCommand` — those are added by their consuming issues ([#306], [#307]); a field nothing reads is a fallow-flagged maintenance trap.

## Background

Relevant modules:

- `src/handlers/gates/bash-program.ts` — `BashProgram.parse(command)` walks the AST once into `rawTokens` + `leadingCdTarget` + `topLevelCommandTexts`, and exposes `pathTokens()`, `externalPaths(cwd)`, and `topLevelCommands()`.
  The private constructor + static `parse()` factory defeats fallow's syntactic analysis, so each public method carries a `// fallow-ignore-next-line unused-class-member` suppression ([#304] retro).
- `src/handlers/gates/bash-command.ts` — `resolveBashCommandCheck(command, agentName, sessionRules, checkPermission, decompose?)` decomposes a chain (via the injectable `decompose`, defaulting to `BashProgram.parse(cmd).topLevelCommands()`), evaluates each unit on the `bash` surface, and combines with `pickMostRestrictive`, falling back to the whole command when decomposition is empty.
- `src/handlers/gates/bash-path-extractor.ts` — the `extractTokensForPathRules` / `extractExternalPathsFromBashCommand` facades, each `await BashProgram.parse(command)` then call a slice.
- `src/handlers/gates/bash-path.ts` / `bash-external-directory.ts` — the two path-bearing bash gates; each takes `(tcc, checkPermission, getSessionRuleset)`, reads the command from `tcc.input`, and calls a facade (which parses).
- `src/handlers/permission-gate-handler.ts` — `handleToolCall` builds an ordered `gateProducers` array; three producers are bash-specific (`describeBashExternalDirectoryGate`, `describeBashPathGate`, and the inline command-pattern producer calling `resolveBashCommandCheck`).
- `test/bash-external-directory.test.ts` — 1027 lines, ~90 call sites against the two extractor facades directly; the load-bearing characterization suite for `externalPaths` / `pathTokens`.

Constraints from `AGENTS.md` / the package skill that apply:

- Default to least privilege; silent over-matching is a permission bypass — a behavior-preserving refactor must not change a single decision.
- Do not add a declared field that nothing reads at runtime — fallow flags it and it is a maintenance trap.
- New `BashProgram` methods need the `// fallow-ignore-next-line unused-class-member` suppression (singular kind, no trailing prose).
- Run `pnpm run check` immediately after each interface-changing step — behavior-preserving signature changes are caught first by the type checker, not the suite.

AST facts (verified empirically during planning):

| Input              | Tree                                                        | `topLevelCommands()` today |
| ------------------ | ----------------------------------------------------------- | -------------------------- |
| `cd a && cd b`     | `program > list > [command, &&, command]`                   | `cd a`, `cd b`             |
| `cat f \| grep b`  | `program > pipeline > [command, \|, command]`               | `cat f`, `grep b`          |
| `npm i > out.txt`  | `program > redirected_statement > [command, file_redirect]` | `npm i`                    |
| `{ cd a; cat b; }` | `program > compound_statement > [command, command]`         | `{ cd a; cat b; }` (whole) |
| `( cd a && rm x )` | `program > subshell > list`                                 | `( cd a && rm x )` (whole) |

The `compound_statement` and `subshell` rows are why `commands()` enumerates the same top-level units `topLevelCommands()` does today — emitting compound statements whole — rather than every `command` node in the tree.
Descending those is [#306]'s job, not this issue's.

## Design Overview

Decision model: the command-pattern unit is promoted from a bare string to a one-field `BashCommand`, and the three bash gates stop owning the parse — the handler parses once and injects the `BashProgram`.
Both moves are behavior-preserving; the value is the extension seam and the single parse, not new behavior.

### `BashCommand` and `commands()`

```typescript
// src/handlers/gates/bash-program.ts

/**
 * One command-pattern unit of a parsed bash program.
 *
 * Minimal by design — `text` is the simple-command (or whole compound
 * statement) string matched against the bash rules. The type is the stable
 * extension point: #306 adds an execution `context`, #307 adds per-command
 * path candidates and an effective working directory.
 */
export interface BashCommand {
  readonly text: string;
}

export class BashProgram {
  // …
  // fallow-ignore-next-line unused-class-member
  commands(): BashCommand[] {
    return this.topLevelCommandTexts.map((text) => ({ text }));
  }
}
```

`topLevelCommands()` and its `fallow-ignore` line are removed; `commands()` takes their place over the same stored `topLevelCommandTexts`.
The enumeration walker (`collectTopLevelCommandTexts`) is unchanged.

### Command-pattern resolver consumes units, not a parse

`resolveBashCommandCheck` is changed from "parse a command string internally" to "combine a caller-supplied unit list," so the handler owns decomposition from the single shared parse and the resolver becomes a pure combiner:

```typescript
// src/handlers/gates/bash-command.ts
export async function resolveBashCommandCheck(
  command: string,             // retained for the empty-units fallback
  units: string[],             // = program.commands().map((c) => c.text)
  agentName: string | undefined,
  sessionRules: Rule[],
  checkPermission: CheckPermissionFn,
): Promise<PermissionCheckResult> {
  const results = units.map((unit) =>
    checkPermission("bash", { command: unit }, agentName, sessionRules),
  );
  return (
    pickMostRestrictive(results) ??
    checkPermission("bash", { command }, agentName, sessionRules)
  );
}
```

The injectable `decompose` parameter and the private `decomposeTopLevelCommands` helper are removed — decomposition now happens once in the handler.
The `?? checkPermission(command)` fallback is preserved, so the empty-units case stays never-weaker.
The function no longer needs to be `async` for parsing, but stays `async` to keep the handler's `await` call site and the gate-producer signature unchanged.

### Parse-once injection in the handler

```typescript
// src/handlers/permission-gate-handler.ts (sketch)
const command = getNonEmptyString(toRecord(tcc.input).command);
const bashProgram =
  tcc.toolName === "bash" && command ? await BashProgram.parse(command) : null;

// bash-specific producers receive the shared program:
() => describeBashExternalDirectoryGate(tcc, bashProgram, checkPermission, getSessionRuleset),
() => describeBashPathGate(tcc, bashProgram, checkPermission, getSessionRuleset),
async () =>
  tcc.toolName === "bash" && bashProgram
    ? describeToolGateFor(
        await resolveBashCommandCheck(
          command ?? "",
          bashProgram.commands().map((c) => c.text),
          tcc.agentName ?? undefined,
          getSessionRuleset(),
          checkPermission,
        ),
      )
    : describeToolGateFor(checkPermission(tcc.toolName, tcc.input, …)),
```

The two path gates gain a `bashProgram: BashProgram | null` parameter and call `bashProgram.externalPaths(cwd)` / `bashProgram.pathTokens()` directly instead of the facade.
They keep their existing `tcc.toolName !== "bash"` / `!command` early-returns; with `bashProgram === null` the gate returns `null` as before.

### Design-review notes

- Dependency width: each bash gate genuinely uses the injected `BashProgram` (one slice each), so the new parameter is a real dependency, not a bag.
- Law of Demeter: gates call `bashProgram.externalPaths(cwd)` / `.pathTokens()` — a method on the injected collaborator, not a reach-through.
- Parameter relay: `bashProgram` flows handler → gate (the endpoint), not threaded through intermediaries.
- `BashCommand` is a one-field type; that is intentional (the extension seam) and fallow-clean because `text` is read by the resolver.
- The extractor facades are kept (test-only seam after this issue); fully retiring them by migrating the 1027-line suite onto `BashProgram` methods is a deferred cleanup, not part of this behavior-preserving refactor.

## Module-Level Changes

1. `src/handlers/gates/bash-program.ts` — add `export interface BashCommand`; replace the `topLevelCommands()` method (and its `fallow-ignore` line) with `commands(): BashCommand[]`; the stored `topLevelCommandTexts` field and `collectTopLevelCommandTexts` walker are unchanged.
2. `src/handlers/gates/bash-command.ts` — change `resolveBashCommandCheck` to accept `(command, units, agentName, sessionRules, checkPermission)`; remove the `decompose` parameter and the `decomposeTopLevelCommands` helper.
3. `src/handlers/permission-gate-handler.ts` — parse `bashProgram` once when `tcc.toolName === "bash"` and a command is present; pass it to the two path gates; compute `units` from `bashProgram.commands()` and pass them to `resolveBashCommandCheck`.
4. `src/handlers/gates/bash-external-directory.ts` — add a `bashProgram: BashProgram | null` parameter; replace `extractExternalPathsFromBashCommand(command, cwd)` with `bashProgram.externalPaths(cwd)`; return `null` when `bashProgram` is `null`.
5. `src/handlers/gates/bash-path.ts` — add a `bashProgram: BashProgram | null` parameter; replace `extractTokensForPathRules(command)` with `bashProgram.pathTokens()`; return `null` when `bashProgram` is `null`.
6. `src/handlers/gates/bash-path-extractor.ts` — unchanged (kept for `test/bash-external-directory.test.ts`).
7. `test/handlers/gates/bash-program.test.ts` — rename the `topLevelCommands` describe and update its assertions to the `commands(): BashCommand[]` shape (`[{ text: "…" }, …]`).
8. `test/handlers/gates/bash-command.test.ts` — pass `units` directly instead of a `decompose` stub; add the `command` fallback argument.
9. `test/handlers/gates/bash-external-directory.test.ts` and `test/handlers/gates/bash-path.test.ts` — construct a `BashProgram` (real `parse`) and pass it to the gate under test.
10. `test/handlers/tool-call.test.ts` — verify the bash chain / single-command integration tests still pass through the handler's single parse (assertions unchanged).
11. `docs/architecture/architecture.md` — update the `bash-program.ts` and `bash-command.ts` listing lines: `commands(): BashCommand[]` (not `topLevelCommands()`), and note the gate handler parses once and injects the `BashProgram`.

No `pkg:*` doc under `docs/configuration.md` or `README.md` changes — behavior is unchanged.
`docs/architecture/v3-architecture.md` is historical narrative and is left unchanged ([#304] retro).

## Test Impact Analysis

1. New unit coverage enabled: `commands()` returns typed `BashCommand[]` entries — the renamed `bash-program.test.ts` cases assert the object shape (`{ text }`), documenting the seam.
   No genuinely new behavior is exercised; the enumeration is unchanged.
2. Tests that become redundant: none — no assertion is removed.
   The `decompose`-stub indirection in `bash-command.test.ts` is replaced by passing `units` directly, which is a simplification, not a coverage loss.
3. Tests that must stay as-is: `test/bash-external-directory.test.ts` (the 1027-line characterization suite) proves `externalPaths` / `pathTokens` outputs are unchanged — the strongest behavior-preservation signal for the parse-once move; both gate suites and the tool-call integration suite confirm the injected program produces identical gate decisions.

## TDD Order

1. `test: model bash command-pattern units as BashCommand` — add `BashCommand` and `commands()` to `bash-program.ts`, remove `topLevelCommands()`; update `resolveBashCommandCheck`'s default decompose to `commands().map((c) => c.text)`; rename/update `bash-program.test.ts` to the object shape.
   Single atomic commit: removing `topLevelCommands()` breaks its sole consumer and its tests at the type level, so the method swap, the consumer update, and the test update land together.
   Use `feat:` is wrong (no behavior change) — use `refactor:`.
   Run `pnpm run check`.
2. `refactor: inject the shared BashProgram into the bash path gates` — parse `bashProgram` once in the handler; add the `bashProgram` parameter to `describeBashExternalDirectoryGate` and `describeBashPathGate`, calling `externalPaths`/`pathTokens` on it; update `test/handlers/gates/bash-external-directory.test.ts` and `bash-path.test.ts` to pass a parsed program.
   The signature change and its call sites (handler + gate tests) must land together.
   Run `pnpm run check`.
3. `refactor: evaluate bash command units from the shared parse` — change `resolveBashCommandCheck` to `(command, units, …)`, remove `decompose` and `decomposeTopLevelCommands`; the handler passes `bashProgram.commands().map((c) => c.text)`; update `bash-command.test.ts` to pass units; confirm `tool-call.test.ts` stays green.
   Run `pnpm run check`; run the full suite (`resolveBashCommandCheck` is a shared helper).
4. `docs: update architecture listing for the BashCommand model and parse-once` — update the two `architecture.md` lines.

After step 3, a bash `tool_call` parses the command exactly once.

## Risks and Mitigations

1. Parse-once changes the decision for some command — Mitigation: the gates call the identical slice methods on the same parse; the 1027-line extractor suite, both gate suites, and the tool-call integration suite assert unchanged outputs.
   Run the full suite after step 3.
2. The extractor facades become production-dead and fallow flags them — Mitigation: `test/bash-external-directory.test.ts` imports both, and fallow treats test files as consumers ([#301] retro), so they stay live; retaining them is the explicit [#304] lift-and-shift decision.
3. `commands()` is flagged by fallow as an unused class member (private-ctor false positive) — Mitigation: carry the `// fallow-ignore-next-line unused-class-member` suppression (singular kind, no trailing prose) exactly as `topLevelCommands()` did.
4. Gate-signature change ripples to mocks beyond the gate suites — Mitigation: grep for every constructor of the gate-call arguments; the gates are called only from the handler and their own suites.
   Run `pnpm run check` after steps 1–3.
5. This refactor ships stacked under [#306]'s release — Mitigation: like [#304] under [#301], note at ship time that release-please omits `refactor:` commits from the changelog, so [#308] must be closed explicitly when [#306] ships (the `/ship-issue` stacked-enabler check covers this).

## Open Questions

- Whether `resolveBashCommandCheck` should take `units: string[]` or `commands: BashCommand[]` directly.
  The plan passes `string[]` to keep the resolver decoupled from the model shape and its tests trivial; revisit if [#306] needs the per-unit `context` inside the resolver (it evaluates by `text`, so likely not).

[#301]: https://github.com/gotgenes/pi-packages/issues/301
[#304]: https://github.com/gotgenes/pi-packages/issues/304
[#306]: https://github.com/gotgenes/pi-packages/issues/306
[#307]: https://github.com/gotgenes/pi-packages/issues/307
[#309]: https://github.com/gotgenes/pi-packages/issues/309
