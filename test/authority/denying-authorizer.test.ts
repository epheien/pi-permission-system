import { describe, expect, it } from "vitest";
import type { TerminalAuthorizer } from "#src/authority/authorizer";
import { DenyingAuthorizer } from "#src/authority/denying-authorizer";

describe("DenyingAuthorizer", () => {
  it("denies with the confirmation-unavailable marker, regardless of details", async () => {
    const authorizer: TerminalAuthorizer = new DenyingAuthorizer();

    const decision = await authorizer.authorize({
      requestId: "req-1",
      source: "tool_call",
      agentName: "test-agent",
      message: "Allow this?",
    });

    expect(decision).toEqual({
      approved: false,
      state: "denied",
      confirmationUnavailable: true,
    });
  });

  it("denies the same way for a skill-sourced request", async () => {
    const authorizer: TerminalAuthorizer = new DenyingAuthorizer();

    const decision = await authorizer.authorize({
      requestId: "req-2",
      source: "skill_input",
      agentName: null,
      message: "Allow skill input?",
      skillName: "deploy-helper",
    });

    expect(decision).toEqual({
      approved: false,
      state: "denied",
      confirmationUnavailable: true,
    });
  });
});
