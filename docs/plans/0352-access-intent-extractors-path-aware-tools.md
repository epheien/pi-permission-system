---
issue: 352
issue_title: "Add access intent extractors for path-aware extension tools"
---

# Path-aware gating for extension and MCP tools

## Problem Statement

Path-based permission gating only recognizes six hardcoded built-in tools.
`PATH_BEARING_TOOLS` in `path-utils.ts` is `{ read, write, edit, find, grep, ls }`, and `getPathBearingToolPath` returns a path only for those.
Both cross-cutting path gates — `describePathGate` (the `path` surface) and `describeExternalDirectoryGate` (the `external_directory` boundary) — call `getPathBearingToolPath`, so for any other tool they receive `null` and skip the gate.

Consequently, a third-party extension tool or an MCP tool that reads or writes the filesystem **bypasses the `path` and `external_directory` gates entirely**.
A user who configured `"path": { "*.env": "deny" }` or relies on the external-directory boundary is silently unprotected against tools outside the built-in six.
This is a permission-bypass gap in a package whose whole purpose is deterministic least-privilege gating.

This work is derived from third-party PR #352 (`moekyo`, branch `feature/path-aware-extension-tools`).
The operator's chosen direction (confirmed via the planning `ask_user` gate) is to **adopt the capability with a simplified design**, not to merge the PR as-is.

## Attribution

The capability and the cross-extension API shape originate with `moekyo`'s PR #352.
Because we ship a re-implementation rather than merging the branch, credit must be explicit and durable:

- **Every** implementation and docs commit for this issue carries this trailer (blank line before it, at the end of the commit body):

  ```text
  Co-authored-by: moekyo <shigotods@outlook.com>
  ```

- The PR #352 close comment (ship stage) thanks `@moekyo` by name for the original PR and design exploration, and links the implementing SHA(s).

Do not use `Closes #352` in any commit (it pre-empts the curated close comment, per AGENTS.md); reference the PR as `Refs #352` / `(#352)` instead.

## Goals

- Close the bypass: extension tools and MCP tools that operate on a filesystem path are subject to the cross-cutting `path` and `external_directory` gates.
- Detect path tools **by convention, without registration**: any non-bash tool exposing `input.path` (and MCP via `input.arguments.path`) is path-gated automatically (default-on).
- Provide `registerToolAccessExtractor(toolName, extractor)` on the cross-extension `PermissionsService` as the escape hatch for tools whose path lives under a non-standard key.
- Keep the design lean: the extractor is `(input) => string | undefined` (a path value), with **no** `ToolAccessIntent` envelope.
- This change is **breaking**: extension/MCP path tools that were previously ungated become gated on upgrade without a user edit.
  It is a security fix; use `feat!:` with a `BREAKING CHANGE:` footer on the behavior-changing commit.

## Non-Goals

- **Per-tool path maps for extension tools** (e.g. `"ffgrep": { "*.env": "deny" }`).
  Deferred as an additive follow-up (see Open Questions).
  In this change, extension/MCP tools are gated via the cross-cutting `path` and `external_directory` surfaces; whole-tool policy (`"ffgrep": "deny"`) still works via the per-tool surface.
- Threading the extractor through `normalizeInput` / `PermissionManager` — not needed for the cross-cutting gates and reserved for the per-tool-path-map follow-up.
- The `ToolAccessIntent` envelope from PR #352 (`resource` / `operation` / `confidence` / `source` / `toolName`).
  Only `.value` was ever consumed by a gate; the remaining fields are speculative (`resource` and `confidence` each have one inhabitant) and a maintenance trap.
