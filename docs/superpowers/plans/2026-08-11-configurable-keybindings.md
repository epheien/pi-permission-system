# 可配置快捷键 `keybindings` 实现计划

> **给 agentic 工人：** REQUIRED SUB-SKILL：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 按任务逐项实现。步骤使用 checkbox（`- [ ]`）语法跟踪。

**目标：** 新增顶层配置 `keybindings`，让 pi-permission-system 的**全部**快捷键（diff 查看键、决策键、overlay 对话框键、YOLO 切换键）都能经配置文件指定，值一律为 `string[]`（`[]` = 禁用），帮助信息只显示每个 action 的第一个键。

**架构：** 决策模型 `reducePrompt` 保持 `PromptKey`（`y/s/n/r`）作为动作标识不动；配置化只发生在两个薄层——`输入键 → PromptKey` 查表（新 `src/authority/prompt-key-matcher.ts`，两界面共用）与 `PromptKey → 显示键`（`PromptModelConfig.optionKeys`，取首键）。diff-view 保持零 `#src/*` 依赖：查看键子集类型留在 `src/diff-view/keybindings.ts`，由 authority 侧把共享 `Keybindings` 投影成它。全部默认值集中在 extension-config 的 `DEFAULT_KEYBINDINGS`（查看键部分复用 diff-view 默认，保证不漂移）。

**技术栈：** TypeScript、pi 扩展 API（`pi.registerShortcut`、`ctx.ui.custom`）、zod、vitest、pnpm。

## 全局约束

- 只用 `pnpm`——绝不 `npm`/`npx`（AGENTS.md 仓库规则）。
- 不编辑 `CHANGELOG.md`（release-please 拥有它）。
- 值语义：每个 action 的值为 `string[]`；`[]` = 禁用；不写 = 默认；写数组 = 整体替换（非追加）。**不使用 `false`。**
- 键盘值校验用 `parseShortcutKey`（pi-tui KeyId 语法）：非法元素**丢弃**（fail-safe，绝不静默绑成别的键）并告警；某 action 全部非法 → 视为 `[]`（禁用）。
- 查表顺序（重复键冲突时）：`approve → approveSession → deny → denyWithReason`，然后 nav/confirm/cancel。
- diff-view 目录**不得** import 任何 `#src/*`（单向依赖 `authority → diff-view`）。
- 帮助信息只显示每个 action 配置数组的**第一个**键。
- 匹配文件既有风格：双引号、分号、尾随逗号、2 空格缩进、`function` 声明、JSDoc 注释。
- 验证：每任务 `pnpm test`（相关文件）+ `pnpm run check`；最终任务 `pnpm run lint`、`pnpm run gen:schema`、`pnpm run verify:public-types`。
- 测试用 `#src/*` 别名导入；工具函数在 `#test/helpers/make-fake-pi.ts` 等既有夹具。

**关键默认值（全部 action）：**

```ts
// 决策键（共用）
approve: ["y"]            approveSession: ["s"]        deny: ["d"]
denyWithReason: ["r"]     confirm: ["enter"]           cancel: ["escape"]
navUp: ["up", "k"]        navDown: ["down", "j"]
// diff 查看键（scrollUp/Down 与 toggleExpand 默认禁用）
scrollUp: []              scrollDown: []               pageUp: ["pageup"]
pageDown: ["pagedown"]    scrollTop: ["home"]          scrollBottom: ["end"]
nextHunk: ["n"]           prevHunk: ["p"]              toggleMode: ["tab"]
toggleWrap: ["w"]         toggleExpand: []             contextMore: ["right", "]"]
contextLess: ["left", "["]    yoloToggle: ["ctrl+alt+y"]
```

---

## 任务索引（依赖顺序）

1. diff-view 查看键：`DiffKeybindings` 收窄为 `string[]` + 新默认 + footer 首键
2. 共享 `Keybindings` 类型 + 默认 + normalize（extension-config）
3. `keybindings` schema + example + gen:schema
4. 决策模型 `optionKeys` + `prompt-key-matcher` 模块
5. overlay 权限对话框接入
6. diff 决策区接入
7. authority 装配（local-user-authorizer 穿 `keybindings`）
8. YOLO 数组化
9. 文档对齐 + 全量验证

---

### Task 1: diff-view 查看键收窄 + 新默认 + footer 首键

**Files:**
- Modify: `src/diff-view/keybindings.ts`
- Modify: `src/diff-view/viewer.ts`（footer 首键）
- Test: `test/diff-view/viewer.test.ts`

**Interfaces:**
- Produces: `DiffKeybindings`（全字段改为 `string[]`）、`DEFAULT_KEYBINDINGS`（新默认值，见上表）。Task 2 的 extension-config 会 import 它。
- Consumes: 无（本任务独立）。

- [ ] **Step 1: 修改 `src/diff-view/keybindings.ts`**

把 `DiffKeybindings` 接口与 `DEFAULT_KEYBINDINGS` 改成纯 `string[]` 语义（去掉 `| false`），默认值按上表（特殊键用 pi KeyId 规范小写：`"tab"`/`"enter"`/`"escape"`/`"pageup"`/`"pagedown"`/`"home"`/`"end"`/`"up"`/`"down"`/`"right"`/`"left"`/`"ctrl+f"`）：

```ts
export interface DiffKeybindings {
  approve: string[];
  reject: string[];
  scrollUp: string[];
  scrollDown: string[];
  pageUp: string[];
  pageDown: string[];
  scrollTop: string[];
  scrollBottom: string[];
  nextHunk: string[];
  prevHunk: string[];
  toggleMode: string[];
  toggleWrap: string[];
  toggleExpand: string[];
  contextMore: string[];
  contextLess: string[];
}

export const DEFAULT_KEYBINDINGS: DiffKeybindings = {
  approve: ["y"],
  reject: ["d"],
  scrollUp: [],
  scrollDown: [],
  pageUp: ["pageup"],
  pageDown: ["pagedown"],
  scrollTop: ["home"],
  scrollBottom: ["end"],
  nextHunk: ["n"],
  prevHunk: ["p"],
  toggleMode: ["tab"],
  toggleWrap: ["w"],
  toggleExpand: [],
  contextMore: ["right", "]"],
  contextLess: ["left", "["],
};
```

- [ ] **Step 2: 改 viewer 的 footer 只显示首键**

`src/diff-view/viewer.ts` `buildFooterLines` 里的 `formatBinding`：

```ts
const formatBinding = (binding: string[]): string | null => {
  if (binding.length === 0) return null;
  return keyLabel(binding[0]!);
};
```

