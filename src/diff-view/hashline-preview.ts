/**
 * Hashline edit preview — 宽松行号预览,供权限 ask 的 diff 审批使用。
 *
 * 语义对齐 `~/wsp/pi-hashline-edit`(RimuruW 版)执行引擎的"非 hash"部分:
 * 行模型、锚点坐标→字符区间、冲突检测、倒序组装均与
 * `src/hashline/apply.ts` / `src/hashline/parse.ts` 保持一致;唯一省略的是
 * 锚点 hash 内容校验(xxh32 上下文哈希)与 stale-anchor 检测。
 *
 * 设计原则:凡是执行引擎必然拒绝的输入(格式错误、越界、冲突、replace_text
 * 不唯一、内容带显示前缀),这里也报错,防止 diff 预览"显示成功"而真实执行
 * 失败;只有"hash 不匹配"(需要完整哈希引擎)是预览不查的——文件已变时预览
 * 行号可能错位,但执行由 hashline 引擎 fail-closed 兜底,不会出现"预览说没变、
 * 实际改了"的方向性错误。
 */

// ─── 形状检测 ────────────────────────────────────────────────────────────

/** hashline 扩展(pi-hashline-edit)以 "edit" 工具名注册,payload 形状: */
export interface HashlinePreviewEdit {
  op?: unknown;
  pos?: unknown;
  end?: unknown;
  lines?: unknown;
  oldText?: unknown;
  newText?: unknown;
}

export interface HashlinePreviewInput {
  path: string;
  edits: HashlinePreviewEdit[];
}

/**
 * 判定是否为 hashline 形状的 edit 输入:edits 非空且每项带字符串 op。
 * 内置 edit 的 single(oldText/newText)与 multi(edits[].oldText/newText)
 * 形状不含 op,不会被误判。
 */
export function isHashlineEditInput(
  input: unknown,
): input is HashlinePreviewInput {
  if (typeof input !== "object" || input === null) return false;
  const record = input as Record<string, unknown>;
  if (typeof record.path !== "string") return false;
  if (!Array.isArray(record.edits) || record.edits.length === 0) return false;
  return record.edits.every(
    (edit) =>
      typeof edit === "object" &&
      edit !== null &&
      typeof (edit as Record<string, unknown>).op === "string",
  );
}

// ─── 锚点解析(宽松) ─────────────────────────────────────────────────────

const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";
const HASH_LENGTH_MIN = 2;
const HASH_LENGTH_MAX = 4;
const HASH_ALPHABET_RE = new RegExp(`^[${NIBBLE_STR}]+$`);

/**
 * 解析 LINE#HASH 锚点并返回行号。容忍前导 ">+-" 与空白,以及可选的
 * ":content" 后缀(与执行引擎的 parseAnchorRef 兼容);校验 hash 的格式
 * (长度 2-4、NIBBLE_STR 字符集,与 DISPLAY_HASH_QUANT 一致——执行端对
 * 违者必报 E_BAD_REF),但不校验 hash 内容是否与文件行匹配(宽松点在于此:
 * 内容匹配需要完整哈希引擎;文件已变时由执行端 fail-closed 兜底)。
 */
export function parseAnchorLine(ref: unknown): number {
  if (typeof ref !== "string") {
    throw new Error(
      `[E_BAD_REF] Invalid line reference. Expected "LINE#HASH" (e.g. "12#VR").`,
    );
  }
  const core = ref.replace(/^\s*[>+-]*\s*/, "").trimEnd();
  const match = /^([0-9]+)\s*#\s*([^\s:]+)(?:\s*:(.*))?$/s.exec(core);
  if (!match) {
    throw new Error(
      `[E_BAD_REF] Invalid line reference "${ref}". Expected "LINE#HASH" (e.g. "12#VR").`,
    );
  }
  const line = Number.parseInt(match[1], 10);
  if (line < 1) {
    throw new Error(
      `[E_BAD_REF] Line number must be >= 1, got ${line} in "${ref}".`,
    );
  }
  const hash = match[2];
  if (
    hash.length < HASH_LENGTH_MIN ||
    hash.length > HASH_LENGTH_MAX ||
    !HASH_ALPHABET_RE.test(hash)
  ) {
    throw new Error(
      `[E_BAD_REF] Invalid line reference "${ref}": hash must be ${HASH_LENGTH_MIN}-${HASH_LENGTH_MAX} characters from ${NIBBLE_STR} (e.g. "12#VR").`,
    );
  }
  return line;
}

