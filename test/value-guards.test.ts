import { describe, expect, test } from "vitest";

import { getNonEmptyString, toRecord } from "#src/value-guards";

describe("toRecord", () => {
  test("returns empty object for null", () => {
    expect(toRecord(null)).toEqual({});
  });

  test("returns empty object for undefined", () => {
    expect(toRecord(undefined)).toEqual({});
  });

  test("returns empty object for a string", () => {
    expect(toRecord("hello")).toEqual({});
  });

  test("returns empty object for a number", () => {
    expect(toRecord(42)).toEqual({});
  });

  test("returns empty object for an array", () => {
    expect(toRecord(["a", "b"])).toEqual({});
  });

  test("returns the object itself for a plain object", () => {
    const input = { a: 1, b: "two" };
    expect(toRecord(input)).toBe(input);
  });

  test("returns the object for a nested object", () => {
    const input = { x: { y: 3 } };
    expect(toRecord(input)).toBe(input);
  });
});

describe("getNonEmptyString", () => {
  test("returns null for non-string values", () => {
    expect(getNonEmptyString(null)).toBeNull();
    expect(getNonEmptyString(undefined)).toBeNull();
    expect(getNonEmptyString(42)).toBeNull();
    expect(getNonEmptyString({})).toBeNull();
    expect(getNonEmptyString([])).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(getNonEmptyString("")).toBeNull();
  });

  test("returns null for whitespace-only string", () => {
    expect(getNonEmptyString("   ")).toBeNull();
    expect(getNonEmptyString("\t\n")).toBeNull();
  });

  test("returns trimmed string for valid string", () => {
    expect(getNonEmptyString("hello")).toBe("hello");
    expect(getNonEmptyString("  hello  ")).toBe("hello");
  });

  test("returns single non-whitespace character", () => {
    expect(getNonEmptyString("a")).toBe("a");
  });
});
