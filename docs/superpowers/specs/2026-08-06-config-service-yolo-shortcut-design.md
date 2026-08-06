# Config Service + YOLO-mode Shortcut — Design

Date: 2026-08-06
Status: approved by operator (design review)

## Summary

Export a public **configuration service** (`getPermissionConfigService()`) and register
a **keyboard shortcut** (`ctrl+alt+y`) that toggles YOLO mode, both backed by a
single shared toggle unit (pure flip + `ConfigStore` persist core).

This is the follow-up the `/permission-system yolo` subcommand plan
(`docs/plans/permission-system-yolo-toggle-subcommand.md`) explicitly deferred:
> "No keyboard shortcut registration this iteration (internal `registerShortcut`,
> external extension binding, and any `pi-permission-system` public API for it are follow-ups)."

## Decisions (from brainstorming)

- **Shaped by operator clarifications** — chosen options:
  - **A (config service accessor):** new, dedicated `PermissionConfigService`
    published on its own `Symbol.for()` slot, separate from `PermissionsService`.
  - **A (method set, minimal):** `getConfig()` + `toggleYoloMode()` only.
    No `setConfig(partial)`, no `setYoloMode(on|off)` (YAGNI).
  - **α (side effects):** persist core decoupled from UI. `toggleYoloMode()` is
    ctx-free and persists; **notification + status-bar sync are the caller's job**.
    A caller with a ctx (the shortcut handler, the command) does its own
    notify/status; a payload-less external extension toggles silently (the gate
    still takes effect immediately).
  - **Shortcut default:** `Key.ctrlAlt("y")` (`ctrl+alt+y`) — unused by π
    built-ins, `y` is mnemonic for YOLO, matches plan-mode's `ctrl+alt+p` convention.
  - **Command side (choice ①, low-risk):** `/permission-system yolo` keeps its
    existing flow (`controller.config.save` → status + error notify for free) and
    only *shares the pure flip function*; it does not switch to
    `configService.toggleYoloMode()`.
