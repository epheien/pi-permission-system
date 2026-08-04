/**
 * Shared fixtures for the forwarding subsystem's test files.
 *
 * Collapses the temp forwarding-directory scaffolding, the forwarded-request
 * writer, and the `ParentAuthorizerDeps` / `ForwardedRequestServerDeps` /
 * `ForwarderContext` / UI-decision builders that the split-out per-class test
 * files repeated per test.
 *
 * Consumed by test/authority/approval-escalator.test.ts (the escalation-up
 * role, ParentAuthorizer since #555) and test/authority/forwarded-request-server.test.ts
 * (the serving-down role) — both extracted from `PermissionForwarder` by Phase 8
 * Step 6 (#530).
 * The `{ emit, on }` events mock is not duplicated here — reuse `makeEvents`
 * from `#test/helpers/handler-fixtures`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

import type { ForwardedRequestServerDeps } from "#src/authority/forwarded-request-server";
import type { ForwarderContext } from "#src/authority/forwarder-context";
import {
  createPermissionForwardingLocation,
  type ForwardedAccessIntent,
  type ForwardedPermissionRequest,
  type PermissionForwardingLocation,
} from "#src/authority/permission-forwarding";
import {
  type SubagentSessionInfo,
  SubagentSessionRegistry,
} from "#src/authority/subagent-registry";
import { makeCheckResult } from "#test/helpers/handler-fixtures";

/** Handle over a temp forwarding directory; register `cleanup` in `afterEach`. */
export interface ForwardingTempDir {
  /** Absolute path passed as `forwardingDir` to `ParentAuthorizerDeps` / `ForwardedRequestServerDeps`. */
  forwardingDir: string;
  /** The session's request/response location under `forwardingDir`. */
  location: PermissionForwardingLocation;
  /** Writes a `ForwardedPermissionRequest` JSON into `location.requestsDir`. */
  writeRequest(
    overrides?: Partial<ForwardedPermissionRequest>,
  ): ForwardedPermissionRequest;
  /** `rmSync(root, { recursive, force })`. */
  cleanup(): void;
}

/**
 * Creates a temp forwarding directory for `sessionId`.
 *
 * Always creates `requests/`; pass `{ createResponsesDir: false }` to omit
 * `responses/` (the missing-`responses/` race test relies on this).
 */
export function createForwardingTempDir(
  sessionId: string,
  options: { createResponsesDir?: boolean } = {},
): ForwardingTempDir {
  const root = mkdtempSync(join(tmpdir(), "permission-forwarding-"));
  const forwardingDir = join(root, "forwarding");
  const location = createPermissionForwardingLocation(forwardingDir, sessionId);
  mkdirSync(location.requestsDir, { recursive: true });
  if (options.createResponsesDir ?? true) {
    mkdirSync(location.responsesDir, { recursive: true });
  }

  return {
    forwardingDir,
    location,
    writeRequest(overrides = {}) {
      const request: ForwardedPermissionRequest = {
        id: "req-forwarded",
        createdAt: Date.now(),
        requesterSessionId: "child-session",
        targetSessionId: sessionId,
        requesterAgentName: "Explore",
        message: "Allow git push?",
        ...overrides,
      };
      writeFileSync(
        join(location.requestsDir, `${request.id}.json`),
        JSON.stringify(request),
        "utf-8",
      );
      return request;
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Builds `ForwardedRequestServerDeps` with a policy that defers to escalation
 * (`ask`) and an approving escalator.
 *
 * Override `policy` / `escalator` with captured `vi.fn()` mocks to assert the
 * resolve-then-escalate flow (e.g. `policy: { resolve }` returning
 * `makeCheckResult({ state: "allow" })`, `escalator: { escalate }`).
 */
export function makeServerDeps(
  overrides: Partial<ForwardedRequestServerDeps> = {},
): ForwardedRequestServerDeps {
  return {
    forwardingDir: "/tmp/forwarding",
    logger: { review: vi.fn(), debug: vi.fn() },
    policy: { resolve: vi.fn(() => makeCheckResult({ state: "ask" })) },
    escalator: {
      escalate: vi
        .fn()
        .mockResolvedValue({ approved: true, state: "approved" }),
    },
    recorder: { recordSessionApproval: vi.fn() },
    ...overrides,
  };
}

/**
 * Builds a well-formed `ForwardedAccessIntent` (ADR 0008 §2) for request /
 * policy fixtures. Defaults model a child in a worktree: a cwd-relative alias
 * alongside the absolute one, so a relative parent rule stays relevant across
 * cwds.
 */
export function makeForwardedAccessIntent(
  overrides: Partial<ForwardedAccessIntent> = {},
): ForwardedAccessIntent {
  return {
    surface: "bash",
    matchValues: ["git status"],
    boundaryValue: null,
    requesterCwd: "/worktree/issue-42",
    principal: { sessionId: "child-session", agentName: "Explore" },
    ...overrides,
  };
}

/**
 * Builds a `ForwarderContext`.
 *
 * The `sessionId` shortcut populates `getSessionId`; an explicit
 * `sessionManager` override merges last for tests stubbing other readers.
 */
export function makeForwarderContext(
  overrides: {
    hasUI?: boolean;
    ui?: ForwarderContext["ui"];
    cwd?: string;
    sessionId?: string;
    sessionManager?: Partial<ForwarderContext["sessionManager"]>;
  } = {},
): ForwarderContext {
  return {
    hasUI: overrides.hasUI ?? false,
    ui: overrides.ui ?? { select: vi.fn(), input: vi.fn() },
    cwd: overrides.cwd ?? "/repo",
    sessionManager: {
      getSessionId: vi.fn(() => overrides.sessionId ?? ""),
      getSessionDir: vi.fn(() => ""),
      getEntries: vi.fn(() => []),
      ...overrides.sessionManager,
    },
  };
}

/**
 * Builds a `SubagentSessionRegistry`, optionally pre-registering `childSessionId`.
 *
 * Omit `entry` for an empty registry (the "session not in registry" case);
 * pass `{}` to register `childSessionId` with no `parentSessionId`.
 */
export function makeSubagentRegistry(
  childSessionId: string,
  entry?: SubagentSessionInfo,
): SubagentSessionRegistry {
  const registry = new SubagentSessionRegistry();
  if (entry) {
    registry.register(childSessionId, entry);
  }
  return registry;
}
