import { matchesKey } from "@earendil-works/pi-tui";
import {
  createDeniedPermissionDecision,
  type PermissionPromptDecision,
  type RequestPermissionOptions,
} from "#src/authority/permission-dialog";
import {
  initialPromptState,
  type PromptEvent,
  type PromptKey,
  type PromptModelConfig,
  type PromptViewState,
  reducePrompt,
} from "#src/authority/permission-prompt-decision";
import type {
  DecisionLayerResult,
  DiffDecisionLayer,
  DiffReviewDecision,
  DiffReviewLabels,
} from "#src/diff-view/presenter";
import type { PermissionSystemExtensionConfig } from "#src/extension-config";
import type { PromptPermissionDetails } from "./permission-prompter";

/** 决策语义的薄包装:把 diff 内按键接进现有 reducePrompt。 */
export class DiffPromptDecisionLayer implements DiffDecisionLayer {
  private state: PromptViewState;
  private readonly config: PromptModelConfig;
  private readonly labels: DiffReviewLabels;
  private theme = PLAIN_THEME;

  constructor(opts: {
    labels: DiffReviewLabels;
    doublePressToConfirm: boolean;
    sessionScope?: NonNullable<RequestPermissionOptions["sessionScope"]>;
  }) {
    this.labels = opts.labels;
    this.config = {
      doublePressToConfirm: opts.doublePressToConfirm,
      sessionLabel: opts.labels.session,
      sessionScope: opts.sessionScope,
    };
    this.state = initialPromptState(this.config);
  }

  setTheme(theme: {
    fg(color: string, text: string): string;
    bg(color: string, text: string): string;
  }): void {
    this.theme = theme;
  }

  render(_width: number): string[] {
    switch (this.state.step) {
      case "decision":
        return ["", ...this.renderDecision()];
      case "reason":
        return ["", ...this.renderReason()];
      case "scope":
        return ["", ...this.renderScope()];
    }
  }

