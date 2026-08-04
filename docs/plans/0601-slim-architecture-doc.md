---
issue: 601
issue_title: "pi-permission-system: slim architecture.md to current state and open targets"
---

# Slim architecture.md to current state and open targets

## Release Recommendation

**Release:** ship independently

This is a standalone docs-only cleanup, not a numbered roadmap step — `grep 601 architecture.md` finds no `(#601)`/`[#601]` step reference, and the issue itself notes it is "independent of the Phase 12 tracks and schedulable any time."
It has no batch.
In practice this commit cuts no release at all: `packages/pi-permission-system/docs/architecture` is a `release-please-config.json` `exclude-paths` entry, and the one non-doc touch (the `.pi/skills/package-pi-permission-system/SKILL.md` regrowth guard) is a repo-level file in no package.
So "ship independently" here means "land on `main`; nothing to release."

## Problem Statement

`packages/pi-permission-system/docs/architecture/architecture.md` has grown to 1213 lines by accreting four distinct roles — current design, target direction, active-phase workspace, and history — with history recorded three times over (the `### Phase N` prose paragraphs, the `## Improvement roadmap — Phase N (complete)` summaries, and the `history/phase-N-*.md` files all say the same thing).
The signal-to-history ratio keeps dropping: Phase 12 planning needed three 50KB reads to load the doc, the `Target: the authority model` section narrates shipped Phase 8–9 machinery as if still pending, and module-tree entries carry long issue-provenance trails that belong in git log and the history files.
The goal is to slim the document to roughly 750 lines so it serves its two real audiences — how the system currently works, and the genuinely open target directions — and to add a regrowth guard so per-change doc-update commits do not re-inflate it.

## Goals

- Delete the `### Phase 1–11` prose paragraphs under `Refactoring history`; keep the phase table (theme + history-file link) as the index.
- Rename `## Target: the authority model` to `## The authority model` and fold its shipped parts into current-state prose; keep the still-open direction material in full.
- Strip issue-provenance archaeology from the module-structure tree, keeping only refs that encode an active constraint.
- Trim pseudo-code that merely restates source (`normalizeFlatConfig()`, the two-phase-checking snippets) down to a sentence plus a pointer.
- Add a regrowth guard to the `package-pi-permission-system` skill so the tree is not re-inflated by future per-change commits.
- Prune reference-link definitions orphaned by the cuts, and verify every remaining `[#N]` reference resolves to a definition and every definition is referenced.
- Preserve all content the tooling and `/plan-improvements` depend on (see Non-Goals).

This change is **not breaking** — it alters no code, config, default, output shape, or public API; it is prose in a release-excluded doc plus one skill file.

## Non-Goals

- Do **not** cut the `## Improvement roadmap — Phase N (complete)` summary chain — the `/plan-improvements` Step 1 hard gate greps for it.
- Do **not** cut the active Phase 12 roadmap (`## Improvement roadmap — Phase 12: …` and its Steps/diagram/batches).
- Do **not** rewrite the `history/phase-N-*.md` files — they are the canonical per-phase record and are unchanged.
- Do **not** update anchors in frozen point-in-time records (`docs/plans/0555-*.md`, `0558-*.md`, `docs/architecture/history/phase-8/9/10-*.md`) that link `#target-the-authority-model`; these are historical documents whose links describe the doc as it stood at the time (see Risks for the rationale and the one live-doc exception that **is** updated).
- Do not touch any `src/` or `test/` file — no code, schema, or config changes.
- Do **not** touch `packages/pi-subagents/docs/architecture/architecture.md` (1265 lines, the same debt) — its bulk prune is the sibling issue #605.
- Do **not** change the `/finish-phase` prompt or lift the regrowth guard beyond this package's skill — the ongoing-prevention mechanism (extend `/finish-phase`) and the shared-convention generalization are follow-ups #606 and #607 (see Open Questions).
- No hard 750-line contract: 750 is the issue's rough target, not a gate.
  The gates are zero information loss, a lint-clean link graph, and the preserved sections above.

## Background

Relevant structure of `architecture.md` (heading line numbers as of this plan):

- `## Config format` (228) → `### Normalization to Rule[]` (249) — carries the `normalizeFlatConfig()` snippet (lines ~251–270).
- `## Two-phase checking` (381) → `### Phase 1` (383, `shouldExposeTool` snippet) / `### Phase 2` (394, the `normalizeInput`/`evaluate` snippet).
- `## Target: the authority model` (494–731, ~238 lines) — the section to rename and fold.
  Subsections: `### Why this is worth doing` (501), `### The spine` (521), `### Authority lives in three places` (533), `### The Authorizer role` (547), `### The recursion` (571), `### What it consolidates` (578), `### yolo is recorded authority` (588), `### Discriminating delegation: a model Authorizer` (604), `### Resolved direction` (644), `### Remaining design work` (666), `### Beyond the target: …classifier` (679), `### Beyond the target: …escalation seam` (692), `### Naming` (723).
