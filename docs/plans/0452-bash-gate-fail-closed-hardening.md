---
issue: 452
issue_title: "Bash permission gates silently fail after model changes, denial events, or session compaction git add/commit/push/gh pr create bypass all rules"
---

# Make the bash permission gate fail closed instead of silently allowing

## Release Recommendation

**Release:** ship independently

This issue is not part of any architecture-roadmap batch (no `(#452)` reference in `docs/architecture/architecture.md`, no `Release batches` subsection).
It is a self-contained security hardening fix and ships on its own.

## Problem Statement

A third-party reporter (`k0valik`) observed that the bash permission gate intermittently stops intercepting `git add` / `git commit` / `git push` / `gh pr create`, letting them run with **no review-log entry at all**, despite an explicit `"git *": "ask"` rule.
The reported triggers — a rapid `model_change` cascade, a user denial, and session compaction — are correlated from production logs but are **not locally reproducible**, and the reporter's own five ranked root-cause theories are speculative.

The investigation (see Background) found that the report bundles several distinct concerns.
Rather than chase an unreproducible trigger, this plan fixes the **confirmable defect class**: the gate is **fail-open** in several places, which contradicts the package's own stated invariant ("Default to least privilege — when in doubt, prompt (`ask`), do not silently allow").
Once the gate fails closed and records every error, the worst case for any present or future bug becomes a **visible** `ask`/block — never an invisible allow — and the one mechanism I could not reproduce becomes diagnosable on recurrence.

## Goals

- Make `PermissionGateHandler.handleToolCall` **fail closed**: any thrown error blocks the tool and writes a review-log entry, rather than letting the SDK pass the command ungated.
- Make the bash tool gate **fail closed** when a non-empty command parses to zero command units: default to `ask` instead of resolving the opaque whole-command string (which lets `cd X && git push` ride a permissive top-level `*`).
- Make the tree-sitter parser **resilient**: a transient init failure must not poison the parser for the process lifetime (no cached rejected promise).
- **Surface the config footgun**: emit a non-fatal config warning when a permissive top-level `*: allow` is set with no `bash` `*` policy, so bash silently inherits `allow`.
- **Make the boundary structurally fail-closed**: register a single `tool_call` adapter that is the only SDK-facing entry point, owns the `try/catch → block`, and is the only place an internal `GateOutcome` is translated to the SDK result shape — so "we didn't decide" can never silently mean "allow."
- **Make every tool call traceable**: guarantee exactly one terminal decision per call, add a `debugLog`-gated per-call trace and a `session_shutdown` decision summary, so an evaluated-and-allowed call is distinguishable from a never-evaluated one without hand-reconciling logs.
- **Add totality tests**: a metamorphic property (wrapping any `ask`/`deny` command in `cd X && …` must not weaken the decision) and a boundary contract test (a throwing handler must block), to catch the fail-open class in development rather than production.
- **This change is breaking** (more restrictive): commands that previously passed silently on the error path or via the empty-parse fallback will now block or prompt.
  Use `fix!:` with a `BREAKING CHANGE:` footer on the behavior-changing commits.

## Non-Goals

- Reproducing or directly fixing the specific `model_change`-cascade / denial / compaction triggers — they are addressed indirectly by making the gate fail closed and observable, not by a targeted mechanism fix.
- The `git`-vs-`rm` asymmetry (some `git` commands bypass while `rm` stays gated in the same period).
  I could not reconcile this from the source; it is documented as diagnosable-on-recurrence (the new review-log entries will pinpoint it) and deferred to a follow-up issue only if it recurs with new logs.
- The reporter's suggested *unconditional* `console.log` instrumentation on every `handleToolCall` — A5 instead adds a `debugLog`-gated per-call trace plus a `session_shutdown` summary, so the trace is available on demand without per-call spam in normal operation.
- Full cross-artifact reconciliation against Pi's session JSONL — A5's in-process counters are the cheaper first tier; reading Pi's session file is a deferred follow-up (see Open Questions).
- Any change to the `/permission-system` command, the config schema (no new field), or the merge precedence model.

## Background

Relevant modules and the verified findings behind each fix:

- `src/handlers/permission-gate-handler.ts` — `handleToolCall` has **no try/catch**.
  The SDK's dispatcher (`@earendil-works/pi-coding-agent` `dist/core/extensions/runner.js`, `emitToolCall`) calls `await handler(event, ctx)` with **no try/catch** — unlike `emitUserBash` directly below it, which catches and continues.
  So a thrown `handleToolCall` produces no `{ block: true }` result and the command is not blocked, with nothing logged.
  This is the keystone defect (A1): it converts every other latent error into a silent, trace-less bypass.
