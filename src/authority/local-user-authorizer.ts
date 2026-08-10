import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type {
  PermissionPromptDecision,
  RequestPermissionOptions,
} from "#src/authority/permission-dialog";
import type {
  PermissionPromptUi,
  PromptPreferences,
  requestPermissionDecision,
} from "#src/authority/permission-prompt-component";
import type {
  DiffReviewDecision,
  DiffReviewInput,
  DiffReviewLabels,
} from "#src/diff-view/presenter";
import { presentDiffReview } from "#src/diff-view/presenter";
import type { PermissionSystemExtensionConfig } from "#src/extension-config";
import { buildForwardedScopeLabels } from "#src/pattern-suggest";
import {
  emitUiPromptEvent,
  type PermissionEventBus,
} from "#src/permission-events";
import { buildUiPrompt } from "#src/permission-ui-prompt";
import { PanelFrame } from "#src/ui/panel-frame";
import type { TerminalAuthorizer } from "./authorizer";
import {
  DiffPromptDecisionLayer,
  mapDiffDecision,
  shouldUseDiff,
} from "./diff-ask-adapter";
import type { PromptPermissionDetails } from "./permission-prompter";

/** Dependencies required by {@link LocalUserAuthorizer}. */
export interface LocalUserAuthorizerDeps {
  /** The active session's UI surface (select/input plus the overlay `custom` dialog). */
  ui: PermissionPromptUi;
  /** The session run mode; the dispatcher renders the overlay dialog only in `"tui"`. */
  mode: ExtensionContext["mode"];
  /** Session cwd, used for diff preview path resolution. */
  cwd: string;
  /** Event bus used for the `permissions:ui_prompt` broadcast. */
  events: PermissionEventBus;
  /** Read live at prompt time so a settings-modal toggle takes effect on the next prompt. */
  getPromptPreferences: () => PromptPreferences;
  /** Read live at prompt time; supplies the diff/presentation config. */
  getConfig: () => PermissionSystemExtensionConfig;
  /** Injected for testability; production callers pass the real function. */
  requestPermissionDecision: typeof requestPermissionDecision;
}

/** 与 permission-prompt-component 同款的 bottom-anchor overlay 参数。 */
const PROMPT_OVERLAY_OPTIONS = {
  anchor: "bottom-center",
  width: "100%",
} as const;

/**
 * Authorizer for a session with an active UI: prompt the human here.
 *
 * Emits the `permissions:ui_prompt` broadcast (moved here from
 * `PermissionPrompter`'s `ctx.hasUI` arm) before showing the dialog, so
 * observers know a decision is imminent. This is the single emit site: a
 * forwarded ask carries its provenance on `details.forwarding`, which this
 * class renders (populated `forwarding` context + "(Subagent)" title) so the
 * broadcast stays non-degraded (#292) without a second emission path.
 */
export class LocalUserAuthorizer implements TerminalAuthorizer {
  constructor(private readonly deps: LocalUserAuthorizerDeps) {}

  authorize(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> {
    const uiPrompt = buildUiPrompt(details);
    emitUiPromptEvent(this.deps.events, uiPrompt);
    if (shouldUseDiff(this.deps.getConfig(), details, this.deps.mode)) {
      return this.presentDiff(details);
    }
    return this.deps.requestPermissionDecision(
      {
        mode: this.deps.mode,
        ui: this.deps.ui,
        doublePressToConfirm:
          this.deps.getPromptPreferences().doublePressToConfirm,
      },
      details.forwarding
        ? "Permission Required (Subagent)"
        : "Permission Required",
      details.message,
      buildRequestOptions(details),
    );
  }

  /**
   * 渲染 write/edit 的交互式 diff 决策视图(仅 TUI 本地 ask 到达这里)。
   * 决策语义经 DiffPromptDecisionLayer 复用现有 reducePrompt;preview 失败
   * 在 diff 视图内嵌警告呈现(裁决 A),preview_unavailable 仅防御性回退。
   */
  private async presentDiff(
    details: PromptPermissionDetails,
  ): Promise<PermissionPromptDecision> {
    const config = this.deps.getConfig();
    const defaultView = config.toolDiffDefaultView ?? "unified";
    const labels: DiffReviewLabels = {
      approve: "Yes",
      session: details.sessionLabel ?? "Yes, for this session",
      deny: "No",
      denyReason: "No, provide reason",
    };
    const decisionLayer = new DiffPromptDecisionLayer({
      labels,
      doublePressToConfirm:
        this.deps.getPromptPreferences().doublePressToConfirm,
      sessionScope: buildRequestOptions(details)?.sessionScope,
    });
    const input: DiffReviewInput = {
      toolName: details.toolName as "write" | "edit",
      input: details.toolInput,
      cwd: this.deps.cwd,
      labels,
      defaultView,
      decisionLayer,
    };
    const decision = await presentDiffReview(
      (build) =>
        this.deps.ui.custom<DiffReviewDecision>(
          (tui, theme, _keybindings, done) =>
            frameWithPanel(build(tui, theme, done), theme, "accent"),
          { overlay: true, overlayOptions: PROMPT_OVERLAY_OPTIONS },
        ),
      input,
    );
    if (decision.kind === "preview_unavailable") {
      return this.deps.requestPermissionDecision(
        {
          mode: this.deps.mode,
          ui: this.deps.ui,
          doublePressToConfirm: false,
        },
        details.forwarding
          ? "Permission Required (Subagent)"
          : "Permission Required",
        details.message,
        buildRequestOptions(details),
      );
    }
    return mapDiffDecision(decision);
  }
}

/**
 * A forwarded ask carrying a session-approval suggestion offers the scope
 * choice (subagent vs whole session); any other ask keeps its single
 * "for this session" option (custom label when the gate supplied one).
 */
function buildRequestOptions(
  details: PromptPermissionDetails,
): RequestPermissionOptions | undefined {
  const pattern = details.sessionApproval?.patterns[0];
  if (details.forwarding && details.sessionApproval && pattern) {
    return {
      sessionScope: buildForwardedScopeLabels(
        details.forwarding.requesterAgentName,
        details.sessionApproval.surface,
        pattern,
      ),
    };
  }
  return details.sessionLabel
    ? { sessionLabel: details.sessionLabel }
    : undefined;
}

/**
 * 用现有 PanelFrame 给夹 diff 内容的组件加边框(镜像现有 prompt 的 framing)。
 * 仅存在于 authority 侧,diff-view 保持零依赖 #src/*。
 */
function frameWithPanel(
  inner: {
    render(width: number): string[];
    invalidate(): void;
    handleInput?(data: string): void;
  },
  theme: { fg(color: string, text: string): string },
  colorName: string,
): Component {
  const frame = new PanelFrame(inner, (text) => theme.fg(colorName, text));
  return {
    render: (width) => frame.render(width),
    invalidate: () => frame.invalidate(),
    handleInput: (data) => {
      inner.handleInput?.(data);
    },
  };
}
