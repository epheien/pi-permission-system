# 设计:yolo 模式完全 bypass —— 仅保留显式 `deny`

日期:2026-10-24
状态:已获批(brainstorming 产物;用户要求跳过 writing-plans,直接 TDD 实现)

## 1. 问题

`yoloMode` 当前的语义是**组合阶段的 `ask` → `allow` 改写**:显式 `deny` 规则原样存活,因此 yolo 抑制提示但保留硬拒绝。

这个语义并不等于"完全 bypass"。扩展里还有四处**绕过规则集评估**的强制拦截,它们在 yolo 下照常生效,仍然能拦住用户:

| # | 泄漏点 | 位置 |
|---|---|---|
| 1 | bash wrapper(`bash -c` / `sudo` / `env` …)的 `allow` 被抬成合成 `ask` | `src/handlers/gates/bash-command.ts` |
| 2 | bash 解析失败 / 空解析 → 合成 `<unparseable-bash-command>` 的 `ask` | `src/handlers/gates/bash-command.ts` |
| 3 | 未知 / 缺失工具名的硬 `block` | `src/handlers/permission-gate-handler.ts` |
| 4 | gate 内部抛错时的 fail-closed 硬 `block` | `src/handlers/tool-call-boundary.ts` |

其余全部入口(`path`、`external_directory`、bash 的 path/external-directory 门、`skill` read/input 门、session 规则、转发请求、invalid-config 的 `allow→ask` clamp)都经过 `resolver.resolve` → `PermissionManager.check`,已被现有改写覆盖。

## 2. 用户确认的需求模型

| 维度 | 结论 |
|---|---|
| `deny` | **保留**(选 C):只有显式 `deny` 规则能拦住 yolo 会话 |
| 非 deny 的拦截/提示 | **全部消失**(选 A):上表 4 项 + 所有 `ask` + 无效配置 clamp + skill `ask` |
| 审计日志 | **保留** |
| 配置面 | 不新增字段、不开兼容开关;`yoloMode` 语义直接升级(YAGNI) |
| 生命周期 / 快捷键 / 状态栏 | 不变:进程内、不持久化、`ctrl+alt+y`、`/permission-system yolo`、红字状态 |

## 3. 语义不变式

> yolo ON ⇒ 本扩展对一次工具调用**只可能因匹配到显式 `deny` 规则而阻止**;其余一律放行,且绝不提示。

`deny` 的来源是 composed ruleset 的任意层(defaults / baseline / config / session)× 任意 surface。

显示面(`getComposedConfigRules`、`getToolPermission`)与 `before_agent_start` 的工具注入**保持 yolo-free**:被 `deny` 的工具依旧不会被注入给 agent。

## 4. 实现

### 4.1 改动清单

1. `src/handlers/gates/bash-command.ts` — `resolveBashCommandCheck` 增加 `yolo` 选项:
   - wrapper floor:yolo 时不再把 `allow` 抬成 `ask`,并把结果标 `origin: "yolo"`,便于审计区分"yolo 放过的 wrapper"
   - 空解析:yolo 时退回整串 `resolver.resolve`(尽力匹配 `deny`),标 `origin: "yolo"`
2. `src/handlers/gates/tool-call-gate-pipeline.ts` — 从注入的 yolo reader 透传标志给 bash 门
3. `src/handlers/permission-gate-handler.ts` — 构造注入 `isYoloEnabled`;验证失败(未知/缺失工具名)在 yolo 下改走 `runner.run(...)` 的 bypass 形态,以复用既有日志 + 决策事件通道
4. `src/handlers/tool-call-boundary.ts` — `createFailClosedToolCall` 注入 `isYoloEnabled`;`catch` 分支在 yolo 下放行,但仍写 `permission_request.blocked`(`resolution: "gate_error"`,`yoloBypass: true`)
5. `src/index.ts` — 组合根把 `() => isYoloModeEnabled(configStore.current())` 注入第 3、4 项

`src/rule.ts` 的 `rewriteAsksToYolo` **行为不变**;仅更新注释,把它定位为"规则集那一层的实现",与上述 4 个绕过点互补。

### 4.2 无需改动

- `src/handlers/gates/skill-input*.ts` — 走 `checkPermission`,skill 的 `ask` 被改写、`deny` 保留,语义正确
- `src/permission-manager.ts` 的 `floorAllowsToAsk` — clamp 产生的 `ask` 会被随后的改写放开,等价于不生效
- `src/handlers/gates/runner.ts` — 已有 `check.origin === "yolo"` 的 fast-path,写 `auto_approved` + 决策事件

## 5. 审计

| 场景 | 事件 | resolution |
|---|---|---|
| yolo 放过 `ask` / wrapper / unparseable | `permission_request.auto_approved` | `auto_approved` |
| yolo 放过未知工具 | 同上,附 `bypassedCheck: "unregistered-tool"` | `auto_approved` |
| yolo 下 gate 抛错 | `permission_request.blocked` | `gate_error` + `yoloBypass: true` |
| 命中显式 `deny` | `permission_request.blocked` | `policy_denied`(不变) |

## 6. 测试

- 新增 `test/bash-command-yolo.test.ts`:wrapper × yolo、空解析 × yolo、wrapper 上有显式 `deny` 时仍 `deny`
- `test/handlers/permission-gate-handler.test.ts`:未知工具在 yolo 下放行并写 `auto_approved`
- `test/handlers/tool-call-boundary.test.ts`:gate 抛错在 yolo 下放行且仍写 `gate_error`
- 新增组合根级集成测试:yolo ON 时除 `deny` 外无任何 block
- `test/permission-manager-yolo.test.ts` 现有 8 个 case 语义不变(deny 保留、非 deny 放开)

## 7. 文档

- `docs/architecture/architecture.md` §"yolo is recorded authority" 重写;保留其中"连 `deny` 一起关掉是另一个模式"的说明(本方案未推翻它)
- 新增 ADR `docs/decisions/0011-yolo-bypasses-all-but-explicit-deny.md`
- `docs/configuration.md`(字段表、fail-closed 措辞、YOLO 小节)
- `README.md`、`docs/cross-extension-api.md` 的相关描述
- 不编辑 `CHANGELOG.md`(release-please 所有)

## 8. 已知取舍

- yolo 下 bash 解析失败只能**整串**匹配 `deny`,可能漏掉子命令级的 `deny` —— 显式全放开模式下的可接受退化,ADR 中写明
- 拼错/未注册的工具名不再被拦截,由 Pi 自身的未知工具报错兜底
