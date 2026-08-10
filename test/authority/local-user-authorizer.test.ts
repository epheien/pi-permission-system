import { describe, expect, it, vi } from "vitest";
import { LocalUserAuthorizer } from "#src/authority/local-user-authorizer";
import type { PermissionPromptDecision } from "#src/authority/permission-dialog";
import type { requestPermissionDecision } from "#src/authority/permission-prompt-component";
import type { PromptPermissionDetails } from "#src/authority/permission-prompter";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeDetails(
  overrides?: Partial<PromptPermissionDetails>,
): PromptPermissionDetails {
  return {
    requestId: "req-123",
    source: "tool_call",
    agentName: "test-agent",
    message: "Allow read?",
    toolName: "read",
    ...overrides,
  };
}

/** A `PermissionPromptUi` double; the tool-expansion accessors go unused here. */
function makePromptUi() {
  return {
    select: vi.fn(),
    input: vi.fn(),
    custom: vi.fn(),
    getToolsExpanded: vi.fn(() => false),
    setToolsExpanded: vi.fn(),
  };
}

function makeDeps(
  overrides: {
    requestPermissionDecision?: typeof requestPermissionDecision;
  } = {},
) {
  const events = {
    emit: vi.fn(),
    on: vi.fn().mockReturnValue(() => undefined),
  };
  const ui = makePromptUi();
  const decisionFn =
    overrides.requestPermissionDecision ??
    vi
      .fn<typeof requestPermissionDecision>()
      .mockResolvedValue({ approved: true, state: "approved" });
  return {
    deps: {
      ui,
      mode: "tui" as const,
      cwd: "/test/project",
      events,
      getPromptPreferences: () => ({ doublePressToConfirm: true }),
      getConfig: () => DEFAULT_EXTENSION_CONFIG,
      requestPermissionDecision: decisionFn,
    },
    events,
    ui,
    decisionFn,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("LocalUserAuthorizer", () => {
  it("emits a UI prompt event with normalized surface and value", async () => {
    const { deps, events } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({
        toolName: "bash",
        command: "git push",
        toolInputPreview: "git push",
      }),
    );

    expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", {
      requestId: "req-123",
      source: "tool_call",
      surface: "bash",
      value: "git push",
      agentName: "test-agent",
      message: "Allow read?",
      forwarding: null,
    });
  });

  it("normalizes skill prompt events to the skill surface", async () => {
    const { deps, events } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({
        source: "skill_input",
        toolName: undefined,
        skillName: "deploy-helper",
      }),
    );

    expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", {
      requestId: "req-123",
      source: "skill_input",
      surface: "skill",
      value: "deploy-helper",
      agentName: "test-agent",
      message: "Allow read?",
      forwarding: null,
    });
  });

  it("calls requestPermissionDecision with the threaded view, title, and message", async () => {
    const { deps, ui, decisionFn } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(makeDetails());

    expect(decisionFn).toHaveBeenCalledWith(
      { mode: "tui", ui, doublePressToConfirm: true },
      "Permission Required",
      "Allow read?",
      undefined,
    );
  });

  it("passes the sessionLabel option when present", async () => {
    const { deps, decisionFn } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({ sessionLabel: "Yes, for 'read' tool" }),
    );

    expect(decisionFn).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.any(String),
      { sessionLabel: "Yes, for 'read' tool" },
    );
  });

  it("emits the UI event before calling requestPermissionDecision", async () => {
    const calls: string[] = [];
    const events = {
      emit: vi.fn(() => {
        calls.push("emit");
      }),
      on: vi.fn().mockReturnValue(() => undefined),
    };
    const ui = makePromptUi();
    const decisionFn = vi.fn<typeof requestPermissionDecision>(() => {
      calls.push("dialog");
      return Promise.resolve({ approved: true, state: "approved" });
    });
    const authorizer = new LocalUserAuthorizer({
      ui,
      mode: "tui",
      cwd: "/test/project",
      events,
      getPromptPreferences: () => ({ doublePressToConfirm: true }),
      getConfig: () => DEFAULT_EXTENSION_CONFIG,
      requestPermissionDecision: decisionFn,
    });

    await authorizer.authorize(makeDetails());

    expect(calls).toEqual(["emit", "dialog"]);
  });

  describe("forwarded provenance", () => {
    it("emits a non-degraded forwarded event with populated forwarding and the child's display projection", async () => {
      const { deps, events } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          source: "tool_call",
          agentName: "Explore",
          message:
            "Subagent 'Explore' requested permission.\n\nAllow git push?",
          surface: "bash",
          value: "git push",
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
        }),
      );

      expect(events.emit).toHaveBeenCalledWith("permissions:ui_prompt", {
        requestId: "req-123",
        source: "tool_call",
        surface: "bash",
        value: "git push",
        agentName: "Explore",
        message: "Subagent 'Explore' requested permission.\n\nAllow git push?",
        forwarding: {
          requesterAgentName: "Explore",
          requesterSessionId: "child-session",
        },
      });
    });

    it("uses the '(Subagent)' dialog title when the ask is forwarded", async () => {
      const { deps, ui, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
        }),
      );

      expect(decisionFn).toHaveBeenCalledWith(
        { mode: "tui", ui, doublePressToConfirm: true },
        "Permission Required (Subagent)",
        "Allow read?",
        undefined,
      );
    });

    it("offers a sessionScope when the forwarded ask carries a suggestion", async () => {
      const { deps, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          toolName: "bash",
          command: "git push",
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
          sessionApproval: { surface: "bash", patterns: ["git *"] },
        }),
      );

      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        "Permission Required (Subagent)",
        expect.any(String),
        {
          sessionScope: {
            subagentLabel: "This subagent ('Explore') only",
            servingSessionLabel:
              'The whole session — allow bash "git *" for parent and all subagents',
          },
        },
      );
    });

    it("offers no sessionScope for a forwarded ask without a suggestion", async () => {
      const { deps, decisionFn } = makeDeps();
      const authorizer = new LocalUserAuthorizer(deps);

      await authorizer.authorize(
        makeDetails({
          forwarding: {
            requesterAgentName: "Explore",
            requesterSessionId: "child-session",
          },
        }),
      );

      expect(decisionFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.any(String),
        undefined,
      );
    });
  });

  it("returns the decision from requestPermissionDecision", async () => {
    const decision: PermissionPromptDecision = {
      approved: false,
      state: "denied",
    };
    const { deps } = makeDeps({
      requestPermissionDecision: vi
        .fn<typeof requestPermissionDecision>()
        .mockResolvedValue(decision),
    });
    const authorizer = new LocalUserAuthorizer(deps);

    const result = await authorizer.authorize(makeDetails());

    expect(result).toEqual(decision);
  });
});

