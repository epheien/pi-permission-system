import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  EXTENSION_ID,
  isYoloModeEnabled,
  type PermissionSystemExtensionConfig,
} from "./extension-config";

export const PERMISSION_SYSTEM_STATUS_KEY = EXTENSION_ID;
export const PERMISSION_SYSTEM_YOLO_STATUS_VALUE = "yolo";

type PermissionStatusContext =
  | Pick<ExtensionContext, "mode" | "hasUI" | "ui">
  | Pick<ExtensionCommandContext, "mode" | "ui">;

export function getPermissionSystemStatus(
  config: PermissionSystemExtensionConfig,
): string | undefined {
  return isYoloModeEnabled(config)
    ? PERMISSION_SYSTEM_YOLO_STATUS_VALUE
    : undefined;
}

export function syncPermissionSystemStatus(
  ctx: PermissionStatusContext,
  config: PermissionSystemExtensionConfig,
): void {
  ctx.ui.setStatus(
    PERMISSION_SYSTEM_STATUS_KEY,
    styleYoloStatus(ctx, getPermissionSystemStatus(config)),
  );
}

/**
 * Apply the high-visibility red, bold style to the yolo status text so an
 * active yolo mode is hard to miss in the status bar.
 *
 * Styling is deliberately terminal-only: in non-TUI modes (`rpc`, `json`,
 * `print`) the status is forwarded as plain text so RPC clients and other
 * consumers don't receive ANSI escape sequences, and only the yolo status
 * value itself is styled so future status values aren't accidentally painted
 * red.
 */
function styleYoloStatus(
  ctx: PermissionStatusContext,
  status: string | undefined,
): string | undefined {
  if (
    status === undefined ||
    ctx.mode !== "tui" ||
    status !== PERMISSION_SYSTEM_YOLO_STATUS_VALUE
  ) {
    return status;
  }
  return ctx.ui.theme.fg("error", ctx.ui.theme.bold(status));
}
