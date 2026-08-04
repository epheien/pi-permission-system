---
issue: 642
issue_title: "pi-permission-system: preserve Ctrl+O tool expansion in inline permission prompts"
---

# Preserve tool expansion in inline permission prompts

## Release Recommendation

**Release:** ship independently

Issue #642 is a standalone bug fix, not a numbered step in `docs/architecture/architecture.md`'s improvement roadmap — a grep for `#642` and `#643` there returns nothing, so there is no `Release:` batch tag to honor.
The change lands a `fix:` commit, which is an unhidden changelog type and cuts a release on its own.

## Problem Statement

While an inline permission prompt holds keyboard focus, Pi's `app.tools.expand` action (Ctrl+O by default) does nothing.
The user cannot expand a truncated tool preview at exactly the moment they are being asked to approve that tool call.

The cause is in `src/authority/permission-prompt-component.ts`.
`presentInlinePermissionPrompt` builds the `ctx.ui.custom` factory but discards its third argument as `_keybindings`, and `PermissionPromptComponent.handleInput` routes every keystroke to either `handleReasonInput` or `toEvent` — neither of which knows about application-level actions.
A focused custom component must explicitly preserve the app actions it does not own; this one preserves none.

This works directly against a stated package priority: keep block/ask/allow decisions reviewable.
The moment a user most needs the full pending tool invocation is the moment they are deciding on it.

