# 设计:toolDiffPrompt —— 在权限 ask 中渲染交互式 diff 视图

日期:2026-08-10
状态:待用户审阅(brainstorming 产物,实现前转 writing-plans)

## 1. 问题

用户在授权决策时,对 `write` / `edit` 的现有 ask 提示只有**纯文本预览**(Agent/Tool/Input 的 k/v 块 + 序列化 JSON),看不出改动前后的差异。独立扩展 `pi-show-diffs` 提供了成熟的交互式 diff 视图,但它不支持 subagent 权限管理(permission-system 的核心能力)。

需求:**在本扩展(pi-permission-system)的权限判定之上,复用 pi-show-diffs 的 UI 与 diff 交互**,让用户在 ask 决策时能看到改动 diff。

## 2. 用户确认的需求模型

| 维度 | 结论 |
|---|---|
| 触发时机 | 仅 Gate 判定 `ask`(本地)弹 diff;`allow` 放行、`block` 拒绝、yolo 静默放行 |
| 工具范围 | 第一版仅 `write` + `edit`;`hashline_edit` 留扩展点,不实现 |
| UI 形态 | 复刻 pi-show-diffs 交互:split/unified、hunk 导航、滚动、context 调整、wrap、语法高亮 |
| 不做 | 内联编辑、`tool_result` 拦截/应用改写文件、独立 auto-approve |
| 权限逻辑 | 完全沿用本扩展(y/s/n/r + double-press + scope step + session 写回 + forwarding) |
| 代码组织 | `src/diff-view/` 自包含独立模块,端口-适配器,单向依赖 `authority → diff-view` |
| 默认视图 | `unified`(非 split);`Tab` 运行时仍可切换;窄终端天然兼容 |
| 配置 | `toolDiffPrompt: boolean`(默认 true)+ `toolDiffDefaultView: "split" \| "unified"`(默认 "unified") |

## 3. 总体架构与数据流

变动只发生在"渲染决策"一环,判定管道不动:

```text
tool_call (write/edit)
  └─ gate pipeline ── allow → 放行   /   block → 拒绝
        └─ ask → AuthorizerSelection.escalate → LocalUserAuthorizer.authorize(details)
                ├─ 回退路径(任一命中)→ 现有文本 prompt(requestPermissionDecisionFromUi / 现有 overlay)
                │    · 非 "tui" 模式 · 工具非 write/edit · 配置 toolDiffPrompt=false
                │    · preview 计算失败 · 转发 ask(无 toolInput,见 §7)
                └─ diff 路径(TUI + write/edit + toolInput 有值 + 配置开)
                     → DiffAskAdapter 计算 preview → 渲染 diff 决策视图
                     → 决策 = 现有 PermissionPromptDecision(y/s/n/r + scope),写回逻辑复用
```

决策模型完全复用现有 `reducePrompt` 状态机;批准/拒绝/会话授权的**写回逻辑(sessionRules、forwarding scope)一行不改**。这是 pi-show-diffs 给不了、也是集成它的理由。

## 4. 模块与接口(端口-适配器)

```text
src/diff-view/                         ← 自包含,零 permission-system 内部依赖
├─ diff-utils.ts        纯 diff 计算、summarize、BOM/行尾、fuzzy match   (无外部依赖)
├─ syntax-highlight.ts  ANSI 语法高亮                                   (无外部依赖)
├─ preview.ts           computeChangePreview(write/edit 裁剪版)         (纯计算)
├─ viewer.ts            交互 diff 视图器(渲染+快捷键,仅依赖 @pi-tui)     (无业务语义)
└─ presenter.ts         【唯一对外出口】presentDiffReview               (接口)

src/authority/
└─ diff-ask-adapter.ts  适配器:把 ToolCallContext/ctx 组装成 diff-view 输入,
                        把 DiffReviewDecision → PermissionPromptDecision   (只依赖接口)
```

- 依赖方向单向:`authority → diff-view`(只用 `presenter.ts` 的接口);`diff-view` 不认识 permission-system 任何符号。
- 未来抽离独立发布 = 原样搬走 `src/diff-view`,无需重构。
- 决策语义留在 `authority` 侧:diff-view 只做 diff 展示与查看交互,把决策键转发给**注入的决策层**(现有 `reducePrompt`)。

### 接口草案(形状,细节留 writing-plans)

