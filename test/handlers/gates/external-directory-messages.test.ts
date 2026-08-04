import { describe, expect, test } from "vitest";

import {
  formatBashExternalDirectoryAskPrompt,
  formatExternalDirectoryAskPrompt,
} from "#src/handlers/gates/external-directory-messages";

// Denial message functions (formatExternalDirectoryDenyReason,
// formatExternalDirectoryUserDeniedReason, formatExternalDirectoryHardStopHint,
// formatBashExternalDirectoryDenyReason) have moved to denial-messages.ts.
// Their behavior is tested in denial-messages.test.ts.

describe("formatExternalDirectoryAskPrompt", () => {
  test("uses 'Current agent' when no agent name provided", () => {
    const result = formatExternalDirectoryAskPrompt(
      "read",
      "/etc/passwd",
      undefined,
      "/projects/my-app",
    );
    expect(result).toContain("Current agent");
    expect(result).toContain("read");
    expect(result).toContain("/etc/passwd");
    expect(result).toContain("/projects/my-app");
  });

  test("uses agent name when provided", () => {
    const result = formatExternalDirectoryAskPrompt(
      "write",
      "/tmp/out.txt",
      undefined,
      "/projects/my-app",
      "my-agent",
    );
    expect(result).toContain("Agent 'my-agent'");
    expect(result).toContain("write");
    expect(result).toContain("/tmp/out.txt");
  });

  test("discloses the resolved path when it differs from the typed path", () => {
    const result = formatExternalDirectoryAskPrompt(
      "read",
      "demo-symlink-passwd",
      "/etc/passwd",
      "/projects/my-app",
    );
    expect(result).toBe(
      "Current agent requested tool 'read' for path 'demo-symlink-passwd' (resolves to '/etc/passwd') outside working directory '/projects/my-app'. Allow this external directory access?",
    );
  });

  test("omits the disclosure when resolvedPath is undefined", () => {
    const result = formatExternalDirectoryAskPrompt(
      "read",
      "/etc/passwd",
      undefined,
      "/projects/my-app",
    );
    expect(result).not.toContain("resolves to");
  });
});

describe("formatBashExternalDirectoryAskPrompt", () => {
  test("includes command, paths, cwd, and agent name", () => {
    const result = formatBashExternalDirectoryAskPrompt(
      "cat /etc/passwd",
      [{ path: "/etc/passwd" }],
      "/projects/my-app",
      "my-agent",
    );
    expect(result).toContain("Agent 'my-agent'");
    expect(result).toContain("cat /etc/passwd");
    expect(result).toContain("/etc/passwd");
    expect(result).toContain("/projects/my-app");
  });

  test("uses 'Current agent' when no agent name provided", () => {
    const result = formatBashExternalDirectoryAskPrompt(
      "ls /tmp",
      [{ path: "/tmp" }],
      "/projects/my-app",
    );
    expect(result).toContain("Current agent");
  });
});
