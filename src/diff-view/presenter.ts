import type { Component } from "@earendil-works/pi-tui";
import { DiffAskComponent } from "./component.js";
import { computeChangePreview } from "./preview.js";

export type DiffToolName = "write" | "edit";

export interface DiffReviewLabels {
  approve: string;
  session: string;
  deny: string;
  denyReason: string;
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
  setTheme(theme: {
    fg(color: string, text: string): string;
    bg(color: string, text: string): string;
  }): void;
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

/** diff-view 最小 TUI 表面:真实 SDK Tui 结构上满足此接口 */
export interface DiffReviewTui {
  terminal?: { rows: number };
  requestRender(): void;
}

/** diff-view 最小主题表面:真实 SDK Theme 结构上满足此接口 */
export interface DiffReviewTheme {
  name?: string;
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  getBgAnsi(key: string): string;
}

/** authority 提供的 overlay 通道:把 build 出来的组件交给 ctx.ui.custom 等宿主渲染 */
export type DiffUiConnector = (
  build: (
    tui: DiffReviewTui,
    theme: DiffReviewTheme,
    done: (d: DiffReviewDecision) => void,
  ) => Component,
) => Promise<DiffReviewDecision>;

export async function presentDiffReview(
  show: DiffUiConnector,
  input: DiffReviewInput,
): Promise<DiffReviewDecision> {
  const preview = await computeChangePreview(
    input.toolName,
    input.input,
    input.cwd,
  );
  if (!preview) {
    return { kind: "preview_unavailable" };
  }
  return show(
    (tui, theme, done) =>
      new DiffAskComponent(tui, theme, preview, input, done),
  );
}
