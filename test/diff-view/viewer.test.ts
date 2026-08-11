import { describe, expect, it, vi } from "vitest";
import { buildStructuredDiff } from "#src/diff-view/diff-utils";
import {
  DEFAULT_KEYBINDINGS,
  type DiffKeybindings,
} from "#src/diff-view/keybindings";
import type { ChangePreview } from "#src/diff-view/preview";
import { DiffViewer } from "#src/diff-view/viewer";

function makePreview(overrides: Partial<ChangePreview> = {}): ChangePreview {
  return {
    toolName: "write",
    path: "/a.txt",
    absolutePath: "/a.txt",
    diff: "-old\n+new\n",
    diffModel: buildStructuredDiff("old\n", "new\n"),
    additions: 1,
    deletions: 1,
    summaryLines: ["Create new file"],
    beforeText: "old\n",
    afterText: "new\n",
    ...overrides,
  };
}
// 真实 pi-tui Theme 必有 bold/fg/bg;渲染路径用到 theme.bold(标题/高亮加粗),
// 故夹具在此补全(简报未含 bold 属计划测试夹具缺漏,与 T1 同类修正;源码保持保真).
const theme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
};
const tui = {
  requestRender: vi.fn(),
  getShowHardwareCursor: () => true,
  setShowHardwareCursor: vi.fn(),
};

function makeViewer(
  defaultView: "split" | "unified" = "unified",
  maxHeight?: number,
) {
  return new DiffViewer(
    tui,
    theme as never,
    makePreview(),
    "default",
    true,
    DEFAULT_KEYBINDINGS,
    defaultView,
    "full",
    "/",
    maxHeight,
  );
}

describe("DiffViewer(裁剪)", () => {
  it("render 返回含 +/- 行的文本", () => {
    const text = makeViewer().render(80).join("\n");
    expect(text).toContain("-1 old");
    expect(text).toContain("+1 new");
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
  it("maxHeight 上限裁剪不要超高", () => {
    const v = makeViewer("unified", 12);
    expect(v.render(80).length).toBeLessThanOrEqual(12);
  });
  it("scrollUp/scrollDown 默认禁用:↑↓ 不滚动", () => {
    const v = makeViewer();
    expect(v.handleInput("\u001b[B")).toBe(false);
    expect(v.handleInput("\u001b[A")).toBe(false);
  });
  it("footer 只显示每个 action 的第一个键", () => {
    const kb: DiffKeybindings = {
      ...DEFAULT_KEYBINDINGS,
      scrollUp: ["up"],
      scrollDown: ["down"],
      nextHunk: ["n", "j"],
    };
    const v = new DiffViewer(
      tui,
      theme as never,
      makePreview(),
      "default",
      true,
      kb,
      "unified",
      "full",
      "/",
      undefined,
    );
    // 用宽画布断言 footer,避免窄宽度把尾部项截断。
    const text = v.render(200).join("\n");
    expect(text).toContain("↑/↓ scroll");
    expect(text).toContain("n next");
    expect(text).not.toContain("n/j");
    // 决策键(y approve / d reject)统一由决策层渲染,viewer footer 不再显示。
    expect(text).not.toContain("approve");
    expect(text).not.toContain("reject");
  });
  it("footer 显示原文大小写, 匹配严格区分大小写", () => {
    const kb: DiffKeybindings = {
      ...DEFAULT_KEYBINDINGS,
      toggleMode: ["G"],
    };
    const v = new DiffViewer(
      tui,
      theme as never,
      makePreview(),
      "default",
      true,
      kb,
      "unified",
      "full",
      "/",
      undefined,
    );
    expect(v.render(200).join("\n")).toContain("G split/unified"); // 显示原文大写
    expect(v.handleInput("G")).toBe(true); // 严格大写命中
    expect(v.viewMode()).toBe("split");
    const v2 = new DiffViewer(
      tui,
      theme as never,
      makePreview(),
      "default",
      true,
      kb,
      "unified",
      "full",
      "/",
      undefined,
    );
    expect(v2.handleInput("g")).toBe(false); // 严格:小写 g 不命中大写 G
    expect(v2.viewMode()).toBe("unified");
  });
  it("大小写严格区分: 大写 Y 切视图, 小写 y 切 wrap", () => {
    const kb: DiffKeybindings = {
      ...DEFAULT_KEYBINDINGS,
      toggleMode: ["Y"],
      toggleWrap: ["y"],
    };
    const a = new DiffViewer(
      tui,
      theme as never,
      makePreview(),
      "default",
      true,
      kb,
      "unified",
      "full",
      "/",
      undefined,
    );
    expect(a.handleInput("Y")).toBe(true); // toggleMode(大写 Y)
    expect(a.viewMode()).toBe("split");
    const b = new DiffViewer(
      tui,
      theme as never,
      makePreview(),
      "default",
      true,
      kb,
      "unified",
      "full",
      "/",
      undefined,
    );
    expect(b.handleInput("y")).toBe(true); // toggleWrap(小写 y)
    expect(b.viewMode()).toBe("unified");
  });
});
