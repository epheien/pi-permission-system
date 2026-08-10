import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, normalize } from "node:path";
import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { loadAndMergeConfigs, readRawUnifiedConfig } from "./config-loader";
import {
  getGlobalConfigPath,
  getLegacyExtensionConfigPath,
  getLegacyGlobalPolicyPath,
  getLegacyProjectPolicyPath,
} from "./config-paths";
import { buildResolvedConfigLogEntry } from "./config-reporter";
import {
  DEFAULT_EXTENSION_CONFIG,
  EXTENSION_ROOT,
  normalizePermissionSystemConfig,
  type PermissionSystemExtensionConfig,
} from "./extension-config";
import type { ResolvedPolicyPaths } from "./policy-loader";
import type { DebugReviewLogger } from "./session-logger";
import { syncPermissionSystemStatus } from "./status";

/**
 * Process-global YOLO state slot.
 *
 * `Symbol.for()` is process-global by spec, so it survives jiti's per-extension
 * module isolation (`moduleCache: false`) and a `/reload` that rebuilds the
 * whole extension: the fresh ConfigStore reads the same `globalThis` slot the
 * previous generation wrote. YOLO is deliberately NOT stored in config.json —
 * it is an in-memory, process-lifetime toggle: once enabled it stays on across
 * session switches, config reloads, and agent turns, and resets only when the
 * process exits (a restart naturally starts non-YOLO).
 */
const YOLO_STATE_KEY = Symbol.for("@gotgenes/pi-permission-system:yolo-state");

function readProcessYoloState(): boolean {
  return (globalThis as Record<symbol, unknown>)[YOLO_STATE_KEY] === true;
}

function writeProcessYoloState(value: boolean): void {
  (globalThis as Record<symbol, unknown>)[YOLO_STATE_KEY] = value;
}

/**
 * Clear the process-global YOLO slot — test-only seam so a test file's
 * instances start from a known non-YOLO state.
 */
export function resetProcessYoloState(): void {
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- Symbol-keyed global property; Map.delete() is not applicable
  delete (globalThis as Record<symbol, unknown>)[YOLO_STATE_KEY];
}

/** Read-only view of the current config — for consumers that only read. */
export interface ConfigReader {
  current(): PermissionSystemExtensionConfig;
}

/**
 * Narrow subset of `ConfigStore` that `PermissionSession` depends on.
 *
 * Using an interface rather than the concrete class avoids private-member
 * coupling between the class and test doubles.
 */
export interface SessionConfigStore extends ConfigReader {
  refresh(ctx: ExtensionContext | undefined, projectTrusted: boolean): void;
  logResolvedPaths(cwd?: string): void;
}

/**
 * Narrow subset of `ConfigStore` for the `/permission-system` command.
 *
 * Using an interface rather than the concrete class avoids private-member
 * coupling between the class and test doubles.
 */
export interface CommandConfigStore extends ConfigReader {
  save(
    next: PermissionSystemExtensionConfig,
    ctx: ExtensionCommandContext,
  ): void;
}

/**
 * Narrow subset of `ConfigStore` for the public config service: read the
 * current config and persist a replacement without any UI context.
 *
 * Using an interface rather than the concrete class avoids private-member
 * coupling between the class and test doubles.
 */
export interface PermissionConfigStore extends ConfigReader {
  saveRuntime(
    next: PermissionSystemExtensionConfig,
  ): PermissionSystemExtensionConfig;
}

/** Narrow view of the manager's resolved policy paths (for `logResolvedPaths`). */
export interface ResolvedPolicyPathProvider {
  getResolvedPolicyPaths(): ResolvedPolicyPaths;
}

export interface ConfigStoreDeps {
  agentDir: string;
  policyPaths: ResolvedPolicyPathProvider;
  logger: DebugReviewLogger;
}

/**
 * Owns the mutable extension config and the operations that read/write it.
 *
 * Replaces the three `(runtime, …)` config free functions
 * (`refreshExtensionConfig`, `saveExtensionConfig`, `logResolvedConfigPaths`)
 * with methods that privately own `config` and `lastConfigWarning`.
 *
 * Implements {@link ConfigReader} so consumers that only read the current config
 * can depend on the narrow interface rather than the full class.
 */
