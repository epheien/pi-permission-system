/**
 * Tests for the "not main" default policy layer (`subagentPermission`).
 *
 * Precedence model (spec docs/superpowers/specs/2026-08-10-subagent-permission-default-design.md):
 *   main (global+project) → subagent (subagentPermission) → specify (per-agent frontmatter)
 *
 * The manager composes the subagent layer only when `isSubagent()` is true;
 * a main session must be completely unaffected.
 */
import { describe, expect, it } from "vitest";
import type { ResolvedAccessIntent } from "#src/access-intent/access-intent";
import { posixPathFlavor } from "#src/path/path-flavor";
import { PermissionManager } from "#src/permission-manager";
import type { ScopeConfig } from "#src/types";
import {
  createInMemoryPolicyLoader,
  createManagerWithProject,
} from "#test/helpers/manager-harness";

function toolIntent(
  surface: string,
  input: Record<string, unknown> = {},
  agentName?: string,
): ResolvedAccessIntent {
  return { kind: "tool", surface, input, agentName };
}

/** Manager over an in-memory loader with the flag pre-set. */
function managerWith(
  global: ScopeConfig,
  isSubagent: boolean,
): PermissionManager {
  return new PermissionManager({
    policyLoader: createInMemoryPolicyLoader({ global }),
    flavor: posixPathFlavor,
    isSubagent: () => isSubagent,
  });
}

describe("PermissionManager — subagentPermission (not-main default layer)", () => {
  it("main agent: subagentPermission is ignored (write stays allow from main)", () => {
    const manager = managerWith(
      { permission: { write: "allow" }, subagentPermission: { write: "ask" } },
      false,
    );
    expect(manager.check(toolIntent("write", { path: "/app/x" })).state).toBe(
      "allow",
    );
  });

  it("subagent: write/edt default to ask, keys not set fall through to main", () => {
    const manager = managerWith(
      {
        permission: { read: "allow", write: "allow" },
        subagentPermission: { write: "ask", edit: "ask" },
      },
      true,
    );
    expect(manager.check(toolIntent("write", { path: "/app/x" })).state).toBe(
      "ask",
    );
    expect(manager.check(toolIntent("edit", { path: "/app/x" })).state).toBe(
      "ask",
    );
    // read is not in subagentPermission → falls through to main allow.
    expect(manager.check(toolIntent("read", { path: "/app/x" })).state).toBe(
      "allow",
    );
  });

  it("specify wins: per-agent frontmatter write:allow overrides subagent ask", () => {
    const { manager, cleanup } = createManagerWithProject(
      { permission: { write: "allow" }, subagentPermission: { write: "ask" } },
      { worker: "---\npermission:\n  write: allow\n---\n" },
      { isSubagent: true },
    );
    try {
      expect(
        manager.check(toolIntent("write", { path: "/app/x" }, "worker")).state,
      ).toBe("allow");
    } finally {
      cleanup();
    }
  });

  it("project subagentPermission overrides global subagentPermission", () => {
    const { manager, cleanup } = createManagerWithProject(
      { subagentPermission: { write: "allow", edit: "allow" } },
      {},
      {
        projectConfig: {
          subagentPermission: { write: "ask" },
        },
        isSubagent: true,
      },
    );
    try {
      expect(manager.check(toolIntent("write", { path: "/app/x" })).state).toBe(
        "ask",
      );
      // edit not set at project level → global subagent allow still applies.
      expect(manager.check(toolIntent("edit", { path: "/app/x" })).state).toBe(
        "allow",
      );
    } finally {
      cleanup();
    }
  });

  it('subagentPermission["*"] overrides the fallback for subagents only', () => {
    const main = managerWith({ subagentPermission: { "*": "allow" } }, false);
    // Main session: universal fallback stays "ask".
    expect(main.check(toolIntent("unknown-tool")).state).toBe("ask");

    const sub = managerWith({ subagentPermission: { "*": "allow" } }, true);
    // Subagent session: universal fallback becomes "allow".
    expect(sub.check(toolIntent("unknown-tool")).state).toBe("allow");
  });

  it("getComposedConfigRules annotates the subagent origin", () => {
    const manager = managerWith({ subagentPermission: { write: "ask" } }, true);
    const rules = manager.getComposedConfigRules();
    expect(
      rules.some((r) => r.surface === "write" && r.origin === "subagent"),
    ).toBe(true);
  });
});

describe("manager — serving a forwarded ask ('requesterIsSubagent')", () => {
  it("composes the subagentPermission layer for a subagent requester even though the serving node is the main session", () => {
    const manager = managerWith(
      {
        permission: { read: "allow", edit: "allow", write: "allow" },
        subagentPermission: { edit: "ask", write: "ask" },
      },
      false, // serving node itself is the main session
    );
    expect(
      manager.check(toolIntent("edit", { path: "/app/x" }), undefined, {
        requesterIsSubagent: true,
      }).state,
    ).toBe("ask");
    expect(
      manager.check(toolIntent("write", { path: "/app/x" }), undefined, {
        requesterIsSubagent: true,
      }).state,
    ).toBe("ask");
    // A key absent from subagentPermission still falls through to main.
    expect(
      manager.check(toolIntent("read", { path: "/app/x" }), undefined, {
        requesterIsSubagent: true,
      }).state,
    ).toBe("allow");
  });

  it("keeps the main map untouched when the requester is not a subagent", () => {
    const manager = managerWith(
      {
        permission: { read: "allow", edit: "allow", write: "allow" },
        subagentPermission: { edit: "ask", write: "ask" },
      },
      false,
    );
    expect(
      manager.check(toolIntent("edit", { path: "/app/x" }), undefined, {
        requesterIsSubagent: false,
      }).state,
    ).toBe("allow");
    // Main-session default call (no requester flag) is unaffected too.
    expect(manager.check(toolIntent("edit", { path: "/app/x" })).state).toBe(
      "allow",
    );
  });
});
