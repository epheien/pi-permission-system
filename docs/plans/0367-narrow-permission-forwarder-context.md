---
issue: 367
issue_title: "Narrow `PermissionForwarder`'s context dependency to a local interface"
---

# Narrow `PermissionForwarder`'s context dependency to a local interface

## Problem Statement

`PermissionForwarder` (`src/forwarded-permissions/permission-forwarder.ts`) threads the full SDK `ExtensionContext` type through every public and private method, even though it reads only a handful of fields.
A wide SDK type reaching into a domain collaborator is platform-type threading.
The symptom is in the tests: `permission-forwarder.test.ts` builds partial context stubs and is forced into five `as unknown as ExtensionContext` casts because a `{ hasUI, ui }` literal can never satisfy the 16-member `ExtensionContext` interface.
This is the single biggest cluster of the 12 such casts across 7 test files (Phase 5 Track C, Step 6).

## Goals

- Define a narrow local `ForwarderContext` interface containing only the `ExtensionContext` fields `PermissionForwarder` actually reads.
- Change the forwarder's public method signatures (`requestApproval`, `processInbox`), its two seam interfaces (`ApprovalRequester`, `InboxProcessor`), and its private methods/helpers to accept that interface.
- Narrow the `requestPermissionDecisionFromUi` dependency's `ui` parameter from `ExtensionContext["ui"]` to the existing `PermissionDecisionUi` interface (the concrete injected implementation already takes `PermissionDecisionUi`).
- Narrow the shared collaborators the forwarder passes `ctx` into — `isSubagentExecutionContext` / `isRegisteredSubagentChild` (`subagent-context.ts`) and `getActiveAgentName` (`active-agent.ts`) — to local narrow context interfaces.
  This is **required**, not optional: passing a `ForwarderContext` value into a parameter typed `ExtensionContext` is a type error, so those collaborators must accept the narrower type for the forwarder narrowing to compile.
- Remove the five `as unknown as ExtensionContext` casts in `permission-forwarder.test.ts`, and the three incidental casts in `subagent-context.test.ts` (2) and `active-agent.test.ts` (1) that the collaborator narrowing makes removable.

This change is **not breaking**.
It narrows internal parameter types only — no observable behavior, output shape, public config, default, or exported runtime API changes.
None of the affected functions are part of the package's public surface (`index.ts` re-exports `PermissionForwarder` / `PermissionForwarderDeps`, but not the narrowed collaborators).
Narrowing a parameter type is backward-compatible for every existing caller, because a full `ExtensionContext` remains assignable to the narrower interface.

## Non-Goals

- The remaining four `as unknown as ExtensionContext` casts in `prompting-gateway.test.ts`, `permission-prompter.test.ts`, `config-store.test.ts`, and `test/helpers/handler-fixtures.ts` — a later Track C pass, out of scope here.
- Narrowing the `requestPermissionDecisionFromUi` dependency in `permission-event-rpc.ts` (it has its own `ui: ExtensionContext["ui"]` parameter) — independent consumer, later pass.
- Changing the reflective `getSystemPrompt` read in `getContextSystemPrompt` — its defensive `toRecord(ctx)` body is kept unchanged (see Design Overview).
- Marking Track C Step 6 `✓ complete` in `docs/architecture/architecture.md` — that is a shipping-time action performed during `/ship-issue`, not part of this refactor commit.

## Background

Relevant existing modules:

- `src/forwarded-permissions/permission-forwarder.ts` — the class under change.
  Fields it reads from the context: `ctx.hasUI`, `ctx.ui` (passed to the injected `requestPermissionDecisionFromUi`), `ctx.sessionManager.getSessionId()` (via the module-private `getSessionId` helper), and `ctx.getSystemPrompt()` (read reflectively via `toRecord(ctx).getSystemPrompt` in `getContextSystemPrompt`).
  It passes `ctx` into two shared collaborators: `isSubagentExecutionContext(ctx, …)` and `getActiveAgentName(ctx)`.