// ─── 形状校验(执行引擎必拒绝的输入,预览同样拒绝) ─────────────────────

const KNOWN_OPS = new Set(["replace", "append", "prepend", "replace_text"]);

const DISPLAY_HASH_QUANT = `[${NIBBLE_STR}]{2,4}`;
const DISPLAY_PREFIX_RE = new RegExp(
  `^\\s*(?:\\d+\\s*#\\s*|#\\s*)${DISPLAY_HASH_QUANT}:`,
);
const DISPLAY_PREFIX_PLUS_RE = new RegExp(
  `^\\+\\s*(?:\\d+\\s*#\\s*|#\\s*)${DISPLAY_HASH_QUANT}:`,
);
const DIFF_MINUS_RE = /^-\s*\d+\s{4}/;

/** lines 必须是字符串数组,且不得携带渲染后的 "LINE#HASH:" / diff "+/-" 前缀。 */
function assertLiteralLines(
  edit: HashlinePreviewEdit,
  index: number,
): asserts edit is HashlinePreviewEdit & { lines: string[] } {
  if (
    !Array.isArray(edit.lines) ||
    !edit.lines.every((l) => typeof l === "string")
  ) {
    throw new Error(`Edit ${index} field "lines" must be a string array.`);
  }
  for (const line of edit.lines) {
    if (!line.length) continue;
    if (
      DISPLAY_PREFIX_RE.test(line) ||
      DISPLAY_PREFIX_PLUS_RE.test(line) ||
      DIFF_MINUS_RE.test(line)
    ) {
      throw new Error(
        `[E_INVALID_PATCH] "lines" must contain literal file content, not rendered "LINE#HASH:" or diff "+/-" prefixes. Offending line: ${JSON.stringify(line)}`,
      );
    }
  }
}

function assertAnchorField<K extends "pos" | "end">(
  edit: HashlinePreviewEdit,
  field: K,
): asserts edit is HashlinePreviewEdit & Record<K, string> {
  const value = edit[field];
  if (typeof value !== "string") {
    throw new Error(`Edit field "${field}" must be a string when provided.`);
  }
}

function assertHashlineEditShape(
  edit: HashlinePreviewEdit,
  index: number,
): void {
  const op = edit.op;
  if (typeof op !== "string" || !KNOWN_OPS.has(op)) {
    throw new Error(
      `[E_BAD_OP] Edit ${index} uses unknown op "${String(op)}". Expected "replace", "append", "prepend", or "replace_text".`,
    );
  }
  if (edit.pos !== undefined && typeof edit.pos !== "string") {
    throw new Error(
      `Edit ${index} field "pos" must be a string when provided.`,
    );
  }
  if (edit.end !== undefined && typeof edit.end !== "string") {
    throw new Error(
      `Edit ${index} field "end" must be a string when provided.`,
    );
  }
  if (edit.oldText !== undefined && typeof edit.oldText !== "string") {
    throw new Error(
      `Edit ${index} field "oldText" must be a string when provided.`,
    );
  }
  if (edit.newText !== undefined && typeof edit.newText !== "string") {
    throw new Error(
      `Edit ${index} field "newText" must be a string when provided.`,
    );
  }
  if (edit.lines !== undefined) {
    const bad =
      !Array.isArray(edit.lines) ||
      edit.lines.some((l) => typeof l !== "string");
    if (bad) {
      throw new Error(`Edit ${index} field "lines" must be a string array.`);
    }
  }

  if (op === "replace_text") {
    if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
      throw new Error(
        `[E_BAD_OP] Edit ${index} with op "replace_text" requires string "oldText" and "newText" fields.`,
      );
    }
    if (
      edit.pos !== undefined ||
      edit.end !== undefined ||
      edit.lines !== undefined
    ) {
      throw new Error(
        `Edit ${index} with op "replace_text" only supports "oldText" and "newText".`,
      );
    }
    return;
  }

  if (edit.lines === undefined) {
    throw new Error(`Edit ${index} requires a "lines" field.`);
  }
  if (edit.oldText !== undefined || edit.newText !== undefined) {
    throw new Error(
      `Edit ${index} with op "${op}" does not support "oldText" or "newText".`,
    );
  }
  if (op === "replace" && typeof edit.pos !== "string") {
    throw new Error(
      `[E_BAD_OP] Edit ${index} with op "replace" requires a "pos" anchor string.`,
    );
  }
  if ((op === "append" || op === "prepend") && edit.end !== undefined) {
    throw new Error(
      `[E_BAD_OP] Edit ${index} with op "${op}" does not support "end". Use "pos" or omit it for file boundary insertion.`,
    );
  }
}

