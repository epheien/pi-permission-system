import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyHashlineEditPreview,
  type HashlinePreviewEdit,
  isHashlineEditInput,
  parseAnchorLine,
} from "#src/diff-view/hashline-preview";
import { computeChangePreview } from "#src/diff-view/preview";

function apply(content: string, edits: HashlinePreviewEdit[]) {
  return applyHashlineEditPreview(content, edits).afterText;
}

function expectThrow(
  content: string,
  edits: HashlinePreviewEdit[],
  code: string,
) {
  expect(() => applyHashlineEditPreview(content, edits)).toThrow(code);
}

describe("parseAnchorLine(宽松)", () => {
  it("解析 LINE#HASH 取出行号", () => {
    expect(parseAnchorLine("12#VR")).toBe(12);
  });
  it("容忍前导空白与 diff 标记", () => {
    expect(parseAnchorLine("  5#XX")).toBe(5);
    expect(parseAnchorLine(">3#XX")).toBe(3);
    expect(parseAnchorLine("-7#XX")).toBe(7);
  });
  it("容忍 :content 后缀", () => {
    expect(parseAnchorLine("12#VR:function hello() {")).toBe(12);
  });
  it("校验 hash 格式:长度 2-4 且字符集 NIBBLE_STR", () => {
    expect(parseAnchorLine("1#ZP")).toBe(1);
    expect(parseAnchorLine("1#ZPM")).toBe(1);
    expect(parseAnchorLine("1#ZPMQ")).toBe(1);
  });
  it("hash 长度或字符集非法 → E_BAD_REF(执行端必拒)", () => {
    expect(() => parseAnchorLine("1#A")).toThrow("E_BAD_REF");
    expect(() => parseAnchorLine("1#ZZZZZZ")).toThrow("E_BAD_REF");
    expect(() => parseAnchorLine("1#xy")).toThrow("E_BAD_REF");
    expect(() => parseAnchorLine("1#0A")).toThrow("E_BAD_REF");
  });
  it("缺 hash / 非数字 / 零行号 → E_BAD_REF", () => {
    expect(() => parseAnchorLine("12")).toThrow("E_BAD_REF");
    expect(() => parseAnchorLine("abc#DD")).toThrow("E_BAD_REF");
    expect(() => parseAnchorLine("0#XX")).toThrow("E_BAD_REF");
    expect(() => parseAnchorLine(42)).toThrow("E_BAD_REF");
  });
});

describe("isHashlineEditInput(形状检测)", () => {
  it("hashline 形状 → true", () => {
    expect(
      isHashlineEditInput({
        path: "/a.txt",
        edits: [{ op: "replace", pos: "1#XX", lines: ["x"] }],
      }),
    ).toBe(true);
  });
  it("内置 single(oldText/newText) → false", () => {
    expect(
      isHashlineEditInput({ path: "/a.txt", oldText: "a", newText: "b" }),
    ).toBe(false);
  });
  it("内置 multi(edits[].oldText/newText) → false", () => {
    expect(
      isHashlineEditInput({
        path: "/a.txt",
        edits: [{ oldText: "a", newText: "b" }],
      }),
    ).toBe(false);
  });
  it("空 edits / 缺 path / 非对象 → false", () => {
    expect(isHashlineEditInput({ path: "/a.txt", edits: [] })).toBe(false);
    expect(
      isHashlineEditInput({ edits: [{ op: "replace", pos: "1#XX" }] }),
    ).toBe(false);
    expect(isHashlineEditInput(null)).toBe(false);
    expect(isHashlineEditInput("edit")).toBe(false);
  });
});

