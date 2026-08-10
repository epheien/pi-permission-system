/**
 * Integration tests proving `ConfigStore.saveRuntime` (a knob toggle such as
 * YOLO) never destroys the user's config — including when the on-disk file
 * carries keys the running build does not recognize (schema rejection).
 *
 * Regression for the data-loss bug: `saveRuntime` spread the *validated*
 * config (`loadUnifiedConfig().config`, which is `{}` on schema rejection),
 * so toggling YOLO over a config containing an unknown key rewrote the file
 * with only the runtime knobs — wiping the entire permission policy.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { getGlobalConfigPath } from "#src/config-paths";
import { ConfigStore } from "#src/config-store";
import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";

function makeLogger() {
  return { debug: vi.fn(), review: vi.fn(), warn: vi.fn() } as never;
}

function makeStore(agentDir: string): ConfigStore {
  return new ConfigStore({
    agentDir,
    policyPaths: {
      getResolvedPolicyPaths: () => ({
        globalConfigPath: getGlobalConfigPath(agentDir),
        globalConfigExists: true,
        projectConfigPath: null,
        projectConfigExists: false,
        agentsDir: "",
        agentsDirExists: false,
        projectAgentsDir: null,
        projectAgentsDirExists: false,
      }),
    },
    logger: makeLogger(),
  });
}

function writeConfig(agentDir: string, value: unknown): string {
  const configPath = getGlobalConfigPath(agentDir);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  return configPath;
}

describe("ConfigStore.saveRuntime — must never wipe config (real fs)", () => {
  it("preserves permission and unknown keys across a YOLO toggle even when the file has an unrecognized key", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "ps-cfg-noloss-"));
    try {
      writeConfig(agentDir, {
        permission: { "*": "allow", edit: "ask" },
        unknownFutureKey: { a: 1 },
        yoloMode: false,
      });
      const configPath = getGlobalConfigPath(agentDir);

      makeStore(agentDir).saveRuntime({
        ...DEFAULT_EXTENSION_CONFIG,
        yoloMode: true,
      });

      const after = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
      expect(after.permission).toEqual({ "*": "allow", edit: "ask" });
      expect(after.unknownFutureKey).toEqual({ a: 1 });
      expect(after.yoloMode).toBe(true);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("preserves the permission policy when the existing file validates cleanly", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "ps-cfg-ok-"));
    try {
      writeConfig(agentDir, {
        permission: { "*": "ask", write: "allow" },
        yoloMode: true,
      });
      const configPath = getGlobalConfigPath(agentDir);

      makeStore(agentDir).saveRuntime({
        ...DEFAULT_EXTENSION_CONFIG,
        yoloMode: false,
      });

      const after = JSON.parse(readFileSync(configPath, "utf-8")) as Record<
        string,
        unknown
      >;
      expect(after.permission).toEqual({ "*": "ask", write: "allow" });
      expect(after.yoloMode).toBe(false);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a present but non-object config file (fail closed)", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "ps-cfg-junk-"));
    try {
      writeConfig(agentDir, [1, 2, 3]);
      const configPath = getGlobalConfigPath(agentDir);
      expect(() =>
        makeStore(agentDir).saveRuntime({
          ...DEFAULT_EXTENSION_CONFIG,
          yoloMode: true,
        }),
      ).toThrow(/Refusing to overwrite/);
      // File untouched.
      expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual([1, 2, 3]);
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