// ─── 行模型与区间坐标(与执行引擎 buildLineIndex 一致) ──────────────────

interface LineIndex {
  fileLines: string[];
  lineStarts: number[];
  hasTerminalNewline: boolean;
  /** read 可见行数:排除尾换行产生的 split 哨兵元素。 */
  visibleLineCount: number;
}

function buildLineIndex(content: string): LineIndex {
  const fileLines = content.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (let index = 0; index < fileLines.length; index++) {
    lineStarts.push(offset);
    offset += fileLines[index].length;
    if (index < fileLines.length - 1) {
      offset += 1;
    }
  }
  const hasTerminalNewline = content.endsWith("\n");
  return {
    fileLines,
    lineStarts,
    hasTerminalNewline,
    visibleLineCount: hasTerminalNewline
      ? fileLines.length - 1
      : fileLines.length,
  };
}

/** 行号越界检查(与执行引擎 validateAnchorEdits 的范围一致:哨兵行仍可寻址)。 */
function assertLineInRange(line: number, lineIndex: LineIndex): void {
  if (line < 1 || line > lineIndex.fileLines.length) {
    throw new Error(
      `[E_RANGE_OOB] Line ${line} does not exist (file has ${lineIndex.visibleLineCount} lines)`,
    );
  }
}

// ─── 单编辑 → 字符区间 ─────────────────────────────────────────────────

interface ResolvedSpan {
  kind: "replace" | "insert";
  index: number;
  label: string;
  start: number;
  end: number;
  replacement: string;
  boundary?: number;
  insertMode?: "append-empty-origin" | "prepend-empty-origin";
}

