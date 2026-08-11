import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ShellToolsConfig,
  UnifiedPermissionConfig,
} from "./config-loader";
import { DEFAULT_KEYBINDINGS as DEFAULT_VIEW_KEYBINDINGS } from "./diff-view/keybindings";
import { parseShortcutKey } from "./keyboard-shortcut";
import {
  OWNER_ONLY_DIRECTORY_MODE,
  restrictExistingPathToOwner,
} from "./log-file-permissions";

export const EXTENSION_ID = "pi-permission-system";

/**
 * The full set of shortcuts this extension exposes, keyed by action name.
 * Every value is an array of pi `KeyId` strings; an empty array disables that
 * action. Written config arrays **replace** the action's keys (never
 * additive); omitted actions keep the built-in defaults.
 */
export interface Keybindings {
  approve: string[];
  approveSession: string[];
  deny: string[];
  denyWithReason: string[];
  confirm: string[];
  cancel: string[];
  navUp: string[];
  navDown: string[];
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
  yoloToggle: string[];
}

/** The decision-key subset shared by the overlay dialog and the diff decision area. */
export type DecisionKeybindings = Pick<
  Keybindings,
  | "approve"
  | "approveSession"
  | "deny"
  | "denyWithReason"
  | "confirm"
  | "cancel"
  | "navUp"
  | "navDown"
>;

/**
 * The default keybindings every action falls back to when the config does not
 * override it. View keys reuse the diff-view defaults (single source) so the
 * two tables cannot drift.
 */
export const DEFAULT_KEYBINDINGS: Keybindings = {
  approve: ["y"],
  approveSession: ["s"],
  deny: ["d"],
  denyWithReason: ["r"],
  confirm: ["enter"],
  cancel: ["escape"],
  navUp: ["up", "k"],
  navDown: ["down", "j"],
  scrollUp: DEFAULT_VIEW_KEYBINDINGS.scrollUp,
  scrollDown: DEFAULT_VIEW_KEYBINDINGS.scrollDown,
  pageUp: DEFAULT_VIEW_KEYBINDINGS.pageUp,
  pageDown: DEFAULT_VIEW_KEYBINDINGS.pageDown,
  scrollTop: DEFAULT_VIEW_KEYBINDINGS.scrollTop,
  scrollBottom: DEFAULT_VIEW_KEYBINDINGS.scrollBottom,
  nextHunk: DEFAULT_VIEW_KEYBINDINGS.nextHunk,
  prevHunk: DEFAULT_VIEW_KEYBINDINGS.prevHunk,
  toggleMode: DEFAULT_VIEW_KEYBINDINGS.toggleMode,
  toggleWrap: DEFAULT_VIEW_KEYBINDINGS.toggleWrap,
  toggleExpand: DEFAULT_VIEW_KEYBINDINGS.toggleExpand,
  contextMore: DEFAULT_VIEW_KEYBINDINGS.contextMore,
  contextLess: DEFAULT_VIEW_KEYBINDINGS.contextLess,
  yoloToggle: ["ctrl+alt+y"],
};

/**
 * Validate one key-array against the pi-tui KeyId grammar, dropping malformed
 * entries fail-safe (a malformed string would otherwise be silently mis-parsed
 * into a different binding). `undefined` falls back to the default array; an
 * empty array stays empty (that action is disabled).
 */
export function sanitizeKeyArray(
  keys: string[] | undefined,
  fallback: string[],
  onDrop?: (key: string) => void,
): string[] {
  const source = keys ?? fallback;
  const valid: string[] = [];
  for (const key of source) {
    const parsed = parseShortcutKey(key);
    if (parsed.ok) {
      valid.push(parsed.key);
    } else {
      onDrop?.(key);
    }
  }
  return valid;
}

/**
 * Merge the raw (partial) config keybindings over the defaults, yielding the
 * complete, sanitized {@link Keybindings} the runtime consumes. YOLO resolves
 * `keybindings.yoloToggle` → the default.
 */
