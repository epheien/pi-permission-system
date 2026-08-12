import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import type {
  EditToolInput,
  WriteToolInput,
} from "@earendil-works/pi-coding-agent";

import {
  fuzzyFindText,
  generateDiffString,
  normalizeForFuzzyMatch,
  normalizeToLF,
  type StructuredDiff,
  stripBom,
  summarizeDiff,
} from "./diff-utils";
import {
  applyHashlineEditPreview,
  isHashlineEditInput,
} from "./hashline-preview";

interface MultiEditOperation {
  oldText: string;
  newText: string;
}

interface MultiEditToolInput {
  path: string;
  edits?: MultiEditOperation[];
  oldText?: string;
  newText?: string;
}

export type PreviewToolName = "edit" | "write";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".icns",
  ".tif",
  ".tiff",
  ".heic",
  ".avif",
]);

export interface ChangePreview {
  toolName: PreviewToolName;
  path: string;
  absolutePath: string;
  diff: string;
  diffModel?: StructuredDiff;
  additions: number;
  deletions: number;
  summaryLines: string[];
  previewError?: string;
  beforeText?: string;
  afterText?: string;
}

function stripAtPrefix(inputPath: string): string {
  return inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
}

function expandTilde(inputPath: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/"))
    return path.join(homedir(), inputPath.slice(2));
  return inputPath;
}

