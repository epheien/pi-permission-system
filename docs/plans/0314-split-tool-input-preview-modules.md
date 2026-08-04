---
issue: 314
issue_title: "Split tool-input-preview.ts into cohesive modules"
---

# Split `tool-input-preview.ts` into cohesive modules

## Problem Statement

`src/tool-input-preview.ts` is the package's sole remaining `fallow` refactoring target: complexity density 0.33 (above the 0.3 threshold) with 6 dependents amplifying every change.
The module is a flat bag of 8 functions mixing three unrelated concerns — prompt formatting, text utilities, and serialization.
The density comes almost entirely from the prompt formatters (`formatEditInputForPrompt` in particular).
Separating the prompt-formatting concern into its own module gives that concern a clear home and lets the remaining utility module fall back under the density threshold.

## Goals

- Extract the three prompt formatters (`formatEditInputForPrompt`, `formatWriteInputForPrompt`, `formatReadInputForPrompt`) plus their shared `getPromptPath` helper into a new `src/tool-input-prompt-formatters.ts`.
- Keep `tool-input-preview.ts` as the home for the text utilities (`truncateInlineText`, `countTextLines`, `formatCount`), `serializeToolInputPreview`, and the three limit constants.
- Update every consumer to import from the new boundary; verify a consumer imports each new export so `fallow` does not flag a dead re-export.
- Behavior-preserving — every existing test stays green; no behavior moves.
- Drop `tool-input-preview.ts` below the 0.3 density threshold and off the refactoring-target list (targets 1 → 0).

## Non-Goals

