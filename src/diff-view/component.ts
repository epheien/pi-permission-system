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
export class DiffAskComponent implements Component {
  private readonly viewer: DiffViewer;
  private readonly decisionLayer: DiffDecisionLayer;

  constructor(
    tui: DiffReviewTui,
    theme: DiffReviewTheme,
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
      "full",
      input.cwd,
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
      return;
    }
    this.viewer.handleInput(data);
  }
}
