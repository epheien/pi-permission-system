import { describe, expect, it } from "vitest";
import { formatDisplayPath } from "#src/diff-view/path-display";

describe("formatDisplayPath", () => {
  it("full 样式原样返回", () => {
    expect(formatDisplayPath("/a/b.ts", "full", "/a")).toBe("/a/b.ts");
  });
  it("short 样式对 cwd 内相对化", () => {
    expect(formatDisplayPath("/a/b.ts", "short", "/a")).toBe("b.ts");
  });
  it("short 样式对 cwd 外保留绝对路径", () => {
    expect(formatDisplayPath("/x/b.ts", "short", "/a")).toBe("/x/b.ts");
  });
});