`keyLabel` 的表保持，另补 `pageup: "PgUp"`、`pagedown: "PgDn"`、`home: "Home"`、`end: "End"`。

- [ ] **Step 3: 更新并运行 viewer 测试**

`test/diff-view/viewer.test.ts`：现有 `makeViewer` 传 `DEFAULT_KEYBINDINGS`，保持不变。新增用例：

```ts
it("scrollUp/scrollDown 默认禁用:↑↓ 不滚动", () => {
  const v = makeViewer();
  const before = v.handleInput("\u001b[B") ? "handled" : "ignored";
  expect(before).toBe("ignored");
});

it("footer 只显示每个 action 的第一个键", () => {
  const kb: DiffKeybindings = {
    ...DEFAULT_KEYBINDINGS,
    scrollUp: ["up"],
    nextHunk: ["n", "j"],
    approve: ["enter", "a", "y"],
  };
  const v = new DiffViewer(
    tui as never, theme as never, makePreview(), "default", true, kb,
    "unified", "full", "/", undefined,
  );
  const text = v.render(80).join("\n");
  expect(text).toContain("up scroll");
  expect(text).not.toContain("up/");
  expect(text).toContain("n next");
  expect(text).not.toContain("n/j");
  expect(text).toMatch(/enter approve\b/);
  expect(text).not.toContain("enter/a/y");
});
```

导入 `DiffKeybindings` 类型。运行：

```bash
pnpm test -- diff-view/viewer
pnpm run check
```

- [ ] **Step 4: Commit**

```bash
git add src/diff-view/keybindings.ts src/diff-view/viewer.ts test/diff-view/viewer.test.ts
git commit -m "feat(pi-permission-system): diff-view 快捷键统一 string[] 语义, 默认禁用滚动, 帮助只显示首键"
```

---

### Task 2: 共享 `Keybindings` 类型 + 默认 + normalize

**Files:**
- Modify: `src/extension-config.ts`
- Modify: `src/config-store.ts`（refresh 传 onWarning）
- Test: `test/extension-config.test.ts`

**Interfaces:**
- Consumes: `parseShortcutKey`（`src/keyboard-shortcut.ts`）、`DEFAULT_KEYBINDINGS`（Task 1，`#src/diff-view/keybindings`）。
- Produces: `Keybindings`、`DecisionKeybindings`（`Pick<Keybindings, "approve"|"approveSession"|"deny"|"denyWithReason"|"confirm"|"cancel"|"navUp"|"navDown">`）、`DEFAULT_KEYBINDINGS`（完整）、`sanitizeKeyArray(keys, fallback, onDrop?)`、`normalizeKeybindings(raw, onDrop?)`；`PermissionSystemExtensionConfig.keybindings: Keybindings`（**必填**），`DEFAULT_EXTENSION_CONFIG` 含 `keybindings`。

- [ ] **Step 1: 写失败的测试**

`test/extension-config.test.ts` 新增 `describe("normalizePermissionSystemConfig keybindings", …)`：

```ts
import {
  DEFAULT_KEYBINDINGS,
  type PermissionSystemExtensionConfig,
  normalizeKeybindings,
} from "#src/extension-config";

const DECISION_KEYS = ["approve", "approveSession", "deny", "denyWithReason",
  "confirm", "cancel", "navUp", "navDown"] as const;

describe("keybindings 归一", () => {
  it("缺省 → 完整默认表", () => {
    const kb = normalizeKeybindings({});
    expect(kb.approve).toEqual(["y"]);
    expect(kb.deny).toEqual(["d"]);
    expect(kb.scrollUp).toEqual([]);
    expect(kb.scrollDown).toEqual([]);
    expect(kb.yoloToggle).toEqual(["ctrl+alt+y"]);
    expect(kb.scrollTop).toEqual(["home"]);
    expect(kb.contextMore).toEqual(["right", "]"]);
  });

  it("部分覆盖 = 该 action 整体替换,其余保持默认", () => {
    const kb = normalizeKeybindings({
      keybindings: { approve: ["z", "q"], deny: [] },
    });
    expect(kb.approve).toEqual(["z", "q"]);
    expect(kb.deny).toEqual([]);          // [] = 禁用
    expect(kb.approveSession).toEqual(["s"]);
    expect(kb.nextHunk).toEqual(["n"]);
  });

  it("非法元素被丢弃并回调告警;全部非法 → []", () => {
    const dropped: string[] = [];
    const kb = normalizeKeybindings(
      { keybindings: { approve: ["y", "foo+y"] } },
      (k) => dropped.push(k),
    );
    expect(kb.approve).toEqual(["y"]);
    expect(dropped).toEqual(["foo+y"]);
    const kb2 = normalizeKeybindings({ keybindings: { cancel: ["bogus"] } });
    expect(kb2.cancel).toEqual([]);
  });

  it("规范化修饰符顺序", () => {
    const kb = normalizeKeybindings({ keybindings: { yoloToggle: [" Alt + CTRL + y "] } });
    expect(kb.yoloToggle).toEqual(["ctrl+alt+y"]);
  });

  it("yoloToggle 优先, 否则用默认", () => {
    expect(
      normalizeKeybindings({ keybindings: { yoloToggle: ["ctrl+w"] } })
        .yoloToggle,
    ).toEqual(["ctrl+w"]);
    expect(normalizeKeybindings({}).yoloToggle).toEqual(["ctrl+alt+y"]);
  });

  it("查看键子集与 diff-view 默认一致(防漂移)", () => {
    const { DEFAULT_KEYBINDINGS: VIEW_KB } = await import("#src/diff-view/keybindings");
    for (const k of ["scrollUp", "scrollDown", "pageUp", "pageDown", "scrollTop",
      "scrollBottom", "nextHunk", "prevHunk", "toggleMode", "toggleWrap",
      "toggleExpand", "contextMore", "contextLess"] as const) {
      expect(DEFAULT_KEYBINDINGS[k]).toEqual(VIEW_KB[k]);
    }
    expect(DEFAULT_KEYBINDINGS.approve).toEqual(VIEW_KB.approve);
    expect(DEFAULT_KEYBINDINGS.deny).toEqual(VIEW_KB.reject);
  });
});

describe("normalizePermissionSystemConfig 携带 keybindings", () => {
  it("DEFAULT_EXTENSION_CONFIG 与归一结果都带完整 keybindings", () => {
    const { DEFAULT_EXTENSION_CONFIG: DEF } = await import("#src/extension-config");
    expect(DEF.keybindings).toBeDefined();
    const cfg = normalizePermissionSystemConfig({} as never);
    expect(cfg.keybindings).toBeDefined();
    expect(cfg.keybindings!.deny).toEqual(["d"]);
  });
});
```

