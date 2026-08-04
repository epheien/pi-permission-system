---
issue: 387
issue_title: "pi-permission-system: clarify bash rule precedence for broad rules and exceptions"
---

# Clarify bash rule precedence for broad rules and exceptions

## Problem Statement

The bash-surface documentation contradicts itself and ships mis-ordered examples.
`docs/configuration.md` correctly states the model once — "Last matching rule wins within a single command — put broad catch-alls first, specific overrides after" — but a few lines later says "Use a more specific pattern before it to carve out exceptions," which is the opposite.
Every full example then orders the specific carve-outs (`git status`, `git diff`) *before* the broad `git *`, so under last-match-wins the broad `git *` rule wins and the carve-outs never take effect.
A user who copies the documented example expecting `git status` to be allowed will instead be asked, because the later `git *` rule overrides the earlier allows.

This is a documentation/example defect, not an evaluator defect.
The evaluator (`src/rule.ts`) deliberately resolves with `rules.findLast(...)` — last-match-wins — and this is a load-bearing, tested invariant across all surfaces (bash, path, mcp, skill).
Resolution direction was confirmed with the user: keep last-match-wins and fix the docs/examples (non-breaking).

## Goals

- Remove the contradictory "before it to carve out exceptions" wording so the docs state last-match-wins consistently.
- Reorder every bash example so the broad rule (`*` / `git *`) precedes the specific carve-outs (`git status`, `git diff`), making each example actually produce its intended exceptions.
- Keep all four config-surface artifacts aligned: `docs/configuration.md`, `config/config.example.json`, `schemas/permissions.schema.json`, and `README.md`.
- Non-breaking: no runtime, evaluator, schema-shape, or default-policy change.

## Non-Goals

