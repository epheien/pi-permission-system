import { describe, expect, it } from "vitest";
import {
  firstOptionKeys,
  initialPromptState,
  type PromptModelConfig,
  reducePrompt,
} from "#src/authority/permission-prompt-decision";
import {
  keyLabel,
  matchCancel,
  matchConfirm,
  matchDecisionHotkey,
  matchNavDown,
  matchNavUp,
} from "#src/authority/prompt-key-matcher";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(
  overrides: Partial<PromptModelConfig> = {},
): PromptModelConfig {
  return {
    doublePressToConfirm: true,
    sessionLabel: "Yes, for this session",
    optionKeys: { y: "y", s: "s", n: "n", r: "r" },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("reducePrompt", () => {
  describe("initial state", () => {
    it("starts on the decision step highlighting approve with nothing armed", () => {
      const state = initialPromptState(makeConfig());
      expect(state).toEqual({
        step: "decision",
        highlightedKey: "y",
        armedKey: undefined,
        hint: "",
        reasonDraft: "",
        reasonError: undefined,
        scopeServing: false,
      });
    });
  });

  describe("arming hint uses the option's first key", () => {
    it("shows the configured first key instead of the raw PromptKey letter", () => {
      const config = makeConfig({
        optionKeys: { y: "a", s: "s", n: "d", r: "r" },
      });
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "y",
      });
      expect(outcome.kind).toBe("render");
      if (outcome.kind !== "render") throw new Error("expected render");
      expect(outcome.state.hint).toBe("Press a again to approve.");
    });
  });

  describe("double-press to confirm (enabled)", () => {
    it("arms the option on the first hotkey press without deciding", () => {
      const config = makeConfig();
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "y",
      });
      expect(outcome).toEqual({
        kind: "render",
        state: {
          step: "decision",
          highlightedKey: "y",
          armedKey: "y",
          hint: "Press y again to approve.",
          reasonDraft: "",
          reasonError: undefined,
          scopeServing: false,
        },
      });
    });

    it("commits the decision on the confirming second press of the same key", () => {
      const config = makeConfig();
      const armed = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "y",
      });
      if (armed.kind !== "render") throw new Error("expected render");
      const outcome = reducePrompt(config, armed.state, {
        type: "hotkey",
        key: "y",
      });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: true, state: "approved" },
      });
    });

    it("re-arms when a different hotkey is pressed", () => {
      const config = makeConfig();
      const armedY = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "y",
      });
      if (armedY.kind !== "render") throw new Error("expected render");
      const armedN = reducePrompt(config, armedY.state, {
        type: "hotkey",
        key: "n",
      });
      expect(armedN).toEqual({
        kind: "render",
        state: {
          step: "decision",
          highlightedKey: "n",
          armedKey: "n",
          hint: "Press n again to deny.",
          reasonDraft: "",
          reasonError: undefined,
          scopeServing: false,
        },
      });
    });

    it("commits deny on the second press of n", () => {
      const config = makeConfig();
      const armed = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "n",
      });
      if (armed.kind !== "render") throw new Error("expected render");
      const outcome = reducePrompt(config, armed.state, {
        type: "hotkey",
        key: "n",
      });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: false, state: "denied" },
      });
    });
  });

  describe("double-press to confirm (disabled)", () => {
    it("commits immediately on the first hotkey press", () => {
      const config = makeConfig({ doublePressToConfirm: false });
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "y",
      });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: true, state: "approved" },
      });
    });
  });

  describe("navigation and enter", () => {
    it("moves the highlight and clears any armed key without deciding", () => {
      const config = makeConfig();
      const armed = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "y",
      });
      if (armed.kind !== "render") throw new Error("expected render");
      const outcome = reducePrompt(config, armed.state, {
        type: "nav",
        direction: "down",
      });
      expect(outcome).toEqual({
        kind: "render",
        state: {
          step: "decision",
          highlightedKey: "s",
          armedKey: undefined,
          hint: "",
          reasonDraft: "",
          reasonError: undefined,
          scopeServing: false,
        },
      });
    });

    it("wraps the highlight from the last option back to the first", () => {
      const config = makeConfig();
      let state = initialPromptState(config);
      for (const _ of [0, 1, 2, 3]) {
        const outcome = reducePrompt(config, state, {
          type: "nav",
          direction: "up",
        });
        if (outcome.kind !== "render") throw new Error("expected render");
        state = outcome.state;
      }
      // up from y wraps to r, then walks r→n→s→y over four presses
      expect(state.highlightedKey).toBe("y");
    });

    it("confirms the highlighted option in a single enter press even when double-press is enabled", () => {
      const config = makeConfig();
      const down = reducePrompt(config, initialPromptState(config), {
        type: "nav",
        direction: "down",
      });
      if (down.kind !== "render") throw new Error("expected render");
      // highlight is now s; move once more to n
      const down2 = reducePrompt(config, down.state, {
        type: "nav",
        direction: "down",
      });
      if (down2.kind !== "render") throw new Error("expected render");
      const outcome = reducePrompt(config, down2.state, { type: "confirm" });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: false, state: "denied" },
      });
    });
  });

  describe("escape", () => {
    it("denies from the decision step", () => {
      const config = makeConfig();
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "cancel",
      });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: false, state: "denied" },
      });
    });
  });

  describe("deny with reason", () => {
    it("opens the reason step on confirming r (double-press enabled)", () => {
      const config = makeConfig();
      const armed = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "r",
      });
      if (armed.kind !== "render") throw new Error("expected render");
      const outcome = reducePrompt(config, armed.state, {
        type: "hotkey",
        key: "r",
      });
      expect(outcome).toEqual({
        kind: "render",
        state: {
          step: "reason",
          highlightedKey: "r",
          armedKey: undefined,
          hint: "",
          reasonDraft: "",
          reasonError: undefined,
          scopeServing: false,
        },
      });
    });

    it("opens the reason step immediately when double-press is disabled", () => {
      const config = makeConfig({ doublePressToConfirm: false });
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "r",
      });
      expect(outcome.kind).toBe("render");
      if (outcome.kind !== "render") throw new Error("expected render");
      expect(outcome.state.step).toBe("reason");
    });

    it("rejects an empty reason and keeps the reason step open", () => {
      const config = makeConfig({ doublePressToConfirm: false });
      const opened = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "r",
      });
      if (opened.kind !== "render") throw new Error("expected render");
      const outcome = reducePrompt(config, opened.state, {
        type: "submitReason",
        draft: "   ",
      });
      expect(outcome).toEqual({
        kind: "render",
        state: {
          step: "reason",
          highlightedKey: "r",
          armedKey: undefined,
          hint: "",
          reasonDraft: "   ",
          reasonError: "A reason is required.",
          scopeServing: false,
        },
      });
    });

    it("commits a denied_with_reason decision for a non-empty reason", () => {
      const config = makeConfig({ doublePressToConfirm: false });
      const opened = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "r",
      });
      if (opened.kind !== "render") throw new Error("expected render");
      const outcome = reducePrompt(config, opened.state, {
        type: "submitReason",
        draft: "  not now  ",
      });
      expect(outcome).toEqual({
        kind: "decision",
        decision: {
          approved: false,
          state: "denied_with_reason",
          denialReason: "not now",
        },
      });
    });

    it("navigates back to the decision step on escape from the reason step", () => {
      const config = makeConfig({ doublePressToConfirm: false });
      const opened = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "r",
      });
      if (opened.kind !== "render") throw new Error("expected render");
      const outcome = reducePrompt(config, opened.state, { type: "cancel" });
      expect(outcome).toEqual({
        kind: "render",
        state: {
          step: "decision",
          highlightedKey: "r",
          armedKey: undefined,
          hint: "",
          reasonDraft: "",
          reasonError: undefined,
          scopeServing: false,
        },
      });
    });
  });

  describe("approve-for-session scope (forwarded asks)", () => {
    const sessionScope = {
      subagentLabel: "This subagent only",
      servingSessionLabel: "The whole session",
    };

    it("opens the scope step when s is confirmed and a sessionScope is offered", () => {
      const config = makeConfig({ doublePressToConfirm: false, sessionScope });
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "s",
      });
      expect(outcome.kind).toBe("render");
      if (outcome.kind !== "render") throw new Error("expected render");
      expect(outcome.state.step).toBe("scope");
      expect(outcome.state.scopeServing).toBe(false);
    });

    it("commits the least-privilege subagent scope by default", () => {
      const config = makeConfig({ doublePressToConfirm: false, sessionScope });
      const opened = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "s",
      });
      if (opened.kind !== "render") throw new Error("expected render");
      const outcome = reducePrompt(config, opened.state, { type: "confirm" });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: true, state: "approved_for_session" },
      });
    });

    it("commits the serving-session scope when the second option is chosen", () => {
      const config = makeConfig({ doublePressToConfirm: false, sessionScope });
      const opened = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "s",
      });
      if (opened.kind !== "render") throw new Error("expected render");
      const moved = reducePrompt(config, opened.state, {
        type: "nav",
        direction: "down",
      });
      if (moved.kind !== "render") throw new Error("expected render");
      expect(moved.state.scopeServing).toBe(true);
      const outcome = reducePrompt(config, moved.state, { type: "confirm" });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: true, state: "approved_for_serving_session" },
      });
    });

    it("navigates back to the decision step on escape from the scope step", () => {
      const config = makeConfig({ doublePressToConfirm: false, sessionScope });
      const opened = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "s",
      });
      if (opened.kind !== "render") throw new Error("expected render");
      const outcome = reducePrompt(config, opened.state, { type: "cancel" });
      expect(outcome.kind).toBe("render");
      if (outcome.kind !== "render") throw new Error("expected render");
      expect(outcome.state.step).toBe("decision");
    });

    it("commits approved_for_session directly when no sessionScope is offered", () => {
      const config = makeConfig({ doublePressToConfirm: false });
      const outcome = reducePrompt(config, initialPromptState(config), {
        type: "hotkey",
        key: "s",
      });
      expect(outcome).toEqual({
        kind: "decision",
        decision: { approved: true, state: "approved_for_session" },
      });
    });
  });
});