function resolveToCwd(inputPath: string, cwd: string): string {
  const expanded = expandTilde(stripAtPrefix(inputPath));
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function errorPreview(
  toolName: PreviewToolName,
  filePath: string,
  absolutePath: string,
  error: string,
  summaryLines: string[],
  extra?: Partial<
    Pick<
      ChangePreview,
      | "diff"
      | "diffModel"
      | "additions"
      | "deletions"
      | "beforeText"
      | "afterText"
    >
  >,
): ChangePreview {
  return {
    toolName,
    path: filePath,
    absolutePath,
    diff: extra?.diff ?? `Preview unavailable\n\n${error}`,
    diffModel: extra?.diffModel,
    additions: extra?.additions ?? 0,
    deletions: extra?.deletions ?? 0,
    summaryLines,
    previewError: error,
    beforeText: extra?.beforeText,
    afterText: extra?.afterText,
  };
}

function createBinaryPreviewMessage(
  filePath: string,
  kind: "image" | "binary",
  detail: string,
  extraLine?: string,
): string {
  return [
    `${kind === "image" ? "Image" : "Binary"} diff preview unavailable`,
    "",
    `Path: ${filePath}`,
    `Reason: ${detail}`,
    extraLine,
    "Textual diffs can only be rendered for text files.",
  ]
    .filter(Boolean)
    .join("\n");
}

function detectBinaryKind(
  filePath: string,
  buffer: Buffer,
): "image" | "binary" | null {
  const extension = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (buffer.includes(0)) return "binary";

  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  if (sample.length === 0) return null;

  let suspicious = 0;
  for (const byte of sample) {
    const isAllowedControl = byte === 9 || byte === 10 || byte === 13;
    const isPrintableAscii = byte >= 32 && byte <= 126;
    const isExtendedUtf8Byte = byte >= 128;
    if (!isAllowedControl && !isPrintableAscii && !isExtendedUtf8Byte)
      suspicious++;
  }

  return suspicious / sample.length > 0.15 ? "binary" : null;
}

function createChangePreviewFromTexts(
  toolName: PreviewToolName,
  filePath: string,
  absolutePath: string,
  beforeText: string,
  afterText: string,
  summaryLines: string[],
  previewError?: string,
): ChangePreview {
  const diffResult = generateDiffString(beforeText, afterText);
  const summary = summarizeDiff(diffResult.diff);

  return {
    toolName,
    path: filePath,
    absolutePath,
    diff: diffResult.diff || "(No visible diff)",
    diffModel: diffResult.model,
    additions: summary.additions,
    deletions: summary.deletions,
    summaryLines,
    previewError,
    beforeText,
    afterText,
  };
}

function getEditOperations(
  input: MultiEditToolInput,
):
  | { operations: MultiEditOperation[]; mode: "single" | "multi" }
  | { error: string } {
  if (Array.isArray(input.edits)) {
    if (input.edits.length === 0) {
      return { error: "The edit call provided an empty edits array." };
    }
    for (const [index, edit] of input.edits.entries()) {
      // edits 元素类型为非空对象;若外部传入类型违约的 null/undefined 元素,此处属性访问
      // 会抛 TypeError,由 computeEditPreview 外层 try/catch 兜底为通用错误消息。
      if (
        typeof edit.oldText !== "string" ||
        typeof edit.newText !== "string"
      ) {
        return { error: `Edit ${index + 1} is missing oldText or newText.` };
      }
    }
    return { operations: input.edits, mode: "multi" };
  }

  if (typeof input.oldText === "string" && typeof input.newText === "string") {
    return {
      operations: [{ oldText: input.oldText, newText: input.newText }],
      mode: "single",
    };
  }

  return { error: "The edit call is missing oldText/newText or edits[]." };
}

async function computeEditPreview(
  input: EditToolInput | MultiEditToolInput,
  cwd: string,
): Promise<ChangePreview> {
  const absolutePath = resolveToCwd(input.path, cwd);

  try {
    await access(absolutePath, fsConstants.R_OK);
  } catch {
    return errorPreview(
      "edit",
      input.path,
      absolutePath,
      `File not found: ${input.path}`,
      ["Replace exact text"],
    );
  }

  try {
    const rawBuffer = await readFile(absolutePath);
    const binaryKind = detectBinaryKind(input.path, rawBuffer);
    if (binaryKind) {
      return errorPreview(
        "edit",
        input.path,
        absolutePath,
        `${binaryKind === "image" ? "Image" : "Binary"} file detected: textual diff preview is not available for ${input.path}.`,
        [
          "Replace exact text",
          binaryKind === "image" ? "Image file" : "Binary file",
        ],
        {
          diff: createBinaryPreviewMessage(
            input.path,
            binaryKind,
            `${binaryKind === "image" ? "Image" : "Binary"} file content cannot be shown as a text diff.`,
            "This edit tool call is likely invalid for this file.",
          ),
        },
      );
    }
    const rawContent = rawBuffer.toString("utf-8");
    const { text: content } = stripBom(rawContent);
    const normalizedContent = normalizeToLF(content);

    // 分派基于拦截点的 canonical 输入形状(pi 框架先运行各工具的
    // prepareArguments + schema 校验,再触发 tool_call 拦截):
    // - 装 pi-hashline-edit 时:edits[].op/pos/end/lines(其 normalize 层已把
    //   oldText/newText、file_path、snake_case、JSON-string edits 收敛为
    //   canonical hashline 形状)→ 宽松行号预览,不校验 hash。
    // - 原版 edit 时:edits[].oldText/newText(内置 prepareArguments 已归一化)
    //   → 下方既有 fuzzy 精确匹配逻辑,行为不变。
    if (isHashlineEditInput(input)) {
      try {
        const result = applyHashlineEditPreview(normalizedContent, input.edits);
        return createChangePreviewFromTexts(
          "edit",
          input.path,
          absolutePath,
          result.beforeText,
          result.afterText,
          result.summaryLines,
        );
      } catch (error) {
        return errorPreview(
          "edit",
          input.path,
          absolutePath,
          error instanceof Error ? error.message : String(error),
          [`${input.edits.length} hashline operation(s)`],
        );
      }
    }

    const operationInfo = getEditOperations(input);
    if ("error" in operationInfo) {
      return errorPreview(
        "edit",
        input.path,
        absolutePath,
        operationInfo.error,
        ["Replace exact text"],
      );
    }

    const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
    type PlannedEdit = {
      index: number;
      matchLength: number;
      newText: string;
      usedFuzzyMatch: boolean;
    };
    const plannedEdits: PlannedEdit[] = [];
    for (const [editIndex, edit] of operationInfo.operations.entries()) {
      const normalizedOldText = normalizeToLF(edit.oldText);
      const normalizedNewText = normalizeToLF(edit.newText);
      const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);
      const label =
        operationInfo.mode === "multi"
          ? `Edit ${editIndex + 1}`
          : "Replace exact text";

      if (!matchResult.found) {
        return errorPreview(
          "edit",
          input.path,
          absolutePath,
          `${label}: could not find the exact text in ${input.path}. The old text must be unique and match the file.`,
          [`${operationInfo.operations.length} targeted edit(s)`],
        );
      }

      const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
      const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;
      if (occurrences > 1) {
        return errorPreview(
          "edit",
          input.path,
          absolutePath,
          `${label}: found ${occurrences} occurrences in ${input.path}. Add more context so the edit is unique.`,
          [`${operationInfo.operations.length} targeted edit(s)`],
        );
      }

      plannedEdits.push({
        index: matchResult.index,
        matchLength: matchResult.matchLength,
        newText: normalizedNewText,
        usedFuzzyMatch: matchResult.usedFuzzyMatch,
      });
    }

    const sortedEdits = [...plannedEdits].sort((a, b) => a.index - b.index);
    for (let i = 1; i < sortedEdits.length; i++) {
      const previous = sortedEdits[i - 1];
      const current = sortedEdits[i];
      if (current.index < previous.index + previous.matchLength) {
        return errorPreview(
          "edit",
          input.path,
          absolutePath,
          `Some edits in ${input.path} overlap or target the same region. Merge them into one edit.`,
          [`${operationInfo.operations.length} targeted edit(s)`],
        );
      }
    }

    const baseContent = normalizedContent;
    let newContent = baseContent;
    for (const edit of [...sortedEdits].sort((a, b) => b.index - a.index)) {
      newContent =
        newContent.substring(0, edit.index) +
        edit.newText +
        newContent.substring(edit.index + edit.matchLength);
    }

    const fuzzyMatchCount = plannedEdits.filter(
      (edit) => edit.usedFuzzyMatch,
    ).length;
    const summaryLines =
      operationInfo.mode === "single"
        ? [
            "Replace exact text",
            fuzzyMatchCount > 0
              ? "Matched using fuzzy normalization"
              : "Matched exact text",
          ]
        : [
            `${operationInfo.operations.length} targeted edit(s)`,
            fuzzyMatchCount > 0
              ? `${fuzzyMatchCount} edit(s) matched using fuzzy normalization`
              : "All edits matched exact text",
          ];

    if (baseContent === newContent) {
      return createChangePreviewFromTexts(
        "edit",
        input.path,
        absolutePath,
        baseContent,
        newContent,
        summaryLines,
        `No changes would be made to ${input.path}.`,
      );
    }

    return createChangePreviewFromTexts(
      "edit",
      input.path,
      absolutePath,
      baseContent,
      newContent,
      summaryLines,
    );
  } catch (error) {
    return errorPreview(
      "edit",
      input.path,
      absolutePath,
      error instanceof Error ? error.message : String(error),
      ["Replace exact text"],
    );
  }
}