运行确认失败（`normalizeKeybindings`/`DEFAULT_KEYBINDINGS` 尚不存在）：

```bash
pnpm test -- extension-config
```

- [ ] **Step 2: 实现 extension-config**

在 `src/extension-config.ts`：

```ts
import type { KeyId } from "@earendil-works/pi-tui";
import { parseShortcutKey } from "./keyboard-shortcut";
import { DEFAULT_KEYBINDINGS as DEFAULT_VIEW_KEYBINDINGS } from "./diff-view/keybindings.js";

export interface Keybindings {
  approve: string[];
  approveSession: string[];
  deny: string[];
  denyWithReason: string[];
  confirm: string[];
  cancel: string[];
  navUp: string[];
  navDown: string[];
  scrollUp: string[];
  scrollDown: string[];
  pageUp: string[];
  pageDown: string[];
  scrollTop: string[];
  scrollBottom: string[];
  nextHunk: string[];
  prevHunk: string[];
  toggleMode: string[];
  toggleWrap: string[];
  toggleExpand: string[];
  contextMore: string[];
  contextLess: string[];
  yoloToggle: string[];
}

export type DecisionKeybindings = Pick<
  Keybindings,
  | "approve" | "approveSession" | "deny" | "denyWithReason"
  | "confirm" | "cancel" | "navUp" | "navDown"
>;

export const DEFAULT_KEYBINDINGS: Keybindings = {
  approve: ["y"],
  approveSession: ["s"],
  deny: ["d"],
  denyWithReason: ["r"],
  confirm: ["enter"],
  cancel: ["escape"],
  navUp: ["up", "k"],
  navDown: ["down", "j"],
  scrollUp: DEFAULT_VIEW_KEYBINDINGS.scrollUp,
  scrollDown: DEFAULT_VIEW_KEYBINDINGS.scrollDown,
  pageUp: DEFAULT_VIEW_KEYBINDINGS.pageUp,
  pageDown: DEFAULT_VIEW_KEYBINDINGS.pageDown,
  scrollTop: DEFAULT_VIEW_KEYBINDINGS.scrollTop,
  scrollBottom: DEFAULT_VIEW_KEYBINDINGS.scrollBottom,
  nextHunk: DEFAULT_VIEW_KEYBINDINGS.nextHunk,
  prevHunk: DEFAULT_VIEW_KEYBINDINGS.prevHunk,
  toggleMode: DEFAULT_VIEW_KEYBINDINGS.toggleMode,
  toggleWrap: DEFAULT_VIEW_KEYBINDINGS.toggleWrap,
  toggleExpand: DEFAULT_VIEW_KEYBINDINGS.toggleExpand,
  contextMore: DEFAULT_VIEW_KEYBINDINGS.contextMore,
  contextLess: DEFAULT_VIEW_KEYBINDINGS.contextLess,
  yoloToggle: ["ctrl+alt+y"],
};

export function sanitizeKeyArray(
  keys: string[] | undefined,
  fallback: string[],
  onDrop?: (key: string) => void,
): string[] {
  const source = keys ?? fallback;
  const valid: KeyId[] = [];
  for (const key of source) {
    const parsed = parseShortcutKey(key);
    if (parsed.ok) valid.push(parsed.key);
    else onDrop?.(key);
  }
  return valid;
}

export function normalizeKeybindings(
  raw: UnifiedPermissionConfig,
  onDrop?: (key: string) => void,
): Keybindings {
  const kb = raw.keybindings;
  const yoloSource = kb?.yoloToggle ?? DEFAULT_KEYBINDINGS.yoloToggle;
  return {
    approve: sanitizeKeyArray(kb?.approve, DEFAULT_KEYBINDINGS.approve, onDrop),
    approveSession: sanitizeKeyArray(kb?.approveSession, DEFAULT_KEYBINDINGS.approveSession, onDrop),
    deny: sanitizeKeyArray(kb?.deny, DEFAULT_KEYBINDINGS.deny, onDrop),
    denyWithReason: sanitizeKeyArray(kb?.denyWithReason, DEFAULT_KEYBINDINGS.denyWithReason, onDrop),
    confirm: sanitizeKeyArray(kb?.confirm, DEFAULT_KEYBINDINGS.confirm, onDrop),
    cancel: sanitizeKeyArray(kb?.cancel, DEFAULT_KEYBINDINGS.cancel, onDrop),
    navUp: sanitizeKeyArray(kb?.navUp, DEFAULT_KEYBINDINGS.navUp, onDrop),
    navDown: sanitizeKeyArray(kb?.navDown, DEFAULT_KEYBINDINGS.navDown, onDrop),
    scrollUp: sanitizeKeyArray(kb?.scrollUp, DEFAULT_KEYBINDINGS.scrollUp, onDrop),
    scrollDown: sanitizeKeyArray(kb?.scrollDown, DEFAULT_KEYBINDINGS.scrollDown, onDrop),
    pageUp: sanitizeKeyArray(kb?.pageUp, DEFAULT_KEYBINDINGS.pageUp, onDrop),
    pageDown: sanitizeKeyArray(kb?.pageDown, DEFAULT_KEYBINDINGS.pageDown, onDrop),
    scrollTop: sanitizeKeyArray(kb?.scrollTop, DEFAULT_KEYBINDINGS.scrollTop, onDrop),
    scrollBottom: sanitizeKeyArray(kb?.scrollBottom, DEFAULT_KEYBINDINGS.scrollBottom, onDrop),
    nextHunk: sanitizeKeyArray(kb?.nextHunk, DEFAULT_KEYBINDINGS.nextHunk, onDrop),
    prevHunk: sanitizeKeyArray(kb?.prevHunk, DEFAULT_KEYBINDINGS.prevHunk, onDrop),
    toggleMode: sanitizeKeyArray(kb?.toggleMode, DEFAULT_KEYBINDINGS.toggleMode, onDrop),
    toggleWrap: sanitizeKeyArray(kb?.toggleWrap, DEFAULT_KEYBINDINGS.toggleWrap, onDrop),
    toggleExpand: sanitizeKeyArray(kb?.toggleExpand, DEFAULT_KEYBINDINGS.toggleExpand, onDrop),
    contextMore: sanitizeKeyArray(kb?.contextMore, DEFAULT_KEYBINDINGS.contextMore, onDrop),
    contextLess: sanitizeKeyArray(kb?.contextLess, DEFAULT_KEYBINDINGS.contextLess, onDrop),
    yoloToggle: sanitizeKeyArray(yoloSource, DEFAULT_KEYBINDINGS.yoloToggle, onDrop),
  };
}
```