- The shortcut key is a **fixed** `KeyId`; it is NOT a config-file knob.
  Extension shortcuts are raw `KeyId`s and are not rebindable through
  `~/.pi/agent/keybindings.json` (that file only remaps π's namespaced action ids).
  Making it configurable is a follow-up, not in scope.

## Architecture

```
globalThis
 Symbol.for("@gotgenes/pi-permission-system:config-service")
   └── PermissionConfigService
         ├── getConfig(): PermissionSystemExtensionConfig
         └── toggleYoloMode(): PermissionSystemExtensionConfig
               ├── toggleYoloConfig(config)   (shared pure flip)
               └── ConfigStore.saveRuntime(next)  (ctx-free persist core; throws on failure)
                              ▲
      /permission-system yolo ─┘  uses toggleYoloConfig + ConfigStore.save(ctx) (unchanged flow)
      ctrl+alt+y shortcut ───────┘  uses configService.toggleYoloMode() + notify + status sync
```

- The gate (`PermissionManager.isYoloEnabled`) reads `configStore.current()` per
  check, so a persisted flip takes effect on the very next gate resolution even
  without any UI call — persistence and memory update are sufficient.
- Persist, memory update, and debug logging live in one ctx-free core
  (`saveRuntime`); the existing `save(next, ctx)` becomes a thin UI decorator so
  the command keeps byte-identical observable behavior.

## Public API surface (`src/service.ts`)

New in the cross-extension public surface:

```ts
const CONFIG_SERVICE_KEY = Symbol.for("@gotgenes/pi-permission-system:config-service");

export interface PermissionConfigService {
  /** Read-only snapshot of the current runtime extension config. */
  getConfig(): PermissionSystemExtensionConfig;
  /**
   * Flip yoloMode and persist to the global config. Returns the new config.
   * Throws on write failure (the caller owns error surfacing / notification).
   */
  toggleYoloMode(): PermissionSystemExtensionConfig;
}

export function publishPermissionConfigService(service: PermissionConfigService): void;
export function getPermissionConfigService(): PermissionConfigService | undefined;
export function unpublishPermissionConfigService(service: PermissionConfigService): void;
```

- `PermissionSystemExtensionConfig` (`src/extension-config.ts`) becomes a
  **newly public type**: rollup-plugin-dts inlines it into `dist/public.d.ts`
  (it is an internal module, not external). Today it is absent from
  `dist/public.d.ts`.
- Accessor trio mirrors the `PermissionsService` trio
  (`publish/get/unpublish`), including the identity compare-and-delete in unpublish.
- `verify-public-types.sh` gains the new symbols
  (`publishPermissionConfigService`, `getPermissionConfigService`,
  `unpublishPermissionConfigService`, `PermissionConfigService`,
  `PermissionSystemExtensionConfig`) and the consumer `probe.ts` gains
  `getPermissionConfigService`.

## ConfigStore refactor (`src/config-store.ts`)

- **New:** `saveRuntime(next): PermissionSystemExtensionConfig`
  - normalize → atomically write global config (tmp+rename) → update `this.config`
    → debug-log — with **no ctx dependency**.
  - returns the normalized config.
  - **throws** on write failure (caller decides how to surface).
- **Changed:** `save(next, ctx)` becomes a thin decorator with **identical
  observable behavior** for the command:
  ```
  try { const normalized = this.saveRuntime(next); syncPermissionSystemStatus(ctx, normalized); }
  catch (error) { ctx.ui.notify(`Failed to save …`, "error"); }
  ```
- **New narrow interface** `PermissionConfigStore { current(); saveRuntime(next) }`
  so the config service depends on the minimal surface (class already implements
  `ConfigReader`; this follows the `CommandConfigStore` / `SessionConfigStore`
  precedent).

## Internal wiring

### `src/permission-config-service.ts` (new)

- `toggleYoloConfig(config): PermissionSystemExtensionConfig` — the pure flip
  (moved from `config-modal.ts`; exported for the command to import).
- `LocalPermissionConfigService implements PermissionConfigService` — wraps the
  narrow `PermissionConfigStore`; `getConfig()` → `current()`;
  `toggleYoloMode()` → `saveRuntime(toggleYoloConfig(current()))`.

### `src/config-modal.ts`

- `yolo` branch keeps its current flow exactly, only sourcing the flip from the
  shared `toggleYoloConfig`: `const next = toggleYoloConfig(controller.config.current());
  controller.config.save(next, ctx); …notify…`. (Behavior unchanged; existing
  tests are the regression net.)

### Shortcut registration (new, e.g. `src/yolo-shortcut.ts`)

```ts
export function registerYoloModeShortcut(
  pi: ExtensionAPI,
  configService: PermissionConfigService,
): void {
  pi.registerShortcut(Key.ctrlAlt("y"), {
    description: "Toggle YOLO mode",
    handler: (ctx) => {
      let next: PermissionSystemExtensionConfig;
      try {
        next = configService.toggleYoloMode();
      } catch (error) {
        ctx.ui.notify(`Failed to toggle YOLO mode: ${…}`, "error");
        return;
      }
      syncPermissionSystemStatus(ctx, next);
      ctx.ui.notify(
        next.yoloMode ? "YOLO mode ON — ask checks auto-approved" : "YOLO mode off",
        next.yoloMode ? "warning" : "info",
      );
    },
  });
}
```

- The shortcut's `ExtensionContext` satisfies `PermissionStatusContext`
  (`mode`/`hasUI`/`ui`), so `syncPermissionSystemStatus` works as-is.
- Same ON/OFF messages/levels as the command.

### Composition root (`src/index.ts`)

- Construct `LocalPermissionConfigService(configStore)` (configStore exists
  early). `registerPermissionSystemCommand` needs **no** new parameter —
  `config-modal.ts` imports the shared `toggleYoloConfig` statically. Only
  `registerYoloModeShortcut(pi, configService)` receives the *instance*; call it
  from the composition root.
- Extend `PermissionServiceLifecycle` to publish/unpublish **both** services at
  the same `session_start` gate:
  - `activate`: if not a registered child, publish both; then emit ready.
  - `teardown`: run cleanups, then unpublish both (identity-scoped).
- Subagent children still skip publishing; `getPermissionConfigService()`
  inside a child resolves the parent's service.

## Boundaries & edge cases

- **Ctx-free contract:** `toggleYoloMode()` must not assume a UI context. It
  persists + updates memory; notifications/status are the caller's responsibility.
- **TUI-only shortcut:** π dispatches extension shortcuts only in interactive
  mode; the registration is harmless in `rpc`/`json`/`print`. Headless toggling
  stays available via `/permission-system yolo`.
- **Subagent children:** no publish; resolve to the parent's slot.
- **Reload:** identity compare-and-delete keeps a superseded generation from
  wiping the new service.
- **Fail closed:** a thrown persist in the shortcut path surfaces an error
  notification; it is never silently swallowed as success.
- **No config shape / schema changes** — the shortcut key is not a config knob.
  `gen:schema` output must be unchanged (parity test guards drift).

## Testing

- `test/config-store.test.ts` — `saveRuntime`: persists + returns normalized,
  updates memory, debug-logs, throws on write failure; `save` decorator keeps
  prior behavior (existing tests stay green).
- `test/permission-config-service.test.ts` (new) —
  `LocalPermissionConfigService`: `getConfig` returns current; `toggleYoloMode`
  flips + persists + returns new config; propagates persist failure.
- `test/service.test.ts` — config-service accessor trio: publish/get,
  last-write-wins re-publish, identity-scoped unpublish, child never clobbers,
  safe no-op unpublish (mirror the existing trio tests).
- `test/config-modal.test.ts` — existing `yolo` command tests stay green
  (regression for the shared-flip refactor).
- `test/yolo-shortcut.test.ts` (new) — registration key/id + description;
  handler: toggles via stub service, syncs status, ON/OFF notifications;
  error path notifies and leaves state untouched.
- `test/service-lifecycle.test.ts` — both services published at activate,
  child skips, teardown unpublishes both.
- Verification: `pnpm test && pnpm run check && pnpm run lint` and
  `pnpm run verify:public-types` (regenerates `dist/public.d.ts`);
  `pnpm run gen:schema` unchanged.

## Docs & changelog

- `docs/cross-extension-api.md` — new **Configuration API** section: accessor,
  interface, usage snippet (read + toggle), graceful degradation, reload note.
- `README.md` — brief mention of the config service + shortcut in the API /
  integration area if a natural spot exists; no command-reference section added.
- `docs/configuration.md` — **no change** (shortcut is not a config knob).
- `CHANGELOG.md` — not edited (release-please owns it).

## Non-goals

- No config-file knob for the shortcut key (fixed `ctrl+alt+y`).
- No `setYoloMode(on|off)` / `setConfig(partial)` / full-config writer.
- No README/config command-reference documentation section.
- No change to config shape, schema, gate logic, `status.ts`, or existing
  `PermissionsService` surface.
