# 配置服务 + YOLO 快捷键 实现计划

> **给 agentic 工人：** REQUIRED SUB-SKILL：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务逐项实现。步骤使用 checkbox（`- [ ]`）语法跟踪。

**目标：** 导出公开的 `PermissionConfigService`（`getPermissionConfigService()`），并注册 `ctrl+alt+y` 快捷键切换 YOLO 模式——命令、快捷键、外部扩展共用同一个 toggle 单元。

**架构：** 在 `src/service.ts`（公开面）新增 `PermissionConfigService` 接口 + 访问器三元组；`ConfigStore` 拆出无 ctx 的 `saveRuntime` 持久化核心，`save` 变薄装饰器；新 `LocalPermissionConfigService` 包装窄的 `PermissionConfigStore`；新 `registerYoloModeShortcut` 用 `Key.ctrlAlt("y")` 注册快捷键并自行 notify + 状态栏同步；`PermissionServiceLifecycle` 同时发布/注销两个服务。

**技术栈：** TypeScript、pi 扩展 API（`registerShortcut`）、vitest、pnpm。

## 全局约束

- 只用 `pnpm`——绝不 `npm`/`npx`（AGENTS.md 仓库规则）。
- 不编辑 `CHANGELOG.md`（release-please 拥有它）。
- 不改配置形状/schema/gate 逻辑；快捷键键位**不是**配置项（spec 非目标）。
- `status.ts` 只被新快捷键**使用**，本身不改。
- 匹配文件既有风格：双引号、分号、尾随逗号、2 空格缩进、`function` 声明。
- 验证：`pnpm test`、`pnpm run check`（tsc --noEmit）、`pnpm run lint`；最终任务跑 `pnpm run verify:public-types`（重新生成 `dist/public.d.ts`）与 `pnpm run gen:schema`（输出必须无变化——有 parity 测试防漂移）。
- 测试用 `#src/*` 别名导入（vitest 已映射）；工具函数在 `#test/helpers/*`。

---

### Task 1: `ConfigStore` 无 ctx 持久化核心（`saveRuntime`）+ `PermissionConfigStore` 窄接口

**文件：**
- 修改：`src/config-store.ts`
- 测试：`test/config-store.test.ts`

**接口：**
- 消费：`ConfigStoreDeps`、`PermissionSystemExtensionConfig`（`src/extension-config.ts`）、现有 `loadUnifiedConfig`/`normalizePermissionSystemConfig`/`getGlobalConfigPath`/`syncPermissionSystemStatus`。
- 产出：`ConfigStore.saveRuntime(next: PermissionSystemExtensionConfig): PermissionSystemExtensionConfig`（无 ctx，失败抛错），以及窄接口 `PermissionConfigStore { current(); saveRuntime(next) }`（`src/config-store.ts`）——Task 2/5 依赖。

- [ ] **Step 1: 写失败的测试**

在 `test/config-store.test.ts` 的 `describe("save()", …)` 块之后、`describe("logResolvedPaths()", …)` 之前，插入一个 `describe("saveRuntime()", …)` 块（复用同文件已有的 `makeStore`/`makeCommandCtx`/mocks）：

