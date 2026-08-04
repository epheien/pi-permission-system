import { describe, expect, it, vi } from "vitest";
import type { TerminalAuthorizer } from "#src/authority/authorizer";
import type { PermissionPromptDecision } from "#src/authority/permission-dialog";
import {
  PermissionPrompter,
  type PermissionPrompterDeps,
  type PromptPermissionDetails,
} from "#src/authority/permission-prompter";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeAuthorizer(
  decision: PermissionPromptDecision,
): TerminalAuthorizer {
  return {
    authorize: vi
      .fn<TerminalAuthorizer["authorize"]>()
      .mockResolvedValue(decision),
  };
}

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

function makeDeps(
  overrides?: Partial<PermissionPrompterDeps>,
): PermissionPrompterDeps {
  return {
    logger: { review: vi.fn() },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PermissionPrompter", () => {
  describe("prompt flow", () => {
    it("logs permission_request.waiting before the outcome", async () => {
      const logger = { review: vi.fn() };
      const prompter = new PermissionPrompter(makeDeps({ logger }));
      const authorizer = makeAuthorizer({ approved: true, state: "approved" });

      await prompter.prompt(authorizer, makeDetails());

      const calls = logger.review.mock.calls.map((c) => c[0] as string);
      expect(
        calls.indexOf("permission_request.waiting"),
      ).toBeGreaterThanOrEqual(0);
      expect(calls.indexOf("permission_request.waiting")).toBeLessThan(
        calls.indexOf("permission_request.approved"),
      );
    });

    it("calls authorizer.authorize with the details", async () => {
      const authorizer = makeAuthorizer({ approved: true, state: "approved" });
      const prompter = new PermissionPrompter(makeDeps());
      const details = makeDetails();

      await prompter.prompt(authorizer, details);

      expect(authorizer.authorize).toHaveBeenCalledWith(details);
    });

    it("logs permission_request.approved when the authorizer approves", async () => {
      const logger = { review: vi.fn() };
      const prompter = new PermissionPrompter(makeDeps({ logger }));
      const authorizer = makeAuthorizer({ approved: true, state: "approved" });

      await prompter.prompt(authorizer, makeDetails());

      expect(logger.review).toHaveBeenCalledWith(
        "permission_request.approved",
        expect.objectContaining({
          requestId: "req-123",
          resolution: "approved",
        }),
      );
    });

    it("logs permission_request.denied when the authorizer denies", async () => {
      const logger = { review: vi.fn() };
      const prompter = new PermissionPrompter(makeDeps({ logger }));
      const authorizer = makeAuthorizer({ approved: false, state: "denied" });

      await prompter.prompt(authorizer, makeDetails());

      expect(logger.review).toHaveBeenCalledWith(
        "permission_request.denied",
        expect.objectContaining({
          requestId: "req-123",
          resolution: "denied",
        }),
      );
    });

    it("logs confirmation_unavailable resolution when the decision carries the marker", async () => {
      const logger = { review: vi.fn() };
      const prompter = new PermissionPrompter(makeDeps({ logger }));
      const authorizer = makeAuthorizer({
        approved: false,
        state: "denied",
        confirmationUnavailable: true,
      });

      await prompter.prompt(authorizer, makeDetails());

      expect(logger.review).toHaveBeenCalledWith(
        "permission_request.denied",
        expect.objectContaining({
          resolution: "confirmation_unavailable",
        }),
      );
    });

    it("logs permission_request.denied with denialReason when present", async () => {
      const logger = { review: vi.fn() };
      const prompter = new PermissionPrompter(makeDeps({ logger }));
      const authorizer = makeAuthorizer({
        approved: false,
        state: "denied_with_reason",
        denialReason: "too sensitive",
      });

      await prompter.prompt(authorizer, makeDetails());

      expect(logger.review).toHaveBeenCalledWith(
        "permission_request.denied",
        expect.objectContaining({
          denialReason: "too sensitive",
        }),
      );
    });

    it("returns the decision from the authorizer", async () => {
      const decision: PermissionPromptDecision = {
        approved: false,
        state: "denied_with_reason",
        denialReason: "sensitive",
      };
      const authorizer = makeAuthorizer(decision);
      const prompter = new PermissionPrompter(makeDeps());

      const result = await prompter.prompt(authorizer, makeDetails());

      expect(result).toEqual(decision);
    });
  });

  // ── Review log field coverage ────────────────────────────────────────────

  describe("review log fields", () => {
    it("includes all standard fields in the waiting log entry", async () => {
      const logger = { review: vi.fn() };
      const prompter = new PermissionPrompter(makeDeps({ logger }));
      const authorizer = makeAuthorizer({ approved: true, state: "approved" });
      const details = makeDetails({
        toolCallId: "tc-1",
        skillName: "librarian",
        path: "/src/foo.ts",
        command: "git status",
        target: "server:tool",
        toolInputPreview: "{ path: '...' }",
      });

      await prompter.prompt(authorizer, details);

      expect(logger.review).toHaveBeenCalledWith(
        "permission_request.waiting",
        expect.objectContaining({
          requestId: "req-123",
          source: "tool_call",
          agentName: "test-agent",
          message: "Allow read?",
          toolCallId: "tc-1",
          toolName: "read",
          skillName: "librarian",
          path: "/src/foo.ts",
          command: "git status",
          target: "server:tool",
          toolInputPreview: "{ path: '...' }",
        }),
      );
    });

    it("uses null for optional fields not present in details", async () => {
      const logger = { review: vi.fn() };
      const prompter = new PermissionPrompter(makeDeps({ logger }));
      const authorizer = makeAuthorizer({ approved: true, state: "approved" });

      await prompter.prompt(authorizer, makeDetails());

      expect(logger.review).toHaveBeenCalledWith(
        "permission_request.waiting",
        expect.objectContaining({
          toolCallId: null,
          skillName: null,
          path: null,
          command: null,
          target: null,
          toolInputPreview: null,
        }),
      );
    });
  });
});
