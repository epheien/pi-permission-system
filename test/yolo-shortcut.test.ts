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
    ["ctrl+alt+y"],
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
    registerYoloModeShortcut({ registerShortcut } as never, service as never, [
      "ctrl+alt+y",
    ]);
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
    registerYoloModeShortcut({ registerShortcut } as never, service as never, [
      "ctrl+alt+y",
    ]);
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
    registerYoloModeShortcut({ registerShortcut } as never, service as never, [
      "ctrl+alt+y",
    ]);
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

describe("registerYoloModeShortcut with configured shortcut keys", () => {
  function captureRegistration(keys?: string[]) {
    const registerShortcut = vi.fn();
    const pi = { registerShortcut } as never;
    registerYoloModeShortcut(
      pi,
      makeConfigService({
        ...DEFAULT_EXTENSION_CONFIG,
      }) as never,
      keys ?? [],
    );
    return registerShortcut;
  }

  it("逐键注册数组中的每个键", () => {
    const registerShortcut = captureRegistration(["shift+ctrl+p", "ctrl+m"]);
    expect(registerShortcut).toHaveBeenCalledTimes(2);
    expect(registerShortcut).toHaveBeenNthCalledWith(
      1,
      "ctrl+shift+p",
      expect.objectContaining({ description: "Toggle YOLO mode" }),
    );
    expect(registerShortcut).toHaveBeenNthCalledWith(
      2,
      "ctrl+m",
      expect.objectContaining({ description: "Toggle YOLO mode" }),
    );
  });

  it("空数组 → 不注册(禁用)", () => {
    expect(captureRegistration([])).not.toHaveBeenCalled();
  });

  it("非法元素被跳过, 合法元素照常注册", () => {
    const registerShortcut = captureRegistration(["foo+y", "ctrl+p"]);
    expect(registerShortcut).toHaveBeenCalledTimes(1);
    expect(registerShortcut).toHaveBeenCalledWith("ctrl+p", expect.anything());
  });
});
