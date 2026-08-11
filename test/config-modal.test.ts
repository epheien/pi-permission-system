import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { loadUnifiedConfig } from "#src/config-loader";
import { registerPermissionSystemCommand } from "#src/config-modal";
import type { CommandConfigStore } from "#src/config-store";
import {
  DEFAULT_EXTENSION_CONFIG,
  normalizePermissionSystemConfig,
  type PermissionSystemExtensionConfig,
} from "#src/extension-config";
import type { Rule, Ruleset } from "#src/rule";

/** Records the mocked SettingsList's forwarded interaction calls for the modal tests. */
const settingsListSpy = vi.hoisted(() => ({
  handleInputCalls: [] as string[],
  invalidateCalls: 0,
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  getSettingsListTheme: () => ({}),
}));

vi.mock("@earendil-works/pi-tui", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@earendil-works/pi-tui")>();
  return {
    ...actual,
    SettingsList: class {
      handleInput(data: string): void {
        settingsListSpy.handleInputCalls.push(data);
      }
      updateValue(): void {}
      render(): string[] {
        return ["YOLO mode            on", "Debug logging        off"];
      }
      invalidate(): void {
        settingsListSpy.invalidateCalls += 1;
      }
    },
  };
});

type Notification = { message: string; level: "info" | "warning" | "error" };

type CommandContextStub = {
  hasUI: boolean;
  ui: {
    notify(message: string, level: "info" | "warning" | "error"): void;
    custom<T>(
      renderer: (...args: unknown[]) => unknown,
      options?: unknown,
    ): Promise<T>;
  };
};

function createCommandContext(hasUI: boolean): {
  ctx: CommandContextStub;
  notifications: Notification[];
  getCustomCalls(): number;
  getCustomRenderer(): ((...args: unknown[]) => unknown) | undefined;
} {
  const notifications: Notification[] = [];
  let customCalls = 0;
  let capturedRenderer: ((...args: unknown[]) => unknown) | undefined;

  return {
    ctx: {
      hasUI,
      ui: {
        notify(message: string, level: "info" | "warning" | "error") {
          notifications.push({ message, level });
        },
        async custom<T>(
          renderer: (...args: unknown[]) => unknown,
          _options?: unknown,
        ): Promise<T> {
          customCalls += 1;
          capturedRenderer = renderer;
          return undefined as T;
        },
      },
    },
    notifications,
    getCustomCalls: () => customCalls,
    getCustomRenderer: () => capturedRenderer,
  };
}

function lastNotification(notifications: Notification[]): Notification {
  return notifications[notifications.length - 1];
}

