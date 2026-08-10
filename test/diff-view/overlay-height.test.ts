import { describe, expect, it, vi } from "vitest";
import { DiffPromptDecisionLayer } from "#src/authority/diff-ask-adapter";
import { DiffAskComponent } from "#src/diff-view/component";
import { buildStructuredDiff } from "#src/diff-view/diff-utils";
import type {
  DiffReviewInput,
  DiffReviewLabels,
} from "#src/diff-view/presenter";
import type { ChangePreview } from "#src/diff-view/preview";
import { PanelFrame } from "#src/ui/panel-frame";

const theme = {
  name: "test",
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  getBgAnsi: (_k: string) => "",
};

const labels: DiffReviewLabels = {
  approve: "Yes",
  session: "Yes, for this session",
  deny: "No",
  denyReason: "No, provide reason",
};

function makePreview(lines = 2): ChangePreview {
  const oldLines = Array.from(
    { length: lines },
    (_, i) => `old line ${i}`,
  ).join("\n");
  const newLines = Array.from(
    { length: lines },
    (_, i) => `new line ${i}`,
  ).join("\n");
  return {
    toolName: "write",
    path: "/a.txt",
    absolutePath: "/a.txt",
    diff: `-${lines} old line 0\n+${lines} new line 0\n`,
    diffModel: buildStructuredDiff(`${oldLines}\n`, `${newLines}\n`),
    additions: lines,
    deletions: lines,
    summaryLines: ["Create new file"],
    beforeText: `${oldLines}\n`,
    afterText: `${newLines}\n`,
  };
}

function makeFramedOverlay(
  rows: number,
  diffLines = 2,
  defaultView: "split" | "unified" = "unified",
) {
  const tui = { terminal: { rows }, requestRender: vi.fn() };
  const done = vi.fn();
  const decisionLayer = new DiffPromptDecisionLayer({
    labels,
    doublePressToConfirm: false,
  });
  const input: DiffReviewInput = {
    toolName: "write",
    input: { path: "/a.txt", content: "new\n" },
    cwd: "/",
    labels,
    defaultView,
    decisionLayer,
  };
  const inner = new DiffAskComponent(
    tui as never,
    theme as never,
    makePreview(diffLines),
    input,
    done,
  );
  return {
    tui,
    lines: new PanelFrame(inner, (t) => t).render(80),
  };
}

describe("diff overlay 高度(回归:下边框被裁)", () => {
  it.each([
    24, 44, 60,
  ])("unified 加边框后整体不超高 %i 行终端,下边框为 └ 行", (rows) => {
    const { lines } = makeFramedOverlay(rows);
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(lines[lines.length - 1]).toContain("└");
  });
  it.each([
    24, 44, 60,
  ])("split 加边框后整体不超高 %i 行终端,下边框为 └ 行", (rows) => {
    const { lines } = makeFramedOverlay(rows, 2, "split");
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(lines[lines.length - 1]).toContain("└");
  });
  it("长 diff 大终端同样不超高", () => {
    const { lines } = makeFramedOverlay(44, 400);
    expect(lines.length).toBeLessThanOrEqual(44);
    expect(lines[lines.length - 1]).toContain("└");
  });
  // 审查实测:旧实现 Math.max(4,…) 视口下限在极矮终端仍溢出(unified 18 行→20、
  // split 20 行→22)。显式预算下严格吃满剩余行。物理地板:viewer 最小输出 =
  // chrome+1(上下指示行必在),故 split≥19 行、unified≥17 行才可能不超高。
  it.each([17, 18, 20, 22])("极矮终端 unified %i 行也不超高", (rows) => {
    const { lines } = makeFramedOverlay(rows);
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(lines[lines.length - 1]).toContain("└");
  });
  it.each([19, 20, 22, 24])("极矮终端 split %i 行也不超高", (rows) => {
    const { lines } = makeFramedOverlay(rows, 2, "split");
    expect(lines.length).toBeLessThanOrEqual(rows);
    expect(lines[lines.length - 1]).toContain("└");
  });
});
