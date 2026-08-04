---
issue: 573
issue_title: "[FEATURE REQUEST] Keybinds for approve/deny/deny with reason"
---

# Inline keybind permission dialog

## Release Recommendation

**Release:** ship independently

Phase 11 Step 4 carries `Release: independent` in the architecture roadmap.
It is a pure live-authority presentation change on the `Authorizer` spine — `evaluate()`, the ruleset, and the gate contract are untouched — so it neither depends on nor blocks the `shell-tool-aliases` batch (Steps 2–3, already shipped) or any other Phase 11 step.

## Problem Statement

The permission prompt shown on an `ask` decision is a stock two-select modal: the user navigates with arrows / `j`/`k` and confirms with enter.
Deny-with-reason costs three keypresses (navigate to the option, enter, then type).
Issue #573 (filed by a third party, Hex4C) asks for single-keypress hotkeys — `y` approve, `n` deny, and a one-key path to deny-with-reason — so fine-grained permission control is fast to exercise.

The operator has scheduled this as Phase 11 Step 4 and, in planning, extended the request in two directions beyond the raw issue:

1. A **double-press-to-confirm** affordance modeled on the pi-ask review-shortcuts flow (first press of a hotkey *arms* the action and shows a "press again to confirm" hint; the same key again commits), gated by a config toggle defaulting **on**.
2. A **mandatory** inline reason editor for deny-with-reason with back-navigation.

## Goals

