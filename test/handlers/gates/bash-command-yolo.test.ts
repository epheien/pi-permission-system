/**
 * yolo full-bypass at the bash-command layer.
 *
 * `resolveBashCommandCheck` synthesizes `ask` in two places that never touch
 * `PermissionManager.check`'s yolo rewrite: the wrapper floor (`bash -c`,
 * `sudo`, `env`, …) and the empty-parse sentinel. Under yolo the extension is
 * meant to bypass everything but an explicit `deny`, so both must stop
 * prompting — while a `deny` (whether on the wrapper rule itself or on a
 * sibling command) still wins.
 */
import { describe, expect, it } from "vitest";

import { resolveBashCommandCheck } from "#src/handlers/gates/bash-command";
import type { PermissionCheckResult } from "#src/types";

import { makeResolver } from "#test/helpers/gate-fixtures";
import { makeCheckResult } from "#test/helpers/handler-fixtures";

/** Build a bash-surface check result for a single command unit. */
function bashResult(
  state: PermissionCheckResult["state"],
  command: string,
  matchedPattern?: string,
  origin: PermissionCheckResult["origin"] = "builtin",
): PermissionCheckResult {
  return makeCheckResult({
    state,
    source: "bash",
    command,
    matchedPattern,
    origin,
  });
}

describe("resolveBashCommandCheck under yolo", () => {
  it("does not floor an allowed wrapper to ask", () => {
    const resolver = makeResolver(
      bashResult("allow", "bash -c 'rm -rf /'", "*"),
    );

    const result = resolveBashCommandCheck(
      "bash -c 'rm -rf /'",
      [{ text: "bash -c 'rm -rf /'", wrapperKind: "opaque-payload" }],
      undefined,
      resolver,
      { yolo: true },
    );

    expect(result.state).toBe("allow");
    expect(result.matchedPattern).toBe("*");
    expect(result.origin).toBe("yolo");
  });

  it("still floors an allowed wrapper to ask without yolo", () => {
    const resolver = makeResolver(
      bashResult("allow", "bash -c 'rm -rf /'", "*"),
    );

    const result = resolveBashCommandCheck(
      "bash -c 'rm -rf /'",
      [{ text: "bash -c 'rm -rf /'", wrapperKind: "opaque-payload" }],
      undefined,
      resolver,
    );

    expect(result.state).toBe("ask");
    expect(result.matchedPattern).toBe("<opaque-bash-wrapper>");
  });

  it("preserves a deny on the wrapper itself", () => {
    const resolver = makeResolver(
      bashResult("deny", "sudo rm -rf /", "sudo *"),
    );

    const result = resolveBashCommandCheck(
      "sudo rm -rf /",
      [{ text: "sudo rm -rf /", wrapperKind: "indirection" }],
      undefined,
      resolver,
      { yolo: true },
    );

    expect(result.state).toBe("deny");
    expect(result.matchedPattern).toBe("sudo *");
    expect(result.origin).not.toBe("yolo");
  });

  it("does not claim a trivially-empty command as a yolo grant", () => {
    // Nothing was floored here, so the resolver's own origin must survive —
    // tagging it "yolo" would report a plain policy allow as a bypass.
    const resolver = makeResolver(
      bashResult("allow", "# just a comment", undefined, "global"),
    );

    const result = resolveBashCommandCheck(
      "# just a comment",
      [],
      undefined,
      resolver,
      { yolo: true },
    );

    expect(result.state).toBe("allow");
    expect(result.origin).toBe("global");
  });

  it("resolves the whole command instead of the unparseable ask sentinel", () => {
    const resolver = makeResolver(
      bashResult("allow", "cd /repo && git push", "*"),
    );

    const result = resolveBashCommandCheck(
      "cd /repo && git push",
      [],
      undefined,
      resolver,
      { yolo: true },
    );

    expect(result.state).toBe("allow");
    expect(result.matchedPattern).toBe("*");
    expect(result.origin).toBe("yolo");
    expect(resolver.resolve).toHaveBeenCalledWith({
      kind: "tool",
      surface: "bash",
      input: { command: "cd /repo && git push" },
      agentName: undefined,
    });
  });

  it("keeps the unparseable ask sentinel without yolo", () => {
    const resolver = makeResolver(bashResult("allow", "cd /repo && git push"));

    const result = resolveBashCommandCheck(
      "cd /repo && git push",
      [],
      undefined,
      resolver,
    );

    expect(result.state).toBe("ask");
    expect(result.matchedPattern).toBe("<unparseable-bash-command>");
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it("still denies a chain when a sibling command is denied", () => {
    const resolver = makeResolver();
    resolver.resolve.mockImplementation((intent) => {
      const command = (intent as { input: { command: string } }).input.command;
      return command.startsWith("rm")
        ? bashResult("deny", command, "rm *")
        : bashResult("allow", command, "*");
    });

    const result = resolveBashCommandCheck(
      "bash -c 'echo hi' && rm -rf /",
      [
        { text: "bash -c 'echo hi'", wrapperKind: "opaque-payload" },
        { text: "rm -rf /" },
      ],
      undefined,
      resolver,
      { yolo: true },
    );

    expect(result.state).toBe("deny");
    expect(result.command).toBe("rm -rf /");
  });
});
