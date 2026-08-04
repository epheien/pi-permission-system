---
issue: 66
issue_title: "Replace legacy config format with flat permission format"
---

# Replace legacy config format with flat permission format

## Problem Statement

The current config format uses multiple top-level namespaces (`defaultPolicy`, `tools`, `bash`, `mcp`, `skills`, `special`) to express permission rules.
OpenCode has converged on a flat format where each top-level key in a `permission` object is a surface name, and the value is either a string (catch-all) or a pattern→action object.
Both formats express the same semantics (surface + pattern + action), but the flat format is more intuitive — the config IS the ruleset in a human-friendly projection.

## Goals

- **Breaking change (`feat!:`)**: replace the legacy multi-namespace config format with a flat `"permission"` key.
- Remove `defaultPolicy`, `tools`, `bash`, `mcp`, `skills`, `special` as top-level config keys.
- `permission["*"]` becomes the universal fallback (replaces `defaultPolicy.tools`).
- String values are shorthand for `{ "*": action }`.
- Object values are pattern→action maps.
- Update `schemas/permissions.schema.json` for the new format.
- Update `config/config.example.json` to use flat format.
- Update per-agent frontmatter parsing to use the same flat shape.
- Update all test fixtures.
- Update README documentation.
- Revise "friendly fork" language to "full fork" across `AGENTS.md`, `README.md`, and `.pi/prompts/` templates — this breaking config change makes the "friendly" / "drop-in" framing inaccurate.
- Write a migration guide (`docs/migration/legacy-to-flat.md`) mapping every legacy key to its flat-format equivalent.

## Non-Goals

