import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { PermissionSystemExtensionConfig } from "./extension-config";
import { parseShortcutKey } from "./keyboard-shortcut";
import type { PermissionConfigService } from "./service";
import { syncPermissionSystemStatus } from "./status";

/** Default shortcut key used when the config does not specify one. */
export const DEFAULT_YOLO_MODE_SHORTCUT = Key.ctrlAlt("y");

/**
 * Register the YOLO-mode toggle shortcut through the public
 * {@link PermissionConfigService}.
 *
 * The key comes from the config (`yoloModeShortcut`, a pi `KeyId` string):
 * - absent → the default {@link DEFAULT_YOLO_MODE_SHORTCUT} (`ctrl+alt+y`);
 * - blank → the shortcut is explicitly disabled (nothing registered);
 * - malformed → fail-safe: nothing is registered (a malformed string would be
 *   silently mis-parsed by pi into a different binding);
 * - valid → registered with that exact key.
 *
 * π dispatches extension shortcuts only in interactive (TUI) mode, so this is
 * the interactive path; headless toggling stays available via the
 * `/permission-system yolo` command. The shortcut's ctx carries `ui.notify` +
 * `ui.setStatus`, so the handler owns feedback like the command does: sync the
 * status bar, then notify ON/OFF with the command's exact messages.
 */
export function registerYoloModeShortcut(
  pi: ExtensionAPI,
  configService: PermissionConfigService,
  shortcut?: string,
): void {
  const parsed = parseShortcutKey(shortcut ?? DEFAULT_YOLO_MODE_SHORTCUT);
  if (!parsed.ok) {
    // Blank → disabled; malformed → never a silently-different binding.
    return;
  }
  pi.registerShortcut(parsed.key, {
    description: "Toggle YOLO mode",
    handler: (ctx: ExtensionContext) => {
      let next: PermissionSystemExtensionConfig;
      try {
        next = configService.toggleYoloMode();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to toggle YOLO mode: ${message}`, "error");
        return;
      }
      syncPermissionSystemStatus(ctx, next);
      ctx.ui.notify(
        next.yoloMode
          ? "YOLO mode ON — ask checks auto-approved"
          : "YOLO mode off",
        next.yoloMode ? "warning" : "info",
      );
    },
  });
}
