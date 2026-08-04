import { describe, expect, test } from "vitest";

import { isDenyWithReason, isPermissionState } from "#src/types";

describe("isPermissionState", () => {
  test("returns true for 'allow'", () => {
    expect(isPermissionState("allow")).toBe(true);
  });

  test("returns true for 'deny'", () => {
    expect(isPermissionState("deny")).toBe(true);
  });

  test("returns true for 'ask'", () => {
    expect(isPermissionState("ask")).toBe(true);
  });

  test("returns false for unrecognized strings", () => {
    expect(isPermissionState("ALLOW")).toBe(false);
    expect(isPermissionState("permit")).toBe(false);
    expect(isPermissionState("")).toBe(false);
    expect(isPermissionState("block")).toBe(false);
  });

  test("returns false for non-string types", () => {
    expect(isPermissionState(null)).toBe(false);
    expect(isPermissionState(undefined)).toBe(false);
    expect(isPermissionState(1)).toBe(false);
    expect(isPermissionState({})).toBe(false);
  });
});

describe("isDenyWithReason", () => {
  test("returns true for { action: 'deny' } without a reason", () => {
    expect(isDenyWithReason({ action: "deny" })).toBe(true);
  });

  test("returns true for { action: 'deny', reason: '...' }", () => {
    expect(isDenyWithReason({ action: "deny", reason: "Use pnpm" })).toBe(true);
  });

  test("returns false for non-deny actions", () => {
    expect(isDenyWithReason({ action: "allow" })).toBe(false);
    expect(isDenyWithReason({ action: "ask" })).toBe(false);
  });

  test("returns false for a non-string reason", () => {
    expect(isDenyWithReason({ action: "deny", reason: 42 })).toBe(false);
    expect(isDenyWithReason({ action: "deny", reason: null })).toBe(false);
  });

  test("returns false for non-object types", () => {
    expect(isDenyWithReason(null)).toBe(false);
    expect(isDenyWithReason(undefined)).toBe(false);
    expect(isDenyWithReason("deny")).toBe(false);
    expect(isDenyWithReason(["deny"])).toBe(false);
  });
});
