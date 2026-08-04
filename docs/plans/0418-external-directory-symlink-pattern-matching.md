---
issue: 418
issue_title: '[Bug] Even though "Allow" is configured, the permission system still prompts for confirmation on access requests'
---

# Match `external_directory` patterns against both the typed and the symlink-resolved path

## Problem Statement

A user configured `external_directory: { "*": "ask", "/tmp/*": "allow" }` (and `path: { "/tmp/*": "allow" }`), yet an agent running `ls -la /tmp/` still triggered an external-directory confirmation prompt.
The denial log shows the gate evaluated `/private/tmp`, not `/tmp`: on macOS `/tmp` is a symlink to `/private/tmp`.

The root cause is that both external-directory gates resolve symlinks (`/tmp` → `/private/tmp`) **before** pattern matching, so the user's `/tmp/*` pattern is matched against the resolved `/private/tmp` and never hits.
Symlink resolution is correct for the outside-CWD **boundary** decision (is this path outside the working directory?), but wrong for **pattern matching** against the patterns a user actually typed.
`canonicalNormalizePathForComparison`'s own docstring already says it is for "containment decisions ... not for pattern matching", yet `describeExternalDirectoryGate` feeds its output straight into the resolver, and `BashProgram.externalPaths` returns the canonical (symlink-resolved) path that `describeBashExternalDirectoryGate` then pattern-matches.

This issue was filed by a third party (`lipaysamart`, not the maintainer).
The maintainer confirmed the direction: fix the bug, and match patterns against **both** the typed and the symlink-resolved forms as aliases (last-match-wins), so a `/tmp/*` rule works and any existing `/private/tmp/*` workaround keeps working.

## Goals

- Make `external_directory` allow/deny/ask patterns match the path **as written** (`/tmp/*`) on systems where the path is a symlink, fixing the reported false prompt.
- Preserve matching against the **symlink-resolved** form too (`/private/tmp/*`), so existing canonical-form workaround configs keep working.
  Both forms are evaluated as equivalent aliases under the existing last-match-wins alias mechanism (`evaluateAnyValue`).
- Keep the outside-CWD **boundary** decision on the symlink-resolved path, so the gate still fires for every external access and least-privilege is preserved.
- Apply the fix consistently to **both** external-directory surfaces: the tool gate (`describeExternalDirectoryGate`) and the bash gate (`describeBashExternalDirectoryGate` over `BashProgram.externalPaths`).
- Reuse the existing resolver surface (generalize `resolvePathPolicy`/`checkPathPolicy` with a `surface` parameter) rather than adding a new resolver method, honoring the architecture's "resolver surface widening" risk note (architecture.md lines 594–595).

This change alters observable behavior for existing configs on upgrade without a user edit: a symlinked `external_directory` allow that previously prompted will now allow, and — importantly — a symlinked `external_directory` **deny** that previously fell through to the `*` fallback (silently allowed) will now correctly deny.
The behavior change is the correction itself and moves toward least privilege, so this is a bug fix (`fix:`), not a breaking change (no documented default or public surface is removed or redefined).

## Non-Goals

- Do **not** change the cross-cutting `path` surface or the path-bearing tool surfaces (`read`, `write`, `edit`, `grep`, `find`, `ls`) to add canonical aliases.
  They already match against the lexical path; the bug and the fix are scoped to `external_directory`.
- Do **not** change the outside-CWD boundary decision (`isPathOutsideWorkingDirectory`) — it stays on the canonical, symlink-resolved path.
- Do **not** change Pi-infrastructure-read containment semantics (`isPiInfrastructureRead`) — that check stays on the canonical path.
- Do **not** add a new resolver method (would widen the resolver surface the architecture flags as a risk).
  Generalize the existing `resolvePathPolicy`/`checkPathPolicy` with an optional `surface` parameter instead.
- Do **not** add `**` (globstar) syntax — a single `*` already crosses subdirectory boundaries.
- Do **not** change Windows case-folding behavior.

## Background

Relevant modules and the current (buggy) data flow:

