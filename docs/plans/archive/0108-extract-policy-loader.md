---
issue: 108
issue_title: "refactor: extract PolicyLoader from PermissionManager"
---

# Extract PolicyLoader from PermissionManager

## Problem Statement

`PermissionManager` conflates three responsibilities: file I/O with mtime caching, 4-scope policy merge with origin tracking, and permission evaluation.
Testing any one concern requires satisfying all three — most critically, every test that checks merge or evaluation logic must write real files to a temp directory.
Extracting the I/O layer into a dedicated `PolicyLoader` makes the merge and evaluation paths testable with pure in-memory stubs.

## Goals

- Extract a `PolicyLoader` interface and a `FilePolicyLoader` implementation that owns all `readFileSync`/`statSync` calls and mtime-based caching currently in `PermissionManager`.
- Make `PermissionManager` accept a `PolicyLoader` via constructor injection.
- Preserve the existing public API of `PermissionManager` — callers continue to construct it the same way (options bag) and call `checkPermission`, `getToolPermission`, `getComposedConfigRules`, etc.
- Enable future tests to supply an in-memory `PolicyLoader` stub (no filesystem).

## Non-Goals

- Rewriting the existing `permission-manager-unified.test.ts` or `permission-system.test.ts` suites — they already work; converting them to use in-memory stubs is a follow-up.
- Changing the merge algorithm or evaluation semantics.
- Extracting `getConfiguredMcpServerNames` into a separate service (it can live on `PolicyLoader` for now since it reads from disk with caching).
- Changing `HandlerDeps` or `createPermissionManagerForCwd` signatures.

## Background

### Permission surface

This change is surface-agnostic — it restructures internal plumbing, not permission evaluation.

### Relevant modules

| File                                       | Role                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `src/permission-manager.ts`                | All three responsibilities today                                                                 |
| `src/runtime.ts`                           | `createPermissionManagerForCwd()` — constructs `PermissionManager`                               |
| `src/handlers/types.ts`                    | `HandlerDeps.createPermissionManagerForCwd` — factory signature                                  |
| `src/config-loader.ts`                     | `loadUnifiedConfig`, `normalizeUnifiedConfig`, `stripJsonComments` — called by PM's load methods |
| `src/common.ts`                            | `extractFrontmatter`, `parseSimpleYamlMap` — called by agent-scope loading                       |
| `tests/permission-manager-unified.test.ts` | 663-line test file exercising PM through temp files                                              |
| `tests/permission-system.test.ts`          | Integration tests constructing PM directly                                                       |

### How PermissionManager is constructed today

The options bag already accepts path overrides (`globalConfigPath`, `agentsDir`, `projectGlobalConfigPath`, `projectAgentsDir`, `globalMcpConfigPath`, `mcpServerNames`).
`createPermissionManagerForCwd` in `runtime.ts` builds the options from `agentDir` + `cwd`.

## Design Overview

### New interface: `PolicyLoader`

```typescript
interface PolicyLoader {
  loadGlobalConfig(): ScopeConfig;
  loadProjectConfig(): ScopeConfig;
  loadAgentConfig(agentName?: string): ScopeConfig;
  loadProjectAgentConfig(agentName?: string): ScopeConfig;
  getConfiguredMcpServerNames(): readonly string[];
  /** Combined mtime stamp for cache invalidation. */
  getCacheStamp(agentName?: string): string;
  /** Accumulated config-parse issues across all loads. */
  getConfigIssues(): string[];
  /** Resolved paths for the /permission-system show command. */
  getResolvedPolicyPaths(): ResolvedPolicyPaths;
}
```

### New class: `FilePolicyLoader`

Lives in `src/policy-loader.ts`.
Receives the same path/override options currently on `PermissionManager`'s constructor.
Moves all `readFileSync`/`statSync` calls, mtime caches, and the `getConfiguredMcpServerNames` disk reader out of `PermissionManager`.

### Slimmed `PermissionManager`

Constructor gains an optional `policyLoader` field in the options bag.
When omitted, `PermissionManager` constructs a `FilePolicyLoader` internally using the path options — this preserves backward compatibility so every existing `new PermissionManager({...})` call continues to work without changes.

```typescript
constructor(options: PermissionManagerOptions = {}) {
  this.loader = options.policyLoader ?? new FilePolicyLoader(options);
  // …no path fields stored on PM itself
}
```

`resolvePermissions()` calls `this.loader.loadGlobalConfig()` etc. instead of `this.loadGlobalConfig()`.
`checkPermission()` calls `this.loader.getConfiguredMcpServerNames()`.
`getConfigIssues()` delegates to `this.loader.getConfigIssues()`.
`getResolvedPolicyPaths()` delegates to `this.loader.getResolvedPolicyPaths()`.
`getPolicyCacheStamp()` delegates to `this.loader.getCacheStamp()`.