function extractText(
  edit: HashlinePreviewEdit,
  field: "oldText" | "newText",
  index: number,
): string {
  const value = edit[field];
  if (typeof value !== "string") {
    throw new Error(
      `[E_BAD_OP] Edit ${index} requires a string "${field}" field.`,
    );
  }
  return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function findExactUniqueTextMatch(
  content: string,
  oldText: string,
): { start: number; end: number } {
  if (oldText.length === 0) {
    throw new Error("[E_BAD_OP] replace_text requires non-empty oldText.");
  }
  const matches: number[] = [];
  let from = 0;
  while (from <= content.length - oldText.length) {
    const index = content.indexOf(oldText, from);
    if (index === -1) break;
    matches.push(index);
    from = index + 1;
  }
  for (let index = 1; index < matches.length; index++) {
    if (matches[index] - matches[index - 1] < oldText.length) {
      throw new Error(
        "[E_MULTI_MATCH] replace_text found overlapping exact matches; re-read and use hashline edits.",
      );
    }
  }
  if (matches.length === 0) {
    throw new Error(
      "[E_NO_MATCH] replace_text found no exact unique match in the current file.",
    );
  }
  if (matches.length > 1) {
    throw new Error(
      "[E_MULTI_MATCH] replace_text found multiple exact matches in the current file. Re-read and use hashline edits.",
    );
  }
  const start = matches[0];
  return { start, end: start + oldText.length };
}

function computeInsertionBoundary(
  edit: HashlinePreviewEdit,
  lineIndex: LineIndex,
): number {
  if (edit.op === "prepend") {
    return typeof edit.pos === "string" ? parseAnchorLine(edit.pos) - 1 : 0;
  }
  if (typeof edit.pos !== "string") {
    return lineIndex.visibleLineCount;
  }
  const posLine = parseAnchorLine(edit.pos);
  if (lineIndex.hasTerminalNewline && posLine === lineIndex.fileLines.length) {
    return lineIndex.visibleLineCount;
  }
  return posLine;
}

function resolveEditToSpan(
  edit: HashlinePreviewEdit,
  index: number,
  content: string,
  lineIndex: LineIndex,
): ResolvedSpan | null {
  const { fileLines, lineStarts, hasTerminalNewline } = lineIndex;
  const label = describeEdit(edit, index);

  switch (edit.op) {
    case "replace": {
      assertAnchorField(edit, "pos");
      assertLiteralLines(edit, index);
      const startLine = parseAnchorLine(edit.pos);
      assertLineInRange(startLine, lineIndex);
      const endLine =
        edit.end !== undefined ? parseAnchorLine(edit.end) : startLine;
      if (edit.end !== undefined) {
        assertLineInRange(endLine, lineIndex);
      }
      if (startLine > endLine) {
        throw new Error(
          `[E_BAD_OP] Range start line ${startLine} must be <= end line ${endLine}`,
        );
      }
      const lines = edit.lines;

      // noop 跳过:替换内容与原行逐字相同(与执行引擎 resolveEditToSpan 一致)。
      const originalLines = fileLines.slice(startLine - 1, endLine);
      if (
        originalLines.length === lines.length &&
        originalLines.every((line, lineIndex) => line === lines[lineIndex])
      ) {
        return null;
      }

      if (lines.length > 0) {
        return {
          kind: "replace",
          index,
          label,
          start: lineStarts[startLine - 1],
          end: lineStarts[endLine - 1] + fileLines[endLine - 1].length,
          replacement: lines.join("\n"),
        };
      }

      // 删除行:吃掉的换行由边界分支决定,避免留下空行。
      if (startLine === 1 && endLine === fileLines.length) {
        return {
          kind: "replace",
          index,
          label,
          start: 0,
          end: content.length,
          replacement: "",
        };
      }
      if (endLine < fileLines.length) {
        return {
          kind: "replace",
          index,
          label,
          start: lineStarts[startLine - 1],
          end: lineStarts[endLine],
          replacement: "",
        };
      }
      return {
        kind: "replace",
        index,
        label,
        start: Math.max(0, lineStarts[startLine - 1] - 1),
        end: lineStarts[endLine - 1] + fileLines[endLine - 1].length,
        replacement: "",
      };
    }

    case "append": {
      assertLiteralLines(edit, index);
      if (edit.lines.length === 0) {
        throw new Error(
          "[E_BAD_OP] Append with empty lines payload. Provide content to insert or remove the edit.",
        );
      }
      const insertedText = edit.lines.join("\n");
      if (content.length === 0) {
        return {
          kind: "insert",
          index,
          label,
          start: 0,
          end: 0,
          replacement: insertedText,
          boundary: computeInsertionBoundary(edit, lineIndex),
          insertMode: "append-empty-origin",
        };
      }
      if (typeof edit.pos !== "string") {
        return {
          kind: "insert",
          index,
          label,
          start: content.length,
          end: content.length,
          replacement: hasTerminalNewline
            ? `${insertedText}\n`
            : `\n${insertedText}`,
          boundary: computeInsertionBoundary(edit, lineIndex),
        };
      }
      const posLine = parseAnchorLine(edit.pos);
      assertLineInRange(posLine, lineIndex);
      const isSentinelAppend =
        hasTerminalNewline && posLine === fileLines.length;
      if (isSentinelAppend) {
        return {
          kind: "insert",
          index,
          label,
          start: content.length,
          end: content.length,
          replacement: `${insertedText}\n`,
          boundary: computeInsertionBoundary(edit, lineIndex),
        };
      }
      return {
        kind: "insert",
        index,
        label,
        start: lineStarts[posLine - 1] + fileLines[posLine - 1].length,
        end: lineStarts[posLine - 1] + fileLines[posLine - 1].length,
        replacement: `\n${insertedText}`,
        boundary: computeInsertionBoundary(edit, lineIndex),
      };
    }

    case "prepend": {
      assertLiteralLines(edit, index);
      if (edit.lines.length === 0) {
        throw new Error(
          "[E_BAD_OP] Prepend with empty lines payload. Provide content to insert or remove the edit.",
        );
      }
      const insertedText = edit.lines.join("\n");
      const start =
        typeof edit.pos === "string"
          ? lineStarts[parseAnchorLine(edit.pos) - 1]
          : 0;
      if (typeof edit.pos === "string") {
        assertLineInRange(parseAnchorLine(edit.pos), lineIndex);
      }
      return {
        kind: "insert",
        index,
        label,
        start,
        end: start,
        replacement: content.length === 0 ? insertedText : `${insertedText}\n`,
        boundary: computeInsertionBoundary(edit, lineIndex),
        ...(content.length === 0
          ? { insertMode: "prepend-empty-origin" as const }
          : {}),
      };
    }

    case "replace_text": {
      const oldText = extractText(edit, "oldText", index);
      const newText = extractText(edit, "newText", index);
      const match = findExactUniqueTextMatch(content, oldText);
      if (oldText === newText) {
        // noop 跳过:替换文本与原文相同(与执行引擎一致;匹配失败仍在上面报错)。
        return null;
      }
      return {
        kind: "replace",
        index,
        label,
        start: match.start,
        end: match.end,
        replacement: newText,
      };
    }
  }
  // op 为 unknown 时 TS 无法证明 switch 穷尽;运行时 assertHashlineEditShape
  // 已保证只能走到上述四分支,这里仅作类型收口。
  throw new Error(`[E_BAD_OP] Unhandled op in hashline preview.`);
}

// ─── 冲突检测与组装(与执行引擎一致) ───────────────────────────────────

function throwEditConflict(
  left: { index: number; label: string },
  right: { index: number; label: string },
  reason: string,
): never {
  throw new Error(
    `[E_EDIT_CONFLICT] Conflicting edits in a single request: edit ${left.index} (${left.label}) and edit ${right.index} (${right.label}) ${reason}. Merge them into one non-overlapping change or split the request.`,
  );
}

function assertNoConflictingSpans(spans: ResolvedSpan[]): void {
  for (let leftIndex = 0; leftIndex < spans.length; leftIndex++) {
    const left = spans[leftIndex];
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < spans.length;
      rightIndex++
    ) {
      const right = spans[rightIndex];

      if (left.kind === "insert" && right.kind === "insert") {
        if (left.boundary === right.boundary) {
          throwEditConflict(left, right, "target the same insertion boundary");
        }
        continue;
      }

      if (left.kind === "replace" && right.kind === "replace") {
        if (left.start < right.end && right.start < left.end) {
          throwEditConflict(
            left,
            right,
            "overlap on the same original line range",
          );
        }
        continue;
      }

      const replaceSpan = left.kind === "replace" ? left : right;
      const insertSpan = left.kind === "insert" ? left : right;
      if (
        insertSpan.start >= replaceSpan.start &&
        insertSpan.start < replaceSpan.end
      ) {
        throwEditConflict(
          left,
          right,
          "cannot be applied together because one inserts inside a replaced original range",
        );
      }
    }
  }
}

