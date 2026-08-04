---
issue: 341
issue_title: "Slim PermissionSession to a state/lifecycle owner; unwind the fig-leaf interfaces"
---

# Slim PermissionSession to a state/lifecycle owner; unwind the fig-leaf interfaces

## Problem Statement

This is Phase 4, Step 8 (Track C: Split the session) of the pi-permission-system improvement roadmap.
Steps 6 ([#339]) and 7 ([#340]) extracted the prompting role into `PromptingGateway` and the resolution role into `PermissionResolver`.
What remains is a `PermissionSession` that still implements four role interfaces — `SessionApprovalRecorder`, `GateHandlerSession`, `AgentPrepSession`, `SessionLifecycleSession` — and still carries transitional permission-query duplicates (`checkPermission`, `getToolPermission`, `getConfigIssues`, `getPolicyCacheStamp`) that delegate to its `PermissionManager` even though `PermissionResolver` now owns the same surface.

The tell is twofold.
First, `new GateRunner(resolver, session, gateway, reporter)` still passes the session as the recorder role — the runner gets a distinct resolver and a distinct prompter, but the recorder is still the god object.
Second, the three handler interfaces are fig leaves: narrow interfaces all satisfied by one object, with no second implementer and no plan for one.
The test cost is a 17-field `MockGateHandlerSession` intersection mock in `handler-fixtures.ts`, a hand-rolled stateful recorder + resolver-delegation dance in `external-directory-session-dedup.test.ts`, and per-handler mock factories in `lifecycle.test.ts` and `before-agent-start.test.ts`.

Now that Step 1 ([#334]) made `PermissionSession` and `PermissionResolver` constructible with test doubles, the handlers can depend on the concrete collaborators directly and the tests can build real instances from small per-collaborator fakes.

## Goals

- Move the recorder role off the session: `GateRunner` receives `SessionRules` (a distinct collaborator) as its `SessionApprovalRecorder`, so the runner's three roles map to three different objects (`resolver`, `recorder`, `prompter`).
- Rewire `AgentPrepHandler` and `SessionLifecycleHandler` to depend on `PermissionResolver` for the permission-query surface (`getToolPermission`, `getPolicyCacheStamp`, `getConfigIssues`, and the `SkillPermissionChecker` `checkPermission` pass).
- Remove the now-dead transitional duplicates from `PermissionSession`: `checkPermission`, `getToolPermission`, `getConfigIssues`, `getPolicyCacheStamp`, `getSessionRuleset`, `recordSessionApproval`.
- Retire the three handler role interfaces (`GateHandlerSession`, `AgentPrepSession`, `SessionLifecycleSession`); the three handlers depend on the concrete `PermissionSession` for state/lifecycle and on `PermissionResolver` for queries (user-confirmed Option A).
- Split or remove the 17-field `makeSession` / `MockGateHandlerSession` fixture; handler tests build a real `PermissionSession` + `PermissionResolver` from small per-collaborator fakes promoted into `test/helpers/`.
- Behavior-preserving — the suite stays green at every commit.

## Non-Goals

- No change to `PromptingGateway` ([#339]) or `PermissionResolver`'s resolution behavior ([#340]) — only their wiring into handlers.
- No change to `ToolCallGateInputs` or `SkillInputGateInputs` — these are genuine narrow input contracts for the pipelines, not fig leaves; `PermissionSession` keeps satisfying `ToolCallGateInputs` structurally and the resolver satisfies `SkillInputGateInputs`.
- No change to `SkillPermissionChecker` — it stays a narrow interface; the production caller switches from the session to the resolver.
- Not the `permission-system.test.ts` catch-all carve — that is Step 9 ([#342]).
- No further `PermissionSession` decomposition (an `ActiveAgentTracker`, a cache-key owner, an infra-path helper) — deferred to Phase 5.
- No change to the `permission-event-rpc.ts` or `config-modal.ts` session usage: RPC reads `session.getRuntimeContext()` and the modal reads `session.lastKnownActiveAgentName` — both stay on the session.

## Background

Relevant modules and how they relate after Steps 6–7:

- `permission-session.ts` — `PermissionSession` class, currently `implements SessionApprovalRecorder, GateHandlerSession, AgentPrepSession, SessionLifecycleSession`.
  Holds `paths`, `logger`, `forwarding`, `permissionManager`, `sessionRules`, `configStore`, `gateway`.
  After this step it keeps `permissionManager` (for `configureForCwd` in `resetForNewSession`/`reload`) and `sessionRules` (for `clear()` in `shutdown`), but sheds all permission-query and recorder/ruleset methods.
- `permission-resolver.ts` — `ScopedPermissionResolver` interface (`{ resolve }`) + concrete `PermissionResolver` class.
  Already carries `checkPermission` / `getToolPermission` / `getConfigIssues` / `getPolicyCacheStamp`, currently `// fallow-ignore-next-line unused-class-member`-suppressed because no handler is wired to them yet.
  This step removes those suppressions as the handlers adopt the methods.
- `session-rules.ts` — `SessionRules` class with `record(approval)`, `getRuleset()`, `approve()`, `clear()`.
  `record` is called only by `session.recordSessionApproval`.
- `session-approval-recorder.ts` — `SessionApprovalRecorder` interface (`recordSessionApproval(approval)`), depended on by `GateRunner`.
- `handlers/gates/runner.ts` — `GateRunner(resolver, recorder, prompter, reporter)`; production passes `session` as `recorder`.
- `handlers/permission-gate-handler.ts` — depends on `GateHandlerSession` (`activate`, `resolveAgentName`); the runner it holds already owns the resolver.
- `handlers/before-agent-start.ts` — `AgentPrepHandler` depends on `AgentPrepSession`; calls `session.getToolPermission`, `session.getPolicyCacheStamp`, and passes `session` as the `SkillPermissionChecker` to `resolveSkillPromptEntries`.
- `handlers/lifecycle.ts` — `SessionLifecycleHandler` depends on `SessionLifecycleSession`; calls `session.getConfigIssues`.
- `index.ts` — composition root; constructs the resolver and all handlers.
  Step 5 ([#338]) already finalized the closure-bag collapse, so Step 8 only adjusts constructor arguments and the resolver's construction order.

Constraints from AGENTS.md / skills that apply:

- The package convention is "narrow role interface, not the concrete class."
  This step consciously trades that off for the three handler interfaces (user-confirmed Option A), because Step 1's constructibility work means tests build real instances rather than mocks that would need casts — so the concrete dependency does not reintroduce the mock-cast smell the rule guards against.
  `ScopedPermissionResolver`, `ToolCallGateInputs`, `SkillInputGateInputs`, and `SkillPermissionChecker` remain narrow interfaces.
- `@typescript-eslint/require-await`: keep handler `async` only where an `await` remains.
- When removing an export, every importer breaks at the type level in that commit — fold the interface deletion, the handler retype, and the consumer-test rewrite into one commit (testing skill).
- `fallow` suppression grammar: the kind token must be the exact singular `unused-class-member`, the only text after the directive (from the [#340] retro).
- Keep schema/example/docs aligned is not relevant here (no config change), but `.pi/skills/package-pi-permission-system/SKILL.md` documents the test fixtures and must be updated.

## Design Overview

### The recorder becomes a distinct collaborator

`session.recordSessionApproval(approval)` only ever calls `this.sessionRules.record(approval)`.
Make `SessionRules` implement `SessionApprovalRecorder` directly by renaming `record` → `recordSessionApproval` (its sole caller is the session method being deleted), then pass `sessionRules` as the runner's recorder:

```typescript
// index.ts (after)
const gateRunner = new GateRunner(resolver, sessionRules, gateway, reporter);
```

Runner call site is unchanged (`this.recorder.recordSessionApproval(descriptor.sessionApproval)`); only the injected object changes.
This is Tell-Don't-Ask: the runner tells `SessionRules` to record, and `SessionRules` owns the per-pattern fan-out loop it already has.

### The handlers depend on the resolver for queries

`AgentPrepHandler` and `SessionLifecycleHandler` gain a `PermissionResolver` (concrete) constructor dependency and call the query methods on it.
`PermissionGateHandler` does not — its `GateRunner` already owns the resolver, and it only needs the session's `activate` / `resolveAgentName`.

```typescript
// before-agent-start.ts (after) — sketch of the call site
shouldExposeTool(toolName, agentName, (t, a) => this.resolver.getToolPermission(t, a));
// ...
permissionStamp: this.resolver.getPolicyCacheStamp(agentName ?? undefined),
// ...
resolveSkillPromptEntries(prompt, this.resolver, agentName, ctx.cwd); // resolver satisfies SkillPermissionChecker
```

```typescript
// lifecycle.ts (after) — sketch of the call site
const policyIssues = this.resolver.getConfigIssues(agentName ?? undefined);
```

The resolver is a genuine second collaborator, not a relay: the handlers call distinct query methods on it directly (no reach-through), and the session keeps its own state/lifecycle surface.
The session and the resolver share the same injected `PermissionManager` + `SessionRules` (wired in `index.ts`), so there is no split-brain — the same guarantee Steps 4 ([#337]) and 7 ([#340]) established.

### PermissionSession after the step

`PermissionSession` becomes a pure state/lifecycle owner: context lifecycle (`activate`/`deactivate`/`getRuntimeContext`), session lifecycle (`resetForNewSession`/`shutdown`/`reload`), agent-start caching, skill entries, agent-name resolution, config gateway (`refreshConfig`/`logResolvedConfigPaths`/`config`), and infra inputs (`getInfrastructureReadDirs`/`getToolPreviewLimits`).
It implements no role interfaces explicitly; it still structurally satisfies `ToolCallGateInputs` (passed to `ToolCallGatePipeline`).

Removed methods (all dead after the handler rewiring):

```text
checkPermission, getToolPermission, getConfigIssues, getPolicyCacheStamp  → resolver owns these
getSessionRuleset                                                         → no production caller (resolver reads the ruleset internally)
recordSessionApproval                                                     → SessionRules owns it
```

### Test construction model (Option A)

The existing `createSession` factory in `permission-session.test.ts` already builds a real `PermissionSession` from per-collaborator fakes (`makePaths`, `makeLogger`, `makeForwarding`, `makeFakePermissionManager`, `makeConfigStore`, `makeGateway`).
Promote it into `test/helpers/session-fixtures.ts` as `makeRealSession(overrides)` and add `makeRealResolver(manager?, sessionRules?)` that constructs a real `PermissionResolver` over the fake manager + a real `SessionRules`.
Handler tests then build real collaborators and assert against them:

- `lifecycle.test.ts` / `before-agent-start.test.ts`: real session + real resolver; assertions shift from "session.refreshConfig was called" to "configStore.refresh was called with ctx" (and resolver/manager spies for the query methods).
- `external-directory-session-dedup.test.ts`: replace the hand-rolled stateful recorder + getSessionRuleset + resolver-delegation with a single real `SessionRules` used both as the recorder and inside a real resolver — the dedup now works natively (record → `getRuleset()` sees the session rule).
- `handler-fixtures.ts`: rebuild `makeHandler` to construct a real session + resolver + `SessionRules` recorder + real pipelines + runner.
  Preserve `makeHandler`'s override-bag keys and return shape so the 104 call sites migrate with minimal or no edits; route permission-result overrides (`checkPermission` / surface-check mocks) into the resolver's fake manager and add `recorder` to the returned bag for the dedup assertions.

## Module-Level Changes

Source (`src/`):

- `session-rules.ts` — rename `record(approval)` → `recordSessionApproval(approval)`; add `implements SessionApprovalRecorder` (import the interface).
- `permission-session.ts` — remove `checkPermission`, `getToolPermission`, `getConfigIssues`, `getPolicyCacheStamp`, `getSessionRuleset`, `recordSessionApproval`; remove the `implements` clause for `SessionApprovalRecorder`, `GateHandlerSession`, `AgentPrepSession`, `SessionLifecycleSession`; drop their imports (and the `SessionApproval` / `Rule` / `PermissionCheckResult` / `PermissionState` imports that become unused); update the class doc comment.
- `permission-resolver.ts` — remove the three `// fallow-ignore-next-line unused-class-member` directives on `getToolPermission`, `getConfigIssues`, `getPolicyCacheStamp` (now they have callers).
- `handlers/permission-gate-handler.ts` — retype the `session` parameter from `GateHandlerSession` to `PermissionSession`; drop the `GateHandlerSession` import.
- `handlers/before-agent-start.ts` — add a `resolver: PermissionResolver` constructor parameter; retype `session` to `PermissionSession`; route `getToolPermission` / `getPolicyCacheStamp` / the `resolveSkillPromptEntries` `SkillPermissionChecker` arg to `this.resolver`; drop the `AgentPrepSession` import.
- `handlers/lifecycle.ts` — add a `resolver: PermissionResolver` constructor parameter; retype `session` to `PermissionSession`; route `getConfigIssues` to `this.resolver`; drop the `SessionLifecycleSession` import.
- `skill-prompt-sanitizer.ts` — update the `SkillPermissionChecker` doc comment ("`PermissionManager` and `PermissionResolver` satisfy this structurally").
- `index.ts` — move the `resolver = new PermissionResolver(...)` construction above the handler construction; pass `resolver` into `AgentPrepHandler` and `SessionLifecycleHandler`; change `GateRunner`'s recorder argument from `session` to `sessionRules`.
- Delete `src/gate-handler-session.ts`, `src/agent-prep-session.ts`, `src/session-lifecycle-session.ts`.

Tests (`test/`):

- New `test/helpers/session-fixtures.ts` — `makeRealSession`, `makeFakePermissionManager`, `makeRealResolver`, and the small collaborator makers (promoted from `permission-session.test.ts`).
- `test/permission-session.test.ts` — import the promoted factory; remove the "constructor and delegation" tests for the six removed methods; rework the `shutdown` "clears session rules" test to drive `sessionRules.recordSessionApproval` / `sessionRules.getRuleset` directly.
- `test/session-rules.test.ts` — rename `record` tests to `recordSessionApproval`; add a `SessionApprovalRecorder`-conformance test.
- `test/handlers/lifecycle.test.ts` — replace the local `makeSession` (`SessionLifecycleSession` mock) with `makeRealSession` + `makeRealResolver`; retarget `getConfigIssues` assertions onto the resolver/manager.
- `test/handlers/before-agent-start.test.ts` — replace the local `makeSession` (`AgentPrepSession` mock) with `makeRealSession` + `makeRealResolver`; retarget `getToolPermission` / `getPolicyCacheStamp` / `checkPermission` assertions onto the resolver/manager.
- `test/helpers/handler-fixtures.ts` — rebuild `makeHandler` / `makeSession` to construct real session + resolver + `SessionRules` recorder; remove the `MockGateHandlerSession` intersection type and the `SessionApprovalRecorder` / `GateHandlerSession` imports; keep `makeSurfaceCheck` / `makeBashCommandCheck` but retarget them to feed the resolver's fake manager; add `recorder` to the returned bag.
- `test/handlers/external-directory-session-dedup.test.ts` — replace the stateful mock session with a real session + real resolver sharing one real `SessionRules`.
- `test/helpers/gate-fixtures.ts` — `makeGateRunner` already builds a `{ recordSessionApproval }` recorder; no change required (verify only).

Docs:

- `docs/architecture/architecture.md` — module-structure block: delete the `gate-handler-session.ts` / `agent-prep-session.ts` / `session-lifecycle-session.ts` lines; update the `permission-session.ts`, `session-rules.ts`, `permission-resolver.ts`, and the three `handlers/` entries; note the recorder is now `SessionRules` and the runner receives three distinct objects.
  Update Finding 2's narrative and the "Current health metrics" row (`PermissionSession` role interfaces implemented by one class 4 → 0).
  The roadmap "Step 8 ✓ complete" marking and the health-score re-measurement are done at `/ship-issue`.
- `.pi/skills/package-pi-permission-system/SKILL.md` — update the `handler-fixtures.ts` description: `MockGateHandlerSession` and the wide `makeSession` are gone; `makeHandler` builds a real session + resolver + `SessionRules` recorder and returns `recorder`; note the new `test/helpers/session-fixtures.ts`.

## Test Impact Analysis

1. New unit tests enabled by the extraction:
   - `SessionRules` gains a direct `recordSessionApproval` / `SessionApprovalRecorder`-conformance test (previously the behavior was only observed through `session.recordSessionApproval`).
   - The resolver's query methods (`getToolPermission` / `getConfigIssues` / `getPolicyCacheStamp`) are now exercised through real handler wiring rather than fallow-suppressed dead members.

2. Existing tests that become redundant:
   - The six "constructor and delegation" tests in `permission-session.test.ts` (delegation of `checkPermission` / `getToolPermission` / `getConfigIssues` / `getPolicyCacheStamp` / `getSessionRuleset` / `recordSessionApproval` to the manager/rules) — the methods are gone; the behavior moves to `PermissionResolver` tests and `SessionRules` tests, which already exist or are added.
   - The hand-rolled stateful recorder + resolver-delegation scaffolding in `external-directory-session-dedup.test.ts` collapses into a real `SessionRules` + real resolver.

3. Existing tests that must stay as-is (they exercise the layer being kept):
   - `permission-session.test.ts` tests for `activate`/`deactivate`, `resetForNewSession`, `shutdown` (cache/skill clearing), cache-key methods, skill entries, `resolveAgentName`, infra paths, config delegation, `reload`, `getRuntimeContext` — these cover the state/lifecycle surface that remains.
   - `runner.test.ts` recorder assertions stay; only the injected recorder object's identity changes (still asserted via the `deps.recordSessionApproval` mock from `gate-fixtures.ts`).
   - The 104 `makeHandler` call sites' behavioral assertions stay; only the fixture internals change.

## TDD Order

Lift-and-shift: keep the suite green at every commit by promoting the shared fixture first, moving the recorder, then retiring one interface per commit (each interface deletion + its handler retype + its consumer-test rewrite folded together), and finishing with the gate-handler fixture rebuild and docs.

1. Promote the real-session fixture to `test/helpers/`.
   - Surface: new `test/helpers/session-fixtures.ts` (`makeRealSession`, `makeFakePermissionManager`, `makeRealResolver`, collaborator makers); `permission-session.test.ts` imports them.
   - Covers: pure test refactor — no production change; the suite stays green.
   - Commit: `test: promote real-session fixture to test/helpers (#341)`.

2. Move the recorder role to `SessionRules`.
   - Surface: `session-rules.ts` (rename `record` → `recordSessionApproval`, `implements SessionApprovalRecorder`), `index.ts` (runner recorder = `sessionRules`), `permission-session.ts` (remove `recordSessionApproval` + `getSessionRuleset` + the `SessionApprovalRecorder` implements/import), `session-rules.test.ts`, `permission-session.test.ts` (remove the two delegation tests; rework `shutdown` test), `handler-fixtures.ts` + `external-directory-session-dedup.test.ts` (recorder = real/fake `SessionRules`; drop `recordSessionApproval`/`getSessionRuleset` from the mock).
   - Covers: the runner receives a distinct recorder; the session sheds the recorder/ruleset surface.
   - Commit: `refactor: move session-approval recorder to SessionRules (#341)`.

3. Retire `SessionLifecycleSession`; rewire the lifecycle handler to the resolver.
   - Surface: `lifecycle.ts` (add `resolver`, retype `session` to `PermissionSession`, `this.resolver.getConfigIssues`), delete `src/session-lifecycle-session.ts`, `permission-session.ts` (remove `getConfigIssues` + the interface implements/import), `permission-resolver.ts` (un-suppress `getConfigIssues`), `index.ts` (construct resolver before lifecycle; pass it in), `lifecycle.test.ts` (real session + resolver), `permission-session.test.ts` (remove the `getConfigIssues` delegation test).
   - Covers: lifecycle handler depends on concrete session + resolver; `SessionLifecycleSession` is gone.
   - Commit: `refactor: retire SessionLifecycleSession; depend on resolver (#341)`.

4. Retire `AgentPrepSession`; rewire the agent-prep handler to the resolver.
   - Surface: `before-agent-start.ts` (add `resolver`, retype `session`, route `getToolPermission` / `getPolicyCacheStamp` / the skill-checker arg to the resolver), delete `src/agent-prep-session.ts`, `permission-session.ts` (remove `getToolPermission` / `getPolicyCacheStamp` / `checkPermission` + the interface implements/import), `permission-resolver.ts` (un-suppress `getToolPermission` / `getPolicyCacheStamp`), `skill-prompt-sanitizer.ts` (doc comment), `index.ts` (pass resolver into `AgentPrepHandler`), `before-agent-start.test.ts` (real session + resolver), `permission-session.test.ts` (remove the three delegation tests).
   - Covers: agent-prep handler depends on concrete session + resolver; `AgentPrepSession` is gone.
   - Commit: `refactor: retire AgentPrepSession; depend on resolver (#341)`.

5. Retire `GateHandlerSession`; rebuild the gate-handler fixture.
   - Surface: `permission-gate-handler.ts` (retype `session` to `PermissionSession`; drop the import), delete `src/gate-handler-session.ts`, `permission-session.ts` (remove the last `GateHandlerSession` import — class now implements nothing explicitly), `handler-fixtures.ts` (rebuild `makeHandler`/`makeSession` on real session + resolver + `SessionRules` recorder + real pipelines; remove `MockGateHandlerSession`; preserve override-bag keys and return shape; add `recorder`), `external-directory-session-dedup.test.ts` (finalize on real session typing).
   - Covers: the last fig-leaf interface is gone; the gate handler depends on the concrete session; the 17-field intersection mock disappears.
   - Commit: `refactor: retire GateHandlerSession; rebuild handler fixture (#341)`.

6. Update architecture and skill docs.
   - Surface: `docs/architecture/architecture.md` (module structure, Finding 2 narrative, metrics row), `.pi/skills/package-pi-permission-system/SKILL.md` (fixture descriptions).
   - Covers: docs reflect the slimmed session, the `SessionRules` recorder, and the new test fixtures.
   - Commit: `docs: update architecture + skill for slimmed PermissionSession (#341)`.

## Risks and Mitigations

- Risk: the `makeHandler` rebuild (Step 5) ripples into 104 call sites.
  Mitigation: preserve `makeHandler`'s override-bag keys and return shape; route permission-result overrides into the resolver's fake manager so call sites migrate with minimal or no edits.
  Enumerate during TDD any call site that overrides a now-computed session method (`getInfrastructureReadDirs` / `getToolPreviewLimits`) and translate it to a collaborator config (`configStore`/`paths`) rather than a method stub.

- Risk: `lifecycle.test.ts` / `before-agent-start.test.ts` assertions that spy on `session.refreshConfig` / `resetForNewSession` no longer apply to a real session.
  Mitigation: shift those assertions to the injected collaborators the real methods drive (`configStore.refresh`, `permissionManager.configureForCwd`, `gateway.activate`), or use `vi.spyOn` on the real instance where the delegation target is internal.

- Risk: removing `session.checkPermission` while a test fixture still passes the session to `SkillInputGatePipeline`.
  Mitigation: `handler-fixtures` uses its own `MockGateHandlerSession` (not the real class), so the real-class removals do not break it until Step 5; in Step 5 wire the skill-input pipeline to the resolver (matching production).

- Risk: `fallow` flags the resolver query methods if a handler rewiring is missed.
  Mitigation: remove each suppression in the same commit that adds the first real caller; run `pnpm fallow dead-code` in the pre-completion check.

- Risk: concrete-class dependency reintroduces the "mock must cast" smell the package convention guards against.
  Mitigation: tests build real instances via the promoted `session-fixtures.ts` helpers — no casts; this is the constructibility payoff Step 1 set up.

## Open Questions

- Whether `makeSurfaceCheck` / `makeBashCommandCheck` should move into `session-fixtures.ts` alongside the resolver helpers or stay in `handler-fixtures.ts` — decide during Step 5 based on which files import them after the rebuild (defer until the call-site set is known).

[#334]: https://github.com/gotgenes/pi-packages/issues/334
[#337]: https://github.com/gotgenes/pi-packages/issues/337
[#338]: https://github.com/gotgenes/pi-packages/issues/338
[#339]: https://github.com/gotgenes/pi-packages/issues/339
[#340]: https://github.com/gotgenes/pi-packages/issues/340
[#342]: https://github.com/gotgenes/pi-packages/issues/342
