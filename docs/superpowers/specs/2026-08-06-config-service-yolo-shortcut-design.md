# 配置服务 + YOLO 模式快捷键 — 设计

日期：2026-08-06
状态：已获操作者批准（设计评审）

## 摘要

导出一个公开的**配置服务**（`getPermissionConfigService()`），并注册一个**键盘快捷键**
（`ctrl+alt+y`）用于切换 YOLO 模式；两者共用同一个切换单元
（纯翻转函数 + `ConfigStore` 持久化核心）。

这是 `/permission-system yolo` 子命令计划
（`docs/plans/permission-system-yolo-toggle-subcommand.md`）明确推迟的后续工作：
> “本迭代不做键盘快捷键注册（内部 `registerShortcut`、外部扩展绑定，以及任何
> `pi-permission-system` 公开 API 都是后续工作）。”

## 决策（来自头脑风暴澄清）

- **由操作者澄清确认的选择**：
  - **A（配置服务访问器）：** 新增专用的 `PermissionConfigService`，发布在其专属的
    `Symbol.for()` 槽位上，与 `PermissionsService` 分离。
  - **A（最小方法集）：** 仅 `getConfig()` + `toggleYoloMode()`。
    不做 `setConfig(partial)`、不做 `setYoloMode(on|off)`（YAGNI）。
  - **α（副作用处理）：** 持久化核心与 UI 解耦。`toggleYoloMode()` 无 ctx 并完成持久化；
    **通知 + 状态栏同步由调用方负责**。有 ctx 的调用方（快捷键 handler、命令）自己做
    notify/状态栏同步；无 UI 的外部扩展静默切换（gate 仍立即生效）。
  - **默认快捷键：** `Key.ctrlAlt("y")`（`ctrl+alt+y`）——π 内建无占用，
    `y` 是 YOLO 的首字母，与 plan-mode 的 `ctrl+alt+p` 惯例一致。
  - **命令侧（选择①，低风险）：** `/permission-system yolo` 保持现有流程
    （`controller.config.save` → 免费获得状态栏 + 错误通知），仅**共享纯翻转函数**；
    不改走 `configService.toggleYoloMode()`。
- 快捷键是**固定的** `KeyId`；不是配置文件里的可配置项。
  扩展快捷键是原始 `KeyId`，不能通过 `~/.pi/agent/keybindings.json` 重映射
  （该文件只能重映射 π 的 namespaced action id）。做成可配置属于后续工作，不在本次范围。

## 架构

```
globalThis
 Symbol.for("@gotgenes/pi-permission-system:config-service")
   └── PermissionConfigService
         ├── getConfig(): PermissionSystemExtensionConfig
         └── toggleYoloMode(): PermissionSystemExtensionConfig
               ├── toggleYoloConfig(config)   （共享纯翻转）
               └── ConfigStore.saveRuntime(next)  （无 ctx 持久化核心；失败抛错）
                              ▲
      /permission-system yolo ─┘  使用 toggleYoloConfig + ConfigStore.save(ctx)（流程不变）
      ctrl+alt+y 快捷键 ─────────┘  使用 configService.toggleYoloMode() + 通知 + 状态栏同步
```

- gate（`PermissionManager.isYoloEnabled`）每次 check 都读 `configStore.current()`，
  所以持久化 + 内存更新后，**下一次 gate 判定就会生效**，即使没有任何 UI 调用——
  持久化与内存更新已足够。
- 持久化、内存更新、调试日志都集中在一个无 ctx 的核心（`saveRuntime`）里；
  现有 `save(next, ctx)` 变成薄 UI 装饰器，使命令侧可观测行为逐字节一致。

## 公开 API 面（`src/service.ts`）

在跨扩展公开面上新增：

