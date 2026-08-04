import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getParser,
  getWarmBashParser,
  resetWarmBashParser,
  warmBashParser,
} from "#src/access-intent/bash/parser";

describe("getParser", () => {
  it("parses a simple bash command and returns a non-null root node", async () => {
    const parser = await getParser();
    const tree = parser.parse("echo hi");
    expect(tree).not.toBeNull();
    expect(tree?.rootNode).toBeDefined();
    expect(tree?.rootNode.type).toBe("program");
    tree?.delete();
  });

  it("returns the same memoized parser instance on repeated calls", async () => {
    const first = await getParser();
    const second = await getParser();
    expect(first).toBe(second);
  });
});

describe("warm parser", () => {
  beforeEach(() => {
    resetWarmBashParser();
  });
  afterEach(() => {
    resetWarmBashParser();
  });

  it("returns null before the parser is warmed", () => {
    expect(getWarmBashParser()).toBeNull();
  });

  it("exposes the parser synchronously after warm-up", async () => {
    await warmBashParser();
    const parser = getWarmBashParser();
    expect(parser).not.toBeNull();
    const tree = parser?.parse("echo hi");
    expect(tree?.rootNode.type).toBe("program");
    tree?.delete();
  });

  it("hands out the same memoized parser as getParser", async () => {
    await warmBashParser();
    expect(getWarmBashParser()).toBe(await getParser());
  });

  it("resetWarmBashParser clears the cached parser", async () => {
    await warmBashParser();
    expect(getWarmBashParser()).not.toBeNull();
    resetWarmBashParser();
    expect(getWarmBashParser()).toBeNull();
  });
});
