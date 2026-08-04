import { describe, expect, it } from "vitest";

import { buildUiPrompt } from "#src/permission-ui-prompt";

describe("buildUiPrompt", () => {
  it("normalizes a skill prompt to the skill surface and skill-name value", () => {
    expect(
      buildUiPrompt({
        requestId: "req-2",
        source: "skill_input",
        agentName: null,
        message: "Allow skill?",
        skillName: "deploy-helper",
      }),
    ).toEqual({
      requestId: "req-2",
      source: "skill_input",
      surface: "skill",
      value: "deploy-helper",
      agentName: null,
      message: "Allow skill?",
      forwarding: null,
    });
  });

  it("derives value with command > path > target > skillName > toolName precedence", () => {
    expect(
      buildUiPrompt({
        requestId: "req-3",
        source: "tool_call",
        agentName: null,
        message: "m",
        toolName: "read",
        path: "/etc/hosts",
        target: "ignored",
      }).value,
    ).toBe("/etc/hosts");
  });

  it("derives surface and value from direct fields and defaults forwarding to null", () => {
    expect(
      buildUiPrompt({
        requestId: "req-u1",
        source: "tool_call",
        agentName: "Explore",
        message: "Allow git push?",
        toolName: "bash",
        command: "git push",
      }),
    ).toEqual({
      requestId: "req-u1",
      source: "tool_call",
      surface: "bash",
      value: "git push",
      agentName: "Explore",
      message: "Allow git push?",
      forwarding: null,
    });
  });

  it("uses explicit surface and value overrides in place of the derived projection", () => {
    expect(
      buildUiPrompt({
        requestId: "req-u2",
        source: "tool_call",
        agentName: "Explore",
        message: "m",
        toolName: "bash",
        command: "git push",
        surface: "external_directory",
        value: "/etc/hosts",
      }),
    ).toEqual({
      requestId: "req-u2",
      source: "tool_call",
      surface: "external_directory",
      value: "/etc/hosts",
      agentName: "Explore",
      message: "m",
      forwarding: null,
    });
  });

  it("treats an explicit null surface/value override as intentional, not a fallback trigger", () => {
    expect(
      buildUiPrompt({
        requestId: "req-u3",
        source: "tool_call",
        agentName: null,
        message: "m",
        toolName: "bash",
        command: "git push",
        surface: null,
        value: null,
      }),
    ).toEqual({
      requestId: "req-u3",
      source: "tool_call",
      surface: null,
      value: null,
      agentName: null,
      message: "m",
      forwarding: null,
    });
  });

  it("passes forwarding context through alongside explicit display fields", () => {
    expect(
      buildUiPrompt({
        requestId: "req-u4",
        source: "tool_call",
        agentName: "Explore",
        message: "Subagent 'Explore' requested permission.\n\nAllow git push?",
        surface: "bash",
        value: "git push",
        forwarding: {
          requesterAgentName: "Explore",
          requesterSessionId: "child-session",
        },
      }),
    ).toEqual({
      requestId: "req-u4",
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

  it("passes forwarding context with null requester identity through unchanged", () => {
    expect(
      buildUiPrompt({
        requestId: "req-fwd-null",
        source: "tool_call",
        agentName: null,
        message: "Allow?",
        surface: null,
        value: null,
        forwarding: { requesterAgentName: null, requesterSessionId: null },
      }),
    ).toEqual({
      requestId: "req-fwd-null",
      source: "tool_call",
      surface: null,
      value: null,
      agentName: null,
      message: "Allow?",
      forwarding: { requesterAgentName: null, requesterSessionId: null },
    });
  });
});