`PermissionSystemExtensionConfig` 增必填字段 `keybindings: Keybindings;`，`DEFAULT_EXTENSION_CONFIG` 加 `keybindings: { ...DEFAULT_KEYBINDINGS }`。`normalizePermissionSystemConfig` 签名改为 `(raw, onDrop?: (key: string) => void)`,返回值加 `keybindings: normalizeKeybindings(raw, onDrop)`。

- [ ] **Step 3: config-store 传 onDrop 到 debug 日志**

`src/config-store.ts` `refresh` 里：

```ts
const runtimeConfig = normalizePermissionSystemConfig(mergeResult.merged, (dropped) => {
  this.deps.logger.debug("config.keybindings", { droppedKey: dropped });
});
```

- [ ] **Step 4: 运行测试 + check**

```bash
pnpm test -- extension-config
pnpm run check
```

- [ ] **Step 5: Commit**

```bash
git add src/extension-config.ts src/config-store.ts test/extension-config.test.ts
git commit -m "feat(pi-permission-system): 共享 Keybindings 类型/默认/归一同 sanitizeKeyArray"
```

---

### Task 3: `keybindings` schema + example + gen:schema

**Files:**
- Modify: `src/config-schema.ts`
- Modify: `src/config-loader.ts`（`mergeUnifiedConfigs` 浅合并 keybindings）
- Modify: `config/config.example.json`
- Test: `test/config-schema.test.ts`（parity）

**Interfaces:**
- Consumes: Task 2 的 `Keybindings` 字段名（schema 与之一一对应）。
- Produces: `unifiedConfigSchema` 顶层 `keybindings`；schema 校验失败视为 scope 整体拒绝（现有 fail-closed 行为，issue 走 config-loader warning）。

- [ ] **Step 1: 加 schema**

`src/config-schema.ts` 新增：

```ts
const keybindingsSchema = z
  .strictObject({
    approve: z.array(z.string()).optional().meta({
      description: "Approve once: a list of keys (empty list disables).",
    }),
    approveSession: z.array(z.string()).optional().meta({
      description: "Approve for this session: a list of keys.",
    }),
    deny: z.array(z.string()).optional().meta({
      description: "Deny: a list of keys.",
    }),
    denyWithReason: z.array(z.string()).optional().meta({
      description: "Deny with a reason: a list of keys.",
    }),
    confirm: z.array(z.string()).optional().meta({
      description: "Confirm the highlighted option.",
    }),
    cancel: z.array(z.string()).optional().meta({
      description: "Cancel / go back.",
    }),
    navUp: z.array(z.string()).optional().meta({
      description: "Move the highlight up.",
    }),
    navDown: z.array(z.string()).optional().meta({
      description: "Move the highlight down.",
    }),
    scrollUp: z.array(z.string()).optional().meta({
      description: "Diff view: scroll up (disabled by default).",
    }),
    scrollDown: z.array(z.string()).optional().meta({
      description: "Diff view: scroll down (disabled by default).",
    }),
    pageUp: z.array(z.string()).optional().meta({ description: "Diff view: page up." }),
    pageDown: z.array(z.string()).optional().meta({ description: "Diff view: page down." }),
    scrollTop: z.array(z.string()).optional().meta({ description: "Diff view: scroll to top." }),
    scrollBottom: z.array(z.string()).optional().meta({ description: "Diff view: scroll to bottom." }),
    nextHunk: z.array(z.string()).optional().meta({ description: "Diff view: next hunk." }),
    prevHunk: z.array(z.string()).optional().meta({ description: "Diff view: previous hunk." }),
    toggleMode: z.array(z.string()).optional().meta({ description: "Diff view: toggle split/unified." }),
    toggleWrap: z.array(z.string()).optional().meta({ description: "Diff view: toggle line wrap." }),
    toggleExpand: z.array(z.string()).optional().meta({ description: "Diff view: toggle expand (unused)." }),
    contextMore: z.array(z.string()).optional().meta({ description: "Diff view: more context lines." }),
    contextLess: z.array(z.string()).optional().meta({ description: "Diff view: fewer context lines." }),
    yoloToggle: z.array(z.string()).optional().meta({
      description: "Toggle YOLO mode.",
    }),
  })
  .meta({
    id: "keybindings",
    description:
      "Configurable keyboard shortcuts. Each value is an array of pi KeyId strings; an empty array disables that action; omitted actions use the built-in defaults.",
  });
```

并在 `unifiedConfigSchema` 对象内加 `keybindings: keybindingsSchema.optional()`。

- [ ] **Step 2: mergeUnifiedConfigs 浅合并 keybindings**

`src/config-loader.ts` `mergeUnifiedConfigs` 末尾追加：

```ts
  // keybindings: shallow-merge per action so a project entry overrides a
  // single action but never drops other global actions.
  const baseKb = base.keybindings;
  const overrideKb = override.keybindings;
  if (baseKb && overrideKb) {
    merged.keybindings = { ...baseKb, ...overrideKb };
  } else if (baseKb) {
    merged.keybindings = baseKb;
  } else if (overrideKb) {
    merged.keybindings = overrideKb;
  }
```

- [ ] **Step 3: config.example.json 加 keybindings 示例**

在 `"authorizerChain": []` 之后插入：

```json
  "keybindings": {
    "approve": ["y"],
    "approveSession": ["s"],
    "deny": ["d"],
    "denyWithReason": ["r"],
    "confirm": ["enter"],
    "cancel": ["escape"],
    "navUp": ["up", "k"],
    "navDown": ["down", "j"],
    "nextHunk": ["n"],
    "prevHunk": ["p"],
    "scrollUp": [],
    "scrollDown": [],
    "yoloToggle": ["ctrl+alt+y"]
  },
```

- [ ] **Step 4: 更新 schema 测试 + 重生成 schema**

`test/config-schema.test.ts` 加一条：`unifiedConfigSchema` 接受合法 keybindings、拒绝未知 action 名（`unrecognized_keys`）。然后：

```bash
pnpm run gen:schema         # 重新生成 schemas/permissions.schema.json
pnpm test -- config-schema  # parity 测试必须通过(无漂移)
pnpm run check
```

- [ ] **Step 5: Commit**

```bash
git add src/config-schema.ts src/config-loader.ts config/config.example.json schemas/permissions.schema.json test/config-schema.test.ts
git commit -m "feat(pi-permission-system): keybindings 配置 schema + 合并 + example + 重新生成 JSON Schema"
```

---

### Task 4: 决策模型 `optionKeys` + `prompt-key-matcher`

