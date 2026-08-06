# `/permission-system yolo` Toggle Subcommand — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-shot `/permission-system yolo` subcommand that flips `yoloMode`, persists it to the global config, and notifies the operator — as the reuse unit a future keyboard-shortcut binding will call.

**Architecture:** Follow the existing `/permission-system` command pattern in `src/config-modal.ts` (`COMMAND_ARGUMENTS` + `handleArgs` branch that returns `true` to keep the flow out of the settings modal).
The toggle decision is extracted to one pure function `toggleYoloMode(config)` so it is unit-testable without a live terminal; persistence rides the existing `CommandConfigStore.save()`, which already syncs the status bar and fail-closes on write errors.

**Tech Stack:** TypeScript, pi extension API (`registerCommand`), vitest, pnpm.

## Global Constraints

- Only use `pnpm` — never `npm`/`npx` (repo rule, AGENTS.md).
- Do not edit `CHANGELOG.md` (release-please owns it).
- Do not change the config shape, schema, gate logic, `ConfigStore`, `status.ts`, or any public type/API (spec non-goals).
- Do not add README / `docs/configuration.md` command-reference sections (they contain no such section today; the command's usage text lives in `USAGE_TEXT`, updated in this plan).
- Do not add `yolo on` / `yolo off` parameterized forms.
- Match the file's existing style: double quotes, semicolons, trailing commas, 2-space indent, `function` declarations.
- Verify with `pnpm run check` (tsc --noEmit) and `pnpm run lint` before committing.

---

### Task 1: `/permission-system yolo` toggle command (TDD)

**Files:**

- Modify: `src/config-modal.ts` — `COMMAND_ARGUMENTS`, `USAGE_TEXT`, new `toggleYoloMode` function, `handleArgs` branch
- Modify: `test/config-modal.test.ts` — completions assertions + a new toggle-persistence handler test

**Interfaces:**

- Consumes: `PermissionSystemExtensionConfig` (`src/extension-config.ts`), `CommandConfigStore` (`src/config-store.ts`) with `current()` / `save(next, ctx)`, the existing `createCommandContext` test helper, `DEFAULT_EXTENSION_CONFIG`, `normalizePermissionSystemConfig`.
- Produces: `toggleYoloMode(config: PermissionSystemExtensionConfig): PermissionSystemExtensionConfig` (module-private) and the `yolo` branch handled by `handleArgs`/command handler.
- [ ] **Step 1: Write the failing tests**

In `test/config-modal.test.ts`, extend the existing `"permission-system command completions expose top-level config actions"` test — after the `"pa"` filter assertion, add:

```ts
    expect(topLevel?.some((item) => item.value === "yolo")).toBeTruthy();

    const filteredYol = definition!.getArgumentCompletions?.("yol");
    expect(filteredYol?.map((item) => item.value)).toEqual(["yolo"]);
```

Add a new test after the existing `"permission-system command handlers manage config summary, persistence, and modal routing"` test:

```ts
test("permission-system yolo command toggles and persists yoloMode", async () => {
  const baseDir = mkdtempSync(join(tmpdir(), "pi-permission-system-yolo-"));
  const configPath = join(baseDir, "config.json");
  let config: PermissionSystemExtensionConfig = {
    ...DEFAULT_EXTENSION_CONFIG,
  };

  try {
    writeFileSync(
      configPath,
      `${JSON.stringify(config, null, 2)}\n`,
      "utf-8",
    );

    const configStore: CommandConfigStore = {
      current: () => config,
      save: (next) => {
        writeFileSync(
          configPath,
          `${JSON.stringify(next, null, 2)}\n`,
          "utf-8",
        );
        config = next;
      },
    };
    const controller = {
      config: configStore,
      configPath,
      getActiveAgentConfigRules: () => [] as Ruleset,
    };

    let definition: {
      handler: (args: string, ctx: CommandContextStub) => Promise<void>;
    } | null = null;

    registerPermissionSystemCommand(
      {
        registerCommand(_name: string, nextDef: typeof definition) {
          definition = nextDef;
        },
      } as never,
      controller,
    );

    // yoloMode starts off; one invocation turns it on and persists.
    const ctx = createCommandContext(false);
    await definition!.handler("yolo", ctx.ctx);
    expect(config.yoloMode).toBe(true);
    expect(lastNotification(ctx.notifications)).toEqual({
      message: "YOLO mode ON — ask checks auto-approved",
      level: "warning",
    });
    const persistedOn = JSON.parse(
      readFileSync(configPath, "utf8"),
    ) as PermissionSystemExtensionConfig;
    expect(persistedOn.yoloMode).toBe(true);

    // Second invocation turns it off and persists.
    await definition!.handler("yolo", ctx.ctx);
    expect(config.yoloMode).toBe(false);
    expect(lastNotification(ctx.notifications)).toEqual({
      message: "YOLO mode off",
      level: "info",
    });
    const persistedOff = JSON.parse(
      readFileSync(configPath, "utf8"),
    ) as PermissionSystemExtensionConfig;
    expect(persistedOff.yoloMode).toBe(false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `pnpm test -- test/config-modal.test.ts`

Expected: FAIL.
The completions test fails because no `yolo` value is in `COMMAND_ARGUMENTS`; the toggle test fails because `handler("yolo", …)` falls through to the "unknown" branch (notifies the usage text at `warning`, leaves `yoloMode` unchanged).

- [ ] **Step 3: Implement the minimal code**

In `src/config-modal.ts`:

1. Add `yolo` to `COMMAND_ARGUMENTS` between `reset` and `help`:

```ts
  {
    value: "yolo",
    label: "Toggle YOLO mode",
    description: "Flip yoloMode and persist it to the global config",
  },
```

2. Update `USAGE_TEXT`:

```ts
const USAGE_TEXT =
  "Usage: /permission-system [show|path|reset|help|yolo] (or run /permission-system with no args to open settings modal)";
```

3. Add the pure toggle function just above `handleArgs`:

```ts
function toggleYoloMode(
  config: PermissionSystemExtensionConfig,
): PermissionSystemExtensionConfig {
  return { ...config, yoloMode: !config.yoloMode };
}
```

4. Add the `yolo` branch in `handleArgs` after the `reset` branch:

```ts
  if (normalized === "yolo") {
    const next = toggleYoloMode(controller.config.current());
    const enabled = next.yoloMode;
    controller.config.save(next, ctx);
    ctx.ui.notify(
      enabled ? "YOLO mode ON — ask checks auto-approved" : "YOLO mode off",
      enabled ? "warning" : "info",
    );
    return true;
  }
```

Note: returning `true` keeps the branch out of the modal path, so it works headless exactly like `show`/`path`/`reset`; `save()` already syncs the status bar and fail-closes on write errors, so no extra handling is needed here.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test -- test/config-modal.test.ts`

Expected: PASS (both the extended completions test and the new toggle test).

- [ ] **Step 5: Run the full verification suite**

Run: `pnpm test && pnpm run check && pnpm run lint`

Expected: all pass, lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/config-modal.ts test/config-modal.test.ts
git commit -m "feat(pi-permission-system): add /permission-system yolo toggle subcommand"
```
