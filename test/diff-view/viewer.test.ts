import { describe, expect, it, vi } from "vitest";
import { buildStructuredDiff } from "#src/diff-view/diff-utils";
import { DEFAULT_KEYBINDINGS } from "#src/diff-view/keybindings";
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
});