```ts
const CONFIG_SERVICE_KEY = Symbol.for("@gotgenes/pi-permission-system:config-service");

export interface PermissionConfigService {
  /** 当前运行时扩展配置的只读快照。 */
  getConfig(): PermissionSystemExtensionConfig;
  /**
   * 翻转 yoloMode 并持久化到全局配置。返回新配置。
   * 写盘失败时抛错（由调用方负责错误呈现/通知）。
   */
  toggleYoloMode(): PermissionSystemExtensionConfig;
}

export function publishPermissionConfigService(service: PermissionConfigService): void;
export function getPermissionConfigService(): PermissionConfigService | undefined;
export function unpublishPermissionConfigService(service: PermissionConfigService): void;
```

- `PermissionSystemExtensionConfig`（`src/extension-config.ts`）会成为**新公开类型**：
  rollup-plugin-dts 会把它内联进 `dist/public.d.ts`
  （它是内部模块，不是 external）。当前它不在 `dist/public.d.ts` 中。
- 访问器三元组与 `PermissionsService` 的三元组
  （`publish/get/unpublish`）保持一致，包括 unpublish 的身份 compare-and-delete。
- `verify-public-types.sh` 增加新符号
  （`publishPermissionConfigService`、`getPermissionConfigService`、
  `unpublishPermissionConfigService`、`PermissionConfigService`、
  `PermissionSystemExtensionConfig`），消费者 `probe.ts` 增加
  `getPermissionConfigService`。

## ConfigStore 重构（`src/config-store.ts`）

- **新增：** `saveRuntime(next): PermissionSystemExtensionConfig`
  - normalize → 原子写全局配置（tmp+rename）→ 更新 `this.config`
    → 调试日志——**无任何 ctx 依赖**。
  - 返回 normalize 后的配置。
  - 写盘失败时**抛错**（由调用方决定如何呈现）。
- **变更：** `save(next, ctx)` 变成薄装饰器，对命令**可观测行为完全不变**：
  ```
  try { const normalized = this.saveRuntime(next); syncPermissionSystemStatus(ctx, normalized); }
  catch (error) { ctx.ui.notify(`Failed to save …`, "error"); }
  ```
- **新增窄接口** `PermissionConfigStore { current(); saveRuntime(next) }`，
  让配置服务只依赖最小表面（类已实现 `ConfigReader`；这沿用了
  `CommandConfigStore` / `SessionConfigStore` 的先例）。

## 内部接线

### `src/permission-config-service.ts`（新建）

- `toggleYoloConfig(config): PermissionSystemExtensionConfig` —— 纯翻转
  （从 `config-modal.ts` 移入；导出供命令导入）。
- `LocalPermissionConfigService implements PermissionConfigService` —— 包装窄接口
  `PermissionConfigStore`；`getConfig()` → `current()`；
  `toggleYoloMode()` → `saveRuntime(toggleYoloConfig(current()))`。

### `src/config-modal.ts`

- `yolo` 分支保持现有流程不变，仅把翻转来源换成共享的 `toggleYoloConfig`：
  `const next = toggleYoloConfig(controller.config.current());
  controller.config.save(next, ctx); …notify…`。（行为不变；现有测试作为回归网。）

### 快捷键注册（新建，例如 `src/yolo-shortcut.ts`）

```ts
export function registerYoloModeShortcut(
  pi: ExtensionAPI,
  configService: PermissionConfigService,
): void {
  pi.registerShortcut(Key.ctrlAlt("y"), {
    description: "Toggle YOLO mode",
    handler: (ctx) => {
      let next: PermissionSystemExtensionConfig;
      try {
        next = configService.toggleYoloMode();
      } catch (error) {
        ctx.ui.notify(`Failed to toggle YOLO mode: ${…}`, "error");
        return;
      }
      syncPermissionSystemStatus(ctx, next);
      ctx.ui.notify(
        next.yoloMode ? "YOLO mode ON — ask checks auto-approved" : "YOLO mode off",
        next.yoloMode ? "warning" : "info",
      );
    },
  });
}
```

