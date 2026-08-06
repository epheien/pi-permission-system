# `/permission-system yolo` toggle subcommand

Date: 2026-08-06

## Release Recommendation

**Release:** no numbered roadmap step applies; ship with the next release-please merge.
No config shape or public type changes; the plan is a command-surface add to the existing `/permission-system` slash command.

## Problem Statement

`yoloMode` (the extension's "ask → allow" rewrite switch) currently has two toggle paths: hand-editing the config file, or opening the `/permission-system` settings modal and flipping the "YOLO mode" setting through four navigational steps.
There is no one-shot way to flip it from the command line / command surface.

The operator wants a single lightweight toggle entry point that can later be bound to a keyboard shortcut (binding placement is a follow-up; this plan only delivers the command capability, and the command is the reuse unit a shortcut/extension binding would call).

## Goals

- Add `/permission-system yolo` as a one-shot toggle: flips `yoloMode`, persists to the **global** config through the same `CommandConfigStore.save()` path the settings modal uses (restart-persistent), and gives immediate visible feedback.
- Keep the toggle logic in one small pure function so it is unit-testable and reusable (a future internal `registerShortcut("ctrl+…")` or an external binding can call the same unit).
- Do not change the config shape, schema, gate logic, `ConfigStore`, status layer, or any public type.
  No new args beyond `yolo` (no `on`/`off` — YAGNI; "toggle" is the agreed semantics).

## Changes

### 1. `src/config-modal.ts`

- Add to `COMMAND_ARGUMENTS`:
  - `{ value: "yolo", label: "Toggle YOLO mode", description: "Flip yoloMode and persist it to the global config" }`
  - Argument completions are prefix-filtered over this array, so `getArgumentCompletions("yol")` automatically gains the new item — no additional completion code.
- Update `USAGE_TEXT` to include `yolo`.
- Add a module-level pure function (before `handleArgs`):

  ```ts
  function toggleYoloMode(
    config: PermissionSystemExtensionConfig,
  ): PermissionSystemExtensionConfig {
    return { ...config, yoloMode: !config.yoloMode };
  }
  ```

- In `handleArgs`, add a `yolo` branch (mirrors the existing `show` / `path` / `reset` branches):

  ```ts
  if (normalized === "yolo") {
    const next = toggleYoloMode(controller.config.current());
    const enabled = next.yoloMode;
    controller.config.save(next, ctx);
    ctx.ui.notify(
      enabled ? "YOLO mode ON — ask checks auto-approved" : "YOLO mode off",
      enabled ? "warning" : "info",
    );
    return true;
  }
  ```

  - `save()` internally calls `syncPermissionSystemStatus`, so the status bar updates to the red bold `yolo` value immediately (no status-layer change needed).
  - `save()` already fail-closes on write errors with an `error` notify; the branch needs no extra error handling.
  - Returning `true` keeps the branch out of the modal path, so it works headless (RPC / non-`hasUI`) the same way `show`/`path`/`reset` do today.

### 2. `test/config-modal.test.ts` (extend)

- In the "completions" test, assert `topLevel` includes `value === "yolo"` and `getArgumentCompletions?.("yol")` resolves to `["yolo"]`.
- Add a handler test over `definition.handler("yolo", ctx)`:
  - **false → true:** start `yoloMode: false`; `save` stub flips `config` and rewrites the temp `config.json`; assert persisted value `true` and `lastNotification` is the ON message at level `"warning"`.
  - **true → false:** start `yoloMode: true`; assert persisted value `false` and the OFF message at level `"info"`.
  - Reuses the existing `createCommandContext` helper (`hasUI: false` is fine — the branch never opens the modal).

### 3. No separate docs change needed

- `README.md` and `docs/configuration.md` contain no `/permission-system` command-reference section (they only document install/config paths); the command's user-facing usage text is `USAGE_TEXT`, surfaced by `/permission-system help` — and it is updated in change 1 above.
  Adding a standalone command-reference section is out of scope (see Non-Goals).

## Explicit Non-Goals

- No keyboard shortcut registration this iteration (internal `registerShortcut`, external extension binding, and any `pi-permission-system` public API for it are follow-ups).
- No `yolo on` / `yolo off` parameterized forms.
- No new README / `docs/configuration.md` command-reference documentation section (existing text is only the in-command `USAGE_TEXT`).
- No config shape / schema / gate / `ConfigStore` / `status.ts` changes.

## Acceptance Criteria

1. `/permission-system yolo` toggles `yoloMode` and the new value is present in the global `config.json` after the call.
2. Status bar reflects the toggle immediately (via existing `save` → status sync).
3. ON and OFF notifications carry the exact agreed messages and levels.
4. Argument completion surfaces `yolo`.
5. `pnpm test` (the extended `config-modal.test.ts`) and `pnpm run check` pass; `pnpm run lint` clean.