- `src/handlers/gates/bash-program.ts` — `parserPromise ??= initParser()` caches a **rejected** promise forever if `initParser()` ever rejects.
  Every later `getParser()` re-throws, and via A1 that is a permanent silent bypass.
  `config.loaded` (emitted from `ConfigStore.refresh()`) re-reads config without re-running the factory module, so a reload looks like recovery but does not clear the module-scoped promise — matching "once broken, stays broken until process restart" (A2).
- `src/handlers/gates/bash-command.ts` — `resolveBashCommandCheck` falls back to resolving the **whole command string** when `BashProgram.parse` yields zero command units.
  `cd /repo && git push` matches no `git *` rule and falls through to a top-level `*: allow`, producing a silent pass (A3).
  When parse succeeds, the chain is split into `[cd /repo, git push]` and `pickMostRestrictive` correctly returns `ask`, so this bypass is only reachable through the empty-parse path.
- `src/config-loader.ts` — config issues collected during `loadAndMergeConfigs` flow through `mergeResult.issues` and are surfaced by `ConfigStore.refresh()` via `ctx.ui.notify(warning, "warning")` and the `config.loaded` debug entry.
  The shipped `config/config.example.json` sets `bash.*: ask` and is safe; a config with a permissive top-level `*: allow` and no `bash` `*` removes the net that would otherwise catch A3 (A4).

Constraints from AGENTS.md / package skill that apply:

- "Default to least privilege — when in doubt, prompt (`ask`), do not silently allow." — this fix aligns the code with that invariant.
- "When removing a config field, keep the loader tolerant" — N/A; no field is removed, A4 only adds a derived warning.
- Keep schema, example config, `docs/configuration.md`, `README.md`, and SKILL aligned.

### Theories ruled out (do not plan around these)

- "Handler deregistration after model changes" — contradicted by the reporter's own data: `rm`/`node` stay gated during bypass, so the handler is firing.
- "Tree-sitter concurrent corruption mid-parse" — implausible: JS is single-threaded and `parser.parse()` is synchronous with no interleaving `await`.
  Only a transient *init* failure (A2) is real.
- "A denial permanently poisons handler state" — no code path mutates shared/module state on denial; denial returns `{ block: true }` cleanly.

## Design Overview

Five defense-in-depth changes plus totality tests.
A1 is the structural keystone — it closes the whole fail-open class at one boundary; A2–A4 fix the specific defects that boundary would otherwise have to absorb; A5 makes the now-guaranteed decision observable.
Each is individually correct; together they guarantee no silent allow.

### A1 — Fail-closed boundary adapter (single chokepoint)

The fail-open holes exist because "allow" is the *implicit default* at five different exits: the pipeline's trailing `return { action: "allow" }`, `GateRunner.run`'s null/bypass allow, the handler's `{}` return, `applyPermissionGate`'s fall-through, and — critically — a thrown handler, which the SDK does **not** convert to a block.
Rather than patch each exit, close the class at one boundary.

Introduce a single SDK-facing adapter that is the only function registered for `pi.on("tool_call")`.
It is the sole place an internal decision is translated to the SDK result shape, and it owns the `try/catch → block`:

```typescript
// src/handlers/tool-call-boundary.ts
/** The only tool_call handler the SDK sees. Guarantees fail-closed: a thrown
 *  gate becomes a Block, and the internal GateOutcome → SDK-shape translation
 *  happens here and nowhere else. */
export function createFailClosedToolCall(
  gate: (event: unknown, ctx: ExtensionContext) => Promise<GateOutcome>,
  reporter: DecisionReporter,
  audit: DecisionAudit,
): (event: unknown, ctx: ExtensionContext) => Promise<{ block?: true; reason?: string }> {
  return async (event, ctx) => {
    try {
      const outcome = await gate(event, ctx);
      audit.recordDecision(outcome.action);
      return outcome.action === "block" ? { block: true, reason: outcome.reason } : {};
    } catch (error) {
      audit.recordError();
      reporter.writeReviewLog("permission_request.blocked", {
        toolName: bestEffortToolName(event),
        command: bestEffortCommand(event),
        resolution: "gate_error",
        error: error instanceof Error ? error.message : String(error),
      });
      return { block: true, reason: formatGateErrorReason(error) };
    }
  };
}
```