- `src/permission-dialog.ts` — already exports the narrow `PermissionDecisionUi` interface (`{ select, input }`), and `requestPermissionDecisionFromUi` already takes `PermissionDecisionUi`.
  The forwarder's `PermissionForwarderDeps.requestPermissionDecisionFromUi` field redundantly widens that parameter to `ExtensionContext["ui"]`; the injected implementation (wired in `index.ts`) is the `PermissionDecisionUi`-typed function, so narrowing the field to `PermissionDecisionUi` matches reality.
- `src/subagent-context.ts` — `isSubagentExecutionContext(ctx, subagentSessionsDir, registry?)` reads `ctx.sessionManager.getSessionId()` (via `isRegisteredSubagentChild`) and `ctx.sessionManager.getSessionDir()`; `isRegisteredSubagentChild(ctx, registry)` reads `ctx.sessionManager.getSessionId()`.
  Other callers — `forwarding-manager.ts`, `prompting-gateway.ts`, `service-lifecycle.ts` — all pass a full `ExtensionContext`, which stays assignable to the narrowed parameter.
- `src/active-agent.ts` — `getActiveAgentName(ctx)` reads `ctx.sessionManager.getEntries()` and inspects each entry's `type` / `customType` / `data` (it already casts each entry to `{ type; customType?; data? }` internally).
  Its other caller, `permission-session.ts`, passes a full `ExtensionContext`.
- `src/permission-prompter.ts` / `src/forwarding-manager.ts` — the two consumers that call `forwarder.requestApproval(ctx, …)` / `forwarder.processInbox(this.context)` through the `ApprovalRequester` / `InboxProcessor` seam interfaces.
  Both hold an `ExtensionContext`, which stays assignable to the narrowed seam parameter.

SDK shapes (from `@earendil-works/pi-coding-agent`):

- `ExtensionContext.sessionManager: ReadonlySessionManager` with `getSessionId(): string`, `getSessionDir(): string`, `getEntries(): SessionEntry[]`.
- `ExtensionContext.getSystemPrompt(): string`.

Precedents in this package (follow these conventions):

- `src/status.ts` already narrows context with `Pick<ExtensionContext, "hasUI" | "ui">`.
- Plan `0366` (the sibling Track C Step 5) established the pattern for these narrowing refactors: a single atomic `refactor:` commit, narrow interface types over concrete/wide types, "method bodies unchanged," and a deliberate reuse-over-strict-ISP stance for collaborator interfaces.

Constraint from the `code-design` skill (Dependency width / ISP): prefer lean local payload interfaces over full SDK types; a function's parameter type should not carry fields it never reads.

## Design Overview

This is a pure type-narrowing refactor.
No runtime behavior changes; only parameter and field types narrow.

### SDK-fidelity decisions (verified against the live SDK source)

The SDK signatures were checked in the development monorepo (`~/development/pi/pi`, `v0.79.1`) in addition to the pinned `0.75.4` in `node_modules`.
`getSessionId(): string`, `getSessionDir(): string`, `getEntries(): SessionEntry[]`, and the 9-member `SessionEntry` union are **identical** across both versions, so the narrow interfaces below are faithful to the SDK and upgrade-safe through the eventual `0.75.4 → 0.79.x` bump.

1. `getSessionDir(): string` — kept faithful to the SDK (no divergence).
   An earlier draft proposed `string | null` to accommodate the existing test stub (`getSessionDir: vi.fn().mockReturnValue(null)`).
   Investigation shows the SDK returns `string` in every version (`return this.sessionDir`), so `null` is unreachable at runtime; the production guard `if (!sessionDir) return false` in `isSubagentExecutionContext` is really guarding the **empty-string** case (`""`, reachable for in-memory / dir-less sessions), which is a valid `string`.
   The narrow interface therefore declares `getSessionDir(): string`, and the `subagent-context.test.ts` `makeCtx` stub coerces an absent dir to `""` (`vi.fn(() => sessionDir ?? "")`) instead of returning `null`.
   This keeps the type exactly the SDK's, still exercises the falsy-dir guard (`""` is falsy → same branch), and requires no call-site churn (`makeCtx(null)` callers stay as-is; the coercion lives in the helper).
   The lone inline throw-stub context returns `""` for `getSessionDir` as well.