function assembleEditResult(content: string, spans: ResolvedSpan[]): string {
  let result = content;
  for (const span of spans) {
    const replacement =
      span.insertMode === "append-empty-origin"
        ? result.length === 0
          ? span.replacement
          : `\n${span.replacement}`
        : span.insertMode === "prepend-empty-origin"
          ? result.length === 0
            ? span.replacement
            : `${span.replacement}\n`
          : span.replacement;
    if (span.start < 0 || span.end > result.length || span.start > span.end) {
      throw new Error(
        `[E_BAD_OP] Invalid span computed for ${span.label} (${span.start}..${span.end}).`,
      );
    }
    result = result.slice(0, span.start) + replacement + result.slice(span.end);
  }
  return result;
}

// ─── 公共入口 ──────────────────────────────────────────────────────────

function previewText(text: string): string {
  const compact = text.replaceAll("\n", "\\n");
  return compact.length > 32 ? `${compact.slice(0, 29)}...` : compact;
}

function describeEdit(edit: HashlinePreviewEdit, index: number): string {
  switch (edit.op) {
    case "replace":
      return typeof edit.end === "string"
        ? `replace ${String(edit.pos)}..${edit.end}`
        : `replace ${String(edit.pos)}`;
    case "append":
      return typeof edit.pos === "string"
        ? `append after ${edit.pos}`
        : "append at EOF";
    case "prepend":
      return typeof edit.pos === "string"
        ? `prepend before ${edit.pos}`
        : "prepend at BOF";
    case "replace_text":
      return `replace_text "${previewText(String(edit.oldText))}"`;
    default:
      return `edit ${index}`;
  }
}

