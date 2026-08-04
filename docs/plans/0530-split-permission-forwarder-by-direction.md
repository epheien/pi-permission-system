---
issue: 530
issue_title: "pi-permission-system: split PermissionForwarder by direction of authority flow"
---

# Split `PermissionForwarder` by direction of authority flow

## Release Recommendation

**Release:** ship independently

This is Phase 8 Step 6, tagged `Release: independent` in the roadmap; Steps 4–6 carry no batch.
It is a pure `refactor:` (a hidden changelog type), so it does not cut a release on its own — it lands on `main` and auto-batches into the next `feat:`/`fix:`/unhidden-`docs:` release.

## Problem Statement

`src/forwarded-permissions/permission-forwarder.ts` is a 578-line class holding two distinct roles that flow authority in opposite directions.
`requestApproval` escalates *up* toward the parent — a three-way dispatch (has-UI → direct dialog, not-a-subagent → deny, else → forward-and-poll) that Phase 9 will turn into `LocalUserAuthorizer` / `DenyingAuthorizer` / `ParentAuthorizer`.
`processInbox` serves escalations from *below* — draining this session's forwarded-request inbox and answering each.
The [architecture roadmap](../architecture/architecture.md) already names this split as preparatory work for the Phase 9 authority spine: doing it now means Phase 9 turns three already-named branches into three `Authorizer`s instead of first dissecting a dual-role class.

## Goals

- Split `PermissionForwarder` into two classes, one per direction of authority flow, each constructing with only its own dependencies.
- `ApprovalEscalator implements ApprovalRequester` — the escalation-up role: the three-way dispatch (each branch a named private method) plus the request-write/poll machinery.
- `ForwardedRequestServer implements InboxProcessor` — the serving-down role: `processInbox` plus the per-request serve flow.
- Relocate the forwarding subsystem into `src/authority/`; the `src/forwarded-permissions/` directory dissolves.
- Keep behavior, output, and config identical — this is a non-breaking `refactor:`.
- Keep the existing consumer seams intact: `PermissionPrompter` depends on `ApprovalRequester`, `ForwardingManager` on `InboxProcessor`.

## Non-Goals

- No behavior change: no new decision logic, no altered review-log events, no config-shape change.
  This is not breaking.
- Do not build the Phase 9 spine (`Authorizer` interface, `canConfirm()` dissolution, serving-as-resolution).
  The forwarded-inbox yolo serve arm stays as-is and dissolves with the spine, exactly as documented today.
- Do not touch `src/permission-forwarding.ts` (the cross-session constants module) or `src/forwarding-manager.ts` beyond its single import line.
- Do not rewrite the frozen history docs under `docs/architecture/history/` — they describe past state by design.

## Background

Relevant modules (all under `packages/pi-permission-system/`):

- `src/forwarded-permissions/permission-forwarder.ts` — the 578-line dual-role class.
  Exports `PermissionForwarder`, the two seam interfaces `ApprovalRequester` / `InboxProcessor`, the `ForwarderContext` read-interface, and `PermissionForwarderDeps`.
  Module-private helpers: `getSessionId` (used by *both* roles), `getContextSystemPrompt` (escalation only), `formatForwardedPermissionPrompt` (serving only).
- `src/forwarded-permissions/io.ts` — pure filesystem IO (request/response read-write, location derivation, atomic JSON writes, cleanup).
  Logger-null-tolerant; no dependency on `ForwarderContext`.
