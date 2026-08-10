import type { Component } from "@earendil-works/pi-tui";
import { DEFAULT_KEYBINDINGS } from "./keybindings.js";
import type {
  DecisionLayerResult,
  DiffDecisionLayer,
  DiffReviewDecision,
  DiffReviewInput,
  DiffReviewTheme,
  DiffReviewTui,
} from "./presenter.js";
import type { ChangePreview } from "./preview.js";
import { DiffViewer } from "./viewer.js";

/**
 * diff 区(viewer 查看键)+ 决策区(注入决策层)组合。裸内容,不 frame——
 * 边框由 authority 侧 adapter(Task 8)用 PanelFrame 包裹。
 *
 * 路由规则:
 * - 决策层给出 decision → 调用 done 结束本次审查;
 * - 决策层 consumed(消化了该键,渲染态变化)→ 停,不转 viewer;
 * - 决策层 ignored(不认该键)→ 交给 viewer 处理查看键。
 */
// viewer 之后组件自己插入的 1 行分隔空行。
const COMPONENT_SEPARATOR_LINES = 1;
/** authority 侧 PanelFrame 包裹本组件产生的上下边框行数。 */
const FRAME_BORDER_LINES = 2;

export class DiffAskComponent implements Component {
  private readonly viewer: DiffViewer;
  private readonly decisionLayer: DiffDecisionLayer;
  private readonly tui: DiffReviewTui;

  constructor(
    tui: DiffReviewTui,
    theme: DiffReviewTheme,
    preview: ChangePreview,
    input: DiffReviewInput,
    private readonly done: (d: DiffReviewDecision) => void,
  ) {
    this.tui = tui;
    // viewer 高度预算 = overlay 总高(终端可视行)− 决策区 − 分隔空行 − 外框。
    // overlay 用 bottom 锚定:组件总高超过终端时,合成只保留前 terminal.rows 行,
    // 决策区与 PanelFrame 下边框会被整体丢弃,必须把下方固定占用留给 viewer 之外。
    this.viewer = new DiffViewer(
      tui,
      theme,
      preview,
      "default",
      true,
      DEFAULT_KEYBINDINGS,
      input.defaultView,
      "full",
      input.cwd,
      computeViewerMaxHeight(tui, input),
    );
    this.decisionLayer = input.decisionLayer;
    input.decisionLayer.setTheme(theme);
  }

  invalidate(): void {
    this.viewer.invalidate();
  }

  render(width: number): string[] {
    return [
      ...this.viewer.render(width),
      "",
      ...this.decisionLayer.render(width),
    ];
  }

  handleInput(data: string): void {
    const result: DecisionLayerResult = this.decisionLayer.handleInput(data);
    if (result.kind === "decision") {
      this.done(result.decision);
      return;
    }
    if (result.kind === "consumed") {
      this.tui.requestRender();
      return;
    }
    this.viewer.handleInput(data);
    this.tui.requestRender();
  }
}

/**
 * viewer 输出行数上限。决策层 render 忽略宽度(决策/reason/scope 均为固定行),用
 * 任意宽度在构造期量高(此时尚未 setTheme,PLAIN_THEME 只影响配色不影响行数),
 * 取初始 decision 步的最宽布局保证各步都不会溢出 overlay。
 */
function computeViewerMaxHeight(
  tui: DiffReviewTui,
  input: DiffReviewInput,
): number {
  const rows = tui.terminal?.rows ?? 24;
  const decisionHeight = input.decisionLayer.render(1).length;
  return Math.max(
    1,
    rows - decisionHeight - COMPONENT_SEPARATOR_LINES - FRAME_BORDER_LINES,
  );
}
