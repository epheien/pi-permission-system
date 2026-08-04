import { describe, expect, test } from "vitest";
import {
  getPathBearingToolPath,
  getToolInputPath,
} from "#src/access-intent/tool-input-path";
import type { ToolAccessExtractorLookup } from "#src/tool-access-extractor-registry";

describe("getPathBearingToolPath", () => {
  test("returns path for a path-bearing tool", () => {
    expect(getPathBearingToolPath("read", { path: "/src/foo.ts" })).toBe(
      "/src/foo.ts",
    );
  });

  test("returns null for a non-path-bearing tool", () => {
    expect(getPathBearingToolPath("bash", { path: "/src/foo.ts" })).toBeNull();
    expect(getPathBearingToolPath("mcp", { path: "/src/foo.ts" })).toBeNull();
    expect(getPathBearingToolPath("task", { path: "/src/foo.ts" })).toBeNull();
  });

  test("returns null when input has no path", () => {
    expect(getPathBearingToolPath("read", {})).toBeNull();
    expect(getPathBearingToolPath("read", { path: "" })).toBeNull();
    expect(getPathBearingToolPath("read", null)).toBeNull();
  });
});

describe("getToolInputPath", () => {
  function lookupOf(
    toolName: string,
    extractor: (input: Record<string, unknown>) => string | undefined,
  ): ToolAccessExtractorLookup {
    return {
      get: (name) => (name === toolName ? extractor : undefined),
    };
  }

  test("returns input.path for a built-in path-bearing tool", () => {
    expect(getToolInputPath("read", { path: "/src/foo.ts" })).toBe(
      "/src/foo.ts",
    );
    expect(getToolInputPath("write", { path: "/src/bar.ts" })).toBe(
      "/src/bar.ts",
    );
  });

  test("returns null for bash", () => {
    expect(getToolInputPath("bash", { path: "/src/foo.ts" })).toBeNull();
  });

  test("returns the MCP arguments.path for an mcp call", () => {
    expect(getToolInputPath("mcp", { arguments: { path: "/etc/hosts" } })).toBe(
      "/etc/hosts",
    );
  });

  test("returns null for an mcp call without an arguments.path", () => {
    expect(getToolInputPath("mcp", { arguments: { query: "x" } })).toBeNull();
    expect(getToolInputPath("mcp", {})).toBeNull();
  });

  test("defaults to input.path for an unregistered extension tool", () => {
    expect(getToolInputPath("my-ext", { path: "/work/file.txt" })).toBe(
      "/work/file.txt",
    );
  });

  test("returns null for an extension tool without a path", () => {
    expect(getToolInputPath("my-ext", { other: true })).toBeNull();
    expect(getToolInputPath("my-ext", { path: "" })).toBeNull();
    expect(getToolInputPath("my-ext", null)).toBeNull();
  });

  test("uses a registered extractor's path over the default convention", () => {
    const extractors = lookupOf("ffgrep", (input) =>
      typeof input.target === "string" ? input.target : undefined,
    );
    expect(
      getToolInputPath("ffgrep", { target: "/etc/passwd" }, extractors),
    ).toBe("/etc/passwd");
  });

  test("returns null when a registered extractor declines", () => {
    const extractors = lookupOf("ffgrep", () => undefined);
    expect(getToolInputPath("ffgrep", { target: "x" }, extractors)).toBeNull();
  });
});
