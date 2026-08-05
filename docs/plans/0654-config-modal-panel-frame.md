---
issue: 654
issue_title: 'Give the /permission-system settings modal a visible border frame'
---

# Frame the /permission-system settings modal with the shared PanelFrame

## Release Recommendation

**Release:** no numbered roadmap step applies; ship with the next release-please merge.
No config shape or public type changes.

## Problem Statement

The `/permission-system` settings modal (`src/config-modal.ts`, `openSettingsModal`) renders a raw `SettingsList` via `ctx.ui.custom` with no visual boundary.
On the TUI it floats directly against the chat background with no framing, so it has poor affordance ("no sense of identity") compared to the permission-ask overlay, which was framed in the previous commit with a `PanelFrame` box (top/bottom rules + side rails, accent color) mirroring show-diff's `BorderFrame`.

`@earendil-works/pi-tui`'s `SettingsList` has no native border support, so the frame must be applied in the presentation layer.
The only existing framer, `PanelFrame`, is currently a private class in `src/authority/permission-prompt-component.ts`.

## Goals

- Give the settings modal the same four-sided `PanelFrame` box (accent color) the permission-ask overlay already has, so the two share a consistent, recognizable look.
- Keep one source of truth for the frame: extract `PanelFrame` into a shared module and reuse it from both dialogs (no duplicated box-drawing code).
- Keep all interaction, layout, and overlay options of the settings modal unchanged (`anchor: center / width: 82 / maxHeight: 85% / margin: 1`).
- Do not change the config shape or any public API — no schema/README/configuration.md drift.

## Changes

### 1. `src/ui/panel-frame.ts` (new)

Extract the private `PanelFrame` class verbatim from `permission-prompt-component.ts` into `src/ui/panel-frame.ts` and export it.
Behavior unchanged: top/bottom `─` rules + side rails, `width <= 4` falls back to the bare child, inner lines truncated and re-padded to full width so framed output never exceeds `width`.

### 2. `src/authority/permission-prompt-component.ts`

Remove the private `PanelFrame` class; `import { PanelFrame } from "#src/ui/panel-frame"`.
Pure move — no behavior change.
Existing `test/authority/permission-prompt-component.test.ts` border assertions keep passing untouched.

### 3. `src/config-modal.ts`

In `openSettingsModal`, `ctx.ui.custom` should stop returning the bare `settingsList` and instead return a framed wrapper:

- `const framed = new PanelFrame(settingsList, (text) => theme.fg("accent", text))`
- return `{ render: (w) => framed.render(w), invalidate: () => framed.invalidate(), handleInput: (d) => settingsList.handleInput(d) }`

`handleInput` must forward to the `SettingsList` (otherwise keys are dead while the modal is focused) — this is exactly the pattern `presentInlinePermissionPrompt` already uses.
`SettingsList` satisfies the child surface (`render`/`invalidate`).
Overlay options stay exactly as-is.

### 4. `docs/architecture/architecture.md`

Add one module-tree line for `ui/panel-frame.ts` (shared TUI box-frame wrapper used by the permission-ask overlay and the settings modal).

### 5. `test/config-modal.test.ts`

Keep the existing `SettingsList` vi.mock but give it a non-empty `render()` returning a few lines, and add a rendering test: capture the `ctx.ui.custom` renderer callback, invoke it with a plain-text fake theme, render at a fixed width, and assert the first line starts with `┌`, the last with `└`, and every non-empty inner line is wrapped with `│`.
This proves the frame is really wired in.

## Verification

- `pnpm run check` (tsc --noEmit)
- `pnpm test` — especially `test/config-modal.test.ts` and `test/authority/permission-prompt-component.test.ts`
- `pnpm run lint`
- `pnpm run build:types` + `pnpm run verify:public-types` (no public-type surface change, sanity check)
