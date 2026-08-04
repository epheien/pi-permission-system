---
issue: 385
issue_title: "pkg:pi-permission-system — Respect pi default active tool set instead of activating all non-denied tools"
---

# Respect pi's default active tool set in `before_agent_start`

## Problem Statement

`AgentPrepHandler.handle()` (`src/handlers/before-agent-start.ts`) builds the active tool set from `pi.getAllTools()` — _every_ registered tool — and re-activates all of them except those explicitly denied.
Pi ships `find`, `grep`, and `ls` as built-in tools that are **off by default** (pi's default active set is `read`, `bash`, `edit`, `write`).
Because the handler starts from the full registry, it silently turns these off-by-default tools _on_ in every session, overriding pi's own activation decision.

This produces two downstream symptoms:

1. The main session always sees `find`, `grep`, `ls`, defeating pi's default of keeping them inactive.
2. The only workaround — denying them globally (`"find": "deny"`) — also strips them from subagents that explicitly request them via `tools:` frontmatter, since `before_agent_start` fires for subagent sessions too.

The fix is to start from `pi.getActiveTools()` (pi's _already-active_ set for the current session) instead of `pi.getAllTools()`.
The permission system then only ever **removes** tools (deny) — it never grants a tool pi left off.
This is the restrict-only contract the extension is meant to honor.

Ben Tang (@0xbentang) reported this issue and submitted reference PR [#386], which is the basis for this plan.
This plan adopts that approach and improves on it in two places: the `getActive()` type fidelity and an explicit regression test (see Design Overview).
The implementation commits should credit Ben with a `Co-authored-by: Ben Tang <bentang@fastmail.com>` trailer (see TDD Order).

## Goals

- Add `getActive()` to the `ToolRegistry` interface, wired to `pi.getActiveTools()` in `index.ts`.
- Change `AgentPrepHandler.handle()` to compute the allowed set from `getActive()` instead of `getAll()`.
- Preserve `getAll()` for `PermissionGateHandler` tool-call validation — registration checks must still see the full registry.
- Type `getActive(): string[]` to match the real `pi.getActiveTools(): string[]` contract (PR #386 typed it `unknown[]`); update mocks/fakes to return `string[]` for fidelity.
- Add a regression test proving off-by-default tools (`find`/`grep`/`ls`) present in the registry but absent from the active set are **not** activated.
- **Breaking change.**
  On upgrade, the main session's effective tool set changes without a user edit: tools pi leaves off (e.g. `find`, `grep`, `ls`) are no longer auto-activated by the permission system.
  Users who want them active should launch pi with the `--tools` CLI flag (there is no persistent config-file key for the active set).
  Ship as `fix!:` with a `BREAKING CHANGE:` footer.

## Non-Goals

- No escape hatch to re-grant pi's off-by-default tools through permission config.
  The extension stays restrict-only; activating tools is pi's job — done at launch via the `--tools` / `-t` CLI flag (e.g. `pi --tools read,bash,edit,write,grep,find,ls`) or programmatically via `createAgentSession({ tools: [...] })`.
  There is no persistent settings-file key for the active tool set.
- No change to `PermissionGateHandler` / `validateRequestedTool` — tool-call validation continues to use `getAll()` (the full registry), which is correct: a denied-but-registered tool should still validate as "registered" and then be gated, not rejected as "unknown".
- No split of the `ToolRegistry` interface (see Design Overview — track-and-watch, not now).
- No change to skill or prompt sanitization logic in the handler.

## Background

Relevant modules:

- `src/handlers/before-agent-start.ts` — `AgentPrepHandler.handle()` is the only Phase-1 (tool-filtering) consumer.
  It currently calls `this.toolRegistry.getAll()`, maps each entry through `getToolNameFromValue`, drops denied tools via `shouldExposeTool`, then `setActive(allowedTools)` (guarded by the `activeToolsGate` cache).
- `src/tool-registry.ts` — the narrow `ToolRegistry` interface (`getAll(): unknown[]`, `setActive(names: string[]): void`) plus `getToolNameFromValue` and the registration-check helpers used by `PermissionGateHandler`.
- `src/index.ts` (~line 153) — composition root wires `toolRegistry = { getAll: () => pi.getAllTools(), setActive: (n) => pi.setActiveTools(n) }`.
- `src/handlers/permission-gate-handler.ts` — Phase-2 (`tool_call`) consumer; calls `this.toolRegistry.getAll()` for `validateRequestedTool`.
  **Stays on `getAll()`.**

Pi SDK contract (`@earendil-works/pi-coding-agent`, `core/extensions/types.d.ts`):

- `getActiveTools(): string[]` — currently active tool **names**.
- `getAllTools(): ToolInfo[]` — all configured tools as objects (`{ name, description, parameters, promptGuidelines, ... }`).
- `setActiveTools(toolNames: string[]): void`.

Note the shape asymmetry: `getActiveTools` returns `string[]`, `getAllTools` returns `ToolInfo[]`.
`getToolNameFromValue` already handles both a bare string (via `getNonEmptyString`) and an object (via `.name`/`.toolName`/`.tool`), so the handler loop works unchanged regardless of source.

AGENTS.md / skill constraints that apply:

- `@typescript-eslint/require-await` is enabled for `src/` — the handler is already `async` with an `eslint-disable` line; unchanged.
- Keep schema/example/docs/types aligned — this change touches no config field, but it does touch `docs/configuration.md` Pi-integration-hooks behavior wording (clarify restrict-only).
- The handler fires for subagent sessions too; `getActiveTools()` returns the subagent's own active set there, so deny still correctly prunes a subagent's requested tools — behavior unchanged on that axis.

## Design Overview

### Decision model

`before_agent_start` recomputes the active set on every fire.
Switching the base set from "all registered" to "currently active" makes the operation purely subtractive:

```text
allowed = getActive()  minus  { tools denied for this agent }
setActive(allowed)
```

Idempotence check (no oscillation across repeated fires):

- Fire 1: active = `[read, bash, edit, write]`, deny `bash` → allowed = `[read, edit, write]` → `setActive([read, edit, write])`.
- Fire 2: `getActive()` now returns `[read, edit, write]` (what we just set); `bash` already absent → allowed = `[read, edit, write]`.
  Stable; the `activeToolsGate` cache short-circuits the redundant `setActive`.

Because the set only shrinks toward a fixed point, there is no risk of the handler re-adding or thrashing tools across fires.

### Type shape

`pi.getActiveTools()` returns `string[]`, so the interface reflects that directly:

```typescript
export interface ToolRegistry {
  getAll(): unknown[]; // ToolInfo[] from pi.getAllTools() — kept defensively wide
  getActive(): string[]; // names from pi.getActiveTools()
  setActive(names: string[]): void;
}
```

The handler change is a single line — `getAll()` → `getActive()`.
The loop keeps `getToolNameFromValue(tool)`: it accepts a bare string and returns it (filtering empties), so the defensive normalization stays in place and the diff stays minimal.

### Consumer call site (composition root, `index.ts`)

```typescript
const toolRegistry = {
  getAll: () => pi.getAllTools(),
  getActive: () => pi.getActiveTools(), // string[]
  setActive: (names: string[]) => pi.setActiveTools(names),
};
```

`AgentPrepHandler` reads `getActive` + `setActive`; `PermissionGateHandler` reads `getAll`.
No reach-through, no output arguments, no mutation of the registry — Tell-Don't-Ask and LoD hold.

### Design-review note (shared interface gaining a field)

After this change the two consumers use disjoint slices of `ToolRegistry`: `AgentPrepHandler` → `{ getActive, setActive }`, `PermissionGateHandler` → `{ getAll }`.
That is a latent ISP seam (the interface could split into an active-tool controller vs. a registry reader).
Splitting a 3-method interface now is premature — **track-and-watch**.
Record it; revisit only if the interface grows or a third consumer appears.

### Edge cases

- **Empty active set.**
  If `getActiveTools()` returns `[]` (e.g. a session with no tools yet), `setActive([])` is a no-op-equivalent — same as today when all tools are denied.
- **Subagent session.**
  `getActiveTools()` returns the subagent's frontmatter-driven set; deny still prunes it.
  Behavior on that axis is unchanged (this is the point — global deny still blocks a subagent, but you no longer _need_ to deny `find`/`grep`/`ls`, so the symptom disappears).
- **Lifecycle timing risk** — see Risks: must confirm `getActiveTools()` is already populated when `before_agent_start` fires.

## Module-Level Changes

- `src/tool-registry.ts` — add `getActive(): string[]` to the `ToolRegistry` interface.
  No other code in this file changes (`getToolNameFromValue` and the registration helpers are untouched).
- `src/index.ts` — add `getActive: () => pi.getActiveTools()` to the `toolRegistry` literal (~line 154).
- `src/handlers/before-agent-start.ts` — replace `const allTools = this.toolRegistry.getAll();` with `this.toolRegistry.getActive();`.
  Update the constructor JSDoc that lists deps as "getAll + setActive" → "getActive + setActive". (`PermissionGateHandler`'s JSDoc still says "getAll + setActive" and stays accurate — it uses getAll.)
- `docs/configuration.md` — clarify the `before_agent_start` row / "Additional behaviors" list: the permission system filters pi's **already-active** tool set (restrict-only) and does not activate tools pi leaves off by default.

Test files (fixtures + specs):

- `test/handlers/before-agent-start.test.ts` — add `getActive` to the local `makeToolRegistry`; migrate the three `getAll`-based active-set assertions to `getActive` returning `string[]`; add the regression test.
- `test/helpers/handler-fixtures.ts` — add `getActive: vi.fn().mockReturnValue(["read", "bash"])` to the shared `makeToolRegistry`.
- `test/handlers/external-directory-session-dedup.test.ts` — add `getActive` to the two inline tool-registry stubs (return `string[]`).
- `test/handlers/tool-call.test.ts` — add `getActive` to the two stubs (these exercise `PermissionGateHandler`, which uses `getAll`; `getActive` is added only to satisfy the interface — return `string[]`).
- `test/helpers/make-fake-pi.ts` — add `getActiveTools(): string[]` returning `toolNames` (bare names, matching the real SDK shape) and add it to the `FakePi` interface.
- `test/permission-events.test.ts`, `test/session-start.test.ts` — add `getActiveTools` to the fake `ExtensionAPI` objects (composition-root wiring tests).

Grep confirmation performed: `getAll` / `getActive` / `setActive` consumers are exactly the two handlers above; no `.pi/skills/package-*/SKILL.md` references the `ToolRegistry` method names; `docs/architecture/architecture.md:504` describes `AgentPrepHandler`'s deps generically (`toolRegistry`) without enumerating method names, so no architecture-doc edit is required.

## Test Impact Analysis

This is a one-line behavior change on a shared seam, not an extraction, so the test surface is mostly fixture plumbing.

1. **New tests enabled:** a focused regression test that was previously impossible to express because the handler ignored the active/registered distinction — given `getActive() = [read, bash, edit, write]` and `getAll() = [...those, find, grep, ls]` (all permission-allowed), assert `setActive` is called with exactly `[read, bash, edit, write]`.
   Under the old code (using `getAll`) this would have activated all seven; it is the canonical guard for #385.
2. **Redundant/changed tests:** the three existing assertions ("filters out denied tools", "includes allowed and ask tools", "calls setActive once") move their mock from `getAll` to `getActive` and switch the returned shape to `string[]`.
   They are not redundant — they still verify deny-filtering, allow/ask inclusion, and cache dedup — but they now exercise the correct source.
3. **Tests that stay as-is:** `shouldExposeTool` pure-helper tests (unaffected), prompt-sanitization tests, skill-entry tests, and all `PermissionGateHandler` / `validateRequestedTool` tests (still validate against `getAll`).

## TDD Order

1. **Interface + composition-root wiring.**
   Red: add `getActive` to `ToolRegistry`; the type checker / composition-root tests fail until `index.ts` and every fake/fixture implement it.
   Green: add `getActive: () => pi.getActiveTools()` to `index.ts`; add `getActiveTools` to `make-fake-pi.ts`, `handler-fixtures.ts` `makeToolRegistry`, and the two composition-root fake APIs (`permission-events.test.ts`, `session-start.test.ts`).
   Because adding a method to the interface breaks every implementer at the type level in one commit, fold the interface addition, the `index.ts` wiring, and all fixture/fake updates into this single step.
   Commit: `feat: add getActive to ToolRegistry wired to pi.getActiveTools (#385)`.

2. **Regression test for off-by-default tools (red→green).**
   Red: in `before-agent-start.test.ts`, add the test — `getActive` returns `[read, bash, edit, write]`, all permission-allowed — asserting `setActive` is called with exactly `[read, bash, edit, write]`.
   With the handler still on `getAll`, this fails (or is wired to `getAll` returning the superset and fails by including `find`/`grep`/`ls`).
   Green: change `AgentPrepHandler.handle()` to call `getActive()`; update the three existing active-set assertions to use `getActive` returning `string[]`; add `getActive` to the inline stubs in `external-directory-session-dedup.test.ts` and `tool-call.test.ts`.
   Commit: `fix!: respect pi's default active tool set in before_agent_start (#385)` with a `BREAKING CHANGE:` footer noting that the permission system no longer auto-activates pi's off-by-default tools (`find`, `grep`, `ls`) in the main session; users wanting them active should launch pi with `--tools read,bash,edit,write,grep,find,ls` (no persistent config-file key exists for the active set).

3. **Docs.**
   Update `docs/configuration.md` to clarify the restrict-only filtering behavior.
   Commit: `docs: clarify before_agent_start filters pi's active tool set (#385)`.

Steps 1 and 2 could be merged (the interface addition and handler switch are tightly coupled), but keeping the regression test and behavior flip in their own `fix!:` commit isolates the breaking change for the changelog.
Prefer the split.

Add a `Co-authored-by:` trailer to the implementation commits (steps 1 and 2 at minimum) to credit the reporter and reference-PR author:

```text
Co-authored-by: Ben Tang <bentang@fastmail.com>
```

## Risks and Mitigations

- **Lifecycle timing — is `getActiveTools()` populated when `before_agent_start` fires?**
  If pi initializes its default active set _after_ this event, `getActiveTools()` could return an empty or unexpected set, breaking tool exposure entirely.
  Mitigation: verify against the `pi-extension-lifecycle` skill and/or a live smoke test that `getActiveTools()` returns pi's defaults (`read`, `bash`, `edit`, `write`) at `before_agent_start` time before relying on it.
  The reference PR #386 was authored by the issue reporter, suggesting they validated this empirically — confirm during TDD.
- **Test fidelity drift.**
  PR #386's mocks return objects (`{ name: "write" }`) for `getActive`, but the real API returns `string[]`.
  Mitigation: this plan types `getActive(): string[]` and returns bare strings from every mock/fake so tests match the real contract.
- **Breaking-change surprise for existing users.**
  Users relying on `find`/`grep`/`ls` being active in the main session lose them on upgrade.
  Mitigation: prominent `BREAKING CHANGE:` footer + changelog (release-please) pointing to the `--tools` CLI flag as the supported way to enable them.

## Open Questions

- Does pi guarantee `getActiveTools()` reflects the user's configured `activeTools` (not just the built-in default four) at `before_agent_start`?
  If a user configured extra active tools at the pi level, the fix should preserve them — confirm during the lifecycle-timing check above.
  Defer until TDD step 2's smoke test.

[#386]: https://github.com/gotgenes/pi-packages/pull/386