Correspondingly, `PermissionGateHandler.handleToolCall` changes its return type from the loose SDK shape (`{ block?: true; reason? }`) to the internal **total** type `GateOutcome` (`{ action: "allow" } | { action: "block"; reason }`, already defined in `handlers/gates/types.ts`).
Its validation-block path returns `{ action: "block", reason }` instead of `{ block: true, reason }`.
The domain handler is now SDK-shape-free, and the `reporter` (plus the new `audit`) dependency lives on the boundary, **not** the handler — so the handler constructor does not widen.
Use the `DecisionReporter` interface type, not the concrete `GateDecisionReporter` (DIP / narrow-interface rule).

`index.ts` registers `pi.on("tool_call", createFailClosedToolCall((e, c) => gates.handleToolCall(e, c), reporter, audit))`.

The catch helpers (`bestEffortToolName`, `bestEffortCommand`, `formatGateErrorReason`) read from the raw `event` defensively and never throw, so a failure inside `session.activate` still logs and blocks.

Fail-closed choice = **block** (not `ask`) for an *unexpected* exception: the command may be unknown and the prompt infrastructure itself may be what threw — block is the unambiguous safe outcome for an internal error.

### A2 — Resilient parser init

Extract a small, pure, unit-testable helper and use it for the parser cache:

```typescript
// src/async-cache.ts
/** Memoize an async factory, but drop a rejected result so the next call retries. */
export function memoizeAsyncWithRetry<T>(factory: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    cached ??= factory().catch((error) => {
      cached = null; // poisoned result cleared → next call re-attempts
      throw error;
    });
    return cached;
  };
}
```

`bash-program.ts` replaces the module-scoped `parserPromise` + `getParser` with `const getParser = memoizeAsyncWithRetry(initParser)`.
On success the behavior is identical (single shared parser); on a transient init failure the next tool call retries instead of inheriting a permanently rejected promise.
A parser-init failure no longer needs a dedicated health signal: the throw from `getParser()` propagates to the A1 boundary, which records it as a `gate_error` review-log entry — so the failure is visible (and the tool blocked) for free.
This is why a separate "parser health" mechanism is intentionally **not** added.

### A3 — Fail-closed empty-parse fallback

In `resolveBashCommandCheck`, when `commands` is empty:

- If `command` is empty, whitespace-only, or comment-only → resolve the whole string as before (genuinely nothing to gate).
- Otherwise (a non-empty command that parsed to zero command units — a parse anomaly or an opaque program) → return a synthetic **`ask`** result, fail closed.

```typescript
if (commands.length === 0) {
  if (isTriviallyEmptyCommand(command)) {
    return resolver.resolve("bash", { command }, agentName);
  }
  return {
    state: "ask",
    toolName: "bash",
    source: "bash",
    origin: "builtin",
    command,
    matchedPattern: "<unparseable-bash-command>",
  } satisfies PermissionCheckResult;
}
```

