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
  test("headlines the external directory and lists the granted pattern", () => {
    const result = formatExternalDirectoryAskPrompt("/etc/passwd", undefined, [
      "/etc/*",
    ]);
    expect(result).toBe(
      "Access external directory /etc/passwd\n\nPatterns\n- /etc/*",
    );
  });

  test("discloses the resolved path when it differs from the typed path", () => {
    const result = formatExternalDirectoryAskPrompt(
      "demo-symlink-passwd",
      "/etc/passwd",
      ["/etc/*"],
    );
    expect(result).toBe(
      "Access external directory demo-symlink-passwd (resolves to '/etc/passwd')\n\nPatterns\n- /etc/*",
    );
  });

  test("omits the disclosure when resolvedPath is undefined", () => {
    const result = formatExternalDirectoryAskPrompt("/etc/passwd", undefined, [
      "/etc/*",
    ]);
    expect(result).not.toContain("resolves to");
  });

  test("does not leak tool name, cwd, or agent into the ask message", () => {
    const result = formatExternalDirectoryAskPrompt("/tmp/out.txt", undefined, [
      "/tmp/*",
    ]);
    expect(result).not.toContain("write");
    expect(result).not.toContain("/projects/my-app");
    expect(result).not.toContain("Agent");
  });

  test("omits the Patterns section when no patterns are provided", () => {
    const result = formatExternalDirectoryAskPrompt(
      "/etc/passwd",
      undefined,
      [],
    );
    expect(result).toBe("Access external directory /etc/passwd");
  });
});

describe("formatBashExternalDirectoryAskPrompt", () => {
  test("headlines each external path and lists the granted patterns", () => {
    const result = formatBashExternalDirectoryAskPrompt(
      [{ path: "/etc/hosts" }, { path: "/var/log/syslog" }],
      ["/etc/*", "/var/log/*"],
    );
    expect(result).toBe(
      "Access external directory /etc/hosts\n" +
        "Access external directory /var/log/syslog\n\n" +
        "Patterns\n- /etc/*\n- /var/log/*",
    );
  });

  test("excludes the bash command and contextual rows from the ask message", () => {
    const result = formatBashExternalDirectoryAskPrompt(
      [{ path: "/etc/hosts" }],
      ["/etc/*"],
    );
    expect(result).toContain("Access external directory /etc/hosts");
    expect(result).not.toContain("cat");
    expect(result).not.toContain("Current agent");
    expect(result).not.toContain("external_directory");
  });

  test("discloses resolved targets and dedupes repeated patterns", () => {
    const result = formatBashExternalDirectoryAskPrompt(
      [
        { path: "demo-symlink-passwd", resolvedPath: "/etc/passwd" },
        { path: "/etc/hosts" },
      ],
      ["/etc/*", "/etc/*"],
    );
    expect(result).toBe(
      "Access external directory demo-symlink-passwd (resolves to '/etc/passwd')\n" +
        "Access external directory /etc/hosts\n\n" +
        "Patterns\n- /etc/*",
    );
  });

  test("omits the Patterns section when no patterns are provided", () => {
    const result = formatBashExternalDirectoryAskPrompt(
      [{ path: "/etc/hosts" }],
      [],
    );
    expect(result).toBe("Access external directory /etc/hosts");
  });
});