- Maintaining backward compatibility with the legacy format (breaking change, sole user).
- Auto-migration tooling (the migration guide is manual; a codemod script is out of scope).
- Changing `evaluate()` or the internal `Rule`/`Ruleset` types (#65 already unified these).
- Changing the `/permission-system` slash command name.
- Changing runtime knobs (`debugLog`, `permissionReviewLog`, `yoloMode`) — those stay at the top level, outside `permission`.

## Background

### Dependencies

| Issue | Status | Relationship                                                          |
| ----- | ------ | --------------------------------------------------------------------- |
| #65   | Closed | Synthesized defaults and unified evaluate path — prerequisite, landed |
| #56   | Closed | Unified Rule type and normalizeConfig — prerequisite, landed          |

### Relevant modules

| File                              | Role                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/config-loader.ts`            | `UnifiedPermissionConfig`, `normalizeUnifiedConfig()`, `mergeUnifiedConfigs()`, `loadAndMergeConfigs()` |
| `src/normalize.ts`                | `NormalizableConfig`, `normalizeConfig()` — converts on-disk shape → Ruleset                            |
| `src/synthesize.ts`               | `synthesizeDefaults()`, `synthesizeOverrides()`, `synthesizeBaseline()`, `composeRuleset()`             |
| `src/permission-manager.ts`       | `normalizeRawPermission()`, per-agent frontmatter parsing, `resolvePermissions()`                       |
| `src/defaults.ts`                 | `mergeDefaults()`, `DEFAULT_POLICY`                                                                     |
| `src/types.ts`                    | `PermissionDefaultPolicy`, `ScopeConfig`                                                                |
| `src/extension-config.ts`         | `detectMisplacedPermissionKeys()` — detects policy keys in the extension config file                    |
| `schemas/permissions.schema.json` | JSON Schema for config files                                                                            |
| `config/config.example.json`      | Example config                                                                                          |

### Permission surfaces involved

All: tools (tool-name surfaces), bash, mcp, skill, special (external_directory).

### How #65 changes the picture

After #65, the internal model is already a flat `Ruleset` — `resolvePermissions()` composes defaults, overrides, baseline, and config rules into a single array.
This issue changes only the *on-disk format* and the *parsing layer* that feeds into that internal model.
The composed ruleset, `evaluate()`, `checkPermission()`, and `getToolPermission()` are unaffected.

## Design Overview

### New config shape

```jsonc
{
  // Runtime knobs (unchanged, top-level)
  "debugLog": false,
  "permissionReviewLog": true,
  "yoloMode": false,

  // Permission policy (new flat shape)
  "permission": {
    "*": "ask",
    "read": "allow",
    "write": "deny",
    "bash": { "*": "ask", "git status": "allow", "git *": "ask" },
    "mcp": { "*": "ask", "mcp_status": "allow" },
    "skill": { "*": "ask" },
    "external_directory": "ask"
  }
}
```

Rules:

- `permission["*"]` is the universal fallback (replaces `defaultPolicy.tools`).
- A string value for a surface key is shorthand for `{ "*": action }`.
- An object value maps patterns to actions within that surface.
- Tool-name surfaces (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, and extension tools) use string shorthand since they have no sub-patterns.
- Multi-pattern surfaces (`bash`, `mcp`, `skill`) use object values.
- `external_directory` uses string shorthand (catch-all for the special surface).

### Flat format → Ruleset normalization

```typescript
/** The on-disk permission shape after JSON parsing. */
type FlatPermissionConfig = Record<string, PermissionState | Record<string, PermissionState>>;

function normalizeFlatConfig(permission: FlatPermissionConfig): Ruleset {
  const rules: Rule[] = [];
  for (const [surface, value] of Object.entries(permission)) {
    if (typeof value === "string" && isPermissionState(value)) {
      rules.push({ surface, pattern: "*", action: value });
    } else if (typeof value === "object" && value !== null) {
      for (const [pattern, action] of Object.entries(value)) {
        if (isPermissionState(action)) {
          rules.push({ surface, pattern, action });
        }
      }
    }
  }
  return rules;
}
```

This replaces both `normalizeConfig()` in `src/normalize.ts` and the surface-specific loops.
The `TOOL_SURFACE_OVERRIDE_KEYS` exclusion of `tools.bash`/`tools.mcp` is eliminated — in the flat format, `bash` is always a surface key with its own pattern map, not an entry in a `tools` map.

### Eliminating `tools.bash` / `tools.mcp` overrides

In the legacy format, `tools.bash` and `tools.mcp` served as fallback overrides — catch-alls for bash/mcp when no pattern matched.
In the flat format, these become explicit `bash["*"]` and `mcp["*"]` entries in the permission object.
`synthesizeOverrides()` and `TOOL_SURFACE_OVERRIDE_KEYS` are no longer needed.

### Eliminating `defaultPolicy`

In the legacy format, `defaultPolicy` expressed per-surface fallbacks.
In the flat format:

- `permission["*"]` replaces `defaultPolicy.tools` (universal fallback).
- `permission.bash` as a string (e.g., `"bash": "ask"`) or `bash["*"]` replaces `defaultPolicy.bash`.
- Same for `mcp`, `skill`, `external_directory`.

`synthesizeDefaults()` changes to consume the flat permission object.
The `PermissionDefaultPolicy` type, `mergeDefaults()`, and `DEFAULT_POLICY` are replaced by simpler logic: extract `permission["*"]` as the universal fallback (default: `"ask"`), then per-surface catch-alls override it.

### Merge precedence

Unchanged: global → project → per-agent frontmatter → project-agent frontmatter.

For the flat format, merging two `permission` objects is a deep-shallow merge:

- For each surface key, if both scopes define it:
  - Both strings → override replaces base.
  - Both objects → shallow merge (override keys win per-pattern).
  - String vs. object → override replaces base entirely.
- Keys present in only one scope carry through.

```typescript
function mergeFlatPermissions(
  base: FlatPermissionConfig,
  override: FlatPermissionConfig,
): FlatPermissionConfig {
  const merged: FlatPermissionConfig = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const baseVal = merged[key];
    if (typeof baseVal === "object" && typeof value === "object") {
      merged[key] = { ...baseVal, ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}
```

### Per-agent frontmatter

Currently, frontmatter uses `permission:` with the legacy nested structure under it:

```yaml
---
permission:
  defaultPolicy:
    tools: allow
  bash:
    git *: allow
---
```

After this change, frontmatter uses the flat shape:

```yaml
---
permission:
  "*": ask
  read: allow
  bash:
    git *: allow
---
```

The `parseSimpleYamlMap()` already handles nested maps.
`normalizeRawPermission()` is replaced by the flat normalizer.

### `ScopeConfig` type changes

```typescript
// Before
export interface ScopeConfig {
  defaultPolicy?: Partial<PermissionDefaultPolicy>;
  tools?: Record<string, PermissionState>;
  bash?: Record<string, PermissionState>;
  mcp?: Record<string, PermissionState>;
  skills?: Record<string, PermissionState>;
  special?: Record<string, PermissionState>;
}

// After
export type FlatPermissionConfig = Record<
  string,
  PermissionState | Record<string, PermissionState>
>;

export interface ScopeConfig {
  permission?: FlatPermissionConfig;
}
```

### `UnifiedPermissionConfig` type changes

```typescript
// Before
export interface UnifiedPermissionConfig {
  debugLog?: boolean;
  permissionReviewLog?: boolean;
  yoloMode?: boolean;
  defaultPolicy?: Partial<PermissionDefaultPolicy>;
  tools?: Record<string, PermissionState>;
  bash?: Record<string, PermissionState>;
  mcp?: Record<string, PermissionState>;
  skills?: Record<string, PermissionState>;
  special?: Record<string, PermissionState>;
}

// After
export interface UnifiedPermissionConfig {
  debugLog?: boolean;
  permissionReviewLog?: boolean;
  yoloMode?: boolean;
  permission?: FlatPermissionConfig;
}
```

### `resolvePermissions()` simplification

After the format change, `resolvePermissions()` simplifies:

1. Load each scope's config.
2. Merge `permission` objects across scopes (deep-shallow merge).
3. Extract universal fallback (`permission["*"]`, default `"ask"`).
4. Call `normalizeFlatConfig()` to produce config rules.
5. Synthesize defaults from the merged permission's catch-all entries.
6. Synthesize MCP baseline.
7. Compose ruleset: `[...defaults, ...baseline, ...configRules]`.

No more `synthesizeOverrides()` or `TOOL_SURFACE_OVERRIDE_KEYS`.

### Default synthesis from flat config

```typescript
function synthesizeDefaultsFromFlat(permission: FlatPermissionConfig): Ruleset {
  const universalDefault = getUniversalDefault(permission); // permission["*"] ?? "ask"
  return [
    { surface: "*", pattern: "*", action: universalDefault, layer: "default" },
    // Per-surface defaults only if NOT already expressed in the permission object.
    // If permission.bash exists, its catch-all is handled by normalizeFlatConfig().
    // If permission.bash does NOT exist, fall through to universal default.
  ];
}
```

Actually, this is even simpler: the universal fallback `{ surface: "*", pattern: "*" }` already covers all surfaces.
Per-surface catch-alls (`bash["*"]`, `mcp["*"]`, etc.) are regular config rules that override it.
`synthesizeDefaults()` reduces to a single rule.

### MCP baseline auto-allow

`synthesizeBaseline()` continues to work as-is — it scans the config ruleset for `surface: "mcp" && action: "allow"` rules.
No changes needed.

### `detectMisplacedPermissionKeys()` in extension-config.ts

This function detects legacy policy keys in the extension runtime config file.
After the format change, the set changes from `["defaultPolicy", "tools", "bash", "mcp", "skills", "special", "external_directory"]` to just `["permission"]`.
The legacy keys should still be detected as misplaced — they indicate someone hasn't migrated.

## Module-Level Changes

### `src/types.ts`

- Add `FlatPermissionConfig` type.
- Remove `PermissionDefaultPolicy`.
- Update `ScopeConfig` to use `permission?: FlatPermissionConfig`.

### `src/normalize.ts`

- Replace `NormalizableConfig` and `normalizeConfig()` with `normalizeFlatConfig(permission: FlatPermissionConfig): Ruleset`.
- Remove `TOOL_SURFACE_OVERRIDE_KEYS`.
- The new normalizer iterates surface keys, producing rules in insertion order.

### `src/config-loader.ts`

- Replace `UnifiedPermissionConfig` policy fields with `permission?: FlatPermissionConfig`.
- Replace `normalizeUnifiedConfig()` to extract `permission` instead of the 6 legacy keys.
- Replace `mergeUnifiedConfigs()` to deep-shallow merge `permission`.
- Update `loadAndMergeConfigs()` accordingly.

### `src/synthesize.ts`

- Simplify `synthesizeDefaults()` to produce a single universal fallback rule from `permission["*"]`.
- Remove `synthesizeOverrides()` and `OverrideScope`.
- `synthesizeBaseline()` unchanged.
- Simplify `composeRuleset()` — no overrides layer.

### `src/defaults.ts`

- Remove `PermissionDefaultPolicy`-dependent code: `mergeDefaults()`, `getSurfaceDefault()`, `DEFAULT_POLICY`, `SURFACE_TO_DEFAULT_KEY`.
- File may be removable entirely if no other callers remain.

### `src/permission-manager.ts`

- Remove `normalizeRawPermission()`, `normalizePolicy()`, `normalizePartialPolicy()`, `normalizePermissionRecord()`.
- Update `loadGlobalConfig()` and `loadProjectGlobalConfig()` to return `ScopeConfig` with `permission`.
- Update `loadScopeConfigFrom()` (frontmatter) to parse the flat permission shape.
- Simplify `resolvePermissions()`: merge permissions across scopes, normalize, compose.
- `checkPermission()` and `getToolPermission()` are unchanged (they already work with composed rules from #65).

### `src/extension-config.ts`

- Update `PERMISSION_POLICY_KEYS` to include `"permission"` and the legacy keys (for migration warnings).
- Update the warning message text.

### `schemas/permissions.schema.json`

- Replace `defaultPolicy`, `tools`, `bash`, `mcp`, `skills`, `special` with a `permission` property.
- `permission` is an object where each key is a surface name.
- Each value is either a `permissionState` string or a `permissionMap` object.
- Keep `$defs/permissionState` and `$defs/permissionMap` as-is.

### `config/config.example.json`

- Replace with flat format example.

### `README.md`

- Update config format documentation and examples.
- Replace "friendly fork" notice with "full fork" language.
- Remove "diverges from upstream in config layout (#10)" — the divergence is now comprehensive, not config-layout-specific.

### `AGENTS.md`

- Replace "friendly fork" with "full fork" (line 7).
- Replace "diverges from upstream in config layout" with broader divergence statement (line 8).
- Remove "diverging from upstream's on-disk identity" constraint (line 18) — no longer meaningful.
- Update "Config and log paths intentionally diverge from upstream" references (lines 28, 151) — reframe around the `/permission-system` slash command being the sole preserved identity.

### `.pi/prompts/plan-issue.md`, `.pi/prompts/tdd-plan.md`, `.pi/prompts/retro.md`

- Replace "upstream-shared on-disk identity" references with simpler "breaking change" language.
- Remove upstream-specific framing since the fork is now fully independent.

### `docs/migration/legacy-to-flat.md` (new)

- Migration guide mapping every legacy config key to its flat-format equivalent.
- Side-by-side before/after examples for: `defaultPolicy`, `tools`, `bash`, `mcp`, `skills`, `special`, `tools.bash`/`tools.mcp` overrides, per-agent frontmatter.
- Checklist format so users can verify each section is migrated.

### Tests

- `tests/normalize.test.ts` — rewrite for `normalizeFlatConfig()`.
- `tests/config-loader.test.ts` — rewrite fixtures and assertions for flat format.
- `tests/synthesize.test.ts` — update `synthesizeDefaults()` tests; remove `synthesizeOverrides()` tests.
- `tests/defaults.test.ts` — remove or rewrite (depends on whether `defaults.ts` survives).
- `tests/permission-system.test.ts` — update all config fixtures to flat format.
- `tests/handlers/*.test.ts` — update any config fixtures.
- `tests/external-directory.test.ts`, `tests/bash-external-directory.test.ts` — update fixtures.
- `tests/extension-config.test.ts` — update misplaced-key detection tests.
- `tests/common.test.ts` — no changes expected (YAML parser is format-agnostic).

## TDD Order

1. **feat!: add FlatPermissionConfig type and normalizeFlatConfig()**
   - Red: write tests for `normalizeFlatConfig()` — string shorthand, object patterns, mixed, empty.
   - Green: implement in `src/normalize.ts`.
   - Update `src/types.ts` with `FlatPermissionConfig`.
   - Update existing `normalize.test.ts` (old tests for `normalizeConfig()` are replaced).
   - Commit: `feat!: add normalizeFlatConfig for flat permission format (#66)`

2. **feat!: simplify synthesizeDefaults() for flat format**
   - Red: write tests for single-rule universal default, custom fallback.
   - Green: simplify `synthesizeDefaults()` to accept `PermissionState` (the universal default) instead of `PermissionDefaultPolicy`.
   - Remove `synthesizeOverrides()` and `OverrideScope`.
   - Update `composeRuleset()` signature (no overrides layer).
   - Update `synthesize.test.ts`.
   - Commit: `feat!: simplify synthesize layer for flat config (#66)`

3. **feat!: replace UnifiedPermissionConfig with flat permission key**
   - Red: update `config-loader.test.ts` fixtures and assertions.
   - Green: rewrite `normalizeUnifiedConfig()`, `mergeUnifiedConfigs()` for flat format.
   - Remove legacy policy fields from `UnifiedPermissionConfig`.
   - Commit: `feat!: replace config-loader with flat permission format (#66)`

4. **feat!: update ScopeConfig and remove PermissionDefaultPolicy**
   - Red: update `defaults.test.ts` and any tests importing `PermissionDefaultPolicy`.
   - Green: update `ScopeConfig` in `src/types.ts`.
     Remove `mergeDefaults()`, `getSurfaceDefault()`, `DEFAULT_POLICY` from `src/defaults.ts` (or remove the file).
   - Commit: `feat!: remove PermissionDefaultPolicy and legacy defaults (#66)`

5. **feat!: update PermissionManager for flat config**
   - Red: update `permission-system.test.ts` fixtures to flat format.
   - Green: rewrite `resolvePermissions()`, `loadGlobalConfig()`, `loadProjectGlobalConfig()`, `loadScopeConfigFrom()`.
   - Remove `normalizeRawPermission()` and helpers.
   - All permission-system tests pass with flat config fixtures.
   - Commit: `feat!: update PermissionManager for flat permission config (#66)`

6. **feat!: update extension-config misplaced-key detection**
   - Red: update `extension-config.test.ts` for new key set.
   - Green: update `PERMISSION_POLICY_KEYS` and warning message.
   - Commit: `feat!: update misplaced-key detection for flat format (#66)`

7. **feat!: update JSON schema and example config**
   - Rewrite `schemas/permissions.schema.json`.
   - Rewrite `config/config.example.json`.
   - Commit: `feat!: update schema and example for flat permission format (#66)`

8. **test: update remaining test fixtures**
   - Update `external-directory.test.ts`, `bash-external-directory.test.ts`, handler tests.
   - Ensure full test suite passes.
   - Commit: `test: update all test fixtures for flat permission format (#66)`

9. **docs: write migration guide**
   - Create `docs/migration/legacy-to-flat.md` with before/after examples for every legacy key.
   - Include per-agent frontmatter migration.
   - Commit: `docs: add legacy-to-flat migration guide (#66)`

10. **docs: revise fork language across project docs**
    - Update `AGENTS.md`: "friendly fork" → "full fork", remove upstream-divergence constraints.
    - Update `README.md`: replace fork notice blockquote, update config sections and examples.
    - Update `.pi/prompts/plan-issue.md`, `tdd-plan.md`, `retro.md`: remove upstream-specific framing.
    - Commit: `docs: revise fork language from friendly to full fork (#66)`

## Risks and Mitigations

| Risk                                                                                                      | Mitigation                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Breaking change for existing configs                                                                      | Issue explicitly states no backward compatibility. Sole user. `detectMisplacedPermissionKeys()` warns on legacy keys.                                                  |
| `tools.bash`/`tools.mcp` override semantics lost                                                          | In the flat format, users express this directly as `bash: { "*": "allow" }`. The override concept is unnecessary — the user controls catch-all placement.              |
| Per-surface defaults (e.g., `defaultPolicy.bash`) no longer expressible separately from `permission["*"]` | Users write `bash: { "*": "ask" }` to set a bash-specific default. The universal fallback `"*"` only applies when no surface-specific catch-all exists.                |
| Frontmatter YAML parsing of `"*"` key requires quoting                                                    | `parseSimpleYamlMap()` already strips quotes from keys. Document that `"*"` must be quoted in YAML frontmatter.                                                        |
| Could this silently weaken a permission?                                                                  | No — the flat format normalizes to the same `Rule[]` as the legacy format. `evaluate()` is unchanged. The universal default is `"ask"` (least privilege) when omitted. |
| Merge semantics change subtly (object + string for same surface)                                          | Define clearly: override replaces base entirely when types differ. Document in README.                                                                                 |
| MCP baseline auto-allow breaks if config rules change shape                                               | `synthesizeBaseline()` scans for `surface: "mcp" && action: "allow"` — this is independent of config format. `normalizeFlatConfig()` produces the same `Rule` shape.   |
| Fork-language update causes stale prompt template behavior                                                | Changes to `.pi/prompts/` are cosmetic (removing upstream references). No behavioral impact on prompt execution.                                                       |

## Open Questions

- Should we keep `defaults.ts` as a file with just a `DEFAULT_UNIVERSAL_FALLBACK = "ask"` constant, or inline it?
  Leaning toward a small constant in `src/synthesize.ts` and deleting `defaults.ts`.
- Should `permission` be required or optional in the config file?
  Leaning toward optional — omitting it means all-ask (least privilege), same as today.
- Should legacy keys in a config file produce a config issue pointing to the new format, or be silently ignored?
  Leaning toward config issue (one-line migration hint) — matches the deprecation-tolerance pattern in AGENTS.md.