PR [#643] from @0xbentang implements a fix.
The PR-review stage (see `docs/retro/0642-preserve-tool-expansion-in-prompts.md`) settled the direction: adopt the capability with our own simplified design, using the PR as reference rather than the merge target.
That retro entry satisfies this plan's `Decide` gate; the plan below implements the recorded decision rather than re-opening it.

## Goals

- While the inline permission prompt is focused, `app.tools.expand` toggles Pi's tool-output expansion.
- The toggle never resolves, commits, arms, or otherwise alters the pending permission decision.
- The action is consulted only in the `decision` and `scope` steps; the `reason` step's text entry is never intercepted.
- The component holds no Pi SDK keybindings type — the keybinding lookup and the `ui` reach-through stay in the module's factory function.
- `docs/configuration.md` and `README.md` document the behavior.

This change is **not breaking**.
It is additive keystroke handling: no output shape, no default, no config field, and no existing key's meaning changes.

## Non-Goals

- **No expand hint in the prompt's hint line.**
  Operator decision: expansion is a global app binding most users already know, the decision-step hint line is already dense, and a permission dialog is the wrong place to teach an unrelated global key.
- **No new config field.**
  The binding is Pi's own `app.tools.expand`; this package reads it, it does not redefine or re-bind it.
- **No change to `PermissionDecisionUi`.**
  The narrow `select`/`input` fallback surface stays exactly as [#573] left it.
- **No change to the pure decision model** (`src/authority/permission-prompt-decision.ts`).
  Tool expansion is a display concern with no bearing on the decision, so it must not become a `PromptEvent`.
- **No other app actions.**
  Only `app.tools.expand` is forwarded; a general app-action passthrough is not in scope and is not speculatively built.

## Background

Relevant modules:

- `src/authority/permission-prompt-component.ts` — `presentInlinePermissionPrompt` builds the `ctx.ui.custom` factory; the private `PermissionPromptComponent` class renders state and maps keystrokes to `PromptEvent`s.
  Declares `PermissionPromptUi = Pick<ExtensionUIContext, "select" | "input" | "custom">` and `PermissionPromptView`.
- `src/authority/permission-prompt-decision.ts` — the pure `reducePrompt` model.
  Owns `PromptStep = "decision" | "reason" | "scope"`.
  No SDK or TUI imports; it must stay that way.
- `src/authority/local-user-authorizer.ts` — `LocalUserAuthorizerDeps.ui` is typed `PermissionPromptUi`, so widening that type reaches this file's tests.
- `src/authority/authorizer.ts` — `selectAuthorizer` passes the real `ctx.ui` (a full `ExtensionUIContext`), so widening is safe in production.

Facts verified against the sibling Pi checkout at `../pi`, not the bundled `dist`:

| Fact                                                                                                                 | Location                                                                  |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `getToolsExpanded()` / `setToolsExpanded()` are declared on `ExtensionUIContext`                                     | `core/extensions/types.ts:277`                                            |
| `custom`'s third factory argument is a non-optional `KeybindingsManager`                                             | `core/extensions/types.ts:195`                                            |
| The factory is invoked as `factory(this.ui, theme, this.keybindings, close)` — always a real manager                 | `modes/interactive/interactive-mode.ts:2490`                              |
| `setToolsExpanded` ends with `this.ui.requestRender()`                                                               | `modes/interactive/interactive-mode.ts:3815`                              |
| All three modes supply both methods (interactive; RPC no-op; headless runner stub)                                   | `interactive-mode.ts:2189`, `rpc-mode.ts:302`, `extensions/runner.ts:262` |
| Pi's own focused component checks this action first                                                                  | `modes/interactive/components/extension-selector.ts:93`                   |
| `matches(data: string, keybinding: Keybinding)` where `Keybinding = keyof Keybindings` includes `"app.tools.expand"` | `tui/src/keybindings.ts:194`, `core/keybindings.ts:22`                    |

Two consequences follow from that table and shape the design.
Because `setToolsExpanded` already re-renders the host, the component must **not** call `requestRender()` after toggling — the prompt's own rendered lines are unchanged by expansion.
Because the keybindings argument is non-optional and always a real instance, no undefined guard is needed.

An AGENTS.md constraint applies: keep Pi SDK imports out of business-logic modules and accept capabilities as parameters.
`permission-prompt-component.ts` is a legitimate SDK consumer (it already imports `ExtensionUIContext`), but the private component class inside it should not gain an SDK type — the module's factory function is the right home for the lookup.

## Design Overview

### The seam

The component gets exactly **one** new collaborator: a predicate that answers "was this keystroke an application action, and did I handle it?"

```typescript
/** The keybindings surface the dialog consults; only `matches` is read (ISP). */
type PromptKeybindings = Pick<KeybindingsManager, "matches">;
```

The `Pick` was verified to compile and to be satisfiable by a bare object literal (`{ matches: (_d, _k) => false }`) under `tsc` at planning time, so the narrowing is a measurement rather than an assumption.

`presentInlinePermissionPrompt` owns both the keybinding lookup and the `ui` reach-through:

```typescript
return view.ui.custom<PermissionPromptDecision>(
  (tui, theme, keybindings, done) =>
    new PermissionPromptComponent(
      theme,
      config,
      title,
      message,
      (data) => handleToolsExpandAction(data, keybindings, view.ui),
      () => {
        tui.requestRender();
      },
      done,
    ),
  { overlay: false },
);
```

with the named helper below it (stepdown rule):

```typescript
/**
 * Forward Pi's tool-expansion action while the dialog holds focus.
 *
 * Returns `true` when the keystroke was the action (and was handled), so the
 * component stops before mapping it to a `PromptEvent`. Deliberately does not
 * request a render: `setToolsExpanded` re-renders the host itself, and the
 * dialog's own lines are unaffected by tool expansion.
 */
function handleToolsExpandAction(
  data: string,
  keybindings: PromptKeybindings,
  ui: PermissionPromptUi,
): boolean {
  if (!keybindings.matches(data, "app.tools.expand")) {
    return false;
  }
  ui.setToolsExpanded(!ui.getToolsExpanded());
  return true;
}
```

This keeps `KeybindingsManager` out of the component entirely, so the component's tests need no keybindings fake to construct it — the seam is a plain `(data: string) => boolean`.

### Precedence

The check sits immediately **after** the existing `reason` early-return and **before** local key mapping:

```typescript
handleInput(data: string): void {
  if (this.state.step === "reason") {
    this.handleReasonInput(data);
    return;
  }
  if (this.handleAppAction(data)) {
    return;
  }
  const event = this.toEvent(data);
  if (event) {
    this.apply(event);
  }
}
```

Because the `reason` branch already returns first, this single-line insertion *is* "before local handling, but only in the `decision` and `scope` steps" — no new branching structure is required, and `PromptStep` is not re-interrogated.

The alternative — consulting the app action only after `toEvent` declines — was considered and rejected.
It would be marginally safer against a pathological rebinding, but it diverges from Pi's own `ExtensionSelectorComponent`, which checks `app.tools.expand` first.
Consistency with the host's focused-component convention wins; the residual rebinding risk is covered under Risks.

### Constructor shape

The PR under review added *two* positional constructor parameters (a `KeybindingsManager` plus a toggle callback), taking the class to eight.
This design adds **one**, taking it to seven, and places it before `requestRender` so the two callback arguments differ visibly at the call site (one takes `data` and delegates to a named helper; the other takes nothing).

Converting the constructor to a params object was considered and deliberately **not** planned.
`PermissionPromptComponent` is private to its module with a single call site, and the conversion would replace `this.theme` / `this.config` with `this.deps.theme` / `this.deps.config` across all three render methods — churn that trades one readability problem for another in a bug-fix commit.
The `tidy-first-assessor` dispatched at the start of `/tdd-plan` reads this file and may revisit the call; this plan does not pre-empt it.

### UI surface widening

`PermissionPromptUi` gains the two accessors:

```typescript
export type PermissionPromptUi = Pick<
  ExtensionUIContext,
  "select" | "input" | "custom" | "getToolsExpanded" | "setToolsExpanded"
>;
```

`PermissionDecisionUi` (the narrow `select`/`input` fallback surface) is untouched, preserving [#573]'s ISP split.
Production passes `ctx.ui`, so nothing changes at the composition root.

## Module-Level Changes

`src/authority/permission-prompt-component.ts`:

- Add a type-only `KeybindingsManager` import from `@earendil-works/pi-coding-agent`.
- Add the module-private `PromptKeybindings = Pick<KeybindingsManager, "matches">` alias.
- Widen `PermissionPromptUi` with `getToolsExpanded` and `setToolsExpanded`.
- Name the factory's third argument `keybindings` (was `_keybindings`) and pass the new closure.
- Add `handleToolsExpandAction` below `presentInlinePermissionPrompt`.
- Add `private readonly handleAppAction: (data: string) => boolean` to the constructor, between `message` and `requestRender`.
- Insert the app-action check in `handleInput` after the `reason` early-return.

`test/authority/permission-prompt-component.test.ts`:

- Retype `PromptFactory`'s `keybindings` parameter from `undefined` to `{ matches(data: string, action: string): boolean }`.
- Extend `makeFakeView` with a configurable expand key (default Ctrl+O), a fake `matches`, stateful `getToolsExpanded`/`setToolsExpanded` stubs on the fake `ui`, and both stubs on the returned object.
- Add a `describe("tool expansion")` block with three tests (see TDD Order).

`test/authority/local-user-authorizer.test.ts`:

- Both `ui` object literals (lines 31 and 138) are typed through `LocalUserAuthorizerDeps.ui`, so the widening breaks them at `tsc`.
- Extract a `makePromptUi()` helper and use it at both sites.

Docs:

- `docs/configuration.md` — extend the `### Inline permission dialog (TUI)` section (line 115) with a sentence on tool expansion after the existing navigation paragraph.
  Not a new table row: the key is Pi's user-rebindable `app.tools.expand`, not a prompt-owned hotkey, so it does not belong in a table of `y`/`s`/`n`/`r`.
- `README.md` — extend the inline-dialog sentence at line 68.
- `docs/architecture/architecture.md` — update the `permission-prompt-component.ts` module-tree entry (line 794) to state that it forwards `app.tools.expand` in the decision/scope steps.
  Per AGENTS.md, the entry describes current behavior; no issue ref is added, since this encodes no lint-guarded or ADR boundary.

Verified as **not** requiring updates:

- `test/authority/authorizer.test.ts:18` and `test/authority/authorizer-selection.test.ts:34` build `ui` literals behind `as unknown as ExtensionContext` casts and never reach `custom`, so they neither break at `tsc` nor at runtime.
- `.pi/skills/package-pi-permission-system/SKILL.md` — greps for `permission-prompt-component`, `inline keybind`, and `hotkey` return no match.
- `docs/architecture/history/phase-11-*.md` — history, never edited retroactively.

## Test Impact Analysis

This is a behavior addition, not an extraction, so the analysis is short.

1. **Newly enabled tests.**
   The `(data: string) => boolean` seam means the component's app-action behavior is testable through the existing fake-view harness with no keybindings-manager fake — the harness supplies a two-line `matches`.
   Making the expand key configurable in the harness newly enables the precedence test: binding the action to a *printable* key is the only way to prove the `reason` step is not intercepted, since the default Ctrl+O would be dropped by `isPrintable` anyway and would false-green.
2. **Newly redundant tests.**
   None.
   No existing test covers app-action handling.
3. **Tests that must stay as-is.**
   Every existing test in `permission-prompt-component.test.ts` now doubles as a guard that the seam does not swallow ordinary keystrokes — the hotkey, navigation, escape, reason-editing, and scope tests all pass keys through `handleInput` ahead of `toEvent`.
   They must keep passing unchanged; a regression in the seam breaks them.

## Invariants at risk

This surface was built by [#573] (phase 11).
Its documented outcomes and the tests that pin them:

| Invariant from [#573]                                                                                                               | Pinned by                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `PermissionDecisionUi` stays narrow (`select`/`input`); the wider `custom`-capable surface is a separate `PermissionPromptUi` (ISP) | `test/authority/permission-dialog.test.ts` — passes `ui` literals with only `select`/`input` to `requestPermissionDecisionFromUi` |
| The double-press affordance is a config toggle read live at prompt time                                                             | the `double-press to confirm (enabled)` / `(disabled)` describe blocks                                                            |
| Deny-with-reason requires a non-empty reason                                                                                        | `rejects an empty reason and shows an error, then accepts a real one`                                                             |
| The mode dispatch renders inline only in `"tui"`                                                                                    | `falls back to the select flow outside TUI mode`                                                                                  |

The widening touches the first invariant's boundary but preserves it: `PermissionPromptUi` grows, `PermissionDecisionUi` does not, and the existing `permission-dialog.test.ts` literals keep compiling untouched — which is itself the measurement that the split held.

The third invariant is the one this change could most plausibly regress, and the chosen precedence is what protects it: intercepting keystrokes during the `reason` step could make a required reason untypeable.
The new precedence test pins it directly rather than leaving it to prose.

No quantitative invariants (byte-identical prefixes, token budgets, latency) are in play.

## TDD Order

1. **Red — cover tool expansion during the prompt.**
   Surface: `test/authority/permission-prompt-component.test.ts`.
   Retype the `PromptFactory` keybindings parameter, extend `makeFakeView` with a configurable expand key and the expansion stubs, and add `describe("tool expansion")` with three tests:
   - toggles expansion on each press (`true` then `false`) and leaves the decision promise unsettled, then still resolves `approved` on `y`, `y`;
   - during the `scope` step (forwarded ask), toggles without committing, then `enter` resolves `approved_for_session`;
   - with the action bound to the printable key `e`, typing `e` inside the `reason` step yields `denialReason: "e"` and `setToolsExpanded` is never called.

   The harness casts to `PermissionPromptView`, so this file compiles and `pnpm run check` stays green; the red is behavioral (`setToolsExpanded` uncalled), not a type error.
   Commit: `test(pi-permission-system): cover tool expansion during permission prompts`.

2. **Green — forward the tools-expand action.**
   Surface: `src/authority/permission-prompt-component.ts` plus `test/authority/local-user-authorizer.test.ts`.
   Apply every `permission-prompt-component.ts` change from Module-Level Changes, and update both `local-user-authorizer.test.ts` `ui` literals via a `makePromptUi()` helper **in this same commit** — widening `PermissionPromptUi` breaks them at the type level, so the interface change and its typed call sites cannot land separately.
   Run `pnpm run check` immediately after this commit (shared-interface change) and the full package suite, not just the two edited files.
   Commit: `fix(pi-permission-system): preserve tool expansion in inline permission prompts`.

3. **Docs — document the behavior.**
   Surface: `docs/configuration.md`, `README.md`, `docs/architecture/architecture.md`.
   Commit: `docs(pi-permission-system): document tool expansion during permission prompts`.

Every commit carries the contributor trailer as the last line of the body, after a blank line:

```text
Co-authored-by: Ben Tang <bentang@fastmail.com>
```

Reference the sources as `Refs #642, #643` in the body — never a `Closes` keyword, which would pre-empt the curated close comments.

## Risks and Mitigations

| Risk                                                                                                         | Mitigation                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A user rebinds `app.tools.expand` to a decision hotkey (`y`/`s`/`n`/`r`), shadowing it in the decision step  | Accepted consequence of the chosen precedence, and self-inflicted. No option becomes unreachable: arrow/`j`/`k` navigation plus `enter` still commits every option, and `esc` still denies. The `reason` step is structurally immune.  |
| A future Pi version stops re-rendering inside `setToolsExpanded`, making the toggle appear inert             | The omission of a `requestRender()` call is deliberate and load-bearing on `interactive-mode.ts:3815`; the design comment on `handleToolsExpandAction` records why, so a future reader sees the dependency rather than re-deriving it. |
| The widened `PermissionPromptUi` reaches a non-TUI caller lacking the accessors                              | Cannot happen: `requestPermissionDecision` dispatches to `custom` only when `mode === "tui"`, production passes the full `ctx.ui`, and all three modes implement both methods anyway (RPC and headless as no-ops).                     |
| The precedence test false-greens because the default Ctrl+O is non-printable and would be dropped regardless | The test binds the action to the printable key `e` specifically so the assertion discriminates; asserting on Ctrl+O would prove nothing.                                                                                               |
| The seam silently swallows ordinary keystrokes                                                               | The full existing test file exercises hotkeys, navigation, escape, reason editing, and scope through `handleInput`; a swallowing regression fails those, not just the new block.                                                       |

## Open Questions

- Whether the expand key should eventually appear in the prompt's hint line for discoverability.
  Explicitly declined by the operator for this change (see Non-Goals).
  Revisit only if users report that the capability is undiscoverable; no follow-up issue filed, since filing one now would be speculative.

[#573]: https://github.com/gotgenes/pi-packages/issues/573
[#643]: https://github.com/gotgenes/pi-packages/pull/643