test("permission-system command completions expose top-level config actions", () => {
  const baseDir = mkdtempSync(
    join(tmpdir(), "pi-permission-system-command-completions-"),
  );
  const configPath = join(baseDir, "config.json");
  let config: PermissionSystemExtensionConfig = { ...DEFAULT_EXTENSION_CONFIG };

  try {
    const configStore: CommandConfigStore = {
      current: () => config,
      save: (next) => {
        config = next;
      },
    };
    const controller = {
      config: configStore,
      configPath,
      getActiveAgentConfigRules: () => [] as Ruleset,
    };

    let definition: {
      description: string;
      getArgumentCompletions?: (
        argumentPrefix: string,
      ) => Array<{ value: string; label: string; description?: string }> | null;
      handler: (args: string, ctx: CommandContextStub) => Promise<void>;
    } | null = null;

    registerPermissionSystemCommand(
      {
        registerCommand(_name: string, nextDefinition: typeof definition) {
          definition = nextDefinition;
        },
      } as never,
      controller,
    );

    expect(definition!.getArgumentCompletions).toBeTypeOf("function");

    const topLevel = definition!.getArgumentCompletions?.("");
    expect(Array.isArray(topLevel)).toBeTruthy();
    expect(topLevel?.some((item) => item.value === "show")).toBeTruthy();
    expect(topLevel?.some((item) => item.value === "reset")).toBeTruthy();

    const filtered = definition!.getArgumentCompletions?.("pa");
    expect(filtered?.map((item) => item.value)).toEqual(["path"]);
    expect(topLevel?.some((item) => item.value === "yolo")).toBeTruthy();

    const filteredYol = definition!.getArgumentCompletions?.("yol");
    expect(filteredYol?.map((item) => item.value)).toEqual(["yolo"]);
    expect(definition!.getArgumentCompletions?.("path extra")).toBe(null);
    expect(definition!.getArgumentCompletions?.("zzz")).toBe(null);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("permission-system command handlers manage config summary, persistence, and modal routing", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-command-"));
  const configPath = join(baseDir, "config.json");
  let config: PermissionSystemExtensionConfig = {
    ...DEFAULT_EXTENSION_CONFIG,
    debugLog: true,
    permissionReviewLog: false,
    yoloMode: true,
    doublePressToConfirm: true,
  };

  try {
    writeFileSync(
      configPath,
      `${JSON.stringify(normalizePermissionSystemConfig(config), null, 2)}\n`,
      "utf-8",
    );

    const configStore: CommandConfigStore = {
      current: () => config,
      save: (next) => {
        const currentConfig = normalizePermissionSystemConfig(
          loadUnifiedConfig(configPath).config,
        );
        const normalized = normalizePermissionSystemConfig(next);
        writeFileSync(
          configPath,
          `${JSON.stringify(normalized, null, 2)}\n`,
          "utf-8",
        );
        config = normalizePermissionSystemConfig(
          loadUnifiedConfig(configPath).config,
        );
        expect(config).not.toEqual(currentConfig);
      },
    };
    const controller = {
      config: configStore,
      configPath,
      getActiveAgentConfigRules: () => [] as Ruleset,
    };

    let registeredName = "";
    let definition: {
      description: string;
      getArgumentCompletions?: (
        argumentPrefix: string,
      ) => Array<{ value: string; label: string; description?: string }> | null;
      handler: (args: string, ctx: CommandContextStub) => Promise<void>;
    } | null = null;

    registerPermissionSystemCommand(
      {
        registerCommand(name: string, nextDefinition: typeof definition) {
          registeredName = name;
          definition = nextDefinition;
        },
      } as never,
      controller,
    );

    expect(registeredName).toBe("permission-system");
    expect(definition!.description).toContain("Configure pi-permission-system");

    const infoCtx = createCommandContext(true);
    await definition!.handler("show", infoCtx.ctx);
    expect(lastNotification(infoCtx.notifications).message).toContain(
      "yoloMode=on",
    );
    expect(lastNotification(infoCtx.notifications).message).toContain(
      "debugLog=on",
    );

    await definition!.handler("path", infoCtx.ctx);
    expect(lastNotification(infoCtx.notifications).message).toBe(
      `permission-system config: ${configPath}`,
    );

    await definition!.handler("help", infoCtx.ctx);
    expect(lastNotification(infoCtx.notifications).message).toContain(
      "Usage: /permission-system",
    );

    await definition!.handler("reset", infoCtx.ctx);
    expect(config).toEqual(DEFAULT_EXTENSION_CONFIG);
    expect(lastNotification(infoCtx.notifications).message).toBe(
      "Permission system settings reset to defaults.",
    );

    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(persisted).toEqual(DEFAULT_EXTENSION_CONFIG);

    await definition!.handler("unknown", infoCtx.ctx);
    expect(lastNotification(infoCtx.notifications).level).toBe("warning");
    expect(lastNotification(infoCtx.notifications).message).toContain(
      "Usage: /permission-system",
    );

    const headlessCtx = createCommandContext(false);
    await definition!.handler("", headlessCtx.ctx);
    expect(lastNotification(headlessCtx.notifications).message).toBe(
      "/permission-system requires interactive TUI mode.",
    );

    const modalCtx = createCommandContext(true);
    await definition!.handler("", modalCtx.ctx);
    expect(modalCtx.getCustomCalls()).toBe(1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("permission-system yolo command toggles and persists yoloMode", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-yolo-"));
  const configPath = join(baseDir, "config.json");
  let config: PermissionSystemExtensionConfig = {
    ...DEFAULT_EXTENSION_CONFIG,
  };

  try {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");

    const configStore: CommandConfigStore = {
      current: () => config,
      save: (next) => {
        writeFileSync(
          configPath,
          `${JSON.stringify(next, null, 2)}\n`,
          "utf-8",
        );
        config = next;
      },
    };
    const controller = {
      config: configStore,
      configPath,
      getActiveAgentConfigRules: () => [] as Ruleset,
    };

    let definition: {
      handler: (args: string, ctx: CommandContextStub) => Promise<void>;
    } | null = null;

    registerPermissionSystemCommand(
      {
        registerCommand(_name: string, nextDef: typeof definition) {
          definition = nextDef;
        },
      } as never,
      controller,
    );

    // yoloMode starts off; one invocation turns it on and persists.
    const ctx = createCommandContext(false);
    await definition!.handler("yolo", ctx.ctx);
    expect(config.yoloMode).toBe(true);
    expect(lastNotification(ctx.notifications)).toEqual({
      message: "YOLO mode ON — ask checks auto-approved",
      level: "warning",
    });
    const persistedOn = JSON.parse(
      readFileSync(configPath, "utf8"),
    ) as PermissionSystemExtensionConfig;
    expect(persistedOn.yoloMode).toBe(true);

    // Second invocation turns it off and persists.
    await definition!.handler("yolo", ctx.ctx);
    expect(config.yoloMode).toBe(false);
    expect(lastNotification(ctx.notifications)).toEqual({
      message: "YOLO mode off",
      level: "info",
    });
    const persistedOff = JSON.parse(
      readFileSync(configPath, "utf8"),
    ) as PermissionSystemExtensionConfig;
    expect(persistedOff.yoloMode).toBe(false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test("show output includes rule origins when getComposedRules is provided", async () => {
  const config = { ...DEFAULT_EXTENSION_CONFIG };
  const composedRules: Rule[] = [
    {
      surface: "read",
      pattern: "*",
      action: "allow",
      layer: "config",
      origin: "global",
    },
    {
      surface: "bash",
      pattern: "rm *",
      action: "deny",
      layer: "config",
      origin: "project",
    },
  ];

  const controller = {
    config: { current: () => config, save: () => {} } as CommandConfigStore,
    configPath: "/fake/config.json",
    getActiveAgentConfigRules: () => composedRules,
  };

  let definition: {
    handler: (args: string, ctx: CommandContextStub) => Promise<void>;
  } | null = null;

  registerPermissionSystemCommand(
    {
      registerCommand(_name: string, nextDef: typeof definition) {
        definition = nextDef;
      },
    } as never,
    controller,
  );

  const ctx = createCommandContext(true);
  await definition!.handler("show", ctx.ctx);
  const msg = lastNotification(ctx.notifications).message;

  expect(msg).toContain("global");
  expect(msg).toContain("project");
  expect(msg).toContain("read");
  expect(msg).toContain("bash");
});

test("show output omits rule summary when getComposedRules is not provided", async () => {
  const config = { ...DEFAULT_EXTENSION_CONFIG, yoloMode: true };

  const controller = {
    config: { current: () => config, save: () => {} } as CommandConfigStore,
    configPath: "/fake/config.json",
    getActiveAgentConfigRules: () => [] as Ruleset,
  };

  let definition: {
    handler: (args: string, ctx: CommandContextStub) => Promise<void>;
  } | null = null;

  registerPermissionSystemCommand(
    {
      registerCommand(_name: string, nextDef: typeof definition) {
        definition = nextDef;
      },
    } as never,
    controller,
  );

  const ctx = createCommandContext(true);
  await definition!.handler("show", ctx.ctx);
  const msg = lastNotification(ctx.notifications).message;

  // Config knobs still present.
  expect(msg).toContain("yoloMode=on");
  // No rule annotation lines.
  expect(msg).not.toContain("(global)");
});

test("settings modal renders a box frame around the settings list", async () => {
  const baseDir = mkdtempSync(
    join(tmpdir(), "pi-permission-system-modal-frame-"),
  );
  const configPath = join(baseDir, "config.json");
  const config = { ...DEFAULT_EXTENSION_CONFIG };

  try {
    const controller = {
      config: { current: () => config, save: () => {} } as CommandConfigStore,
      configPath,
      getActiveAgentConfigRules: () => [] as Ruleset,
    };

    let definition: {
      handler: (args: string, ctx: CommandContextStub) => Promise<void>;
    } | null = null;

    registerPermissionSystemCommand(
      {
        registerCommand(_name: string, nextDef: typeof definition) {
          definition = nextDef;
        },
      } as never,
      controller,
    );

    const ctx = createCommandContext(true);
    await definition!.handler("", ctx.ctx);

    const renderer = ctx.getCustomRenderer();
    expect(renderer).toBeTypeOf("function");

    const theme = { fg: (_color: string, text: string) => text };
    const component = (
      renderer as (...args: unknown[]) => {
        render(width: number): string[];
        invalidate(): void;
        handleInput(data: string): void;
      }
    )({ requestRender: () => {} }, theme, {}, () => {});
    const lines = component.render(40);

    expect(lines.length).toBeGreaterThan(2);
    expect(lines[0]).toMatch(/^┌/);
    expect(lines[0]).toMatch(/┐$/);
    expect(lines[lines.length - 1]).toMatch(/^└/);
    expect(lines[lines.length - 1]).toMatch(/┘$/);
    for (const line of lines.slice(1, -1)) {
      expect(line.startsWith("│")).toBe(true);
      expect(line.endsWith("│")).toBe(true);
    }

    // handleInput must reach the SettingsList, otherwise keys are dead
    // while the modal holds focus.
    settingsListSpy.handleInputCalls.length = 0;
    component.handleInput("\u001b[B");
    expect(settingsListSpy.handleInputCalls).toEqual(["\u001b[B"]);

    // invalidate is forwarded so the SettingsList can bust cached output.
    settingsListSpy.invalidateCalls = 0;
    component.invalidate();
    expect(settingsListSpy.invalidateCalls).toBe(1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
