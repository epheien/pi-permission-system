import { describe, expect, it, vi } from "vitest";
import type { PermissionConfigStore } from "#src/config-store";
import {
  DEFAULT_EXTENSION_CONFIG,
  type PermissionSystemExtensionConfig,
} from "#src/extension-config";
import {
  LocalPermissionConfigService,
  toggleYoloConfig,
} from "#src/permission-config-service";

function makeStore() {
  const state = { config: { ...DEFAULT_EXTENSION_CONFIG } };
  const saveRuntime = vi.fn(
    (
      next: PermissionSystemExtensionConfig,
    ): PermissionSystemExtensionConfig => {
      state.config = next;
      return next;
    },
  );
  const store: PermissionConfigStore = {
    current: () => state.config,
    saveRuntime,
  };
  return { state, saveRuntime, store };
}

describe("toggleYoloConfig", () => {
  it("flips yoloMode on without mutating the input", () => {
    const input = { ...DEFAULT_EXTENSION_CONFIG, yoloMode: false };
    const result = toggleYoloConfig(input);
    expect(result.yoloMode).toBe(true);
    expect(input.yoloMode).toBe(false);
  });

  it("flips yoloMode off", () => {
    const input = { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true };
    expect(toggleYoloConfig(input).yoloMode).toBe(false);
  });
});

describe("LocalPermissionConfigService", () => {
  it("getConfig returns the current config", () => {
    const { store } = makeStore();
    const service = new LocalPermissionConfigService(store);
    expect(service.getConfig()).toEqual(DEFAULT_EXTENSION_CONFIG);
  });

  it("toggleYoloMode flips, persists via saveRuntime, and returns the new config", () => {
    const { saveRuntime, store } = makeStore();
    const service = new LocalPermissionConfigService(store);
    const result = service.toggleYoloMode();
    expect(result.yoloMode).toBe(true);
    expect(saveRuntime).toHaveBeenCalledWith({
      ...DEFAULT_EXTENSION_CONFIG,
      yoloMode: true,
    });
    expect(store.current().yoloMode).toBe(true);
  });

  it("toggleYoloMode flips back when already on", () => {
    const { state, store } = makeStore();
    state.config = { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true };
    const service = new LocalPermissionConfigService(store);
    expect(service.toggleYoloMode().yoloMode).toBe(false);
  });

  it("propagates a persist failure", () => {
    const { saveRuntime, store } = makeStore();
    saveRuntime.mockImplementation(() => {
      throw new Error("disk full");
    });
    const service = new LocalPermissionConfigService(store);
    expect(() => service.toggleYoloMode()).toThrow("disk full");
  });
});
