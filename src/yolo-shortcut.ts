import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { PermissionSystemExtensionConfig } from "./extension-config";
import type { PermissionConfigService } from "./service";
import { syncPermissionSystemStatus } from "./status";

/**
 * Register the `ctrl+alt+y` shortcut that flips YOLO mode through the public
 * {@link PermissionConfigService}.
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
): void {
  pi.registerShortcut(Key.ctrlAlt("y"), {
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
