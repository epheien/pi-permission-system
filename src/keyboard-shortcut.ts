import type { KeyId } from "@earendil-works/pi-tui";

/**
 * Parses and validates user-supplied keyboard-shortcut values against pi-tui's
 * `KeyId` grammar.
 *
 * pi-tui's `parseKeyId` is not exported, and feeding a malformed string to
 * `registerShortcut` would silently mis-bind (e.g. `"foo+y"` would be treated
 * as the bare `"y"` key). This module mirrors that grammar so a config value is
 * either accepted in a canonical form or rejected outright — never registered
 * as a different binding.
 *
 * Grammar (mirrors `@earendil-works/pi-tui` keys):
 * - modifiers: `ctrl`, `shift`, `alt`, `super` — each at most once
 * - base key: a single letter `a-z`, digit `0-9`, a symbol, or a special key
 *   name (`escape`, `enter`, `space`, `f1`…`f12`, `pageUp`, …)
 */

const MODIFIERS = ["ctrl", "shift", "alt", "super"] as const;
const MODIFIER_SET = new Set<string>(MODIFIERS);

const SYMBOL_KEYS = new Set<string>(
  "`-=[]\\;',./!@#$%^&*()_+{|}:\"<>?".split(""),
);

const SPECIAL_KEYS = new Set<string>([
  "escape",
  "esc",
  "enter",
  "return",
  "tab",
  "space",
  "backspace",
  "delete",
  "insert",
  "clear",
  "home",
  "end",
  "pageup",
  "pagedown",
  "up",
  "down",
  "left",
  "right",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
]);

/** Result of parsing a shortcut value. */
export type ShortcutKeyParse =
  | { ok: true; key: KeyId }
  | { ok: false; reason: "empty" | "invalid" };

/**
 * Parse a config-supplied shortcut value into a canonical, pi-tui-compatible
 * `KeyId`.
 *
 * - `undefined` / blank string → `{ ok: false, reason: "empty" }` (the caller
 *   treats a blank as "shortcut explicitly disabled"; `undefined` as "use the
 *   default").
 * - malformed → `{ ok: false, reason: "invalid" }` — the caller must NOT
 *   register anything (never a silently-different binding).
 * - valid → the canonical form with modifiers in a fixed order
 *   (`ctrl+shift+alt+super`), e.g. `"Y + Alt + CTRL"` → `"ctrl+alt+y"`.
 *   A single **letter** keeps its original case (`"G"` → `"G"`, `"y + Alt + CTRL"`
 *   → `"ctrl+alt+y"`): `g` and `G` are the same key in a terminal (Shift and
 *   CapsLock produce the same character), and the matching layer treats single
 *   letters case-insensitively.
 */
export function parseShortcutKey(input: string | undefined): ShortcutKeyParse {
  if (input === undefined) {
    return { ok: false, reason: "empty" };
  }

  const rawParts = input
    .trim()
    .split("+")
    .map((part) => part.trim());
  const lowerParts = rawParts.map((part) => part.toLowerCase());
  if (lowerParts.length === 0 || lowerParts.some((part) => part === "")) {
    return lowerParts.length === 1
      ? { ok: false, reason: "empty" }
      : {
          ok: false,
          reason: "invalid",
        };
  }

  // 字母 base 保留原始大小写(g 与 G 是同一个键——终端发的是字符,分不清
  // Shift 与 CapsLock,匹配层按大小写等价处理);其余键(数字/符号/特殊键)
  // 规范为小写 canonical。
  const rawBase = rawParts[rawParts.length - 1]!;
  const lowerBase = lowerParts[lowerParts.length - 1]!;
  const base = /^[A-Za-z]$/.test(rawBase) ? rawBase : lowerBase;
  if (!isBaseKey(base)) {
    return { ok: false, reason: "invalid" };
  }

  const modifiers = lowerParts.slice(0, -1);
  if (
    modifiers.some((modifier) => !MODIFIER_SET.has(modifier)) ||
    new Set(modifiers).size !== modifiers.length
  ) {
    return { ok: false, reason: "invalid" };
  }

  const canonicalModifiers = MODIFIERS.filter((modifier) =>
    modifiers.includes(modifier),
  );
  // Every segment was validated against the pi-tui KeyId grammar above, so the
  // assembled string is a legal KeyId even though TypeScript can't prove it.
  return {
    ok: true,
    key: [...canonicalModifiers, base].join("+") as KeyId,
  };
}

function isBaseKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    /^[a-z]$/.test(lower) ||
    /^[0-9]$/.test(key) ||
    SYMBOL_KEYS.has(lower) ||
    SPECIAL_KEYS.has(lower)
  );
}
