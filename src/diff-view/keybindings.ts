// src/diff-view/keybindings.ts
export type DiffDefaultView = "split" | "unified";
export type DiffColorMode = "default" | "theme";
export type PathStyle = "full" | "short";

export interface DiffKeybindings {
  approve: string[] | false;
  reject: string[] | false;
  scrollUp: string[] | false;
  scrollDown: string[] | false;
  pageUp: string[] | false;
  pageDown: string[] | false;
  scrollTop: string[] | false;
  scrollBottom: string[] | false;
  nextHunk: string[] | false;
  prevHunk: string[] | false;
  toggleMode: string[] | false;
  toggleWrap: string[] | false;
  toggleExpand: string[] | false;
  contextMore: string[] | false;
  contextLess: string[] | false;
}

export const DEFAULT_KEYBINDINGS: DiffKeybindings = {
  approve: ["Enter", "a", "y"],
  reject: ["Escape", "r"],
  scrollUp: ["up"],
  scrollDown: ["down"],
  pageUp: ["pageUp"],
  pageDown: ["pageDown"],
  scrollTop: ["home"],
  scrollBottom: ["end"],
  nextHunk: ["n"],
  prevHunk: ["p"],
  toggleMode: ["Tab"],
  toggleWrap: ["w"],
  toggleExpand: ["ctrl+f"],
  contextMore: ["right", "]"],
  contextLess: ["left", "["],
};