- 快捷键的 `ExtensionContext` 满足 `PermissionStatusContext`
  （`mode`/`hasUI`/`ui`），所以 `syncPermissionSystemStatus` 可直接使用。
- ON/OFF 消息与级别和命令一致。

### 组合根（`src/index.ts`）

- 构造 `LocalPermissionConfigService(configStore)`（configStore 早已存在）。
  `registerPermissionSystemCommand` **不需要**新参数——`config-modal.ts` 静态导入
  共享的 `toggleYoloConfig` 即可。只有 `registerYoloModeShortcut(pi, configService)`
  接收**实例**；在组合根调用它。
- 扩展 `PermissionServiceLifecycle`，在同一个 `session_start` 时机发布/注销**两个**服务：
  - `activate`：若非已注册的子 agent，则同时发布两者；随后 emit ready。
  - `teardown`：先跑清理，再注销两者（身份化）。
- 子 agent 仍然跳过发布；子进程里的 `getPermissionConfigService()` 解析到父进程的槽位。

## 边界与边界情况

- **无 ctx 契约：** `toggleYoloMode()` 不得假设存在 UI 上下文。它只做
  持久化 + 更新内存；通知/状态栏由调用方负责。
- **仅 TUI 的快捷键：** π 只在 interactive 模式派发扩展快捷键；
  在 `rpc`/`json`/`print` 下注册无害。无头切换仍可通过 `/permission-system yolo`。
- **子 agent：** 不发布；解析到父进程的槽位。
- **reload：** 身份 compare-and-delete 保证被取代的一代不会抹掉新服务。
- **fail-closed：** 快捷键路径中的持久化抛错会呈现为错误通知；不会被静默吞掉当作成功。
- **无配置形状/schema 变化** —— 快捷键键位不是配置项。`gen:schema` 输出必须不变
  （有 parity 测试防漂移）。

## 测试

- `test/config-store.test.ts` — `saveRuntime`：持久化 + 返回 normalize 结果、
  更新内存、调试日志、写盘失败抛错；`save` 装饰器保持原行为（既有测试保持绿）。
- `test/permission-config-service.test.ts`（新建）—
  `LocalPermissionConfigService`：`getConfig` 返回 current；`toggleYoloMode`
  翻转 + 持久化 + 返回新配置；传播持久化失败。
- `test/service.test.ts` — 配置服务访问器三元组：publish/get、
  后写覆盖重发布、身份化 unpublish、子 agent 不覆盖、安全 no-op unpublish
  （镜像现有三元组测试）。
- `test/config-modal.test.ts` — 现有 `yolo` 命令测试保持绿（共享翻转重构的回归网）。
- `test/yolo-shortcut.test.ts`（新建）— 注册键/id + description；
  handler：经 stub 服务翻转、同步状态栏、ON/OFF 通知；
  错误路径通知且不改变状态。
- `test/service-lifecycle.test.ts` — activate 时同时发布两个服务、
  子 agent 跳过、teardown 注销两者。
- 验证：`pnpm test && pnpm run check && pnpm run lint` 以及
  `pnpm run verify:public-types`（重新生成 `dist/public.d.ts`）；
  `pnpm run gen:schema` 不变。

## 文档与变更日志

- `docs/cross-extension-api.md` — 新增 **Configuration API** 一节：
  访问器、接口、用法示例（读取 + 切换）、优雅降级、reload 说明。
- `README.md` — 在 API/集成区域若有自然位置，简要提及配置服务与快捷键；
  不加命令参考文档章节。
- `docs/configuration.md` — **不改**（快捷键不是配置项）。
- `CHANGELOG.md` — 不编辑（release-please 拥有它）。

## 非目标

- 快捷键不做配置文件里的可配置项（固定 `ctrl+alt+y`）。
- 不做 `setYoloMode(on|off)` / `setConfig(partial)` / 全量配置写入器。
- 不加 README/config 命令参考文档章节。
- 不改配置形状、schema、gate 逻辑、`status.ts`，或现有 `PermissionsService` 表面。