```ts
  // ── saveRuntime() ────────────────────────────────────────────────────

  describe("saveRuntime()", () => {
    it("persists via tmp write + rename and returns the normalized config", () => {
      const { store } = makeStore();
      mockLoadUnifiedConfig.mockReturnValue({
        config: { permission: { "*": "ask" } },
      });
      const next = { ...DEFAULT_EXTENSION_CONFIG, debugLog: true };
      const result = store.saveRuntime(next);
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining(".tmp"),
        expect.stringContaining('"debugLog": true'),
        "utf-8",
      );
      expect(mockRenameSync).toHaveBeenCalled();
      expect(result.debugLog).toBe(true);
    });

    it("updates current() after a successful saveRuntime", () => {
      const { store } = makeStore();
      store.saveRuntime({ ...DEFAULT_EXTENSION_CONFIG, yoloMode: true });
      expect(store.current().yoloMode).toBe(true);
    });

    it("writes config.saved debug log after a successful saveRuntime", () => {
      const { store, logger } = makeStore();
      store.saveRuntime({ ...DEFAULT_EXTENSION_CONFIG });
      expect(logger.debug).toHaveBeenCalledWith(
        "config.saved",
        expect.objectContaining({ yoloMode: false }),
      );
    });

    it("throws on write failure, leaves current() unchanged, and logs nothing", () => {
      const { store, logger } = makeStore();
      mockMkdirSync.mockImplementation(() => {
        throw new Error("disk full");
      });
      expect(() => store.saveRuntime({ ...DEFAULT_EXTENSION_CONFIG })).toThrow(
        "disk full",
      );
      expect(store.current()).toEqual(DEFAULT_EXTENSION_CONFIG);
      expect(logger.debug).not.toHaveBeenCalledWith(
        "config.saved",
        expect.anything(),
      );
    });

    it("does not call syncPermissionSystemStatus (no ctx dependency)", () => {
      const { store } = makeStore();
      store.saveRuntime({ ...DEFAULT_EXTENSION_CONFIG });
      expect(mockSyncPermissionSystemStatus).not.toHaveBeenCalled();
    });
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test -- test/config-store.test.ts`
Expected: FAIL——`saveRuntime` 不存在（TypeError/编译错误），新测试块全部失败；既有 `save()` 测试仍通过。

- [ ] **Step 3: 实现最小代码**

在 `src/config-store.ts`：

1. 在 `CommandConfigStore` 接口之后新增窄接口：

```ts
/**
 * Narrow subset of `ConfigStore` for the public config service: read the
 * current config and persist a replacement without any UI context.
 *
 * Using an interface rather than the concrete class avoids private-member
 * coupling between the class and test doubles.
 */
export interface PermissionConfigStore extends ConfigReader {
  saveRuntime(next: PermissionSystemExtensionConfig): PermissionSystemExtensionConfig;
}
```

2. 将 `export class ConfigStore implements SessionConfigStore, CommandConfigStore {` 改为：

```ts
export class ConfigStore
  implements SessionConfigStore, CommandConfigStore, PermissionConfigStore
{
```

3. 在 `save(next, ctx)` **之前**新增 `saveRuntime`（把原子写盘 + 更新内存 + 日志的核心逻辑从 `save` 移出，失败改为 `throw`）：

```ts
  /**
   * Persist a replacement runtime config to the global config file and update
   * the current config, with no UI context dependency.
   *
   * This is the ctx-free core behind {@link save}. It returns the normalized
   * config and throws on write failure — the caller owns error surfacing.
   */
  saveRuntime(
    next: PermissionSystemExtensionConfig,
  ): PermissionSystemExtensionConfig {
    const normalized = normalizePermissionSystemConfig(next);
    const globalPath = getGlobalConfigPath(this.deps.agentDir);

    const existing = loadUnifiedConfig(globalPath);
    const merged = {
      ...existing.config,
      debugLog: normalized.debugLog,
      permissionReviewLog: normalized.permissionReviewLog,
      yoloMode: normalized.yoloMode,
    };

    const tmpPath = `${globalPath}.tmp`;
    try {
      mkdirSync(dirname(globalPath), { recursive: true });
      writeFileSync(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
      renameSync(tmpPath, globalPath);
    } catch (error) {
      try {
        if (existsSync(tmpPath)) {
          unlinkSync(tmpPath);
        }
      } catch {
        // Ignore cleanup failures.
      }
      throw error;
    }

    this.config = normalized;
    this.lastConfigWarning = null;

    this.deps.logger.debug("config.saved", {
      debugLog: normalized.debugLog,
      permissionReviewLog: normalized.permissionReviewLog,
      yoloMode: normalized.yoloMode,
    });
    return normalized;
  }
```

4. 把现有 `save(next, ctx)` 的**方法体**整体替换为薄装饰器（保留 JSDoc，可微调说明它委托给 `saveRuntime`）：