```ts
// diff-view/presenter.ts —— 唯一对外出口
// 决策语义在 authority 侧;diff-view 只做展示与查看交互,通过注入的
// UI 通道与决策回调保持中立(不 import permission-system 任何符号)
export interface DiffUiPort {
  // authority 实现:经 ctx.ui.custom 托管 overlay;离屏/取消 → preview_unavailable
  show(component: Component): Promise<DiffReviewDecision>;
}
export interface DiffReviewInput {
  toolName: "write" | "edit";          // hashline_edit 未来扩展点
  input: unknown;                       // 原始工具 input(write.content / edit.oldText+newText)
  cwd: string;                          // 相对路径解析基准
  labels: { approve: string; session: string; deny: string; denyReason: string };
  defaultView: "split" | "unified";
}
export type DiffReviewDecision =
  | { kind: "approve" }
  | { kind: "approve_for_session"; scope?: "subagent_only" | "serving_session" }
  | { kind: "deny"; reason?: string }
  | { kind: "preview_unavailable"; error?: string };   // → 调用方回退文本
export function presentDiffReview(ui: DiffUiPort, input: DiffReviewInput): Promise<DiffReviewDecision>;
```

`presentDiffReview` 组装 viewer 组件并交 `DiffUiPort.show` 显示;决策键由 diff-view 转发给**注入的决策回调**——authority 侧实现为现有 `reducePrompt` 状态机(adapter 闭包注入),把用户在 diff 内的按键解析成 y/s/n/r + scope step,回传中立 `DiffReviewDecision`。

以 `toolInput` 为 `write`/`edit` 原样透传、`cwd` 为会话目录,`DiffAskAdapter` 不重新解析路径(沿用 gate 已算出的输入),路径敏感语义不进 diff-view。

### 决策映射

| DiffReviewDecision | PermissionPromptDecision |
|---|---|
| `approve` | `{ approved: true, state: "approved" }` |
| `approve_for_session`(无 scope)| `{ approved: true, state: "approved_for_session" }` |
| `approve_for_session`(scope 由现有 scope step 产出)| `approved_for_session` / `approved_for_serving_session` |
| `deny` | `createDeniedPermissionDecision()` |
| `deny`(带 reason)| `createDeniedPermissionDecision(reason)` |
| `preview_unavailable` | 不决策,回退现有文本 prompt |

steer:**不引入独立 steer 通道**(现有 `r` = deny with reason 已把反馈作为 block reason 回传模型,同 pickup);若后续确认需要"打断式重试",单独设计。

## 5. 交互与键位(融合方案)

diff 区与决策区在同一 overlay:

- **diff 查看键**(pi-show-diffs 原味):`j`/`k` 上下滚动、`PageUp/Down`、`n`/`p` 前后 hunk、`Tab` split↔unified、`h`/`l`(或 `[`/`]`)增减 context、`w` 换行、`g`/`G` 首尾。
- **决策键**(沿用本扩展语义,加 `a` 别名):`Enter`/`a`/`y` = 批准一次;`s` = 批准 for session(转发 ask 时进入现有 scope step);`Esc`/`n` = 拒绝;`r` = 拒绝并附原因。
- `↑`/`↓` 在 y/s/n/r 间移动高亮(现有行为,保留);`j`/`k` 从"决策导航"让位给"diff 滚动"(行为微迁移,文档注明)。
- **double-press** 保留,对字母热键 y/s/n/r 生效。

scope step:diff 区仍显示在背景,决策行替换为 scope 两行(与现有 scope 渲染一致)。

## 6. 数据流改动(必改,风险点)

diff 计算需要**原始 tool input**(after 文本)与 **cwd**,当前 ask 链路不携带:

1. `PromptPermissionDetails`(`src/authority/permission-prompter.ts`)增加可选 `toolInput?: unknown`——仅本地 ask 且工具为 write/edit 时由 tool gate 填充(descriptor `promptDetails` 处 `tcc.input` 已在手,白名单加一个字段即可)。
2. `LocalUserAuthorizer` 构造注入 `cwd`(在 `selectAuthorizer(ctx, …)` 处取 `ctx.cwd`;`authorizer.ts` 已有 `ctx`)。
3. `DiffAskAdapter` 组装 `toolInput` + `cwd` → `computeChangePreview` → `presentDiffReview`。