- `## Module structure` (732–865) — the ~130-line tree with per-entry provenance trails.
- `## Improvement roadmap — Phase 12` (866–1008) — active, keep in full.
- `## Improvement roadmap — Phase 7–11 (complete)` (1010–1057) — the summary chain, keep.
- `## Refactoring history` (1059) — a phase table (1063–1076) then `### Phase 1`–`### Phase 11` prose (1078–1132, ~55 lines) to delete.
- Reference-link definitions (1134–1212).

Constraints from AGENTS.md and the package skill that apply:

- Markdown is one-sentence-per-line; long-lived docs use reference-style `[#N]` links; MD053 rejects an unused `[#N]:` definition; the enforcer is `rumdl` via `pnpm run lint` (also `pnpm exec rumdl check <file>`).
- `architecture.md` inline-copies the core `rule.ts` types (`Rule`, `RuleOrigin`, `Ruleset`) — those listings are current-state reference and stay untouched.
- When reworking documented prose (not removing a symbol), grep `.pi/skills/package-*/SKILL.md` for the mechanism name — reworded prose carries no removed symbol to match.
- Renaming a heading changes its GitHub anchor slug; every in-repo `#old-anchor` link to it must be re-pointed or accepted as historical.

## Design Overview

Five content operations plus a link-graph sweep, each a separate `docs:` commit for reviewability.
No code, so no data shapes change; the design decisions are editorial boundaries.

### 1. Refactoring-history prose deletion (issue proposed-change 1)

Delete the `### Phase 1` … `### Phase 11` paragraphs (lines ~1078–1132), keeping the `## Refactoring history` heading, its one-paragraph lede, and the phase table.
Zero information loss: each deleted paragraph is a near-verbatim duplicate of the matching `## Improvement roadmap — Phase N (complete)` summary (which survives) and the `history/phase-N-*.md` file (unchanged).
The table's history-file links remain the index into the detail.

### 2. Fold `Target: the authority model` → `The authority model` (issue proposed-change 2)

Rename the heading `## Target: the authority model` → `## The authority model`.
Then, per the issue:

- **Cut** the opening meta-paragraphs that frame it as "now current state, not merely a target" and narrate what landed in which Phase 9 step — replace with one current-state sentence.
- **Cut** `### Why this is worth doing` entirely, leaving one line plus a link to `history/phase-9-authorizer-spine.md`.
- **Cut** `### What it consolidates` — it describes dissolved machinery (`GatePrompter`, `PromptingGateway`, `canConfirm()`) that no longer exists.
- **Compress** the four `### Resolved direction` points to one line each (they are shipped; the detail lives in the phase-9 history and the `0557`/`0558` plans).

**Keep in full** (still-open or still-explanatory material): `### The spine`, `### Authority lives in three places` (the three-lifetimes model), `### The recursion`, `### yolo is recorded authority`, `### Discriminating delegation: a model Authorizer`, `### Remaining design work`, both `### Beyond the target:` sections, and `### Naming`.

Anchor fallout (the rename changes `#target-the-authority-model` → `#the-authority-model`):

- **Update** the two surviving in-file links (in the `## Improvement roadmap — Phase 9 (complete)` and `Phase 8 (complete)` summaries, lines ~1032 and ~1043).
- **Update** the one live sibling architecture doc: `docs/architecture/permission-prompter.md` line 11.
- The other two in-file links (lines ~1115, ~1120) live inside the `### Phase 8`/`### Phase 9` prose being **deleted** in operation 1 — no update needed.
- Frozen records keep their stale anchor (see Non-Goals / Risks).

Sub-anchors referenced elsewhere are preserved because their headings are kept: `#resolved-direction` (linked from `0558` plan), `#remaining-design-work` (linked from `history/phase-10`), `#beyond-the-target-a-non-deterministic-access-intent-classifier`, `#discriminating-delegation-a-model-authorizer`, `#the-recursion`.

### 3. Strip module-tree provenance archaeology (issue proposed-change 3)

Each `src/` tree entry keeps one or two lines describing what the module **is now**; drop the "relocated #559, dissolved #505, renamed #510…" issue trails.
Example target: the `path-normalizer.ts` entry (~15 lines of provenance) collapses to a 1–2 line description of its current role.