```ts
  save(
    next: PermissionSystemExtensionConfig,
    ctx: ExtensionCommandContext,
  ): void {
    try {
      const normalized = this.saveRuntime(next);
      syncPermissionSystemStatus(ctx, normalized);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Failed to save permission-system config at '${getGlobalConfigPath(this.deps.agentDir)}': ${message}`,
        "error",
      );
    }
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test -- test/config-store.test.ts`
Expected: PASS——新增 5 个 `saveRuntime` 测试 + 既有 9 个 `save()` 测试全部绿色（装饰器行为逐字节保持）。

- [ ] **Step 5: 提交**

```bash
git add src/config-store.ts test/config-store.test.ts
git commit -m "refactor(pi-permission-system): extract ctx-free saveRuntime persist core"
```

---

### Task 2: 公开配置服务接口 + 访问器三元组 + `LocalPermissionConfigService`

**文件：**
- 修改：`src/service.ts`
- 创建：`src/permission-config-service.ts`
- 测试：`test/service.test.ts`、`test/permission-config-service.test.ts`（新建）

**接口：**
- 消费：`PermissionConfigStore`（Task 1 产出）、`PermissionSystemExtensionConfig`。
- 产出：`PermissionConfigService { getConfig(); toggleYoloMode() }`、`publishPermissionConfigService` / `getPermissionConfigService` / `unpublishPermissionConfigService`、共享纯翻转 `toggleYoloConfig(config)`、`LocalPermissionConfigService`——Task 3/4/5 依赖。

- [ ] **Step 1: 写失败的测试**

**(a)** 在 `test/service.test.ts` 顶部 import 区补：

```ts
import {
  getPermissionConfigService,
  getPermissionsService,
  publishPermissionConfigService,
  publishPermissionsService,
  unpublishPermissionConfigService,
  unpublishPermissionsService,
} from "#src/service";
import type {
  PermissionConfigService,
  PermissionsService,
} from "#src/service";
```

（把原来的 `type PermissionsService` 与函数 import 合并到上面两组里，删除旧的两行。）

**(b)** 在 `test/service.test.ts` 的 `describe("globalThis accessor", …)` 块之后插入：

```ts
// ── config service globalThis accessor ───────────────────────────────────

function makeConfigService(): PermissionConfigService {
  return { getConfig: vi.fn(), toggleYoloMode: vi.fn() };
}

describe("config service globalThis accessor", () => {
  afterEach(() => {
    const current = getPermissionConfigService();
    if (current) {
      unpublishPermissionConfigService(current);
    }
  });

  it("returns undefined when nothing has been published", () => {
    expect(getPermissionConfigService()).toBeUndefined();
  });

  it("returns the published config service", () => {
    const service = makeConfigService();
    publishPermissionConfigService(service);
    expect(getPermissionConfigService()).toBe(service);
  });

  it("overwrites a previously published config service", () => {
    const first = makeConfigService();
    const second = makeConfigService();
    publishPermissionConfigService(first);
    publishPermissionConfigService(second);
    expect(getPermissionConfigService()).toBe(second);
  });

  it("removes the slot when it still holds the given service", () => {
    const service = makeConfigService();
    publishPermissionConfigService(service);
    unpublishPermissionConfigService(service);
    expect(getPermissionConfigService()).toBeUndefined();
  });

  it("does not remove the slot when a different service occupies it", () => {
    const parent = makeConfigService();
    const child = makeConfigService();
    publishPermissionConfigService(parent);
    unpublishPermissionConfigService(child);
    expect(getPermissionConfigService()).toBe(parent);
  });

  it("unpublish is safe to call when nothing was published", () => {
    expect(() =>
      unpublishPermissionConfigService(makeConfigService()),
    ).not.toThrow();
    expect(getPermissionConfigService()).toBeUndefined();
  });
});
```

**(c)** 新建 `test/permission-config-service.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import {
  LocalPermissionConfigService,
  toggleYoloConfig,
} from "#src/permission-config-service";
import type { PermissionConfigStore } from "#src/config-store";
import {
  DEFAULT_EXTENSION_CONFIG,
  type PermissionSystemExtensionConfig,
} from "#src/extension-config";