The mtime-based `resolvedPermissionsCache` stays on `PermissionManager` — it caches the *merge result*, not raw I/O.

### Backward compatibility

- `PermissionManagerOptions` keeps all existing path fields.
  They are forwarded to `FilePolicyLoader` when no explicit `policyLoader` is provided.
- All external callers (`runtime.ts`, `config-reporter.ts`, test files) continue to construct `new PermissionManager({ globalConfigPath, … })` unchanged.
- `createPermissionManagerForCwd` in `runtime.ts` needs no changes.

## Module-Level Changes

### `src/policy-loader.ts` (new)

- Export `PolicyLoader` interface.
- Export `FilePolicyLoader` class implementing it.
- Move from `permission-manager.ts`: `getFileStamp`, `readConfiguredMcpServerNamesFromConfigPath`, `getConfiguredMcpServerNamesFromPaths`, all `load*Config` methods, `getConfiguredMcpServerNames`, `getPolicyCacheStamp`, `getResolvedPolicyPaths`, the associated cache fields, and `ResolvedPolicyPaths`.
- Move imports of `readFileSync`, `statSync`, `existsSync` into this file.

### `src/permission-manager.ts` (changed)

- Remove all filesystem imports (`readFileSync`, `statSync`, `existsSync`).
- Remove moved methods and cache fields.
- Import `PolicyLoader`, `FilePolicyLoader`, `ResolvedPolicyPaths` from `./policy-loader`.
- Re-export `ResolvedPolicyPaths` (it is part of the public API).
- Add `policyLoader?: PolicyLoader` to the constructor options type.
- Construct `FilePolicyLoader` when no loader provided.
- Delegate `getConfigIssues`, `getResolvedPolicyPaths`, `getPolicyCacheStamp` to `this.loader`.
- `resolvePermissions` calls `this.loader.*` for scope configs.
- `checkPermission` calls `this.loader.getConfiguredMcpServerNames()`.

### `tests/policy-loader.test.ts` (new)

- Unit tests for `FilePolicyLoader` using temp directories (same strategy as existing tests).
- Test mtime cache invalidation, missing-file handling, MCP server name reading.

### `tests/permission-manager-unified.test.ts` (changed — minimal)

- Add 1–2 tests demonstrating in-memory `PolicyLoader` stub usage for merge/evaluate logic without filesystem.
- Existing file-based tests are NOT rewritten.

### `docs/architecture/target-architecture.md` (updated)

- Note `PolicyLoader` as the I/O boundary in the module diagram.

## Test Impact Analysis

The extraction creates a clean I/O boundary, which changes where tests belong and what they need to set up.

### New tests enabled by the extraction

With a `PolicyLoader` interface, `PermissionManager` becomes testable with a pure in-memory stub.
The following test categories can be written without touching the filesystem:

1. **Merge logic** — 4-scope merge (global → project → agent → project-agent), deep-shallow merge semantics, `permission["*"]` universal fallback extraction, origin tracking across scopes.
   Today these require `createManagerWithProject()` + temp files (permission-system.test.ts lines 1372–1560, 1927–2013).
   An `InMemoryPolicyLoader` that returns predetermined `ScopeConfig` objects tests the same logic with no I/O.
2. **Evaluation logic** — `checkPermission()` surface routing, `deriveSource()`, `matchedPattern`, `resultExtras`.
   Today these require `createManager()` + temp files (permission-system.test.ts lines 621–1210, permission-manager-unified.test.ts lines 1–663).
   With an in-memory loader, each test is a one-liner construction + assertion.
3. **Session rule composition** — session rules appended to composed rules, last-match-wins interaction with config rules.
   Already exercised in permission-manager-unified.test.ts but still writes temp files for the base config.
4. **Config issue accumulation** — `getConfigIssues()` aggregation across scopes.
   Can be tested by making the in-memory loader return preset issues.

### Existing tests that become redundant or simplifiable

Once the in-memory `PolicyLoader` tests cover merge and evaluation thoroughly, the following filesystem-based tests in `permission-system.test.ts` become integration-level redundancy.
They should **not** be deleted in this PR — they serve as regression anchors — but they can be marked for future simplification.