- Multi-path tools: one path per tool (the default `input.path` convention and PR #352's own `ToolAccessIntentDeclaration.value` are both single-path).
- Extending the read-only infrastructure auto-allow (`READ_ONLY_PATH_BEARING_TOOLS`) to extension tools — out of scope.
- Wiring into the Phase 5 roadmap: this is a new feature, not a roadmap step.

## Background

### Current extraction and consumers

`src/path-utils.ts`:

```typescript
export const PATH_BEARING_TOOLS = new Set(["read", "write", "edit", "find", "grep", "ls"]);

export function getPathBearingToolPath(toolName: string, input: unknown): string | null {
  if (!PATH_BEARING_TOOLS.has(toolName)) return null;
  return getNonEmptyString(toRecord(input).path);
}
```

`getPathBearingToolPath` has four callers:

1. `handlers/gates/path.ts` — the `path` gate (decision-bearing).
2. `handlers/gates/external-directory.ts` — the `external_directory` gate (decision-bearing).
3. `handlers/gates/tool.ts` — the per-tool gate, but only for the session-approval **suggestion** value and the decision **log** value (cosmetic, not the decision).

Only the two cross-cutting gates need to become path-aware for extension tools.
`tool.ts` stays on `getPathBearingToolPath` (built-in semantics are correct there — the per-tool surface for extension tools stays `"*"`, consistent with `normalizeInput`).

### The proven registrar pattern to mirror

`src/tool-input-formatter-registry.ts` already establishes the exact shape this change needs:

- A read-only `ToolInputFormatterLookup` (`get(toolName)`) and a write-only `ToolInputFormatterRegistrar` (`register(toolName, fn): () => void`), split for ISP.
- A `ToolInputFormatterRegistry` class implementing both; duplicate registration throws; the disposer is identity-guarded.
- Created once in `index.ts`; the **same instance** is passed as a `Registrar` to `LocalPermissionsService` (line 131) and as a `Lookup` to `ToolCallGatePipeline` (line 174).
- Exposed cross-extension via `PermissionsService.registerToolInputFormatter` (`service.ts`).

The new extractor registry mirrors this one-for-one.

### Pipeline wiring

`ToolCallGatePipeline` is constructed once (`index.ts:171`) with `(resolver, session, formatterRegistry)` and holds `customFormatters?` as a constructor field, handing it to `ToolPreviewFormatter`.
Adding `customExtractors?: ToolAccessExtractorLookup` as a fourth constructor parameter and forwarding it to the two gate producers mirrors the existing `customFormatters` relay exactly.

### AGENTS.md / skill constraints

- Keep schema, example config, `docs/configuration.md`, `README.md`, and loaders aligned (package skill).
  Here only `schemas/permissions.schema.json` `markdownDescription`, `docs/configuration.md`, `docs/cross-extension-api.md`, and `README.md` need touching — there is **no** new config field (registration is a runtime API), so the loader/`PermissionSystemExtensionConfig` are untouched.
- `docs/architecture/architecture.md` carries a "Path-bearing tool normalization" section and a "Module structure" listing — both need updates.
- Default to least privilege — gating previously-ungated path tools is the safe direction.

## Design Overview

### Lean extractor + registry (`src/tool-access-extractor-registry.ts`)

Adapted from PR #352's registry (which is already lean and correct), with the **value-only** extractor signature:

```typescript
/** Returns the filesystem path this tool will access, or undefined to decline. */
export type ToolAccessExtractor = (
  input: Record<string, unknown>,
) => string | undefined;

export interface ToolAccessExtractorLookup {
  get(toolName: string): ToolAccessExtractor | undefined;
}

export interface ToolAccessExtractorRegistrar {
  register(toolName: string, extractor: ToolAccessExtractor): () => void;
}

export class ToolAccessExtractorRegistry
  implements ToolAccessExtractorLookup, ToolAccessExtractorRegistrar {
  private readonly extractors = new Map<string, ToolAccessExtractor>();
  register(toolName, extractor) { /* throw on dup; identity-guarded disposer */ }
  get(toolName) { return this.extractors.get(toolName); }
}
```

### Extensible extraction (`src/path-utils.ts`)

A new function alongside the unchanged `getPathBearingToolPath`:

```typescript
export function getToolInputPath(
  toolName: string,
  input: unknown,
  extractors?: ToolAccessExtractorLookup,
): string | null {
  if (toolName === "bash") return null; // bash has its own token-based path gates
  const record = toRecord(input);

  if (PATH_BEARING_TOOLS.has(toolName)) return getNonEmptyString(record.path);
  if (toolName === "mcp") return getNonEmptyString(toRecord(record.arguments).path);

  const custom = extractors?.get(toolName);
  if (custom) return getNonEmptyString(custom(record));

  return getNonEmptyString(record.path); // default convention for extension tools
}
```

`toRecord` coerces non-objects to `{}`, so MCP/extension extraction is null-safe without an `isPlainRecord` guard.

### Gate consumption

`describePathGate(tcc, resolver, extractors?)` and `describeExternalDirectoryGate(tcc, infraDirs, extractors?)` swap `getPathBearingToolPath(tcc.toolName, tcc.input)` for `getToolInputPath(tcc.toolName, tcc.input, extractors)`.
Everything downstream is unchanged: the `path` gate still calls `resolver.resolve("path", { path }, …)` and still short-circuits when no explicit `path` rule matched (`matchedPattern === undefined`, preserving #58); `external_directory` still applies the `isPathOutsideWorkingDirectory` + infra-read checks.
No `PermissionManager`/`normalizeInput` change is needed, because the `path` and `external_directory` surfaces are special keys that `normalizeInput` already resolves from `{ path }`.

### Service call-site sketch (consumer)

```typescript
const permissions = getPermissionsService();
const dispose = permissions?.registerToolAccessExtractor(
  "ffgrep",
  (input) => (typeof input.target === "string" ? input.target : undefined),
);
// ...later
dispose?.();
```

Tell-Don't-Ask: the consumer hands a pure function to the registrar and gets a disposer; it never inspects registry internals.

### Composition-root wiring (`src/index.ts`)

```typescript
const accessExtractorRegistry = new ToolAccessExtractorRegistry();

const permissionsService = new LocalPermissionsService(
  permissionManager, sessionRules, formatterRegistry, accessExtractorRegistry, // +1
);

const toolCallGatePipeline = new ToolCallGatePipeline(
  resolver, session, formatterRegistry, accessExtractorRegistry, // +1 (lookup)
);
```

One registry instance; the service holds the `Registrar` side, the pipeline the `Lookup` side — exactly as `formatterRegistry` is shared today.

### Design-review checklist result

- Dependency width: `ToolAccessExtractorLookup` is one method; pipeline gains one optional field.
  Narrow.
- Law of Demeter: gates call `getToolInputPath(tcc.toolName, tcc.input, this.customExtractors)` — no reach-through.
- Output arguments: none; the extractor is a pure `(input) => string | undefined`.
- Parameter relay: `customExtractors` flows `index → pipeline → gate fns` and is consumed at the gates, mirroring the existing `customFormatters` relay — established pattern, not a new smell.
- Missing abstraction: the registry is the cohesive abstraction.

No structural smells; the change mirrors the `ToolInputFormatterRegistry` precedent.

## Module-Level Changes

### New files

1. `src/tool-access-extractor-registry.ts` — `ToolAccessExtractor` (value-only), `ToolAccessExtractorLookup`, `ToolAccessExtractorRegistrar`, `ToolAccessExtractorRegistry`.
2. `test/tool-access-extractor-registry.test.ts` — register/dispose/duplicate-throw/identity-guard/get, mirroring `tool-input-formatter-registry.test.ts`.

### Modified — source

1. `src/path-utils.ts` — add `getToolInputPath`; `getPathBearingToolPath` unchanged.
2. `src/handlers/gates/path.ts` — `describePathGate` accepts `extractors?: ToolAccessExtractorLookup`; use `getToolInputPath`.
3. `src/handlers/gates/external-directory.ts` — same for `describeExternalDirectoryGate`.
4. `src/handlers/gates/tool-call-gate-pipeline.ts` — add `customExtractors?` constructor param; pass to the two gate producers.
5. `src/service.ts` — add `registerToolAccessExtractor(toolName, extractor): () => void` to the `PermissionsService` interface (mirror the `registerToolInputFormatter` doc block).
6. `src/permissions-service.ts` — inject `ToolAccessExtractorRegistrar` (4th ctor param); implement `registerToolAccessExtractor` delegating to `registry.register`.
7. `src/index.ts` — construct `ToolAccessExtractorRegistry`; pass to `LocalPermissionsService` and `ToolCallGatePipeline`.

### Modified — tests

1. `test/path-utils.test.ts` — `getToolInputPath` cases: built-ins → `input.path`; `bash` → null; `mcp` → `arguments.path`; extension default → `input.path`; registered extractor overrides; missing/empty → null.
2. `test/handlers/gates/path.test.ts` — extension/MCP tool with `input.path` now produces a `path` descriptor under a matching rule; registered extractor's path is used.
3. `test/handlers/gates/external-directory.test.ts` — extension/MCP external path now gated.
4. `test/handlers/gates/tool-call-gate-pipeline.test.ts` — pipeline forwards `customExtractors` to the gates (end-to-end: an extension tool with an external `input.path` blocks).
5. `test/permissions-service.test.ts` — `registerToolAccessExtractor` delegates to the registrar and returns its disposer.
6. `test/service.test.ts` — adapter delegation + accessor includes the new method.
7. `test/composition-root.test.ts` — a registered extractor reaches the live pipeline (parallel to the existing `registerToolInputFormatter` wiring assertion at line 321).

### Modified — docs / schema

1. `docs/cross-extension-api.md` — add a `registerToolAccessExtractor` section mirroring `registerToolInputFormatter`; note default-on convention.
2. `docs/configuration.md` — document that `path` / `external_directory` now cover extension + MCP path tools; show the `path`-surface form for protecting files across all tools.
3. `README.md` — brief mention in the permissions/behavior section.
4. `schemas/permissions.schema.json` — update the `permission` `markdownDescription` to state extension tools (via `input.path` or a registered extractor) and MCP (`input.arguments.path`) participate in `path` gating.
5. `docs/architecture/architecture.md` — "Path-bearing tool normalization" gets a note that the cross-cutting gates extract paths for extension/MCP tools via the extractor registry; add `tool-access-extractor-registry.ts` to the "Module structure" listing.
6. `config/config.example.json` — **review only**; if adding an illustrative entry, use the cross-cutting `path` surface (e.g. `"path": { "*.env": "deny" }`), **not** PR #352's per-tool `ffgrep` path map (that requires the deferred per-tool feature).

## Test Impact Analysis

1. New lower-level tests enabled:
   - `tool-access-extractor-registry.test.ts` — register/dispose/dup semantics in isolation.
   - `getToolInputPath` table tests covering built-in / bash / mcp / extension-default / registered-extractor / empty branches purely (mocked lookup).
2. Existing tests that change (behavior change, not redundant):
   - `path.test.ts` / `external-directory.test.ts` gain cases asserting extension/MCP tools are now gated.
     Existing built-in cases stay green (the `extractors` parameter is optional and built-in extraction is unchanged).
   - `getPathBearingToolPath` tests in `path-utils.test.ts` stay as-is (function unchanged); add a sibling block for `getToolInputPath`.
3. Tests that must stay as-is:
   - `tool.test.ts` — the per-tool gate is unchanged (still uses `getPathBearingToolPath` for suggestion/log values).
   - All `normalizeInput` / `permission-manager` tests — untouched in this scope.

## TDD Order

Every commit below includes the `Co-authored-by: moekyo <shigotods@outlook.com>` trailer (see Attribution).

### Cycle 1 — extractor registry

1. RED: `test/tool-access-extractor-registry.test.ts` — `register` returns a disposer; duplicate registration throws; disposer is identity-guarded (a stale disposer cannot evict a later registration); `get` returns the extractor or `undefined`.
2. GREEN: `src/tool-access-extractor-registry.ts`.

- Commit: `feat: add tool access extractor registry (#352)`

### Cycle 2 — extensible path extraction

1. RED: `test/path-utils.test.ts` — `getToolInputPath` table: built-ins → `input.path`; `bash` → null; `mcp` → `arguments.path`; extension default → `input.path`; a registered extractor (via a fake `Lookup`) overrides; missing/empty → null.
2. GREEN: add `getToolInputPath` to `src/path-utils.ts`.

- Commit: `feat: add extensible tool input path extraction (#352)`

### Cycle 3 — gates gate extension/MCP path tools (default-on, breaking)

1. RED: update `test/handlers/gates/path.test.ts`, `external-directory.test.ts`, and `tool-call-gate-pipeline.test.ts` — an extension tool with `input.path` (and an MCP tool with `arguments.path`) under a matching `path` rule / outside the cwd now produces a gate descriptor; a registered extractor's path is honored; bash and pathless tools still skip.
2. GREEN: thread `customExtractors?: ToolAccessExtractorLookup` into `ToolCallGatePipeline` and both gate signatures; switch the two gates to `getToolInputPath`; construct + pass the registry lookup in `src/index.ts`.
   Run `pnpm --filter @gotgenes/pi-permission-system run check` (pipeline constructor signature change has a single call site in `index.ts`).

- Commit: `feat!: gate extension and MCP path tools by default (#352)`
- Footer: `BREAKING CHANGE: extension and MCP tools that expose a filesystem path (input.path, or input.arguments.path for MCP) are now subject to the path and external_directory permission gates. Tools previously ungated may now prompt or be denied under existing path rules.`

### Cycle 4 — expose `registerToolAccessExtractor` on the service

1. RED: `test/permissions-service.test.ts` (delegates to the registrar, returns its disposer), `test/service.test.ts` (adapter delegation + accessor surface), `test/composition-root.test.ts` (a registered extractor reaches the live pipeline and gates the matching tool end-to-end).
2. GREEN: add the method to the `PermissionsService` interface (`src/service.ts`); inject `ToolAccessExtractorRegistrar` into `LocalPermissionsService` and implement it; pass `accessExtractorRegistry` as the registrar in `src/index.ts`.
   Run `pnpm --filter @gotgenes/pi-permission-system run check`.

- Commit: `feat: expose registerToolAccessExtractor via permissions service (#352)`

### Cycle 5 — docs + schema

1. GREEN (docs): update `docs/cross-extension-api.md`, `docs/configuration.md`, `README.md`, `schemas/permissions.schema.json` (`markdownDescription`), and `docs/architecture/architecture.md`; review `config/config.example.json` (path-surface example only).

- Commit: `docs: document path-aware extension/MCP gating and registerToolAccessExtractor (#352)`

## Risks and Mitigations

| Risk                                                                                                    | Mitigation                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `input.path` false positives — a tool whose `input.path` is not a filesystem path gets spuriously gated | The `path` gate is a no-op unless an explicit `path` rule matched (`matchedPattern === undefined` → skip, #58); `external_directory` only fires for paths resolving outside the cwd. Friction only arises with configured path rules and an external-looking value. Documented under default-on. |
| Behavior change surprises users on upgrade                                                              | Shipped as `feat!:` with a `BREAKING CHANGE:` footer; documented in `docs/configuration.md` and the schema description; it is a security improvement (closing a bypass).                                                                                                                         |
| Pipeline constructor signature change breaks the single call site                                       | `index.ts` is the sole construction site; updated in the same commit (Cycle 3); `pnpm run check` after.                                                                                                                                                                                          |
| MCP `arguments.path` does not match every MCP tool's shape                                              | This is best-effort default coverage; non-conforming MCP tools use a registered extractor. Matches PR #352's MCP handling.                                                                                                                                                                       |
| Divergence from the source PR causes confusion when the PR is closed                                    | The close comment credits `@moekyo` by name, states the simplified design adopted (lean extractor, no envelope), links the implementing SHA(s), and notes the deferred per-tool follow-up.                                                                                                       |

## Open Questions

- **Per-tool path maps for extension tools** (`"ffgrep": { "*.env": "deny" }`) — deferred.
  Additive later: thread the same extractor through `PermissionManager.checkPermission` → `normalizeInput`, and change `normalizeInput`'s extension-tool branch from `values: ["*"]` to `getToolInputPath(...)`.
  No API or registry change required.
  File a follow-up issue and reference it in the PR #352 close comment.
- Should built-in MCP path extraction eventually consider arguments beyond `path` (e.g. `paths`, `file`)?
  Out of scope; revisit if MCP tooling conventions broaden.