**Files:**
- Modify: `src/authority/permission-prompt-decision.ts`
- Create: `src/authority/prompt-key-matcher.ts`
- Test: `test/authority/permission-prompt-decision.test.ts`（新增）

**Interfaces:**
- Consumes: `DecisionKeybindings`（Task 2）、`PromptKey`（本文件）。
- Produces:
  - `PromptModelConfig.optionKeys: Record<PromptKey, string>`（必填;显示/arming 提示用首键）；
  - `firstOptionKeys(kb: DecisionKeybindings): Record<PromptKey, string>`；
  - `matchDecisionHotkey(kb, data): PromptKey | undefined`、`matchNavUp(kb, data): boolean`、`matchNavDown(kb, data): boolean`、`matchConfirm(kb, data): boolean`、`matchCancel(kb, data): boolean`、`keyLabel(key: string): string`（`src/authority/prompt-key-matcher.ts`）。

- [ ] **Step 1: 写失败的测试**

`test/authority/permission-prompt-decision.test.ts`：`makeConfig` 增加默认 `optionKeys: { y: "y", s: "s", n: "n", r: "r" }`；新增：

```ts
import { firstOptionKeys } from "#src/authority/permission-prompt-decision";
import {
  matchCancel, matchConfirm, matchDecisionHotkey, matchNavDown, matchNavUp,
} from "#src/authority/prompt-key-matcher";

const KB = {
  approve: ["y", "a"], approveSession: ["s"], deny: ["d"], denyWithReason: ["r"],
  confirm: ["enter"], cancel: ["escape"], navUp: ["up", "k"], navDown: ["down", "j"],
};

describe("prompt-key-matcher", () => {
  it("firstOptionKeys 取每个 action 的第一个键", () => {
    expect(firstOptionKeys(KB)).toEqual({ y: "y", s: "s", n: "d", r: "r" });
  });

  it("matchDecisionHotkey 按 approve→approveSession→deny→denyWithReason 顺序", () => {
    expect(matchDecisionHotkey(KB, "a")).toBe("y");
    expect(matchDecisionHotkey(KB, "s")).toBe("s");
    expect(matchDecisionHotkey(KB, "d")).toBe("n");
    expect(matchDecisionHotkey(KB, "r")).toBe("r");
    expect(matchDecisionHotkey(KB, "q")).toBeUndefined();
  });

  it("nav/confirm/cancel 命中", () => {
    expect(matchNavUp(KB, "k")).toBe(true);
    expect(matchNavDown(KB, "j")).toBe(true);
    expect(matchConfirm(KB, "\r")).toBe(true);
    expect(matchCancel(KB, "\u001b")).toBe(true);
    expect(matchNavUp(KB, "x")).toBe(false);
  });
});

describe("reducePrompt 用 optionKeys 生成 arming 提示", () => {
  it("提示显示该 action 的第一个键而非 PromptKey 字母", () => {
    const config = makeConfig({ optionKeys: { y: "a", s: "s", n: "d", r: "r" } });
    const outcome = reducePrompt(config, initialPromptState(config), {
      type: "hotkey", key: "y",
    });
    if (outcome.kind !== "render") throw new Error("expected render");
    expect(outcome.state.hint).toBe("Press a again to approve.");
  });
});
```

运行确认失败：

```bash
pnpm test -- permission-prompt-decision
```

- [ ] **Step 2: 实现**

`src/authority/prompt-key-matcher.ts`：

```ts
import { matchesKey } from "@earendil-works/pi-tui";
import type { DecisionKeybindings } from "#src/extension-config";
import type { PromptKey } from "#src/authority/permission-prompt-decision";

export function matchDecisionHotkey(
  kb: DecisionKeybindings,
  data: string,
): PromptKey | undefined {
  if (matchesAny(kb.approve, data)) return "y";
  if (matchesAny(kb.approveSession, data)) return "s";
  if (matchesAny(kb.deny, data)) return "n";
  if (matchesAny(kb.denyWithReason, data)) return "r";
  return undefined;
}

export function matchNavUp(kb: DecisionKeybindings, data: string): boolean {
  return matchesAny(kb.navUp, data);
}
export function matchNavDown(kb: DecisionKeybindings, data: string): boolean {
  return matchesAny(kb.navDown, data);
}
export function matchConfirm(kb: DecisionKeybindings, data: string): boolean {
  return matchesAny(kb.confirm, data);
}
export function matchCancel(kb: DecisionKeybindings, data: string): boolean {
  return matchesAny(kb.cancel, data);
}

function matchesAny(keys: string[], data: string): boolean {
  return keys.some((key) => matchesKey(data, key));
}

const KEY_LABELS: Record<string, string> = {
  up: "↑", down: "↓", left: "←", right: "→",
  pageup: "PgUp", pagedown: "PgDn", home: "Home", end: "End",
  escape: "Esc", esc: "Esc", tab: "Tab", enter: "Enter",
};

export function keyLabel(key: string): string {
  return KEY_LABELS[key] ?? key;
}
```

`src/authority/permission-prompt-decision.ts`：

- `PromptModelConfig` 增必填 `optionKeys: Record<PromptKey, string>;`。
- `pressHotkey` 的 hint 改为：

```ts
hint: `Press ${config.optionKeys[key]} again to ${OPTION_VERBS[key]}.`,
```

- 新增导出：

```ts
import type { DecisionKeybindings } from "#src/extension-config";

export function firstOptionKeys(
  kb: DecisionKeybindings,
): Record<PromptKey, string> {
  return {
    y: kb.approve[0] ?? "y",
    s: kb.approveSession[0] ?? "s",
    n: kb.deny[0] ?? "n",
    r: kb.denyWithReason[0] ?? "r",
  };
}
```

- [ ] **Step 3: 运行测试 + check**

```bash
pnpm test -- permission-prompt-decision
pnpm run check
```

- [ ] **Step 4: Commit**

```bash
git add src/authority/permission-prompt-decision.ts src/authority/prompt-key-matcher.ts test/authority/permission-prompt-decision.test.ts
git commit -m "feat(pi-permission-system): 决策模型 optionKeys 首键提示 + prompt-key-matcher 共享命中"
```

---

### Task 5: overlay 权限对话框接入

**Files:**
- Modify: `src/authority/permission-prompt-component.ts`
- Test: `test/authority/permission-prompt-component.test.ts`

**Interfaces:**
- Consumes: `DecisionKeybindings`（Task 2）、`firstOptionKeys`/matcher/keyLabel（Task 4）、`PromptModelConfig.optionKeys`（Task 4）。
- Produces: `PermissionPromptView` 增必填 `keybindings: DecisionKeybindings`。

