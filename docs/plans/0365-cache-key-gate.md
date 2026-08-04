---
issue: 365
issue_title: "Encapsulate agent-start cache keys in a `CacheKeyGate` class"
---

# Encapsulate agent-start cache keys in a `CacheKeyGate` class

## Problem Statement

`PermissionSession` exposes four anemic methods over two private `string | null` fields (`shouldUpdateActiveTools` / `commitActiveToolsCacheKey` / `shouldUpdatePromptState` / `commitPromptStateCacheKey`).
`AgentPrepHandler` drives each pair via ask-then-tell: it asks "should I update?", performs the effect, then tells "commit the key".
The same `prev !== next` comparison lives in three places — the session's inline `!==`, the handler's orchestration, and the free function `shouldApplyCachedAgentStartState` in `before-agent-start-cache.ts`, which has no production caller and is kept alive only by its own test (so `fallow`'s 0%-dead-exports check misses it).

This is Phase 5, Track B, Step 4 of the `pi-permission-system` improvement roadmap (`docs/architecture/architecture.md`).
The goal is to fold the comparison into a single cohesive `CacheKeyGate` class that owns a previous key and exposes one Tell — `runIfChanged(nextKey, effect)`.

## Goals

- Introduce a `CacheKeyGate` class owning a previous key and exposing `runIfChanged(nextKey, effect)` plus `reset()`.
- Replace `PermissionSession`'s four cache methods and two `string | null` fields with two `CacheKeyGate` sub-objects exposed as `readonly` properties.
- Collapse `AgentPrepHandler`'s two ask-then-tell pairs into single `gate.runIfChanged(key, effect)` tells.
- Remove the dead-in-production `shouldApplyCachedAgentStartState` (and the test assertions that keep it alive), folding its comparison into `CacheKeyGate`.
- Keep `fallow`'s dead-export and dead-file metrics at 0%.

This change is not breaking: it is an internal encapsulation refactor with no change to config, schema, the `/permission-system` command, or observable agent-facing behavior in normal operation.

## Non-Goals

- Track A (`#362`–`#364`, logger state + composition-root coupling) — closed and shipped; no merge coordination is needed.
- Track C (`#366`, `#367`) and Track D (`#368`) — independent steps, out of scope.
- Changing the cache-key *content* — `createActiveToolsCacheKey` and `createBeforeAgentStartPromptStateKey` (the key builders in `before-agent-start-cache.ts`) are unchanged; only the comparison helper is removed.
- Changing `before-agent-start.ts`'s tool-filtering loop or skill-prompt sanitization logic.

## Background

Relevant modules:

- `src/permission-session.ts` — `PermissionSession` owns mutable session state.
  Lines 41–42 declare `toolsCacheKey` / `promptCacheKey`; lines 122–135 declare the four anemic methods; `resetForNewSession`, `shutdown`, and `reload` each set both fields to `null`.
- `src/handlers/before-agent-start.ts` — `AgentPrepHandler.handle` builds the two cache keys, then runs the two ask-then-tell pairs (lines 76–95).
- `src/before-agent-start-cache.ts` — the key builders plus the dead `shouldApplyCachedAgentStartState`.

Current consumers of the four session methods (verified by grep): only `src/handlers/before-agent-start.ts`, `test/permission-session.test.ts`, and `test/handlers/before-agent-start.test.ts`.
Current consumers of `shouldApplyCachedAgentStartState`: only `test/before-agent-start-cache.test.ts`.
No `.pi/skills/package-*/SKILL.md` references any of these symbols.

Constraints from AGENTS.md / package skill:

- A new exported class warrants its own unit test (`code-design`: extract helpers into a module with its own public API once they warrant tests).
- `@typescript-eslint/require-await` is enabled for `src/`; `handle` keeps its existing `// eslint-disable-next-line @typescript-eslint/require-await` since it stays `async` with no `await`.
- When a roadmap step ships, mark it complete in `docs/architecture/architecture.md` as part of the shipping change.

## Design Overview

### `CacheKeyGate`

A standalone, dependency-free class in a new module `src/cache-key-gate.ts`:

```typescript
export class CacheKeyGate {
  private previousKey: string | null = null;

  runIfChanged<T>(nextKey: string, effect: () => T): T | undefined {
    if (this.previousKey === nextKey) {
      return undefined;
    }
    const result = effect();
    this.previousKey = nextKey;
    return result;
  }

  reset(): void {
    this.previousKey = null;
  }
}
```

Semantics:

- On a changed key: runs `effect`, commits `nextKey`, returns the effect's value.
- On an unchanged key: skips `effect`, returns `undefined`.
- `reset()` re-arms the gate so the next key is treated as changed (used by the session lifecycle).

Commit ordering is run-then-commit: the key is committed only after the effect returns.
This unifies the two paths (the tools path already committed after `setActive`; the prompt path previously committed before the sanitization work).
The only observable difference is on the pathological path where the effect throws — the key is then left uncommitted and the next `before_agent_start` event retries, which is strictly safer (no poisoned cache).
In normal (non-throwing) operation the behavior is identical.

### `PermissionSession`

Replace the two fields and four methods with two exposed gates:

```typescript
readonly activeToolsGate = new CacheKeyGate();
readonly promptStateGate = new CacheKeyGate();
```

The three lifecycle methods (`resetForNewSession`, `shutdown`, `reload`) replace `this.toolsCacheKey = null; this.promptCacheKey = null;` with `this.activeToolsGate.reset(); this.promptStateGate.reset();`.

The gates are exposed as `readonly` properties (per the resolved design decision) rather than wrapped in delegating methods.
The gate is a cohesive behavior object the session owns; the handler sends it a single Tell (`runIfChanged`), so this is Tell-Don't-Ask at the gate boundary, not a reach-through to a stranger.
This hits the roadmap's "0 anemic cache accessors / 2 owned `CacheKeyGate` sub-objects" target.

### `AgentPrepHandler` call sites

The two ask-then-tell pairs become single tells:

```typescript
this.session.activeToolsGate.runIfChanged(activeToolsCacheKey, () => {
  this.toolRegistry.setActive(allowedTools);
});

const promptResult = this.session.promptStateGate.runIfChanged(
  promptStateCacheKey,
  () => {
    const toolPromptResult = sanitizeAvailableToolsSection(
      event.systemPrompt,
      allowedTools,
    );
    const skillPromptResult = resolveSkillPromptEntries(
      toolPromptResult.prompt,
      this.resolver,
      agentName,
      ctx.cwd,
    );
    this.session.setActiveSkillEntries(skillPromptResult.entries);
    return skillPromptResult.prompt !== event.systemPrompt
      ? { systemPrompt: skillPromptResult.prompt }
      : {};
  },
);
return promptResult ?? {};
```

The effect's return type `T` is `BeforeAgentStartEventResult`; `runIfChanged` returns `BeforeAgentStartEventResult | undefined`, and `?? {}` reproduces the old early-return-`{}` behavior when the prompt cache is unchanged.

### Edge cases preserved

- Unchanged prompt key: effect skipped, skill entries untouched, returns `{}` — same as the old early return.
- Changed prompt key whose sanitized prompt equals the original: effect runs (commits key, sets skill entries), returns `{}` — same as before.
- `setActive` is still invoked at most once per distinct allowed-tools set across repeated events.

## Module-Level Changes

- `src/cache-key-gate.ts` — new file; exports `CacheKeyGate`.
- `src/permission-session.ts` — remove `toolsCacheKey` / `promptCacheKey` fields and the four methods (`shouldUpdateActiveTools`, `commitActiveToolsCacheKey`, `shouldUpdatePromptState`, `commitPromptStateCacheKey`); add `readonly activeToolsGate` / `readonly promptStateGate`; update the three reset sites; import `CacheKeyGate` from `#src/cache-key-gate`.
- `src/handlers/before-agent-start.ts` — replace the two ask-then-tell blocks with `runIfChanged` tells.
- `src/before-agent-start-cache.ts` — remove `shouldApplyCachedAgentStartState`; keep both key builders.
- `test/cache-key-gate.test.ts` — new unit test for `CacheKeyGate`.
- `test/permission-session.test.ts` — remove the `cache key methods` describe block (now covered by `CacheKeyGate`'s test); rewrite the `resetForNewSession` / `shutdown` / `reload` "clears cache keys" assertions to drive the gates via `runIfChanged`.
- `test/handlers/before-agent-start.test.ts` — rewrite the four tests that spy on `commit*` / mock `shouldUpdate*` to drive real gate behavior (e.g. call `handle` twice with identical inputs and assert `setActive` runs once / the second result is `{}`).
- `test/before-agent-start-cache.test.ts` — remove the `shouldApplyCachedAgentStartState` import and the dedupe test; in the permission-change test, replace the `shouldApplyCachedAgentStartState(baselineKey, invalidatedKey)` assertion with a direct key comparison (`expect(invalidatedKey).not.toBe(baselineKey)`).
- `docs/architecture/architecture.md` — append `✓ complete` to the Step 4 line (Phase 5, Track B) as part of shipping.

No `docs/architecture/` complexity tables, layout listings, or domain diagrams reference the removed symbols beyond the roadmap step line itself.

## Test Impact Analysis

1. New tests enabled by the extraction.
   `CacheKeyGate` gets a focused unit test for behavior that was previously only reachable through the session's anemic methods or the free function: `runIfChanged` runs and returns on a first/changed key, skips and returns `undefined` on an unchanged key, and `reset()` re-arms the gate.

2. Tests that become redundant.
   The `cache key methods` describe block in `permission-session.test.ts` (five tests exercising `shouldUpdate*` / `commit*` directly) is superseded by the `CacheKeyGate` unit test — remove it.
   The `dedupes unchanged active-tool exposure and prompt state` test in `before-agent-start-cache.test.ts` exercises only `shouldApplyCachedAgentStartState` — remove it.

3. Tests that must stay (rewritten, not deleted).
   The `resetForNewSession` / `shutdown` / `reload` "clears cache keys" tests genuinely exercise session-lifecycle re-arming of the gates — keep them, asserting via the exposed gates.
   The handler behavior tests (`setActive` called/skipped, returns `{}` vs `{ systemPrompt }`) genuinely exercise the handler's dedupe orchestration — keep them, driving real gate state instead of mocking the removed methods.
   The permission-change test in `before-agent-start-cache.test.ts` genuinely exercises key invalidation on a policy-stamp change — keep it, asserting key inequality directly.

## TDD Order

1. Add `CacheKeyGate` (new module + unit test).
   Surface: `test/cache-key-gate.test.ts` against `src/cache-key-gate.ts`.
   Covers: runs `effect` and returns its value on a new/changed key; skips `effect` and returns `undefined` on an unchanged key; `reset()` re-arms so the same key runs again.
   Commit: `feat: add CacheKeyGate for agent-start cache keys (#365)`.

2. Migrate `PermissionSession` + `AgentPrepHandler` + their tests to `CacheKeyGate`.
   Surface: `src/permission-session.ts`, `src/handlers/before-agent-start.ts`, `test/permission-session.test.ts`, `test/handlers/before-agent-start.test.ts`.
   This is one step: removing the four methods breaks the handler and both test files at the type/behavior level simultaneously, so the extraction, all consumer updates, and all consumer-test updates land together.
   Remove the two fields + four methods; add the two `readonly` gates; update the three reset sites; rewrite the handler call sites; rewrite the affected tests per the Module-Level Changes list.
   Run `pnpm run check` immediately after this commit (shared-surface change).
   Commit: `refactor: encapsulate agent-start cache keys in CacheKeyGate (#365)`.

3. Remove the dead-in-production `shouldApplyCachedAgentStartState`.
   Surface: `src/before-agent-start-cache.ts`, `test/before-agent-start-cache.test.ts`.
   Remove the function and its test references (drop the dedupe test; convert the permission-change assertion to a direct key comparison).
   Verify with `pnpm fallow dead-code` that the export count stays at 0% dead.
   Commit: `refactor: remove test-only shouldApplyCachedAgentStartState (#365)`.

4. Mark the roadmap step complete.
   Surface: `docs/architecture/architecture.md`.
   Append `✓ complete` to the Phase 5 Track B Step 4 line.
   Commit: `docs: mark Phase 5 Step 4 complete (#365)`.

## Risks and Mitigations

- Risk: the prompt path's commit ordering shifts from commit-then-run to run-then-commit.
  Mitigation: observable only when the effect throws (then the key is retried — strictly safer); normal operation is identical.
  No existing test asserts the throw-path ordering.
- Risk: handler tests currently mock the removed methods (`vi.spyOn(session, "shouldUpdatePromptState")`).
  Mitigation: rewrite them to drive real gate state via repeated `handle` calls; the handler tests already use a real session (`makeRealSession`), so the real gates are present.
- Risk: removing an export could leave a dangling reference.
  Mitigation: grep confirmed the four methods and `shouldApplyCachedAgentStartState` are referenced only in the files listed above (no SKILL.md, no composition-root test); step 3 runs `fallow` to confirm 0% dead code.

## Open Questions

- Track A steps (`#362`–`#364`) shipped but were not individually marked `✓ complete` in `docs/architecture/architecture.md`.
  Step 4 of this plan marks Step 4 complete per the package-skill convention; whether to back-fill the Track A markers is out of scope here.
