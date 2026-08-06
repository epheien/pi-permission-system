import type { PermissionConfigStore } from "./config-store";
import type { PermissionSystemExtensionConfig } from "./extension-config";
import type { PermissionConfigService } from "./service";

/**
 * Pure flip of `yoloMode` — the single shared toggle unit.
 *
 * Used by `LocalPermissionConfigService.toggleYoloMode` (persist via the config
 * store) and by the `/permission-system yolo` command (persist via the ctx-aware
 * `save` decorator), so command, shortcut, and external extensions all toggle
 * through the same decision.
 */
export function toggleYoloConfig(
  config: PermissionSystemExtensionConfig,
): PermissionSystemExtensionConfig {
  return { ...config, yoloMode: !config.yoloMode };
}

/**
 * In-process implementation of the public {@link PermissionConfigService}.
 *
 * Wraps the narrow {@link PermissionConfigStore} (the shared `ConfigStore`) so
 * `getConfig()` reflects the live runtime config and `toggleYoloMode()` persists
 * through the same ctx-free core the gates read.
 */
export class LocalPermissionConfigService implements PermissionConfigService {
  constructor(private readonly store: PermissionConfigStore) {}

  getConfig(): PermissionSystemExtensionConfig {
    return this.store.current();
  }

  toggleYoloMode(): PermissionSystemExtensionConfig {
    return this.store.saveRuntime(toggleYoloConfig(this.store.current()));
  }
}