describe("firstOptionKeys", () => {
  it("takes the first key of each decision action", () => {
    expect(
      firstOptionKeys({
        approve: ["y", "a"],
        approveSession: ["s"],
        deny: ["d"],
        denyWithReason: ["r"],
      } as never),
    ).toEqual({ y: "y", s: "s", n: "d", r: "r" });
  });

  it("falls back to the PromptKey letter when an action is disabled (empty array)", () => {
    expect(
      firstOptionKeys({
        approve: [],
        approveSession: [],
        deny: [],
        denyWithReason: [],
      } as never),
    ).toEqual({ y: "y", s: "s", n: "n", r: "r" });
  });
});

describe("prompt-key-matcher", () => {
  const KB = {
    approve: ["y", "a"],
    approveSession: ["s"],
    deny: ["d"],
    denyWithReason: ["r"],
    confirm: ["enter"],
    cancel: ["escape"],
    navUp: ["up", "k"],
    navDown: ["down", "j"],
  };

  it("matchDecisionHotkey 按 approve→approveSession→deny→denyWithReason 顺序", () => {
    expect(matchDecisionHotkey(KB, "a")).toBe("y");
    expect(matchDecisionHotkey(KB, "y")).toBe("y");
    expect(matchDecisionHotkey(KB, "s")).toBe("s");
    expect(matchDecisionHotkey(KB, "d")).toBe("n");
    expect(matchDecisionHotkey(KB, "r")).toBe("r");
    expect(matchDecisionHotkey(KB, "q")).toBeUndefined();
  });

  it("nav/confirm/cancel 命中与未命中", () => {
    // pi handleInput 的原始数据:箭头是转义序列,字母/控制键是字面量。
    expect(matchNavUp(KB, "k")).toBe(true);
    expect(matchNavUp(KB, "\u001b[A")).toBe(true);
    expect(matchNavDown(KB, "j")).toBe(true);
    expect(matchNavDown(KB, "\u001b[B")).toBe(true);
    expect(matchConfirm(KB, "\r")).toBe(true);
    expect(matchCancel(KB, "\u001b")).toBe(true);
    expect(matchNavUp(KB, "x")).toBe(false);
    expect(matchConfirm(KB, "x")).toBe(false);
  });

  it("keyLabel 只做符号映射, 字母保留原文大小写", () => {
    expect(keyLabel("G")).toBe("G");
    expect(keyLabel("g")).toBe("g");
    expect(keyLabel("ctrl+alt+y")).toBe("ctrl+alt+y");
    expect(keyLabel("up")).toBe("↑");
  });

  it("单字母键严格区分大小写", () => {
    const KB_G = { ...KB, approve: ["G"] };
    expect(matchDecisionHotkey(KB_G, "G")).toBe("y");
    expect(matchDecisionHotkey(KB_G, "g")).toBeUndefined(); // 严格:小写 g ≠ 大写 G
    const KB_lower = { ...KB, deny: ["d"] };
    expect(matchDecisionHotkey(KB_lower, "d")).toBe("n");
    expect(matchDecisionHotkey(KB_lower, "D")).toBeUndefined(); // 严格:大写 D ≠ 小写 d
  });

  it("大写 Y 命中 approveSession, 小写 y 命中 approve(互不吞)", () => {
    const KB_CASE = {
      approve: ["y"],
      approveSession: ["Y", "s"],
      deny: ["d"],
      denyWithReason: ["r"],
      confirm: ["enter"],
      cancel: ["escape"],
      navUp: ["up", "k"],
      navDown: ["down", "j"],
    };
    expect(matchDecisionHotkey(KB_CASE, "Y")).toBe("s");
    expect(matchDecisionHotkey(KB_CASE, "y")).toBe("y");
    expect(matchDecisionHotkey(KB_CASE, "S")).toBeUndefined(); // 严格:大写 S ≠ 小写 s
  });
});
