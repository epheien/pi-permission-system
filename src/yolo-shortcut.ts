import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { PermissionSystemExtensionConfig } from "./extension-config";
import { parseShortcutKey } from "./keyboard-shortcut";
import type { PermissionConfigService } from "./service";
import { syncPermissionSystemStatus } from "./status";

/**
 * Register the YOLO-mode toggle shortcuts through the public
 * {@link PermissionConfigService}.
 *
 * The keys come from the normalized `keybindings.yoloToggle` (an array of pi
 * `KeyId` strings): an **empty array** means the shortcut is explicitly
 * disabled (nothing is registered); malformed entries are skipped fail-safe
 * (a malformed string would be silently mis-parsed by pi into a different
 * binding). Each key is registered independently.
 *
 * π dispatches extension shortcuts only in interactive (TUI) mode, so this is
 * the interactive path; headless toggling stays available via the
 * `/permission-system yolo` command. Each handler's ctx carries `ui.notify` +
 * `ui.setStatus`, so the handler owns feedback like the command does: sync the
 * status bar, then notify ON/OFF with the command's exact messages.
 */
export function registerYoloModeShortcut(
  pi: ExtensionAPI,
  configService: PermissionConfigService,
  keys: string[],
): void {
  for (const shortcut of keys) {
    const parsed = parseShortcutKey(shortcut);
    if (!parsed.ok) {
      // Malformed entries were already dropped by normalize; this is a
      // defensive skip so a bad value is never a silently-different binding.
      continue;
    }
    pi.registerShortcut(parsed.key, {
      description: "Toggle YOLO mode",
      handler: (ctx: ExtensionContext) => {
        let next: PermissionSystemExtensionConfig;
        try {
          next = configService.toggleYoloMode();
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
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
}