  handleInput(data: string): DecisionLayerResult {
    if (this.state.step === "reason") {
      return this.handleReasonInput(data);
    }
    if (this.state.step === "scope") {
      if (matchesKey(data, "up")) {
        return this.apply({ type: "nav", direction: "up" });
      }
      if (matchesKey(data, "down")) {
        return this.apply({ type: "nav", direction: "down" });
      }
      if (matchesKey(data, "enter")) {
        return this.apply({ type: "confirm" });
      }
      if (matchesKey(data, "escape")) {
        return this.apply({ type: "cancel" });
      }
      return { kind: "ignored" };
    }
    // decision 步:y/a 批准、s 会话、r 拒绝并附原因;拒绝用 Esc(或 r)。
    // 'n' 是 viewer 的下一 hunk 键,故意不在此映射(reducePrompt 内部仍支持,
    // 但 diff 视图不把 'n' 路由给拒绝)。
    const key = HOTKEY_TO_PROMPT_KEY[data];
    if (key) {
      return this.apply({ type: "hotkey", key });
    }
    if (matchesKey(data, "enter")) {
      return this.apply({ type: "confirm" });
    }
    if (matchesKey(data, "escape")) {
      return this.apply({ type: "cancel" });
    }
    return { kind: "ignored" };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private apply(event: PromptEvent): DecisionLayerResult {
    const outcome = reducePrompt(this.config, this.state, event);
    if (outcome.kind === "decision") {
      return { kind: "decision", decision: toDiffDecision(outcome.decision) };
    }
    this.state = outcome.state;
    return { kind: "consumed" };
  }

  private handleReasonInput(data: string): DecisionLayerResult {
    if (matchesKey(data, "enter")) {
      return this.apply({
        type: "submitReason",
        draft: this.state.reasonDraft,
      });
    }
    if (matchesKey(data, "escape")) {
      return this.apply({ type: "cancel" });
    }
    if (matchesKey(data, "backspace")) {
      this.state = {
        ...this.state,
        reasonDraft: this.state.reasonDraft.slice(0, -1),
        reasonError: undefined,
      };
      return { kind: "consumed" };
    }
    if (isPrintable(data)) {
      this.state = {
        ...this.state,
        reasonDraft: this.state.reasonDraft + data,
        reasonError: undefined,
      };
      return { kind: "consumed" };
    }
    return { kind: "consumed" };
  }

  private renderDecision(): string[] {
    const rows: string[] = [];
    for (const key of OPTION_ORDER) {
      const label = OPTION_LABEL(key, this.labels);
      const selected = this.state.highlightedKey === key;
      const marker = selected ? "▶" : " ";
      const row = `${marker} (${key}) ${label}`;
      rows.push(selected ? this.theme.fg("accent", row) : row);
    }
    if (this.state.hint) {
      rows.push(this.theme.fg("muted", this.state.hint));
    } else {
      rows.push(
        this.theme.fg(
          "muted",
          "enter confirm · esc deny · r deny+reason · j/k=scroll · n/p=hunk",
        ),
      );
    }
    return rows;
  }

  private renderReason(): string[] {
    const lines = [
      `${this.theme.fg("accent", "Reason (required):")} ${this.state.reasonDraft}\u2588`,
    ];
    if (this.state.reasonError) {
      lines.push(this.theme.fg("error", this.state.reasonError));
    }
    lines.push(this.theme.fg("muted", "enter submit · esc back"));
    return lines;
  }

  private renderScope(): string[] {
    const scope = this.config.sessionScope;
    const rows: Array<{ label: string; serving: boolean }> = [
      { label: scope?.subagentLabel ?? "This subagent only", serving: false },
      {
        label: scope?.servingSessionLabel ?? "The whole session",
        serving: true,
      },
    ];
    const lines = ["Apply this session grant to:"];
    for (const row of rows) {
      const selected = this.state.scopeServing === row.serving;
      const marker = selected ? "▶" : " ";
      const text = `${marker} ${row.label}`;
      lines.push(selected ? this.theme.fg("accent", text) : text);
    }
    lines.push(this.theme.fg("muted", "↑/↓ move · enter confirm · esc back"));
    return lines;
  }
}

const OPTION_ORDER: readonly PromptKey[] = ["y", "s", "n", "r"];

function OPTION_LABEL(key: PromptKey, labels: DiffReviewLabels): string {
  switch (key) {
    case "y":
      return labels.approve;
    case "s":
      return labels.session;
    case "n":
      return labels.deny;
    case "r":
      return labels.denyReason;
  }
}

/**
 * diff 决策键 → reducePrompt 的 PromptKey。注意不含 'n':'n' 是 viewer 的
 * hunk 导航键,拒绝以 Esc / r 表达(用户裁决 2026-08-10)。
 */
const HOTKEY_TO_PROMPT_KEY: Record<string, PromptKey | undefined> = {
  y: "y",
  a: "y", // approve 别名
  s: "s",
  r: "r",
};

function isPrintable(data: string): boolean {
  if (data.length !== 1) {
    return false;
  }
  const code = data.charCodeAt(0);
  return code >= 0x20 && code !== 0x7f;
}

/** 单元测试友好主题;生产构造后由组件注入真实 theme。 */
const PLAIN_THEME = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
};

export function isDiffReviewableTool(
  toolName: unknown,
): toolName is "write" | "edit" {
  return toolName === "write" || toolName === "edit";
}

export function shouldUseDiff(
  config: PermissionSystemExtensionConfig,
  details: PromptPermissionDetails,
  mode: string,
): boolean {
  return (
    mode === "tui" &&
    isDiffReviewableTool(details.toolName) &&
    details.toolInput !== undefined &&
    (config.toolDiffPrompt ?? true)
  );
}

export function mapDiffDecision(
  decision: DiffReviewDecision,
): PermissionPromptDecision {
  switch (decision.kind) {
    case "approve":
      return { approved: true, state: "approved" };
    case "approve_for_session":
      return {
        approved: true,
        state:
          decision.scope === "serving_session"
            ? "approved_for_serving_session"
            : "approved_for_session",
      };
    case "deny":
      return createDeniedPermissionDecision(decision.reason);
    case "preview_unavailable":
      // 防御分支:用户在裁决 A 下对 write/edit 不可达(computeChangePreview 从不
      // 返回 null)。保持 fail-closed,不静默放行。
      return createDeniedPermissionDecision();
  }
}

export function toDiffDecision(
  decision: PermissionPromptDecision,
): DiffReviewDecision {
  if (decision.approved) {
    if (decision.state === "approved_for_serving_session") {
      return { kind: "approve_for_session", scope: "serving_session" };
    }
    if (decision.state === "approved_for_session") {
      return { kind: "approve_for_session", scope: "subagent_only" };
    }
    return { kind: "approve" };
  }
  return decision.denialReason !== undefined
    ? { kind: "deny", reason: decision.denialReason }
    : { kind: "deny" };
}