| Test (permission-system.test.ts)                                      | What it really tests                            | After extraction                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| "PermissionManager canonical built-in permission checking" (line 621) | Evaluation: tool surface routing                | Covered by in-memory eval test; file-based version is redundant integration |
| "multiline bash command resolves to allow" (line 639)                 | Evaluation: dotAll matching                     | Same — pure evaluation concern                                              |
| "Bash specific deny patterns override catch-all" (line 660)           | Evaluation: last-match-wins                     | Same                                                                        |
| "MCP wildcard matching" (line 685)                                    | Evaluation: MCP target normalization + matching | Same                                                                        |
| "Arbitrary extension tools" (line 718)                                | Evaluation: extension tool source derivation    | Same                                                                        |
| "Skill permission matching" (line 742)                                | Evaluation: skill surface                       | Same                                                                        |
| "MCP proxy tool infers server-prefixed aliases" (line 778)            | Evaluation: MCP name inference                  | Same                                                                        |
| "Project-level config overrides base bash patterns" (line 1372)       | Merge: project > global                         | Covered by in-memory merge test                                             |
| "System-agent config overrides project-level" (line 1405)             | Merge: agent > project                          | Same                                                                        |
| "Project-agent config overrides system-agent" (line 1447)             | Merge: project-agent > agent                    | Same                                                                        |
| "Full precedence chain" (line 1481)                                   | Merge: all 4 scopes                             | Same                                                                        |

These tests write temp files solely to feed `PermissionManager` a known policy.
With an in-memory loader, the same assertions run faster, in isolation, and without cleanup.

### Tests that must stay file-based

Some tests genuinely exercise the I/O layer and belong on `FilePolicyLoader`:

| Test                                                                     | Why it must stay file-based                 |
| ------------------------------------------------------------------------ | ------------------------------------------- |
| "getResolvedPolicyPaths returns correct paths and existence" (line 2304) | Tests `existsSync` path probing             |
| "getResolvedPolicyPaths returns false for missing files" (line 2340)     | Same                                        |
| "PermissionManager reads config from PI_CODING_AGENT_DIR" (line 1561)    | Tests env-driven path resolution            |
| "MCP server names in settings.json are not used" (line 805)              | Tests mcp.json file reading                 |
| Agent frontmatter tests with `.md` files (lines 999–1099)                | Tests YAML frontmatter extraction from disk |

These move to `tests/policy-loader.test.ts` or remain as integration tests that exercise the full stack.

### Simplification plan (deferred to follow-up)

In a follow-up PR after this extraction lands:

1. Add a shared `InMemoryPolicyLoader` test helper to `tests/helpers/`.
2. Rewrite the merge-logic tests (lines 1372–1560) to use the in-memory loader — delete temp-dir setup.
3. Rewrite the evaluation-logic tests (lines 621–1210) similarly.
4. Keep the file-based integration tests in `permission-system.test.ts` for the I/O-dependent subset listed above.
5. Move `getResolvedPolicyPaths` and `getConfigIssues` tests to `tests/policy-loader.test.ts`.

This follow-up is tracked as a non-goal of the current issue.

## TDD Order

1. **red → green**: Create `src/policy-loader.ts` with the `PolicyLoader` interface and `FilePolicyLoader` skeleton.
   Write `tests/policy-loader.test.ts` with basic tests: construct a `FilePolicyLoader` pointing at a temp dir, load global config, verify `ScopeConfig` returned.
   `test: add PolicyLoader interface and FilePolicyLoader skeleton tests`

2. **feat**: Move all I/O methods and caching from `PermissionManager` into `FilePolicyLoader`.
   Wire `PermissionManager` to accept `policyLoader` option and delegate.
   Existing tests must continue to pass (backward-compat constructor).
   `feat: extract FilePolicyLoader from PermissionManager`

3. **test**: Add in-memory `PolicyLoader` stub tests in `tests/permission-manager-unified.test.ts` — demonstrate merge and evaluation without filesystem.
   Cover: universal fallback, surface routing, session rule composition, origin tracking, multi-scope merge.
   `test: add in-memory PolicyLoader stub tests for PermissionManager`

4. **test**: Add `FilePolicyLoader` edge-case tests — mtime cache invalidation, agent frontmatter loading, MCP server name dedup, missing files, config issue accumulation.
   `test: cover FilePolicyLoader caching and edge cases`

5. **docs**: Update `docs/architecture/target-architecture.md` to reflect the `PolicyLoader` extraction.
   `docs: add PolicyLoader to target architecture`

## Risks and Mitigations

| Risk                                     | Mitigation                                                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Could this silently weaken a permission? | No — merge algorithm and evaluation logic are unchanged; only the I/O call site moves.                                                                                     |
| Breaking existing constructor API        | `FilePolicyLoader` is constructed internally when `policyLoader` option is absent; all existing callers work unchanged.                                                    |
| Cache invalidation regression            | `FilePolicyLoader.getCacheStamp()` uses the same `getFileStamp()` logic; `PermissionManager.resolvedPermissionsCache` continues to use the stamp for its own invalidation. |
| Large test rewrite risk                  | Existing test files are NOT rewritten — only additive tests are planned.                                                                                                   |

## Open Questions

- Should `getConfiguredMcpServerNames` move to a separate `McpConfigLoader` interface, or stay on `PolicyLoader`?
  Deferred — keeping it on `PolicyLoader` is simpler for now; it can be split later if MCP config grows.