- `src/forwarding-manager.ts` — `ForwardingManager` (implements `ForwardingController`); imports `InboxProcessor`, drives inbox polling.
- `src/permission-prompter.ts` — imports `ApprovalRequester` (type only); delegates the UI/forwarding decision to the injected forwarder.
- `src/index.ts` — the composition root; constructs the single `PermissionForwarder` from `PermissionForwarderDeps` and injects it into both the prompter and the `ForwardingManager`.
- `src/authority/` — seeded by Step 5 (#529): holds `subagent-detection.ts` and `subagent-context.ts`.
  This step adds the forwarding modules here.

Test surface:

- `test/permission-forwarder.test.ts` — two `requestApproval` describes (escalation) + one `processInbox` describe (serving), all on the Step 4 (#528) harness (`test/helpers/forwarding-fixtures.ts`).
- `test/forwarded-permissions/io.test.ts` — the IO helper tests; imports from `#src/forwarded-permissions/io`.
- `test/helpers/forwarding-fixtures.ts` — `makeForwarderDeps`, `makeForwarderContext`, `makeUiDecision`, `createForwardingTempDir`, `makeSubagentRegistry`; imports `ForwarderContext` / `PermissionForwarderDeps`.

Constraints from AGENTS.md and the package skill that apply:

- When a roadmap step completes, mark it `✅` (step heading + Mermaid node) in `docs/architecture/architecture.md` in the implementation doc-update commit, not a deferred ship commit.
- `docs/architecture/architecture.md` names internal symbols in narrative prose and a module-layout tree; a `src/`-only grep misses them.
- `.pi/skills/package-*/SKILL.md` names `PermissionForwarder.requestApproval` in prose — a renamed symbol must be updated there too.
- `src` ships recursively in the `package.json` `files` allowlist, so relocating files within `src/` needs no allowlist edit.

### Dependency partition

The combined `PermissionForwarderDeps` (7 fields) partitions cleanly by role:

| Field                             | Escalation (`requestApproval`) | Serving (`processInbox`) |
| --------------------------------- | ------------------------------ | ------------------------ |
| `forwardingDir`                   | ✓                              | ✓                        |
| `logger`                          | ✓                              | ✓                        |
| `requestPermissionDecisionFromUi` | ✓                              | ✓                        |
| `detection`                       | ✓                              | —                        |
| `registry`                        | ✓                              | —                        |
| `config`                          | —                              | ✓ (yolo serve arm)       |
| `events`                          | —                              | ✓ (UI prompt broadcast)  |

Each new deps interface (5 fields) is strictly narrower than the current 7-field bag — the escalator never reads `config`/`events`, the server never reads `detection`/`registry`.
The escalation UI fast path does **not** emit a UI event (the prompter does — pinned by the "does not emit a UI prompt event" test), which is why the escalator drops `events`.

## Design Overview

### Target module layout (`src/authority/`)

```text
src/authority/
├── subagent-detection.ts        (existing, #529)
├── subagent-context.ts          (existing, #529)
├── forwarding-io.ts             (renamed from forwarded-permissions/io.ts; content unchanged)
├── forwarder-context.ts         (new: ForwarderContext + getSessionId)
├── approval-escalator.ts        (new: ApprovalEscalator + ApprovalRequester + ApprovalEscalatorDeps)
└── forwarded-request-server.ts  (new: ForwardedRequestServer + InboxProcessor + ForwardedRequestServerDeps)
```

`src/forwarded-permissions/` (both `permission-forwarder.ts` and `io.ts`) is deleted; the directory dissolves.

### Shared context module

`ForwarderContext` (the narrow `{ hasUI, ui, sessionManager }` read-interface) and `getSessionId(ctx)` (the ~8-line session-id reader) are shared by both classes and both seam interfaces.
Per the operator's decision, they get a dedicated cohesive home rather than being folded into `forwarding-io.ts` (which stays purely filesystem) or duplicated across the two sibling classes:

```typescript
// src/authority/forwarder-context.ts
export interface ForwarderContext {
  hasUI: boolean;
  ui: PermissionDecisionUi;
  sessionManager: {
    getSessionId(): string;
    getSessionDir(): string;
    getEntries(): readonly SessionEntryView[];
  };
}

export function getSessionId(ctx: ForwarderContext): string {
  /* unchanged body: try ctx.sessionManager.getSessionId(), trim, fallback "unknown" */
}
```

`getSessionId` becomes an exported function with two consumers (both classes), so fallow sees it as live.

### `ApprovalEscalator` (escalation-up)

```typescript
// src/authority/approval-escalator.ts
export interface ApprovalRequester {
  requestApproval(
    ctx: ForwarderContext,
    message: string,
    options?: RequestPermissionOptions,
    forwarded?: ForwardedPromptDisplay,
  ): Promise<PermissionPromptDecision>;
}

export interface ApprovalEscalatorDeps {
  forwardingDir: string;
  detection: SubagentDetector;
  registry?: SubagentSessionRegistry;
  logger: DebugReviewLogger;
  requestPermissionDecisionFromUi: (
    ui: PermissionDecisionUi,
    title: string,
    message: string,
    options?: RequestPermissionOptions,
  ) => Promise<PermissionPromptDecision>;
}

export class ApprovalEscalator implements ApprovalRequester { /* ... */ }
```

Owns `requestApproval` and the private `waitForForwardedApproval`, `buildForwardedRequest`, `pollForForwardedResponse`.
Module-private helper `getContextSystemPrompt` moves here (escalation-only).
Imports `getSessionId` / `ForwarderContext` from `forwarder-context.ts`, IO helpers from `forwarding-io.ts`.

### `ForwardedRequestServer` (serving-down)

```typescript
// src/authority/forwarded-request-server.ts
export interface InboxProcessor {
  processInbox(ctx: ForwarderContext): Promise<void>;
}

export interface ForwardedRequestServerDeps {
  forwardingDir: string;
  logger: DebugReviewLogger;
  config: ConfigReader;
  events?: PermissionEventBus;
  requestPermissionDecisionFromUi: (
    ui: PermissionDecisionUi,
    title: string,
    message: string,
    options?: RequestPermissionOptions,
  ) => Promise<PermissionPromptDecision>;
}

export class ForwardedRequestServer implements InboxProcessor { /* ... */ }
```

Owns `processInbox` and the private `processSingleForwardedRequest`.
Module-private helper `formatForwardedPermissionPrompt` moves here (serving-only).
Imports `getSessionId` / `ForwarderContext` from `forwarder-context.ts`, IO helpers from `forwarding-io.ts`.

### Composition-root call site (`index.ts`)

```typescript
const escalator = new ApprovalEscalator({
  forwardingDir: paths.forwardingDir,
  detection: subagentDetection,
  registry: subagentRegistry,
  logger,
  requestPermissionDecisionFromUi,
});
const requestServer = new ForwardedRequestServer({
  forwardingDir: paths.forwardingDir,
  logger,
  config: configStore,
  events: pi.events,
  requestPermissionDecisionFromUi,
});

const prompter = new PermissionPrompter({ logger, events: pi.events, forwarder: escalator });
// ...
session = new PermissionSession(
  paths,
  new ForwardingManager(subagentDetection, requestServer),
  /* ... */
);
```

The `forwardingDeps: PermissionForwarderDeps` intermediate is removed; each class takes its own inline deps object.
The prompter gets the escalator (`ApprovalRequester`), the manager gets the server (`InboxProcessor`) — matching the two seams they already depend on.

### Design-review pass

- **Dependency width** — both new deps interfaces (5 fields) are narrower than the old bag (7); every field is read by its owner.
  No wide interface.
- **Law of Demeter** — the classes call free IO functions and `getSessionId(ctx)`; no new reach-through chains.
- **Output arguments** — none; no writes back into injected deps.
- **Duplication** — `getSessionId` and `ForwarderContext` are shared via `forwarder-context.ts`, not duplicated.
  The two classes are genuinely different logical concerns (opposite authority directions), so keeping them separate is correct, not extractable duplication.

## Module-Level Changes

Production:

- **Add** `src/authority/forwarder-context.ts` — `ForwarderContext` interface + exported `getSessionId`.
- **Add** `src/authority/approval-escalator.ts` — `ApprovalEscalator`, `ApprovalRequester`, `ApprovalEscalatorDeps`; private `waitForForwardedApproval` / `buildForwardedRequest` / `pollForForwardedResponse`; module-private `getContextSystemPrompt`.
- **Add** `src/authority/forwarded-request-server.ts` — `ForwardedRequestServer`, `InboxProcessor`, `ForwardedRequestServerDeps`; private `processSingleForwardedRequest`; module-private `formatForwardedPermissionPrompt`.
- **Rename** `src/forwarded-permissions/io.ts` → `src/authority/forwarding-io.ts` (content unchanged).
- **Delete** `src/forwarded-permissions/permission-forwarder.ts`; **remove** the now-empty `src/forwarded-permissions/` directory.
- **Edit** `src/index.ts` — replace the `PermissionForwarder` import + `forwardingDeps` bag with `ApprovalEscalator` / `ForwardedRequestServer` imports and two inline deps objects; inject `escalator` into the prompter and `requestServer` into `ForwardingManager`.
- **Edit** `src/permission-prompter.ts` — import `ApprovalRequester` from `./authority/approval-escalator`.
- **Edit** `src/forwarding-manager.ts` — import `InboxProcessor` from `./authority/forwarded-request-server`.
- **Edit** `src/session-logger.ts` — the doc comment "Injected into `ConfigStore` and `PermissionForwarder`" → name the two new classes (prose-only).
- **Edit** `src/authority/subagent-detection.ts` — the doc comment naming `PermissionForwarder` (prose-only) → name `ApprovalEscalator` / `ForwardedRequestServer`.

Tests:

- **Split** `test/permission-forwarder.test.ts` → `test/authority/approval-escalator.test.ts` (the two `requestApproval` describes) + `test/authority/forwarded-request-server.test.ts` (the `processInbox` describe); delete the original.
- **Move** `test/forwarded-permissions/io.test.ts` → `test/authority/forwarding-io.test.ts` (import path → `#src/authority/forwarding-io`); remove the now-empty `test/forwarded-permissions/` directory.
- **Edit** `test/helpers/forwarding-fixtures.ts` — import `ForwarderContext` from `#src/authority/forwarder-context`; split `makeForwarderDeps` into `makeEscalatorDeps` (`ApprovalEscalatorDeps`) + `makeServerDeps` (`ForwardedRequestServerDeps`); keep `makeForwarderContext` / `makeUiDecision` / `createForwardingTempDir` / `makeSubagentRegistry`.
  Update the header comment referencing `PermissionForwarderDeps` / #530.

Docs (implementation doc-update commit):

- **Edit** `docs/architecture/architecture.md`:
  - Module-layout tree — replace the `forwarded-permissions/` block with `forwarding-io.ts`, `forwarder-context.ts`, `approval-escalator.ts`, `forwarded-request-server.ts` under `authority/`; drop the `forwarded-permissions/` node.
  - Roadmap Step 6 heading → `✅`; Mermaid node `S6` → `✅`.
  - Metrics table row `PermissionForwarder roles per class` → mark `✅` (2 → 1 each).
  - The Phase 8 "Findings" bullet describing the 591-LOC dual-role class stays (it is a historical finding), but verify no *current-state* prose still claims the class is unsplit.
- **Edit** `docs/architecture/permission-prompter.md` — lines naming `src/forwarded-permissions/permission-forwarder.ts`, `PermissionForwarder`, `PermissionForwarderDeps`, `new PermissionForwarder(forwardingDeps)` → `src/authority/approval-escalator.ts`, `ApprovalEscalator`, `ApprovalEscalatorDeps`, `new ApprovalEscalator({ ... })`.
- **Edit** `.pi/skills/package-pi-permission-system/SKILL.md` — `PermissionForwarder.requestApproval` → `ApprovalEscalator.requestApproval`.
- **Leave unchanged** `docs/architecture/history/phase-3-*.md` and `phase-5-*.md` — frozen historical records.

## Test Impact Analysis

1. **New tests the split enables** — none strictly *new*; the split lets each role's tests construct the narrower class with only its own deps (escalator tests no longer supply `config`/`events`; server tests no longer supply `detection`/`registry`), removing incidental setup.
   The existing behavior coverage transfers 1:1.
2. **Redundant tests** — none become redundant.
   The `requestApproval` and `processInbox` describes exercise genuinely different behavior; they relocate, they do not collapse.
3. **Tests that must stay as-is** — all of them.
   This is a lift-and-shift; every existing assertion (UI fast-path no-emit, non-subagent deny, forwarded-inbox emit/rich-emit/auto-approve/responses-race, and the full `io` suite) must stay green against the relocated code, since they pin the behavior the refactor must preserve.

## Invariants at risk

This step relocates surfaces earlier Phase 8 steps refactored; each documented outcome must stay green:

- Step 4 (#528) — the forwarding test harness (`forwarding-fixtures.ts`).
  Splitting `makeForwarderDeps` must keep `makeForwarderContext` / `createForwardingTempDir` / `makeSubagentRegistry` behavior identical; the migrated tests are the pin.
- Step 5 (#529) — `SubagentDetection` is the single owner of subagent detection; the escalator keeps `registry` for *target resolution only* and reads detection via the injected `SubagentDetector`.
  Do not re-introduce a second detection path.
  Pinned by the existing `requestApproval` non-subagent-deny test and the `subagent-detection` suite.
- Behavioral parity is pinned by the relocated `approval-escalator.test.ts` / `forwarded-request-server.test.ts` / `forwarding-io.test.ts` — no invariant lives only in prose here.

## TDD Order

This is a pure refactor, so each cycle is "relocate code + tests, keep the suite green" rather than red→green.
`pnpm --filter @gotgenes/pi-permission-system run check` and `run test` gate every step.
Sequenced tidy-first so each commit leaves the repo valid.

1. **Prep: rename `io.ts` → `forwarding-io.ts`; extract `forwarder-context.ts`.**
   Rename `src/forwarded-permissions/io.ts` → `src/authority/forwarding-io.ts` (content unchanged); add `src/authority/forwarder-context.ts` with `ForwarderContext` + exported `getSessionId`.
   Update `permission-forwarder.ts` to import IO helpers from `#src/authority/forwarding-io` and `ForwarderContext` / `getSessionId` from `#src/authority/forwarder-context` (remove its local `ForwarderContext` + `getSessionId`).
   Move `test/forwarded-permissions/io.test.ts` → `test/authority/forwarding-io.test.ts` (import → `#src/authority/forwarding-io`); remove `test/forwarded-permissions/`.
   `PermissionForwarder`, both seams, and all consumers still resolve — no consumer edits yet.
   Commit: `refactor(pi-permission-system): rename forwarding io and extract forwarder-context`.

2. **Extract `ForwardedRequestServer` (serving-down).**
   Add `src/authority/forwarded-request-server.ts` with `ForwardedRequestServer`, `InboxProcessor`, `ForwardedRequestServerDeps`, `processSingleForwardedRequest`, and module-private `formatForwardedPermissionPrompt`.
   Remove `processInbox` / `processSingleForwardedRequest` / `formatForwardedPermissionPrompt` / `InboxProcessor` from `permission-forwarder.ts`; narrow `PermissionForwarderDeps` to drop `config` + `events`.
   Update `forwarding-manager.ts` to import `InboxProcessor` from the new module, and `index.ts` to construct `ForwardedRequestServer` and pass it to `ForwardingManager`.
   Split the `processInbox` describe out of `permission-forwarder.test.ts` into `test/authority/forwarded-request-server.test.ts`; add `makeServerDeps` to `forwarding-fixtures.ts`.
   Removing an exported interface (`InboxProcessor`) and narrowing the deps bag breaks its importer and the object literal in `index.ts` in the same commit — fold the manager + index + test updates in here.
   Commit: `refactor(pi-permission-system): extract ForwardedRequestServer`.

3. **Rename the escalation role → `ApprovalEscalator`; dissolve `forwarded-permissions/`.**
   Move `src/forwarded-permissions/permission-forwarder.ts` → `src/authority/approval-escalator.ts`; rename `PermissionForwarder` → `ApprovalEscalator`, `PermissionForwarderDeps` → `ApprovalEscalatorDeps`; keep `ApprovalRequester` defined here; keep `getContextSystemPrompt` module-private.
   Remove the now-empty `src/forwarded-permissions/` directory.
   Update `index.ts` (construct `ApprovalEscalator`, inject into prompter) and `permission-prompter.ts` (import `ApprovalRequester` from `./authority/approval-escalator`).
   Rename `permission-forwarder.test.ts` → `test/authority/approval-escalator.test.ts`; rename `makeForwarderDeps` → `makeEscalatorDeps` (typed `ApprovalEscalatorDeps`) in `forwarding-fixtures.ts` and update its header comment.
   Removing the `ApprovalRequester` export's old home breaks the prompter import in the same commit — fold both in.
   Commit: `refactor(pi-permission-system): rename PermissionForwarder to ApprovalEscalator`.

4. **Doc-update commit.**
   Update `docs/architecture/architecture.md` (module tree, Step 6 heading + Mermaid `S6` → `✅`, `PermissionForwarder roles per class` metric row), `docs/architecture/permission-prompter.md` (class/deps/path/wiring names), and `.pi/skills/package-pi-permission-system/SKILL.md` (`ApprovalEscalator.requestApproval`); fix the `session-logger.ts` / `subagent-detection.ts` doc comments if not already handled inline.
   Commit: `docs(pi-permission-system): mark Phase 8 Step 6 complete; retarget forwarder docs`.

## Risks and Mitigations

- **Atomic type-break on export removal** — removing `InboxProcessor` / `ApprovalRequester` from their old homes breaks importers in the same commit.
  Mitigation: Steps 2 and 3 each fold the consumer + `index.ts` + test edits into the same commit, as the TDD order specifies; `pnpm run check` gates each.
- **Silent behavior drift in the yolo serve arm** — the serving role keeps its out-of-ruleset yolo check (dissolves with the Phase 9 spine).
  Mitigation: the relocated `forwarded-request-server.test.ts` "does not emit … when forwarded permission auto-approves" test pins it.
- **Stale symbol references in prose** — architecture/prompter docs and the package skill name the old symbols.
  Mitigation: Step 4 grep-sweep for `PermissionForwarder` / `forwarded-permissions` across `docs/` (excluding frozen `history/`) and `.pi/skills/`.
- **`ForwardingManager` unchanged behavior** — only its `InboxProcessor` import path changes.
  Mitigation: `forwarding-manager.test.ts` (untouched by Step 4 of #528) stays green.

## Open Questions

None.
The shared-context placement (dedicated `src/authority/forwarder-context.ts`) was confirmed with the operator during planning.
