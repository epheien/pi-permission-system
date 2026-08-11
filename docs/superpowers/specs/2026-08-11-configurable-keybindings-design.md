# 设计:可配置快捷键 `keybindings` —— 所有快捷键经配置文件指定

日期:2026-08-11
状态:待用户审阅(brainstorming 产物,实现前转 writing-plans)

## 1. 问题

pi-permission-system 目前只有 **YOLO 切换键**可用配置指定(`yoloModeShortcut`,单个 KeyId 字符串);其余所有快捷键都是**硬编码**:

- diff 查看键(`src/diff-view/keybindings.ts` 的 `DEFAULT_KEYBINDINGS`):滚动/翻页/hunk 跳转/视图切换/wrap/上下文 ±;
- diff 决策键(`src/authority/diff-ask-adapter.ts` `DiffPromptDecisionLayer`):`y`/`a` 批准、`s` 会话、`r` 拒绝并附原因、`enter` 确认、`escape` 拒绝;
- overlay 权限对话框(`src/authority/permission-prompt-component.ts`):决策键 `y`/`s`/`n`/`r`、导航 `↑`/`↓`/`j`/`k`/`ctrl+p`/`ctrl+n`、`enter` 确认、`escape` 拒绝。

用户希望:**所有快捷键都能通过配置文件指定**,配置方式对齐 `pi-show-diffs.json` 的 `keybindings` 块(每个 action 一个键数组)。另外要求:**帮助信息只显示每个 action 的第一个快捷键**。

## 2. 用户确认的需求模型

| 维度 | 结论 |
|---|---|
| 覆盖范围 | **全量**(选 C):diff 查看键 + 决策键 + overlay 对话框 + YOLO,统一收进 `keybindings` 块;旧 `yoloModeShortcut` 不保留(已删除),YOLO 快捷键仅 `keybindings.yoloToggle` |
| 决策键组织 | **方案①**(共用):`reducePrompt` 决策模型被 overlay 对话框与 diff 决策区共用,`keybindings` 里只定义**一套**决策键 + 导航键,两种界面共享;diff 专属查看键单独分组 |
| 值语义 | 每个 action = `string[]`;**`[]` 表示禁用**(不用 `false`,保持值类型一致);缺省 = 内置默认;写数组 = **整体替换**(非追加)该 action 的全部键 |
| deny 默认 | **`d`**(用户裁决);`n` 继续留给 diff 的 nextHunk |
| diff 滚动 | **默认禁用**(用户裁决):`scrollUp/scrollDown` 默认 `[]`,`↑/↓` 让给决策区移动高亮;hunk 跳转(`n`/`p`)与翻页(`pageUp`/`pageDown`)已足够 |
| 帮助显示 | 每个 action 只显示**第一个**键(用户补充需求) |
| 配置风格 | 对齐 `pi-show-diffs.json`:action 名 → 键数组 |
| fail-safe | 沿用仓库哲学:非法键值丢弃并 debug 告警,绝不静默绑成别的键;未知 action 名走现有 schema/config-loader 告警 |

## 3. 配置 schema 与默认值

新增顶层字段 `keybindings`。zod `strictObject`,每个 action 值 = `z.array(z.string())`;未知 action 名 → schema 校验告警(现有 config-loader warning 通道)。

| action | 默认键 | 说明 |
|---|---|---|
| `approve` | `["y"]` | 决策键,共用;diff 原有 `a` 别名移除 |
| `approveSession` | `["s"]` | 决策键,共用 |
| `deny` | `["d"]` | 决策键,共用;用户裁决用 `d` |
| `denyWithReason` | `["r"]` | 决策键,共用 |
| `confirm` | `["enter"]` | 决策键,共用 |
| `cancel` | `["escape"]` | 决策键,共用 |
| `navUp` | `["up", "k"]` | 决策键,共用;`ctrl+p` 旧别名随默认移除(可配置加回) |
| `navDown` | `["down", "j"]` | 决策键,共用;`ctrl+n` 旧别名随默认移除(可配置加回) |
| `scrollUp` | `[]` | diff 查看键;默认禁用(用户裁决) |
| `scrollDown` | `[]` | diff 查看键;默认禁用(用户裁决) |
| `pageUp` | `["pageUp"]` | diff 查看键 |
| `pageDown` | `["pageDown"]` | diff 查看键 |
| `scrollTop` | `["home"]` | diff 查看键 |
| `scrollBottom` | `["end"]` | diff 查看键 |
| `nextHunk` | `["n"]` | diff 查看键 |
| `prevHunk` | `["p"]` | diff 查看键 |
| `toggleMode` | `["Tab"]` | diff 查看键(split/unified) |
| `toggleWrap` | `["w"]` | diff 查看键 |
| `toggleExpand` | `[]` | diff 查看键;未接线的旧字段,保留可配置,默认禁用 |
| `contextMore` | `["right", "]"]` | diff 查看键 |
| `contextLess` | `["left", "["]` | diff 查看键 |
| `yoloToggle` | `["ctrl+alt+y"]` | YOLO;缺省用默认,`[]` 禁用 |