**Exception — keep refs that encode an active constraint** (these are rules, not history):

- `permission-manager.ts` must not import `AccessPath` — the ADR 0002 string boundary, lint-guarded (`no-restricted-imports`).
- The `rule.ts`/`path/path-flavor.ts` note that a single module holds the package's only `=== "win32"` comparison (a structural invariant).
- Any ref whose removal would drop a currently-true "must / only / never" rule a maintainer needs.

This is prose-rework, not symbol removal, so no `src/`-symbol grep applies; the edit is confined to the `## Module structure` fenced block.

### 4. Trim source-restating pseudo-code (issue proposed-change 4)

- `### Normalization to Rule[]`: replace the `normalizeFlatConfig()` TypeScript snippet with a sentence describing the string-shorthand/object expansion and a pointer to `src/normalize.ts`.
- `## Two-phase checking`: replace the `shouldExposeTool()` (Phase 1) and the `normalizeInput`/`evaluate` (Phase 2) snippets with a sentence each plus pointers (`before-agent-start.ts` / the gate pipeline).
  Keep the surrounding prose that explains *why* two phases exist — only the code that duplicates source is cut.

Leave the Mermaid diagrams (MCP candidate loop, session-approval sequence) — they show control flow the prose does not, and are not source restatements.

### 5. Skill regrowth guard (issue proposed-change 5)

Add a short rule to `.pi/skills/package-pi-permission-system/SKILL.md`, near the existing `docs/architecture/architecture.md` guidance (the "inline-copies the core `rule.ts` types" bullet / the roadmap `✅`-marking paragraph): module-tree entries describe **current behavior**; cite an issue **only** when it encodes an active constraint; provenance goes to `history/`.
Without this, the per-change doc-update commits that the skill already mandates would re-inflate the tree the way this issue is undoing.

### 6. Link-graph sweep

After operations 1–4, some `[#N]:` definitions lose their last `[#N]` reference (e.g. issue numbers cited only in deleted history prose or stripped module-tree trails).
`rumdl` (MD053) flags an orphaned definition but **not** a missing one, so the sweep is two-directional:

- Run `pnpm exec rumdl check` (or `pnpm run lint`) and delete every flagged orphan definition.
- Manually verify the reverse: every `[#N]` reference in the body still has a `[#N]:` definition (`grep -oE '\[#[0-9]+\]' | sort -u` against the definition list).

Do **not** delete a definition still referenced by surviving prose (the kept `### Beyond the target` / `### Remaining design work` sections cite many issues).

## Module-Level Changes

- `packages/pi-permission-system/docs/architecture/architecture.md` — the five content operations above plus the link-definition prune; net ~1213 → ~750 lines (soft target).
- `packages/pi-permission-system/docs/architecture/permission-prompter.md` — re-point the one `architecture.md#target-the-authority-model` link (line 11) to `#the-authority-model`.
- `.pi/skills/package-pi-permission-system/SKILL.md` — add the module-tree regrowth-guard rule.

Grep evidence that the anchor-rename touch points are complete (run at plan time):

- In-file `#target-the-authority-model`: 4 hits — 2 survive (update), 2 are inside deleted prose.
- Cross-file live doc: `docs/architecture/permission-prompter.md` (update).
- Cross-file frozen: `docs/plans/0555`, `docs/plans/0558`, `docs/architecture/history/phase-8/9/10` — left as historical (Non-Goals).

No `src/`, `test/`, schema, example-config, `README.md`, `docs/configuration.md`, or `docs/decisions/` file is touched — none references the slimmed prose by a removed symbol (verified: the cuts remove no exported name, only duplicated narrative and provenance trails).

## Test Impact Analysis

Not applicable — docs-only.
No unit tests exist for or against prose content; the only automated gate is `pnpm run lint` (`rumdl` MD053 for the link graph, plus the markdown style rules).
There is no code behavior to pin, so no test is added, removed, or made redundant.

## Invariants at risk

- **`/plan-improvements` Step 1 gate** — greps for the `## Improvement roadmap — Phase N (complete)` summary chain.
  Mitigation: that chain is an explicit Non-Goal; the cuts touch only the `### Phase N` *duplicate* prose under `Refactoring history`, not the summaries.
- **Reference-link integrity (MD053)** — a stale/orphaned `[#N]:` fails `pnpm run lint`.
  Mitigation: operation 6 is the dedicated sweep, and the lint run at build-completion verifies it.
- **Cross-reference anchors** — the `#resolved-direction`, `#remaining-design-work`, and `#beyond-the-target-*` sub-anchors are linked from surviving docs; their headings are kept, so the anchors are stable.
- **Active-constraint refs in the module tree** — dropping the ADR 0002 string-boundary note or the win32-comparison invariant would erase a live rule.
  Mitigation: operation 3's explicit keep-list.