export function normalizeKeybindings(
  raw: UnifiedPermissionConfig,
  onDrop?: (key: string) => void,
): Keybindings {
  const kb = raw.keybindings;
  const yoloSource = kb?.yoloToggle ?? DEFAULT_KEYBINDINGS.yoloToggle;
  return {
    approve: sanitizeKeyArray(kb?.approve, DEFAULT_KEYBINDINGS.approve, onDrop),
    approveSession: sanitizeKeyArray(
      kb?.approveSession,
      DEFAULT_KEYBINDINGS.approveSession,
      onDrop,
    ),
    deny: sanitizeKeyArray(kb?.deny, DEFAULT_KEYBINDINGS.deny, onDrop),
    denyWithReason: sanitizeKeyArray(
      kb?.denyWithReason,
      DEFAULT_KEYBINDINGS.denyWithReason,
      onDrop,
    ),
    confirm: sanitizeKeyArray(kb?.confirm, DEFAULT_KEYBINDINGS.confirm, onDrop),
    cancel: sanitizeKeyArray(kb?.cancel, DEFAULT_KEYBINDINGS.cancel, onDrop),
    navUp: sanitizeKeyArray(kb?.navUp, DEFAULT_KEYBINDINGS.navUp, onDrop),
    navDown: sanitizeKeyArray(kb?.navDown, DEFAULT_KEYBINDINGS.navDown, onDrop),
    scrollUp: sanitizeKeyArray(
      kb?.scrollUp,
      DEFAULT_KEYBINDINGS.scrollUp,
      onDrop,
    ),
    scrollDown: sanitizeKeyArray(
      kb?.scrollDown,
      DEFAULT_KEYBINDINGS.scrollDown,
      onDrop,
    ),
    pageUp: sanitizeKeyArray(kb?.pageUp, DEFAULT_KEYBINDINGS.pageUp, onDrop),
    pageDown: sanitizeKeyArray(
      kb?.pageDown,
      DEFAULT_KEYBINDINGS.pageDown,
      onDrop,
    ),
    scrollTop: sanitizeKeyArray(
      kb?.scrollTop,
      DEFAULT_KEYBINDINGS.scrollTop,
      onDrop,
    ),
    scrollBottom: sanitizeKeyArray(
      kb?.scrollBottom,
      DEFAULT_KEYBINDINGS.scrollBottom,
      onDrop,
    ),
    nextHunk: sanitizeKeyArray(
      kb?.nextHunk,
      DEFAULT_KEYBINDINGS.nextHunk,
      onDrop,
    ),
    prevHunk: sanitizeKeyArray(
      kb?.prevHunk,
      DEFAULT_KEYBINDINGS.prevHunk,
      onDrop,
    ),
    toggleMode: sanitizeKeyArray(
      kb?.toggleMode,
      DEFAULT_KEYBINDINGS.toggleMode,
      onDrop,
    ),
    toggleWrap: sanitizeKeyArray(
      kb?.toggleWrap,
      DEFAULT_KEYBINDINGS.toggleWrap,
      onDrop,
    ),
    toggleExpand: sanitizeKeyArray(
      kb?.toggleExpand,
      DEFAULT_KEYBINDINGS.toggleExpand,
      onDrop,
    ),
    contextMore: sanitizeKeyArray(
      kb?.contextMore,
      DEFAULT_KEYBINDINGS.contextMore,
      onDrop,
    ),
    contextLess: sanitizeKeyArray(
      kb?.contextLess,
      DEFAULT_KEYBINDINGS.contextLess,
      onDrop,
    ),
    yoloToggle: sanitizeKeyArray(
      yoloSource,
      DEFAULT_KEYBINDINGS.yoloToggle,
      onDrop,
    ),
  };
}

