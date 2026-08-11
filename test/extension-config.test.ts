import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import { DEFAULT_KEYBINDINGS as DEFAULT_VIEW_KEYBINDINGS } from "#src/diff-view/keybindings";
import {
  DEFAULT_KEYBINDINGS,
  detectMisplacedPermissionKeys,
  ensurePermissionSystemLogsDirectory,
  isYoloModeEnabled,
  normalizeKeybindings,
  normalizePermissionSystemConfig,
  type PermissionSystemExtensionConfig,
} from "#src/extension-config";

function makeConfig(
  yoloMode: boolean | undefined,
): PermissionSystemExtensionConfig {
  return { yoloMode } as PermissionSystemExtensionConfig;
}

describe("detectMisplacedPermissionKeys", () => {
  it("returns an empty array for a record with only valid extension keys", () => {
    const result = detectMisplacedPermissionKeys({
      debugLog: true,
      permissionReviewLog: true,
      yoloMode: false,
    });
    expect(result).toEqual([]);
  });

  it("returns an empty array for an empty record", () => {
    const result = detectMisplacedPermissionKeys({});
    expect(result).toEqual([]);
  });

  it("returns misplaced key names when legacy permission-rule keys are present", () => {
    const result = detectMisplacedPermissionKeys({
      debugLog: true,
      defaultPolicy: { tools: "ask" },
      bash: { "git status": "allow" },
    });
    expect(result).toEqual(["defaultPolicy", "bash"]);
  });

  it("detects all known legacy permission-rule keys", () => {
    const result = detectMisplacedPermissionKeys({
      defaultPolicy: {},
      tools: {},
      bash: {},
      mcp: {},
      skills: {},
      special: {},
      external_directory: {},
    });
    expect(result).toEqual([
      "defaultPolicy",
      "tools",
      "bash",
      "mcp",
      "skills",
      "special",
      "external_directory",
    ]);
  });

  it("does not detect doom_loop as a misplaced permission key", () => {
    const result = detectMisplacedPermissionKeys({
      doom_loop: {},
    });
    expect(result).toEqual([]);
  });

  it("does not flag the new flat-format permission key as misplaced", () => {
    const result = detectMisplacedPermissionKeys({
      debugLog: false,
      permission: { "*": "ask" },
    });
    expect(result).toEqual([]);
  });

  it("ignores unknown keys that are not permission-rule keys", () => {
    const result = detectMisplacedPermissionKeys({
      debugLog: true,
      someRandomKey: "value",
    });
    expect(result).toEqual([]);
  });
});

describe("normalizePermissionSystemConfig", () => {
  it("normalizes a valid config object", () => {
    const result = normalizePermissionSystemConfig({
      debugLog: true,
      permissionReviewLog: false,
      yoloMode: true,
    });
    expect(result).toEqual({
      debugLog: true,
      permissionReviewLog: false,
      yoloMode: true,
      doublePressToConfirm: true,
      keybindings: DEFAULT_KEYBINDINGS,
    });
  });

  it("always carries a full merged keybindings", () => {
    const result = normalizePermissionSystemConfig({});
    expect(result.keybindings).toEqual(DEFAULT_KEYBINDINGS);
  });

  it("defaults debugLog to false when missing", () => {
    const result = normalizePermissionSystemConfig({});
    expect(result.debugLog).toBe(false);
  });

  it("defaults permissionReviewLog to true when missing", () => {
    const result = normalizePermissionSystemConfig({});
    expect(result.permissionReviewLog).toBe(true);
  });

  it("defaults yoloMode to false when missing", () => {
    const result = normalizePermissionSystemConfig({});
    expect(result.yoloMode).toBe(false);
  });

  it("defaults doublePressToConfirm to true when missing", () => {
    const result = normalizePermissionSystemConfig({});
    expect(result.doublePressToConfirm).toBe(true);
  });

  it("sets doublePressToConfirm false when explicitly disabled", () => {
    const result = normalizePermissionSystemConfig({
      doublePressToConfirm: false,
    });
    expect(result.doublePressToConfirm).toBe(false);
  });

  it("includes toolInputPreviewMaxLength when a valid positive integer is provided", () => {
    const result = normalizePermissionSystemConfig({
      toolInputPreviewMaxLength: 400,
    });
    expect(result.toolInputPreviewMaxLength).toBe(400);
  });

  it("omits toolInputPreviewMaxLength when absent", () => {
    const result = normalizePermissionSystemConfig({});
    expect("toolInputPreviewMaxLength" in result).toBe(false);
  });

  it("includes toolTextSummaryMaxLength when a valid positive integer is provided", () => {
    const result = normalizePermissionSystemConfig({
      toolTextSummaryMaxLength: 120,
    });
    expect(result.toolTextSummaryMaxLength).toBe(120);
  });

  it("omits toolTextSummaryMaxLength when absent", () => {
    const result = normalizePermissionSystemConfig({});
    expect("toolTextSummaryMaxLength" in result).toBe(false);
  });

  it("includes shellTools when provided", () => {
    const result = normalizePermissionSystemConfig({
      shellTools: {
        exec_command: { commandArgument: "cmd", workdirArgument: "workdir" },
      },
    });
    expect(result.shellTools).toEqual({
      exec_command: { commandArgument: "cmd", workdirArgument: "workdir" },
    });
  });

  it("omits shellTools when absent", () => {
    const result = normalizePermissionSystemConfig({});
    expect("shellTools" in result).toBe(false);
  });

  it("includes authorizerChain when provided", () => {
    const result = normalizePermissionSystemConfig({
      authorizerChain: ["model-judge", "typo-reviewer"],
    });
    expect(result.authorizerChain).toEqual(["model-judge", "typo-reviewer"]);
  });

  it("omits authorizerChain when absent", () => {
    const result = normalizePermissionSystemConfig({});
    expect("authorizerChain" in result).toBe(false);
  });
});

