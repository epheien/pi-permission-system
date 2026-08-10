import { describe, expect, it } from "vitest";
import {
  detectLineEnding,
  generateDiffString,
  normalizeToLF,
  stripBom,
  summarizeDiff,
} from "#src/diff-view/diff-utils";

describe("diff-utils(移植)", () => {
  it("detectLineEnding 识别 CRLF", () => {
    expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
  });
  it("normalizeToLF 统一为 LF", () => {
    expect(normalizeToLF("a\r\nb")).toBe("a\nb");
  });
  it("stripBom 分离 BOM 与文本", () => {
    expect(stripBom("\uFEFFabc")).toEqual({ bom: "\uFEFF", text: "abc" });
  });
  it("generateDiffString 对无差异无增删标记", () => {
    const { diff } = generateDiffString("abc\ndef\n", "abc\ndef\n");
    const lines = diff.split("\n");
    expect(lines.some((l) => l.startsWith("+") || l.startsWith("-"))).toBe(false);
  });
  it("generateDiffString 产出含 +/- 的可视 diff", () => {
    const { diff } = generateDiffString("a\nb\n", "a\nc\n");
    expect(diff.split("\n")).toContain("-2 b");
    expect(diff.split("\n")).toContain("+2 c");
  });
  it("summarizeDiff 统计增删", () => {
    const { additions, deletions } = summarizeDiff("@@\n-a\n+b\n");
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
  });
});
