# toolDiffPrompt(ask 中交互式 diff 视图)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `pi-permission-system` 的权限 ask 中,对 `write`/`edit` 渲染可交互的统一/分裂 diff 视图,决策语义沿用现有 y/s 会话/r 原因 + scope。

**Architecture:** 端口-适配器。`src/diff-view/` 自包含移植自 `~/wsp/pi-show-diffs`(纯 diff 计算 + 交互视图 + presenter 唯一出口),`authority` 侧 `DiffAskAdapter` 组装 `toolInput`+`cwd` 并注入决策层(基于现有 `reducePrompt`);单向依赖 `authority → diff-view`;`diff-view` 不 import 任何 `#src/*` 符号。

**Tech Stack:** TypeScript、`@earendil-works/pi-tui`、新增 npm 依赖 `diff`(diff-utils)、`cli-highlight`(语法高亮);移植来源 `~/wsp/pi-show-diffs`。

## Global Constraints

- 本项目只用 `pnpm`(`pnpm add` / `pnpm run …`),禁用 `npm`/`npx`。
- 包内不变量:配置字段必须被运行时读取,不得"声明不读";`PermissionSystemExtensionConfig` 新字段按 `toolInputPreviewMaxLength` 样板(**可选字段**、不进 `DEFAULT_EXTENSION_CONFIG`、读点 `?? 默认`)以最小化 tsc/deepEqual 波及。
- 新配置字段必须定义在 `src/config-schema.ts` 的 `unifiedConfigSchema`(带 `.meta({ description, markdownDescription })`)→ `pnpm run gen:schema` 再生成 → carry 进 `extension-config.ts` 的 `normalizePermissionSystemConfig` → 读点用 `??` 回退。
- 时间:仅 TUI(`ctx.mode === "tui"`)且 gate 为 `ask` 且工具 `write|edit` 且 `toolDiffPrompt` 开启且本地 ask(转发 ask 无 `toolInput`)才走 diff;其余一律现有文本 prompt。
- 决策语义零迁移:批准/拒绝/session/scope 的写回逻辑不动;diff 内容**只在 UI 展示、不落 review log**。
- **键位定稿(修正 spec §5 的 n 键冲突):** `n` 归 **viewer(hunk 导航)**,不再作拒绝热键;拒绝 = `Esc`(或决策层高亮 Enter 确认),带理由拒绝 = `r`。`↑↓` 在非 scope 步交给 viewer 滚动 diff;仅在 **scope step** 时 `↑↓/Enter/Esc` 归决策层(scope 选择)。`y`/`a`=批准、`s`=会话(转发时进 scope)、`Enter`=确认高亮。
- 移植来源 `~/wsp/pi-show-diffs` 为本机仓库,移植以该仓库当前内容为准;统一改 import 后缀与模块风格,`pnpm run check`/`lint`/`test` 全绿。
- 不做:内联编辑、auto-approve、steer、`hashline_edit`、非 TUI 内 diff 流程、转发 wire 改动(M2)。
- 默认视图 `unified`(非 split);`Tab` 运行时切换;窄终端回退 unified(移植源已内置)。
- **§9 修订(2026-08-10 用户裁决 A)**:preview 计算失败(二进制/缺文件/不可读)不触发文本回退,而是在 diff 视图内渲染警告行;`computeChangePreview` 对 write/edit 返回带 `previewError` 的 preview(从不 null),`preview_unavailable` 仅防御性保留(T5 已实现)。T8 据此无需 text 回退分支(仍可保留防御)。

## File Structure

```
src/diff-view/                      (新建,自包含,不 import #src/*)
├─ diff-utils.ts                    移植 pi-show-diffs/src/diff-utils.ts(纯)
├─ syntax-highlight.ts              移植 pi-show-diffs/src/syntax-highlight.ts(纯)
├─ path-display.ts                  移植 pi-show-diffs/src/path-display.ts(PathStyle 固定 "full")
├─ keybindings.ts                   新建:DiffKeybindings 类型 + DEFAULT_KEYBINDINGS(查看键 + approve/reject)
├─ preview.ts                       移植 + 裁剪:computeChangePreview(write/edit)
├─ viewer.ts                        移植 ui.ts 的 DiffViewer 裁剪(仅查看键,删决策/编辑/自动/steer/RPC)
├─ component.ts                     新建:DiffAskComponent(viewer + 注入决策层,裸内容不 frame)
└─ presenter.ts                     新建:DiffUiConnector / DiffReviewInput / DiffReviewDecision / presentDiffReview

src/authority/
├─ permission-prompter.ts           修改:PromptPermissionDetails + toolInput?: unknown
├─ authorizer.ts                    修改:AuthorizerSelectionDeps + getConfig;selectAuthorizer 注入 cwd + getConfig
├─ local-user-authorizer.ts         修改:deps + cwd + getConfig;接入 diff 分支
└─ diff-ask-adapter.ts              新建:shouldUseDiff / mapDiffDecision / DiffPromptDecisionLayer / presentDiff(含 PanelFrame 包装)

src/handlers/gates/tool.ts          修改:promptDetails 携带 toolInput(仅 write/edit)
src/index.ts                        修改:AuthorizerSelection deps 传 getConfig()
src/config-schema.ts                修改:unifiedConfigSchema + 两字段
src/extension-config.ts             修改:PermissionSystemExtensionConfig + normalize
schemas/permissions.schema.json     再生成(gen:schema)
config/config.example.json          修改:示例
docs/configuration.md               修改:新小节
README.md                           修改:简要提及
package.json                        修改:新增 diff、cli-highlight 依赖
```

---

### Task 1:新增依赖并移植纯计算模块(diff-utils + syntax-highlight)

**Files:**
- Modify: `package.json`
- Create: `src/diff-view/diff-utils.ts`
- Create: `src/diff-view/syntax-highlight.ts`
- Test: `test/diff-view/diff-utils.test.ts`
- Test: `test/diff-view/syntax-highlight.test.ts`

**Interfaces:**
- Consumes: 移植源 `~/wsp/pi-show-diffs/src/diff-utils.ts`、`syntax-highlight.ts`。
- Produces: `generateDiffString(before, after): { diff: string; model?: StructuredDiff }`、`summarizeDiff(diff): DiffSummary`、`stripBom(raw): { bom, text }`、`detectLineEnding`、`normalizeToLF`、`detectSyntaxLanguage(filePath)`、`tokenizeSyntaxLine(text, lang)`;类型 `StructuredDiff`、`DiffSummary`。

- [ ] **Step 1: 写入对移植后 API 的失败测试**

```ts
// test/diff-view/diff-utils.test.ts
import { describe, expect, it } from "vitest";
import {
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  stripBom,
  summarizeDiff,
} from "#src/diff-view/diff-utils";

describe("diff-utils(移植)", () => {
  it("detectLineEnding 识别 CRLF", () => {
    expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
  });
  it("normalizeToLF 统一为 LF", () => {
    expect(normalizeToLF("a\r\nb")).toBe("a\nb");
  });
  it("stripBom 分离 BOM 与文本", () => {
    expect(stripBom("\uFEFFabc")).toEqual({ bom: "\uFEFF", text: "abc" });
  });
  it("generateDiffString 对无差异返回空 diff", () => {
    const { diff } = generateDiffString("abc\ndef\n", "abc\ndef\n");
    expect(diff).toBe("");
  });
  it("generateDiffString 产出含 +/- 的可视 diff", () => {
    const { diff } = generateDiffString("a\nb\n", "a\nc\n");
    expect(diff).toContain("-b");
    expect(diff).toContain("+c");
  });
  it("summarizeDiff 统计增删", () => {
    const { additions, deletions } = summarizeDiff("@@\n-a\n+b\n");
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
  });
});
```

