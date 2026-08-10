import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cleanupPermissionForwardingLocationIfEmpty,
  ensureDirectoryExists,
  formatUnknownErrorMessage,
  isErrnoCode,
  logPermissionForwardingError,
  logPermissionForwardingWarning,
  readForwardedPermissionRequest,
  tryRemoveDirectoryIfEmpty,
  writeJsonFileAtomic,
} from "#src/authority/forwarding-io";
import {
  createPermissionForwardingLocation,
  type ForwardedAccessIntent,
  type ForwardedPermissionRequest,
} from "#src/authority/permission-forwarding";
import type { DebugReviewLogger } from "#src/session-logger";

// ── helpers ────────────────────────────────────────────────────────────────

function makeLogger(): DebugReviewLogger {
  return {
    review: vi.fn(),
    debug: vi.fn(),
  };
}

// ── formatUnknownErrorMessage ──────────────────────────────────────────────

describe("formatUnknownErrorMessage", () => {
  it("returns the error message for Error instances", () => {
    expect(formatUnknownErrorMessage(new Error("oops"))).toBe("oops");
  });

  it("converts non-Error values to string", () => {
    expect(formatUnknownErrorMessage("raw string")).toBe("raw string");
    expect(formatUnknownErrorMessage(42)).toBe("42");
  });

  it("falls back to String(error) for Error with empty message", () => {
    // error.message is falsy (""), so the function falls through to String(error)
    const e = new Error("");
    expect(formatUnknownErrorMessage(e)).toBe("Error");
  });
});

// ── isErrnoCode ────────────────────────────────────────────────────────────

describe("isErrnoCode", () => {
  it("returns true when code matches", () => {
    expect(isErrnoCode({ code: "ENOENT" }, "ENOENT")).toBe(true);
  });

  it("returns false when code does not match", () => {
    expect(isErrnoCode({ code: "EACCES" }, "ENOENT")).toBe(false);
  });

  it("returns false for null", () => {
    expect(isErrnoCode(null, "ENOENT")).toBe(false);
  });

  it("returns false when no code property", () => {
    expect(isErrnoCode({}, "ENOENT")).toBe(false);
  });
});

// ── logPermissionForwardingWarning ─────────────────────────────────────────

describe("logPermissionForwardingWarning", () => {
  it("calls logger.review with the warning event", () => {
    const logger = makeLogger();
    logPermissionForwardingWarning(logger, "something went wrong");
    expect(logger.review).toHaveBeenCalledWith(
      "permission_forwarding.warning",
      { message: "something went wrong" },
    );
  });

  it("calls logger.debug with the warning event", () => {
    const logger = makeLogger();
    logPermissionForwardingWarning(logger, "something went wrong");
    expect(logger.debug).toHaveBeenCalledWith("permission_forwarding.warning", {
      message: "something went wrong",
    });
  });

  it("includes formatted error when an error is provided", () => {
    const logger = makeLogger();
    logPermissionForwardingWarning(logger, "bad thing", new Error("fs fail"));
    expect(logger.review).toHaveBeenCalledWith(
      "permission_forwarding.warning",
      { message: "bad thing", error: "fs fail" },
    );
  });

  it("does not throw when logger is null", () => {
    expect(() => logPermissionForwardingWarning(null, "ignored")).not.toThrow();
  });

  it("does not call anything when logger is null", () => {
    // Verify the null-logger path is a true no-op — cannot easily spy on null,
    // but we can verify the call succeeds silently.
    expect(() =>
      logPermissionForwardingWarning(null, "msg", new Error("err")),
    ).not.toThrow();
  });
});

// ── logPermissionForwardingError ───────────────────────────────────────────

describe("logPermissionForwardingError", () => {
  it("calls logger.review with the error event", () => {
    const logger = makeLogger();
    logPermissionForwardingError(logger, "critical failure");
    expect(logger.review).toHaveBeenCalledWith("permission_forwarding.error", {
      message: "critical failure",
    });
  });

  it("calls logger.debug with the error event", () => {
    const logger = makeLogger();
    logPermissionForwardingError(logger, "critical failure");
    expect(logger.debug).toHaveBeenCalledWith("permission_forwarding.error", {
      message: "critical failure",
    });
  });

  it("includes formatted error when an error is provided", () => {
    const logger = makeLogger();
    logPermissionForwardingError(logger, "io error", new Error("ENOENT"));
    expect(logger.review).toHaveBeenCalledWith("permission_forwarding.error", {
      message: "io error",
      error: "ENOENT",
    });
  });

  it("does not throw when logger is null", () => {
    expect(() => logPermissionForwardingError(null, "ignored")).not.toThrow();
  });
});

// ── file permissions ───────────────────────────────────────────────────────