export interface HashlinePreviewResult {
  beforeText: string;
  afterText: string;
  summaryLines: string[];
}

/**
 * 基于当前文件内容(LF 归一、去 BOM 后)应用 hashline 格式的 edits。
 * 不校验 hash;结构与语义错误抛错,由调用方转为预览错误。
 */
export function applyHashlineEditPreview(
  content: string,
  edits: HashlinePreviewEdit[],
): HashlinePreviewResult {
  if (edits.length === 0) {
    return { beforeText: content, afterText: content, summaryLines: [] };
  }

  for (const [index, edit] of edits.entries()) {
    assertHashlineEditShape(edit, index);
  }

  const lineIndex = buildLineIndex(content);

  const spans: ResolvedSpan[] = [];
  // noop 返回 null 跳过;相同 span 去重(与执行引擎 resolveEditSpans 的
  // seenSpanKeys 一致)——重复/已应用的编辑不产生冲突假报。
  const seenSpanKeys = new Set<string>();
  for (const [index, edit] of edits.entries()) {
    const span = resolveEditToSpan(edit, index, content, lineIndex);
    if (span === null) {
      continue;
    }
    const spanKey =
      span.kind === "insert"
        ? `insert:${span.boundary}:${span.replacement}`
        : `replace:${span.start}:${span.end}:${span.replacement}`;
    if (seenSpanKeys.has(spanKey)) {
      continue;
    }
    seenSpanKeys.add(spanKey);
    spans.push(span);
  }

  assertNoConflictingSpans(spans);

  const ordered = [...spans].sort((left, right) => {
    if (right.end !== left.end) {
      return right.end - left.end;
    }
    if (left.kind !== right.kind) {
      return left.kind === "replace" ? -1 : 1;
    }
    if (left.kind === "insert" && right.kind === "insert") {
      return (
        (right.boundary ?? -1) - (left.boundary ?? -1) ||
        left.index - right.index
      );
    }
    return left.index - right.index;
  });

  const afterText = assembleEditResult(content, ordered);

  if (content.length > 0 && afterText.length === 0) {
    throw new Error(
      "[E_WOULD_EMPTY] Refusing to empty a non-empty file through edit. If intentional, use the write tool or bash.",
    );
  }

  const summaryLines = [
    `${edits.length} hashline operation(s)`,
    ...edits.map((edit, index) => describeEdit(edit, index)),
  ];

  return { beforeText: content, afterText, summaryLines };
}
