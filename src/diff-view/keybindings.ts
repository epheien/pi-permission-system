// src/diff-view/keybindings.ts
export type DiffDefaultView = "split" | "unified";
export type DiffColorMode = "default" | "theme";
export type PathStyle = "full" | "short";

/**
 * Diff-view keyboard bindings: every action maps to an array of pi KeyId
 * strings. An empty array disables that action; omitted actions never occur
 * here because the assembled config is always fully merged (see
 * `extension-config`).
 */
export interface DiffKeybindings {
  scrollUp: string[];
  scrollDown: string[];
  pageUp: string[];
  pageDown: string[];
  scrollTop: string[];
  scrollBottom: string[];
  nextHunk: string[];
  prevHunk: string[];
  toggleMode: string[];
  toggleWrap: string[];
  toggleExpand: string[];
  contextMore: string[];
  contextLess: string[];
}

export const DEFAULT_KEYBINDINGS: DiffKeybindings = {
  scrollUp: [],
  scrollDown: [],
  pageUp: ["pageup"],
  pageDown: ["pagedown"],
  scrollTop: ["home"],
  scrollBottom: ["end"],
  nextHunk: ["n"],
  prevHunk: ["p"],
  toggleMode: ["tab"],
  toggleWrap: ["w"],
  toggleExpand: [],
  contextMore: ["right", "]"],
  contextLess: ["left", "["],
};