- [ ] **Step 1: 改 `PermissionPromptView` + 构造 config**

```ts
export interface PermissionPromptView {
  mode: ExtensionContext["mode"];
  ui: PermissionPromptUi;
  doublePressToConfirm: boolean;
  keybindings: DecisionKeybindings;
}
```

`presentInlinePermissionPrompt` 里：

```ts
const config: PromptModelConfig = {
  doublePressToConfirm: view.doublePressToConfirm,
  sessionLabel: options?.sessionLabel ?? DEFAULT_SESSION_LABEL,
  sessionScope: options?.sessionScope,
  optionKeys: firstOptionKeys(view.keybindings),
};
```

- [ ] **Step 2: `toEvent` 改用 matcher**

```ts
private toEvent(data: string): PromptEvent | undefined {
  if (this.state.step === "decision") {
    const key = matchDecisionHotkey(this.kb, data);
    if (key) return { type: "hotkey", key };
  }
  if (matchNavUp(this.kb, data)) return { type: "nav", direction: "up" };
  if (matchNavDown(this.kb, data)) return { type: "nav", direction: "down" };
  if (matchConfirm(this.kb, data)) return { type: "confirm" };
  if (matchCancel(this.kb, data)) return { type: "cancel" };
  return undefined;
}
```

组件构造函数加 `private readonly kb: DecisionKeybindings`（来自 `view.keybindings`）。删除原 `toEvent` 里对 `up/down/j/k/ctrl+p/ctrl+n/enter/escape/OPTION_ORDER.find(...)` 的硬编码分支。

- [ ] **Step 3: 决策行/hint 显示首键**

`renderDecision`：
- 选项行 `(key)` 改 `(this.config.optionKeys[key])`。
- 底部 hint（decision 步）改为动态：

```ts
const kb = this.kb;
const move = `${keyLabel(kb.navUp[0] ?? "up")}/${keyLabel(kb.navDown[0] ?? "down")}`;
const hint =
  `${move} move · ${keyLabel(kb.confirm[0] ?? "enter")} confirm · ` +
  `${keyLabel(kb.deny[0] ?? "d")} deny` +
  (this.config.doublePressToConfirm
    ? " · press a letter, then again to confirm"
    : "");
lines.push(this.theme.fg("muted", hint));
```

（现在 hint 不再硬编码 "esc deny"；scope/reason 步的静态 hint 保留原样。）

- [ ] **Step 4: 更新组件测试**

`test/authority/permission-prompt-component.test.ts`：
- `makeFakeView` 的 `view` 对象加：

```ts
keybindings: {
  approve: ["y", "a"], approveSession: ["s"], deny: ["d"], denyWithReason: ["r"],
  confirm: ["enter"], cancel: ["escape"], navUp: ["up", "k"], navDown: ["down", "j"],
},
```

- `runPrompt(true, ["n", "n"])` 改为 `["d", "d"]`（deny 现在默认 `d`）。
- "resolves denied on n, n" → 改名/改键 `["d", "d"]`。
- `runPrompt(true, [ARROW_DOWN, ARROW_DOWN, ENTER])` 仍成立（nav 含 up/down）。
- ctrl+n / ctrl+p 导航两个用例：改用 `"j"` / `"k"`（`expect(text).toContain("▶ (s)")` 等断言保留）。新增断言 `▶ (d)` 而非 `▶ (n)`。
- "keeps ctrl+n/ctrl+p as an undocumented shortcut" 用例改名 `"ctrl+n/ctrl+p 不再是导航快捷键(默认已移除)"`，断言 hint 不含 `ctrl+n`/`ctrl+p` 且两键不移动高亮（渲染仍 `▶ (y)`）。
- reason 步回来后再 deny 的用例 `["r", ESCAPE, "n"]` → `["r", ESCAPE, "d"]`。
- 提交前跑：

```bash
pnpm test -- permission-prompt-component
pnpm run check
```

- [ ] **Step 5: Commit**

```bash
git add src/authority/permission-prompt-component.ts test/authority/permission-prompt-component.test.ts
git commit -m "feat(pi-permission-system): overlay 权限对话框快捷键配置化 + 决策行/提示首键"
```

---

### Task 6: diff 决策区接入

**Files:**
- Modify: `src/authority/diff-ask-adapter.ts`
- Test: `test/authority/diff-ask-adapter.test.ts`

**Interfaces:**
- Consumes: `DecisionKeybindings`（Task 2）、`firstOptionKeys`/matcher/keyLabel（Task 4）。
- Produces: `DiffPromptDecisionLayer` 构造 opts 增必填 `keybindings: DecisionKeybindings`；`handleInput` 在 decision 步也开始消费 nav。

- [ ] **Step 1: 改构造 + handleInput**

`DiffPromptDecisionLayer`：

```ts
constructor(opts: {
  labels: DiffReviewLabels;
  doublePressToConfirm: boolean;
  sessionScope?: NonNullable<RequestPermissionOptions["sessionScope"]>;
  keybindings: DecisionKeybindings;
}) {
  ...
  this.config = {
    doublePressToConfirm: opts.doublePressToConfirm,
    sessionLabel: opts.labels.session,
    sessionScope: opts.sessionScope,
    optionKeys: firstOptionKeys(opts.keybindings),
  };
  this.kb = opts.keybindings;
}
```

`handleInput` 重写为按 step 分发（删除 `HOTKEY_TO_PROMPT_KEY`）：

```ts
handleInput(data: string): DecisionLayerResult {
  switch (this.state.step) {
    case "reason":
      return this.handleReasonInput(data);
    case "scope":
      if (matchNavUp(this.kb, data)) return this.apply({ type: "nav", direction: "up" });
      if (matchNavDown(this.kb, data)) return this.apply({ type: "nav", direction: "down" });
      if (matchConfirm(this.kb, data)) return this.apply({ type: "confirm" });
      if (matchCancel(this.kb, data)) return this.apply({ type: "cancel" });
      return { kind: "ignored" };
    default: {
      const key = matchDecisionHotkey(this.kb, data);
      if (key) return this.apply({ type: "hotkey", key });
      if (matchNavUp(this.kb, data)) return this.apply({ type: "nav", direction: "up" });
      if (matchNavDown(this.kb, data)) return this.apply({ type: "nav", direction: "down" });
      if (matchConfirm(this.kb, data)) return this.apply({ type: "confirm" });
      if (matchCancel(this.kb, data)) return this.apply({ type: "cancel" });
      return { kind: "ignored" };
    }
  }
}
```