function makeStore() {
  const state = { config: { ...DEFAULT_EXTENSION_CONFIG } };
  const saveRuntime = vi.fn(
    (next: PermissionSystemExtensionConfig): PermissionSystemExtensionConfig => {
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test -- test/service.test.ts test/permission-config-service.test.ts`
Expected: FAIL——`getPermissionConfigService`/`PermissionConfigService`/`LocalPermissionConfigService`/`toggleYoloConfig` 不存在。

- [ ] **Step 3: 实现最小代码**

**(a)** 在 `src/service.ts` 顶部 import 区，`import type { PermissionCheckResult, PermissionState } from "./types";` 之后加：

```ts
import type { PermissionSystemExtensionConfig } from "./extension-config";
```

**(b)** 在 `const SERVICE_KEY = Symbol.for("@gotgenes/pi-permission-system:service");` 之后加：

```ts
/** Process-global key for the config service slot. */
const CONFIG_SERVICE_KEY = Symbol.for(
  "@gotgenes/pi-permission-system:config-service",
);
```

**(c)** 在文件末尾 `unpublishPermissionsService` 函数之后追加：

```ts
/**
 * Public configuration surface exposed via `getPermissionConfigService()`.
 *
 * A read-only snapshot plus one mutation: flip `yoloMode` and persist it to the
 * global config through the same ctx-free core the gates read, so it takes
 * effect on the very next gate resolution. Persistence is ctx-free — the caller
 * owns any notification / status-bar feedback (the extension's own `ctrl+alt+y`
 * shortcut and the `/permission-system yolo` command both build on this unit).
 */
export interface PermissionConfigService {
  /** Current runtime extension config snapshot (read-only). */
  getConfig(): PermissionSystemExtensionConfig;
  /**
   * Flip `yoloMode` and persist it to the global config, then return the new
   * config. Throws on write failure — the caller surfaces the error.
   */
  toggleYoloMode(): PermissionSystemExtensionConfig;
}

/**
 * Store a `PermissionConfigService` on `globalThis` so other extensions can
 * retrieve it via `getPermissionConfigService()`.
 *
 * Mirror of {@link publishPermissionsService}: called at `session_start` by the
 * top-level (parent) instance only (Task 5 wires this). Overwrites any
 * previously published service, which keeps `/reload` working.
 */
export function publishPermissionConfigService(
  service: PermissionConfigService,
): void {
  (globalThis as Record<symbol, unknown>)[CONFIG_SERVICE_KEY] = service;
}

/**
 * Retrieve the published `PermissionConfigService`, or `undefined` if the
 * permission-system extension has not loaded (or has been unloaded).
 */
export function getPermissionConfigService(): PermissionConfigService | undefined {
  return (globalThis as Record<symbol, unknown>)[CONFIG_SERVICE_KEY] as
    | PermissionConfigService
    | undefined;
}

/**
 * Remove `service` from `globalThis`, but only when the current slot still
 * holds it (identity compare-and-delete). Mirrors {@link unpublishPermissionsService}.
 */
export function unpublishPermissionConfigService(
  service: PermissionConfigService,
): void {
  if (getPermissionConfigService() !== service) {
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global property; Map.delete() is not applicable
  delete (globalThis as Record<symbol, unknown>)[CONFIG_SERVICE_KEY];
}
```

**(d)** 新建 `src/permission-config-service.ts`：

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test -- test/service.test.ts test/permission-config-service.test.ts`
Expected: PASS——访问器三元组 6 项 + `toggleYoloConfig` 2 项 + `LocalPermissionConfigService` 4 项全绿；既有 `service.test.ts` 其余测试不回归。

- [ ] **Step 5: 提交**

```bash
git add src/service.ts src/permission-config-service.ts test/service.test.ts test/permission-config-service.test.ts
git commit -m "feat(pi-permission-system): publish a public config service accessor"
```

---

### Task 3: `ctrl+alt+y` 快捷键切换 YOLO 模式

**文件：**
- 创建：`src/yolo-shortcut.ts`
- 测试：`test/yolo-shortcut.test.ts`（新建）

**接口：**
- 消费：`PermissionConfigService`（Task 2 产出）、`syncPermissionSystemStatus`（`src/status.ts`）、`Key`（`@earendil-works/pi-tui`）、`ExtensionAPI`（`@earendil-works/pi-coding-agent`）。
- 产出：`registerYoloModeShortcut(pi: ExtensionAPI, configService: PermissionConfigService): void`——Task 5 调用。

- [ ] **Step 1: 写失败的测试**

新建 `test/yolo-shortcut.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
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
  registerYoloModeShortcut(pi as never, makeConfigService({
    ...DEFAULT_EXTENSION_CONFIG,
  }));
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
    registerYoloModeShortcut(
      { registerShortcut } as never,
      service as never,
    );
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
    registerYoloModeShortcut(
      { registerShortcut } as never,
      service as never,
    );
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
    registerYoloModeShortcut(
      { registerShortcut } as never,
      service as never,
    );
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test -- test/yolo-shortcut.test.ts`
Expected: FAIL——`#src/yolo-shortcut` 模块不存在。

- [ ] **Step 3: 实现最小代码**

新建 `src/yolo-shortcut.ts`：

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test -- test/yolo-shortcut.test.ts`
Expected: PASS——4 项全绿。

- [ ] **Step 5: 提交**

```bash
git add src/yolo-shortcut.ts test/yolo-shortcut.test.ts
git commit -m "feat(pi-permission-system): add ctrl+alt+y shortcut to toggle yolo mode"
```

---

### Task 4: `/permission-system yolo` 命令共享同一个 toggle 单元

**文件：**
- 修改：`src/config-modal.ts`
- 测试：`test/config-modal.test.ts`（回归，不改断言）

**接口：**
- 消费：`toggleYoloConfig`（Task 2 产出）。
- 产出：无新接口——命令行为零变化，`controller.config.save(next, ctx)` 保持（状态栏 + 错误通知仍由 `save` 装饰器负责）。

- [ ] **Step 1: 确认现有测试为回归网**

Run: `pnpm test -- test/config-modal.test.ts`
Expected: PASS（改动前基线）。

- [ ] **Step 2: 重构**

在 `src/config-modal.ts`：

1. 顶部 import 区（`import type { CommandConfigStore } from "./config-store";` 之后）加：

```ts
import { toggleYoloConfig } from "./permission-config-service";
```

2. **删除**模块内的私有函数：

```ts
function toggleYoloMode(
  config: PermissionSystemExtensionConfig,
): PermissionSystemExtensionConfig {
  return { ...config, yoloMode: !config.yoloMode };
}
```

3. `yolo` 分支的 `const next = toggleYoloMode(controller.config.current());` 改为：

```ts
    const next = toggleYoloConfig(controller.config.current());
```

- [ ] **Step 3: 运行测试确认通过**

Run: `pnpm test -- test/config-modal.test.ts`
Expected: PASS——"permission-system yolo command toggles and persists yoloMode" 等既有测试全绿（行为不变；`PermissionSystemExtensionConfig` 类型 import 若无其它用处，检查 `pnpm run check` 是否报 unused——若非 unused 则保留，否则从 import 列表移除）。

- [ ] **Step 4: 提交**

```bash
git add src/config-modal.ts
git commit -m "refactor(pi-permission-system): share the yolo toggle unit with the command"
```

---

### Task 5: 组合根接线 + 生命周期双服务发布

**文件：**
- 修改：`src/index.ts`、`src/service-lifecycle.ts`
- 测试：`test/service-lifecycle.test.ts`

**接口：**
- 消费：`LocalPermissionConfigService`、`registerYoloModeShortcut`（Task 2/3）、`publishPermissionConfigService`/`unpublishPermissionConfigService`（Task 2）。
- 产出：`PermissionServiceLifecycle` 构造函数增加第二个服务参数——组合根与测试依赖此签名。

- [ ] **Step 1: 写失败的测试**

在 `test/service-lifecycle.test.ts`：

**(a)** 顶部 mock 工厂补两个 hoisted mock（在 `mockUnpublishPermissionsService` 之后加）：

```ts
const mockPublishPermissionConfigService = vi.hoisted(() => vi.fn<() => void>());
const mockUnpublishPermissionConfigService = vi.hoisted(() => vi.fn<() => void>());
```

并把 `vi.mock("#src/service", …)` 替换为：

```ts
vi.mock("#src/service", () => ({
  publishPermissionsService: mockPublishPermissionsService,
  unpublishPermissionsService: mockUnpublishPermissionsService,
  publishPermissionConfigService: mockPublishPermissionConfigService,
  unpublishPermissionConfigService: mockUnpublishPermissionConfigService,
}));
```

**(b)** 加 helper：

```ts
function makeConfigService(): PermissionConfigService {
  return { getConfig: vi.fn(), toggleYoloMode: vi.fn() };
}
```

并把 `makeLifecycle` 改为传两个服务：

```ts
function makeLifecycle(overrides?: { subscriptions?: (() => void)[] }) {
  const service = makeService();
  const configService = makeConfigService();
  const detection = makeDetection();
  const events = { emit: vi.fn(), on: vi.fn() };
  const subscriptions = overrides?.subscriptions ?? [];
  const lifecycle = new PermissionServiceLifecycle(
    service,
    configService,
    detection,
    events,
    subscriptions,
  );
  return { lifecycle, service, configService, detection, events, subscriptions };
}
```

**(c)** import 区补类型与 mock 重置（`beforeEach` 里对两个新 mock 也 `.mockReset()`）：`mockPublishPermissionConfigService.mockReset(); mockUnpublishPermissionConfigService.mockReset();`。import 加 `import type { PermissionConfigService } from "#src/service";`（合并进现有 type import）。

**(d)** 在 `describe("activate", …)` 里加：

```ts
  it("publishes both services for a non-child session", () => {
    const ctx = makeCtx();
    const { lifecycle, service, configService } = makeLifecycle();
    mockIsRegisteredChild.mockReturnValue(false);
    lifecycle.activate(ctx);
    expect(mockPublishPermissionsService).toHaveBeenCalledWith(service);
    expect(mockPublishPermissionConfigService).toHaveBeenCalledWith(
      configService,
    );
  });

  it("skips publishing either service for a registered child session", () => {
    const ctx = makeCtx();
    const { lifecycle } = makeLifecycle();
    mockIsRegisteredChild.mockReturnValue(true);
    lifecycle.activate(ctx);
    expect(mockPublishPermissionsService).not.toHaveBeenCalled();
    expect(mockPublishPermissionConfigService).not.toHaveBeenCalled();
  });
```

**(e)** 在 `describe("teardown", …)` 里加：

```ts
  it("unpublishes both services after running subscriptions", () => {
    const { lifecycle, service, configService } = makeLifecycle();
    lifecycle.teardown();
    expect(mockUnpublishPermissionsService).toHaveBeenCalledWith(service);
    expect(mockUnpublishPermissionConfigService).toHaveBeenCalledWith(
      configService,
    );
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test -- test/service-lifecycle.test.ts`
Expected: FAIL——构造函数仍只收 1 个服务参数，类型/运行时错误。

- [ ] **Step 3: 实现最小代码**

**(a)** `src/service-lifecycle.ts`——import 区更新：

```ts
import {
  type PermissionConfigService,
  type PermissionsService,
  publishPermissionConfigService,
  publishPermissionsService,
  unpublishPermissionConfigService,
  unpublishPermissionsService,
} from "./service";
```

构造函数与 activate/teardown：

```ts
export class PermissionServiceLifecycle implements ServiceLifecycle {
  constructor(
    private readonly service: PermissionsService,
    private readonly configService: PermissionConfigService,
    private readonly detection: RegisteredChildDetector,
    private readonly events: PermissionEventBus,
    private readonly subscriptions: readonly (() => void)[],
  ) {}

  activate(ctx: ExtensionContext): void {
    if (!this.detection.isRegisteredChild(ctx)) {
      publishPermissionsService(this.service);
      publishPermissionConfigService(this.configService);
    }
    emitReadyEvent(this.events);
  }

  teardown(): void {
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    unpublishPermissionsService(this.service);
    unpublishPermissionConfigService(this.configService);
  }
}
```

（同步更新类 JSDoc：提及两个服务同时发布/注销。）

**(b)** `src/index.ts`——import 区加：

```ts
import { LocalPermissionConfigService } from "./permission-config-service";
import { registerYoloModeShortcut } from "./yolo-shortcut";
```

在 `registerPermissionSystemCommand(pi, { … });` 块之后加：

```ts
  // The public config surface: constructed over the same configStore the gates
  // read, so a toggle persists through the ctx-free saveRuntime core and takes
  // effect immediately. The ctrl+alt+y shortcut and the /permission-system yolo
  // command both toggle through this unit.
  const configService = new LocalPermissionConfigService(configStore);
  registerYoloModeShortcut(pi, configService);
```

把 `PermissionServiceLifecycle` 构造调用改为传两个服务：

```ts
  const serviceLifecycle = new PermissionServiceLifecycle(
    permissionsService,
    configService,
    subagentDetection,
    pi.events,
    [unsubSubagentLifecycle],
  );
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test -- test/service-lifecycle.test.ts test/composition-root.test.ts`
Expected: PASS——activate/teardown 新增断言全绿；composition-root 测试不回归。

- [ ] **Step 5: 提交**

```bash
git add src/index.ts src/service-lifecycle.ts test/service-lifecycle.test.ts
git commit -m "feat(pi-permission-system): publish config service and wire the yolo shortcut"
```

---

### Task 6: 公开面验证（`verify-public-types`）+ schema 不变

**文件：**
- 修改：`scripts/verify-public-types.sh`
- 生成：`dist/public.d.ts`（`pnpm run build:types` 重新生成）

**接口：**
- 消费：Task 2 新增的公开符号。

- [ ] **Step 1: 更新符号清单**

在 `scripts/verify-public-types.sh` 的符号 `for` 循环里加入（保持与现有符号同组）：

```sh
for sym in getPermissionsService publishPermissionsService unpublishPermissionsService \
  getPermissionConfigService publishPermissionConfigService unpublishPermissionConfigService \
  PermissionConfigService PermissionSystemExtensionConfig \
  PermissionsService PermissionCheckResult PermissionState ToolInputFormatter \
  PERMISSIONS_UI_PROMPT_CHANNEL PERMISSIONS_READY_CHANNEL PERMISSIONS_DECISION_CHANNEL \
  PermissionUiPromptEvent registerAuthorizer PermissionQuery Authorizer \
  AuthorizerVerdict PromptPermissionDetails; do
```

并在消费者 `probe.ts` 的 import 与使用处扩展：

```ts
import {
  getPermissionsService,
  getPermissionConfigService,
  PERMISSIONS_UI_PROMPT_CHANNEL,
  type PermissionCheckResult,
  type PermissionUiPromptEvent,
} from "@gotgenes/pi-permission-system";

void getPermissionsService;
void getPermissionConfigService;
void PERMISSIONS_UI_PROMPT_CHANNEL;
const _e: PermissionUiPromptEvent | undefined = undefined;
const _r: PermissionCheckResult | undefined = undefined;
void _e;
void _r;
```

- [ ] **Step 2: 运行验证**

Run: `pnpm run verify:public-types`
Expected: 两条 OK；`dist/public.d.ts` 被 `prepack → build:types` 重新生成，其中包含 `PermissionConfigService` 与 `PermissionSystemExtensionConfig`。

- [ ] **Step 3: 确认 schema 不变**

Run: `pnpm run gen:schema && git diff --exit-code schemas/permissions.schema.json`
Expected: 无 diff（快捷键不是配置项；parity 测试防漂移）。

- [ ] **Step 4: 运行全量验证**

Run: `pnpm test && pnpm run check && pnpm run lint`
Expected: 全绿、lint 干净。

- [ ] **Step 5: 提交**

```bash
git add scripts/verify-public-types.sh dist/public.d.ts
git commit -m "chore(pi-permission-system): verify the public config service surface"
```

---

### Task 7: 文档（cross-extension-api + README）

**文件：**
- 修改：`docs/cross-extension-api.md`、`README.md`

**接口：** 无代码接口——纯文档。

- [ ] **Step 1: 在 `docs/cross-extension-api.md` 补 "Configuration API" 小节**

在 "## Event API" 标题**之前**插入一个新 `## Configuration API` 小节（在本节的 "Service Accessor" 之后、Event API 之前），内容要点：
- 访问器 `getPermissionConfigService()`，Symbol 槽 `@gotgenes/pi-permission-system:config-service`。
- 接口 `PermissionConfigService { getConfig(); toggleYoloMode() }` 的说明：`getConfig()` 只读快照；`toggleYoloMode()` 翻转并持久化、返回新配置、失败抛错、无 UI 依赖——通知/状态栏由调用方负责。
- 用法示例（读取 + 切换，含 try/catch + `getPermissionsService()` 同款优雅降级护栏）。
- 说明：`/reload` 后重新解析；子 agent 内解析到父进程服务；TUI 快捷键 `ctrl+alt+y` 也是这个服务的一个调用方（`docs` 提一句即可，快捷键详细说明在 README）。
- 提示 `toggleYoloMode()` 会立刻影响 gate（下一次判定生效）。

示例代码块（放在小节内）：

```typescript
const { getPermissionConfigService } = await import(
  "@gotgenes/pi-permission-system"
);
const configService = getPermissionConfigService();
if (configService) {
  console.log(configService.getConfig().yoloMode ? "yolo on" : "yolo off");
  const next = configService.toggleYoloMode(); // persists; throws on write failure
  console.log(next.yoloMode ? "yolo on" : "yolo off");
}
```

- [ ] **Step 2: 在 `README.md` 提一句**

在 README 的集成/API 相关小节（若有自然的 "Extension API" / "Integration" 区域）加一句：公开配置服务 `getPermissionConfigService()` 可读取/切换 YOLO 模式；`ctrl+alt+y` 快捷键可随时切换（TUI）；`/permission-system yolo` 是无头/CLI 路径。若 README 无此类小节，则保持最小——只在恰好处加一行，不要新增长文档章节（spec 非目标）。

- [ ] **Step 3: 运行 lint**

Run: `pnpm run lint:md`
Expected: markdown lint 干净（rumdl 风格：标题层级、列表、行宽等按 `.rumdl.toml`）。

- [ ] **Step 4: 提交**

```bash
git add docs/cross-extension-api.md README.md
git commit -m "docs(pi-permission-system): document the configuration service and yolo shortcut"
```

---

## 自审

- **Spec 覆盖**：Task 1（saveRuntime 核心）✓；Task 2（公开接口/三元组/实现）✓；Task 3（ctrl+alt+y 快捷键）✓；Task 4（命令共享 toggle 单元，选择①）✓；Task 5（组合根 + 生命周期双服务发布）✓；Task 6（verify-public-types + schema 不变）✓；Task 7（文档，配置文档不改）✓；非目标全部不实现。
- **占位符**：无 TBD/TODO；所有代码步骤含完整代码块。
- **类型一致性**：`PermissionConfigStore`（Task 1）被 Task 2/5 消费；`PermissionConfigService`/`toggleYoloConfig`/`LocalPermissionConfigService`（Task 2）被 Task 3/4/5 消费；`saveRuntime`（Task 1）被 Task 2 的 `LocalPermissionConfigService` 调用；生命周期签名（Task 5）与 `service-lifecycle.test.ts` 一致。`save()` 装饰器保持 `(next, ctx)` 签名，命令侧无忧。