转发 ask 的 `accessIntent` 只带 path facts、**无 toolInput** → M1 下转发降级文本(§7)。

## 7. subagent 转发边界(M1 / M2 划分,已获用户认可)

- **M1(本次)**:本地 ask 完整 diff;子代理转发 ask 保持现有文本降级展示(行为零变化,不破坏 ADR 0008,转发 wire 不带完整 tool input 是既定格式)。
- **M2(后续,单独文档)**:由子代理转发前算好 diff 随请求附上,主会话只渲染。会动 forwarding wire 格式 + 需单独审 ADR 0008(disclosure-down 重新评估:diff 是"计划写入内容",向有权决策的主会话揭示合理,但仍应单独走)。`presenter` 接口形态已为 M2 预留(决策入口只依赖"给我一个 preview"),M2 无需重构 M1。

## 8. 配置

`PermissionSystemExtensionConfig`(`extension-config.ts`)新增两个字段(遵循既有 `doublePressToConfirm` 的模式):

```ts
toolDiffPrompt: boolean                  // 默认 true:ask 时对 write/edit 走 diff 视图
toolDiffDefaultView: "split" | "unified" // 默认 "unified"
```

- 定义在 `src/config-schema.ts` 的 `unifiedConfigSchema`(带 `.meta({ description, markdownDescription })`),再 `gen:schema` 生成；`normalizePermissionSystemConfig` 中 carry 进 `PermissionSystemExtensionConfig`（带缺省回退）。
- `DEFAULT_EXTENSION_CONFIG` 给**具体默认值**(`toolDiffPrompt: true`、`toolDiffDefaultView: "unified"`),不能给显式 `undefined`——项目测试用 `deepEqual`,会导致相等性破坏。
- 运行时确被读(默认真值注入 presenter),不成为"声明了却未读"的维护陷阱。
- 不暴露 view/rail/context 等深度显示配置,第一版固定默认。

## 9. 回退与安全

- 回退文本 prompt 的情形:非 `"tui"` 模式、非 write/edit、`toolDiffPrompt=false`、preview 计算失败(二进制/图片、edit oldText 找不到、文件不可读、路径异常)、转发 ask(无 toolInput)。
- **不落日志**:diff 内容只在 UI 展示;review log 沿用现有 `getToolInputPreviewForLog`(序列化 input 预览)。`writeReviewEntry` 按白名单取字段,新增 `toolInput` 不会自动写入日志。
- yolo 下 ask→allow 直接放行,不经过 prompt、不弹 diff。

## 10. 测试

- **diff-view 纯逻辑**:diff-utils 迁移 pi-show-diffs 既有断言;preview 计算(write 新建/覆盖、edit 精确匹配 ± fuzzy、二进制、缺文件)。
- **决策映射**:`DiffReviewDecision → PermissionPromptDecision` 各态(approve / session / scope / deny / deny_reason)。
- **authority 集成**(handler-fixtures / gate-fixtures):TUI + write/edit + ask → 进 diff presenter;非 write/edit、非 TUI、崩溃前回退文本;`toolDiffPrompt=false` 回退;转发 ask 无 toolInput 回退。
- **回归**:全量套件不回归;`pnpm run check` / `lint` / `gen:schema` 对齐。

## 11. 文档对齐

- `docs/configuration.md`:新增 `toolDiffPrompt` / `toolDiffDefaultView` 小节。
- `README.md` 简要提及 diff 视图。
- `config/config.example.json` 加注释示例(如需要)。
- `schemas/permissions.schema.json` 由 `gen:schema` 再生成(extension config 若同步 schema)。

## 12. 范围内 / 范围外

范围内:M1(本地 ask diff 视图)+ 端口-适配器模块 + 两配置字段 + 数据流小改 + 测试/文档。
范围外:M2(转发带 diff,wir e+ADR);hashline_edit;内联编辑;独立 steer 通道;split 默认;深度显示配置;以 pi-show-diffs 为 npm 依赖。

## 13. 风险

- **键位微迁移**(j/k 决策导航 → diff 滚动)是现有用户习惯的小破坏,文档注明。
- **大输入**:先沿用 pi-show-diffs 行为;若实测卡顿,把"超大 before/after 降级文本"列入后续。
- **依赖新增**:`diff` + `cli-highlight` 两个 npm 依赖(files/`dist` 打包要含 `src/diff-view`)。