`renderDecision`：`(DISPLAY_KEY[key])` 改为 `(this.config.optionKeys[key])`;hint 改为动态（决策键 + move;hunk 键由 footer 显示）:

```ts
const kb = this.kb;
const move = `${keyLabel(kb.navUp[0] ?? "up")}/${keyLabel(kb.navDown[0] ?? "down")}`;
rows.push(
  this.theme.fg(
    "muted",
    `${move} move · ${keyLabel(kb.confirm[0] ?? "enter")} confirm · ` +
      `${keyLabel(kb.deny[0] ?? "d")} deny · ${keyLabel(kb.denyWithReason[0] ?? "r")} deny+reason`,
  ),
);
```

删除 `DISPLAY_KEY`、`HOTKEY_TO_PROMPT_KEY` 常量。

- [ ] **Step 2: 更新测试**

`test/authority/diff-ask-adapter.test.ts`：
- 新增 `const DEFAULT_KB = { approve: ["y"], approveSession: ["s"], deny: ["d"], denyWithReason: ["r"], confirm: ["enter"], cancel: ["escape"], navUp: ["up", "k"], navDown: ["down", "j"] };`（类型 `DecisionKeybindings`）。
- `makeLayer` 的构造加 `keybindings: DEFAULT_KB`。
- "a 是 approve 别名" → 改为 `"a 不再是默认 approve 键(默认仅 y)→ ignored"`，断言 `{ kind: "ignored" }`。
- "↑↓ 在 decision 步 → ignored(交 viewer 滚动)" → 改为 `"↑↓ 在 decision 步移动高亮(consumed)"`：

```ts
it("↑↓ 在 decision 步移动高亮(consumed)", () => {
  const layer = makeLayer();
  expect(layer.handleInput("\u001b[B")).toEqual({ kind: "consumed" });
  expect(layer.render(80).join("\n")).toContain("▶ (s)");
});
```

- render 断言 `"(esc) No"` → `"(d) No"`;`"esc deny"` → 断言 `"d deny"`。
- "j/k 等查看键 → ignored" → 改为查看键用未绑定的键 `["w", "\t", "x"]`（`j`/`k` 现在是 nav，会 consumed）。
- "n 不是拒绝键(交 viewer 的 hunk)→ ignored" 保留（deny 默认 `d`,`n` 仍是 hunk 查看键）。
- "ctrl+n/ctrl+p … → ignored" 保留。
- 运行：

```bash
pnpm test -- diff-ask-adapter
pnpm run check
```

- [ ] **Step 3: Commit**

```bash
git add src/authority/diff-ask-adapter.ts test/authority/diff-ask-adapter.test.ts
git commit -m "feat(pi-permission-system): diff 决策区快捷键配置化, 移除 y/a/s/r/hotkey 硬编码"
```

---

### Task 7: authority 装配（local-user-authorizer 穿 `keybindings`）

**Files:**
- Modify: `src/authority/local-user-authorizer.ts`
- Modify: `src/diff-view/component.ts`
- Modify: `src/diff-view/presenter.ts`
- Test: `test/authority/local-user-authorizer.test.ts`、`test/diff-view/presenter.test.ts`

**Interfaces:**
- Consumes: `DiffKeybindings`（Task 1）、`Keybindings`/`DecisionKeybindings`（Task 2）。
- Produces: `DiffReviewInput` 增必填 `viewerKeybindings: DiffKeybindings`;`LocalUserAuthorizer.authorize` 的 overlay 路径 `view.keybindings` 来自 `config.keybindings`;`presentDiff` 组装 viewer + 决策层。

- [ ] **Step 1: presenter 增 `viewerKeybindings`**

`src/diff-view/presenter.ts` `DiffReviewInput` 加 `viewerKeybindings: DiffKeybindings;`(import `type { DiffKeybindings } from "./keybindings.js"`)。

`src/diff-view/component.ts` `DiffAskComponent` 构造改用：

```ts
this.viewer = new DiffViewer(
  tui, theme, preview, "default", true,
  input.viewerKeybindings,
  input.defaultView, "full", input.cwd, computeViewerMaxHeight(tui, input),
);
```

（不再 import/使用 `DEFAULT_KEYBINDINGS`。）

- [ ] **Step 2: local-user-authorizer 组装**

`authorize` 的 overlay 回退路径加 `keybindings: this.deps.getConfig().keybindings`。

`presentDiff`:

```ts
const config = this.deps.getConfig();
const kb = config.keybindings;
const defaultView = config.toolDiffDefaultView ?? "unified";
const labels: DiffReviewLabels = { approve: "Yes", session: ..., deny: "No", denyReason: "No, provide reason" };
const decisionLayer = new DiffPromptDecisionLayer({
  labels,
  doublePressToConfirm: this.deps.getPromptPreferences().doublePressToConfirm,
  sessionScope: buildRequestOptions(details)?.sessionScope,
  keybindings: kb,
});
const input: DiffReviewInput = {
  toolName: details.toolName as "write" | "edit",
  input: details.toolInput,
  cwd: this.deps.cwd,
  labels,
  defaultView,
  decisionLayer,
  viewerKeybindings: {
    approve: kb.approve,
    reject: kb.deny,
    scrollUp: kb.scrollUp,
    scrollDown: kb.scrollDown,
    pageUp: kb.pageUp,
    pageDown: kb.pageDown,
    scrollTop: kb.scrollTop,
    scrollBottom: kb.scrollBottom,
    nextHunk: kb.nextHunk,
    prevHunk: kb.prevHunk,
    toggleMode: kb.toggleMode,
    toggleWrap: kb.toggleWrap,
    toggleExpand: kb.toggleExpand,
    contextMore: kb.contextMore,
    contextLess: kb.contextLess,
  },
};
```

- [ ] **Step 3: 更新相关测试**

- `test/diff-view/presenter.test.ts`:构造 `DiffReviewInput` 处补 `viewerKeybindings`（可用 `DEFAULT_KEYBINDINGS`）。
- `test/authority/local-user-authorizer.test.ts`:所有 `getConfig: () => DEFAULT_EXTENSION_CONFIG` 处已自动含 keybindings;若某夹具显式构造 config 对象（如 `deps.getConfig = () => ({...})` 处）,补 `keybindings: DEFAULT_KEYBINDINGS`。搜索 `getConfig` 逐个核对。
- 新增一个集成断言（在 local-user-authorizer.test.ts）:presentDiff 路径下决策层收到配置键（例如配置 `deny: ["z"]` 后，`(z) No` 出现在渲染中）。按该文件现有 harness 写法补充。
- 运行：

```bash
pnpm test -- local-user-authorizer presenter
pnpm run check
```