```ts
// test/diff-view/syntax-highlight.test.ts
import { describe, expect, it } from "vitest";
import {
  detectSyntaxLanguage,
  tokenizeSyntaxLine,
} from "#src/diff-view/syntax-highlight";

describe("syntax-highlight(移植)", () => {
  it("detectSyntaxLanguage 按扩展名识别", () => {
    expect(detectSyntaxLanguage("a.ts")).toBe("typescript");
  });
  it("tokenizeSyntaxLine 对无语法语言原样单段返回", () => {
    const seg = tokenizeSyntaxLine("plain text", undefined);
    expect(seg).toEqual([{ text: "plain text", kind: undefined }]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test test/diff-view/diff-utils.test.ts test/diff-view/syntax-highlight.test.ts`
Expected: FAIL——`Cannot find module '#src/diff-view/diff-utils'`。

- [ ] **Step 3: 添加依赖并移植实现**

```bash
cd /Users/eph/wsp/pi-permission-system
pnpm add diff cli-highlight
mkdir -p src/diff-view
cp ~/wsp/pi-show-diffs/src/diff-utils.ts      src/diff-view/diff-utils.ts
cp ~/wsp/pi-show-diffs/src/syntax-highlight.ts src/diff-view/syntax-highlight.ts
```

两个文件无相对内部导入(`import * as Diff from "diff"`、`import { highlight } from "cli-highlight"` 均为裸导入,`node:*` 除外),无需改。

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test test/diff-view/diff-utils.test.ts test/diff-view/syntax-highlight.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-lock.yaml src/diff-view/diff-utils.ts src/diff-view/syntax-highlight.ts test/diff-view
git commit -m "feat(pi-permission-system): 移植 diff 计算与语法高亮模块到 src/diff-view"
```

---

### Task 2:移植 path-display 与 keybindings

**Files:**
- Create: `src/diff-view/path-display.ts`
- Create: `src/diff-view/keybindings.ts`
- Test: `test/diff-view/path-display.test.ts`

**Interfaces:**
- Consumes: none 外部(内联 `PathStyle` 小类型)。
- Produces: `formatDisplayPath(path: string, style: PathStyle, cwd: string): string`(`PathStyle = "full" | "short"`);`type DiffDefaultView = "split" | "unified"`;`type DiffKeybindings`、`DEFAULT_KEYBINDINGS: DiffKeybindings`。

- [ ] **Step 1: 写 path-display 测试**

```ts
// test/diff-view/path-display.test.ts
import { describe, expect, it } from "vitest";
import { formatDisplayPath } from "#src/diff-view/path-display";