- Add an inline `ctx.ui.custom<PermissionPromptDecision>` permission dialog for TUI sessions with letter hotkeys: `y` approve, `s` approve-for-this-session, `n` deny, `r` deny-with-reason, alongside arrow / `j`/`k` navigation and enter-confirm.
- Require a confirming **second press** of the same letter hotkey before a decision commits (arm → confirm), governed by a new `doublePressToConfirm` config toggle that defaults to `true`.
- Make deny-with-reason an inline editor sub-step: `r` opens a reason editor; enter submits; a non-empty reason is **mandatory**; `esc` navigates **back** to the decision list.
- Preserve the forwarded-ask grant-scope choice (subagent vs. serving session) as an in-component second step with back-navigation.
- Keep the existing `select()` / `input()` flow **unchanged** for non-TUI contexts (RPC / frontend — the #519 constraint): the inline component renders only when `ctx.mode === "tui"`.
- Keep the `PermissionPromptDecision` contract, `emitUiPromptEvent` broadcast, review-log bracketing, and gate behavior byte-for-byte identical — only the human-facing input surface changes.

## Non-Goals

- No change to `evaluate()`, the `PermissionResolver`, the ruleset, or any gate outcome — this is presentation-only.
- No change to the `ParentAuthorizer` (subagent-escalation) or `DenyingAuthorizer` paths; only `LocalUserAuthorizer`'s live-UI arm gains the inline dialog.
- No configurable *remapping* of the hotkey letters — `y`/`s`/`n`/`r` are fixed this round (a per-key config surface, mirroring pi-ask's keybinding schema, is deferred; not filed — revisit only if requested).
- No timer-based double-press window — arming is pure state (press the same key again, no elapsed-time constraint), matching pi-ask's `resolveReviewShortcutDoublePress`.
- No double-press behavior in the non-TUI `select()`/`input()` fallback — a modal select cannot express arm-then-confirm; the toggle affects the inline component only.

## Background

Relevant existing modules:

- `src/authority/authorizer.ts` — `selectAuthorizer(ctx, deps)` performs the once-per-activation `hasUI` / `isSubagent` / deny dispatch, returning `LocalUserAuthorizer` when `ctx.hasUI`.
  It already receives the full `ExtensionContext`, so `ctx.mode` and `ctx.ui.custom` are reachable here without new plumbing into the caller.
- `src/authority/local-user-authorizer.ts` — the single `permissions:ui_prompt` emit site; calls the injected `requestPermissionDecisionFromUi(ui, title, message, options)`.
- `src/authority/permission-dialog.ts` — owns option semantics: the `PermissionDecisionUi` interface (`select`/`input`), `RequestPermissionOptions` (including `sessionScope` for forwarded asks), `normalizePermissionDenialReason`, `createDeniedPermissionDecision`, and the `PermissionPromptDecision` / `PermissionDecisionState` types.
- `src/authority/authorizer-selection.ts` — `AuthorizerSelection` stores `ctx` at `activate()` and delegates to the selected `Authorizer` via `PermissionPrompter`.
- `src/config-modal.ts` — the in-package precedent for `ctx.ui.custom`: builds a TUI `SettingsList` from `@earendil-works/pi-tui`, gated on `ctx.hasUI`, resolving via `done()`.
- `src/config-schema.ts` / `src/extension-config.ts` / `src/config-loader.ts` — the config source-of-truth chain: Zod schema (`.meta` descriptions, regenerated `schemas/permissions.schema.json`) → `PermissionSystemExtensionConfig` + `DEFAULT_EXTENSION_CONFIG` + `normalizePermissionSystemConfig` → `mergeUnifiedConfigs` scalar list.

Reference model (external): `~/development/pi/pi-ask/src/ui/review-shortcuts.ts` — `resolveReviewShortcutDoublePress(digit, pendingActionIndex)` is a pure resolver: matching the pending action confirms; any other key re-arms.
The hint text (`Press N again to <action>.`) is derived from the pending index. pi-ask keeps the double-press logic and the question view-model pure (`state.ts`, `review-shortcuts.ts`, `question-view-model.ts`) and tests the component by invoking the `ctx.ui.custom` factory with a fake `tui` + `plainTheme()` + captured `done`, then simulating input — the pattern this plan follows.

SDK facts (verified against `@earendil-works/pi-coding-agent@0.79.1`):

- `ctx.ui.custom<T>(factory, options?)` renders **inline** by default (`overlay ?? false`) and returns `Promise<T>`; the factory receives `(tui, theme, keybindings, done)` and returns a `Component` (a `Container` subclass with `handleInput(data)` and optional `dispose()`).
- `ctx.mode` is `"tui" | "rpc" | "json" | "print"`; `ctx.hasUI` is `true` in **both** `"tui"` and `"rpc"`.
  So the current `hasUI`-selected `LocalUserAuthorizer` also serves RPC, where `ctx.ui.custom` does not render — the inline path must gate on `ctx.mode === "tui"`, and RPC must keep `select()`/`input()`.
- `@earendil-works/pi-tui@0.79.1` (a `devDependency` already present) exports the primitives (`Container`, `Text`, `Spacer`, `SelectList`, `Editor`, `matchesKey`) the component needs; `getSelectListTheme`/`getSettingsListTheme` come from `@earendil-works/pi-coding-agent`.

AGENTS.md / package-skill constraints that apply:

- Config field lifecycle: define in `unifiedConfigSchema` with `.meta`, regenerate the schema (`pnpm run gen:schema`; a parity test guards drift), carry through `PermissionSystemExtensionConfig` + `mergeUnifiedConfigs` (the #332/#347 drop class — post-#356 the compiler flags a missed read), and keep `config.example.json` / `docs/configuration.md` / `README.md` aligned.
- "Treat any declared config field not read at runtime as a maintenance trap" — the toggle must be consumed in the same phase it is declared (it goes live in TDD step 4).
- Keep Pi SDK / TUI imports out of pure modules — the decision model (step 1) imports neither; only the component (step 3) and the dispatcher wiring (step 4) touch the SDK.

## Design Overview

### Separation: pure decision model vs. thin TUI component

The interaction logic (which key produces which decision, double-press arming, step transitions, reason validation) lives in a **pure** module with no SDK/TUI imports; the `ctx.ui.custom` component is a thin adapter that forwards keystrokes to the model and renders its state.
This is Test-Driven Design: the branch-heavy logic is unit-tested directly, and the component test only has to confirm wiring.

```typescript
// src/authority/permission-prompt-decision.ts (new, pure)

export type PromptStep = "decision" | "reason" | "scope";

export interface PromptOption {
  readonly key: "y" | "s" | "n" | "r";
  readonly state: PermissionDecisionState; // approve / approved_for_session / denied / denied_with_reason
  readonly label: string;
}

export interface PromptModelConfig {
  readonly options: readonly PromptOption[]; // s/scope present only when the ask offers them
  readonly doublePressToConfirm: boolean;
  readonly sessionScope?: RequestPermissionOptions["sessionScope"];
}

export interface PromptViewState {
  readonly step: PromptStep;
  readonly highlightedKey: PromptOption["key"];
  readonly armedKey?: PromptOption["key"]; // set only while awaiting the confirming second press
  readonly hint: string; // "Press y again to approve." etc.
  readonly reasonDraft: string;
  readonly reasonError?: string; // "A reason is required." when an empty submit is attempted
}

// A press yields either a re-render (new state) or a terminal decision.
export type PromptOutcome =
  | { readonly kind: "render"; readonly state: PromptViewState }
  | { readonly kind: "decision"; readonly decision: PermissionPromptDecision };

export function initialPromptState(config: PromptModelConfig): PromptViewState;

export function pressKey(
  config: PromptModelConfig,
  state: PromptViewState,
  key: string, // raw key data from the TUI
): PromptOutcome;

export function submitReason(
  state: PromptViewState,
): PromptOutcome; // rejects empty (render with reasonError); else decision
```

Model behavior (the unit-test surface):

- **Navigation** (`up`/`down`/`j`/`k`) moves `highlightedKey`, clears `armedKey` (moving off an armed option cancels the arm), and does not commit.
- **Letter hotkey** with `doublePressToConfirm: true`: first press sets `armedKey` = that key, moves the highlight to it, and sets `hint` to `Press <key> again to <verb>.`; pressing the **same** key again commits its decision; pressing a **different** letter re-arms the new one.
- **Letter hotkey** with `doublePressToConfirm: false`: commits immediately.
- **enter** commits the currently highlighted option in one press (a deliberate navigate-then-confirm is already two keystrokes; enter is the always-single-press confirm path, so the double-press toggle governs only the letter fast-path).
- **`r` (deny-with-reason)** when armed/confirmed transitions to `step: "reason"` rather than returning a decision; the component then shows the editor.
- **`submitReason`**: an empty/whitespace draft returns `{ kind: "render" }` with `reasonError` set (mandatory reason); a non-empty draft returns `{ kind: "decision" }` with `createDeniedPermissionDecision(reason)`.
- **`s` (approve-for-session)** on a forwarded ask carrying `sessionScope` transitions to `step: "scope"` (subagent vs. serving-session sub-select) instead of committing; picking a scope commits `approved_for_session` or `approved_for_serving_session`; a cancelled/`esc` scope step navigates **back** to the decision list.
- **`esc`**: from `"reason"` or `"scope"` → back to `"decision"` (clears the draft / armed state); from `"decision"` (top level) → commit `createDeniedPermissionDecision()` (esc denies, matching the roadmap).

### The component and mode dispatch

`permission-dialog.ts` stays the single option-semantics entry and gains a mode dispatcher.
`PermissionDecisionUi` widens to expose `custom` (the `select`/`input` members are retained for the fallback), and the entry takes the run mode:

```typescript
// src/authority/permission-dialog.ts (changed)

export interface PermissionDecisionUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  custom<T>(
    factory: (tui: TUI, theme: Theme, keybindings: KeybindingsManager, done: (r: T) => void) => Component,
    options?: { overlay?: boolean },
  ): Promise<T>;
}

export interface PermissionPromptView {
  readonly mode: ExtensionMode;
  readonly ui: PermissionDecisionUi;
  readonly doublePressToConfirm: boolean;
}

// New single entry LocalUserAuthorizer calls; dispatches on mode.
export function requestPermissionDecision(
  view: PermissionPromptView,
  title: string,
  message: string,
  options?: RequestPermissionOptions,
): Promise<PermissionPromptDecision> {
  if (view.mode === "tui") {
    return presentInlinePermissionPrompt(view, title, message, options); // permission-prompt-component.ts
  }
  return requestPermissionDecisionFromUi(view.ui, title, message, options); // unchanged select/input path
}
```

`requestPermissionDecisionFromUi` (the existing select/input implementation) is retained verbatim as the non-TUI fallback, so its current tests keep passing (lift-and-shift — introduce the dispatcher alongside, migrate the caller, keep the old function).

### Consumer call site (Tell-Don't-Ask / LoD check)

`selectAuthorizer` already holds `ctx`; it reads `ctx.mode`/`ctx.ui` once and hands the authorizer a resolved view plus a live preference getter, rather than letting the authorizer reach back through `ctx`:

```typescript
// src/authority/authorizer.ts — selectAuthorizer, hasUI arm (sketch)
if (ctx.hasUI) {
  return new LocalUserAuthorizer({
    ui: ctx.ui,
    mode: ctx.mode,
    events: deps.events,
    getPromptPreferences: deps.getPromptPreferences, // () => ({ doublePressToConfirm })
    requestPermissionDecision: deps.requestPermissionDecision,
  });
}
```

```typescript
// src/authority/local-user-authorizer.ts — authorize (sketch)
authorize(details: PromptPermissionDetails): Promise<PermissionPromptDecision> {
  emitUiPromptEvent(this.deps.events, buildUiPrompt(details)); // unchanged single emit site
  const { doublePressToConfirm } = this.deps.getPromptPreferences();
  return this.deps.requestPermissionDecision(
    { mode: this.deps.mode, ui: this.deps.ui, doublePressToConfirm },
    details.forwarding ? "Permission Required (Subagent)" : "Permission Required",
    details.message,
    buildRequestOptions(details), // unchanged (sessionScope for forwarded asks)
  );
}
```

`getPromptPreferences` is a **getter**, not a snapshot, so toggling `doublePressToConfirm` in the `/permission-system` settings modal takes effect on the next prompt without re-activation.
It is wired in `index.ts` from the same config store the settings modal writes.

### Config field

`doublePressToConfirm` is a flat boolean knob alongside `yoloMode`/`debugLog`/`permissionReviewLog` (a UI-behavior toggle, not part of the `permission` map), defaulting **on**:

```jsonc
// config.example.json (excerpt)
{
  "doublePressToConfirm": true
}
```

Default-on normalization mirrors `permissionReviewLog` (present-unless-explicitly-false): `raw.doublePressToConfirm !== false`.

### Edge cases

- **RPC session** (`hasUI` true, `mode: "rpc"`): dispatcher takes the `select`/`input` branch — behavior identical to today.
- **`doublePressToConfirm` off**: letter hotkeys commit on first press; enter still commits the highlight; reason/scope sub-steps are unaffected (they are step transitions, not double-press).
- **Empty reason**: rejected with an inline `reasonError`; the editor stays open (mandatory reason).
- **Forwarded ask without a session suggestion**: no `sessionScope`; `s` commits `approved_for_session` directly (no scope step), matching current behavior.
- **`s` option absent** (asks that offer no session grant): the option list omits `s`; pressing it is a no-op.

## Module-Level Changes

New:

- `src/authority/permission-prompt-decision.ts` — the pure model (types + `initialPromptState` / `pressKey` / `submitReason`).
  No SDK/TUI imports.
- `src/authority/permission-prompt-component.ts` — `presentInlinePermissionPrompt(view, title, message, options)`: builds the `ctx.ui.custom` factory, renders decision list + hotkey hints + reason editor + scope sub-select via `@earendil-works/pi-tui` primitives, forwards `handleInput` to the model, and resolves `done(decision)`.
- `test/authority/permission-prompt-decision.test.ts` — pure-model unit tests.
- `test/authority/permission-prompt-component.test.ts` — component tests via a fake `tui`/`theme`/`done` harness (the pi-ask `ask-settings-command.test.ts` pattern).

Changed:

- `src/authority/permission-dialog.ts` — widen `PermissionDecisionUi` with `custom`; add `PermissionPromptView` + the `requestPermissionDecision` dispatcher; keep `requestPermissionDecisionFromUi` as the fallback.
- `src/authority/local-user-authorizer.ts` — `LocalUserAuthorizerDeps` gains `mode`, `getPromptPreferences`, and `requestPermissionDecision` (replacing the injected `requestPermissionDecisionFromUi`); `ui` type widens via `PermissionDecisionUi`.
- `src/authority/authorizer.ts` — `AuthorizerSelectionDeps` gains `getPromptPreferences` and `requestPermissionDecision`; `selectAuthorizer` passes `mode: ctx.mode` and the getter into `LocalUserAuthorizer`.
- `src/index.ts` — construct `getPromptPreferences` from the config store and inject it plus `requestPermissionDecision` into `AuthorizerSelection`'s deps.
- `src/config-schema.ts` — add `doublePressToConfirm: z.boolean().optional().meta({ description, markdownDescription })`; then `pnpm run gen:schema` regenerates `schemas/permissions.schema.json` (do not hand-edit).
- `src/extension-config.ts` — add `doublePressToConfirm: boolean` to `PermissionSystemExtensionConfig`, `doublePressToConfirm: true` to `DEFAULT_EXTENSION_CONFIG`, and `doublePressToConfirm: raw.doublePressToConfirm !== false` in `normalizePermissionSystemConfig`.
- `src/config-loader.ts` — add `doublePressToConfirm` to the boolean-scalar merge list in `mergeUnifiedConfigs` (and the doc comment listing scalar fields).
- `src/config-modal.ts` — add the toggle to `buildSettingItems` / `applySetting` / `syncSettingValues` and to `cloneDefaultConfig` (a required boolean must be present in the reset clone).
- `config/config.example.json` — add `"doublePressToConfirm": true`.
- `docs/configuration.md` — document the toggle and the inline-dialog hotkeys.
- `README.md` — note the inline TUI permission dialog and its hotkeys/toggle under the permission-prompt behavior.
- `docs/architecture/architecture.md` — mark Phase 11 Step 4 complete (✅ on the step heading and the `S4` Mermaid node) and update the health-metric row `Inline prompt component files (ui.custom in src/authority/)` from `0` to `1`, in the implementation doc-update commit.

Symbol-removal / rename grep (performed for this plan): `requestPermissionDecisionFromUi` is **retained** (not removed), so no consumer breaks; `grep -rn requestPermissionDecisionFromUi src test` shows `permission-dialog.ts`, `local-user-authorizer.ts` (+ its type import), `authorizer.ts`, `index.ts`, and `local-user-authorizer.test.ts`.
The migration re-points the injected seam from `requestPermissionDecisionFromUi` to `requestPermissionDecision` at those call sites; the function itself remains as the fallback implementation.
No `docs/` or `SKILL.md` prose names `requestPermissionDecisionFromUi` (it is an internal symbol), so no narrative doc update is needed for the rename — only the additive inline-dialog documentation above.

## Test Impact Analysis

1. **New tests the split enables** — the double-press arming, reason-required validation, esc back-navigation, and forwarded-scope transitions become directly unit-testable as pure `pressKey`/`submitReason` cases, with no TUI harness.
   These are new behaviors with no prior coverage.
2. **Redundant / simplified** — none of the existing `permission-dialog.test.ts` select/input cases become redundant: they now pin the **RPC fallback** branch, which is still reached.
   No test is deleted.
3. **Must stay as-is** — `permission-dialog.test.ts` select/input assertions (they exercise the retained fallback), and `permission-prompter.test.ts` / `authorizer-selection.test.ts` (they exercise bracketing and selection, which are unchanged).

## Invariants at risk

Step 4 touches the `Authorizer` spine landed in Phase 9 (#555–#559).
Invariants to preserve, each with its pinning test:

- **Single `permissions:ui_prompt` emit site** (`LocalUserAuthorizer`, #292/#555) — pinned by `local-user-authorizer.test.ts` ("emits a UI prompt event…").
  The emit stays in `authorize()` ahead of the dispatch; the mode branch is downstream of it, so the broadcast fires identically for TUI and RPC.
  Update the test's deps shape (add `mode`/`getPromptPreferences`/`requestPermissionDecision`) but keep the emit assertion.
- **Forwarded-ask provenance rendering** (`(Subagent)` title + populated `forwarding` context, #557) — pinned by `local-user-authorizer.test.ts`; the title/`buildRequestOptions` logic is unchanged.
- **`confirmationUnavailable` / `DenyingAuthorizer` path** (#556) — untouched; no TUI branch exists there.
- **Review-log bracketing order** (`PermissionPrompter`, #555) — untouched; the dispatcher sits inside `authorizer.authorize`, which `PermissionPrompter` still brackets.

## TDD Order

1. **Pure decision model** — `test/authority/permission-prompt-decision.test.ts` red → `src/authority/permission-prompt-decision.ts` green.
   Cover: navigation highlight (no commit, clears arm); double-press arm→confirm per key; different-key re-arm; toggle-off immediate commit; enter commits highlight; `r`→reason step; `submitReason` empty-rejected / non-empty decision; `s`→scope step with back-nav and least-privilege default; esc back (reason/scope) and esc-denies (top level).
   Commit: `feat(pi-permission-system): add inline permission prompt decision model`.
2. **Config field** — schema + type + default + normalize + merge + regen schema, with the config-schema parity test and `extension-config` / `config-loader` unit tests.
   `config.example.json`, `docs/configuration.md`, `README.md` updated here.
   Commit: `feat(pi-permission-system): add doublePressToConfirm config toggle`. (Field is declared here and consumed in step 4 — no persistent unread window by the pre-completion `fallow dead-code` gate.)
3. **Inline component** — `test/authority/permission-prompt-component.test.ts` red → `src/authority/permission-prompt-component.ts` green, using a fake `tui`/`theme`/`done` harness; assert key sequences resolve the expected `PermissionPromptDecision` and that the reason editor / scope sub-select wire to the model.
   Commit: `feat(pi-permission-system): render inline keybind permission prompt`.
4. **Mode dispatch + wiring** — widen `PermissionDecisionUi`, add `PermissionPromptView` + `requestPermissionDecision` in `permission-dialog.ts`; thread `mode` + `getPromptPreferences` + the dispatcher through `authorizer.ts` / `local-user-authorizer.ts` / `index.ts`; add the settings-modal toggle in `config-modal.ts`.
   Update `local-user-authorizer.test.ts` and `permission-dialog.test.ts` (add tui→inline and rpc→fallback dispatch cases; keep the select/input and emit assertions).
   This removes the old injected `requestPermissionDecisionFromUi` seam from `LocalUserAuthorizerDeps` / `AuthorizerSelectionDeps` and its `index.ts` call site — one commit, since a removed injected field breaks its consumers and their tests at the type level simultaneously.
   Commit: `feat(pi-permission-system): dispatch TUI permission prompts to the inline keybind dialog`.
5. **Architecture completion** — mark Phase 11 Step 4 ✅ (heading + `S4` node) and bump the `Inline prompt component files` metric row `0 → 1` in `docs/architecture/architecture.md`.
   Commit: `docs(pi-permission-system): mark Phase 11 Step 4 complete`.

## Risks and Mitigations

- **`ctx.ui.custom` renders only in TUI** — mitigated by gating on `ctx.mode === "tui"` (not `hasUI`) and keeping the `select`/`input` fallback for RPC; a dispatch test pins both branches.
- **Config field declared but unread** (maintenance-trap smell) — mitigated by consuming it in step 4, the same phase; the pre-completion `fallow dead-code` gate runs after step 4.
- **Live-toggle staleness** — reading `doublePressToConfirm` via a getter (not an activation snapshot) keeps the settings-modal change effective on the next prompt.
- **Component hard to unit-test** — mitigated by the pure-model split; the component test only confirms wiring against a fake TUI, matching the pi-ask harness pattern.
- **Regressing a spine invariant with a green suite** — the Invariants-at-risk section names each invariant and its pinning test; the `local-user-authorizer.test.ts` emit assertion is preserved through the deps-shape change.

## Open Questions

- Per-key hotkey remapping (a config schema mirroring pi-ask's keybindings) is deferred and unfiled; revisit only if a user requests configurable letters.
- Whether the inline dialog should also surface the tool-input preview inline (beyond the current `message`) is left to the component's rendering pass; no contract change is implied, so it is an implementation detail, not a planned surface.