- [ ] **Step 4: Commit**

```bash
git add src/authority/local-user-authorizer.ts src/diff-view/component.ts src/diff-view/presenter.ts test/authority/local-user-authorizer.test.ts test/diff-view/presenter.test.ts
git commit -m "feat(pi-permission-system): authority 装配从 config.keybindings 注入 viewer 与决策层"
```

---

### Task 8: YOLO 数组化

**Files:**
- Modify: `src/yolo-shortcut.ts`
- Modify: `src/index.ts`
- Test: `test/yolo-shortcut.test.ts`

**Interfaces:**
- Consumes: `Keybindings`（Task 2）、`parseShortcutKey`。
- Produces: `registerYoloModeShortcut(pi, configService, keys: string[])`——`keys` 为空数组 = 禁用（不注册）;非空 = 逐键 `pi.registerShortcut`。

- [ ] **Step 1: 写失败的测试**

`test/yolo-shortcut.test.ts` 的第二个 `describe` 改为数组语义：

```ts
describe("registerYoloModeShortcut 数组语义", () => {
  function capture(keys?: string[]) {
    const registerShortcut = vi.fn();
    const pi = { registerShortcut } as never;
    registerYoloModeShortcut(
      pi,
      makeConfigService({ ...DEFAULT_EXTENSION_CONFIG }) as never,
      keys ?? [],
    );
    return registerShortcut;
  }

  it("逐键注册数组中的每个键", () => {
    const registerShortcut = capture(["ctrl+shift+p", "ctrl+m"]);
    expect(registerShortcut).toHaveBeenCalledTimes(2);
    expect(registerShortcut).toHaveBeenNthCalledWith(
      1, "ctrl+shift+p", expect.objectContaining({ description: "Toggle YOLO mode" }),
    );
    expect(registerShortcut).toHaveBeenNthCalledWith(2, "ctrl+m", expect.anything());
  });

  it("空数组 → 不注册(禁用)", () => {
    expect(capture([])).not.toHaveBeenCalled();
  });
});
```

`register()`（第一块）改为 `registerYoloModeShortcut(pi, service, ["ctrl+alt+y"])` 并断言注册的是 `"ctrl+alt+y"`。运行确认失败后实现。

- [ ] **Step 2: 实现 yolo-shortcut**

```ts
export function registerYoloModeShortcut(
  pi: ExtensionAPI,
  configService: PermissionConfigService,
  keys: string[],
): void {
  for (const shortcut of keys) {
    const parsed = parseShortcutKey(shortcut);
    if (!parsed.ok) continue; // 非法元素在 normalize 已丢弃,这里是防御性跳过
    pi.registerShortcut(parsed.key, {
      description: "Toggle YOLO mode",
      handler: (ctx: ExtensionContext) => { /* 原 handler 不变 */ },
    });
  }
}
```

空数组自然不注册(禁用)。**删除** `DEFAULT_YOLO_MODE_SHORTCUT` 常量与 `Key` import(不再使用——默认值由 normalize 的 `yoloToggle` 提供)。

- [ ] **Step 3: index.ts 传 `keys`**

```ts
registerYoloModeShortcut(pi, configService, configStore.current().keybindings.yoloToggle);
```

- [ ] **Step 4: 运行 + check**

```bash
pnpm test -- yolo-shortcut
pnpm run check
```

- [ ] **Step 5: Commit**

```bash
git add src/yolo-shortcut.ts src/index.ts test/yolo-shortcut.test.ts
git commit -m "feat(pi-permission-system): YOLO 快捷键数组化注册, keybindings.yoloToggle"
```

---

### Task 9: 文档对齐 + 全量验证

**Files:**
- Modify: `docs/configuration.md`（Runtime Knobs 表加 `keybindings` 行;新增 `### 可配置快捷键 keybindings` 小节;overlay 与 diff 两节更新按键描述）
- Modify: `README.md`（如有快捷键速查,更新默认键与配置说明）
- 复核：`config/config.example.json`、`src/config-schema.ts` 与文档一致性

- [ ] **Step 1: 写配置文档**

`docs/configuration.md` Runtime Knobs 表新增一行：

```markdown
| `keybindings` | *(全默认)* | 可配置本扩展全部快捷键。每个 action 的值为 pi `KeyId` 数组;`[]` 禁用该 action;不写的用内置默认;写数组 = 整体替换;优先级 `keybindings.yoloToggle` → 默认。见下方小节。 |
```

新增小节（放在 overlay 对话框一节之前）列出全部 action 与默认键（用 Task 2 的 `DEFAULT_KEYBINDINGS` 表）+ 示例 JSON,说明"帮助信息只显示每个 action 的第一个键"。更新 overlay 对话框与 interactive diff 两节中的硬编码按键描述（`y`/`s`/`n`/`r` → 默认 `y`/`s`/`d`/`r`;diff 滚动描述改为 禁用/经 `keybindings` 启用;`↑/↓` 为高亮移动）。

- [ ] **Step 2: 全量验证**

```bash
pnpm run check
pnpm test
pnpm run lint
pnpm run gen:schema        # 输出应无变动(已有 parity 守护,若 schema 已是最新则无 diff)
pnpm run verify:public-types
```

确认 `git status` 干净(除 CHANGELOG.md 外,若它被动过则 `git checkout -- CHANGELOG.md`——release-please 拥有它)。

- [ ] **Step 3: Commit**

```bash
git add docs/configuration.md README.md
git commit -m "docs(pi-permission-system): 文档化 keybindings 配置与默认按键, 更新 overlay/diff 键盘说明"
```

---

## 计划自检

- **Spec 覆盖**：§3 默认表 → Task 1/2;§5 装配点 1-7 → Task 2/3(装配点 1-2)、Task 1(装配点 4)、Task 4(决策模型件)、Task 5(装配点 5)、Task 6(装配点 6)、Task 7(装配点 7/4 的投影)、Task 8(装配点 3);§6 校验 → Task 2(非法丢弃+告警)、Task 3(schema fail-closed + 合并);§7 帮助首键 → Task 1/5/6;§11 兼容 → yoloModeShortcut 已移除,仅 `yoloToggle`,不再有回退。
- **占位符扫**：无 TBD/TODO;每步给实际代码与命令。
- **类型一致**：`DecisionKeybindings` 统一从 extension-config 导出;`optionKeys` 在 Task 4 定义、Task 5/6 使用;`viewerKeybindings` 在 Task 7 定义与消费;`registerYoloModeShortcut` 第三参在 Task 8 起为 `string[]`(Task 8 同步改 `index.ts`)。
