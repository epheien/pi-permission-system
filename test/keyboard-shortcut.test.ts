import { describe, expect, it } from "vitest";
import { parseShortcutKey } from "#src/keyboard-shortcut";

describe("parseShortcutKey", () => {
  it("returns the canonical key for a plain modified combo", () => {
    expect(parseShortcutKey("ctrl+alt+y")).toEqual({
      ok: true,
      key: "ctrl+alt+y",
    });
  });

  it("lowercases and normalizes modifier order", () => {
    expect(parseShortcutKey(" Alt + CTRL + y ")).toEqual({
      ok: true,
      key: "ctrl+alt+y",
    });
  });

  it("accepts an unmodified single key", () => {
    expect(parseShortcutKey("f5")).toEqual({ ok: true, key: "f5" });
  });

  it("accepts special keys with modifiers", () => {
    expect(parseShortcutKey("shift+ctrl+pageUp")).toEqual({
      ok: true,
      key: "ctrl+shift+pageup",
    });
  });

  it("accepts symbol keys", () => {
    expect(parseShortcutKey("ctrl+[")).toEqual({ ok: true, key: "ctrl+[" });
  });

  it("reports empty for undefined", () => {
    expect(parseShortcutKey(undefined)).toEqual({
      ok: false,
      reason: "empty",
    });
  });

  it("reports empty for a blank string (explicit disable)", () => {
    expect(parseShortcutKey("")).toEqual({ ok: false, reason: "empty" });
    expect(parseShortcutKey("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("reports invalid for an unknown segment", () => {
    expect(parseShortcutKey("foo+y")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("reports invalid for a duplicated modifier", () => {
    expect(parseShortcutKey("ctrl+ctrl+y")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("reports invalid for an unknown base key", () => {
    expect(parseShortcutKey("ctrl+banana")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("reports invalid for a missing base key", () => {
    expect(parseShortcutKey("ctrl+")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("keeps an uppercase letter's case (uppercase G is the same key as g)", () => {
    expect(parseShortcutKey("G")).toEqual({ ok: true, key: "G" });
    expect(parseShortcutKey("Ctrl+G")).toEqual({
      ok: true,
      key: "ctrl+G",
    });
    expect(parseShortcutKey("Shift+G")).toEqual({
      ok: true,
      key: "shift+G",
    });
  });

  it("keeps a lowercase letter lowercase", () => {
    expect(parseShortcutKey("g")).toEqual({ ok: true, key: "g" });
  });
});