describe("LocalUserAuthorizer diff view", () => {
  it("uses the diff view for a local write ask and returns the approved decision", async () => {
    const { deps, ui, decisionFn } = makeDeps();
    let resolve: ((d: unknown) => void) | undefined;
    ui.custom.mockImplementation(
      (_factory: unknown, _options: unknown) =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const authorizer = new LocalUserAuthorizer(deps);

    const promise = authorizer.authorize(
      makeDetails({
        toolName: "write",
        toolInput: { path: "/test/project/new.txt", content: "hello\n" },
      }),
    );

    expect(decisionFn).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(ui.custom).toHaveBeenCalledTimes(1));

    const build = ui.custom.mock.calls[0]?.[0] as (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (d: unknown) => void,
    ) => {
      render(width: number): string[];
      invalidate(): void;
      handleInput(data: string): void;
    };
    const fakeTheme = {
      fg: (_c: string, t: string) => t,
      bg: (_c: string, t: string) => t,
      bold: (t: string) => t,
      getBgAnsi: () => "",
    };
    const fakeTui = { requestRender: vi.fn() };
    const component = build(
      fakeTui,
      fakeTheme,
      { matches: () => false },
      resolve ?? (() => {}),
    );

    const text = component.render(80).join("\n");
    expect(text).toContain("hello");
    expect(text).toContain("(y) Yes");

    component.handleInput("y");
    component.handleInput("y");
    expect(await promise).toEqual({ approved: true, state: "approved" });
  });

  it("falls back to requestPermissionDecision when toolDiffPrompt is off", async () => {
    const { deps, decisionFn } = makeDeps();
    deps.getConfig = () => ({
      ...DEFAULT_EXTENSION_CONFIG,
      toolDiffPrompt: false,
    });
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(
      makeDetails({ toolName: "write", toolInput: {} }),
    );

    expect(decisionFn).toHaveBeenCalled();
  });

  it("does not use the diff view for a non-write/edit tool (read)", async () => {
    const { deps, ui, decisionFn } = makeDeps();
    const authorizer = new LocalUserAuthorizer(deps);

    await authorizer.authorize(makeDetails({ toolName: "read" }));

    expect(decisionFn).toHaveBeenCalled();
    expect(ui.custom).not.toHaveBeenCalled();
  });
});