describe("toolDiffPrompt config", () => {
  it("carries toolDiffPrompt when provided", () => {
    expect(
      normalizePermissionSystemConfig({ toolDiffPrompt: false }).toolDiffPrompt,
    ).toBe(false);
  });
  it("omits toolDiffPrompt when absent", () => {
    expect("toolDiffPrompt" in normalizePermissionSystemConfig({})).toBe(false);
  });
  it("carries toolDiffDefaultView when provided", () => {
    expect(
      normalizePermissionSystemConfig({ toolDiffDefaultView: "split" })
        .toolDiffDefaultView,
    ).toBe("split");
  });
  it("omits toolDiffDefaultView when absent", () => {
    expect("toolDiffDefaultView" in normalizePermissionSystemConfig({})).toBe(
      false,
    );
  });
});

describe("ensurePermissionSystemLogsDirectory", () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-logsdir-"));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  test("creates the logs directory owner-only", () => {
    const logsDir = join(baseDir, "extensions", "pi-permission-system", "logs");

    expect(ensurePermissionSystemLogsDirectory(logsDir)).toBe(undefined);
    expect(statSync(logsDir).mode & 0o777).toBe(0o700);
  });

  test("tightens a directory inherited from an earlier version", () => {
    const logsDir = join(baseDir, "logs");
    mkdirSync(logsDir);
    chmodSync(logsDir, 0o755);

    expect(ensurePermissionSystemLogsDirectory(logsDir)).toBe(undefined);
    expect(statSync(logsDir).mode & 0o777).toBe(0o700);
  });
});

describe("keybindings 归一", () => {
  it("缺省 → 完整默认表", () => {
    const kb = normalizeKeybindings({});
    expect(kb.approve).toEqual(["y"]);
    expect(kb.deny).toEqual(["d"]);
    expect(kb.scrollUp).toEqual([]);
    expect(kb.scrollDown).toEqual([]);
    expect(kb.yoloToggle).toEqual(["ctrl+alt+y"]);
    expect(kb.scrollTop).toEqual(["home"]);
    expect(kb.contextMore).toEqual(["right", "]"]);
  });

  it("部分覆盖 = 该 action 整体替换, 其余保持默认", () => {
    const kb = normalizeKeybindings({
      keybindings: { approve: ["z", "q"], deny: [] },
    });
    expect(kb.approve).toEqual(["z", "q"]);
    expect(kb.deny).toEqual([]); // [] = 禁用
    expect(kb.approveSession).toEqual(["s"]);
    expect(kb.nextHunk).toEqual(["n"]);
  });

  it("非法元素被丢弃并回调告警; 全部非法 → []", () => {
    const dropped: string[] = [];
    const kb = normalizeKeybindings(
      { keybindings: { approve: ["y", "foo+y"] } },
      (key) => dropped.push(key),
    );
    expect(kb.approve).toEqual(["y"]);
    expect(dropped).toEqual(["foo+y"]);
    const kb2 = normalizeKeybindings({ keybindings: { cancel: ["bogus"] } });
    expect(kb2.cancel).toEqual([]);
  });

  it("规范化修饰符顺序", () => {
    const kb = normalizeKeybindings({
      keybindings: { yoloToggle: [" Alt + CTRL + y "] },
    });
    expect(kb.yoloToggle).toEqual(["ctrl+alt+y"]);
  });

  it("yoloToggle 优先, 否则用默认", () => {
    expect(
      normalizeKeybindings({ keybindings: { yoloToggle: ["ctrl+w"] } })
        .yoloToggle,
    ).toEqual(["ctrl+w"]);
    expect(normalizeKeybindings({}).yoloToggle).toEqual(["ctrl+alt+y"]);
  });

  it("查看键子集与 diff-view 默认一致(防漂移)", () => {
    for (const key of [
      "scrollUp",
      "scrollDown",
      "pageUp",
      "pageDown",
      "scrollTop",
      "scrollBottom",
      "nextHunk",
      "prevHunk",
      "toggleMode",
      "toggleWrap",
      "toggleExpand",
      "contextMore",
      "contextLess",
    ] as const) {
      expect(DEFAULT_KEYBINDINGS[key]).toEqual(DEFAULT_VIEW_KEYBINDINGS[key]);
    }
  });
});

describe("isYoloModeEnabled", () => {
  it("returns true when yoloMode is true", () => {
    expect(isYoloModeEnabled(makeConfig(true))).toBe(true);
  });

  it("returns false when yoloMode is false", () => {
    expect(isYoloModeEnabled(makeConfig(false))).toBe(false);
  });

  it("returns false when yoloMode is undefined", () => {
    expect(isYoloModeEnabled(makeConfig(undefined))).toBe(false);
  });
});