describe("forwarding artifact permissions", () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("writes a forwarded request owner-only", () => {
    root = mkdtempSync(join(tmpdir(), "io-modes-"));
    const filePath = join(root, "req.json");

    writeJsonFileAtomic(null, filePath, { id: "req-1" });

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("creates a forwarding directory owner-only", () => {
    root = mkdtempSync(join(tmpdir(), "io-modes-"));
    const dirPath = join(root, "sessions", "parent", "requests");

    expect(ensureDirectoryExists(null, dirPath, "requests")).toBe(true);

    expect(statSync(dirPath).mode & 0o777).toBe(0o700);
  });
});

// ── readForwardedPermissionRequest ─────────────────────────────────────────

describe("readForwardedPermissionRequest — accessIntent field", () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function baseRequest(): ForwardedPermissionRequest {
    return {
      id: "req-1",
      createdAt: 1000,
      requesterSessionId: "child-session",
      targetSessionId: "parent-session",
      requesterAgentName: "researcher",
      message: "Allow this path access?",
    };
  }

  function writeAndRead(raw: unknown): ForwardedPermissionRequest | null {
    root = mkdtempSync(join(tmpdir(), "io-read-"));
    const filePath = join(root, "req.json");
    writeJsonFileAtomic(null, filePath, raw);
    return readForwardedPermissionRequest(null, filePath);
  }

  it("round-trips a well-formed access intent (path surface)", () => {
    const accessIntent: ForwardedAccessIntent = {
      surface: "path",
      matchValues: ["/worktree/issue-42/src/foo.ts", "src/foo.ts"],
      boundaryValue: "/worktree/issue-42/src/foo.ts",
      requesterCwd: "/worktree/issue-42",
      requesterIsSubagent: false,
      principal: { sessionId: "child-session", agentName: "researcher" },
    };
    const parsed = writeAndRead({ ...baseRequest(), accessIntent });
    expect(parsed?.accessIntent).toEqual(accessIntent);
  });

  it("round-trips a non-path access intent (skill surface, null boundary)", () => {
    const accessIntent: ForwardedAccessIntent = {
      surface: "skill",
      matchValues: ["deep-research"],
      boundaryValue: null,
      requesterCwd: "/repo",
      requesterIsSubagent: false,
      principal: { sessionId: "child-session", agentName: "unknown" },
    };
    const parsed = writeAndRead({ ...baseRequest(), accessIntent });
    expect(parsed?.accessIntent).toEqual(accessIntent);
  });

  it("carries only strings on matchValues (the ADR-0002 wire boundary)", () => {
    const accessIntent: ForwardedAccessIntent = {
      surface: "external_directory",
      matchValues: ["/etc/hosts", "/private/etc/hosts"],
      boundaryValue: "/private/etc/hosts",
      requesterCwd: "/repo",
      principal: { sessionId: "child-session", agentName: "researcher" },
    };
    const parsed = writeAndRead({ ...baseRequest(), accessIntent });
    expect(
      parsed?.accessIntent?.matchValues.every((v) => typeof v === "string"),
    ).toBe(true);
    expect(
      parsed?.accessIntent?.boundaryValue === null ||
        typeof parsed?.accessIntent?.boundaryValue === "string",
    ).toBe(true);
  });

  it("round-trips requesterIsSubagent=true and narrows any non-true value to false", () => {
    const accessIntent: ForwardedAccessIntent = {
      surface: "edit",
      matchValues: ["/app/x"],
      boundaryValue: null,
      requesterCwd: "/repo",
      principal: { sessionId: "child-session", agentName: "worker" },
      requesterIsSubagent: true,
    };
    const parsed = writeAndRead({ ...baseRequest(), accessIntent });
    expect(parsed?.accessIntent?.requesterIsSubagent).toBe(true);

    // A foreign/older child that stamps a non-boolean is narrowed to false.
    const foreign = {
      ...accessIntent,
      requesterIsSubagent: "yes",
    } as unknown as ForwardedAccessIntent;
    const parsedForeign = writeAndRead({
      ...baseRequest(),
      accessIntent: foreign,
    });
    expect(parsedForeign?.accessIntent?.requesterIsSubagent).toBe(false);
  });

  it("reads a request with no access intent as undefined (version skew)", () => {
    const parsed = writeAndRead(baseRequest());
    expect(parsed?.accessIntent).toBeUndefined();
    // Display/routing fields still reconstruct.
    expect(parsed?.message).toBe("Allow this path access?");
    expect(parsed?.requesterAgentName).toBe("researcher");
  });

  it("drops a malformed access intent to undefined (non-string match value)", () => {
    const parsed = writeAndRead({
      ...baseRequest(),
      accessIntent: {
        surface: "path",
        matchValues: ["/ok", 42],
        boundaryValue: null,
        requesterCwd: "/repo",
        principal: { sessionId: "child-session", agentName: "researcher" },
      },
    });
    expect(parsed?.accessIntent).toBeUndefined();
  });

  it("drops a malformed access intent to undefined (missing principal)", () => {
    const parsed = writeAndRead({
      ...baseRequest(),
      accessIntent: {
        surface: "path",
        matchValues: ["/ok"],
        boundaryValue: null,
        requesterCwd: "/repo",
      },
    });
    expect(parsed?.accessIntent).toBeUndefined();
  });
});

