import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EXTENSION_CONFIG,
  type PermissionSystemExtensionConfig,
} from "#src/extension-config";
import { registerYoloModeShortcut } from "#src/yolo-shortcut";

const mockSyncStatus = vi.hoisted(() => vi.fn<() => void>());
vi.mock("#src/status", () => ({
  syncPermissionSystemStatus: mockSyncStatus,
}));

type Notification = { message: string; level: "info" | "warning" | "error" };

function makeCtx() {
  const notifications: Notification[] = [];
  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      notify(message: string, level: "info" | "warning" | "error") {
        notifications.push({ message, level });
      },
      setStatus: vi.fn(),
    },
  };
  return { ctx, notifications };
}

function makeConfigService(
  result: PermissionSystemExtensionConfig,
): PermissionConfigServiceStub {
  return {
    getConfig: vi.fn(() => result),
    toggleYoloMode: vi.fn(() => result),
  };
}

type PermissionConfigServiceStub = {
  getConfig: ReturnType<typeof vi.fn>;
  toggleYoloMode: ReturnType<typeof vi.fn>;
};

function register(): {
  key: string;
  description: string;
  handler: (ctx: unknown) => void;
} {
  const registerShortcut = vi.fn();
  const pi = { registerShortcut } as never;
  registerYoloModeShortcut(
    pi,
    makeConfigService({
      ...DEFAULT_EXTENSION_CONFIG,
    }) as never,
  );
  const [key, options] = registerShortcut.mock.calls[0] as [
    string,
    { description: string; handler: (ctx: unknown) => void },
  ];
  return { key, description: options.description, handler: options.handler };
}

beforeEach(() => {
  mockSyncStatus.mockReset();
});

describe("registerYoloModeShortcut", () => {
  it("registers ctrl+alt+y with a description", () => {
    const { key, description, handler } = register();
    expect(key).toBe("ctrl+alt+y");
    expect(description).toBe("Toggle YOLO mode");
    expect(typeof handler).toBe("function");
  });

  it("handler toggles yolo on, syncs status, and notifies ON", () => {
    const service = makeConfigService({
      ...DEFAULT_EXTENSION_CONFIG,
      yoloMode: true,
    });
    const registerShortcut = vi.fn();
    registerYoloModeShortcut({ registerShortcut } as never, service as never);
    const { handler } = registerShortcut.mock.calls[0][1] as {
      handler: (ctx: unknown) => void;
    };
    const { ctx, notifications } = makeCtx();
    handler(ctx);
    expect(service.toggleYoloMode).toHaveBeenCalledOnce();
    expect(mockSyncStatus).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ yoloMode: true }),
    );
    expect(notifications[notifications.length - 1]).toEqual({
      message: "YOLO mode ON — ask checks auto-approved",
      level: "warning",
    });
  });

  it("handler toggles yolo off and notifies OFF", () => {
    const service = makeConfigService({
      ...DEFAULT_EXTENSION_CONFIG,
      yoloMode: false,
    });
    const registerShortcut = vi.fn();
    registerYoloModeShortcut({ registerShortcut } as never, service as never);
    const { handler } = registerShortcut.mock.calls[0][1] as {
      handler: (ctx: unknown) => void;
    };
    const { ctx, notifications } = makeCtx();
    handler(ctx);
    expect(notifications[notifications.length - 1]).toEqual({
      message: "YOLO mode off",
      level: "info",
    });
  });

  it("handler notifies an error when toggle throws and does not sync status", () => {
    const service = makeConfigService({
      ...DEFAULT_EXTENSION_CONFIG,
    });
    service.toggleYoloMode.mockImplementation(() => {
      throw new Error("disk full");
    });
    const registerShortcut = vi.fn();
    registerYoloModeShortcut({ registerShortcut } as never, service as never);
    const { handler } = registerShortcut.mock.calls[0][1] as {
      handler: (ctx: unknown) => void;
    };
    const { ctx, notifications } = makeCtx();
    expect(() => handler(ctx)).not.toThrow();
    expect(mockSyncStatus).not.toHaveBeenCalled();
    expect(notifications[notifications.length - 1]).toEqual({
      message: "Failed to toggle YOLO mode: disk full",
      level: "error",
    });
  });
});

describe("registerYoloModeShortcut with a configured shortcut key", () => {
  function captureRegistration(shortcut?: string) {
    const registerShortcut = vi.fn();
    const pi = { registerShortcut } as never;
    registerYoloModeShortcut(
      pi,
      makeConfigService({
        ...DEFAULT_EXTENSION_CONFIG,
      }) as never,
      shortcut,
    );
    return registerShortcut;
  }

  it("registers a custom configured key (normalized)", () => {
    const registerShortcut = captureRegistration("shift+ctrl+p");
    expect(registerShortcut).toHaveBeenCalledWith(
      "ctrl+shift+p",
      expect.objectContaining({ description: "Toggle YOLO mode" }),
    );
  });

  it("registers the default ctrl+alt+y when no shortcut is given", () => {
    const registerShortcut = captureRegistration(undefined);
    expect(registerShortcut).toHaveBeenCalledWith(
      "ctrl+alt+y",
      expect.anything(),
    );
  });

  it("registers nothing when the shortcut is explicitly disabled (blank)", () => {
    const registerShortcut = captureRegistration("");
    expect(registerShortcut).not.toHaveBeenCalled();
  });

  it("registers nothing for a malformed shortcut value", () => {
    const registerShortcut = captureRegistration("foo+y");
    expect(registerShortcut).not.toHaveBeenCalled();
  });
});
