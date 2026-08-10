import { describe, expect, it } from "vitest";
import {
  DiffPromptDecisionLayer,
  mapDiffDecision,
  shouldUseDiff,
  toDiffDecision,
} from "#src/authority/diff-ask-adapter";
import { createDeniedPermissionDecision } from "#src/authority/permission-dialog";
import type { PromptPermissionDetails } from "#src/authority/permission-prompter";
import type { DiffReviewLabels } from "#src/diff-view/presenter";
import type { PermissionSystemExtensionConfig } from "#src/extension-config";

function mk(
  overrides: Partial<PromptPermissionDetails> = {},
): PromptPermissionDetails {
  return {
    requestId: "r",
    source: "tool_call",
    agentName: null,
    message: "m",
    ...overrides,
  };
}

function cfg(
  overrides: Partial<PermissionSystemExtensionConfig> = {},
): PermissionSystemExtensionConfig {
  return overrides as PermissionSystemExtensionConfig;
}

const LABELS: DiffReviewLabels = {
  approve: "Yes",
  session: "Yes, for this session",
  deny: "No",
  denyReason: "No, provide reason",
};

function makeLayer(
  overrides: {
    doublePressToConfirm?: boolean;
    sessionScope?: { subagentLabel: string; servingSessionLabel: string };
  } = {},
) {
  return new DiffPromptDecisionLayer({
    labels: LABELS,
    doublePressToConfirm: overrides.doublePressToConfirm ?? false,
    sessionScope: overrides.sessionScope,
  });
}

const ESC = "\u001b";
const ENTER = "\r";
const CTRL_N = "\u000e";
const CTRL_P = "\u0010";

describe("mapDiffDecision", () => {
  it("approve → approved", () => {
    expect(mapDiffDecision({ kind: "approve" })).toEqual({
      approved: true,
      state: "approved",
    });
  });

  it("approve_for_session → approved_for_session", () => {
    expect(mapDiffDecision({ kind: "approve_for_session" })).toEqual({
      approved: true,
      state: "approved_for_session",
    });
  });

  it("approve_for_session serving → approved_for_serving_session", () => {
    expect(
      mapDiffDecision({
        kind: "approve_for_session",
        scope: "serving_session",
      }),
    ).toEqual({
      approved: true,
      state: "approved_for_serving_session",
    });
  });

  it("deny 无 reason → denied", () => {
    expect(mapDiffDecision({ kind: "deny" })).toEqual(
      createDeniedPermissionDecision(),
    );
  });

  it("deny with reason → denied_with_reason", () => {
    expect(mapDiffDecision({ kind: "deny", reason: "nope" })).toEqual(
      createDeniedPermissionDecision("nope"),
    );
  });

  it("preview_unavailable → denied(fail-closed, 防御)", () => {
    expect(mapDiffDecision({ kind: "preview_unavailable" })).toEqual(
      createDeniedPermissionDecision(),
    );
  });
});

describe("toDiffDecision", () => {
  it("approved → approve", () => {
    expect(toDiffDecision({ approved: true, state: "approved" })).toEqual({
      kind: "approve",
    });
  });

  it("approved_for_session → approve_for_session(subagent only)", () => {
    expect(
      toDiffDecision({ approved: true, state: "approved_for_session" }),
    ).toEqual({ kind: "approve_for_session", scope: "subagent_only" });
  });

  it("approved_for_serving_session → approve_for_session(serving)", () => {
    expect(
      toDiffDecision({
        approved: true,
        state: "approved_for_serving_session",
      }),
    ).toEqual({ kind: "approve_for_session", scope: "serving_session" });
  });

  it("denied → deny", () => {
    expect(toDiffDecision({ approved: false, state: "denied" })).toEqual({
      kind: "deny",
    });
  });

  it("denied_with_reason → deny(reason)", () => {
    expect(
      toDiffDecision({
        approved: false,
        state: "denied_with_reason",
        denialReason: "nope",
      }),
    ).toEqual({ kind: "deny", reason: "nope" });
  });
});

describe("shouldUseDiff", () => {
  it("write + tui + toolInput + 缺省开启 → true", () => {
    expect(
      shouldUseDiff(cfg({}), mk({ toolName: "write", toolInput: {} }), "tui"),
    ).toBe(true);
  });

  it("toolDiffPrompt=false → false", () => {
    expect(
      shouldUseDiff(
        cfg({ toolDiffPrompt: false }),
        mk({ toolName: "edit", toolInput: {} }),
        "tui",
      ),
    ).toBe(false);
  });

  it("非 write/edit → false", () => {
    expect(
      shouldUseDiff(cfg({}), mk({ toolName: "bash", toolInput: {} }), "tui"),
    ).toBe(false);
  });

  it("转发 ask(无 toolInput)→ false", () => {
    expect(shouldUseDiff(cfg({}), mk({ toolName: "write" }), "tui")).toBe(
      false,
    );
  });

  it("非 TUI → false", () => {
    expect(
      shouldUseDiff(cfg({}), mk({ toolName: "write", toolInput: {} }), "rpc"),
    ).toBe(false);
  });
});