async function computeWritePreview(
  input: WriteToolInput,
  cwd: string,
): Promise<ChangePreview> {
  const absolutePath = resolveToCwd(input.path, cwd);
  let beforeText = "";
  let existed = true;

  try {
    await access(absolutePath, fsConstants.R_OK);
    const rawBuffer = await readFile(absolutePath);
    const binaryKind = detectBinaryKind(input.path, rawBuffer);
    if (binaryKind) {
      return errorPreview(
        "write",
        input.path,
        absolutePath,
        `Existing ${binaryKind === "image" ? "image" : "binary"} file detected: textual diff preview is not available for ${input.path}.`,
        [
          "Overwrite existing file",
          binaryKind === "image" ? "Image file" : "Binary file",
        ],
        {
          diff: createBinaryPreviewMessage(
            input.path,
            binaryKind,
            `Existing file content cannot be rendered as text.`,
            `Approving will overwrite it with ${input.content.split("\n").length.toLocaleString()} line(s) of text.`,
          ),
        },
      );
    }
    const rawContent = rawBuffer.toString("utf-8");
    beforeText = normalizeToLF(stripBom(rawContent).text);
  } catch {
    existed = false;
  }

  const afterText = normalizeToLF(input.content);
  if (beforeText === afterText) {
    return createChangePreviewFromTexts(
      "write",
      input.path,
      absolutePath,
      beforeText,
      afterText,
      [existed ? "Overwrite existing file" : "Create new file"],
      `No changes would be made to ${input.path}.`,
    );
  }

  return createChangePreviewFromTexts(
    "write",
    input.path,
    absolutePath,
    beforeText,
    afterText,
    [
      existed ? "Overwrite existing file" : "Create new file",
      `${afterText.split("\n").length} output line(s)`,
    ],
  );
}

export async function computeChangePreview(
  toolName: PreviewToolName,
  input: unknown,
  cwd: string,
): Promise<ChangePreview | null> {
  // 保留运行时兜底:调用方可能传类型系统之外的值(如 "bash"),非 write/edit 返回 null。
  const name: string = toolName;
  if (name === "edit") {
    return computeEditPreview(input as EditToolInput, cwd);
  }
  if (name === "write") {
    return computeWritePreview(input as WriteToolInput, cwd);
  }
  return null;
}
