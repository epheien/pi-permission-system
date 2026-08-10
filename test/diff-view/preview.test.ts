import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeChangePreview } from "#src/diff-view/preview";

describe("computeChangePreview(write/edit)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "diff-view-preview-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("write 新建输出差异与 afterText", async () => {
    const p = join(dir, "a.txt");
    const preview = await computeChangePreview(
      "write",
      { path: p, content: "x\n" },
      "/",
    );
    expect(preview?.additions).toBe(1);
    expect(preview?.summaryLines.join(" ")).toContain("Create new file");
  });

  it("write 覆盖时 diff 含旧->新", async () => {
    const p = join(dir, "b.txt");
    writeFileSync(p, "old\n");
    const preview = await computeChangePreview(
      "write",
      { path: p, content: "new\n" },
      "/",
    );
    expect(preview?.deletions ?? 0).toBeGreaterThan(0);
    expect(preview?.additions ?? 0).toBeGreaterThan(0);
  });

  it("edit 精确匹配可计算", async () => {
    const p = join(dir, "c.txt");
    writeFileSync(p, "aaa\nbbb\n");
    const preview = await computeChangePreview(
      "edit",
      { path: p, oldText: "bbb", newText: "BBB" },
      "/",
    );
    expect(preview?.afterText).toContain("BBB");
  });

  it("edit oldText 缺失时 previewError 非空", async () => {
    const p = join(dir, "d.txt");
    writeFileSync(p, "aaa\n");
    const preview = await computeChangePreview(
      "edit",
      { path: p, oldText: "nope", newText: "x" },
      "/",
    );
    expect(preview?.previewError).toBeTruthy();
  });

  it("非 write/edit 返回 null", async () => {
    expect(await computeChangePreview("bash" as never, {}, "/")).toBeNull();
  });
});