- Do not change the evaluator's precedence model.
  Switching to most-specific-wins (the issue's rejected Option 2) is a breaking semantic change across every surface and is out of scope.
- Do not change any TypeScript source under `src/`, any loader, or any test.
- Do not change the schema's structure, field set, or validation rules — only the illustrative `examples`/`markdownDescription` example block within it.
- Do not touch the already-correct prose at `docs/configuration.md` line 188, the `path`-surface note around line 322, the "Restricted Bash Surface" example (already broad-first), or `README.md` line 87.

## Background

Relevant modules and artifacts:

- `src/rule.ts` — `evaluate()` resolves via `rules.findLast(...)`; the type doc on `Ruleset` reads "Later rules take priority (last-match-wins)."
  This is the authority; the docs must describe it, not contradict it.
- `src/wildcard-matcher.ts` — `wildcardMatch()` backs `*`/`?` semantics; unchanged.
- `docs/configuration.md` — the bash-surface section (`### bash Surface`) and several full config examples.
- `config/config.example.json` — the shipped example config; its `bash` block carries the mis-ordering.
- `schemas/permissions.schema.json` — an `examples`/`markdownDescription` JSON example carries the same mis-ordering; its prose `markdownDescription` (around line 120) already states broad-first correctly.
- `README.md` — line 87 already states "put broad catch-alls first and specific overrides after" (correct); line 18 is a feature bullet (correct).

Constraint from the package skill (AGENTS.md / `package-pi-permission-system`): "Keep schema, example config, `docs/configuration.md`, `README.md`, and TypeScript types/loaders aligned — changing one without the others is a bug."
This plan touches docs/config/schema examples only; types and loaders need no change, so alignment is satisfied by fixing all example sites together.

The package skill also records "pattern ordering is last-match-wins" as a core invariant — confirming Option 1 (docs fix) over Option 2 (evaluator change).

## Design Overview

The fix is editorial.
Two changes of kind:

1. Prose correction (one site): `docs/configuration.md` line ~202.
   Replace "Use a more specific pattern before it to carve out exceptions." with wording that matches last-match-wins, e.g.: "Place a more specific pattern *after* it to carve out exceptions — the later matching rule wins."

2. Example reordering (five sites): move the broad rule above its specific carve-outs so the later, more-specific rule wins.

Canonical corrected bash block (used where a surface-wide `*` is present):

```jsonc
"bash": {
  "*": "ask",
  "git *": "ask",
  "git status": "allow",
  "git diff": "allow",
  "rm -rf *": "deny"
}
```

Resolution trace under last-match-wins, confirming intent:

- `git status` → matches `*`, `git *`, and `git status`; last match is `git status` → **allow**.
- `git diff` → last match is `git diff` → **allow**.
- `git push` → last match is `git *` → **ask**.
- `rm -rf foo` → last match is `rm -rf *` → **deny**.

Design note on the `git *: ask` line in blocks that also have `*: ask`: the two have the same action, so `git *` is action-redundant with the surface-wide `*`.
It is retained deliberately because it is *pattern*-distinct: it demonstrates scoping a broad rule to a command family, which is the exact teaching point of "broad rule first, specific carve-out after."
This matches the user's confirmed Option 1 snippet.

For the minimal inline example that has no surface-wide `*` (configuration.md line ~61), use the two-line form directly:

```jsonc
"bash": { "git *": "ask", "git status": "allow" }
```

No type/interface changes; no code-fenced TS types apply (docs-only change).

## Module-Level Changes

No `src/` files change.
Documentation and config-example artifacts only:

- `docs/configuration.md`
  - Line ~61 (full `permission` example): reorder inline bash to `{ "git *": "ask", "git status": "allow" }`.
  - Line ~202 (prose): replace "before it to carve out exceptions" with the last-match-wins wording above.
  - Lines ~211–217 (bash example block): reorder to broad-first (`*`, `git *`, then `git status`, `git diff`, `rm -rf *`).
  - Lines ~443–444 (global agent YAML override): reorder to `git *: ask` then `git status: allow`.
- `config/config.example.json`
  - `bash` block (lines ~23–28): reorder to `*`, `git *`, `git status`, `git diff`.
- `schemas/permissions.schema.json`
  - The example JSON block (lines ~87–91): reorder its `bash` map to `*`, `git *`, `git status`, `git diff`.
- `README.md` — no change (lines 18 and 87 are already correct); verify only.

Grep sweep already performed for the affected example shape (`git status` / `git *` / "carve out" / "last-match") across `docs/configuration.md`, `README.md`, `config/`, and `schemas/`.
No occurrences exist under `src/`, `test/`, or `.pi/skills/package-pi-permission-system/SKILL.md` that need editing.
No `docs/architecture/` layout/metrics file references these example blocks.

## Test Impact Analysis

Not an extraction or refactor — no test surface changes.

- New tests enabled: none.
  The evaluator already encodes last-match-wins and is covered (e.g. existing `rule`/wildcard tests).
- Tests made redundant: none.
- Tests that must stay as-is: existing last-match-wins evaluator tests in `test/` remain the behavioral source of truth; this plan documents that behavior rather than altering it.
- No test references `config/config.example.json` or the schema example block (verified by grep), so reordering JSON keys cannot break a test.
  JSON object key order is semantically insignificant; schema validity is unaffected.

## Build Order

This is a docs/config-only change with no red→green test cycles — route to `/build-plan`, not `/tdd-plan`.
Land as a single reviewable commit (all example sites must agree to satisfy the alignment constraint).

1. Edit `docs/configuration.md`: fix the line ~202 prose and reorder the three bash examples (inline ~61, block ~211–217, agent YAML ~443–444).
2. Edit `config/config.example.json`: reorder the `bash` block to broad-first.
3. Edit `schemas/permissions.schema.json`: reorder the example `bash` block to broad-first.
4. Verify `README.md` needs no change (lines 18, 87 already correct).
5. Run `pnpm --filter @gotgenes/pi-permission-system run check` and `pnpm run lint:md` to confirm JSON validity and markdown lint pass.
   Re-grep for any remaining `git status` … `git *` (specific-before-broad) ordering to confirm none survive.
6. Commit: `docs: fix bash rule precedence examples and wording (#387)`.

(No `feat`/`fix` code change; the suggested commit type is `docs:`.
Non-breaking, so no `!` and no `BREAKING CHANGE:` footer.)

## Risks and Mitigations

- Risk: another example or doc still teaches specific-before-broad and slips through.
  Mitigation: the closing grep sweep (step 5) re-checks all surfaces; the inventory above is grep-derived, not memory-derived.
- Risk: reordering JSON keys breaks schema validation or an example-loading test.
  Mitigation: key order is JSON-insignificant; grep confirmed no test loads these artifacts.
  `pnpm run check` validates JSON parse.
- Risk: editing the schema's `examples` block accidentally touches schema structure.
  Mitigation: change is confined to values inside the example object; no `properties`/`required`/`type` edits.

## Open Questions

None.
Resolution direction (Option 1, docs-only, non-breaking) was confirmed with the user.
The retained-but-action-redundant `git *: ask` line is an intentional, documented pedagogical choice, not an open question.