describe("applyHashlineEditPreview: replace", () => {
  it("单行替换", () => {
    expect(
      apply("a\nb\nc", [{ op: "replace", pos: "2#XX", lines: ["x"] }]),
    ).toBe("a\nx\nc");
  });
  it("范围替换(pos..end, inclusive)", () => {
    expect(
      apply("a\nb\nc\nd", [
        { op: "replace", pos: "1#XX", end: "2#YY", lines: ["x", "y"] },
      ]),
    ).toBe("x\ny\nc\nd");
  });
  it("单行替换为多行(无 end)", () => {
    expect(
      apply("a\nb", [{ op: "replace", pos: "2#XX", lines: ["x", "y"] }]),
    ).toBe("a\nx\ny");
  });
  it("删除中间行不留空行", () => {
    expect(apply("a\nb\nc", [{ op: "replace", pos: "2#XX", lines: [] }])).toBe(
      "a\nc",
    );
  });
  it("删除首行", () => {
    expect(apply("a\nb\nc", [{ op: "replace", pos: "1#XX", lines: [] }])).toBe(
      "b\nc",
    );
  });
  it("删除末行(无尾换行)", () => {
    expect(apply("a\nb", [{ op: "replace", pos: "2#XX", lines: [] }])).toBe(
      "a",
    );
  });
  it("拒绝清空非空文件(E_WOULD_EMPTY)", () => {
    expectThrow(
      "a",
      [{ op: "replace", pos: "1#XX", lines: [] }],
      "E_WOULD_EMPTY",
    );
  });
});

describe("applyHashlineEditPreview: append / prepend", () => {
  it("append after pos", () => {
    expect(apply("a\nb", [{ op: "append", pos: "1#XX", lines: ["x"] }])).toBe(
      "a\nx\nb",
    );
  });
  it("append at EOF(无 pos,无尾换行)", () => {
    expect(apply("a\nb", [{ op: "append", lines: ["x"] }])).toBe("a\nb\nx");
  });
  it("append at EOF(有尾换行)", () => {
    expect(apply("a\nb\n", [{ op: "append", lines: ["x"] }])).toBe("a\nb\nx\n");
  });
  it("append 到空文件", () => {
    expect(apply("", [{ op: "append", lines: ["x"] }])).toBe("x");
  });
  it("prepend before pos", () => {
    expect(apply("a\nb", [{ op: "prepend", pos: "2#XX", lines: ["x"] }])).toBe(
      "a\nx\nb",
    );
  });
  it("prepend at BOF(无 pos)", () => {
    expect(apply("a\nb", [{ op: "prepend", lines: ["x"] }])).toBe("x\na\nb");
  });
  it("prepend 到空文件", () => {
    expect(apply("", [{ op: "prepend", lines: ["x"] }])).toBe("x");
  });
});

describe("applyHashlineEditPreview: replace_text", () => {
  it("唯一匹配替换", () => {
    expect(
      apply("hello world", [
        { op: "replace_text", oldText: "world", newText: "pi" },
      ]),
    ).toBe("hello pi");
  });
  it("找不到 → E_NO_MATCH", () => {
    expectThrow(
      "hello",
      [{ op: "replace_text", oldText: "nope", newText: "x" }],
      "E_NO_MATCH",
    );
  });
  it("多匹配 → E_MULTI_MATCH", () => {
    expectThrow(
      "a a",
      [{ op: "replace_text", oldText: "a", newText: "b" }],
      "E_MULTI_MATCH",
    );
  });
  it("重叠匹配 → E_MULTI_MATCH", () => {
    expectThrow(
      "aaa",
      [{ op: "replace_text", oldText: "aa", newText: "b" }],
      "E_MULTI_MATCH",
    );
  });
  it("空 oldText → E_BAD_OP", () => {
    expectThrow(
      "a",
      [{ op: "replace_text", oldText: "", newText: "b" }],
      "E_BAD_OP",
    );
  });
});

