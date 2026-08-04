---
issue: 437
issue_title: "pkg:pi-permission-system — system-prompt-sanitizer strips the entire Available tools section from the wire prompt"
---

# Narrow the Available tools section instead of stripping it

## Release Recommendation

**Release:** ship independently

Issue [#437] is a standalone bug fix; it is not a step in the `docs/architecture/architecture.md` improvement roadmap (no `Release:` annotation references it), so it ships on its own.

## Problem Statement

`AgentPrepHandler.handle()` (`src/handlers/before-agent-start.ts`) runs `sanitizeAvailableToolsSection()` over the system prompt on every `before_agent_start` and returns the result as a `{ systemPrompt }` override.
That sanitizer **deletes the entire `Available tools:` section** (`src/system-prompt-sanitizer.ts:215`, via `removeLineSection` — `allowedToolNames` is never consulted for that section), so the wire prompt lists no tools at all.
The package's own docs state the intended behavior as *"The `Available tools:` system prompt section is rewritten to **match** the filtered active tool set"* (`docs/configuration.md:644`) — narrow, not delete.

The fix is to **narrow** the section to the allowed tools (keep allowed-tool lines, drop denied ones) rather than removing it wholesale, and to make the returned override **byte-stable across turns** so it does not thrash the provider's prompt cache.

This plan is the product of a deep source investigation that also disproved the original retirement hypothesis; see Background for the verified Pi lifecycle facts that shape the design.

## Goals

- Replace the wholesale `Available tools:` deletion with per-line narrowing: keep the lines for allowed tools, drop the lines for denied/inactive tools, and preserve non-tool boilerplate.
- Keep the existing per-tool `Guidelines:` filtering and the `<available_skills>` skill filtering unchanged in intent.
- Make `AgentPrepHandler`'s returned `systemPrompt` **byte-identical across turns** for a stable policy/agent, so the provider prompt cache (tools + system prefix) is reused rather than rewritten each turn.
- Remove the per-turn memoization gates (`activeToolsGate`, `promptStateGate`, and the now-orphaned `CacheKeyGate`): the override must be recomputed and returned every turn, and the gates' "return `{}` on a cache hit" semantics actively reset Pi's base prompt to a skill-**unfiltered** state (a latent skill-leak).
- **Breaking change.**
  On upgrade the wire system prompt changes: the `Available tools:` section reappears (now narrowed to the active set) where it was previously absent.
  Ship as `fix!:` with a `BREAKING CHANGE:` footer.

## Non-Goals

- No change to the **function-calling schema** narrowing (`setActive` / restrict-only active set from [#385]) — that stays exactly as is; this plan only fixes the **prose** listing and the override lifecycle.
- No upstream Pi change.
  The fully-frozen end-state (return `{}` forever and let Pi assemble one correct, skill-excluded prompt) would require a Pi skill-exclusion hook and a live system-prompt getter, neither of which exists today (see Open Questions).
- No rename of `sanitizeAvailableToolsSection` or its module file — the export name and `system-prompt-sanitizer.ts` stay; only the section-handling behavior changes.
- No change to skill-prompt sanitization logic (`skill-prompt-sanitizer.ts`) — it already edits the disjoint `<available_skills>` block and is re-pointed at the narrowed prompt unchanged.

## Background

### Verified Pi lifecycle (`@earendil-works/pi-coding-agent@0.79.1`)

The investigation confirmed these facts by reading the compiled SDK; they constrain the design.

- `before_agent_start` fires with `event.systemPrompt = agentSession._baseSystemPrompt` as a **by-value string snapshot** (`agent-session.js:796`).
- `setActive(names)` → `setActiveToolsByName` (`agent-session.js:543`) narrows the callable tool schema **and** rebuilds `_baseSystemPrompt` / `agent.state.systemPrompt` to a correctly-narrowed `Available tools:` + `Guidelines:` section.
  So Pi already knows how to narrow the prose — but the result is **not readable inside the handler**.
- Returning `{ systemPrompt }` **replaces** `agent.state.systemPrompt` for the turn (`agent-session.js:812`); when the handler returns no override, Pi resets `agent.state.systemPrompt = _baseSystemPrompt` (`agent-session.js:810-817`).
- There is **no `getSystemPrompt` on `ExtensionAPI`** (the `pi` the factory receives — `loader.js:149` api object and the type both lack it); the only `getSystemPrompt` is on the per-event `ctx`, which `before_agent_start` overrides to the **stale** pre-rebuild snapshot (`runner.js:749`).
  Therefore the handler cannot read Pi's freshly-rebuilt prompt to layer skill filtering on top — which is why the originally-planned "retire the sanitizer, read via `pi.getSystemPrompt()`" approach is not viable.
- `ToolInfo` (`getAllTools()` / `getActiveTools()`) omits `promptSnippet` (`types.d.ts:1060`), so we cannot **regenerate** Pi's exact tool lines — but we can **line-filter** the lines Pi already rendered into `event.systemPrompt`.

### Why narrowing (not deleting, not retiring) is the chosen fix

Skill filtering removes `<available_skills>` entries, which can only be done by returning a `systemPrompt` override — and any override replaces Pi's tool-prose rebuild for that turn.
So the override we return must itself carry the narrowed tool prose.
We obtain it by line-filtering `event.systemPrompt` (Option B from the issue discussion), which is the only in-extension way to be correct **and** cache-stable from the first turn.

### Byte-stability argument (the cache invariant)

The provider caches the request prefix (tools block → system prompt → messages); a byte change rewrites the cache from that point.
The override is computed as `narrow(event.systemPrompt, allowed)` then skill-filtered.
It is byte-stable across turns because:

- `event.systemPrompt`'s **non-tool** regions (base instructions, `<available_skills>`) do not depend on the active tool set, so they are identical every turn.
- The **tool** regions differ across turns only in which tool lines are present (turn 1 = Pi defaults; turn 2+ = Pi's prior-turn narrowing), but `narrow(..., allowed)` keeps exactly the allowed-tool lines either way, and a given tool's line is the same `promptSnippet` string regardless of the active set.
- `narrow` is therefore idempotent and deterministic from the (stable) allowed set, so `narrow(defaultProse, allowed) === narrow(narrowedProse, allowed)`.

Result: turn 1 and turn 2+ produce the identical override → the prefix is frozen from turn 1.

### Why the memoization gates must go

`AgentPrepHandler` currently wraps the prompt computation in `promptStateGate.runIfChanged(key, …)` and `return promptResult ?? {}`.
`CacheKeyGate.runIfChanged` returns `undefined` on an unchanged key (`cache-key-gate.ts:21`), so a cache hit yields `{}` → Pi resets `agent.state.systemPrompt` to `_baseSystemPrompt`, which has **narrowed tools but unfiltered skills** — a per-turn skill leak whenever the key repeats.
The fix requires the override to be **recomputed and returned every turn**, which defeats both gates; with the override now cheap and byte-stable, the gates earn nothing and `CacheKeyGate` becomes dead.

### Constraints from AGENTS.md / package skill

- Restrict-only active set ([#385]) is preserved — the allowed set is still `getActive()` minus denied (`src/handlers/before-agent-start.ts:59`).
- Keep schema/example/docs/types aligned: this change touches no config field, but it does touch `docs/configuration.md` Pi-integration-hooks wording.
- `@typescript-eslint/require-await` is enabled for `src/`; `handle` stays `async` with its existing `eslint-disable` line.

## Design Overview

### Narrowing the `Available tools:` section

`sanitizeAvailableToolsSection(systemPrompt, allowedToolNames)` keeps its signature and result shape (`{ prompt, removed }`).
Only the `Available tools:` branch changes — from "delete the section" to "keep allowed-tool lines":

```typescript
// within the located "Available tools:" section body:
const keptBody = body.filter((line) => {
  const toolName = extractToolBulletName(line); // "- read: …" -> "read"; null for non-bullet/prose
  if (toolName === null) return true;           // keep headers, blanks, boilerplate prose
  return allowedTools.has(toolName);            // keep allowed tool lines, drop denied ones
});
// if no tool bullets survive, drop the whole section (header + body); otherwise keep header + keptBody
```

- `extractToolBulletName(line)`: matches `^\s*-\s+([A-Za-z0-9_-]+):` and returns the captured name, else `null`.
  Inside the `Available tools:` section, `- name:` bullets are tool lines; non-bullet lines (the `In addition to the tools above…` boilerplate, blanks) are preserved.
- The existing `sanitizeGuidelinesSection` (per-tool `Guidelines:` filtering) is unchanged — it already keeps only the guidelines for allowed tools and was never the bug.
- `removeLineSection` loses its only caller and is removed; the "no tools allowed" edge inlines the header+body drop.

### Handler flow (gates removed)

`AgentPrepHandler.handle` becomes a straight-line, recompute-every-turn flow:

```typescript
this.session.activate(ctx);
this.session.refreshConfig(ctx);
const agentName = this.session.resolveAgentName(ctx, event.systemPrompt);

const allowedTools = activeToolsAllowedBy(this.resolver, agentName, this.toolRegistry.getActive());
this.toolRegistry.setActive(allowedTools); // every turn; idempotent, keeps Pi's base fresh

const toolPromptResult = sanitizeAvailableToolsSection(event.systemPrompt, allowedTools);
const skillPromptResult = resolveSkillPromptEntries(toolPromptResult.prompt, this.resolver, agentName, ctx.cwd);
this.session.setActiveSkillEntries(skillPromptResult.entries);

return skillPromptResult.prompt !== event.systemPrompt ? { systemPrompt: skillPromptResult.prompt } : {};
```

- No `activeToolsGate` / `promptStateGate` / cache-key construction.
- `setActive` is called unconditionally each turn — with a stable allowed set this rewrites the tools block to identical bytes, so the cache is unaffected.
- Returns `{}` only when nothing was narrowed or filtered (no denied tools, no denied skills); in that case `event.systemPrompt` already equals Pi's correct base, so the reset-to-base is correct and stable.

This keeps Tell-Don't-Ask and LoD intact: the handler tells `toolRegistry` to `setActive`, tells `session` to `setActiveSkillEntries`, and reads only `getActive()` — no reach-through, no output arguments.

### Edge cases

- **All tools denied:** no tool bullet survives → the `Available tools:` section is removed entirely (header included); `setActive([])` already empties the schema.
  Stable across turns.
- **No denials:** `narrow` keeps every line, guidelines/skills unchanged → `prompt === event.systemPrompt` → return `{}` → Pi serves its (already-correct) base.
- **Agent switch mid-session (subagent):** allowed set / denied skills change → override changes → one intentional cache transition to the new agent's prompt.
  Correct, not a regression.
- **A `- name:` prose line that is not a real tool:** within the `Available tools:` section Pi only emits tool bullets, so this does not arise; non-bullet prose is always kept.

## Module-Level Changes

`src/`:

- `system-prompt-sanitizer.ts` — replace the wholesale `Available tools:` removal with per-bullet narrowing; add the `extractToolBulletName` helper; remove the now-unused `removeLineSection`; `sanitizeGuidelinesSection`, `findSection`, `collapseExtraBlankLines`, `normalizePrompt` unchanged.
- `handlers/before-agent-start.ts` — drop the `activeToolsGate` / `promptStateGate` calls and the `createActiveToolsCacheKey` / `createBeforeAgentStartPromptStateKey` imports; call `setActive(allowedTools)` directly; compute sanitize → skill-filter → `setActiveSkillEntries` every turn; return `{ systemPrompt }` when changed vs `event.systemPrompt`, else `{}`.
  Update the constructor JSDoc that lists `toolRegistry` (unchanged deps, but the gate references in prose go away).
- `permission-session.ts` — remove the `activeToolsGate` and `promptStateGate` fields, their three `reset()` pairs (`resetForNewSession`, `shutdown`, `reload`), and the `CacheKeyGate` import.
- `before-agent-start-cache.ts` — **delete** (`createActiveToolsCacheKey`, `createBeforeAgentStartPromptStateKey`, `BeforeAgentStartPromptStateInput`, and the private helpers have no remaining consumers).
- `cache-key-gate.ts` — **delete** (`CacheKeyGate` has no remaining consumers once both gates are removed; verified the only `runIfChanged` callers are the two gates in `before-agent-start.ts`).

`test/`:

- `system-prompt-sanitizer.test.ts` — rewrite the delete-oriented cases to narrowing: assert allowed-tool lines and boilerplate are kept, denied-tool lines are dropped, the section is removed only when no tools are allowed; add a byte-stability case (`sanitizeAvailableToolsSection(fullProse, allowed)` deep-equals `sanitizeAvailableToolsSection(narrowedProse, allowed)`); keep the `findSection` boundary and guidelines-filtering cases.
- `handlers/before-agent-start.test.ts` — remove the gate-specific tests (`calls setActive once across repeated calls`, `returns empty object on repeated calls with unchanged inputs`); add `setActive` called each turn; add a denied-tool-narrowed-in-prose assertion; add the handler-level byte-stability regression (`handle(fullProse)` and `handle(narrowedProse)` return an identical `systemPrompt`); keep the `#385` regression (`does not activate registered tools pi left inactive`).
- `permission-session.test.ts` — remove the `activeToolsGate` / `promptStateGate` reset assertions (around lines 109-118, 169-178, 339-340).
- `before-agent-start-cache.test.ts` — **delete** (covers only the removed key builder).
- `cache-key-gate.test.ts` — **delete** (covers only the removed `CacheKeyGate`).

`docs/`:

- `docs/configuration.md` — line 636 hook-table cell (`removes denied tool entries from the system prompt` → narrows the `Available tools:` listing to the active set); lines 643-644 "Additional behaviors" (state that the listing is narrowed to match the active set, byte-stable across turns, restrict-only retained).
- `docs/architecture/architecture.md` — line 693 module description (`Remove denied tools from system prompt` → `Narrow Available tools + filter guidelines to the active set`); remove line 719 (`before-agent-start-cache.ts` module listing).
  The Phase-5 history sentence (line 757) mentioning `CacheKeyGate` is a past-tense record of that phase and is left as-is.
- `.pi/skills/package-pi-permission-system/SKILL.md` — line 146 testing bullet wording (`denied tools removed` → `denied tool lines removed from the Available tools listing, allowed preserved`); line 28 ("tool filtering + system-prompt sanitization") still accurate, no change.
- `docs/architecture/v3-architecture.md` — **intentionally not updated**: it is a superseded design-era snapshot ("as-is design… and the debt that motivates the target architecture"), not the live architecture doc; its module listing (lines 66, 85) is historical.

No `schemas/`, `config/`, or loader changes — this touches no config field.

## Test Impact Analysis

1. **New tests enabled.**
   The byte-stability invariant is newly expressible: at the sanitizer level (`narrow(full) === narrow(narrowed)`) and at the handler level (`handle(full)` vs `handle(narrowed)` return identical `systemPrompt`).
   These were impossible under the delete-all behavior (which destroyed the section the stability is about) and under the gate memoization (which hid per-turn output behind a cache).
2. **Tests simplified / removed.**
   The two gate tests in `before-agent-start.test.ts` and the whole `before-agent-start-cache.test.ts` / `cache-key-gate.test.ts` files go away with the gates; the `permission-session.test.ts` gate-reset assertions are deleted.
3. **Tests that must stay (rewritten in place).**
   The `system-prompt-sanitizer.test.ts` guidelines-filtering and `findSection` boundary cases still exercise behavior we keep; the `#385` active-set regression in `before-agent-start.test.ts` still pins restrict-only filtering and stays.

## Invariants at risk

- **[#385] restrict-only active set** — Outcome: the active set starts from `getActive()` and only ever removes denied tools (never activates a tool Pi left off).
  Pinned by `before-agent-start.test.ts` → `does not activate registered tools pi left inactive (find/grep/ls)`.
  This plan keeps the allowed-set computation untouched; the test stays green.
  Removing `activeToolsGate` changes *how often* `setActive` is called (now every turn), not *with what* — the invariant holds; only the `calls setActive once` dedup test (which pinned the gate, not [#385]) is updated.
- **Per-turn skill filtering** — denied skills must be filtered on **every** turn.
  This was the latent leak in the gate's `{}`-on-hit path; the always-recompute-and-return flow fixes it.
  Add an explicit handler assertion that a denied skill is absent from the returned `systemPrompt` across two consecutive `handle` calls.

## TDD Order

1. **Detangle the override lifecycle: drop the memoization gates, recompute and return every turn.**
   Red: update `before-agent-start.test.ts` to expect `setActive` each turn and a returned override on repeated unchanged inputs (replacing the two gate tests) plus the per-turn skill-filter assertion; remove the `permission-session.test.ts` gate-reset assertions; delete `before-agent-start-cache.test.ts` and `cache-key-gate.test.ts`.
   Green: rework `AgentPrepHandler.handle` to call `setActive` directly and compute/return the override each turn; remove the gate fields/resets from `permission-session.ts`; delete `before-agent-start-cache.ts` and `cache-key-gate.ts`.
   Run `pnpm run check` immediately (shared interface + deleted modules).
   Commit: `refactor: recompute before_agent_start prompt every turn; drop memoization gates (#437)`.

2. **Narrow the `Available tools:` section instead of deleting it (the breaking fix).**
   Red: rewrite `system-prompt-sanitizer.test.ts` for narrowing (keep allowed bullets + boilerplate, drop denied bullets, remove section only when none allowed) and add the sanitizer byte-stability case; add the handler-level byte-stability regression and the denied-tool-narrowed-in-prose case in `before-agent-start.test.ts`.
   Green: implement per-bullet narrowing in `sanitizeAvailableToolsSection` (add `extractToolBulletName`, remove `removeLineSection`).
   Commit: `fix!: narrow the Available tools section to the active set instead of stripping it (#437)` with a `BREAKING CHANGE:` footer noting the wire system prompt now lists the active tools (narrowed) where the section was previously removed entirely.

3. **Docs.**
   Update `docs/configuration.md`, `docs/architecture/architecture.md`, and the package `SKILL.md` to describe narrowing and the removed cache module.
   Commit: `docs: describe Available-tools narrowing and drop the prompt-cache module (#437)`.

Steps 1 and 2 are kept separate so the breaking, user-visible behavior flip (delete → narrow) is isolated in its own `fix!:` commit; step 1 is a behavior-preserving-on-the-wire detangle (it changes only the per-turn recompute cadence and closes the skill-leak).

## Risks and Mitigations

- **Narrowed output does not byte-match across turns (cache still thrashes).**
  The whole benefit of Option B is byte-stability from turn 1; a whitespace or ordering mismatch between `narrow(default)` and `narrow(narrowed)` would reintroduce a turn-2 cache break.
  Mitigation: the sanitizer- and handler-level byte-stability tests assert `narrow(full)` deep-equals `narrow(narrowed)`; `collapseExtraBlankLines` already normalizes blank runs.
- **Tool-line format coupling.**
  `extractToolBulletName` assumes Pi's `- name: description` bullet shape.
  Mitigation: a focused unit test for the extractor (bullet vs prose vs blank); the parser keeps any line it cannot classify as a tool bullet, so a format change degrades to "keep the line", never "wrongly drop user prose".
- **Removing `activeToolsGate` causes redundant `setActive` calls.**
  Mitigation: `setActiveToolsByName` is idempotent and only rebuilds a prompt string; with a stable allowed set the tools block is byte-identical, so neither correctness nor provider caching regresses.
- **Dead-code / orphan imports after deletions.**
  Mitigation: run `pnpm fallow dead-code` and `pnpm run lint` after step 1; grep confirmed `runIfChanged`, `CacheKeyGate`, and the cache-key builders have no consumers outside the deleted set.

## Open Questions

- **Fully-frozen end-state (return `{}` forever).**
  The only way to stop returning a per-turn override entirely is for Pi to assemble the final prompt itself with denied skills excluded — which needs an upstream Pi skill-exclusion hook (and/or a live system-prompt getter on `ExtensionAPI`).
  Worth a separate upstream tracking issue; out of scope here.
- **Should `setActive` calls be re-gated later?**
  If profiling ever shows the per-turn prompt rebuild matters, a value-returning memo (cache the last override, return it on a hit — not the `{}`-on-hit `CacheKeyGate`) could be reintroduced.
  Defer until there is evidence it matters.

[#385]: https://github.com/gotgenes/pi-packages/issues/385
[#437]: https://github.com/gotgenes/pi-packages/issues/437