配置示例(形如 pi-show-diffs.json):

```jsonc
{
  "keybindings": {
    "approve":      ["y", "Y"],
    "deny":         ["d"],
    "scrollUp":     [],
    "scrollDown":   [],
    "nextHunk":     ["n"],
    "prevHunk":     ["p"],
    "yoloToggle":   ["ctrl+alt+y"]
  }
}
```

## 4. 总体架构与数据流

决策模型 `reducePrompt` 保持 `PromptKey`(`y`/`s`/`n`/`r`)作为**动作标识**不变;配置化只发生在两个薄层,由各界面 adapter 承载:

1. **输入键 → 动作**:adapter 用配置的 `string[]` 查表,输入键命中哪个动作的数组就映射到对应 `PromptKey`(查表顺序 `approve → approveSession → deny → denyWithReason`,重复键按此顺序优先;`confirm`/`cancel`/`navUp`/`navDown` 单独查)。
2. **动作 → 显示键**:渲染 `(x)` 字母与 "Press x again" 提示时,取该动作配置数组的**第一个**键。

`PromptModelConfig` 增加 `optionKeys: Record<PromptKey, string>`(每动作第一个键),供 reducer 的 arming 提示(`Press x again …`)使用;adapter 构造时从配置填充。

```text
config.json
  └─ keybindings ── normalizePermissionSystemConfig ── PermissionSystemExtensionConfig.keybindings
       ├─ 决策键 ── overlay 对话框 requestPermissionDecision(PromptModelConfig.optionKeys + 查表)
       │         └─ diff 决策区 DiffPromptDecisionLayer(同套查表 + 显示)
       ├─ diff 查看键 ── DiffAskComponent → DiffViewer(kb = 配置投影) / footer 首键
       └─ yoloToggle ── index.ts → registerYoloModeShortcut(逐键 registerShortcut)
```

diff-view 保持**零 `#src/*` 依赖**:`src/diff-view/keybindings.ts` 的 `DiffKeybindings` 类型简化为 `string[]`(值类型一致,`[]`=禁用),由 authority 侧(`LocalUserAuthorizer.presentDiff`)把共享 `keybindings` **投影**成 `DiffKeybindings`(取查看键 + footer 需要的 approve/reject)传入。

## 5. 装配点

1. **共享类型与归一** — `src/extension-config.ts`:`PermissionSystemExtensionConfig` 增 `keybindings?: Keybindings`(完整合并后的运行时形状);`normalizePermissionSystemConfig` 把部分配置 merge 到默认,产出完整 `Keybindings`;`yoloToggle` 解析优先级见 §3。默认表常量化(供 schema/文档/测试复用)。
2. **config-schema** — `src/config-schema.ts`:`keybindings` strictObject schema;重跑 `pnpm run gen:schema`。
3. **YOLO** — `src/yolo-shortcut.ts` + `src/index.ts`:`registerYoloModeShortcut` 改收 `string[]`,逐键 `pi.registerShortcut`;`[]` = 不注册(禁用)。读取归一后的 `configStore.current().keybindings.yoloToggle`(旧 `yoloModeShortcut` 已移除)。
4. **diff 查看键** — `src/diff-view/keybindings.ts` + `component.ts`:`DiffKeybindings` 改 `string[]`,`DEFAULT_KEYBINDINGS` 换新表;`DiffAskComponent` 不再硬编码默认,由 `presentDiff` 从配置投影传入。
5. **overlay 对话框** — `src/authority/permission-prompt-component.ts`:`toEvent` 改配置查表;`renderDecision` 与 hint 动态取首键;构造 `PromptModelConfig.optionKeys`。
6. **diff 决策区** — `src/authority/diff-ask-adapter.ts`:同 5 查表;移除硬编码 `y/a/s/r` 与 DISPLAY_KEY 的 `esc`;决策步安全消费 `navUp/navDown`(滚动已禁用);显示 `(d) No`。
7. **帮助首键** — `src/diff-view/viewer.ts` `buildFooterLines` 的 `formatBinding` 只列 `binding[0]`;两处决策 hint、`(x)` 前缀只显示该动作第一个键,并由配置动态生成(如 `j/k move · enter confirm · d deny · …`)。

## 6. 校验与错误处理(fail-closed)