describe("DiffPromptDecisionLayer", () => {
  it("y 批准(无 double-press)", () => {
    const layer = makeLayer();
    expect(layer.handleInput("y")).toEqual({
      kind: "decision",
      decision: { kind: "approve" },
    });
  });

  it("a 是 approve 别名", () => {
    const layer = makeLayer();
    expect(layer.handleInput("a")).toEqual({
      kind: "decision",
      decision: { kind: "approve" },
    });
  });

  it("double-press 下 y,y 批准、单次 y arm", () => {
    const layer = makeLayer({ doublePressToConfirm: true });
    expect(layer.handleInput("y")).toEqual({ kind: "consumed" });
    expect(layer.handleInput("y")).toEqual({
      kind: "decision",
      decision: { kind: "approve" },
    });
  });

  it("Esc 拒绝(无 reason)", () => {
    const layer = makeLayer();
    expect(layer.handleInput(ESC)).toEqual({
      kind: "decision",
      decision: { kind: "deny" },
    });
  });

  it("s 会话(无 scope step)", () => {
    const layer = makeLayer();
    expect(layer.handleInput("s")).toEqual({
      kind: "decision",
      decision: { kind: "approve_for_session", scope: "subagent_only" },
    });
  });

  it("s 后进 scope step 可选择 serving scope", () => {
    const layer = makeLayer({
      sessionScope: {
        subagentLabel: "This subagent only",
        servingSessionLabel: "The whole session",
      },
    });
    expect(layer.handleInput("s")).toEqual({ kind: "consumed" });
    // 默认选中 subagent scope
    expect(layer.handleInput(ENTER)).toEqual({
      kind: "decision",
      decision: { kind: "approve_for_session", scope: "subagent_only" },
    });
  });

  it("scope step 下选 serving(↓ + enter)", () => {
    const layer = makeLayer({
      sessionScope: {
        subagentLabel: "This subagent only",
        servingSessionLabel: "The whole session",
      },
    });
    layer.handleInput("s");
    layer.handleInput("\u001b[B"); // down
    expect(layer.handleInput(ENTER)).toEqual({
      kind: "decision",
      decision: { kind: "approve_for_session", scope: "serving_session" },
    });
  });

  it("r + 原因 + enter → deny_with_reason", () => {
    const layer = makeLayer();
    expect(layer.handleInput("r")).toEqual({ kind: "consumed" });
    for (const ch of ["n", "o", "p", "e"]) {
      expect(layer.handleInput(ch)).toEqual({ kind: "consumed" });
    }
    expect(layer.handleInput(ENTER)).toEqual({
      kind: "decision",
      decision: { kind: "deny", reason: "nope" },
    });
  });

  it("reason 步 Esc 回到 decision", () => {
    const layer = makeLayer();
    layer.handleInput("r");
    expect(layer.handleInput(ESC)).toEqual({ kind: "consumed" });
    // 回到 decision 后可批准
    expect(layer.handleInput("y")).toEqual({
      kind: "decision",
      decision: { kind: "approve" },
    });
  });

  it("n 不是拒绝键(交 viewer 的 hunk)→ ignored", () => {
    const layer = makeLayer();
    expect(layer.handleInput("n")).toEqual({ kind: "ignored" });
  });

  it("j/k 等查看键 → ignored", () => {
    const layer = makeLayer();
    for (const key of ["j", "k", "\t", "w"]) {
      expect(layer.handleInput(key)).toEqual({ kind: "ignored" });
    }
  });

  it("↑↓ 在 decision 步 → ignored(交 viewer 滚动)", () => {
    const layer = makeLayer();
    expect(layer.handleInput("\u001b[B")).toEqual({ kind: "ignored" });
    expect(layer.handleInput("\u001b[A")).toEqual({ kind: "ignored" });
  });

  it("render 输出四选项行与提示", () => {
    const layer = makeLayer();
    const rows = layer.render(80).join("\n");
    expect(rows).toContain("(y) Yes");
    expect(rows).toContain("(s) Yes, for this session");
    expect(rows).toContain("(esc) No");
    expect(rows).toContain("(r) No, provide reason");
    expect(rows).toContain("esc deny");
  });

  it("ctrl+n/ctrl+p 在 decision 步已被替换为 viewer 查看(不导航选项)→ ignored", () => {
    const layer = makeLayer();
    expect(layer.handleInput(CTRL_N)).toEqual({ kind: "ignored" });
    expect(layer.handleInput(CTRL_P)).toEqual({ kind: "ignored" });
  });
});