2. A minimal `SessionEntryView` for `getEntries` (the one genuine narrowing of an element type).
   `getActiveAgentName` reads only `type` / `customType` / `data` from each entry, and its tests build simplified literals (e.g. `{ type: "message", data: { name: "agent" } }`) that are not assignable to the SDK's `SessionEntry` discriminated union.
   The narrow context declares `getEntries(): readonly SessionEntryView[]` where `SessionEntryView = { type: string; customType?: string; data?: unknown }`.
   The SDK `SessionEntry` is assignable to `SessionEntryView` (it has `type` at minimum), so full-`ExtensionContext` callers are unaffected, and the internal per-entry cast in `getActiveAgentName` disappears.
   This is not a divergence so much as **naming the structural slice the function already operated on**: the SDK `SessionEntry` is a discriminated union of nine variants the function never inspects, and the test fixtures' simplified literals (e.g. `{ type: "tool_call", customType: "active_agent", data: {…} }`) are not assignable to that union — building real `CustomEntry` literals just to test name-extraction would be pure ceremony.

### Collaborator narrow interfaces

`active-agent.ts` — minimal entry view plus the reader context:

```typescript
/** Minimal session-entry view: the fields getActiveAgentName reads. */
export interface SessionEntryView {
  type: string;
  customType?: string;
  data?: unknown;
}

/** Narrow context for getActiveAgentName — reads only session entries. */
export interface ActiveAgentContext {
  sessionManager: { getEntries(): readonly SessionEntryView[] };
}

export function getActiveAgentName(ctx: ActiveAgentContext): string | null;
```