- `src/handlers/gates/external-directory.ts` — `describeExternalDirectoryGate(tcc, infraDirs, extractors)`.
  Computes `normalizedExtPath = canonicalNormalizePathForComparison(externalDirectoryPath, cwd)` (symlink-resolved) and sets `input: { path: normalizedExtPath }`, which the runner passes to `resolver.resolve("external_directory", input)`.
  That is the tool-gate bug: pattern matching runs against the resolved path.
  The gate does **not** currently receive a resolver; the sibling `describePathGate` does.
- `src/handlers/gates/bash-external-directory.ts` — `describeBashExternalDirectoryGate(tcc, bashProgram, resolver)`.
  Iterates `bashProgram.externalPaths(cwd)` and calls `resolver.resolve("external_directory", { path: p })` per path.
  This is the surface that actually fired in the report (`toolName: "bash"`).
- `src/handlers/gates/bash-program.ts` — `BashProgram.externalPaths(cwd): string[]`.
  For each candidate token it computes `canonicalizePath(normalizePathForComparison(candidate, resolveBase))`, uses the canonical form for the within-CWD boundary check, and pushes the **canonical** form into the returned list (deduped by canonical).
  That is the bash-gate bug source: the returned, pattern-matched value is symlink-resolved.
- `src/path-utils.ts` — `normalizePathForComparison` (lexical, no symlink), `canonicalNormalizePathForComparison` (lexical + `realpathSync`; docstring: containment only, "not for pattern matching"), `getPathPolicyValues` (lexical alias list: absolute + cwd-relative + literal, home-expanded via #350).
- `src/permission-resolver.ts` — `ScopedPermissionResolver` with `resolve`, `resolvePathPolicy(values)` (hardcoded to the `path` surface), `checkPermission`.
- `src/permission-manager.ts` — `checkPathPolicy(values, agentName?, sessionRules?)` (hardcoded surface/toolName `"path"`) → `buildCheckResult`.
  `buildCheckResult` uses `evaluateAnyValue` for any surface in `PATH_SURFACES` (which includes `external_directory`): **last-rule-wins across the alias set** (`rules.findLast(r => values.some(v => ruleMatches(r, surface, v)))`).
  `deriveSource` returns `"special"` for `external_directory` (a `SPECIAL_PERMISSION_KEYS` member), matching today's `checkPermission` source.
- `src/session-rules.ts` — `deriveApprovalPattern(normalizedPath)` → `<dir>/*` for session approvals.

Constraints from AGENTS.md / the package skill:

- "The four path layers compose with most-restrictive-wins"; the boundary gate must keep firing — preserved here (boundary stays canonical).
- "Wildcard matching must be explicit and tested — silent over-matching is a permission bypass."
  New alias matching needs deterministic symlink tests.
- "When a gate resolves through a new manager/resolver method beyond `checkPermission`/`resolve` (e.g. `checkPathPolicy`/`resolvePathPolicy`), wire it through the same surface dispatcher in `makeHandler`" — the #393 false-green class.
  Because the external-directory gates will now resolve through `resolvePathPolicy`/`checkPathPolicy`, `makeHandler` must route the `external_directory` surface onto `checkPathPolicy` (mirroring `checkPermission`), or `makeSurfaceCheck`-driven tests will silently pass `allow`.
- `docs/architecture/architecture.md` inline-documents the gate listing, `path-utils.ts`, `bash-program.ts`, and the resolver surface; these need updating.

## Design Overview

### Decision model

For the `external_directory` surface, evaluate a tool/bash path against the **union** of:

1. the lexical (as-typed, normalized, non-symlink-resolved) policy values from `getPathPolicyValues`, and
2. the canonical (symlink-resolved) absolute path,

as equivalent aliases, using the existing `evaluateAnyValue` (last-rule-wins across aliases) path already wired for `PATH_SURFACES`.
The outside-CWD boundary check and the infrastructure-read check keep using the canonical path.

Why last-match-wins is correct here: `evaluateAnyValue` returns the last config rule (in config order) that matches *any* alias.
So `{ "*": "ask", "/tmp/*": "allow" }` resolves `allow` (the `/tmp/*` rule matches the lexical alias and is later than `*`); `{ "*": "allow", "/tmp/*": "deny" }` resolves `deny` (closing today's silent-allow hole on symlinked denies).

### New shared helper (`path-utils.ts`)

```ts
/**
 * Equivalent external_directory policy-match values for a path: the lexical
 * (as-typed) alias list plus the canonical (symlink-resolved) absolute path.
 * The boundary/containment decision uses the canonical form separately; this
 * helper is only for pattern matching, so user patterns on the typed path and
 * on the resolved path both match (last-match-wins across aliases).
 */
export function getExternalDirectoryPolicyValues(
  pathValue: string,
  cwd: string,
): string[] {
  const lexical = getPathPolicyValues(pathValue, { cwd });
  const canonical = canonicalNormalizePathForComparison(pathValue, cwd);
  return canonical ? [...new Set([...lexical, canonical])] : lexical;
}
```

Lexical aliases come first so the representative value (used by `evaluateAnyValue`'s fallback and display) is the typed form; the `Set` collapses the no-symlink case (Linux `/tmp`) to a single value.

### Resolver surface generalization (no new method)

Add an optional `surface` parameter (default `"path"`) to the existing methods:

```ts
// ScopedPermissionManager
checkPathPolicy(
  values: readonly string[],
  agentName?: string,
  sessionRules?: Ruleset,
  surface?: string, // default "path"
): PermissionCheckResult;

// ScopedPermissionResolver
resolvePathPolicy(
  values: readonly string[],
  agentName?: string,
  surface?: string, // default "path"
): PermissionCheckResult;
```

`PermissionManager.checkPathPolicy` threads `surface` into `buildCheckResult(surface, lookupValues, {}, surface, surface, fullRules)`.
Existing callers (the bash-path gate, `resolvePathPolicy`) are unaffected by the default.
This keeps the resolver surface at four methods (`resolve` + `resolvePathPolicy` + `checkPermission` + `checkPathPolicy`), consistent with architecture.md's risk note rather than widening it.

### Tool gate call site (Tell-Don't-Ask check)

```ts
// describeExternalDirectoryGate, after the boundary + infra checks
const matchValues = getExternalDirectoryPolicyValues(externalDirectoryPath, tcc.cwd);
const preCheck = resolver.resolvePathPolicy(
  matchValues,
  tcc.agentName ?? undefined,
  "external_directory",
);
const approvalPath = normalizePathForComparison(externalDirectoryPath, tcc.cwd);
// descriptor: input: {}, preCheck, sessionApproval: single(deriveApprovalPattern(approvalPath))
```

The gate gains a `resolver` parameter (mirroring `describePathGate`), threaded from `ToolCallGatePipeline.this.resolver`.
The runner consumes `descriptor.preCheck` and skips its own `resolve`, so `input` becomes `{}` (as the bash gate already does).
The session fast-path still works because `resolvePathPolicy` applies session rules via `getRuleset()`.

### Bash gate + `externalPaths` (extraction interaction check)

`BashProgram.externalPaths(cwd)` keeps computing the canonical form for the **boundary** check and the dedup identity, but **returns the lexical** (normalized, non-symlink-resolved) form:

```ts
// inside externalPaths, per accepted candidate:
const lexical = normalizePathForComparison(candidate, resolveBase);
const canonical = canonicalizePath(lexical);
if (canonical && normalizedCwd && !isSafeSystemPath(canonical)
    && !isPathWithinDirectory(canonical, normalizedCwd) && !seen.has(canonical)) {
  seen.add(canonical);      // dedup identity stays canonical
  externalPaths.push(lexical); // returned value is the typed form
}
```

`describeBashExternalDirectoryGate` then resolves each returned path through both aliases:

```ts
const check = resolver.resolvePathPolicy(
  getExternalDirectoryPolicyValues(p, tcc.cwd),
  tcc.agentName ?? undefined,
  "external_directory",
);
```

The `uncovered`/`pickMostRestrictive` logic is unchanged (config-level `deny` is still not downgraded to `ask`).
Approval patterns derive from the lexical path; display/message strings now show the typed path (`/tmp`) instead of `/private/tmp` — a UX improvement.
`externalPaths(): string[]` keeps its shape (only the value semantics change canonical → lexical), so the test-only facade `extractExternalPathsFromBashCommand` and its 29 test references are unaffected except where they assert a real symlinked path (none today, since `/tmp`-symlink behavior is platform-dependent and untested).

### Edge cases

- No symlink (Linux `/tmp`, or a non-existent path): `canonicalizePath` no-ops (ENOENT/ENOTDIR fall back to lexical), so the alias list dedups to one value — behavior identical to today.
- `EACCES`/`ELOOP` during `realpathSync`: `canonicalizePath` returns the lexical form; aliasing degrades to lexical-only, still matching the typed pattern.
- Contradictory config (`{ "/private/tmp/*": "deny", "/tmp/*": "allow" }`): last-match-wins picks `/tmp/*` allow (documented behavior); noted in Risks.
- Session dedup: approval pattern from the lexical path matches the lexical alias on subsequent requests (`external-directory-session-dedup` stays green).

## Module-Level Changes

- `src/path-utils.ts` — add `getExternalDirectoryPolicyValues(pathValue, cwd)`.
  No symbol removed.
- `src/permission-manager.ts` — add optional `surface` param (default `"path"`) to `ScopedPermissionManager.checkPathPolicy` (interface) and `PermissionManager.checkPathPolicy` (impl); thread it into `buildCheckResult`.
- `src/permission-resolver.ts` — add optional `surface` param (default `"path"`) to `ScopedPermissionResolver.resolvePathPolicy` (interface) and `PermissionResolver.resolvePathPolicy` (impl); pass through to `checkPathPolicy`.
  Update the doc comments (path → path-shaped surface).
- `src/handlers/gates/external-directory.ts` — add a `resolver: ScopedPermissionResolver` parameter; replace the `input: { path: normalizedExtPath }` matching with a precomputed `preCheck` via `resolver.resolvePathPolicy(getExternalDirectoryPolicyValues(...), …, "external_directory")`; set `input: {}`; keep the canonical path for the infra-read bypass; derive the approval pattern from the lexical normalized path.
- `src/handlers/gates/tool-call-gate-pipeline.ts` — update the `describeExternalDirectoryGate(...)` call to pass `this.resolver`.
- `src/handlers/gates/bash-program.ts` — `externalPaths` returns the lexical normalized path (dedup identity stays canonical; boundary check stays canonical).
- `src/handlers/gates/bash-external-directory.ts` — resolve each external path through `resolver.resolvePathPolicy(getExternalDirectoryPolicyValues(p, cwd), …, "external_directory")`; approval patterns from the lexical path.
- `test/helpers/handler-fixtures.ts` — route the `external_directory` surface in `makeHandler`'s dispatcher onto `checkPathPolicy` (mirroring `checkPermission`) so `makeSurfaceCheck`/`makeBashCommandCheck`-driven tests do not false-green (#393 class).
- `test/helpers/gate-fixtures.ts` — `makePathDispatchResolver`/`makeResolver` already stub `resolvePathPolicy`; confirm the `surface` argument is accepted (the stubs dispatch on `values`, ignoring `surface`, so they remain compatible).
  Add fixtures only if a gate unit test needs surface-aware dispatch.
- Docs and metadata:
  - `docs/architecture/architecture.md` — update the `external-directory.ts` and `bash-external-directory.ts` gate lines, the `bash-program.ts` `externalPaths` description (now returns the typed form, dedup by canonical), the `path-utils.ts` line (add `getExternalDirectoryPolicyValues`; reaffirm `canonicalNormalizePathForComparison` is containment-only), and the resolver-surface note (methods now take a `surface` param; count unchanged).
  - `.pi/skills/package-pi-permission-system/SKILL.md` — update the fixture notes (`checkPathPolicy` now covers path-shaped surfaces including `external_directory`; `makeHandler` routes `external_directory` through `checkPathPolicy`).
  - `docs/configuration.md` — add a short note in the `external_directory` section that patterns match both the path as written and its symlink-resolved form, with `/tmp/*` on macOS as the example.
  - `README.md` / `config/config.example.json` / `schemas/permissions.schema.json` — only if a worked example references symlinked paths; otherwise no change (the surface shape is unchanged).

Symbol-grep performed: no exported symbol is removed or renamed (`externalPaths` keeps its name and `string[]` shape; the resolver/manager methods only gain an optional trailing parameter).
The reworded mechanism (canonical → lexical return value of `externalPaths`; "matches resolved path" → "matches typed and resolved path") is searched in `docs/architecture/architecture.md` and `SKILL.md` and updated above.

## Test Impact Analysis

This is a bug fix with a small extraction (the policy-values helper), not a large refactor.

1. New tests enabled:
   - `path-utils.test.ts` — unit-test `getExternalDirectoryPolicyValues`: returns `[lexical, canonical]` for a real symlinked tmpdir, dedups when canonical equals lexical, and handles relative inputs.
   - `permission-manager` / `permission-resolver` tests — `checkPathPolicy`/`resolvePathPolicy` with `surface: "external_directory"` evaluate against the `external_directory` ruleset.
   - `bash-program.test.ts` — `externalPaths` returns the typed form for a symlinked candidate (deterministic via a created tmpdir symlink).
   - An end-to-end acceptance test (real tmpdir symlink) pinning the reported repro for both a path-bearing tool and a bash command.
2. Existing tests to update (not redundant, but assert the old behavior):
   - `handlers/gates/external-directory.test.ts` — the "input contains normalized path for checkPermission" test (the gate now uses `preCheck`, not `input.path`); add the resolver argument; assert allow for a symlinked `/tmp/*` config.
   - `handlers/gates/bash-external-directory.test.ts` — switch the resolver stub from `resolve` to `resolvePathPolicy`; assert both typed and resolved patterns match.
3. Tests that must stay as-is (genuinely exercise the boundary layer): the within-CWD / outside-CWD boundary tests in `path-utils.test.ts` and `bash-program.test.ts`, and `external-directory-session-dedup.test.ts`.

## Invariants at risk

- **#393 false-green** (stubbed-but-unrouted resolver method silently passing `allow`).
  Pinned by routing `external_directory` through `checkPathPolicy` in `makeHandler` and by the end-to-end acceptance test using real instances.
- **#352 extension/MCP path gating** (`Outcome:` extension and MCP tools are external-directory gated).
  Preserved — `getToolInputPath` extraction is unchanged; only the matching values change.
  Pinned by the existing `describeExternalDirectoryGate — extension and MCP tools (#352)` tests.
- **Boundary still fires / most-restrictive-wins** — the canonical boundary check is unchanged.
  Pinned by the existing outside-CWD tests.
- **Bash config-deny not downgraded to ask** (`pickMostRestrictive`).
  Preserved; pinned by the existing bash-external-directory deny tests.

## TDD Order

1. `refactor:` — generalize path-policy resolution with a `surface` parameter.
   Surface: `permission-manager` + `permission-resolver` unit tests.
   Red: `resolvePathPolicy(values, agent, "external_directory")` (and `checkPathPolicy(..., "external_directory")`) evaluate against an `external_directory` pattern map; default still resolves the `path` surface.
   Green: add the optional `surface` param to both interfaces and impls; thread into `buildCheckResult`.
   Commit: `refactor(pi-permission-system): generalize path-policy resolution to any path-shaped surface (#418)`.

2. `feat:` — add `getExternalDirectoryPolicyValues` helper.
   Surface: `path-utils.test.ts` (create a real symlink in a tmpdir for determinism).
   Red: returns the union of lexical aliases and the canonical absolute path; dedups when equal.
   Green: implement the helper.
   Commit: `feat(pi-permission-system): add external-directory typed+resolved policy aliases (#418)`.

3. `fix:` — bash external-directory gate matches typed and resolved paths.
   Surface: `bash-program.test.ts` + `handlers/gates/bash-external-directory.test.ts`.
   Red: with a symlinked external path, `externalPaths` returns the typed form; the gate allows for both a `/tmp/*` and a `/private/tmp/*` allow config and prompts for neither; a `/tmp/*` deny now denies.
   Green: `externalPaths` returns lexical (dedup by canonical); the gate resolves via `resolvePathPolicy(getExternalDirectoryPolicyValues(...), …, "external_directory")`; approval patterns from the lexical path.
   Commit: `fix(pi-permission-system): match bash external_directory patterns against typed and resolved paths (#418)`.

4. `fix:` — tool external-directory gate matches typed and resolved paths.
   Surface: `handlers/gates/external-directory.test.ts` + `tool-call-gate-pipeline` wiring.
   Red: with a symlinked path, a `/tmp/*` allow config resolves `allow` (no prompt); update the `input.path` assertion to the `preCheck` shape.
   Green: thread `resolver` into `describeExternalDirectoryGate`; use `preCheck` via `resolvePathPolicy(..., "external_directory")`; keep canonical for the infra-read bypass; derive approval from the lexical path; update the pipeline call site (same commit — the signature change breaks the call site).
   Also update `makeHandler` to route `external_directory` through `checkPathPolicy` (same commit — required to avoid the #393 false-green for the new tests).
   Commit: `fix(pi-permission-system): match external_directory tool patterns against typed and resolved paths (#418)`.

5. `test:` — end-to-end acceptance for the reported repro.
   Surface: `handlers/external-directory-integration.test.ts` (real instances via `makeHandler`/`createManager`, real tmpdir symlink outside CWD).
   Red→Green: with `external_directory: { "*": "ask", "<link>/*": "allow" }` where `<link>` is a symlink to a real external dir, both a path-bearing tool read and a bash `ls <link>` are allowed without forwarding/prompt.
   Commit: `test(pi-permission-system): pin symlinked external_directory allow acceptance (#418)`.

6. `docs:` — documentation and metadata alignment.
   Update `docs/architecture/architecture.md` (gate lines, `externalPaths`, `path-utils`, resolver-surface note), `.pi/skills/package-pi-permission-system/SKILL.md` (fixture/`makeHandler` notes), and `docs/configuration.md` (the typed+resolved matching note with the macOS `/tmp/*` example).
   Touch `README.md`/`config.example.json`/`schemas/permissions.schema.json` only if a symlink example is added.
   Commit: `docs(pi-permission-system): document external_directory symlink alias matching (#418)`.

## Risks and Mitigations

- Risk: a symlink could let a typed-form pattern bypass a resolved-form deny (or vice versa) because `evaluateAnyValue` is last-match-wins, not most-restrictive.
  Mitigation: the boundary still fires on the canonical path (the gate always runs), and the universal `*` default is `ask`, so an unmatched external path always prompts — never silently allows.
  The fix also closes today's hole where a symlinked **deny** silently fell through to `*`.
  Document the contradictory-config edge case.
- Risk: false-green from a stubbed-but-unrouted `checkPathPolicy` in `makeHandler` (#393 class).
  Mitigation: route `external_directory` through `checkPathPolicy` in `makeHandler` and add the real-instance acceptance test in step 5.
- Risk: changing `externalPaths` return value (canonical → lexical) churns the 29 test references.
  Mitigation: most references use non-existent synthetic paths where `canonicalizePath` no-ops (lexical == canonical), so they are unaffected; only symlink-specific assertions (none today) change.
- Risk: double `realpathSync` (once in `externalPaths` for the boundary, once in the gate via the helper).
  Mitigation: negligible (external paths per command are few); keeping `externalPaths(): string[]` avoids a 29-reference shape change.
- Risk: scope creep into the `path` surface or boundary semantics.
  Mitigation: Non-Goals fence the change to `external_directory` pattern matching only.

## Open Questions

- Should the bash external-directory **prompt/log message** display the typed path (`/tmp`) or the resolved path (`/private/tmp`)?
  This plan shows the typed form (clearer for the user, matches what they configured); defer to the build step if a reviewer prefers showing both.
- Should `docs/configuration.md` cross-reference the macOS `/tmp` → `/private/tmp` case explicitly, or keep the note surface-agnostic?
  Defer to the docs step; lean toward one concrete macOS example plus a general statement.