export class ConfigStore
  implements SessionConfigStore, CommandConfigStore, PermissionConfigStore
{
  private config: PermissionSystemExtensionConfig;
  private lastConfigWarning: string | null = null;

  constructor(private readonly deps: ConfigStoreDeps) {
    this.config = { ...DEFAULT_EXTENSION_CONFIG };
  }

  /** Return the current extension config. */
  current(): PermissionSystemExtensionConfig {
    return this.config;
  }

  /**
   * Reload merged config from disk.
   *
   * If `ctx` is provided, uses it to derive the cwd and sync UI status.
   * When `projectTrusted` is `false`, the project scope is withheld so an
   * untrusted repository's runtime config (`yoloMode`, `permissionReviewLog`,
   * …) cannot loosen the operator's global config (#644).
   */
  refresh(ctx: ExtensionContext | undefined, projectTrusted: boolean): void {
    const cwd = ctx?.cwd ?? null;
    const mergeResult = loadAndMergeConfigs(
      this.deps.agentDir,
      cwd ?? "",
      EXTENSION_ROOT,
      { includeProjectScope: projectTrusted },
    );
    const runtimeConfig = normalizePermissionSystemConfig(mergeResult.merged);
    // YOLO is a process-lifetime, in-memory toggle: never adopt a persisted
    // value (a fresh process starts non-YOLO), and preserve the in-process
    // toggle across session/reload/agent-turn refreshes. Only process exit
    // resets it. See {@link readProcessYoloState} for the storage seam.
    this.config = { ...runtimeConfig, yoloMode: readProcessYoloState() };

    if (ctx?.hasUI) {
      // Sync the status bar from the real in-memory toggle (this.config), not
      // the ignored on-disk value, so YOLO stays lit across refreshes.
      syncPermissionSystemStatus(ctx, this.config);
    }

    const warning =
      mergeResult.issues.length > 0 ? mergeResult.issues.join("\n") : undefined;

    if (warning && warning !== this.lastConfigWarning) {
      this.lastConfigWarning = warning;
      ctx?.ui.notify(warning, "warning");
    } else if (!warning) {
      this.lastConfigWarning = null;
    }

    this.deps.logger.debug("config.loaded", {
      warning: warning ?? null,
      debugLog: runtimeConfig.debugLog,
      permissionReviewLog: runtimeConfig.permissionReviewLog,
      yoloMode: runtimeConfig.yoloMode,
      projectTrusted,
    });
  }

  /**
   * Persist a replacement runtime config to the global config file and update
   * the current config, with no UI context dependency.
   *
   * This is the ctx-free core behind {@link save}. It returns the normalized
   * config and throws on write failure — the caller owns error surfacing.
   */
  saveRuntime(
    next: PermissionSystemExtensionConfig,
  ): PermissionSystemExtensionConfig {
    const normalized = normalizePermissionSystemConfig(next);
    const globalPath = getGlobalConfigPath(this.deps.agentDir);

    // Base the write on the RAW config file, not the schema-validated
    // loadUnifiedConfig result: the validated result is `{}` whenever the file
    // carries a key this build rejects (a newer field read by an older
    // extension, a typo, …), and spreading that would rewrite the file down to
    // just the runtime knobs — silently destroying the user's permission
    // policy. Spreading the raw object preserves unknown keys verbatim.
    const existingRaw = readRawUnifiedConfig(globalPath);
    const isObject =
      typeof existingRaw === "object" &&
      existingRaw !== null &&
      !Array.isArray(existingRaw);
    if (existingRaw !== null && !isObject) {
      // A present file that is not a config object may be corrupt or a foreign
      // format — never destroy it just to persist a knob toggle.
      throw new Error(
        `Refusing to overwrite config at '${globalPath}': the file exists but is not a JSON config object.`,
      );
    }
    const merged: Record<string, unknown> = {
      ...(isObject ? (existingRaw as Record<string, unknown>) : {}),
    };
    // YOLO never persists: strip any legacy/stale value and never write the
    // toggle — it lives only in this process's memory (see refresh()).
    delete merged.yoloMode;
    merged.debugLog = normalized.debugLog;
    merged.permissionReviewLog = normalized.permissionReviewLog;

    const tmpPath = `${globalPath}.tmp`;
    try {
      mkdirSync(dirname(globalPath), { recursive: true });
      writeFileSync(tmpPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
      renameSync(tmpPath, globalPath);
    } catch (error) {
      try {
        if (existsSync(tmpPath)) {
          unlinkSync(tmpPath);
        }
      } catch {
        // Ignore cleanup failures.
      }
      throw error;
    }

    // YOLO stays in memory only: keep the process-global slot in sync with the
    // toggled value so a later refresh() re-adopts it instead of resetting.
    writeProcessYoloState(normalized.yoloMode);

    this.config = normalized;
    this.lastConfigWarning = null;

    this.deps.logger.debug("config.saved", {
      debugLog: normalized.debugLog,
      permissionReviewLog: normalized.permissionReviewLog,
      yoloMode: normalized.yoloMode,
    });
    return normalized;
  }

  /**
   * Save updated runtime knobs to the global config file, then update
   * the current config and sync UI status.
   *
   * Thin decorator over {@link saveRuntime}: persists, then syncs UI status,
   * and surfaces write failures as a UI error notification.
   *
   * Equivalent to `saveExtensionConfig(runtime, next, ctx)`.
   */
  // Called via the CommandConfigStore interface from config-modal.ts — fallow cannot trace through interfaces.
  // fallow-ignore-next-line unused-class-member
  save(
    next: PermissionSystemExtensionConfig,
    ctx: ExtensionCommandContext,
  ): void {
    try {
      const normalized = this.saveRuntime(next);
      syncPermissionSystemStatus(ctx, normalized);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Failed to save permission-system config at '${getGlobalConfigPath(this.deps.agentDir)}': ${message}`,
        "error",
      );
    }
  }

  /**
   * Write the resolved config path set to the review and debug logs.
   *
   * Equivalent to `logResolvedConfigPaths(runtime)`.
   */
  logResolvedPaths(cwd?: string): void {
    const policyPaths = this.deps.policyPaths.getResolvedPolicyPaths();
    const { agentDir } = this.deps;
    const legacyGlobalPolicyDetected = existsSync(
      getLegacyGlobalPolicyPath(agentDir),
    );
    const legacyProjectPolicyDetected = cwd
      ? existsSync(getLegacyProjectPolicyPath(cwd))
      : false;
    const legacyExtConfigPath = getLegacyExtensionConfigPath(EXTENSION_ROOT);
    const newGlobalPath = getGlobalConfigPath(agentDir);
    const legacyExtensionConfigDetected =
      normalize(legacyExtConfigPath) !== normalize(newGlobalPath) &&
      existsSync(legacyExtConfigPath);
    const entry = buildResolvedConfigLogEntry({
      policyPaths,
      legacyGlobalPolicyDetected,
      legacyProjectPolicyDetected,
      legacyExtensionConfigDetected,
    });
    this.deps.logger.review(
      "config.resolved",
      entry as unknown as Record<string, unknown>,
    );
    this.deps.logger.debug(
      "config.resolved",
      entry as unknown as Record<string, unknown>,
    );
  }
}