- No renaming, signature change, or behavior change to any moved or retained function.
- No change to `ToolPreviewFormatter` (`tool-preview-formatter.ts`) beyond its import statements — its dispatch logic and methods are untouched.
- No change to the configurable-limit plumbing (`resolveToolPreviewLimits`, the constants' fallback role).
- The other Phase 3 roadmap steps (#315–#321) are independent follow-ups and are out of scope.

## Background

Relevant modules:

- `src/tool-input-preview.ts` — the target.
  Exports 3 constants + 8 functions.
  Imports `getNonEmptyString`, `toRecord` from `./common` and `safeJsonStringify` from `./logging`.
- `src/tool-preview-formatter.ts` — the `ToolPreviewFormatter` class (extracted in [#282]).
  Imports the three prompt formatters, `getPromptPath`, `serializeToolInputPreview`, `truncateInlineText`, and the three constants from `tool-input-preview.ts`.
  It calls the prompt formatters in its `formatToolInputForPrompt` dispatch switch and calls `getPromptPath` in `formatSearchInputForPrompt`.
- `src/builtin-tool-input-formatters.ts` — imports only `truncateInlineText` (a retained utility); no change.

Consumer audit (every importer of the four symbols being moved):

| Importer                               | Imports being moved                                                                                  | Action                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `src/tool-preview-formatter.ts`        | `formatEditInputForPrompt`, `formatWriteInputForPrompt`, `formatReadInputForPrompt`, `getPromptPath` | Repoint these four to the new module; keep `serializeToolInputPreview`, `truncateInlineText`, constants from `tool-input-preview` |
| `test/tool-input-preview.test.ts`      | `formatEditInputForPrompt`, `formatWriteInputForPrompt`, `formatReadInputForPrompt`, `getPromptPath` | Move these four describe blocks into the new sibling test file                                                                    |
| `src/builtin-tool-input-formatters.ts` | (none — only `truncateInlineText`)                                                                   | No change                                                                                                                         |
| `test/permission-prompts.test.ts`      | (none — only the 3 constants)                                                                        | No change                                                                                                                         |
| `test/tool-preview-formatter.test.ts`  | (none — only the 3 constants)                                                                        | No change                                                                                                                         |
| `test/handlers/gates/tool.test.ts`     | (none — only the 3 constants)                                                                        | No change                                                                                                                         |

Constraints from AGENTS.md and the package skill that apply:

- Within a package, import siblings via the `#src/` / `#test/` path aliases (test files), and `./` relative imports (production files, matching existing style in `tool-input-preview.ts` and `tool-preview-formatter.ts`).
- `@typescript-eslint/require-await` is on for `src/` — not relevant here (no async).
- When a step removes an export, every importing module and its tests break at the type level in the same commit — fold the extraction, the consumer update, and the consumer-test update into one step (lesson from the [#282] retro, which split extraction from consumer threading and found it unbuildable).
- When a module is moved/added, update `docs/architecture/` listings that reference it.

## Design Overview

This is a cohesion split by concern, not statement-level procedure-splitting: each moved function is already a complete, independently-tested pure function that returns a value, and the three prompt formatters + their shared `getPromptPath` helper form a single cohesive concern (rendering tool input for a permission prompt).

### New module: `src/tool-input-prompt-formatters.ts`

Holds the prompt-formatting concern.
The three formatters call `countTextLines` and `formatCount` (text utilities that stay in `tool-input-preview.ts`), and `getPromptPath` calls `getNonEmptyString` from `./common`.

```typescript
import { getNonEmptyString, toRecord } from "./common";
import { countTextLines, formatCount } from "./tool-input-preview";

export function getPromptPath(input: Record<string, unknown>): string | null { /* unchanged */ }
export function formatEditInputForPrompt(input: Record<string, unknown>): string { /* unchanged */ }
export function formatWriteInputForPrompt(input: Record<string, unknown>): string { /* unchanged */ }
export function formatReadInputForPrompt(input: Record<string, unknown>): string { /* unchanged */ }
```

Dependency direction: `tool-input-prompt-formatters.ts` → `tool-input-preview.ts` (one-way; the utilities have no knowledge of the formatters).
No cycle: `tool-input-preview.ts` will no longer reference any prompt formatter after the move.

### Retained module: `src/tool-input-preview.ts`

After the move it holds only the text utilities, serialization, and constants.
Its `./common` import drops to nothing — `getNonEmptyString` was used only by `getPromptPath` and `toRecord` only by `formatEditInputForPrompt`, both of which move out.
Only the `safeJsonStringify` import from `./logging` (used by `serializeToolInputPreview`) remains.

```typescript
import { safeJsonStringify } from "./logging";

export const TOOL_INPUT_PREVIEW_MAX_LENGTH = 200;
export const TOOL_INPUT_LOG_PREVIEW_MAX_LENGTH = 1000;
export const TOOL_TEXT_SUMMARY_MAX_LENGTH = 80;

export function truncateInlineText(value: string, maxLength: number): string { /* unchanged */ }
export function countTextLines(value: string): number { /* unchanged */ }
export function formatCount(value: number, singular: string, plural: string): string { /* unchanged */ }
export function serializeToolInputPreview(input: unknown): string { /* unchanged */ }
```

### Consumer call site (`tool-preview-formatter.ts`)

The class's dispatch and search-formatting call sites are unchanged; only the import source changes.

```typescript
// imports split across two modules:
import { serializeToolInputPreview, truncateInlineText,
  TOOL_INPUT_LOG_PREVIEW_MAX_LENGTH, TOOL_INPUT_PREVIEW_MAX_LENGTH,
  TOOL_TEXT_SUMMARY_MAX_LENGTH } from "./tool-input-preview";
import { formatEditInputForPrompt, formatReadInputForPrompt,
  formatWriteInputForPrompt, getPromptPath } from "./tool-input-prompt-formatters";
```

This follows Tell-Don't-Ask and the Law of Demeter trivially — the consumer calls free functions with the data they need and uses the returned string.
No new collaborator, no output argument, no reach-through is introduced.

### Dead-re-export check

All four new exports (`getPromptPath`, `formatEditInputForPrompt`, `formatWriteInputForPrompt`, `formatReadInputForPrompt`) are imported by `tool-preview-formatter.ts`, so `fallow` will see a live consumer for each.
No barrel (`index.ts`) re-exports these symbols — `src/index.ts` does not reference `tool-input-preview`, so no barrel update is needed.

### Edge cases

- No behavior changes, so no new edge cases.
  The moved functions' existing edge-case tests (empty edits, missing path, CR/LF/CRLF line counting, offset/limit absence) move with them verbatim.

## Module-Level Changes

| File                                        | Change                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tool-input-prompt-formatters.ts`       | **New.** Add `getPromptPath`, `formatEditInputForPrompt`, `formatWriteInputForPrompt`, `formatReadInputForPrompt` (verbatim). Import `getNonEmptyString`, `toRecord` from `./common` and `countTextLines`, `formatCount` from `./tool-input-preview`.                                           |
| `src/tool-input-preview.ts`                 | Remove the four moved functions. Change the `./common` import line — drop `getNonEmptyString` and `toRecord` (now unused here); keep only `import { safeJsonStringify } from "./logging"`.                                                                                                      |
| `src/tool-preview-formatter.ts`             | Split the import: keep `serializeToolInputPreview`, `truncateInlineText`, and the three constants from `./tool-input-preview`; move `formatEditInputForPrompt`, `formatReadInputForPrompt`, `formatWriteInputForPrompt`, `getPromptPath` to a new import from `./tool-input-prompt-formatters`. |
| `test/tool-input-prompt-formatters.test.ts` | **New.** Move the `getPromptPath`, `formatEditInputForPrompt`, `formatWriteInputForPrompt`, `formatReadInputForPrompt` describe blocks here, importing from `#src/tool-input-prompt-formatters`. No `vi.mock("../src/logging.js")` needed (these functions never serialize).                    |
| `test/tool-input-preview.test.ts`           | Remove the four moved describe blocks and their imports. Keep `constants`, `truncateInlineText`, `countTextLines`, `formatCount`, `serializeToolInputPreview` blocks and the `logging` mock.                                                                                                    |
| `docs/architecture/architecture.md`         | Module listing (~line 537): add `tool-input-prompt-formatters.ts` entry, refine `tool-input-preview.ts` description. Health table (~line 769): `Refactoring targets` 1 (medium) → 0. Finding #2 (~line 782): mark resolved. Roadmap step 1 (~line 790): mark ✅ shipped.                        |
| `docs/architecture/v3-architecture.md`      | Module listing (~line 67): add `tool-input-prompt-formatters.ts`; refine `tool-input-preview.ts` description.                                                                                                                                                                                   |

The pre-[#266] finding block (~lines 580–600) is a historical snapshot of a completed phase — leave it as-is.

## Test Impact Analysis

1. New unit tests the extraction enables: none.
   The three prompt formatters and `getPromptPath` are already exported pure functions with direct unit coverage in `tool-input-preview.test.ts`.
   The extraction relocates that coverage into a sibling test file matching the new module boundary; it does not unlock previously-impractical tests.
2. Tests that become redundant: none.
   No higher-level test duplicates the moved functions' coverage; the moved describe blocks remain the sole coverage and simply change file.
3. Tests that must stay as-is: the retained blocks in `tool-input-preview.test.ts` (`constants`, `truncateInlineText`, `countTextLines`, `formatCount`, `serializeToolInputPreview`) genuinely exercise the utilities staying in that module — they stay verbatim with the `logging` mock intact.

## TDD Order

This is behavior-preserving.
Because removing the four exports from `tool-input-preview.ts` breaks `tool-preview-formatter.ts` and `tool-input-preview.test.ts` at the type level in the same commit, the extraction, the consumer update, and both test-file edits must land together (the [#282] retro lesson).
No new red test is written — the existing suite is the regression net.

1. `refactor:` — Create `src/tool-input-prompt-formatters.ts` with the four functions; remove them from `tool-input-preview.ts` and drop its now-unused `./common` import; repoint `tool-preview-formatter.ts` imports; create `test/tool-input-prompt-formatters.test.ts` with the four moved describe blocks and trim them out of `test/tool-input-preview.test.ts`.
   Test surface: `test/tool-input-prompt-formatters.test.ts` (relocated coverage) + the trimmed `test/tool-input-preview.test.ts`; the full suite stays green.
   Verify with `pnpm --filter @gotgenes/pi-permission-system run check` and `... run test`.
   Commit: `refactor: split prompt formatters into tool-input-prompt-formatters (#314)`

2. `docs:` — Update `docs/architecture/architecture.md` (module listing, health table `Refactoring targets` 1 → 0, finding #2 resolved, roadmap step 1 ✅) and `docs/architecture/v3-architecture.md` (module listing).
   Optionally re-run `fallow health --targets` to confirm 0 targets and cite the figure.
   Commit: `docs: record tool-input-preview split in architecture (#314)`

## Risks and Mitigations

- Risk: a missed importer of a moved symbol breaks the build.
  Mitigation: the consumer audit table above is exhaustive (grep of `src/` and `test/` for all four symbols); removing the exports makes TypeScript flag any miss immediately in step 1, and `pnpm run check` runs before commit.
- Risk: `fallow` flags a new module export as a dead re-export.
  Mitigation: all four new exports are consumed by `tool-preview-formatter.ts`; no speculative re-exports are added and no barrel re-exports them.
- Risk: density does not fall below 0.3 after the split.
  Mitigation: `formatEditInputForPrompt` (the dominant contributor) moves out, so the retained module is four small utilities + constants; step 2 re-runs `fallow health --targets` to confirm targets 1 → 0 before recording the outcome.
- Risk: introduced import cycle between the two modules.
  Mitigation: dependency is strictly one-way (`tool-input-prompt-formatters.ts` → `tool-input-preview.ts`); the utility module references no formatter after the move.

## Open Questions

- None.
  The proposed change is unambiguous and behavior-preserving.

[#266]: https://github.com/gotgenes/pi-packages/issues/266
[#282]: https://github.com/gotgenes/pi-packages/issues/282