describe("formatDisplayPath", () => {
  it("full 样式原样返回", () => {
    expect(formatDisplayPath("/a/b.ts", "full", "/a")).toBe("/a/b.ts");
  });
  it("short 样式对 cwd 内相对化", () => {
    expect(formatDisplayPath("/a/b.ts", "short", "/a")).toBe("b.ts");
  });
  it("short 样式对 cwd 外保留绝对路径", () => {
    expect(formatDisplayPath("/x/b.ts", "short", "/a")).toBe("/x/b.ts");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test test/diff-view/path-display.test.ts` → FAIL: module missing。

- [ ] **Step 3: 移植 + 新建 keybindings**

```bash
cp ~/wsp/pi-show-diffs/src/path-display.ts src/diff-view/path-display.ts
```

`path-display.ts` 顶部依赖去 `.js` 后缀并指向本模块:

```ts
import { isAbsolute, relative } from "node:path";
import type { PathStyle } from "./keybindings.js";
```

新建 `keybindings.ts`(含 `PathStyle`、`DiffDefaultView`、查看与 approve/reject 键;内联编辑/steer/auto 键已删):

```ts
// src/diff-view/keybindings.ts
export type DiffDefaultView = "split" | "unified";
export type DiffColorMode = "default" | "theme";
export type PathStyle = "full" | "short";

export interface DiffKeybindings {
  approve: string[] | false;
  reject: string[] | false;
  scrollUp: string[] | false;
  scrollDown: string[] | false;
  pageUp: string[] | false;
  pageDown: string[] | false;
  scrollTop: string[] | false;
  scrollBottom: string[] | false;
  nextHunk: string[] | false;
  prevHunk: string[] | false;
  toggleMode: string[] | false;
  toggleWrap: string[] | false;
  toggleExpand: string[] | false;
  contextMore: string[] | false;
  contextLess: string[] | false;
}

export const DEFAULT_KEYBINDINGS: DiffKeybindings = {
  approve: ["Enter", "a", "y"],
  reject: ["Escape", "r"],
  scrollUp: ["up"],
  scrollDown: ["down"],
  pageUp: ["pageUp"],
  pageDown: ["pageDown"],
  scrollTop: ["home"],
  scrollBottom: ["end"],
  nextHunk: ["n"],
  prevHunk: ["p"],
  toggleMode: ["Tab"],
  toggleWrap: ["w"],
  toggleExpand: ["ctrl+f"],
  contextMore: ["right", "]"],
  contextLess: ["left", "["],
};
```

**Global Constraints 键位定稿注意:** `approve` 键仅用于 footer 提示与 key 归一;决策解析实际由决策层(Global Constraints 中 `y/a/Enter`、`Esc/r`、`s`)处理,viewer 在 `handleInput` 中对这些键一律返回 `false`(Task 4)。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test test/diff-view/path-display.test.ts` → PASS。

- [ ] **Step 5: 提交**

```bash
git add src/diff-view/path-display.ts src/diff-view/keybindings.ts test/diff-view/path-display.test.ts
git commit -m "feat(pi-permission-system): 移植路径显示与查看键位定义"
```

---

### Task 3:移植并裁剪 preview(write/edit 计算)

**Files:**
- Create: `src/diff-view/preview.ts`
- Test: `test/diff-view/preview.test.ts`

**Interfaces:**
- Consumes: `diff-utils`(Task 1);移植源 `~/wsp/pi-show-diffs/src/preview.ts`。
- Produces: `type PreviewToolName = "write" | "edit"`;`interface ChangePreview { toolName; path; absolutePath; diff; additions; deletions; summaryLines; previewError?; beforeText?; afterText? }`;`computeChangePreview(toolName: PreviewToolName, input: unknown, cwd: string): Promise<ChangePreview | null>`。

- [ ] **Step 1: 写失败测试(用临时文件)**

```ts
// test/diff-view/preview.test.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeChangePreview } from "#src/diff-view/preview";

describe("computeChangePreview(write/edit)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "diff-view-preview-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("write 新建输出差异与 afterText", async () => {
    const p = join(dir, "a.txt");
    const preview = await computeChangePreview("write", { path: p, content: "x\n" }, "/");
    expect(preview?.additions).toBe(1);
    expect(preview?.summaryLines.join(" ")).toContain("Create new file");
  });

  it("write 覆盖时 diff 含旧->新", async () => {
    const p = join(dir, "b.txt");
    writeFileSync(p, "old\n");
    const preview = await computeChangePreview("write", { path: p, content: "new\n" }, "/");
    expect(preview?.deletions ?? 0).toBeGreaterThan(0);
    expect(preview?.additions ?? 0).toBeGreaterThan(0);
  });

  it("edit 精确匹配可计算", async () => {
    const p = join(dir, "c.txt");
    writeFileSync(p, "aaa\nbbb\n");
    const preview = await computeChangePreview(
      "edit",
      { path: p, oldText: "bbb", newText: "BBB" },
      "/",
    );
    expect(preview?.afterText).toContain("BBB");
  });

  it("edit oldText 缺失时 previewError 非空", async () => {
    const p = join(dir, "d.txt");
    writeFileSync(p, "aaa\n");
    const preview = await computeChangePreview(
      "edit",
      { path: p, oldText: "nope", newText: "x" },
      "/",
    );
    expect(preview?.previewError).toBeTruthy();
  });

  it("非 write/edit 返回 null", async () => {
    expect(await computeChangePreview("bash" as never, {}, "/")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test test/diff-view/preview.test.ts` → FAIL: module missing。

- [ ] **Step 3: 移植并裁剪**

```bash
cp ~/wsp/pi-show-diffs/src/preview.ts src/diff-view/preview.ts
```

裁剪点(参照移植源当前内容逐一删改,保留 `computeEditPreview` / `computeWritePreview` / `resolveTotCwd` / `errorPreview` / `createChangePreviewFromTexts` / `createBinaryPreviewMessage` / `detectBinaryKind` 等辅助):
- 删除 `import { computeHashlinePreview, type HashlineEditInput } from "./hashline.js";` 及 `computeHashlineEditChangePreview` 整个函数。
- `PreviewToolName` 改为 `"write" | "edit"`。
- 相对内部导入去 `.js` 后缀(`./diff-utils.js` → `./diff-utils`)。
- `computeChangePreview` 保留 write/edit 两支,删 hashline 分支。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test test/diff-view/preview.test.ts` → PASS。

- [ ] **Step 5: 提交**

```bash
git add src/diff-view/preview.ts test/diff-view/preview.test.ts
git commit -m "feat(pi-permission-system): 移植 write/edit diff preview 计算并裁剪 hashline"
```

---

### Task 4:移植并裁剪交互 diff 视图(viewer.ts)

**Files:**
- Create: `src/diff-view/viewer.ts`
- Test: `test/diff-view/viewer.test.ts`

**Interfaces:**
- Consumes: `ChangePreview`(Task 3)、`DEFAULT_KEYBINDINGS`/`DiffKeybindings`/`DiffDefaultView`/`DiffColorMode`(Task 2)、`detectSyntaxLanguage`/`tokenizeSyntaxLine`(Task 1)、`formatDisplayPath`(Task 2);移植源 `~/wsp/pi-show-diffs/src/ui.ts` 的 `DiffViewer` 类。
- Produces: `DiffViewer` 类(裁剪版)。构造签名:
  `new DiffViewer(tui, theme, preview, diffColorMode: DiffColorMode, showDiffRail: boolean, kb: DiffKeybindings, defaultView: DiffDefaultView, pathStyle: PathStyle, cwd: string)`。
  暴露:`render(width): string[]`、`invalidate()`、`handleInput(data): boolean`(true=已消费,仅处理**查看键**)、`viewMode(): DiffDefaultView`、`hunkOffsets(): number[]`。
- 规则:**viewer 不拥有 approve/reject/session/steer/auto 决策**——`handleInput` 对 `y/a/s/r/Escape` 一律返回 `false`;`n` 归 hunk 下一段(查看键)。

- [ ] **Step 1: 写失败测试(查看键行为 + 键分离)**

```ts
// test/diff-view/viewer.test.ts
import { describe, expect, it, vi } from "vitest";
import { DiffViewer } from "#src/diff-view/viewer";
import type { ChangePreview } from "#src/diff-view/preview";
import { DEFAULT_KEYBINDINGS } from "#src/diff-view/keybindings";

function makePreview(overrides: Partial<ChangePreview> = {}): ChangePreview {
  return {
    toolName: "write",
    path: "/a.txt",
    absolutePath: "/a.txt",
    diff: "-old\n+new\n",
    additions: 1,
    deletions: 1,
    summaryLines: ["Create new file"],
    beforeText: "old\n",
    afterText: "new\n",
    ...overrides,
  };
}
const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t };
const tui = {
  requestRender: vi.fn(),
  getShowHardwareCursor: () => true,
  setShowHardwareCursor: vi.fn(),
};

function makeViewer(defaultView: "split" | "unified" = "unified") {
  return new DiffViewer(
    tui as never,
    theme as never,
    makePreview(),
    "default",
    true,
    DEFAULT_KEYBINDINGS,
    defaultView,
    "full",
    "/",
  );
}

describe("DiffViewer(裁剪)", () => {
  it("render 返回含 +/- 行的文本", () => {
    const text = makeViewer().render(80).join("\n");
    expect(text).toContain("-old");
    expect(text).toContain("+new");
  });
  it("Tab 切换 split/unified 视图模式", () => {
    const v = makeViewer();
    expect(v.viewMode()).toBe("unified");
    v.handleInput("\t");
    expect(v.viewMode()).toBe("split");
  });
  it("y/a/s/r/Escape 不再被 viewer 消费(交给决策层)", () => {
    const v = makeViewer();
    for (const key of ["a", "y", "s", "r", "\u001b"]) {
      expect(v.handleInput(key)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test test/diff-view/viewer.test.ts` → FAIL: module missing。

- [ ] **Step 3: 移植 ui.ts 并裁剪**

```bash
cp ~/wsp/pi-show-diffs/src/ui.ts src/diff-view/viewer.ts
```

裁剪清单(以移植源当前内容为基准给出锚文本,逐项删除/替换):
1. 顶部 `import { t } from "./i18n.js";` → 内联回退(忽略 params):
   `const t = (_key: string, fallback: string) => fallback;`
2. `import { rebuildPreviewAfterManualEdit, type ChangePreview } from "./preview.js";` → `import type { ChangePreview } from "./preview.js";`。删除 `DiffDecision.afterTextOverride` 字段,动作收敛为 `"approve" | "cancel"`(定义于 viewer.ts 顶部)。
3. 删除内联编辑全部锚点:`private readonly allowAfterEdit` 构造参数、`isEditingInline()`、`enterInlineEditMode()`、`applyUpdatedPreview(rebuildPreviewAfterManualEdit(...))`、`if (!this.allowAfterEdit) return false;`、`kb.editInline` 绑定行、footer 中 `allowAfterEdit? … editInline … : null`。
4. 删除 auto-approve/steer 全部锚点:`matchesBinding(data, kb.autoApprove)`(约三处)、`[kb.autoApprove, …]` 绑定、footer `fmt(kb.autoApprove, …)`、steer 键绑定与 steer 分支。
5. 删除 RPC 分支整段:`if (isRpcMode(ctx)) { … }`(本扩展非 TUI 回退在 authority 侧处理,viewer 只服务 TUI)。
6. `DiffViewer` 构造签名去掉 `allowAfterEdit` 参数;`viewMode()`/`hunkOffsets()` 保持移植源实现。
7. 决策完成函数 `done` 的调用点全部删除:`handleInput` 对 `approve`/`reject` 绑定的匹配不产生 `done(...)`——直接返回 `false`,由组件决策层解析;保留纯查看键(j/k/↑↓/n/p/Tab/h/l/[/]/w/g/G/PgUp/PgDn/home/end)。
8. 不引入 `BorderFrame`——裸内容由 authority 侧 `PanelFrame` 包裹(见 Task 8)。
9. 相对内部导入统一去 `.js`;`DEFAULT_KEYBINDINGS`/类型改从 `#src` 对应的 `./keybindings` 导入(check Task 2 定义)。

> 该步最重。验收:下述 Step 4 全绿。

- [ ] **Step 4: 运行测试与类型检查确认**

Run: `pnpm test test/diff-view/viewer.test.ts && pnpm run check`
Expected: PASS + `tsc --noEmit` 0 错误。

- [ ] **Step 5: 提交**

```bash
git add src/diff-view/viewer.ts test/diff-view/viewer.test.ts
git commit -m "feat(pi-permission-system): 移植交互 diff 视图并剥离决策键(编辑/steer/auto/rpc 已删)"
```

---

### Task 5:presenter 与决策层组合(DiffAskComponent)

**Files:**
- Create: `src/diff-view/presenter.ts`
- Create: `src/diff-view/component.ts`
- Test: `test/diff-view/presenter.test.ts`

**Interfaces:(对 authority 的最终契约)**
```ts
export type DiffToolName = "write" | "edit";
export interface DiffReviewLabels {
  approve: string; session: string; deny: string; denyReason: string;
}
export type DiffReviewDecision =
  | { kind: "approve" }
  | { kind: "approve_for_session"; scope?: "subagent_only" | "serving_session" }
  | { kind: "deny"; reason?: string }
  | { kind: "preview_unavailable" };
export type DecisionLayerResult =
  | { kind: "decision"; decision: DiffReviewDecision }
  | { kind: "consumed" }   // 决策层消化了该键(渲染态变化),别转 viewer
  | { kind: "ignored" };   // 决策层不认 → 交 viewer
export interface DiffDecisionLayer {
  /** 组件构造时注入 theme(构建发生在拿到 tui/theme 的 build 内) */
  setTheme(theme: { fg(c: string, t: string): string; bg(c: string, t: string): string }): void;
  render(width: number): string[];
  handleInput(data: string): DecisionLayerResult;
}
export interface DiffReviewInput {
  toolName: DiffToolName;
  input: unknown;
  cwd: string;
  labels: DiffReviewLabels;
  defaultView: "split" | "unified";
  decisionLayer: DiffDecisionLayer;
}
export type DiffUiConnector = (
  build: (
    tui: { requestRender(): void },
    theme: { fg(c: string, t: string): string; bg(c: string, t: string): string },
    done: (d: DiffReviewDecision) => void,
  ) => { render(width: number): string[]; invalidate(): void; handleInput(data: string): void },
) => Promise<DiffReviewDecision>;
export async function presentDiffReview(
  show: DiffUiConnector,
  input: DiffReviewInput,
): Promise<DiffReviewDecision>;
```

- Consumes: `computeChangePreview` + `ChangePreview`(Task 3)、`DiffViewer`(Task 4)、`DEFAULT_KEYBINDINGS`(Task 2)。
- Produces:`presentDiffReview`——先 `computeChangePreview`;preview 为空 → 直接 `{ kind: "preview_unavailable" }`(不经 UI);否则 `show(build)` 构造 `DiffAskComponent`。

- [ ] **Step 1: 写失败测试(经 fake connector 驱动组件)**

```ts
// test/diff-view/presenter.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  presentDiffReview,
  type DiffDecisionLayer,
  type DiffReviewDecision,
  type DiffReviewInput,
} from "#src/diff-view/presenter";

const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t };
const tui = { requestRender: vi.fn() };

function makeInput(overrides: Partial<DiffReviewInput> = {}): DiffReviewInput {
  const decisionLayer: DiffDecisionLayer = {
    render: () => ["(y) yes · (n) no"],
    handleInput: vi.fn((d: string): import("#src/diff-view/presenter").DecisionLayerResult =>
      d === "y" ? { kind: "decision", decision: { kind: "approve" } } : { kind: "ignored" },
    ),
  };
  return {
    toolName: "write",
    input: { path: "/tmp/x.txt", content: "new\n" },
    cwd: "/",
    labels: { approve: "Yes", session: "Session", deny: "No", denyReason: "No + reason" },
    defaultView: "unified",
    decisionLayer,
    ...overrides,
  };
}

describe("presentDiffReview", () => {
  it("组装组件:渲染 diff 行 + 决策行,决策键返回审批", async () => {
    let component: { render(w: number): string[]; invalidate(): void; handleInput(d: string): void } | undefined;
    const show = vi.fn(
      (build: Parameters<import("#src/diff-view/presenter").DiffUiConnector>[0]) =>
        new Promise<DiffReviewDecision>((resolve) => {
          component = build(tui as never, theme as never, resolve);
        }),
    );
    const promise = presentDiffReview(show as never, makeInput());
    const text = component?.render(80).join("\n") ?? "";
    expect(text).toContain("-old");
    expect(text).toContain("+new");
    expect(text).toContain("(y) yes");
    component?.handleInput("y");
    expect(await promise).toEqual({ kind: "approve" });
  });

  it("preview 计算失败时不触 UI,返回 preview_unavailable", async () => {
    const show = vi.fn();
    const decision = await presentDiffReview(show as never, makeInput({ toolName: "edit", input: { path: "/no/such/file", oldText: "x", newText: "y" } }) as DiffReviewInput);
    expect(show).not.toHaveBeenCalled();
    expect(decision.kind).toBe("preview_unavailable");
  });
});
```

> 注:测试第 2 例用不存在的读取路径让 `computeChangePreview` 失败——具体"不可预览"输入以 `preview.ts` 实现为准(如 `file not found`)。

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test test/diff-view/presenter.test.ts` → FAIL: module missing。

- [ ] **Step 3: 实现 presenter + component**

```ts
// src/diff-view/component.ts
import type { Tui, Theme } from "@earendil-works/pi-tui";
import type { ChangePreview } from "./preview.js";
import type {
  DecisionLayerResult,
  DiffDecisionLayer,
  DiffReviewDecision,
  DiffReviewInput,
} from "./presenter.js";
import { DEFAULT_KEYBINDINGS, type PathStyle } from "./keybindings.js";
import { DiffViewer } from "./viewer.js";

/** diff 区(viewer 查看键)+ 决策区(注入决策层)组合;裸内容,不 frame */
export class DiffAskComponent implements Component {
  private readonly viewer: DiffViewer;
  constructor(
    tui: Tui,
    theme: Theme,
    preview: ChangePreview,
    input: DiffReviewInput,
    private readonly done: (d: DiffReviewDecision) => void,
  ) {
    this.viewer = new DiffViewer(
      tui,
      theme,
      preview,
      "default",
      true,
      DEFAULT_KEYBINDINGS,
      input.defaultView,
      "full" as PathStyle,
      input.cwd,
    );
    this.decisionLayer = input.decisionLayer;
    input.decisionLayer.setTheme(theme);
  }
  private readonly decisionLayer: DiffDecisionLayer;
  invalidate(): void {
    this.viewer.invalidate();
  }
  render(width: number): string[] {
    return [...this.viewer.render(width), "", ...this.decisionLayer.render(width)];
  }
  handleInput(data: string): void {
    const result: DecisionLayerResult = this.decisionLayer.handleInput(data);
    if (result.kind === "decision") {
      this.done(result.decision);
      return;
    }
    if (result.kind === "consumed") {
      return;
    }
    this.viewer.handleInput(data);
  }
}
```

```ts
// src/diff-view/presenter.ts
import type { Component, Theme, Tui } from "@earendil-works/pi-tui";
import { DiffAskComponent } from "./component.js";
import { computeChangePreview } from "./preview.js";

export type DiffToolName = "write" | "edit";
export interface DiffReviewLabels {
  approve: string; session: string; deny: string; denyReason: string;
}
export type DiffReviewDecision =
  | { kind: "approve" }
  | { kind: "approve_for_session"; scope?: "subagent_only" | "serving_session" }
  | { kind: "deny"; reason?: string }
  | { kind: "preview_unavailable" };
export type DecisionLayerResult =
  | { kind: "decision"; decision: DiffReviewDecision }
  | { kind: "consumed" }
  | { kind: "ignored" };
export interface DiffDecisionLayer {
  /** 组件构造时注入 theme(构建发生在拿到 tui/theme 的 build 内) */
  setTheme(theme: { fg(c: string, t: string): string; bg(c: string, t: string): string }): void;
  render(width: number): string[];
  handleInput(data: string): DecisionLayerResult;
}
export interface DiffReviewInput {
  toolName: DiffToolName;
  input: unknown;
  cwd: string;
  labels: DiffReviewLabels;
  defaultView: "split" | "unified";
  decisionLayer: DiffDecisionLayer;
}
// src/diff-view/presenter.ts
  build: (
    tui: Tui,
    theme: Theme,
    done: (d: DiffReviewDecision) => void,
  ) => Component,
) => Promise<DiffReviewDecision>;

export async function presentDiffReview(
  show: DiffUiConnector,
  input: DiffReviewInput,
): Promise<DiffReviewDecision> {
  const preview = await computeChangePreview(input.toolName, input.input, input.cwd);
  if (!preview) {
    return { kind: "preview_unavailable" };
  }
  return show((tui, theme, done) => new DiffAskComponent(tui, theme, preview, input, done));
}
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test test/diff-view/presenter.test.ts && pnpm run check`
Expected: PASS + tsc 0 错误。

- [ ] **Step 5: 提交**

```bash
git add src/diff-view/presenter.ts src/diff-view/component.ts test/diff-view/presenter.test.ts
git commit -m "feat(pi-permission-system): diff-view presenter 与决策层组合组件"
```

---

### Task 6:配置字段(toolDiffPrompt / toolDiffDefaultView)

**Files:**
- Modify: `src/config-schema.ts`(unifiedConfigSchema,`doublePressToConfirm` 附近)
- Modify: `src/extension-config.ts`(接口 + normalize)
- Modify: `schemas/permissions.schema.json`(再生成)
- Modify: `config/config.example.json`
- Modify: `test/extension-config.test.ts`
- Modify: `docs/configuration.md`

**Interfaces:**
- Consumes: 现有 extension config 管线。
- Produces: `PermissionSystemExtensionConfig.toolDiffPrompt?: boolean`、`toolDiffDefaultView?: "split" | "unified"`(可选字段;读点 `?? true` / `?? "unified"`);`normalizePermissionSystemConfig` 提供时才携带。

- [ ] **Step 1: 写失败测试**

```ts
// test/extension-config.test.ts 追加
describe("toolDiffPrompt config", () => {
  it("carries toolDiffPrompt when provided", () => {
    expect(normalizePermissionSystemConfig({ toolDiffPrompt: false }).toolDiffPrompt).toBe(false);
  });
  it("omits toolDiffPrompt when absent", () => {
    expect("toolDiffPrompt" in normalizePermissionSystemConfig({})).toBe(false);
  });
  it("carries toolDiffDefaultView when provided", () => {
    expect(normalizePermissionSystemConfig({ toolDiffDefaultView: "split" }).toolDiffDefaultView).toBe("split");
  });
  it("omits toolDiffDefaultView when absent", () => {
    expect("toolDiffDefaultView" in normalizePermissionSystemConfig({})).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test test/extension-config.test.ts` → FAIL(字段不存在)。

- [ ] **Step 3: 实现**

`src/config-schema.ts` 的 `unifiedConfigSchema`(与 `doublePressToConfirm` 相邻)加入:

```ts
toolDiffPrompt: z.boolean().optional().meta({
  description:
    "When true and the tool is write or edit, ask prompts render an interactive diff view. Defaults to true.",
  markdownDescription:
    "Whether ask prompts for `write`/`edit` render an interactive diff view. Defaults to `true`. Set `false` to fall back to the plain text prompt.",
}),
toolDiffDefaultView: z.enum(["split", "unified"]).optional().meta({
  description:
    "View the diff opens in by default. Defaults to unified; Tab still toggles at runtime.",
  markdownDescription:
    "Default diff view. `unified` (default) or `split`; `Tab` toggles at runtime.",
}),
```

`src/extension-config.ts`:

```ts
export interface PermissionSystemExtensionConfig {
  // … 现有字段 …
  /** Ask 中 write/edit 渲染交互式 diff;缺省 true。 */
  toolDiffPrompt?: boolean;
  /** diff 默认视图;缺省 "unified"。 */
  toolDiffDefaultView?: "split" | "unified";
}
```

`normalizePermissionSystemConfig` 的 `yoloModeShortcut` 块后追加:

```ts
if (raw.toolDiffPrompt !== undefined) {
  result.toolDiffPrompt = raw.toolDiffPrompt;
}
if (raw.toolDiffDefaultView !== undefined) {
  result.toolDiffDefaultView = raw.toolDiffDefaultView === "split" ? "split" : "unified";
}
```

`UnifiedPermissionConfig` 由 schema infer 自动携带两字段(`#332/#347` 陷阱由 normalize 直接读 typed 字段而避免——tsc 会 catch 漏读)。

- [ ] **Step 4: 再生成 schema 并通过测试**

Run: `pnpm run gen:schema && pnpm test test/extension-config.test.ts test/config-schema.test.ts && pnpm run check`
Expected: PASS;`config/config.example.json` 补充 `"toolDiffDefaultView": "unified"` 带注释示例。

- [ ] **Step 5: 文档**

`docs/configuration.md` 新增小节(语义、默认 unified、Tab 切换、false 回退文本)。

- [ ] **Step 6: 提交**

```bash
git add src/config-schema.ts src/extension-config.ts schemas/permissions.schema.json config/config.example.json test/extension-config.test.ts docs/configuration.md
git commit -m "feat(pi-permission-system): 新增 toolDiffPrompt/toolDiffDefaultView 配置"
```

---

### Task 7:数据流——PromptPermissionDetails.toolInput + LocalUserAuthorizer.cwd

**Files:**
- Modify: `src/authority/permission-prompter.ts`(`PromptPermissionDetails` 加 `toolInput?: unknown`)
- Modify: `src/handlers/gates/tool.ts`(promptDetails 携带 toolInput,仅 write/edit)
- Modify: `src/authority/authorizer.ts`(`AuthorizerSelectionDeps` 加 `getConfig`;selectAuthorizer 注入 `cwd` 与 `getConfig` 到 LocalUserAuthorizer)
- Modify: `src/index.ts`(AuthorizerSelection deps 传 `getConfig: () => configStore.current()`)
- Test: `test/authority/authorizer-selection.test.ts`(断言 LocalUserAuthorizer 收到 cwd/getConfig)
- Test: `test/handlers/gates/tool.test.ts`(断言 write/edit 的 promptDetails 带 toolInput;其它工具不带)

**Interfaces:**
- Consumes: `PermissionPromptDetails`;`tcc.input`。
- Produces: `PromptPermissionDetails.toolInput?: unknown`;`LocalUserAuthorizerDeps.cwd: string`、`getConfig: () => PermissionSystemExtensionConfig`。

- [ ] **Step 1: 写失败测试**

```ts
// test/authority/authorizer-selection.test.ts 追加(适配现有 helper 形态)
it("LocalUserAuthorizer 携带 cwd 与 getConfig 构造", () => {
  const env = makeSelectionEnv({ mode: "tui", hasUI: true }); // 既有 helper
  const authorizer = selectAuthorizer(env.ctx, env.deps);
  expect(authorizer).toBeInstanceOf(LocalUserAuthorizer);
  const deps = (authorizer as unknown as { deps: Record<string, unknown> }).deps;
  expect(deps.cwd).toBe(env.ctx.cwd);
  expect(deps.getConfig).toBe(env.deps.getConfig);
});
```

```ts
// test/handlers/gates/tool.test.ts 追加(用 makeHandler 现有关卡跑 write/edit,断言 prompter.escalate 收到的 details)
it("write/edit 的 ask 携带原始 toolInput", async () => {
  const { prompter } = makeHandler({
    session: { checkPermission: makeSurfaceCheck({ write: { state: "ask" } }) },
  });
  const escalated = vi.fn().mockResolvedValue({ approved: true, state: "approved" } as PermissionPromptDecision);
  prompter.escalate = escalated;
  await runToolCall({ handler, toolName: "write", input: { path: "/x.txt", content: "hi" } } as never);
  const details = escalated.mock.calls[0]?.[0];
  expect(details.toolInput).toEqual({ path: "/x.txt", content: "hi" });
});
```

(report:按 `test/handlers/gates/tool.test.ts` 现有驱动方式跑 tool_call,断言 `prompter.escalate` 参数中的 `details.toolInput`。)

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test test/authority/authorizer-selection.test.ts test/handlers/gates/tool.test.ts` → FAIL。

- [ ] **Step 3: 实现**

`src/authority/permission-prompter.ts`:

```ts
export interface PromptPermissionDetails {
  // … 现有 …
  /**
   * 本地 ask 的 write/edit 原始工具 input(diff before/after 计算来源)。
   * 转发 ask 不会带此字段(accessIntent 仅含 path facts)。diff 内容不落 review log。
   */
  toolInput?: unknown;
}
```

`src/handlers/gates/tool.ts` 的 `promptDetails` 对象(约文件尾 `promptDetails: { … }`)中追加:

```ts
...(tcc.toolName === "write" || tcc.toolName === "edit"
  ? { toolInput: tcc.input }
  : {}),
```

`src/authority/authorizer.ts`:
- 顶部 `import type { PermissionSystemExtensionConfig } from "#src/extension-config";`
- `AuthorizerSelectionDeps` 追加 `getConfig: () => PermissionSystemExtensionConfig;`
- `selectAuthorizer` 中 LocalUserAuthorizer 分支改为:

```ts
return new LocalUserAuthorizer({
  ui: ctx.ui,
  mode: ctx.mode,
  cwd: ctx.cwd,
  events: deps.events,
  getPromptPreferences: deps.getPromptPreferences,
  getConfig: deps.getConfig,
  requestPermissionDecision: deps.requestPermissionDecision,
});
```

`src/index.ts` 的 `AuthorizerSelection` 构造参数追加:

```ts
getConfig: () => configStore.current(),
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test test/authority/authorizer-selection.test.ts test/handlers/gates/tool.test.ts && pnpm run check`
Expected: PASS + tsc 0 错误。

- [ ] **Step 5: 提交**

```bash
git add src/authority/permission-prompter.ts src/handlers/gates/tool.ts src/authority/authorizer.ts src/index.ts test/authority/authorizer-selection.test.ts test/handlers/gates/tool.test.ts
git commit -m "feat(pi-permission-system): ask 链路携带 write/edit toolInput 与 cwd,供 diff 计算"
```

---

### Task 8:DiffAskAdapter 接入 LocalUserAuthorizer

**Files:**
- Create: `src/authority/diff-ask-adapter.ts`
- Modify: `src/authority/local-user-authorizer.ts`
- Test: `test/authority/diff-ask-adapter.test.ts`
- Modify: `test/authority/local-user-authorizer.test.ts`

**Interfaces:**
- Consumes: `PromptPermissionDetails`(Task 7)、`presentDiffReview`/`DiffReviewInput`/`DiffReviewDecision`/`Degree`(Task 5)、`reducePrompt`(现有 `permission-prompt-decision.ts`)、`PanelFrame`(现有 `src/ui/panel-frame.ts`)、`requestPermissionDecision`(现有)。
- Produces:
  - `shouldUseDiff(config: PermissionSystemExtensionConfig, details: PromptPermissionDetails, mode: string): boolean`
  - `mapDiffDecision(decision: DiffReviewDecision): PermissionPromptDecision`
  - `DiffPromptDecisionLayer`:实现 `DiffDecisionLayer`,内部持有 `PermissionPromptView` 式的 `{ mode, ui, cwd }` 上下文、wrap `reducePrompt` 状态机;`render(width)` 输出决策行(去 title/message);`handleInput(data)` 归一为 `PromptEvent` 并映射回 `DiffReviewDecision`。
  - `LocalUserAuthorizer.presentDiff(details, uiPrompt): Promise<PermissionPromptDecision>`——TUI 下经 `ui.custom` 显示、preview 失败回退文本。

- [ ] **Step 1: 写失败测试(映射 + 是否走 diff)**

```ts
// test/authority/diff-ask-adapter.test.ts
import { describe, expect, it } from "vitest";
import { createDeniedPermissionDecision } from "#src/authority/permission-dialog";
import { mapDiffDecision, shouldUseDiff } from "#src/authority/diff-ask-adapter";
import type { PromptPermissionDetails } from "#src/authority/permission-prompter";
import type { PermissionSystemExtensionConfig } from "#src/extension-config";

function mk(overrides: Partial<PromptPermissionDetails> = {}): PromptPermissionDetails {
  return {
    requestId: "r",
    source: "tool_call",
    agentName: null,
    message: "m",
    ...overrides,
  } as PromptPermissionDetails;
}
function cfg(overrides: Partial<PermissionSystemExtensionConfig> = {}) {
  return overrides as PermissionSystemExtensionConfig;
}

describe("mapDiffDecision", () => {
  it("approve → approved", () => {
    expect(mapDiffDecision({ kind: "approve" })).toEqual({ approved: true, state: "approved" });
  });
  it("approve_for_session → approved_for_session", () => {
    expect(mapDiffDecision({ kind: "approve_for_session" })).toEqual({ approved: true, state: "approved_for_session" });
  });
  it("deny 无 reason → denied", () => {
    expect(mapDiffDecision({ kind: "deny" })).toEqual(createDeniedPermissionDecision());
  });
  it("deny with reason → denied_with_reason", () => {
    expect(mapDiffDecision({ kind: "deny", reason: "nope" })).toEqual(createDeniedPermissionDecision("nope"));
  });
});

describe("shouldUseDiff", () => {
  it("write + tui + toolInput + 缺省开 → true", () => {
    expect(shouldUseDiff(cfg({}), mk({ toolName: "write", toolInput: {} }), "tui")).toBe(true);
  });
  it("toolDiffPrompt=false → false", () => {
    expect(shouldUseDiff(cfg({ toolDiffPrompt: false }), mk({ toolName: "edit", toolInput: {} }), "tui")).toBe(false);
  });
  it("非 write/edit → false", () => {
    expect(shouldUseDiff(cfg({}), mk({ toolName: "bash", toolInput: {} }), "tui")).toBe(false);
  });
  it("转发 ask(无 toolInput)→ false", () => {
    expect(shouldUseDiff(cfg({}), mk({ toolName: "write" }), "tui")).toBe(false);
  });
  it("非 TUI → false", () => {
    expect(shouldUseDiff(cfg({}), mk({ toolName: "write", toolInput: {} }), "rpc")).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test test/authority/diff-ask-adapter.test.ts` → FAIL: module missing。

- [ ] **Step 3: 实现 adapter**

```ts
// src/authority/diff-ask-adapter.ts
import {
  type PermissionPromptDecision,
  createDeniedPermissionDecision,
} from "#src/authority/permission-dialog";
import type {
  DecisionLayerResult,
  DiffDecisionLayer,
  DiffReviewDecision,
} from "#src/diff-view/presenter";
import type { PermissionSystemExtensionConfig } from "#src/extension-config";
import type { PromptPermissionDetails } from "./permission-prompter";

export function isDiffReviewableTool(toolName: unknown): toolName is "write" | "edit" {
  return toolName === "write" || toolName === "edit";
}

export function shouldUseDiff(
  config: PermissionSystemExtensionConfig,
  details: PromptPermissionDetails,
  mode: string,
): boolean {
  return (
    mode === "tui" &&
    isDiffReviewableTool(details.toolName) &&
    details.toolInput !== undefined &&
    (config.toolDiffPrompt ?? true)
  );
}

export function mapDiffDecision(decision: DiffReviewDecision): PermissionPromptDecision {
  switch (decision.kind) {
    case "approve":
      return { approved: true, state: "approved" };
    case "approve_for_session":
      return {
        approved: true,
        state: decision.scope === "serving_session"
          ? "approved_for_serving_session"
          : "approved_for_session",
      };
    case "deny":
      return createDeniedPermissionDecision(decision.reason);
    case "preview_unavailable":
      return createDeniedPermissionDecision();
  }
}
```

`DiffPromptDecisionLayer`(同一文件或 `diff-prompt-decision-layer.ts`):

```ts
import {
  initialPromptState,
  reducePrompt,
  type PromptEvent,
  type PromptKey,
  type PromptModelConfig,
  type PromptViewState,
} from "#src/authority/permission-prompt-decision";
import type { DiffReviewLabels } from "#src/diff-view/presenter";

const HOTKEY_TO_PROMPT_KEY: Record<string, PromptKey | undefined> = {
  y: "y",
  a: "y", // approve 别名
  s: "s",
  n: "n",
  r: "r",
};

/** 决策语义的薄包装:把 diff 内按键接进现有 reducePrompt,y/s scope/r reason 不变 */
export class DiffPromptDecisionLayer implements DiffDecisionLayer {
  private state: PromptViewState;
  private labels: DiffReviewLabels;
  private doublePressToConfirm: boolean;
  private theme = PLAIN_THEME;

  constructor(opts: {
    labels: DiffReviewLabels;
    doublePressToConfirm: boolean;
    sessionScope?: NonNullable<RequestPermissionOptions["sessionScope"]>;
  }) {
    this.labels = opts.labels;
    this.doublePressToConfirm = opts.doublePressToConfirm;
    const config: PromptModelConfig = {
      doublePressToConfirm: opts.doublePressToConfirm,
      sessionLabel: opts.labels.session,
      sessionScope: opts.sessionScope,
    };
    this.state = initialPromptState(config);
  }

  setTheme(theme: { fg(c: string, t: string): string; bg(c: string, t: string): string }): void {
    this.theme = theme;
  }

  render(width: number): string[] {
    const theme = this.theme;
    switch (this.state.step) {
      case "decision": {
        const lines = ["", ...this.renderDecisionRows(theme)];
        if (this.state.hint) lines.push(theme.fg("muted", this.state.hint));
        return lines;
      }
      case "reason":
        return ["", theme.fg("accent", "Reason (required):") + this.state.reasonDraft + "\u2588",
          this.state.reasonError ? theme.fg("error", this.state.reasonError) : "",
          theme.fg("muted", "enter submit · esc back")];
      case "scope":
        return ["", ...this.renderScopeRows(theme)];
    }
  }

  handleInput(data: string): DecisionLayerResult {
    // reason 步:整键进 reason 编辑器(reduceReasonStep)
    if (this.state.step === "reason") {
      const event = toReasonEvent(data);
      return this.apply(event);
    }
    // scope 步:↑↓/Enter/Esc 归决策层
    if (this.state.step === "scope") {
      if (matchesKey(data, "up")) return this.apply({ type: "nav", direction: "up" });
      if (matchesKey(data, "down")) return this.apply({ type: "nav", direction: "down" });
      if (matchesKey(data, "enter")) return this.apply({ type: "confirm" });
      if (matchesKey(data, "escape")) return this.apply({ type: "cancel" });
      return { kind: "ignored" };
    }
    // decision 步:热键 / Enter / Esc;其余(查看键)→ ignored
    const key = HOTKEY_TO_PROMPT_KEY[data];
    if (key) return this.apply({ type: "hotkey", key });
    if (matchesKey(data, "enter")) return this.apply({ type: "confirm" });
    if (matchesKey(data, "escape")) return this.apply({ type: "cancel" });
    return { kind: "ignored" };
  }

  private apply(event: PromptEvent): DecisionLayerResult {
    const outcome = reducePrompt(this.configFor(), this.state, event);
    if (outcome.kind === "decision") {
      return { kind: "decision", decision: toDiffDecision(outcome.decision) };
    }
    this.state = outcome.state;
    return { kind: "consumed" };
  }
}

export function toDiffDecision(
  decision: PermissionPromptDecision,
): DiffReviewDecision {
  if (decision.approved) {
    if (decision.state === "approved_for_serving_session") {
      return { kind: "approve_for_session", scope: "serving_session" };
    }
    if (decision.state === "approved_for_session") {
      return { kind: "approve_for_session", scope: "subagent_only" };
    }
    return { kind: "approve" };
  }
  return decision.denialReason !== undefined
    ? { kind: "deny", reason: decision.denialReason }
    : { kind: "deny" };
}
```

> **行模板锚点:** `renderDecisionRows` / `renderScopeRows` 复用 `permission-prompt-component.ts` 中 `renderDecision`/`renderScope` 的格式化(高亮 `▶`,字母带 `(y)` 前缀,hint 措辞),**去掉 title/message 两行**(标题与摘要已由 viewer 区提供)。`toReasonEvent(data)` = 现有 `handleReasonInput` 的映射(enter→submit、escape→cancel、backspace→backspace、可打印→append)——`reducePrompt` 的 reason 步由 `reduceReasonStep` 与 `submitReason` 驱动,提交时 `normalizePermissionDenialReason` 校验空值。

- [ ] **Step 4: 接入 LocalUserAuthorizer(渲染 + 回退)**

`src/authority/local-user-authorizer.ts` 变更:

```ts
export interface LocalUserAuthorizerDeps {
  ui: PermissionPromptUi;
  mode: ExtensionContext["mode"];
  cwd: string;
  events: PermissionEventBus;
  getPromptPreferences: () => PromptPreferences;
  getConfig: () => PermissionSystemExtensionConfig;
  requestPermissionDecision: typeof requestPermissionDecision;
}
```

`authorize` 中,在 `emitUiPromptEvent(…)` 之后、现有 `requestPermissionDecision` 之前插入:

```ts
if (shouldUseDiff(this.deps.getConfig(), details, this.deps.mode)) {
  return this.presentDiff(details);
}
```

新增私有方法(顶部复用 `authorize` 已有的别处常量/类型):

```ts
const PROMPT_OVERLAY_OPTIONS = { anchor: "bottom-center", width: "100%" } as const; // 复用或移到共享

private async presentDiff(details: PromptPermissionDetails): Promise<PermissionPromptDecision> {
  const config = this.deps.getConfig();
  const defaultView = config.toolDiffDefaultView ?? "unified";
  const labels: DiffReviewLabels = {
    approve: "Yes",
    session: details.sessionLabel ?? "Yes, for this session",
    deny: "No",
    denyReason: "No, provide reason",
  };
  const decisionLayer = new DiffPromptDecisionLayer({
    labels,
    doublePressToConfirm: this.deps.getPromptPreferences().doublePressToConfirm,
    sessionScope: buildRequestOptions(details)?.sessionScope,
  });
  const input: DiffReviewInput = {
    toolName: details.toolName as "write" | "edit",
    input: details.toolInput,
    cwd: this.deps.cwd,
    labels,
    defaultView,
    decisionLayer,
  };
  const decision = await presentDiffReview(
    (build) =>
      this.deps.ui.custom<DiffReviewDecision>(
        (tui, theme, _kb, done) =>
          frameWithPanel(build(tui, theme, done), theme, "accent"),
        { overlay: true, overlayOptions: PROMPT_OVERLAY_OPTIONS },
      ),
    input,
  );
  if (decision.kind === "preview_unavailable") {
    return this.deps.requestPermissionDecision(
      { mode: this.deps.mode, ui: this.deps.ui, doublePressToConfirm: false },
      details.forwarding ? "Permission Required (Subagent)" : "Permission Required",
      buildUiPrompt(details),
      buildRequestOptions(details),
    );
  }
  return mapDiffDecision(decision);
}
```

> **接线契约(必读):** `this.deps.ui.custom<T>(factory, options)` 与现有 `requestPermissionDecision` 的 TUI 分支同一底层(T7 的 `PermissionPromptUi` 含 `custom`);factory 签名 `(tui, theme, _kb, done)`,其中 `done` 就是 resolve 为泛型 `T` 的回调,故此处 `custom<DiffReviewDecision>` 直接产出 diff 决策 Promise。`frameWithPanel(component, theme, colorName)` 以现有 `PanelFrame`(`src/ui/panel-frame.ts`,`borderColor: (t) => theme.fg(colorName, t)`,accent)包裹裸 `DiffAskComponent`,镜像现有 prompt 的 framing。`PROMPT_OVERLAY_OPTIONS = { anchor: "bottom-center", width: "100%" }`(与 `permission-prompt-component.ts` 同款)。preview 失败时走上文回退。
> 约束:`frameWithPanel` 作 `diff-ask-adapter.ts` 私有辅助;`PanelFrame` 只存在于 authority 侧,`diff-view` 保持不依赖任何 `#src/*`。`PLAIN_THEME` = `{ fg: (_c,t)=>t, bg: (_c,t)=>t }`(单元测试友好,默认无 ANSI)。

- [ ] **Step 5: 运行确认通过**

Run: `pnpm test test/authority/diff-ask-adapter.test.ts test/authority/local-user-authorizer.test.ts test/authority/permission-prompt-component.test.ts && pnpm run check`
Expected: PASS + tsc 0 错误。

- [ ] **Step 6: 提交**

```bash
git add src/authority/diff-ask-adapter.ts src/authority/local-user-authorizer.ts test/authority/diff-ask-adapter.test.ts test/authority/local-user-authorizer.test.ts
git commit -m "feat(pi-permission-system): DiffAskAdapter 接入本地 write/edit ask,决策复用 reducePrompt"
```

---

### Task 9:回归、文档、收尾验证

**Files:**
- Modify: `README.md`

**Interfaces:** 无新接口。

- [ ] **Step 1: README 补表述**

在 ask 行为相关小节补一小段:write/edit 的 ask 默认以交互 diff 视图呈现(unified 默认、Tab 切换、`toolDiffPrompt`/`toolDiffDefaultView` 可配;关闭即回退文本)。

- [ ] **Step 2: 全量验证**

Run:
```bash
pnpm run check
pnpm run lint
pnpm test
```
Expected: 全绿;`lint:md` 通过(rumdl)。

- [ ] **Step 3: 手动冒烟(可选,需 TUI)**

真实 Pi TUI:令 `write`/`edit` 为 `ask` → 触发 → 弹 diff 视图;`Tab` 切 split/unified、`j/k`/`↑↓` 滚动、`n/p` 换 hunk、`y`/`a`/`Enter` 批准、`s` 会话(转发时 scope)、`Esc` 拒绝、`r` 带理由拒绝;`toolDiffPrompt=false` 后回退文本。

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs(pi-permission-system): 文档化 write/edit ask 的交互 diff 视图"
```

---

## Self-Review

- **Spec coverage:** §3 架构 → T1-T5/T8;§4 接口 → T4/T5;§5 键位 → T4(查看)+ T8(决策),**n 键冲突已按 Global Constraints 修正(Esc 拒绝,n 归 hunk)**;§6 数据流 → T7/T8;§8 配置 → T6;§7 M1/M2 → M1 本计划、M2 范围外;§9 回退 → T8 `shouldUseDiff` 决定是否走 diff;preview 失败在 diff 视图内嵌警告呈现(用户裁决 A,`preview_unavailable` 仅防御);§10 测试 → 各 Task;§11 文档 → T6/T9。
- **Placeholder scan:** Task 5/8 的"接线契约/行模板锚点"均为指向既有代码(`permission-prompt-component.ts`/`presentInlinePermissionPrompt`)的明确指令,非 TBD;Task 8 的 UI 接线已定实为 `this.deps.ui.custom<DiffReviewDecision>(…)`,无"二选一"遗留。
- **Type consistency:** `DiffReviewDecision`(approve/approve_for_session/deny/preview_unavailable)= T5 定义、T8 映射(`toDiffDecision`/`mapDiffDecision` 双向);`DecisionLayerResult`/`DiffDecisionLayer` = T5 定义、T8 `DiffPromptDecisionLayer` 实现;`toolInput?: unknown` = T7 定义、T8 消费;`toolDiffPrompt`/`toolDiffDefaultView` = T6 定义、T8 读取(`?? true`/`?? "unified"` 与改准 Input 一致);`DiffViewer.viewMode()` = T4 产物、T4 测试消费;`shouldUseDiff` 三参数签名在 T8 Step1 与 Step3 完全一致。
