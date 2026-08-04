---
issue: 290
issue_title: "Reduce stripJsonComments complexity in config-loader.ts"
---

# Decompose `stripJsonComments`

## Problem Statement

`stripJsonComments` in `src/config-loader.ts` is a hand-rolled JSONC scanner that walks the input one character at a time while juggling five pieces of mutable state (`inString`, `stringQuote`, `escaping`, `inLineComment`, `inBlockComment`) in a single loop.
`fallow health --targets` flags it at cognitive complexity 31 — the interleaved state transitions, not the loop itself, are the source of the load.
This is the lowest-priority of the Phase 2 complexity targets in the config-loader track of `packages/pi-permission-system/docs/architecture/architecture.md`.

## Goals

- Lower the cognitive complexity of `stripJsonComments` from 31 to below the `fallow` target (< 15) by decomposing it into named, pure consume helpers.
- Replace the five-flag single-loop scanner with a thin dispatcher that delegates each JSONC sub-grammar (string literal, line comment, block comment) to a helper that returns the consumed segment and the resume index.
- Keep behavior identical — the existing config-loading tests that cover comment stripping stay green without modification.
- Add direct unit tests for `stripJsonComments` (it is already exported but has no dedicated coverage), pinning current behavior before the refactor.

## Non-Goals

- No change to the exported signature `stripJsonComments(input: string): string` or its two call sites (`loadUnifiedConfig`, `policy-loader.ts`).
- No new exports — the consume helpers stay private to the module (a speculative export would trip `fallow dead-code`).
- No change to JSONC semantics: this is a comment stripper, not a full JSON5 parser; trailing commas, single-quoted keys, and other JSON5 features remain out of scope.
- No change to any other function in `config-loader.ts` (`normalizeUnifiedConfig`, `mergeUnifiedConfigs`, `loadAndMergeConfigs`, `normalizeFlatPermissionValue`, etc.).
- Phase 2 Step 6 ([#288], test-fixture extraction) is a separate issue and out of scope.

## Background

### Current behavior (the contract to preserve)

The scanner emits every input character verbatim except the contents of `//` line comments and `/* ... */` block comments, with these nuances confirmed by reading the loop:

- A `//` outside a string starts a line comment; the comment text is dropped, but the terminating `\n` is preserved in the output (and a comment that runs to EOF with no newline simply drops the rest).
- A `/*` outside a string starts a block comment; everything through the closing `*/` is dropped, including the `*/`.
  An unterminated block comment drops everything to EOF.
- Inside a string literal (`"`-quoted or `'`-quoted), `//` and `/*` are *not* treated as comments — the original guards both comment checks with `!inString`.
  The opening quote, the body (with backslash escapes honored so an escaped quote does not close the string), and the closing quote are all emitted verbatim.
  An unterminated string emits everything to EOF.
- A lone `/` that is not part of `//` or `/*` is emitted as an ordinary character.

### Call sites

`stripJsonComments` is `export`ed and has exactly two production consumers:

- `config-loader.ts` → `loadUnifiedConfig` (`JSON.parse(stripJsonComments(raw))`).
- `policy-loader.ts` → `loadPolicyFile` (same pattern).

It is currently exercised only indirectly — `test/config-loader.test.ts` has a single `"strips JSONC comments before parsing"` case routed through `loadUnifiedConfig`.
No test imports `stripJsonComments` directly today.

### Constraints from AGENTS.md / package skill

- TypeScript, ES2024 target, `pnpm` only.
- Within the package, import siblings via the `#src/` / `#test/` aliases, not relative paths.
- Biome bans `x!` and ESLint auto-fixes `x as T` back to `x!`; avoid assertions — the dispatcher narrows naturally without them.
- Export only symbols a production consumer imports — keep the helpers private.
- This is a pure utility with no Pi SDK imports; keep it that way.

## Design Overview

### Approach: consume helpers (chosen) vs. mode-discriminant step function (rejected)

The issue offers two shapes.
Per the `code-design` heuristics, an extraction is only worthwhile if each extracted piece returns a value, owns state, or gives behavior to data — relocating statements to lower a metric is procedure-splitting.

- Rejected — a typed `mode` discriminant with a single per-character `step(state, char)` function.
  The step function would read and write a shared mutable `state` object (`{ inString, escaping, ... }`) — an output-argument / shared-mutable-state smell — and the `mode` discriminant exists only to re-encode the same five flags.
  It relocates the interleaving rather than removing it.
- Chosen — three pure consume helpers, one per JSONC sub-grammar, each taking `(input, index)` (where `index` points at the opening delimiter) and returning `{ output, nextIndex }`.
  Each helper returns a value and encapsulates one production of the grammar; the outer loop becomes a stateless dispatcher with no flags at all.
  This is the issue's second option and the design-sound one.

### Shape

```typescript
/** A consumed run of source: the text to emit and the index to resume scanning. */
interface ScanSegment {
  output: string;
  nextIndex: number;
}

/** Consume a `//` line comment starting at `start`; drop the body, keep the newline. */
function consumeLineComment(input: string, start: number): ScanSegment;

// Consume a slash-star block comment starting at `start`; drop it entirely.
function consumeBlockComment(input: string, start: number): ScanSegment;

/** Consume a string literal starting at the opening quote at `start`; emit verbatim. */
function consumeString(input: string, start: number): ScanSegment;
```

### Dispatcher

```typescript
export function stripJsonComments(input: string): string {
  let output = "";
  let i = 0;
  while (i < input.length) {
    const char = input[i];
    const next = input[i + 1] ?? "";

    if (char === "/" && next === "/") {
      ({ output, i } = applySegment(output, consumeLineComment(input, i)));
      continue;
    }
    if (char === "/" && next === "*") {
      ({ output, i } = applySegment(output, consumeBlockComment(input, i)));
      continue;
    }
    if (char === '"' || char === "'") {
      ({ output, i } = applySegment(output, consumeString(input, i)));
      continue;
    }

    output += char;
    i++;
  }
  return output;
}
```

The dispatcher checks `//` and `/*` before quotes, which is safe because strings are fully consumed by `consumeString` the instant an opening quote is seen — control never re-enters the dispatcher mid-string, so the original's `!inString` guard on the comment checks is preserved structurally rather than as a flag. (If a tiny `applySegment` helper reads awkwardly, the equivalent `output += seg.output; i = seg.nextIndex;` is fine — the point is the loop holds no scanning state.)

### Helper bodies (behavior-preserving)

`consumeString` honors backslash escapes so an escaped quote does not close the literal; it emits the opening quote, the body, and the closing quote, and stops at the index past the closing quote (or EOF for an unterminated string):

```typescript
function consumeString(input: string, start: number): ScanSegment {
  const quote = input[start];
  let output = quote;
  let i = start + 1;
  let escaping = false;
  while (i < input.length) {
    const char = input[i];
    output += char;
    i++;
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === quote) break;
  }
  return { output, nextIndex: i };
}
```

`consumeLineComment` scans to the next `\n`, drops the comment text, and preserves the newline:

```typescript
function consumeLineComment(input: string, start: number): ScanSegment {
  const newlineIndex = input.indexOf("\n", start);
  if (newlineIndex === -1) return { output: "", nextIndex: input.length };
  return { output: "\n", nextIndex: newlineIndex + 1 };
}
```

`consumeBlockComment` scans to the closing `*/` and drops everything (unterminated → EOF):

```typescript
function consumeBlockComment(input: string, start: number): ScanSegment {
  const closeIndex = input.indexOf("*/", start + 2);
  if (closeIndex === -1) return { output: "", nextIndex: input.length };
  return { output: "", nextIndex: closeIndex + 2 };
}
```

Note the comment helpers drop the local `escaping` flag entirely (escapes are meaningless in comments) and replace the character-by-character block-comment scan with `indexOf("*/")`, which is behavior-identical for this stripper.
Each helper owns exactly one sub-grammar and returns a value — no shared mutable state survives the extraction.

### Design verification

- Tell-Don't-Ask / no reach-through: the dispatcher calls each helper with `(input, index)` and consumes the returned `ScanSegment`; helpers never mutate a shared bag.
- Behavior on data: each helper encapsulates one JSONC production and returns the consumed text plus resume index — genuine decomposition, not statement relocation.
- No new collaborator crosses a layer boundary; `design-review` is not applicable (no shared interface or wiring change — this is one self-contained pure function).
- ISP: helpers take primitives (`string`, `number`); no domain object carries unused fields.

### Edge cases (all behavior-preserving)

- `//` and `/*` inside a string: never seen by the dispatcher because `consumeString` consumes the whole literal first.
- Escaped quote inside a string (`"a\\"b"`): the `escaping` flag in `consumeString` prevents premature closing.
- Line comment with no trailing newline (EOF): body dropped, no newline emitted.
- Unterminated block comment / unterminated string: consumed to EOF, matching the original.
- Lone `/` (e.g. a JSON value like `"a/b"` outside-string division-looking text): emitted verbatim by the dispatcher's fall-through.
- Empty input: loop never runs, returns `""`.

## Module-Level Changes

| File                                | Change                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/config-loader.ts`              | Replace the body of `stripJsonComments` with the stateless dispatcher; add private `ScanSegment` interface and private `consumeLineComment`, `consumeBlockComment`, `consumeString` helpers (placed directly below `stripJsonComments` per the stepdown rule). No signature change, no export change. |
| `test/config-loader.test.ts`        | Add a dedicated `describe("stripJsonComments")` block importing `stripJsonComments` from `#src/config-loader`, with direct unit tests for every branch (see Test Impact). The existing `"strips JSONC comments before parsing"` integration case stays unchanged.                                     |
| `docs/architecture/architecture.md` | Mark Phase 2 Step 5 ([#290]) complete; drop `config-loader.ts` / `stripJsonComments` from the "Worst CRAP risk" line and the findings table (row 5); refresh the refactoring-target count and metrics if remeasured with `fallow`.                                                                    |

No barrel changes: `stripJsonComments` is already exported from `config-loader.ts` and re-exported nowhere; the two consumers import it directly.
A grep across `src/`, `test/`, and `.pi/skills/package-pi-permission-system/SKILL.md` confirms the only references to `stripJsonComments` are its definition and the two `JSON.parse(stripJsonComments(...))` call sites — no symbol is removed or renamed, so no skill or other doc update is needed.

## Test Impact Analysis

1. New unit tests enabled.
   `stripJsonComments` is exported but has never been unit-tested directly.
   The refactor is the occasion to pin its full contract with direct, fast, branch-level tests: line comment dropped (newline preserved), line comment at EOF (no newline), block comment dropped, unterminated block comment to EOF, `//` and `/*` inside a double- and single-quoted string preserved, escaped quote inside a string, unterminated string to EOF, lone `/` preserved, and a combined JSONC document (mirroring `config/config.example.json` style) round-tripping to valid JSON.
   These were always possible against the exported function but were never written; they become the behavior-preservation safety net.
2. Tests that become redundant.
   None are removed.
   The existing `"strips JSONC comments before parsing"` case in the `loadUnifiedConfig` suite now overlaps with the direct unit tests but retains integration value (it exercises the strip → `JSON.parse` → normalize path), and the issue requires it stay green unmodified.
3. Tests that must stay as-is.
   The `loadUnifiedConfig` / `loadAndMergeConfigs` suites and the `policy-loader.test.ts` suite exercise the two real call sites end-to-end; they remain the integration guard that the consume-helper refactor changed nothing observable.

## TDD Order

1. `test:` Add a `describe("stripJsonComments")` block to `test/config-loader.test.ts` (import `stripJsonComments` from `#src/config-loader`) covering every branch listed in Test Impact item 1.
   Green immediately — these assert the *current* exported behavior before any refactor, so they pass against today's implementation and lock the contract.
   Run `pnpm --filter @gotgenes/pi-permission-system exec vitest run test/config-loader.test.ts` to confirm.
   Commit: `test: add direct stripJsonComments unit tests`
2. `refactor:` Replace `stripJsonComments`'s body with the stateless dispatcher and add the private `ScanSegment` interface plus `consumeLineComment`, `consumeBlockComment`, and `consumeString` helpers.
   No signature or export change, so the two call sites are untouched.
   Green: the Step 1 unit tests and the existing `config-loader`/`policy-loader` suites all stay green without modification.
   Run `pnpm run check` (type-only changes are not caught by vitest's esbuild) and the full package suite (`pnpm --filter @gotgenes/pi-permission-system exec vitest run`).
   Commit: `refactor: model stripJsonComments as consume helpers`
3. `docs:` Update `docs/architecture/architecture.md` — mark Phase 2 Step 5 ([#290]) complete, remove `stripJsonComments` from the worst-CRAP-risk line and findings row 5, and refresh the target count / metrics if remeasured with `fallow health --targets`.
   Commit: `docs: mark Phase 2 step 5 complete in permission-system architecture`

## Risks and Mitigations

- Risk: a consume helper silently changes a drop/preserve boundary (e.g., emits or eats one extra character at a delimiter).
  Mitigation: Step 1 pins the exact contract — newline-preservation, EOF cases, and the closing-delimiter index — before the refactor; the helpers are written to match those assertions.
- Risk: replacing the character-by-character block-comment scan with `indexOf("*/")` differs on some input.
  Mitigation: the original drops everything between `/*` and the first `*/` (or EOF); `indexOf` finds exactly that first occurrence — behavior-identical, and the unterminated-block-comment test covers the EOF branch.
- Risk: the dispatcher checks comments before quotes and diverges from the original's `!inString` guard.
  Mitigation: `consumeString` consumes the entire literal on the opening quote, so the dispatcher is only ever at top level — the `//`-inside-string and `/*`-inside-string unit tests prove equivalence.
- Risk: a Biome/ESLint assertion loop.
  Mitigation: no type assertions are introduced; the dispatcher and helpers narrow on primitive comparisons.

## Open Questions

- Whether to fold the architecture-doc metric refresh (target count, health score) into Step 3 or defer it until a full Phase 2 re-measure.
  Resolve by running `fallow health --targets` after Step 2: if `stripJsonComments` has dropped off the target list (expected), update the count in Step 3; otherwise reassess the decomposition.

[#288]: https://github.com/gotgenes/pi-packages/issues/288
[#290]: https://github.com/gotgenes/pi-packages/issues/290