describe("applyHashlineEditPreview: 多编辑与冲突", () => {
  it("不重叠的 replace + append 一次应用", () => {
    expect(
      apply("a\nb\nc", [
        { op: "replace", pos: "2#XX", lines: ["x"] },
        { op: "append", pos: "3#YY", lines: ["y"] },
      ]),
    ).toBe("a\nx\nc\ny");
  });
  it("insert 起点落在 replace 区间内 → E_EDIT_CONFLICT", () => {
    expectThrow(
      "a\nb\nc\nd",
      [
        { op: "replace", pos: "2#XX", end: "3#YY", lines: ["x"] },
        { op: "append", pos: "2#ZZ", lines: ["y"] },
      ],
      "E_EDIT_CONFLICT",
    );
  });
  it("两个 replace 覆盖同一行(不同内容) → E_EDIT_CONFLICT", () => {
    expectThrow(
      "a\nb\nc",
      [
        { op: "replace", pos: "2#XX", lines: ["x"] },
        { op: "replace", pos: "2#YY", lines: ["y"] },
      ],
      "E_EDIT_CONFLICT",
    );
  });
  it("相同插入边界 → E_EDIT_CONFLICT", () => {
    expectThrow(
      "a\nb",
      [
        { op: "append", pos: "1#XX", lines: ["x"] },
        { op: "append", pos: "1#YY", lines: ["y"] },
      ],
      "E_EDIT_CONFLICT",
    );
  });
});

describe("noop 与相同 span 去重(对齐执行引擎)", () => {
  it("两个相同 replace 同一行 → 应用一次,不冲突", () => {
    expect(
      apply("a\nb\nc", [
        { op: "replace", pos: "2#XX", lines: ["x"] },
        { op: "replace", pos: "2#YY", lines: ["x"] },
      ]),
    ).toBe("a\nx\nc");
  });
  it("noop replace(内容相同) + 改动 replace 同行 → 应用改动", () => {
    expect(
      apply("a\nb\nc", [
        { op: "replace", pos: "2#XX", lines: ["b"] },
        { op: "replace", pos: "2#YY", lines: ["x"] },
      ]),
    ).toBe("a\nx\nc");
  });
  it("同一边界两个相同 append → 应用一次", () => {
    expect(
      apply("a\nb", [
        { op: "append", pos: "1#XX", lines: ["x"] },
        { op: "append", pos: "1#YY", lines: ["x"] },
      ]),
    ).toBe("a\nx\nb");
  });
  it("replace_text oldText === newText → noop", () => {
    expect(
      apply("a", [{ op: "replace_text", oldText: "a", newText: "a" }]),
    ).toBe("a");
  });
  it("noop replace_text 仍要求 oldText 在文件中唯一", () => {
    expectThrow(
      "b",
      [{ op: "replace_text", oldText: "a", newText: "a" }],
      "E_NO_MATCH",
    );
  });
  it("不同内容的 replace 同一行仍冲突", () => {
    expectThrow(
      "a\nb\nc",
      [
        { op: "replace", pos: "2#XX", lines: ["x"] },
        { op: "replace", pos: "2#YY", lines: ["y"] },
      ],
      "E_EDIT_CONFLICT",
    );
  });
});

