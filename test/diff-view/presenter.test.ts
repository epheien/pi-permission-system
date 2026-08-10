import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DiffDecisionLayer,
  type DiffReviewDecision,
  type DiffReviewInput,
  presentDiffReview,
} from "#src/diff-view/presenter";

// 最小主题/tui 形状,满足 diff-view 的 DiffReviewTheme/DiffReviewTui 结构(经 as never 传入)
const theme = {
  fg: (_c: string, t: string) => t,
  bg: (_c: string, t: string) => t,
  bold: (t: string) => t,
  getBgAnsi: (_k: string) => "",
};
const tui = { requestRender: vi.fn() };

function makeInput(overrides: Partial<DiffReviewInput> = {}): DiffReviewInput {
  const decisionLayer: DiffDecisionLayer = {
    render: () => ["(y) yes · (n) no"],
    setTheme: vi.fn(),
    handleInput: vi.fn(
      (d: string): import("#src/diff-view/presenter").DecisionLayerResult =>
        d === "y"
          ? { kind: "decision", decision: { kind: "approve" } }
          : { kind: "ignored" },
    ),
  };
  return {
    toolName: "write",
    input: { path: "/tmp/default-x.txt", content: "new\n" },
    cwd: "/",
    labels: {
      approve: "Yes",
      session: "Session",
      deny: "No",
      denyReason: "No + reason",
    },
    defaultView: "unified",
    decisionLayer,
    ...overrides,
  };
}

describe("presentDiffReview", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "diff-view-presenter-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("组装组件:渲染 diff 行 + 决策行,决策键返回审批", async () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "old\n");

    let component:
      | {
          render(w: number): string[];
          invalidate(): void;
          handleInput(data: string): void;
        }
      | undefined;
    let onBuilt!: () => void;
    const built = new Promise<void>((resolve) => {
      onBuilt = resolve;
    });
    const show = vi.fn(
      (
        build: Parameters<
          import("#src/diff-view/presenter").DiffUiConnector
        >[0],
      ) => {
        onBuilt();
        return new Promise<DiffReviewDecision>((resolve) => {
          component = build(tui, theme, resolve) as unknown as {
            render(w: number): string[];
            invalidate(): void;
            handleInput(data: string): void;
          };
        });
      },
    );

    const promise = presentDiffReview(
      show,
      makeInput({ input: { path: p, content: "new\n" } }),
    );
    // presentDiffReview 先 await computeChangePreview(异步读文件),再调 show；等 show 被调用再读组件
    await built;
    if (!component) {
      throw new Error("component not built");
    }

    // viewer 的 diff 行带 ANSI 着色与 rail 标/-行号,剥色后形如 "-1 old"/"+1 new"
    const ESC = String.fromCharCode(27);
    const stripAnsi = (s: string) =>
      s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
    const text = stripAnsi(component.render(80).join("\n"));
    expect(text).toContain("-1 old");
    expect(text).toContain("+1 new");
    expect(text).toContain("(y) yes");

    component.handleInput("y");
    expect(await promise).toEqual({ kind: "approve" });
  });

  it("preview 计算返回 null 时不触 UI,返回 preview_unavailable", async () => {
    const show = vi.fn();
    // 非 write/edit 工具名让 computeChangePreview 返回 null(该函数仅对 write/edit 有预览)
    const decision = await presentDiffReview(
      show as never,
      makeInput({ toolName: "bash" as never }),
    );
    expect(show).not.toHaveBeenCalled();
    expect(decision).toEqual({ kind: "preview_unavailable" });
  });
});
