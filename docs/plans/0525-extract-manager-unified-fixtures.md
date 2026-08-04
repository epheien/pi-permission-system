---
issue: 525
issue_title: "pi-permission-system: extract shared fixtures from permission-manager-unified.test.ts"
---

# Extract shared config-harness fixtures from `permission-manager-unified.test.ts`

## Release Recommendation

**Release:** ship independently

Phase 8 Step 1's roadmap entry is tagged `Release: independent` — it belongs to no release batch.
This is test-only work: every commit is `test(pi-permission-system):`, a `hidden: true` changelog type that does not cut a release on its own (per AGENTS.md).
So this plan lands on `main` and auto-batches into the next `feat:`/`fix:`/unhidden-`docs:` release; it does not itself trigger one.
No mid-batch coordination is required — Step 2 ([#526]) depends on this file's harness existing, not on a release.

## Problem Statement

`test/permission-manager-unified.test.ts` (3,745 LOC) carries a cluster of near-identical config-harness scaffolding: six file-local manager factories, several fully-inline temp-dir-plus-config blocks, and eleven hand-rolled `sessionRules` array literals.
The roadmap records 24 clone groups / 305 duplicated lines with accelerating churn.
Phase 8 Step 2 ([#526]) lands manager-level yolo tests in this same file; extracting the duplication first keeps that step's diff readable instead of copying scaffolding again.
This is a Category D (test duplication) tidy-first refactor with no production change.

## Goals

- Move the file-local config-harness factories into the shared `test/helpers/manager-harness.ts`, alongside the existing `createManager` / `createManagerWithProject` builders.
- Introduce a `sessionRule` builder that replaces the local `sessionAllow` helper and the eleven inline `sessionRules` array literals.
- Collapse factories that duplicate the existing shared builders (permission-only and global-plus-project construction) into thin delegators rather than relocating duplicate bodies.
- Keep every existing assertion and test case intact — this is a pure setup-scaffolding extraction, not a behavior change.
- Leave the file's clone groups at or near zero and make the shared harness reusable by Step 2.

Not breaking: no production code, config, schema, or public runtime surface changes.

## Non-Goals

- No production source change (`src/` untouched).
- Do not extract the repeated test *act/assert* bodies (e.g. the agent-frontmatter blocks at lines ~2494 and ~2523 that construct `createManager` with a `reviewer` agent file and repeat `checkTool` assertions).
  Per the `testing` skill, the repeated system-under-test call is the test subject, not duplication to remove — wrapping it in a helper would hide the act.
- Do not extract the single-instance inline harness blocks that are not clones: the `MCP server names in settings.json` test (~line 2270, which also writes `mcp.json` + `settings.json`) and the `PI_CODING_AGENT_DIR` test (~line 2911, which manages an env var).
  These appear once, carry test-specific extra setup, and are out of the "repeated config-harness blocks" scope.
- Do not touch the file-local action helpers `checkTool` / `checkPathValues` / `checkPath` — they are single-definition wrappers around `manager.check`, not duplicated harness.
- Do not rename or re-home the existing `createManager` / `createManagerWithProject` builders (three test files import them); only extend the module.

## Background

Relevant modules:

- `test/helpers/manager-harness.ts` — the designated shared home.
  Already exports `createManager(config, agentFiles?, options?)` (filesystem-backed `PermissionManager` from a `ScopeConfig`, returns `{ manager, globalConfigPath, cleanup }`) and `createManagerWithProject(...)` (two-level global + project harness, returns `{ manager, cleanup }`).
  Establishes the `create*` naming convention this plan follows.
- `test/permission-manager-unified.test.ts` — holds the local factories to extract.

Local factories and their call-site counts (from `grep -c`):

| Local symbol                                                                       | Uses | What it builds                                                             |
| ---------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------- |
| `sessionAllow(surface, pattern)`                                                   | 20   | a `layer: "session"` allow `Rule`                                          |
| inline `sessionRules` array literals                                               | 11   | the same `Rule` shape, hand-rolled                                         |
| `makeManager(mcpServerNames?)`                                                     | 21   | manager over nonexistent paths (universal `ask`), no temp dir / cleanup    |
| `makeManagerWithConfig(permission, mcp?)`                                          | 62   | temp dir + `{ permission }` config → `{ manager, cleanup }`                |
| `makeManagerWithScopes(global, project?)`                                          | 10   | global + optional project config → `{ manager, cleanup }`                  |
| `makeInMemoryManager(scopes?, mcp?)` + `createInMemoryPolicyLoader(scopes?, mcp?)` | 28   | manager over an in-memory `PolicyLoader`, no filesystem                    |
| `makeAgentDirSetup({ globalPermission, projectPermission? })`                      | 7    | agentDir-layout harness via `getGlobalConfigPath` / `getProjectConfigPath` |

Two call sites (~lines 1177, 1189) use `createInMemoryPolicyLoader` directly (not via `makeInMemoryManager`) because they pass a `platform: "win32"` option to the `PermissionManager` constructor — so the loader factory must be exported independently, not only wrapped.

Applicable constraints from AGENTS.md and skills:

- Test-only work uses `test(pi-permission-system):`, a hidden changelog type; it does not cut a release (see Release Recommendation).
- `docs/architecture/architecture.md` references this file's metrics (lines 834, 850) and defines Step 1's `Outcome:`; the implementation commit marks Step 1 complete (`package-pi-permission-system` skill: mark the step `✅` on both the step heading and its Mermaid node in the implementation doc-update commit, not at ship time).
- `manager-harness.ts` currently imports only `ScopeConfig` from `#src/types`; the moved factories add imports for `PolicyLoader` (`#src/permission-manager`), `ResolvedPolicyPaths` (`#src/policy-loader`), `Rule` + `PermissionState` (`#src/rule` / `#src/types`), and `getGlobalConfigPath` / `getProjectConfigPath` (`#src/config-paths`).

## Design Overview

Consolidate all filesystem- and loader-backed manager construction into `manager-harness.ts` under the module's `create*` convention, then migrate call sites and delete the file-local definitions.
Two factories that merely re-shape an existing builder's input become thin delegators (no duplicated body); the three genuinely distinct patterns (missing-config, in-memory, agentDir) move as new named builders; the session-rule literal becomes one builder.

Final shared API added to `test/helpers/manager-harness.ts`:

```typescript
// New — generalizes the local sessionAllow (default action stays "allow").
export function sessionRule(
  surface: string,
  pattern: string,
  action: PermissionState = "allow",
): Rule;

// New — manager over nonexistent paths; universal "ask" default. No cleanup.
export function createMissingConfigManager(
  mcpServerNames?: readonly string[],
): PermissionManager;

// New — thin delegator to createManager({ permission }, {}, { mcpServerNames }).
export function createManagerWithConfig(
  permission: Record<string, unknown>,
  mcpServerNames?: readonly string[],
): { manager: PermissionManager; cleanup: () => void };

// New — thin delegator to createManagerWithProject.
export function createManagerWithScopes(
  globalPermission: Record<string, unknown>,
  projectPermission?: Record<string, unknown>,
): { manager: PermissionManager; cleanup: () => void };

// Moved — in-memory PolicyLoader + its manager wrapper (loader exported for
// the two platform-override call sites).
export function createInMemoryPolicyLoader(
  scopes?: {
    global?: ScopeConfig;
    project?: ScopeConfig;
    agent?: Record<string, ScopeConfig>;
    projectAgent?: Record<string, ScopeConfig>;
  },
  mcpServerNames?: readonly string[],
): PolicyLoader;
export function createInMemoryManager(
  scopes?: Parameters<typeof createInMemoryPolicyLoader>[0],
  mcpServerNames?: readonly string[],
): PermissionManager;

// Moved — agentDir-layout harness.
export function createAgentDirHarness(opts: {
  globalPermission: Record<string, unknown>;
  projectPermission?: Record<string, unknown>;
}): {
  agentDir: string;
  cwd: string;
  globalConfigPath: string;
  projectConfigPath: string;
  cleanup: () => void;
};
```

### Delegation, not relocation, for the two duplicative factories

`makeManagerWithConfig(permission, mcp?)` currently re-implements the temp-dir + write + construct sequence that `createManager` already owns; its body just differs by taking a bare `permission` record instead of a full `ScopeConfig`.
The extracted `createManagerWithConfig` keeps the ergonomic positional signature (62 terse call sites) but delegates:

```typescript
export function createManagerWithConfig(permission, mcpServerNames) {
  const { manager, cleanup } = createManager({ permission }, {}, { mcpServerNames });
  return { manager, cleanup };
}
```

`createManagerWithScopes` likewise delegates to `createManagerWithProject({ permission: global }, {}, { projectConfig: { permission: project } })`.
This removes the duplicated harness body rather than moving it — the clone disappears instead of relocating.
The one behavioral detail to preserve: `createManager` writes a `pi-permissions.jsonc` file with a trailing newline, whereas the old local `makeManagerWithConfig` wrote `config.json` without one; both are valid inputs to the loader (verified by the suite staying green), so the delegation is behavior-preserving for the assertions.

### Session-rule builder

`sessionRule(surface, pattern, action = "allow")` returns the exact `Rule` shape the inline literals build (`{ surface, pattern, action, layer: "session", origin: "session" }`).
It subsumes the local `sessionAllow(surface, pattern)` (all 20 uses are `allow`) and the eleven inline `external_directory` session-rule arrays, which become `[sessionRule("external_directory", "/other/project/*")]`.

### Interaction with upstream

The moved factories carry no Tell-Don't-Ask or output-argument smell: each constructs a value (`PermissionManager` and/or a `cleanup` closure) and returns it; none mutates a caller-supplied argument.
`createInMemoryPolicyLoader` returns a plain object implementing the `PolicyLoader` interface — it reads `#src/permission-manager` and `#src/policy-loader` types the test file already imports, so no upstream API gap needs closing before the move.

## Module-Level Changes

- `test/helpers/manager-harness.ts` — add `sessionRule`, `createMissingConfigManager`, `createManagerWithConfig`, `createManagerWithScopes`, `createInMemoryPolicyLoader`, `createInMemoryManager`, `createAgentDirHarness`; add the corresponding imports (`PolicyLoader`, `ResolvedPolicyPaths`, `Rule`, `PermissionState`, `getGlobalConfigPath`, `getProjectConfigPath`).
- `test/permission-manager-unified.test.ts` — delete the seven local factory definitions and the inline `sessionRules` literals; import the new builders from `#test/helpers/manager-harness`; migrate all call sites (rename `make*` → `create*`, `sessionAllow` → `sessionRule`).
  Keep the two `platform: "win32"` call sites using the imported `createInMemoryPolicyLoader` directly.
  Prune any now-orphaned imports from the file's top block (e.g. `mkdtempSync` / `writeFileSync` if no inline block still uses them; the retained single-instance blocks at ~2270 and ~2911 likely keep them alive — verify before removing).
- `docs/architecture/architecture.md` — mark Phase 8 Step 1 complete: `✅` on the Step 1 heading (line ~849) and on the `S1` Mermaid node (line ~909).
  Update the metric prose (lines 834, 850) only if the post-refactor clone count is being reported as resolved; the `Duplication ≤ 5.5%` target row is a phase-close metric — do not tick it for a single step.
  This edit lands in the implementation doc-update commit, not at ship time.

No `src/`, schema, config, or `README.md` change — this refactor removes no production export and adds no user-facing feature, so the README-command and schema-alignment checks do not apply.

## Test Impact Analysis

1. **New tests enabled:** none directly — this is deduplication of setup, not a new production surface.
   It does unblock Step 2 ([#526]) to add manager-level yolo tests that import the shared harness instead of copying scaffolding.
2. **Tests made redundant:** none removed.
   Every existing `it` / `test` case and its assertions are preserved verbatim; only the construction scaffolding is relocated.
3. **Tests that must stay as-is:** all of them.
   In particular, the agent-frontmatter act/assert clones (~lines 2494, 2523) stay unextracted — the repeated `checkTool` act is the test subject (see Non-Goals).

## Invariants at risk

The only invariant is the existing suite: `test/permission-manager-unified.test.ts` must stay fully green after every step, and the other two `manager-harness` consumers (`test/skill-prompt-sanitizer.test.ts`, `test/handlers/external-directory-symlink-acceptance.test.ts`) must stay green since the module gains exports without changing existing signatures.
No prior-phase production `Outcome:` invariant is touched — Step 1 changes no `src/` file.
Verification is `pnpm --filter @gotgenes/pi-permission-system exec vitest run` (full file) plus `pnpm run check` after any step that moves a type-bearing factory.

## TDD Order

This is a behavior-preserving test refactor, so each cycle is a green-suite-verified extraction, not a red→green pair.
Per the extraction rule, each step moves a factory (or removes a local symbol) **and** migrates all its call sites in the same commit — a removed local symbol breaks every caller at the type level until they are updated.
Run `pnpm --filter @gotgenes/pi-permission-system exec vitest run test/permission-manager-unified.test.ts` after each step; run `pnpm run check` after any step that moves a type-bearing signature.

1. **`sessionRule` builder.**
   Add `sessionRule` to `manager-harness.ts`; migrate the 20 `sessionAllow` calls and 11 inline `sessionRules` literals; delete the local `sessionAllow`.
   Verify suite green.
   Commit: `test(pi-permission-system): extract sessionRule builder into manager-harness`.
2. **`createMissingConfigManager`.**
   Add it to the harness; migrate the 21 `makeManager()` calls; delete the local `makeManager`.
   Verify green.
   Commit: `test(pi-permission-system): extract createMissingConfigManager helper`.
3. **`createManagerWithConfig` (delegator).**
   Add the delegating builder; migrate the 62 `makeManagerWithConfig` calls; delete the local factory.
   Verify green + `pnpm run check`.
   Commit: `test(pi-permission-system): reuse shared createManager via createManagerWithConfig`.
4. **`createManagerWithScopes` (delegator).**
   Add the delegating builder; migrate the 10 `makeManagerWithScopes` calls; delete the local factory.
   Verify green.
   Commit: `test(pi-permission-system): reuse createManagerWithProject via createManagerWithScopes`.
5. **`createInMemoryPolicyLoader` + `createInMemoryManager`.**
   Move both into the harness (export the loader); migrate the 28 `makeInMemoryManager` calls and the two direct `createInMemoryPolicyLoader` platform-override sites; delete the locals.
   Verify green + `pnpm run check`.
   Commit: `test(pi-permission-system): move in-memory policy-loader harness into helpers`.
6. **`createAgentDirHarness`.**
   Move it into the harness; migrate the 7 `makeAgentDirSetup` calls; delete the local factory.
   Prune any orphaned top-of-file imports left after all moves.
   Verify green + `pnpm run check`.
   Commit: `test(pi-permission-system): move agentDir harness into helpers`.
7. **Roadmap doc update.**
   Mark Phase 8 Step 1 `✅` (heading + `S1` Mermaid node) in `docs/architecture/architecture.md`; refresh the clone-count prose if reporting it resolved.
   Verify `rumdl` and `mmdc` (diagram render) pass.
   Commit: `docs(pi-permission-system): mark Phase 8 Step 1 complete`.

## Risks and Mitigations

- **Large mechanical call-site churn (Step 3 touches 62 sites).**
  Mitigation: each step is a find-and-replace of one symbol, verified by the full file's suite staying green before commit — a missed or wrong rename fails a real assertion, not just a typecheck.
- **A moved factory silently changes a default (e.g. config filename / trailing newline).**
  Mitigation: the delegators reuse the existing green builders; any observable difference surfaces as a suite failure in the same step.
- **Orphaned imports after the moves (Biome `noUnusedImports` is warning-level, exit 0).**
  Mitigation: Step 6 explicitly prunes top-of-file imports; the pre-completion reviewer runs `pnpm fallow dead-code` as a backstop.
- **Naming inconsistency if some `make*` names are kept.**
  Mitigation: rename every extracted factory to the module's `create*` convention (the `sessionRule` builder keeps the plain-`Rule`-builder naming already used by `sessionAllow`).

## Open Questions

None.
The single-instance inline blocks deliberately left in place (MCP-settings, `PI_CODING_AGENT_DIR`) are recorded in Non-Goals; no follow-up issue is warranted — they are not clones and carry test-specific setup.

[#526]: https://github.com/gotgenes/pi-packages/issues/526
