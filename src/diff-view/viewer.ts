import {
  type Component,
  CURSOR_MARKER,
  type KeyId,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import {
  adjustStructuredDiffContext,
  type InlineRange,
  type StructuredDiff,
  type StructuredDiffHunk,
  type StructuredDiffRow,
  type StructuredDiffVisibleItem,
} from "./diff-utils";
import {
  DEFAULT_KEYBINDINGS,
  type DiffColorMode,
  type DiffDefaultView,
  type DiffKeybindings,
  type PathStyle,
} from "./keybindings";
import { formatDisplayPath } from "./path-display";
import type { ChangePreview } from "./preview";
import {
  detectSyntaxLanguage,
  type SyntaxSegment,
  tokenizeSyntaxLine,
} from "./syntax-highlight";

type ViewMode = "split" | "unified";
type DiffTone = "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext";
type ChangedDiffTone = Exclude<DiffTone, "toolDiffContext">;

/**
 * 最小化主题结构,避免 diff-view 依赖任何 SDK 具体包:只要渲染用到的成员。
 * 真实 SDK Theme 结构上满足此接口,故 authority 侧传入即兼容。
 */
interface DiffTheme {
  name?: string;
  fg(color: string, text: string): string;
  bold(text: string): string;
  getBgAnsi(key: string): string;
}

/** 内联英文 fallback:本模块不依赖 i18n(参数忽略) */
const t = (
  _key: string,
  fallback: string,
  _params?: Record<string, string | number>,
): string => fallback;

interface CursorOverlay {
  startOffset: number;
  lines: string[];
}

interface RenderedCell {
  lines: string[];
  cursorLineIndex?: number;
}

interface RenderedContent {
  lines: string[];
  hunkOffsets: number[];
  cursorOffset?: number;
  cursorOverlay?: CursorOverlay;
}

interface RenderedRowSpan {
  startOffset: number;
  lineCount: number;
}

interface RenderedDiffCache {
  lines: string[];
  hunkOffsets: number[];
  rowSpans: Array<RenderedRowSpan | undefined>;
  rowIndexByNewLine: number[];
}

interface ViewerLayout {
  width: number;
  mode: ViewMode;
  headerLines: string[];
  columnLines: string[];
  footerLines: string[];
  contentLines: string[];
  hunkOffsets: number[];
  viewportHeight: number;
  maxScrollOffset: number;
  scrollOffset: number;
  currentHunkIndex: number;
  cursorOverlay?: CursorOverlay;
}

const TAB_REPLACEMENT = "    ";
const DIFF_RAIL_MARKER = "▌";
const MIN_SPLIT_COLUMN_WIDTH = 28;
const MIN_CONTEXT_LINES = 0;
const MAX_CONTEXT_LINES = 80;
const INLINE_CURSOR_OPEN = "\x1b[1;7m";
const INLINE_CURSOR_CLOSE = "\x1b[0m";
const INLINE_HIGHLIGHT_MAX_CHANGED_RATIO = 0.8;
const DEFAULT_DARK_DIFF_BACKGROUND_ANSI: Record<ChangedDiffTone, string> = {
  toolDiffAdded: "\x1b[48;2;58;86;74m",
  toolDiffRemoved: "\x1b[48;2;86;63;67m",
};
const DEFAULT_LIGHT_DIFF_BACKGROUND_ANSI: Record<ChangedDiffTone, string> = {
  toolDiffAdded: "\x1b[48;2;223;240;216m",
  toolDiffRemoved: "\x1b[48;2;242;222;222m",
};

interface RgbColor {
  r: number;
  g: number;
  b: number;
}

interface HslColor {
  h: number;
  s: number;
  l: number;
}

function rgbLuminance(color: RgbColor): number {
  return (color.r * 299 + color.g * 587 + color.b * 114) / 1000;
}

function isLightTheme(theme: DiffTheme): boolean {
  const name = (theme.name ?? "").toLowerCase();
  if (name.includes("light")) return true;
  if (name.includes("dark")) return false;

  try {
    const bg = theme.getBgAnsi("toolPendingBg");
    const match = /48;2;(\d+);(\d+);(\d+)/.exec(bg);
    if (match) {
      return (
        rgbLuminance({
          r: Number(match[1]),
          g: Number(match[2]),
          b: Number(match[3]),
        }) > 128
      );
    }
  } catch {}

  return false;
}

function getDefaultDiffBackgrounds(
  theme: DiffTheme,
): Record<ChangedDiffTone, string> {
  return isLightTheme(theme)
    ? DEFAULT_LIGHT_DIFF_BACKGROUND_ANSI
    : DEFAULT_DARK_DIFF_BACKGROUND_ANSI;
}

function getThemeDiffBackgrounds(
  theme: DiffTheme,
): Record<ChangedDiffTone, string> {
  return {
    toolDiffAdded: theme.getBgAnsi("toolSuccessBg"),
    toolDiffRemoved: theme.getBgAnsi("toolErrorBg"),
  };
}

function getDiffBackgrounds(
  theme: DiffTheme,
  mode: DiffColorMode,
): Record<ChangedDiffTone, string> {
  return mode === "theme"
    ? getThemeDiffBackgrounds(theme)
    : getDefaultDiffBackgrounds(theme);
}

function parseTrueColorBackgroundAnsi(ansi: string): RgbColor | undefined {
  const match = /\x1b\[48;2;(\d{1,3});(\d{1,3});(\d{1,3})m/.exec(ansi);
  if (!match) return undefined;

  const rgb = {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
  };
  return [rgb.r, rgb.g, rgb.b].every(
    (channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255,
  )
    ? rgb
    : undefined;
}

function rgbToHsl(color: RgbColor): HslColor {
  const r = color.r / 255;
  const g = color.g / 255;
  const b = color.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
        break;
    }
    h /= 6;
  }

  return { h, s, l };
}

function hueToRgb(p: number, q: number, t: number): number {
  let hue = t;
  if (hue < 0) hue += 1;
  if (hue > 1) hue -= 1;
  if (hue < 1 / 6) return p + (q - p) * 6 * hue;
  if (hue < 1 / 2) return q;
  if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
  return p;
}

function hslToRgb(color: HslColor): RgbColor {
  if (color.s === 0) {
    const channel = Math.round(color.l * 255);
    return { r: channel, g: channel, b: channel };
  }

  const q =
    color.l < 0.5
      ? color.l * (1 + color.s)
      : color.l + color.s - color.l * color.s;
  const p = 2 * color.l - q;
  return {
    r: Math.round(hueToRgb(p, q, color.h + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, color.h) * 255),
    b: Math.round(hueToRgb(p, q, color.h - 1 / 3) * 255),
  };
}

function formatTrueColorBackgroundAnsi(color: RgbColor): string {
  return `\x1b[48;2;${color.r};${color.g};${color.b}m`;
}

function intensifyDiffBackground(ansi: string): string | undefined {
  const rgb = parseTrueColorBackgroundAnsi(ansi);
  if (!rgb) return undefined;

  const hsl = rgbToHsl(rgb);
  const isLightBackground = rgbLuminance(rgb) > 128;
  return formatTrueColorBackgroundAnsi(
    hslToRgb({
      h: hsl.h,
      s: clampNumber(hsl.s * 1.3 + 0.08, 0, 1),
      l: clampNumber(hsl.l + (isLightBackground ? -0.12 : 0.1), 0.18, 0.86),
    }),
  );
}

function getInlineDiffBackgrounds(
  lineBackgrounds: Record<ChangedDiffTone, string>,
): Record<ChangedDiffTone, string> {
  return {
    toolDiffAdded:
      intensifyDiffBackground(lineBackgrounds.toolDiffAdded) ??
      lineBackgrounds.toolDiffAdded,
    toolDiffRemoved:
      intensifyDiffBackground(lineBackgrounds.toolDiffRemoved) ??
      lineBackgrounds.toolDiffRemoved,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function normalizeTuiText(text: string): string {
  return text.replace(/\t/g, TAB_REPLACEMENT);
}

function pluralize(word: string, count: number): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

function summarizeLines(lines: string[], maxItems = 3): string {
  if (lines.length === 0) return "";
  const visible = lines.slice(0, maxItems).map(normalizeTuiText);
  if (lines.length <= maxItems) return visible.join(" • ");
  return `${visible.join(" • ")} • … ${lines.length - maxItems} more`;
}

function sliceChars(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join("");
}

function centerAnsiText(text: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const truncated = truncateToWidth(text, safeWidth, "", false);
  const padding = Math.max(0, safeWidth - visibleWidth(truncated));
  const leftPadding = Math.floor(padding / 2);
  return truncateToWidth(
    `${" ".repeat(leftPadding)}${truncated}`,
    safeWidth,
    "",
    true,
  );
}

export class DiffViewer implements Component {
  private scrollOffset = 0;
  private lastWidth = 80;
  private wrapLongLines = true;
  private preferredMode: ViewMode;
  private baseDiffModel?: StructuredDiff;
  private diffModel?: StructuredDiff;
  private contextLines: number;
  private readonly syntaxLanguage?: string;
  private readonly syntaxLineCache = new Map<string, SyntaxSegment[]>();
  private readonly diffBackgrounds: Record<ChangedDiffTone, string>;
  private readonly diffInlineBackgrounds: Record<ChangedDiffTone, string>;
  private preview: ChangePreview;
  private inlineEditMode = false;
  private selectedHunkIndex?: number;
  private readonly diffModelCacheIds = new WeakMap<StructuredDiff, number>();
  private nextDiffModelCacheId = 1;
  private lastRenderedDiffCache?: { key: string; value: RenderedDiffCache };
  private readonly cursorlessRowCache = new Map<string, RenderedCell>();
  private readonly gapLineCache = new Map<string, string>();
  private readonly kb: DiffKeybindings;

  constructor(
    private readonly tui: {
      terminal?: { rows: number };
      requestRender(): void;
    },
    private readonly theme: DiffTheme,
    preview: ChangePreview,
    diffColorMode: DiffColorMode,
    private readonly showDiffRail: boolean = true,
    keybindings?: DiffKeybindings,
    private readonly defaultView: DiffDefaultView = "split",
    private readonly pathStyle: PathStyle = "full",
    private readonly cwd: string = "",
    /** viewer 自身输出行数上限;缺省时按终端可视行填满(旧行为)。 */
    private readonly maxHeight?: number,
  ) {
    this.kb = keybindings ?? DEFAULT_KEYBINDINGS;
    this.diffBackgrounds = getDiffBackgrounds(theme, diffColorMode);
    this.diffInlineBackgrounds = getInlineDiffBackgrounds(this.diffBackgrounds);
    this.preview = preview;
    this.baseDiffModel = preview.diffModel;
    this.diffModel = preview.diffModel;
    this.contextLines = preview.diffModel?.contextLines ?? 4;
    this.preferredMode = preview.diffModel ? this.defaultView : "unified";
    this.syntaxLanguage = detectSyntaxLanguage(preview.path);
  }

  viewMode(): DiffDefaultView {
    return this.preferredMode;
  }

  hunkOffsets(): number[] {
    return this.buildLayout(this.lastWidth).hunkOffsets;
  }

  invalidate(): void {
    this.lastRenderedDiffCache = undefined;
  }

  getPreview(): ChangePreview {
    return this.preview;
  }

  private getDiffModelCacheId(diff: StructuredDiff): number {
    const existing = this.diffModelCacheIds.get(diff);
    if (existing !== undefined) return existing;

    const nextId = this.nextDiffModelCacheId++;
    this.diffModelCacheIds.set(diff, nextId);
    return nextId;
  }

  private serializeInlineRanges(ranges: InlineRange[]): string {
    return ranges.map((range) => `${range.start}:${range.end}`).join(",");
  }

  private getCursorlessRowCacheKey(
    mode: ViewMode,
    row: StructuredDiffRow,
    width: number,
    lineNumberWidth: number,
    split?: { leftWidth: number; rightWidth: number },
  ): string {
    return [
      mode,
      width,
      lineNumberWidth,
      this.showDiffRail ? "rail" : "no-rail",
      this.wrapLongLines ? "wrap" : "nowrap",
      split?.leftWidth ?? "",
      split?.rightWidth ?? "",
      row.kind,
      row.oldLineNumber ?? "",
      row.newLineNumber ?? "",
      this.serializeInlineRanges(row.oldHighlights),
      this.serializeInlineRanges(row.newHighlights),
      row.oldText,
      row.newText,
    ].join("\u001f");
  }

  private getCachedCursorlessRow(
    key: string,
    render: () => RenderedCell,
  ): RenderedCell {
    const cached = this.cursorlessRowCache.get(key);
    if (cached) return cached;

    const rendered = render();
    if (this.cursorlessRowCache.size >= 10_000) {
      this.cursorlessRowCache.clear();
    }
    this.cursorlessRowCache.set(key, rendered);
    return rendered;
  }

  private getCachedGapLine(label: string, width: number): string {
    const key = `${width}\u001f${label}`;
    const cached = this.gapLineCache.get(key);
    if (cached) return cached;

    const rendered = centerAnsiText(this.theme.fg("muted", label), width);
    if (this.gapLineCache.size >= 1_000) {
      this.gapLineCache.clear();
    }
    this.gapLineCache.set(key, rendered);
    return rendered;
  }

  private buildKeymap(layout: ViewerLayout): Map<string, () => boolean> {
    const { kb } = this;
    const actionDefs: Array<[string[] | false, () => boolean]> = [
      [kb.scrollUp, () => this.setScrollOffset(this.scrollOffset - 1)],
      [kb.scrollDown, () => this.setScrollOffset(this.scrollOffset + 1)],
      [
        kb.pageUp,
        () => this.setScrollOffset(this.scrollOffset - layout.viewportHeight),
      ],
      [
        kb.pageDown,
        () => this.setScrollOffset(this.scrollOffset + layout.viewportHeight),
      ],
      [kb.scrollTop, () => this.setScrollOffset(0)],
      [kb.scrollBottom, () => this.setScrollOffset(layout.maxScrollOffset)],
      [kb.nextHunk, () => this.jumpToHunk(layout.currentHunkIndex + 1)],
      [kb.prevHunk, () => this.jumpToHunk(layout.currentHunkIndex - 1)],
      [kb.contextLess, () => this.adjustContext(-1)],
      [kb.contextMore, () => this.adjustContext(1)],
      [kb.toggleMode, () => this.toggleMode()],
      [kb.toggleWrap, () => this.toggleWrap()],
    ];
    const keymap = new Map<string, () => boolean>();
    for (const [binding, action] of actionDefs) {
      if (!binding) continue;
      for (const key of binding) keymap.set(key, action);
    }
    return keymap;
  }

  private resolveAction(
    data: string,
    layout: ViewerLayout,
  ): (() => boolean) | undefined {
    const keymap = this.buildKeymap(layout);
    // 单字母键严格区分大小写(y 与 Y 是两个键);组合键交 matchesKey。
    const direct = keymap.get(data);
    if (direct) return direct;
    for (const [key, action] of keymap) {
      if (key.includes("+") || key.length > 1) {
        if (matchesKey(data, key as KeyId)) return action;
      }
    }
    return undefined;
  }

  private getLineNumberWidth(): number {
    if (!this.diffModel) return 4;
    return Math.max(
      1,
      String(
        Math.max(this.diffModel.totalOldLines, this.diffModel.totalNewLines, 1),
      ).length,
    );
  }

  private getSplitLayout(width: number): {
    leftWidth: number;
    rightWidth: number;
    gutterText: string;
    gutterWidth: number;
  } {
    const gutterText = this.theme.fg("borderMuted", " │ ");
    const gutterWidth = 3;
    const leftWidth = Math.floor((width - gutterWidth) / 2);
    const rightWidth = width - gutterWidth - leftWidth;
    return { leftWidth, rightWidth, gutterText, gutterWidth };
  }

  private canRenderSplit(width: number): boolean {
    if (!this.diffModel) return false;
    const split = this.getSplitLayout(width);
    return (
      split.leftWidth >= MIN_SPLIT_COLUMN_WIDTH &&
      split.rightWidth >= MIN_SPLIT_COLUMN_WIDTH
    );
  }

  private getEffectiveMode(width: number): ViewMode {
    if (this.preferredMode === "split" && this.canRenderSplit(width))
      return "split";
    return "unified";
  }

  private getViewportHunkFocusOffset(
    scrollOffset: number,
    viewportHeight: number,
  ): number {
    return Math.max(
      0,
      scrollOffset + Math.floor(Math.max(0, viewportHeight) / 4),
    );
  }

  private getCurrentHunkIndex(
    hunkOffsets: number[],
    focusOffset: number,
  ): number {
    if (hunkOffsets.length === 0) return 0;
    let current = 0;
    for (let i = 0; i < hunkOffsets.length; i++) {
      if (focusOffset >= (hunkOffsets[i] ?? 0)) current = i;
      else break;
    }
    return current;
  }

  private getNavigationDiff(): StructuredDiff | undefined {
    return this.baseDiffModel ?? this.diffModel;
  }

  private formatHunkLabel(
    currentHunkIndex: number,
    totalHunks: number,
  ): string {
    const navigationDiff = this.getNavigationDiff();
    if (!navigationDiff || totalHunks === 0) return "Hunk: none";
    const hunk =
      navigationDiff.hunks[clampNumber(currentHunkIndex, 0, totalHunks - 1)];
    const newRange =
      hunk.newStartLine === undefined
        ? undefined
        : hunk.newStartLine === hunk.newEndLine
          ? hunk.newStartLine.toLocaleString()
          : `${hunk.newStartLine.toLocaleString()}-${(hunk.newEndLine ?? hunk.newStartLine).toLocaleString()}`;
    const oldRange =
      hunk.oldStartLine === undefined
        ? undefined
        : hunk.oldStartLine === hunk.oldEndLine
          ? hunk.oldStartLine.toLocaleString()
          : `${hunk.oldStartLine.toLocaleString()}-${(hunk.oldEndLine ?? hunk.oldStartLine).toLocaleString()}`;
    const anchor = newRange
      ? `new ${newRange}`
      : oldRange
        ? `old ${oldRange}`
        : "mixed";
    return `Hunk ${currentHunkIndex + 1}/${totalHunks} @ ${anchor}`;
  }

  private buildHeaderLines(
    width: number,
    mode: ViewMode,
    currentHunkIndex: number,
    totalHunks: number,
  ): string[] {
    const modeLabel = this.preferredMode === mode ? mode : `${mode} (auto)`;
    const diffLine = [
      `${this.theme.fg("muted", t("ui.diff", "Diff:"))} ${this.theme.fg("success", `+${this.preview.additions}`)} ${this.theme.fg("dim", "/")} ${this.theme.fg("error", `-${this.preview.deletions}`)}`,
      this.theme.fg(
        "muted",
        this.formatHunkLabel(currentHunkIndex, totalHunks),
      ),
      `${this.theme.fg("muted", t("ui.view", "View:"))} ${this.theme.fg("text", modeLabel)}`,
      `${this.theme.fg("muted", t("ui.context", "Context:"))} ${this.theme.fg("text", this.diffModel ? String(this.inlineEditMode ? "all" : this.contextLines) : "—")}`,
      `${this.theme.fg("muted", t("ui.wrap", "Wrap:"))} ${this.theme.fg("text", this.wrapLongLines ? "on" : "off")}`,
    ].join(` ${this.theme.fg("dim", "•")} `);
    const displayPath = formatDisplayPath(
      this.preview.path,
      this.pathStyle,
      this.cwd,
    );
    const toolAndPath = `${this.theme.fg("muted", t("ui.tool", "Tool:"))} ${this.theme.fg("text", normalizeTuiText(this.preview.toolName))} ${this.theme.fg("dim", "•")} ${this.theme.fg("muted", t("ui.path", "Path:"))} ${this.theme.fg("text", normalizeTuiText(displayPath))}`;
    const summaryLine = this.preview.previewError
      ? this.theme.fg(
          "warning",
          t(
            "ui.previewWarning",
            `Preview warning: ${normalizeTuiText(this.preview.previewError)}`,
            { message: normalizeTuiText(this.preview.previewError) },
          ),
        )
      : this.theme.fg("dim", summarizeLines(this.preview.summaryLines));
    const title = this.inlineEditMode
      ? t("ui.titleEdit", "Review proposed file change · INLINE EDIT")
      : t("ui.title", "Review proposed file change");

    return [
      truncateToWidth(
        this.theme.bold(this.theme.fg("accent", title)),
        width,
        "",
        false,
      ),
      truncateToWidth(toolAndPath, width, this.theme.fg("muted", "…"), false),
      truncateToWidth(diffLine, width, this.theme.fg("muted", "…"), false),
      truncateToWidth(summaryLine, width, this.theme.fg("muted", "…"), false),
    ];
  }

  private buildColumnLines(width: number, mode: ViewMode): string[] {
    if (mode !== "split") return [];
    const split = this.getSplitLayout(width);
    const leftHeader = truncateToWidth(
      this.theme.bold(this.theme.fg("muted", t("ui.original", "Original"))),
      split.leftWidth,
      "",
      true,
    );
    const rightTitle = this.inlineEditMode
      ? this.theme.fg("accent", t("ui.updatedEditing", "Updated (editing)"))
      : this.theme.fg("muted", t("ui.updated", "Updated"));
    const rightHeader = truncateToWidth(
      this.theme.bold(rightTitle),
      split.rightWidth,
      "",
      true,
    );
    const divider = this.theme.fg(
      "borderMuted",
      `${"─".repeat(split.leftWidth)}─┼─${"─".repeat(split.rightWidth)}`,
    );
    return [leftHeader + split.gutterText + rightHeader, divider];
  }

  private buildFooterLines(width: number, mode: ViewMode): string[] {
    const { kb } = this;
    const keyLabel = (key: string): string => {
      const labels: Record<string, string> = {
        up: "↑",
        down: "↓",
        left: "←",
        right: "→",
        pageup: "PgUp",
        pagedown: "PgDn",
        home: "Home",
        end: "End",
        escape: "Esc",
        tab: "Tab",
      };
      // 单字母键显示保留配置原文大小写(g 与 G 是两个不同的键)。
      return labels[key] ?? key;
    };
    // 帮助信息只显示每个 action 的第一个快捷键(有多个时)。
    const formatBinding = (binding: string[]): string | null => {
      if (binding.length === 0) return null;
      return keyLabel(binding[0]);
    };
    const fmt = (binding: string[], label: string): string | null => {
      const keys = formatBinding(binding);
      return keys ? `${keys} ${label}` : null;
    };
    const fmtPair = (
      first: string[],
      second: string[],
      label: string,
    ): string | null => {
      const firstKeys = formatBinding(first);
      const secondKeys = formatBinding(second);
      return firstKeys && secondKeys
        ? `${firstKeys}/${secondKeys} ${label}`
        : null;
    };
    const hasHunks = (this.getNavigationDiff()?.hunks.length ?? 0) > 0;
    const hasStructuredDiff = Boolean(this.baseDiffModel);

    const parts: string[] = [
      hasHunks ? fmt(kb.prevHunk, "prev") : null,
      hasHunks ? fmt(kb.nextHunk, "next") : null,
      fmtPair(kb.scrollUp, kb.scrollDown, "scroll"),
      fmtPair(kb.pageUp, kb.pageDown, "jump"),
      fmtPair(kb.scrollTop, kb.scrollBottom, "edges"),
      hasStructuredDiff
        ? fmtPair(kb.contextLess, kb.contextMore, "ctx-/+")
        : null,
      hasStructuredDiff ? fmt(kb.toggleMode, "split/unified") : null,
      fmt(kb.toggleWrap, "wrap"),
    ].filter((part): part is string => part !== null);
    return [
      truncateToWidth(
        this.theme.fg("dim", parts.join(" • ")),
        width,
        "",
        false,
      ),
    ];
  }

  private wrapStyledText(text: string, width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (text.length === 0) return [""];
    if (!this.wrapLongLines) {
      return [
        truncateToWidth(text, safeWidth, this.theme.fg("muted", "…"), false),
      ];
    }
    const wrapped = wrapTextWithAnsi(text, safeWidth).map((line) =>
      truncateToWidth(line, safeWidth, "", false),
    );
    return wrapped.length > 0 ? wrapped : [""];
  }

  private getBackgroundAnsiForTone(tone: DiffTone): string | undefined {
    if (tone === "toolDiffContext") return undefined;
    return this.diffBackgrounds[tone];
  }

  private getInlineBackgroundAnsiForTone(tone: DiffTone): string | undefined {
    if (tone === "toolDiffContext") return undefined;
    return this.diffInlineBackgrounds[tone];
  }

  private applyInlineHighlight(text: string, tone: DiffTone): string {
    const inlineBackgroundAnsi = this.getInlineBackgroundAnsiForTone(tone);
    if (!inlineBackgroundAnsi) return this.theme.bold(text);

    const baseBackgroundAnsi =
      this.getBackgroundAnsiForTone(tone) ?? "\x1b[49m";
    return `${inlineBackgroundAnsi}${this.theme.bold(text)}${baseBackgroundAnsi}`;
  }

  private getForegroundForTone(tone: DiffTone): "text" | "toolDiffContext" {
    return tone === "toolDiffContext" ? "toolDiffContext" : "text";
  }

  private applyLineBackground(text: string, tone: DiffTone): string {
    const backgroundAnsi = this.getBackgroundAnsiForTone(tone);
    return backgroundAnsi ? `${backgroundAnsi}${text}\x1b[49m` : text;
  }

  private getSyntaxSegments(text: string): SyntaxSegment[] {
    if (!this.syntaxLanguage || text.trim().length === 0) return [{ text }];
    const cached = this.syntaxLineCache.get(text);
    if (cached) return cached;

    const segments = tokenizeSyntaxLine(text, this.syntaxLanguage);
    this.syntaxLineCache.set(text, segments);
    return segments;
  }

  private static readonly TOKEN_TO_THEME: Record<string, string> = {
    keyword: "syntaxKeyword",
    literal: "syntaxNumber",
    "meta-keyword": "syntaxKeyword",
    built_in: "syntaxType",
    type: "syntaxType",
    class: "syntaxType",
    name: "syntaxType",
    string: "syntaxString",
    regexp: "syntaxString",
    "meta-string": "syntaxString",
    link: "syntaxString",
    code: "syntaxString",
    number: "syntaxNumber",
    symbol: "syntaxNumber",
    comment: "syntaxComment",
    doctag: "syntaxComment",
    quote: "syntaxComment",
    function: "syntaxFunction",
    title: "syntaxFunction",
    attr: "syntaxVariable",
    attribute: "syntaxVariable",
    variable: "syntaxVariable",
    "template-variable": "syntaxVariable",
    params: "syntaxVariable",
    operator: "syntaxOperator",
    punctuation: "syntaxPunctuation",
    meta: "syntaxKeyword",
    tag: "syntaxKeyword",
    "selector-tag": "syntaxType",
    "selector-id": "syntaxKeyword",
    "selector-pseudo": "syntaxKeyword",
    "selector-class": "syntaxFunction",
    "selector-attr": "syntaxVariable",
    addition: "syntaxString",
    deletion: "syntaxVariable",
    "template-tag": "syntaxKeyword",
    "builtin-name": "syntaxType",
    section: "syntaxType",
    bullet: "syntaxNumber",
    emphasis: "syntaxVariable",
    strong: "syntaxVariable",
    formula: "syntaxNumber",
    subst: "syntaxOperator",
  };

  private styleSyntaxSegment(
    text: string,
    tone: DiffTone,
    token: SyntaxSegment["token"],
    highlighted: boolean,
    useInlineBackground: boolean,
  ): string {
    const themeToken = token
      ? (this.constructor as typeof DiffViewer).TOKEN_TO_THEME[token]
      : undefined;
    const styled = themeToken
      ? this.theme.fg(themeToken, text)
      : this.theme.fg(this.getForegroundForTone(tone), text);

    if (!highlighted) return styled;
    return useInlineBackground
      ? this.applyInlineHighlight(styled, tone)
      : this.theme.bold(styled);
  }

  private styleDiffText(
    text: string,
    ranges: InlineRange[],
    tone: DiffTone,
    cursorCol?: number,
  ): string {
    const safeText = normalizeTuiText(text);
    const chars = Array.from(safeText);
    const clampedCursorCol =
      cursorCol === undefined
        ? undefined
        : clampNumber(cursorCol, 0, chars.length);
    if (safeText.length === 0) {
      if (clampedCursorCol === undefined) return "";
      return this.inlineEditMode
        ? CURSOR_MARKER
        : `${INLINE_CURSOR_OPEN} ${INLINE_CURSOR_CLOSE}`;
    }

    const safeRanges = ranges
      .map((range) => ({
        start: clampNumber(range.start, 0, chars.length),
        end: clampNumber(range.end, 0, chars.length),
      }))
      .filter((range) => range.end > range.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const highlightedCharCount = safeRanges.reduce(
      (total, range) => total + range.end - range.start,
      0,
    );
    const useInlineHighlightBackground =
      highlightedCharCount > 0 &&
      highlightedCharCount < chars.length * INLINE_HIGHLIGHT_MAX_CHANGED_RATIO;

    const syntaxSegments = this.getSyntaxSegments(safeText);
    const syntaxRanges: Array<{
      start: number;
      end: number;
      token: SyntaxSegment["token"];
    }> = [];
    let syntaxCursor = 0;

    for (const segment of syntaxSegments) {
      const segmentLength = Array.from(segment.text).length;
      if (segmentLength === 0) continue;
      syntaxRanges.push({
        start: syntaxCursor,
        end: syntaxCursor + segmentLength,
        token: segment.token,
      });
      syntaxCursor += segmentLength;
    }

    const boundaries = new Set<number>([0, chars.length]);
    for (const range of safeRanges) {
      boundaries.add(range.start);
      boundaries.add(range.end);
    }
    for (const range of syntaxRanges) {
      boundaries.add(range.start);
      boundaries.add(range.end);
    }
    if (clampedCursorCol !== undefined && clampedCursorCol < chars.length) {
      boundaries.add(clampedCursorCol);
      boundaries.add(clampedCursorCol + 1);
    }

    const orderedBoundaries = [...boundaries].sort((a, b) => a - b);
    let syntaxIndex = 0;
    let highlightIndex = 0;
    let output = "";

    for (let i = 0; i < orderedBoundaries.length - 1; i++) {
      const start = orderedBoundaries[i];
      const end = orderedBoundaries[i + 1];
      if (end <= start) continue;

      while (
        syntaxIndex < syntaxRanges.length &&
        start >= syntaxRanges[syntaxIndex].end
      )
        syntaxIndex++;
      while (
        highlightIndex < safeRanges.length &&
        start >= safeRanges[highlightIndex].end
      )
        highlightIndex++;

      const token =
        syntaxIndex < syntaxRanges.length &&
        start >= syntaxRanges[syntaxIndex].start &&
        start < syntaxRanges[syntaxIndex].end
          ? syntaxRanges[syntaxIndex].token
          : undefined;
      const highlighted =
        highlightIndex < safeRanges.length &&
        start >= safeRanges[highlightIndex].start &&
        start < safeRanges[highlightIndex].end;

      const segmentText = sliceChars(safeText, start, end);
      if (
        clampedCursorCol !== undefined &&
        start === clampedCursorCol &&
        end === clampedCursorCol + 1
      ) {
        output += `${this.inlineEditMode ? CURSOR_MARKER : ""}${INLINE_CURSOR_OPEN}${segmentText || " "}${INLINE_CURSOR_CLOSE}`;
        continue;
      }

      output += this.styleSyntaxSegment(
        segmentText,
        tone,
        token,
        highlighted,
        highlighted && useInlineHighlightBackground,
      );
    }

    if (clampedCursorCol !== undefined && clampedCursorCol === chars.length) {
      output += this.inlineEditMode
        ? CURSOR_MARKER
        : `${INLINE_CURSOR_OPEN} ${INLINE_CURSOR_CLOSE}`;
    }

    return output;
  }

  private getCellPrefixWidth(lineNumberWidth: number): number {
    return lineNumberWidth + 2 + (this.showDiffRail ? 1 : 0);
  }

  private getRailColorToken(tone: DiffTone): "success" | "error" | "muted" {
    if (tone === "toolDiffAdded") return "success";
    if (tone === "toolDiffRemoved") return "error";
    return "muted";
  }

  private buildRailMarker(tone: DiffTone): string {
    if (!this.showDiffRail) return "";
    return this.theme.fg(this.getRailColorToken(tone), DIFF_RAIL_MARKER);
  }

  private buildCellPrefix(
    sign: string,
    lineNumber: number | undefined,
    lineNumberWidth: number,
    tone: DiffTone,
  ): string {
    const numberText =
      lineNumber === undefined
        ? "".padStart(lineNumberWidth, " ")
        : String(lineNumber).padStart(lineNumberWidth, " ");
    const foreground = this.getForegroundForTone(tone);
    const isChangedLine = tone !== "toolDiffContext";
    const signText =
      sign.trim().length === 0
        ? sign
        : this.theme.bold(this.theme.fg(foreground, sign));
    const numberStyle = isChangedLine
      ? this.theme.bold(this.theme.fg(foreground, numberText))
      : this.theme.fg("muted", numberText);
    return `${this.buildRailMarker(tone)}${signText}${numberStyle} `;
  }

  private buildCellContinuationPrefix(
    lineNumberWidth: number,
    tone: DiffTone,
  ): string {
    return `${this.buildRailMarker(tone)}${" ".repeat(lineNumberWidth + 2)}`;
  }

  private renderEmptySplitCell(
    cellWidth: number,
    lineNumberWidth: number,
  ): RenderedCell {
    if (!this.showDiffRail) {
      return { lines: [" ".repeat(cellWidth)] };
    }

    const prefixWidth = this.getCellPrefixWidth(lineNumberWidth);
    const prefix = this.buildCellPrefix(
      " ",
      undefined,
      lineNumberWidth,
      "toolDiffContext",
    );
    const fill = " ".repeat(Math.max(0, cellWidth - prefixWidth));
    return { lines: [truncateToWidth(prefix + fill, cellWidth, "", true)] };
  }

  private getCursorColForRow(
    row: StructuredDiffRow,
    side: "old" | "new",
  ): number | undefined {
    // 内联编辑已裁剪(永不激活),直接无光标
    return undefined;
  }

  private renderSplitCell(
    row: StructuredDiffRow,
    side: "old" | "new",
    cellWidth: number,
    lineNumberWidth: number,
    cursorCol?: number,
  ): RenderedCell {
    const prefixWidth = this.getCellPrefixWidth(lineNumberWidth);
    const contentWidth = Math.max(1, cellWidth - prefixWidth);
    let sign = " ";
    let tone: DiffTone = "toolDiffContext";
    let lineNumber: number | undefined;
    let text = "";
    let highlights: InlineRange[] = [];

    if (side === "old") {
      lineNumber = row.oldLineNumber;
      text = row.oldText;
      highlights = row.oldHighlights;
      if (row.kind === "delete" || row.kind === "replace") {
        sign = "-";
        tone = "toolDiffRemoved";
      }
    } else {
      lineNumber = row.newLineNumber;
      text = row.newText;
      highlights = row.newHighlights;
      if (row.kind === "insert" || row.kind === "replace") {
        sign = "+";
        tone = "toolDiffAdded";
      }
    }

    if (
      lineNumber === undefined &&
      text.length === 0 &&
      cursorCol === undefined
    ) {
      return this.renderEmptySplitCell(cellWidth, lineNumberWidth);
    }

    const styledText = this.styleDiffText(text, highlights, tone, cursorCol);
    const wrapped = this.wrapStyledText(styledText, contentWidth);
    const result: string[] = [];
    let cursorLineIndex: number | undefined;

    for (let i = 0; i < wrapped.length; i++) {
      const prefix =
        i === 0
          ? this.buildCellPrefix(sign, lineNumber, lineNumberWidth, tone)
          : this.buildCellContinuationPrefix(lineNumberWidth, tone);
      const line = truncateToWidth(prefix + wrapped[i], cellWidth, "", true);
      if (cursorLineIndex === undefined && line.includes(CURSOR_MARKER))
        cursorLineIndex = i;
      result.push(this.applyLineBackground(line, tone));
    }

    return {
      lines: result.length > 0 ? result : [" ".repeat(cellWidth)],
      cursorLineIndex,
    };
  }

  private renderSplitRowWithCursor(
    row: StructuredDiffRow,
    leftWidth: number,
    rightWidth: number,
    gutterText: string,
    lineNumberWidth: number,
    cursorCol?: number,
  ): RenderedCell {
    const leftCell = this.renderSplitCell(
      row,
      "old",
      leftWidth,
      lineNumberWidth,
    );
    const rightCell = this.renderSplitCell(
      row,
      "new",
      rightWidth,
      lineNumberWidth,
      cursorCol,
    );
    const total = Math.max(leftCell.lines.length, rightCell.lines.length);
    const lines: string[] = [];

    for (let i = 0; i < total; i++) {
      const leftLine =
        leftCell.lines.at(i) ??
        this.renderEmptySplitCell(leftWidth, lineNumberWidth).lines.at(0) ??
        "";
      const rightLine =
        rightCell.lines.at(i) ??
        this.renderEmptySplitCell(rightWidth, lineNumberWidth).lines.at(0) ??
        "";
      const left = truncateToWidth(leftLine, leftWidth, "", true);
      const right = truncateToWidth(rightLine, rightWidth, "", true);
      lines.push(left + gutterText + right);
    }

    return { lines, cursorLineIndex: rightCell.cursorLineIndex };
  }

  private renderSplitRow(
    row: StructuredDiffRow,
    leftWidth: number,
    rightWidth: number,
    gutterText: string,
    lineNumberWidth: number,
  ): RenderedCell {
    return this.renderSplitRowWithCursor(
      row,
      leftWidth,
      rightWidth,
      gutterText,
      lineNumberWidth,
      this.getCursorColForRow(row, "new"),
    );
  }

  private renderUnifiedLine(
    sign: " " | "+" | "-",
    lineNumber: number | undefined,
    text: string,
    tone: DiffTone,
    highlights: InlineRange[],
    width: number,
    lineNumberWidth: number,
    cursorCol?: number,
  ): RenderedCell {
    const prefixWidth = this.getCellPrefixWidth(lineNumberWidth);
    const contentWidth = Math.max(1, width - prefixWidth);
    const styledText = this.styleDiffText(text, highlights, tone, cursorCol);
    const wrapped = this.wrapStyledText(styledText, contentWidth);
    const lines: string[] = [];
    let cursorLineIndex: number | undefined;

    for (let i = 0; i < wrapped.length; i++) {
      const prefix =
        i === 0
          ? this.buildCellPrefix(sign, lineNumber, lineNumberWidth, tone)
          : this.buildCellContinuationPrefix(lineNumberWidth, tone);
      const line = truncateToWidth(prefix + wrapped[i], width, "", true);
      if (cursorLineIndex === undefined && line.includes(CURSOR_MARKER))
        cursorLineIndex = i;
      lines.push(this.applyLineBackground(line, tone));
    }

    return {
      lines: lines.length > 0 ? lines : [" ".repeat(width)],
      cursorLineIndex,
    };
  }

  private renderUnifiedRowWithCursor(
    row: StructuredDiffRow,
    width: number,
    lineNumberWidth: number,
    cursorCol?: number,
  ): RenderedCell {
    if (row.kind === "equal") {
      return this.renderUnifiedLine(
        " ",
        row.oldLineNumber,
        row.oldText,
        "toolDiffContext",
        [],
        width,
        lineNumberWidth,
        cursorCol,
      );
    }
    if (row.kind === "delete") {
      return this.renderUnifiedLine(
        "-",
        row.oldLineNumber,
        row.oldText,
        "toolDiffRemoved",
        row.oldHighlights,
        width,
        lineNumberWidth,
      );
    }
    if (row.kind === "insert") {
      return this.renderUnifiedLine(
        "+",
        row.newLineNumber,
        row.newText,
        "toolDiffAdded",
        row.newHighlights,
        width,
        lineNumberWidth,
        cursorCol,
      );
    }

    const removed = this.renderUnifiedLine(
      "-",
      row.oldLineNumber,
      row.oldText,
      "toolDiffRemoved",
      row.oldHighlights,
      width,
      lineNumberWidth,
    );
    const added = this.renderUnifiedLine(
      "+",
      row.newLineNumber,
      row.newText,
      "toolDiffAdded",
      row.newHighlights,
      width,
      lineNumberWidth,
      cursorCol,
    );
    return {
      lines: [...removed.lines, ...added.lines],
      cursorLineIndex:
        added.cursorLineIndex === undefined
          ? undefined
          : removed.lines.length + added.cursorLineIndex,
    };
  }

  private renderUnifiedRow(
    row: StructuredDiffRow,
    width: number,
    lineNumberWidth: number,
  ): RenderedCell {
    return this.renderUnifiedRowWithCursor(
      row,
      width,
      lineNumberWidth,
      this.getCursorColForRow(row, "new"),
    );
  }

  private renderGapLine(label: string, width: number): string {
    return this.getCachedGapLine(label, width);
  }

  private getRenderedDiffCache(
    width: number,
    mode: ViewMode,
  ): RenderedDiffCache | undefined {
    if (!this.diffModel) return undefined;

    const lineNumberWidth = this.getLineNumberWidth();
    const cacheKey = [
      this.getDiffModelCacheId(this.diffModel),
      mode,
      width,
      lineNumberWidth,
      this.wrapLongLines ? "wrap" : "nowrap",
      this.showDiffRail ? "rail" : "no-rail",
    ].join("|");
    if (this.lastRenderedDiffCache?.key === cacheKey) {
      return this.lastRenderedDiffCache.value;
    }

    const navigationDiff = this.getNavigationDiff() ?? this.diffModel;
    const navigationHunks = navigationDiff.hunks;
    const lines: string[] = [];
    const hunkOffsets: number[] = new Array<number>(
      navigationHunks.length,
    ).fill(0);
    const rowSpans: Array<RenderedRowSpan | undefined> = new Array<
      RenderedRowSpan | undefined
    >(this.diffModel.rows.length);
    const rowIndexByNewLine: number[] = new Array<number>(
      this.diffModel.totalNewLines + 1,
    );
    let nextHunkIndex = 0;

    const split = mode === "split" ? this.getSplitLayout(width) : undefined;

    for (const item of this.diffModel.visibleItems) {
      if (item.type === "row") {
        while (
          nextHunkIndex < navigationHunks.length &&
          navigationHunks[nextHunkIndex].changeStartRow === item.fullRowIndex
        ) {
          hunkOffsets[nextHunkIndex] = lines.length;
          nextHunkIndex++;
        }

        const rowStartOffset = lines.length;
        const rendered =
          mode === "split" && split
            ? this.getCachedCursorlessRow(
                this.getCursorlessRowCacheKey(
                  mode,
                  item.row,
                  width,
                  lineNumberWidth,
                  split,
                ),
                () =>
                  this.renderSplitRowWithCursor(
                    item.row,
                    split.leftWidth,
                    split.rightWidth,
                    split.gutterText,
                    lineNumberWidth,
                  ),
              )
            : this.getCachedCursorlessRow(
                this.getCursorlessRowCacheKey(
                  mode,
                  item.row,
                  width,
                  lineNumberWidth,
                ),
                () =>
                  this.renderUnifiedRowWithCursor(
                    item.row,
                    width,
                    lineNumberWidth,
                  ),
              );

        rowSpans[item.fullRowIndex] = {
          startOffset: rowStartOffset,
          lineCount: rendered.lines.length,
        };
        if (item.row.newLineNumber !== undefined) {
          rowIndexByNewLine[item.row.newLineNumber] = item.fullRowIndex;
        }
        lines.push(...rendered.lines);
        continue;
      }

      lines.push(this.renderGapLine(item.label, width));
    }

    for (let i = nextHunkIndex; i < hunkOffsets.length; i++) {
      hunkOffsets[i] = lines.length;
    }

    const value = { lines, hunkOffsets, rowSpans, rowIndexByNewLine };
    this.lastRenderedDiffCache = { key: cacheKey, value };
    return value;
  }

  private getCursorOverlay(
    width: number,
    mode: ViewMode,
    content: RenderedDiffCache,
  ): { cursorOffset?: number; cursorOverlay?: CursorOverlay } {
    // 内联编辑已裁剪(永不激活),不渲染光标浮层
    return {};
  }

  private buildStructuredContent(
    width: number,
    mode: ViewMode,
  ): RenderedContent {
    const content = this.getRenderedDiffCache(width, mode);
    if (!content) return { lines: [], hunkOffsets: [] };

    const { cursorOffset, cursorOverlay } = this.getCursorOverlay(
      width,
      mode,
      content,
    );
    return {
      lines: content.lines,
      hunkOffsets: content.hunkOffsets,
      cursorOffset,
      cursorOverlay,
    };
  }

  private stylePlainTextLine(line: string): string {
    const safe = normalizeTuiText(line);
    if (safe.startsWith("+"))
      return this.applyLineBackground(
        this.theme.fg("text", safe),
        "toolDiffAdded",
      );
    if (safe.startsWith("-"))
      return this.applyLineBackground(
        this.theme.fg("text", safe),
        "toolDiffRemoved",
      );
    if (safe.startsWith(" ")) return this.theme.fg("toolDiffContext", safe);
    return this.theme.fg("text", safe);
  }

  private buildPlainTextContent(width: number): RenderedContent {
    const lines: string[] = [];
    for (const rawLine of (this.preview.diff || "(No visible diff)").split(
      "\n",
    )) {
      const wrapped = this.wrapStyledText(
        this.stylePlainTextLine(rawLine),
        width,
      );
      lines.push(...wrapped);
    }
    return { lines: lines.length > 0 ? lines : [""], hunkOffsets: [] };
  }

  private buildContent(width: number, mode: ViewMode): RenderedContent {
    if (this.diffModel) return this.buildStructuredContent(width, mode);
    return this.buildPlainTextContent(width);
  }

  private buildLayout(width: number): ViewerLayout {
    const safeWidth = Math.max(20, width);
    const mode = this.getEffectiveMode(safeWidth);
    const columnLines = this.buildColumnLines(safeWidth, mode);
    const footerLines = this.buildFooterLines(safeWidth, mode);
    const content = this.buildContent(safeWidth, mode);
    const provisionalHeaderLines = this.buildHeaderLines(
      safeWidth,
      mode,
      0,
      content.hunkOffsets.length,
    );
    const terminalRows = this.tui.terminal?.rows ?? 24;
    const chrome =
      provisionalHeaderLines.length +
      columnLines.length +
      footerLines.length +
      2;
    const rowBasedViewport = Math.max(4, terminalRows - chrome);
    // 缺省(无 maxHeight)按终端可视行填满,保留 4 行最小可用视口;
    // 显式预算时严格不超高:bottom 锚定的 overlay 总高超过终端会被合成丢弃
    // (决策区与下边框),故 viewportHeight 直接吃满剩余预算,预算紧张时允许
    // 视口矮于 4 行也要保住下边框。
    const viewportHeight =
      this.maxHeight === undefined
        ? rowBasedViewport
        : Math.max(1, this.maxHeight - chrome);
    const maxScrollOffset = Math.max(0, content.lines.length - viewportHeight);
    let nextScrollOffset = this.scrollOffset;
    if (this.inlineEditMode && content.cursorOffset !== undefined) {
      const desiredTop = Math.max(
        0,
        content.cursorOffset - Math.floor(viewportHeight / 3),
      );
      if (
        content.cursorOffset < nextScrollOffset ||
        content.cursorOffset >= nextScrollOffset + viewportHeight
      ) {
        nextScrollOffset = desiredTop;
      }
    }
    const clampedOffset = clampNumber(nextScrollOffset, 0, maxScrollOffset);
    const derivedCurrentHunkIndex =
      this.inlineEditMode && content.cursorOffset !== undefined
        ? this.getCurrentHunkIndex(content.hunkOffsets, content.cursorOffset)
        : this.getCurrentHunkIndex(
            content.hunkOffsets,
            this.getViewportHunkFocusOffset(clampedOffset, viewportHeight),
          );
    const currentHunkIndex =
      !this.inlineEditMode && content.hunkOffsets.length > 0
        ? clampNumber(
            this.selectedHunkIndex ?? derivedCurrentHunkIndex,
            0,
            content.hunkOffsets.length - 1,
          )
        : derivedCurrentHunkIndex;
    const headerLines = this.buildHeaderLines(
      safeWidth,
      mode,
      currentHunkIndex,
      content.hunkOffsets.length,
    );

    return {
      width: safeWidth,
      mode,
      headerLines,
      columnLines,
      footerLines,
      contentLines: content.lines,
      hunkOffsets: content.hunkOffsets,
      viewportHeight,
      maxScrollOffset,
      scrollOffset: clampedOffset,
      currentHunkIndex,
      cursorOverlay: content.cursorOverlay,
    };
  }

  private setScrollOffset(nextOffset: number): boolean {
    const layout = this.buildLayout(this.lastWidth);
    const clampedOffset = clampNumber(nextOffset, 0, layout.maxScrollOffset);
    const derivedHunkIndex = this.getCurrentHunkIndex(
      layout.hunkOffsets,
      this.getViewportHunkFocusOffset(clampedOffset, layout.viewportHeight),
    );
    const nextSelectedHunkIndex =
      !this.inlineEditMode && layout.hunkOffsets.length > 0
        ? derivedHunkIndex
        : undefined;
    const selectionChanged = nextSelectedHunkIndex !== this.selectedHunkIndex;
    if (clampedOffset === this.scrollOffset && !selectionChanged) return false;
    this.scrollOffset = clampedOffset;
    if (!this.inlineEditMode) {
      this.selectedHunkIndex = nextSelectedHunkIndex;
    }
    return true;
  }

  private jumpToHunk(targetHunkIndex: number): boolean {
    const layout = this.buildLayout(this.lastWidth);
    if (layout.hunkOffsets.length === 0) return false;
    const safeTarget = clampNumber(
      targetHunkIndex,
      0,
      layout.hunkOffsets.length - 1,
    );
    const anchor = layout.hunkOffsets[safeTarget] ?? 0;
    const nextOffset = clampNumber(
      anchor - Math.floor(layout.viewportHeight / 4),
      0,
      layout.maxScrollOffset,
    );
    const selectionChanged = this.selectedHunkIndex !== safeTarget;
    if (nextOffset === this.scrollOffset && !selectionChanged) return false;
    this.selectedHunkIndex = safeTarget;
    this.scrollOffset = nextOffset;
    return true;
  }

  private preserveCurrentHunk(run: () => void): boolean {
    const before = this.buildLayout(this.lastWidth);
    const currentHunkIndex = before.currentHunkIndex;
    const previousOffset = this.scrollOffset;
    run();
    const after = this.buildLayout(this.lastWidth);
    if (after.hunkOffsets.length > 0) {
      const safeTarget = clampNumber(
        currentHunkIndex,
        0,
        after.hunkOffsets.length - 1,
      );
      const anchor = after.hunkOffsets[safeTarget] ?? 0;
      this.scrollOffset = clampNumber(
        anchor - Math.floor(after.viewportHeight / 4),
        0,
        after.maxScrollOffset,
      );
    } else {
      this.scrollOffset = clampNumber(previousOffset, 0, after.maxScrollOffset);
    }
    return true;
  }

  private adjustContext(delta: number): boolean {
    const baseDiffModel = this.baseDiffModel;
    if (!baseDiffModel) return false;
    const nextContextLines = clampNumber(
      this.contextLines + delta,
      MIN_CONTEXT_LINES,
      MAX_CONTEXT_LINES,
    );
    if (nextContextLines === this.contextLines) return false;
    return this.preserveCurrentHunk(() => {
      this.contextLines = nextContextLines;
      this.diffModel = adjustStructuredDiffContext(
        baseDiffModel,
        nextContextLines,
      );
    });
  }

  private toggleMode(): boolean {
    if (!this.baseDiffModel) return false;
    return this.preserveCurrentHunk(() => {
      this.preferredMode = this.preferredMode === "split" ? "unified" : "split";
    });
  }

  private toggleWrap(): boolean {
    return this.preserveCurrentHunk(() => {
      this.wrapLongLines = !this.wrapLongLines;
    });
  }

  handleInput(data: string): boolean {
    const layout = this.buildLayout(this.lastWidth);
    const action = this.resolveAction(data, layout);
    return action ? action() : false;
  }

  render(width: number): string[] {
    this.lastWidth = Math.max(1, width);
    const layout = this.buildLayout(this.lastWidth);
    this.scrollOffset = layout.scrollOffset;

    const visible = layout.contentLines.slice(
      layout.scrollOffset,
      layout.scrollOffset + layout.viewportHeight,
    );
    if (layout.cursorOverlay) {
      for (let i = 0; i < layout.cursorOverlay.lines.length; i++) {
        const absoluteLineIndex = layout.cursorOverlay.startOffset + i;
        if (
          absoluteLineIndex < layout.scrollOffset ||
          absoluteLineIndex >= layout.scrollOffset + layout.viewportHeight
        ) {
          continue;
        }
        visible[absoluteLineIndex - layout.scrollOffset] =
          layout.cursorOverlay.lines[i]!;
      }
    }

    const linesAbove = layout.scrollOffset;
    const linesBelow = Math.max(
      0,
      layout.contentLines.length - (layout.scrollOffset + visible.length),
    );
    const hunkInfo =
      layout.hunkOffsets.length > 0
        ? `hunk ${layout.currentHunkIndex + 1}/${layout.hunkOffsets.length}`
        : "no hunks";
    const topIndicatorText =
      linesAbove > 0
        ? `↑ ${pluralize("more line", linesAbove)} • ${hunkInfo}`
        : `Top of diff • ${hunkInfo}`;
    const bottomIndicatorText =
      linesBelow > 0
        ? `↓ ${pluralize("more line", linesBelow)} • ${hunkInfo}`
        : `Bottom of diff • ${hunkInfo}`;

    const result: string[] = [];
    result.push(...layout.headerLines);
    result.push(...layout.columnLines);
    result.push(
      truncateToWidth(
        this.theme.fg("dim", topIndicatorText),
        layout.width,
        "",
        true,
      ),
    );
    result.push(...visible);
    while (
      result.length <
      layout.headerLines.length +
        layout.columnLines.length +
        1 +
        layout.viewportHeight
    ) {
      result.push(" ".repeat(layout.width));
    }
    result.push(
      truncateToWidth(
        this.theme.fg("dim", bottomIndicatorText),
        layout.width,
        "",
        true,
      ),
    );
    result.push(...layout.footerLines);
    return result;
  }
}
