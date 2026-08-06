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
  | Pick<ExtensionContext, "hasUI" | "ui">
  | Pick<ExtensionCommandContext, "ui">;

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
  const status = getPermissionSystemStatus(config);
  ctx.ui.setStatus(
    PERMISSION_SYSTEM_STATUS_KEY,
    status === undefined ? undefined : renderYoloStatus(ctx.ui, status),
  );
}

/**
 * Render the yolo status text in a high-visibility red, bold style so an
 * active yolo mode is hard to miss in the status bar.
 */
function renderYoloStatus(
  ui: PermissionStatusContext["ui"],
  status: string,
): string {
  return ui.theme.fg("error", ui.theme.bold(status));
}