- **schema 层**:`keybindings` 为 `strictObject`,未知 action 名 → schema 校验告警(现有 config-loader warning 通道,沿用 `lastConfigWarning` 去重)。
- **运行时元素校验**:每个键元素过 `parseShortcutKey`(pi KeyId 语法,镜像 pi-tui keys)。非法元素**丢弃**并写 debug 日志;某 action 全部非法 → 视为 `[]`(禁用)。沿用"绝不静默绑成别的键"原则——不复用 `yoloModeShortcut` 的"整体拒绝注册"策略,因为数组语义下丢弃非法元素更符合直觉且不造成错绑。
- **跨 action 重复键**:不阻止,查表顺序决定(§4),文档注明。
- **未知 action 值类型**(如塞了对象)同样走 schema 校验告警。

## 7. 帮助显示规则(只显示第一个键)

所有动态帮助区域只渲染每个 action 配置数组的**第一个**键:

- diff footer(`buildFooterLines`):`formatBinding([]|["a","b"])` → 仅 `a`;禁用的 action 整项不显示。
- overlay / diff 决策区 hint 行:`(x)` 前缀、`Press x again` arming 提示、`enter confirm · d deny` 风格的行,全部取首键;键标签映射(↑/↓/PgUp/PgDn/Home/End/Esc/Tab)沿用现有 `keyLabel` 表。
- 无歧义地满足用户补充需求:多个快捷键时帮助只显示第一个。

## 8. 非目标(non-goals)

- **文本编辑器内部键**固定不变:`reason` 编辑框内的 `backspace` 删字符、可打印字符输入,不属于"快捷键",不配置化。
- **pi 自己的键**不动:`app.tools.expand`(`Ctrl+O`)工具展开由 pi 的 `KeybindingsManager` 处理,权限系统只透传 `keybindings.matches(data, "app.tools.expand")`,不纳入本项目配置。
- **配置设置弹窗编辑 keybindings** 不做:keybindings 属于手改 JSON 的配置,不进入 `/permission-system` 的 `SettingsList`。
- **跨 action 冲突检测与阻止**不做(YAGNI):只按查表顺序 + 文档说明;不做静默"帮你改键"。
- 不改动 `config-schema.ts` 之外的 schema 生成物(由 `gen:schema` 重新生成,parity 测试防漂移)。
- 不引入 `false` 值;`[]` 是唯一禁用表达。
- 不新增 `backspace`/`deleteChar` 等 action。

## 9. 行为变化提示(需用户知晓)

1. overlay 对话框的 **No 从 `n` 改为 `d`**(`deny: ["d"]`)。
2. **`ctrl+p` / `ctrl+n` 导航别名移除**(默认 `navUp/navDown` = `[up,k]`/`[down,j]`);需要可配置加回。
3. diff 视图 **`↑/↓` 从滚动改为移动决策高亮**(`scrollUp/scrollDown` 默认 `[]`);滚动将以 hunk 跳转 + 翻页替代。
4. diff 决策区 approve 的 **`a` 别名移除**(默认 `approve: ["y"]`)。
5. diff 决策区显示从 `(esc) No` 改为 `(d) No`。

## 10. 测试与文档对齐

**测试**(既有 vitest 体系,`#src/*` 别名):
- `config-schema.test.ts`:schema parity 守护(重新生成后无漂移)。
- `extension-config.test.ts` / `normalize` 测试:部分合并、`[]` 禁用、非法元素丢弃、`yoloToggle` 缺省/禁用、完整默认表。
- `diff-view/viewer.test.ts`:自定义查看键生效、`[]` 禁用后该 action 无绑定、footer 只显示首键。
  + `diff-ask-adapter` 测试:决策键查表、`(d) No` 显示、hint 首键、决策步 ↑/↓ 移动高亮。
- `permission-prompt-component.test.ts` / `permission-prompt-decision.test.ts`:配置键映射、显示首键、arming 提示用首键。
- `yolo-shortcut.test.ts`:`yoloToggle` 数组逐键注册、`[]` 禁用。

**文档对齐**(仓库 invariant):`src/config-schema.ts`、`config/config.example.json`、`docs/configuration.md`(Runtime Knobs 表 + overlay/diff 两节 + 新 `keybindings` 小节)、`README.md`(如有快捷键速查)。

## 11. 兼容与迁移

- 旧 `yoloModeShortcut` 已**移除**——YOLO 快捷键仅由 `keybindings.yoloToggle` 配置(不存在回退)。
- `DiffKeybindings` 类型从 `string[] | false` 收窄为 `string[]`:内部现有消费点(`buildKeymap` 的 `if (!binding)`、footer 的 `formatBinding` 空值分支)已天然兼容空数组,收窄后删除 `false` 分支即可。
- 未声明 `keybindings` 的既有配置文件完全不受影响(收益默认值行为)。