The sentinel `matchedPattern` makes the path visible in the review log when the gate runs — directly addressing the "no trace" complaint — without injecting a logger into this pure function.
The non-empty chain path (the `commands.map(...) → pickMostRestrictive` branch, #301 / #306) is unchanged.

### A4 — Config footgun warning

Add a pure detector run against the **merged** permission map (where the final composed top-level `*` and `bash` surface are both known):

```typescript
// returns one issue string, or undefined
export function detectPermissiveBashFallback(
  permission: FlatPermissionConfig | undefined,
): string | undefined;
```

It warns when `permission["*"] === "allow"` (or a deny-with-reason that resolves to allow — not applicable, so a plain `"allow"` check suffices) **and** the `bash` surface either is absent or is an object with no `"*"` key.
A `bash` value that is the bare string `"allow"`/`"ask"`/`"deny"` (shorthand for `{ "*": … }`) counts as having an explicit `bash` `*` and does not warn.
Call it in `loadAndMergeConfigs` after the merge and push its result onto `allIssues`, so it rides the existing `mergeResult.issues` → `ctx.ui.notify` path.

#### Consumer call-site sketch (A4 wiring)

```typescript
// config-loader.ts, end of loadAndMergeConfigs, after `merged` is final
const bashFallbackIssue = detectPermissiveBashFallback(merged.permission);
if (bashFallbackIssue) allIssues.push(bashFallbackIssue);
return { merged, issues: allIssues };
```

No reach-through: the detector takes the plain map and returns a string; `loadAndMergeConfigs` owns the push.

### A5 — Decision-per-call trace and shutdown summary

The reporter could not distinguish "evaluated and allowed" from "never evaluated" because the allow path writes nothing, and the user-facing review log intentionally stays quiet on allow (noise control).
With A1 the boundary now produces exactly one terminal decision per call; make that decision *observable* without flooding the review log.

A `DecisionAudit` collaborator (owned by the boundary) holds per-session counters: `toolCalls`, `allowed`, `blocked`, `errors`.

```typescript
// src/decision-audit.ts
export class DecisionAudit {
  recordDecision(action: "allow" | "block"): void; // also bumps toolCalls
  recordError(): void;                              // also bumps toolCalls
  writeSummary(logger: PermissionSystemLogger): void;
}
```

- When `debugLog` is enabled, the boundary writes one compact `permission.decision` debug entry per call (tool, action, matched pattern) — a full trace on demand, off by default.
- On `session_shutdown` (already hooked by `SessionLifecycleHandler`), `writeSummary` emits one `permission.session_summary` debug line with the counters.
  `toolCalls !== allowed + blocked + errors` is an invariant violation logged at warning level — a cheap structural self-check that flags any future regression that re-opens a silent path.

This is in-process self-audit.
Full reconciliation against Pi's own session JSONL (the cross-artifact check the reporter did by hand) needs to read Pi's session file and is a deferred follow-up (see Open Questions).

## Module-Level Changes

- `src/handlers/tool-call-boundary.ts` — **new** module: `createFailClosedToolCall(gate, reporter, audit)` (the sole `pi.on("tool_call")` target) plus the defensive `bestEffortToolName` / `bestEffortCommand` / `formatGateErrorReason` helpers.
- `src/decision-audit.ts` — **new** module: `DecisionAudit` (counters + `recordDecision` / `recordError` / `writeSummary`).
- `src/handlers/permission-gate-handler.ts` — change `handleToolCall`'s return type from `{ block?: true; reason? }` to the internal total `GateOutcome`; the validation-block path returns `{ action: "block", reason }`.
  No constructor change (the reporter lives on the boundary).
- `src/handlers/lifecycle.ts` — `SessionLifecycleHandler` gains the `DecisionAudit` (injected) and calls `audit.writeSummary(logger)` in `handleSessionShutdown`.
- `src/index.ts` — construct `DecisionAudit`; register `pi.on("tool_call", createFailClosedToolCall((e, c) => gates.handleToolCall(e, c), reporter, audit))` instead of the bare handler; pass `audit` into `SessionLifecycleHandler`.
- `src/async-cache.ts` — **new** module exporting `memoizeAsyncWithRetry`.
- `src/handlers/gates/bash-program.ts` — replace `parserPromise` + `getParser()` with `memoizeAsyncWithRetry(initParser)`; remove the now-dead module-scoped `let parserPromise`.
- `src/handlers/gates/bash-command.ts` — add the empty-commands fail-closed branch and the `isTriviallyEmptyCommand` helper.
- `src/config-loader.ts` — add and export `detectPermissiveBashFallback`; call it in `loadAndMergeConfigs`.
- `docs/configuration.md` — document the new fail-closed behavior (gate errors block, unparseable bash commands prompt) and the recommendation to set `bash.*` explicitly; describe the new config warning.
- `README.md` — if it summarizes gate behavior or config recommendations, add the `bash.*` note (grep first; update only if present).
- `.pi/skills/package-pi-permission-system/SKILL.md` — add a short note under Debugging that the gate now fails closed and emits a `gate_error` review entry, and that an unparseable bash command resolves to `ask` (`<unparseable-bash-command>` sentinel).
- `config/config.example.json` — verify only; it already sets `bash.*: ask`, no change expected.

Greps performed / to confirm during implementation:

- The only consumer breakage is internal: `handleToolCall`'s return-type change (`{ block?: true }` → `GateOutcome`) breaks every test that asserts the SDK shape (`tool-call.test.ts`, `tool-call-events.test.ts`) — fold those updates into the A1 step (they now assert `GateOutcome` from the handler, or `{ block: true }`/`{}` from the boundary).
- `getParser` / `parserPromise` are file-local to `bash-program.ts` (no external importers) — confirm before deleting the `let`.
- Grep `docs/` for any sample review-log output or documented "allow"/fallback wording that the new `gate_error` / `<unparseable-bash-command>` entries would make stale.

## Test Impact Analysis

1. **New unit tests enabled by these changes:**
   - `test/async-cache.test.ts` — `memoizeAsyncWithRetry`: caches on success (single factory call across N calls); drops a rejected result so the next call re-invokes the factory; surfaces the rejection to the caller each time it fails.
   - `test/handlers/gates/bash-command.test.ts` — empty `commands` + non-empty command → `ask` with the sentinel `matchedPattern`; empty `commands` + whitespace/comment-only command → whole-string resolve (unchanged).
   - `test/handlers/tool-call-boundary.test.ts` (new) — the boundary contract: an `allow` `GateOutcome` → `{}`; a `block` outcome → `{ block: true, reason }`; a **throwing** gate → `{ block: true }` plus a `gate_error` review-log entry and `audit.recordError()`.
     A header comment cites that the SDK's `emitToolCall` lacks a try/catch (unlike `emitUserBash`), documenting why the boundary must absorb the throw.
   - `test/handlers/gates/bash-command-metamorphic.test.ts` (new) — the totality property: for a table of `ask`/`deny` commands, `resolveBashCommandCheck` over `cd /x && <cmd>` yields a decision no weaker than the bare `<cmd>` (deny ≥ ask ≥ allow).
     A focused parametrized table over real parse+resolve, not a full fuzzer (tree-sitter fuzzing is brittle); it pins A3 directly.
   - `test/decision-audit.test.ts` (new) — counters increment per recorded decision/error; `writeSummary` emits the summary line; a forced `toolCalls !== allowed + blocked + errors` mismatch logs the warning-level invariant violation.
   - `test/config-loader.test.ts` (or a new `detect-permissive-bash-fallback.test.ts`) — detector returns a warning for `{*: "allow"}` with no `bash.*`; returns `undefined` when `bash.*` is set, when `bash` is a bare string, or when top-level `*` is not `allow`.
2. **Tests that become redundant:** none — all additive.
3. **Tests that must stay as-is:** the existing `resolveBashCommandCheck` chain / most-restrictive tests (#301 / #306) — they pin that the non-empty path is untouched; the `makeHandler`-based `tool-call.test.ts` happy-path tests pin that the normal allow/block flow is unchanged (updated only for the `GateOutcome` return shape).

## Invariants at risk

This change touches surfaces refactored by earlier roadmap steps; keep their pinned tests green.

- #301 / #306 (bash chain evaluation, most-restrictive-wins) — A3 changes only the `commands.length === 0` branch.
  Pinned by `test/handlers/gates/bash-command.test.ts` chain tests.
- #308 (single `BashProgram.parse` per evaluate) — A2 changes `getParser` caching, not the parse-once contract.
  Pinned by `test/handlers/gates/tool-call-gate-pipeline.test.ts`.
- The `makeHandler` real-pipeline wiring (#341 / handler-fixtures) — A1 changes `handleToolCall`'s return type to `GateOutcome`; update `makeHandler`'s callers and the `tool-call*.test.ts` assertions in the same commit so all existing handler tests keep compiling/passing.
  `makeHandler` itself needs no reporter (the reporter moved to the boundary), but the boundary tests construct their own reporter/audit mocks.

## TDD Order

1. **A2 parser resilience.**
   Red: `test/async-cache.test.ts` for `memoizeAsyncWithRetry` (success-caches, reject-retries, reject-surfaces).
   Green: add `src/async-cache.ts`; rewire `bash-program.ts` to use it and delete the `let parserPromise`.
   Run `pnpm run check`.
   Commit: `fix(pi-permission-system): retry tree-sitter parser init instead of caching a rejected promise (#452)`.
2. **A4 config footgun warning.**
   Red: detector tests (warn / no-warn matrix).
   Green: add and export `detectPermissiveBashFallback`; call it in `loadAndMergeConfigs`.
   Commit: `feat(pi-permission-system): warn when a permissive top-level "*" leaves bash ungated (#452)`.
3. **A1 fail-closed boundary + `GateOutcome` handler return.**
   Red: add `test/handlers/tool-call-boundary.test.ts` (allow/block/throw contract); update `tool-call.test.ts` / `tool-call-events.test.ts` to the new `GateOutcome` return shape.
   Green: add `src/handlers/tool-call-boundary.ts` and a minimal `src/decision-audit.ts` (counters only — `recordDecision`/`recordError`; `writeSummary` lands in step 5); change `handleToolCall` to return `GateOutcome`; register the boundary in `index.ts` (same commit — interface + sole call site).
   Run `pnpm run check` (return-type change) and the full suite (shared handler fixtures).
   Commit: `fix!(pi-permission-system): route tool calls through a fail-closed boundary (#452)` with a `BREAKING CHANGE:` footer covering the whole fail-closed shift (this commit and step 4) and the remediation: set an explicit permissive `bash` policy (e.g. `"bash": { "*": "allow" }`) to opt back into permissive behavior.
4. **A3 fail-closed empty-parse fallback.**
   Red: `bash-command.test.ts` empty-non-empty → `ask`; empty-trivial → whole-string resolve; plus `bash-command-metamorphic.test.ts` (the `cd X && <cmd>` no-weaker property).
   Green: add the empty-commands branch + `isTriviallyEmptyCommand`.
   Commit: `fix(pi-permission-system): prompt instead of allowing an unparseable bash command (#452)` (the breaking footer is already carried by step 3; reference it in the body).
5. **A5 decision audit + shutdown summary.**
   Red: `test/decision-audit.test.ts` (counters, summary line, invariant-violation warning); extend the boundary test for the `debugLog`-gated per-call trace.
   Green: complete `DecisionAudit.writeSummary`; thread `audit` into `SessionLifecycleHandler.handleSessionShutdown` and the `debugLog`-gated per-call trace in the boundary; wire `audit` in `index.ts`.
   Commit: `feat(pi-permission-system): trace tool-call decisions and emit a session summary (#452)`.
6. **Docs + SKILL alignment.**
   Update `docs/configuration.md`, `README.md` (if applicable), and the package SKILL note (fail-closed boundary, `gate_error` / `<unparseable-bash-command>` / `permission.session_summary` entries).
   Commit: `docs(pi-permission-system): document fail-closed gate behavior and bash fallback warning (#452)`.

Run the full package suite (`pnpm --filter @gotgenes/pi-permission-system exec vitest run`) after steps 3 and 5, which touch shared handler fixtures and composition-root wiring.

## Risks and Mitigations

- **Risk:** blocking on every transient gate error is too aggressive and surprises users.
  **Mitigation:** these errors should be rare; the review-log `gate_error` entry tells the user exactly what happened and the generic reason names the gate.
  Correctness (no silent allow) outweighs convenience for a permission system.
- **Risk:** A3's `ask` default produces unexpected prompts for unparseable commands in permissive configs.
  **Mitigation:** documented in the breaking note with a real opt-out (`"bash": { "*": "allow" }`); only triggers on the rare empty-parse path.
- **Risk:** the `git`-vs-`rm` asymmetry is a distinct, still-unexplained bug that these changes do not fix.
  **Mitigation:** the new review-log entries make any recurrence visible and attributable; a follow-up issue is filed only if it recurs with fresh logs.
- **Risk:** the A1 boundary + `GateOutcome` return-type change ripples through `tool-call*.test.ts` assertions.
  **Mitigation:** the change is mechanical (assert `GateOutcome` from the handler, SDK shape from the boundary) and folded into the A1 step; the reporter moving to the boundary keeps the handler constructor from widening.
- **Risk:** A5's audit adds per-call work.
  **Mitigation:** counters are O(1); the per-call trace is gated behind `debugLog`; the summary is one line on `session_shutdown`.
- **Risk:** scope growth — five changes plus an audit in one issue.
  **Mitigation:** the steps are independently committable; A5 (step 5) is separable to a follow-up if review prefers, but the A1 boundary is the structural keystone and must land here.
  A `DecisionAudit` stub (counters only) is introduced in step 3 so the boundary signature is stable before A5 completes it.

## Open Questions

- Should an *unexpected* gate error (A1) prompt (`ask`) rather than hard-block when the context supports a UI?
  Deferred: hard-block is the unambiguous fail-closed choice and avoids depending on possibly-broken prompt infrastructure.
  Revisit if blocking proves disruptive in practice.
- Should A4's detector also warn for other surfaces (`mcp`, `skill`) that inherit a permissive top-level `*`?
  Deferred to a follow-up; this issue is scoped to the bash bypass.
- Full reconciliation of A5's in-process counters against Pi's own session JSONL (the cross-artifact check the reporter performed by hand) is deferred — it requires reading Pi's session file, a heavier mechanism than this issue warrants.
  The in-process summary is the cheaper first tier.
- Should `GateOutcome` gain an explicit first-class `ask` variant (today `ask` is resolved inside `applyPermissionGate`, and `GateOutcome` carries only `allow`/`block`)?
  Deferred: the two-variant total type is sufficient for the boundary's fail-closed translation; widening it is a larger decision-model refactor better tracked on its own.