## Build Order

Docs-only — no red→green cycles.
Each step is one reviewable `docs:` commit; ordering puts content cuts before the link sweep so the sweep sees the final reference set.

1. **Delete `### Phase 1–11` refactoring-history prose** (issue change 1).
   Keep the `## Refactoring history` heading, lede, and phase table.
   Commit: `docs(pi-permission-system): drop duplicated refactoring-history prose (#601)`.
2. **Fold and rename `Target: the authority model` → `The authority model`** (issue change 2).
   Cut `Why this is worth doing` / `What it consolidates`, compress `Resolved direction`, keep the open-direction subsections; update the two surviving in-file anchor links and `permission-prompter.md` line 11.
   Commit: `docs(pi-permission-system): fold shipped authority-model prose into current state (#601)`.
3. **Strip module-tree provenance archaeology** (issue change 3), keeping the active-constraint refs on the keep-list.
   Commit: `docs(pi-permission-system): strip issue-provenance trails from module tree (#601)`.
4. **Trim source-restating pseudo-code** (issue change 4): `normalizeFlatConfig()` and the two-phase snippets → sentence + pointer.
   Commit: `docs(pi-permission-system): replace source-restating snippets with pointers (#601)`.
5. **Add the skill regrowth guard** (issue change 5) to `package-pi-permission-system/SKILL.md`.
   Commit: `docs(pi-permission-system): guard module-tree regrowth in package skill (#601)`.
6. **Link-graph sweep**: prune orphaned `[#N]:` definitions, verify no missing references, run `pnpm exec rumdl check` on the doc.
   Commit: `docs(pi-permission-system): prune orphaned link definitions after slim (#601)`.

Steps 1–4 may be reordered freely (they touch disjoint regions); step 5 is independent (a different file); step 6 must run last so it sees the final reference set.
If the operator prefers fewer commits, steps 1–4 can collapse into one — but the link sweep (6) must stay separate so a `rumdl` failure is attributable.

## Risks and Mitigations

- **Information loss during the fold.**
  Risk: cutting `Why this is worth doing` / `What it consolidates` drops a rationale a future reader wants.
  Mitigation: the cut material is preserved verbatim in `history/phase-9-authorizer-spine.md` and the `0555`–`0558` plans; the fold leaves a one-line pointer to the phase-9 history.
- **Broken anchors in frozen records.**
  Risk: renaming the heading strands `#target-the-authority-model` links in `history/` and old plans.
  Mitigation: those are point-in-time records — a link describing the doc as it stood is acceptable, and rewriting frozen history is itself a Non-Goal.
  The two *live* references (in-file survivors + `permission-prompter.md`) are updated.
  Accepting the historical staleness is the deliberate trade the issue's rename asks for.
- **Over-cutting a gate-relevant section.**
  Risk: trimming too aggressively removes the `## Improvement roadmap — Phase N (complete)` chain the `/plan-improvements` gate needs.
  Mitigation: the Non-Goals list fences it explicitly, and each cut is a scoped edit to a named region, not a bulk deletion.
- **Silent missing link reference.**
  Risk: `rumdl` catches orphaned definitions but not a `[#N]` with no definition.
  Mitigation: operation 6's manual reverse-grep check.
- **750-line target pressure.**
  Risk: chasing the number invites over-cutting.
  Mitigation: the plan treats 750 as a soft target and prioritizes the zero-information-loss and keep-list gates over the count.

## Open Questions

The issue's proposed change is concrete and operator-authored, so the scope of #601 itself has no open questions.

One broader question was raised during planning — how to *maintain* the architecture docs so this debt does not re-accrete, and that pi-subagents carries the same debt.
Resolved with the operator and split into three follow-ups (filed during this session, kept out of #601's scope):

- **#605** — pi-subagents bulk prune (sibling of #601: apply this playbook to `packages/pi-subagents/docs/architecture/architecture.md`, 1265 lines).
- **#606** — extend `/finish-phase` with a bounded doc-hygiene step (stop emitting the duplicate `### Phase N` prose it currently produces, strip provenance from touched module-tree entries, re-frame `Target:`→current).
  This is the agreed *ongoing-prevention* mechanism; `/plan-improvements` was rejected as the home because it is the read-cost *consumer*, and its discipline is code structure, not doc hygiene.
- **#607** — generalize #601's package-skill regrowth guard into a shared convention (`AGENTS.md` + the `/finish-phase` step) so it governs every package, not just this one.
