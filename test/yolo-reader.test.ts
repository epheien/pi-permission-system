import { describe, expect, it, vi } from "vitest";

import { readYoloSafe } from "#src/yolo-reader";

// This guard is what keeps the yolo seam honest: both mid-decision readers
// (the tool_call fail-closed boundary and the gate runner's pre-resolved
// normalization) must fail closed when the flag cannot be read.
describe("readYoloSafe", () => {
  it("returns the reader's value when it succeeds", () => {
    expect(readYoloSafe(() => true)).toBe(true);
    expect(readYoloSafe(() => false)).toBe(false);
  });

  it("falls back to yolo off when the reader throws", () => {
    const reader = vi.fn<() => boolean>(() => {
      throw new Error("config store not ready");
    });

    expect(readYoloSafe(reader)).toBe(false);
  });
});