`subagent-context.ts` — one module-local context reused by both functions (reuse-over-strict-ISP, matching the 0366 precedent; `isRegisteredSubagentChild` reads only `getSessionId`, but sharing one interface keeps the module's contract consistent and both test stubs already provide both methods):

```typescript
/** Narrow context for subagent detection — reads session id and dir. */
export interface SubagentDetectionContext {
  sessionManager: {
    getSessionId(): string;
    getSessionDir(): string;
  };
}

export function isRegisteredSubagentChild(
  ctx: SubagentDetectionContext,
  registry: SubagentSessionRegistry,
): boolean;

export function isSubagentExecutionContext(
  ctx: SubagentDetectionContext,
  subagentSessionsDir: string,
  registry?: SubagentSessionRegistry,
): boolean;
```

### Forwarder narrow context

`permission-forwarder.ts` defines `ForwarderContext`, a standalone interface (defined standalone rather than `extends`-ing the collaborator interfaces, to avoid cross-module type coupling; its `sessionManager` is a superset of both collaborator needs, so a `ForwarderContext` value is assignable to both `SubagentDetectionContext` and `ActiveAgentContext`):

```typescript
/**
 * Narrow context the forwarder reads: UI gate + dialog UI + the three
 * session-manager readers used directly or via isSubagentExecutionContext /
 * getActiveAgentName. getSystemPrompt is read reflectively (see
 * getContextSystemPrompt), so it is intentionally not a typed member.
 */
export interface ForwarderContext {
  hasUI: boolean;
  ui: PermissionDecisionUi;
  sessionManager: {
    getSessionId(): string;
    getSessionDir(): string;
    getEntries(): readonly SessionEntryView[];
  };
}
```

`SessionEntryView` is imported from `active-agent.ts` (reused, not redefined).

The seam interfaces and the `requestPermissionDecisionFromUi` dependency narrow accordingly:

```typescript
export interface ApprovalRequester {
  requestApproval(
    ctx: ForwarderContext,
    message: string,
    options?: RequestPermissionOptions,
    forwarded?: ForwardedPromptDisplay,
  ): Promise<PermissionPromptDecision>;
}

export interface InboxProcessor {
  processInbox(ctx: ForwarderContext): Promise<void>;
}

export interface PermissionForwarderDeps {
  // …unchanged fields…
  requestPermissionDecisionFromUi: (
    ui: PermissionDecisionUi, // was ExtensionContext["ui"]
    title: string,
    message: string,
    options?: RequestPermissionOptions,
  ) => Promise<PermissionPromptDecision>;
}
```

All private methods (`waitForForwardedApproval`, `buildForwardedRequest`, `processSingleForwardedRequest`) and the module-private helpers (`getSessionId`, `getContextSystemPrompt`) change their `ctx: ExtensionContext` parameter to `ctx: ForwarderContext`.
`getContextSystemPrompt` keeps its reflective `toRecord(ctx).getSystemPrompt` body unchanged — `toRecord` accepts `unknown`, so it compiles against `ForwarderContext`, and the defensive behavior (tolerating a missing `getSystemPrompt`) is preserved.

### Consumer call sites (verify assignability, no edits)

```typescript
// permission-prompter.ts (ctx: ExtensionContext from its handler)
const decision = await this.deps.forwarder.requestApproval(ctx, message, …);
// forwarding-manager.ts (this.context: ExtensionContext | null, null-guarded)
void this.forwarder.processInbox(this.context).finally(…);
```

`ExtensionContext` is assignable to `ForwarderContext` (it has all members, with `getSessionDir(): string` matching exactly and `SessionEntry[]` assignable to `readonly SessionEntryView[]`), so both consumers compile with no change.
`PermissionForwarder` continues to satisfy `implements ApprovalRequester, InboxProcessor` with the narrowed seam types.

### Edge cases

- None affecting runtime — method bodies are untouched.
- The UI fast path in `requestApproval` (`if (ctx.hasUI) …`) returns before touching `sessionManager`, but `sessionManager` is still a required member of `ForwarderContext` (other paths read it unconditionally), so the test fixtures must supply it (see Test Impact Analysis).
- The only failure mode is a compile error from an incorrectly narrowed type; `pnpm run check` catches it at the commit boundary.

## Module-Level Changes

- `src/active-agent.ts` — add exported `SessionEntryView` and `ActiveAgentContext`; change `getActiveAgentName`'s parameter to `ActiveAgentContext`; drop the now-redundant per-entry `as { type; … }` cast (the element type is already `SessionEntryView`); drop the now-unused `ExtensionContext` import if nothing else uses it.
- `src/subagent-context.ts` — add exported `SubagentDetectionContext`; change `isRegisteredSubagentChild` and `isSubagentExecutionContext` parameters to it; keep the `SubagentSessionRegistry` import; drop the `ExtensionContext` import if unused afterward.
- `src/forwarded-permissions/permission-forwarder.ts` — add `ForwarderContext`; import `PermissionDecisionUi` (from `#src/permission-dialog`) and `SessionEntryView` (from `#src/active-agent`); change `ApprovalRequester`, `InboxProcessor`, `PermissionForwarderDeps.requestPermissionDecisionFromUi`, the stored field's type, the two public methods, the three private methods, and the two module-private helpers from `ExtensionContext` to `ForwarderContext` / `PermissionDecisionUi`; keep the `ExtensionContext` import only if a residual reference remains (expected: none — verify and remove).
- `test/active-agent.test.ts` — retype `makeCtx` to return `ActiveAgentContext` (or a plain object satisfying it); remove its one `as unknown as ExtensionContext` cast; drop the `ExtensionContext` import.
- `test/subagent-context.test.ts` — retype `makeCtx` and the inline throw-stub context to `SubagentDetectionContext`; coerce the `getSessionDir` stub to a `string` (`vi.fn(() => sessionDir ?? "")`; inline stub returns `""`) so it satisfies the faithful `getSessionDir(): string` without a cast; remove its two `as unknown as ExtensionContext` casts; drop the `ExtensionContext` import.
- `test/permission-forwarder.test.ts` — add a small `makeCtx(overrides)` helper that returns a `ForwarderContext` with default `vi.fn()` session-manager stubs; rewrite the five inline context literals to use it; remove all five `as unknown as ExtensionContext` casts; drop the `ExtensionContext` import.
- `docs/architecture/architecture.md` — no change in this plan; the `✓ complete` mark on Track C Step 6 (and any reader-cast count update) is applied at ship time.

Grep confirmation performed while planning:

- The narrowed collaborators are called from `permission-forwarder.ts`, `forwarding-manager.ts`, `prompting-gateway.ts`, `service-lifecycle.ts`, `permission-session.ts` (production, all pass full `ExtensionContext`) and are `vi.mock`-ed in `forwarding-manager.test.ts` / `service-lifecycle.test.ts` / `permission-session.test.ts` (mocked, no real-type dependency).
- `index.ts` re-exports only `PermissionForwarder` / `PermissionForwarderDeps`; the narrowed collaborators and `ForwarderContext` are not part of the public surface.
- No `.pi/skills/package-pi-permission-system/SKILL.md` reference names these parameter types.

## Test Impact Analysis

1. New tests enabled — none required.
   The change makes the existing fixtures honest (plain objects satisfying narrow interfaces) without adding coverage.
   `subagent-context.test.ts` and `active-agent.test.ts` already unit-test the narrowed collaborators directly; those suites simply lose their casts.
2. Tests becoming redundant — none.
   Every assertion still pertains; only the context-stub construction simplifies.
3. Tests that must stay as-is — all of them.
   `permission-forwarder.test.ts` genuinely exercises `requestApproval` / `processInbox`; the change only removes the casts the wide `ExtensionContext` type forced.
   The forwarder fixtures additionally gain the previously-omitted `sessionManager` stub methods (e.g. the UI-fast-path stub gains `getSessionId` / `getSessionDir` / `getEntries`) because `sessionManager` is a required member of `ForwarderContext`; the shared `makeCtx` helper absorbs this so each test stays focused on its own overrides.

## TDD Order

This is a single atomic type change: the production narrowing and the test simplification must land in the same commit to keep the tree green (removing a cast before the parameter narrows, or vice versa, leaves `tsc` red).
There is no incremental lift-and-shift here — no large test file is rewritten wholesale, and no export is removed (only parameter types narrow and small interfaces are added).

1. Red → Green → Commit — narrow the forwarder context and its collaborators.
   - Red: in the three test files, remove the eight `as unknown as ExtensionContext` casts, retype/add the `makeCtx` helpers to the narrow interfaces, and add the missing `sessionManager` stub methods to the forwarder fixtures.
     `pnpm run check` (tsc) fails: plain objects typed as the narrow interfaces do not satisfy the still-`ExtensionContext` parameters.
   - Green: add `SessionEntryView` / `ActiveAgentContext` to `active-agent.ts`, `SubagentDetectionContext` to `subagent-context.ts`, and `ForwarderContext` to `permission-forwarder.ts`; narrow all the parameters/fields/imports listed in Module-Level Changes; drop the now-redundant internal cast in `getActiveAgentName`.
     `pnpm run check`, `pnpm run lint`, and `pnpm run test` pass; `index.ts`, `permission-prompter.ts`, and `forwarding-manager.ts` need no edit.
   - Commit: `refactor: narrow PermissionForwarder context to a local interface (#367)`.

## Risks and Mitigations

- Risk: the narrowing ripples beyond the forwarder into two shared collaborator modules, which is wider than the issue's literal "change the forwarder's method signatures."
  Mitigation: it is forced by the type system (the forwarder passes `ctx` into those collaborators), the consequence is purely beneficial (three additional casts removed), and every other caller of those collaborators passes a full `ExtensionContext` that stays assignable — verified by grep.
  No public API or runtime behavior changes.
- Risk: `SessionEntryView` is a local element type rather than the SDK `SessionEntry` union, so a future SDK change to the entry shape would not auto-propagate.
  Mitigation: it names exactly the three fields `getActiveAgentName` reads, the SDK union stays assignable to it, and the signatures were verified identical across the pinned `0.75.4` and the dev `v0.79.1` SDK — so the eventual upgrade does not break it.
  `getSessionDir` / `getSessionId` / `getEntries` are kept at their exact SDK signatures (no divergence), so the only standing local type is `SessionEntryView`.
- Risk: a hidden caller passing something that is *not* a full `ExtensionContext` could rely on a field the narrow interface drops.
  Mitigation: grep confirms all production callers pass `ExtensionContext`; mocked callers use `vi.mock` and do not depend on the real parameter type.
- Risk: forgetting one parameter (e.g. a private method) leaves a residual `ExtensionContext` reference and a stranded import.
  Mitigation: removing the `ExtensionContext` import is part of each step; `pnpm run check` and `pnpm fallow dead-code` flag any residual reference or unused import at the commit boundary.

## Open Questions

- None.
  The design is determined by the issue, the type constraints, and the 0366 precedent; deferred items (the remaining four casts, `permission-event-rpc.ts`, the roadmap completion mark) are captured under Non-Goals.
