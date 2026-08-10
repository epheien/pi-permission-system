import { describe, expect, it } from "vitest";
import {
  detectSyntaxLanguage,
  tokenizeSyntaxLine,
} from "#src/diff-view/syntax-highlight";

describe("syntax-highlight(移植)", () => {
  it("detectSyntaxLanguage 按扩展名识别", () => {
    expect(detectSyntaxLanguage("a.ts")).toBe("ts");
  });
  it("tokenizeSyntaxLine 对无语法语言原样单段返回", () => {
    const seg = tokenizeSyntaxLine("plain text", undefined);
    expect(seg).toEqual([{ text: "plain text", kind: undefined }]);
  });
});