export interface PermissionSystemExtensionConfig {
  debugLog: boolean;
  permissionReviewLog: boolean;
  yoloMode: boolean;
  /** Require a confirming second press of a decision hotkey in the overlay TUI dialog. Defaults to true. */
  doublePressToConfirm: boolean;
  /** Additional directories to auto-allow for reads as Pi infrastructure. */
  piInfrastructureReadPaths?: string[];
  /** Max length of the inline-JSON input preview shown in permission prompts. Defaults to 200. */
  toolInputPreviewMaxLength?: number;
  /** Max length of inline pattern/path summaries (grep/find/ls) in permission prompts. Defaults to 80. */
  toolTextSummaryMaxLength?: number;
  /** Non-bash tools that carry shell semantics, keyed by tool name. */
  shellTools?: ShellToolsConfig;
  /** Ordered names of registered live-authority chain links to consult before the terminal authorizer. */
  authorizerChain?: string[];
  /** Ask 中 write/edit 渲染交互式 diff;缺省 true。 */
  toolDiffPrompt?: boolean;
  /** diff 默认视图;缺省 "unified"。 */
  toolDiffDefaultView?: "split" | "unified";
  /** 全部快捷键:完整合并后的键名 → pi KeyId 数组(`[]` = 禁用)。 */
  keybindings: Keybindings;
}

export const DEFAULT_EXTENSION_CONFIG: PermissionSystemExtensionConfig = {
  debugLog: false,
  permissionReviewLog: true,
  yoloMode: false,
  doublePressToConfirm: true,
  keybindings: { ...DEFAULT_KEYBINDINGS },
};

function resolveExtensionRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..");
}

export const EXTENSION_ROOT = resolveExtensionRoot();

const PERMISSION_POLICY_KEYS: ReadonlySet<string> = new Set([
  "defaultPolicy",
  "tools",
  "bash",
  "mcp",
  "skills",
  "special",
  "external_directory",
]);

export function detectMisplacedPermissionKeys(
  raw: Record<string, unknown>,
): string[] {
  return Object.keys(raw).filter((key) => PERMISSION_POLICY_KEYS.has(key));
}

export function normalizePermissionSystemConfig(
  raw: UnifiedPermissionConfig,
  onDrop?: (key: string) => void,
): PermissionSystemExtensionConfig {
  const result: PermissionSystemExtensionConfig = {
    debugLog: raw.debugLog === true,
    permissionReviewLog: raw.permissionReviewLog !== false,
    yoloMode: raw.yoloMode === true,
    doublePressToConfirm: raw.doublePressToConfirm !== false,
    keybindings: normalizeKeybindings(raw, onDrop),
  };
  if (raw.piInfrastructureReadPaths !== undefined) {
    result.piInfrastructureReadPaths = raw.piInfrastructureReadPaths;
  }
  if (raw.toolInputPreviewMaxLength !== undefined) {
    result.toolInputPreviewMaxLength = raw.toolInputPreviewMaxLength;
  }
  if (raw.toolTextSummaryMaxLength !== undefined) {
    result.toolTextSummaryMaxLength = raw.toolTextSummaryMaxLength;
  }
  if (raw.shellTools !== undefined) {
    result.shellTools = raw.shellTools;
  }
  if (raw.authorizerChain !== undefined) {
    result.authorizerChain = raw.authorizerChain;
  }
  if (raw.toolDiffPrompt !== undefined) {
    result.toolDiffPrompt = raw.toolDiffPrompt;
  }
  if (raw.toolDiffDefaultView !== undefined) {
    result.toolDiffDefaultView =
      raw.toolDiffDefaultView === "split" ? "split" : "unified";
  }
  return result;
}

export function isYoloModeEnabled(
  config: PermissionSystemExtensionConfig,
): boolean {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-conversion -- typed as boolean but may be undefined at runtime (untyped callers); Boolean() guards against that
  return Boolean(config.yoloMode);
}

export function ensurePermissionSystemLogsDirectory(
  logsDir: string,
): string | undefined {
  try {
    // `recursive` applies the mode to every directory this creates, so a fresh
    // install also gets an owner-only extension config dir. Directories that
    // already exist are untouched by `mkdirSync`, hence the explicit tighten.
    mkdirSync(logsDir, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
    restrictExistingPathToOwner(logsDir, OWNER_ONLY_DIRECTORY_MODE);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Failed to create permission-system log directory '${logsDir}': ${message}`;
  }
}