describe("applyHashlineEditPreview: 结构校验(执行引擎必拒绝的输入)", () => {
  it("未知 op → E_BAD_OP", () => {
    expectThrow("a", [{ op: "delete", pos: "1#XX", lines: [] }], "E_BAD_OP");
  });
  it("replace 缺 pos → E_BAD_OP", () => {
    expectThrow("a", [{ op: "replace", lines: ["x"] }], "E_BAD_OP");
  });
  it("append 空 lines → E_BAD_OP", () => {
    expectThrow("a", [{ op: "append", pos: "1#XX", lines: [] }], "E_BAD_OP");
  });
  it("append 带 end → E_BAD_OP", () => {
    expectThrow(
      "a\nb",
      [{ op: "append", pos: "1#XX", end: "2#YY", lines: ["x"] }],
      "E_BAD_OP",
    );
  });
  it("replace_text 带 pos → 报错", () => {
    expectThrow(
      "a",
      [{ op: "replace_text", oldText: "a", newText: "b", pos: "1#XX" }],
      "only supports",
    );
  });
  it("lines 携带显示前缀 → E_INVALID_PATCH", () => {
    expectThrow(
      "a\nb",
      [{ op: "replace", pos: "2#XX", lines: ["2#VR:x"] }],
      "E_INVALID_PATCH",
    );
    expectThrow(
      "a\nb",
      [{ op: "replace", pos: "2#XX", lines: ["-2    x"] }],
      "E_INVALID_PATCH",
    );
  });
  it("行号越界 → E_RANGE_OOB", () => {
    expectThrow(
      "a",
      [{ op: "replace", pos: "5#XX", lines: ["x"] }],
      "E_RANGE_OOB",
    );
  });
  it("范围起点大于终点 → 报错", () => {
    expectThrow(
      "a\nb\nc",
      [{ op: "replace", pos: "3#XX", end: "1#YY", lines: ["x"] }],
      "must be <= end",
    );
  });
});

describe("applyHashlineEditPreview: summaryLines 与往返", () => {
  it("返回 beforeText 与带操作说明的 summaryLines", () => {
    const result = applyHashlineEditPreview("a\nb", [
      { op: "replace", pos: "2#XX", lines: ["x"] },
      { op: "append", lines: ["y"] },
    ]);
    expect(result.beforeText).toBe("a\nb");
    expect(result.afterText).toBe("a\nx\ny");
    expect(result.summaryLines).toEqual([
      "2 hashline operation(s)",
      "replace 2#XX",
      "append at EOF",
    ]);
  });
});

describe("computeChangePreview 集成(hashline 形状的 edit)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "diff-view-hashline-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("hashline 形状走宽松预览,toolName 仍为 edit", async () => {
    const p = join(dir, "a.txt");
    writeFileSync(p, "aaa\nbbb\n");
    const preview = await computeChangePreview(
      "edit",
      { path: p, edits: [{ op: "replace", pos: "2#XX", lines: ["BBB"] }] },
      "/",
    );
    expect(preview?.toolName).toBe("edit");
    expect(preview?.afterText).toContain("BBB");
    expect(preview?.summaryLines.join(" ")).toContain("hashline operation");
    expect(preview?.previewError).toBeUndefined();
  });

  it("hashline 坏锚点 → previewError 非空(不跳审批)", async () => {
    const p = join(dir, "b.txt");
    writeFileSync(p, "aaa\n");
    const preview = await computeChangePreview(
      "edit",
      { path: p, edits: [{ op: "replace", pos: "nope", lines: ["x"] }] },
      "/",
    );
    expect(preview?.previewError).toBeTruthy();
    expect(preview?.previewError).toContain("E_BAD_REF");
  });

  it("内置 oldText/newText 形状不受影响", async () => {
    const p = join(dir, "c.txt");
    writeFileSync(p, "aaa\nbbb\n");
    const preview = await computeChangePreview(
      "edit",
      { path: p, oldText: "bbb", newText: "BBB" },
      "/",
    );
    expect(preview?.afterText).toContain("BBB");
    expect(preview?.summaryLines.join(" ")).toContain("Replace exact text");
  });

  it("内置 multi 形状(edits[].oldText/newText)不受影响", async () => {
    const p = join(dir, "d.txt");
    writeFileSync(p, "aaa\nbbb\nccc\n");
    const preview = await computeChangePreview(
      "edit",
      {
        path: p,
        edits: [
          { oldText: "bbb", newText: "BBB" },
          { oldText: "ccc", newText: "CCC" },
        ],
      },
      "/",
    );
    expect(preview?.afterText).toContain("BBB");
    expect(preview?.afterText).toContain("CCC");
    expect(preview?.summaryLines.join(" ")).toContain("targeted edit");
    expect(preview?.previewError).toBeUndefined();
  });
});