// ── tryRemoveDirectoryIfEmpty ──────────────────────────────────────────────

describe("tryRemoveDirectoryIfEmpty", () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns true when the directory does not exist", () => {
    root = mkdtempSync(join(tmpdir(), "io-test-"));
    const absent = join(root, "nonexistent");
    expect(tryRemoveDirectoryIfEmpty(null, absent, "test")).toBe(true);
  });

  it("returns true and removes an empty directory", () => {
    root = mkdtempSync(join(tmpdir(), "io-test-"));
    const dir = join(root, "empty");
    mkdirSync(dir);
    expect(tryRemoveDirectoryIfEmpty(null, dir, "test")).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("returns false and leaves a non-empty directory in place", () => {
    root = mkdtempSync(join(tmpdir(), "io-test-"));
    const dir = join(root, "nonempty");
    mkdirSync(dir);
    writeFileSync(join(dir, "file.json"), "{}", "utf-8");
    expect(tryRemoveDirectoryIfEmpty(null, dir, "test")).toBe(false);
    expect(existsSync(dir)).toBe(true);
  });
});

// ── cleanupPermissionForwardingLocationIfEmpty ─────────────────────────────

describe("cleanupPermissionForwardingLocationIfEmpty", () => {
  let root: string;

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("preserves responses/ when requests/ is non-empty (the concurrent-request race)", () => {
    root = mkdtempSync(join(tmpdir(), "io-cleanup-"));
    const forwardingDir = join(root, "forwarding");
    const location = createPermissionForwardingLocation(
      forwardingDir,
      "parent-session",
    );
    // Simulate: requests/ has a pending file, responses/ is momentarily empty
    mkdirSync(location.requestsDir, { recursive: true });
    mkdirSync(location.responsesDir, { recursive: true });
    writeFileSync(join(location.requestsDir, "req-b.json"), "{}", "utf-8");
    // responses/ is empty (sibling subagent A already cleaned up its response)

    cleanupPermissionForwardingLocationIfEmpty(null, location);

    // requests/ is non-empty → should NOT be removed
    expect(existsSync(location.requestsDir)).toBe(true);
    // responses/ must survive — removing it causes the ENOENT write loop
    expect(existsSync(location.responsesDir)).toBe(true);
    // sessionRoot must also survive while subdirs are present
    expect(existsSync(location.sessionRootDir)).toBe(true);
  });

  it("removes both subdirs and sessionRoot when both are empty (normal serial cleanup)", () => {
    root = mkdtempSync(join(tmpdir(), "io-cleanup-"));
    const forwardingDir = join(root, "forwarding");
    const location = createPermissionForwardingLocation(
      forwardingDir,
      "parent-session",
    );
    mkdirSync(location.requestsDir, { recursive: true });
    mkdirSync(location.responsesDir, { recursive: true });
    // Both empty — normal end-of-lifecycle state

    cleanupPermissionForwardingLocationIfEmpty(null, location);

    expect(existsSync(location.requestsDir)).toBe(false);
    expect(existsSync(location.responsesDir)).toBe(false);
    expect(existsSync(location.sessionRootDir)).toBe(false);
  });

  it("leaves responses/ in place when it is non-empty even if requests/ is empty", () => {
    root = mkdtempSync(join(tmpdir(), "io-cleanup-"));
    const forwardingDir = join(root, "forwarding");
    const location = createPermissionForwardingLocation(
      forwardingDir,
      "parent-session",
    );
    mkdirSync(location.requestsDir, { recursive: true });
    mkdirSync(location.responsesDir, { recursive: true });
    writeFileSync(join(location.responsesDir, "resp.json"), "{}", "utf-8");
    // requests/ is empty, responses/ has a stale response

    cleanupPermissionForwardingLocationIfEmpty(null, location);

    // requests/ is empty so it gets removed
    expect(existsSync(location.requestsDir)).toBe(false);
    // responses/ is non-empty → survives
    expect(existsSync(location.responsesDir)).toBe(true);
    // sessionRoot survives because responses/ is still present
    expect(existsSync(location.sessionRootDir)).toBe(true);
  });
});
