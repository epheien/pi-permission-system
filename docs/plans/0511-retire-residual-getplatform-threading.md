---
issue: 511
issue_title: "pi-permission-system: retire the residual getPlatform() threading (infra-read + skill-prompt sanitization)"
---

# Retire the residual `getPlatform()` threading (infra-read + skill-prompt sanitization)

## Release Recommendation

**Release:** ship independently

This is the follow-up tracked in the architecture roadmap's "Residual `getPlatform()` threading (follow-up [#511])" subsection — not one of the five numbered Phase 7 steps and not a member of the `symlink-resistant-path-matching` batch.
It is a behavior-preserving refactor, so its commits are `refactor(pi-permission-system):` (a `hidden: true` changelog type): it does not cut a release on its own.
It lands on `main` and auto-batches into the next `feat:`/`fix:` release.

## Problem Statement

## 510 introduced `PathNormalizer` as the single home for platform-aware path interpretation and added `PermissionSession.getPlatform()` (backing `ToolCallGateInputs.getPlatform()`) as a temporary escape hatch for call sites that still call raw `path-utils` functions which are not `AccessPath` operations

Five such sites thread `platform` directly rather than through `PathNormalizer`.
Three fold away under Phase 7 (#502, #503/#504) and retire their `platform` thread as a side effect.
Two are not covered by any Phase 7 step and are this issue's scope:

1. **Infra-read containment** — `handlers/gates/external-directory.ts` calls `isPiInfrastructureRead(..., platform)` directly.
2. **Skill-prompt sanitization** — `skill-prompt-sanitizer.ts` (`createResolvedSkillEntry` → `normalizePathForComparison`, `findSkillPathMatch` → `isPathWithinDirectory`), reached from `before-agent-start.ts` and `handlers/gates/skill-read.ts`.

Routing both through the `PathNormalizer` the gates already hold removes their direct `platform` threading and moves the containment/normalization behavior onto the collaborator that already owns `cwd` + `platform`.

### Goals

- Route the external-directory infra-read containment check through `PathNormalizer` so `describeExternalDirectoryGate` no longer takes a `platform` parameter.
- Route skill-prompt sanitization (entry normalization, read-path normalization, base-dir containment) through `PathNormalizer` so `createResolvedSkillEntry`, `findSkillPathMatch`, `resolveSkillPromptEntries`, and `describeSkillReadGate` no longer take a `platform` parameter.
- Keep the change behavior-preserving — same decisions, same normalized values, no new filesystem access.

### Non-Goals

- **Removing `getPlatform()`.**
  `ToolCallGatePipeline.evaluate` reads `getPlatform()` once and threads it to three gates (skill-read, external-directory, tool); after this issue the tool gate (`describeToolGate`) still consumes it, so the pipeline read — and `PermissionSession.getPlatform()` / `ToolCallGateInputs.getPlatform()` — must stay until #502 also lands.
  That final removal is tracked in **#513** (fold into this issue only if #502 has already merged at implementation time).
- **The Phase 7 steps themselves** (#502, #503, #504, #505, #506) — they fold the other three reads and dissolve `path-utils.ts`; out of scope here.
- **Removing the leaf `platform` parameters in `path-utils.ts`** (`isPiInfrastructureRead`, `isPathWithinDirectory`, `normalizePathForComparison`).
  They persist as platform-parameterized predicates; this issue removes the *consumers'* direct `platform` threading, not the leaves.
- **Changing skill matching from lexical to canonical (symlink-resolved).**
  Skill matching is lexical today and stays lexical (see Design Overview).

### Background

Relevant modules and how they relate:

- `src/path-normalizer.ts` — the `PathNormalizer` class, constructed at the session edge with `platform` + `cwd` baked in.
  Today it exposes `forPath`/`forLiteral` (build `AccessPath`s), `isAbsolute`/`resolveBase`/`joinBase`, and `isWithinDirectory`/`isOutsideWorkingDirectory`.
  It already imports `isPathWithinDirectory`/`isPathOutsideWorkingDirectory` from `path-utils` and `AccessPath` from `access-intent/access-path`.
- `src/handlers/gates/external-directory.ts` — `describeExternalDirectoryGate(tcc, infraDirs, resolver, normalizer, platform, extractors)`.
  Already holds the `normalizer`; builds `accessPath = normalizer.forPath(externalDirectoryPath)` for the boundary decision and pattern matching, then computes `canonicalExtPath = accessPath.boundaryValue()` and calls `isPiInfrastructureRead(tcc.toolName, canonicalExtPath, infraDirs, tcc.cwd, platform)`.
- `src/skill-prompt-sanitizer.ts` — `createResolvedSkillEntry` normalizes `entry.location` and `dirname(entry.location)` via `normalizePathForComparison(_, cwd, platform)` (lexical only) and caches them as `normalizedLocation` / `normalizedBaseDir` strings on `SkillPromptEntry`; `findSkillPathMatch(normalizedPath, entries, platform)` does an exact-string match on `normalizedLocation` and an `isPathWithinDirectory(_, entry.normalizedBaseDir, platform)` match on the base dir; `resolveSkillPromptEntries(prompt, manager, agentName, cwd, platform)` drives both.
- `src/handlers/before-agent-start.ts` — calls `resolveSkillPromptEntries(..., ctx.cwd, this.session.getPlatform())`.
- `src/handlers/gates/skill-read.ts` — `describeSkillReadGate(tcc, platform, getActiveSkillEntries)` normalizes the read path via `normalizePathForComparison(path, tcc.cwd, platform)` then calls `findSkillPathMatch(normalizedReadPath, entries, platform)`.
- `src/handlers/gates/tool-call-gate-pipeline.ts` — `ToolCallGatePipeline.evaluate` builds `normalizer = getPathNormalizer()` and `platform = getPlatform()`, then threads `platform` into `describeSkillReadGate`, `describeExternalDirectoryGate`, and `describeToolGate`.

Constraint (`AGENTS.md` / `package-pi-permission-system` skill): no `src/` module may read `process.platform` (ESLint `no-restricted-syntax` guard, exempting `index.ts`); every leaf takes an injected `platform`.
This change does not add any `process.platform` read — it consolidates injected-`platform` reads onto `PathNormalizer`.

`tcc.cwd` is set from `ctx.cwd` in `permission-gate-handler.ts`, and `PathNormalizer` is rebuilt from `ctx.cwd` on `session.activate(ctx)` (called before every gate evaluate).
So the normalizer's baked `cwd` equals `tcc.cwd` and the `before-agent-start` `ctx.cwd` — confirming that moving the `cwd` argument onto the normalizer is behavior-preserving.

### Design Overview

#### Decision: route through `PathNormalizer` methods, do not carry `AccessPath`s on skill entries

The issue raises a fork for skill-prompt sanitization: carry `AccessPath`s on `SkillPromptEntry`, or resolve through the normalizer.
Carrying `AccessPath`s is rejected because `AccessPath.forPath` eagerly computes the canonical (symlink-resolved) alias via `canonicalNormalizePathForComparison` → `canonicalizePath` → `realpathSync` (`src/canonicalize-path.ts`).
Skill matching is purely **lexical** today (both sides use `normalizePathForComparison`, which never touches the filesystem).
Building an `AccessPath` per skill entry on every `before_agent_start` (every turn) and per read tool call would introduce repeated `realpathSync` filesystem access and switch matching toward canonical form — both behavior changes against a behavior-preserving refactor.
Instead, add a lexical normalize method to `PathNormalizer` and reuse its existing `isWithinDirectory`.

#### `PathNormalizer` gains two methods

```typescript
/** Lexical (not symlink-resolved) comparison value against the baked cwd. */
comparableValue(pathValue: string): string {
  return normalizePathForComparison(pathValue, this.cwd, this.platform);
}

/** Pi infrastructure-read containment against the baked cwd/platform. */
isInfrastructureRead(
  toolName: string,
  accessPath: AccessPath,
  infraDirs: readonly string[],
): boolean {
  return isPiInfrastructureRead(
    toolName,
    accessPath.boundaryValue(),
    infraDirs,
    this.cwd,
    this.platform,
  );
}
```

`comparableValue` returns a plain string (like `resolveBase`/`joinBase`), distinct from the `for*` methods that build `AccessPath`s — the lexical absolute form used for skill comparison.
`isInfrastructureRead` takes the **already-built** `AccessPath` (the gate constructs it for the boundary decision and pattern matching) and extracts `boundaryValue()` internally — Tell-Don't-Ask, and it avoids a second `forPath` (which would re-run `realpathSync`).
`PathNormalizer` adds imports for `normalizePathForComparison` and `isPiInfrastructureRead` from `path-utils` (it already imports the two containment predicates).

#### External-directory gate call site

```typescript
// before: isPiInfrastructureRead(tcc.toolName, accessPath.boundaryValue(), infraDirs, tcc.cwd, platform)
if (normalizer.isInfrastructureRead(tcc.toolName, accessPath, infraDirs)) {
  return { action: "allow", /* … infrastructure_auto_allowed … */ };
}
```

The `platform` parameter and the `isPiInfrastructureRead` + (now-unused) `canonicalExtPath` local are removed; the `getToolInputPath` import stays.
The `accessPath.boundaryValue()` comment about the canonical form moves into `PathNormalizer.isInfrastructureRead`.

#### Skill sanitizer call sites

```typescript
// createResolvedSkillEntry(entry, state, normalizer)
normalizedLocation: normalizer.comparableValue(entry.location),
normalizedBaseDir: normalizer.comparableValue(dirname(entry.location)),

// findSkillPathMatch(normalizedPath, entries, normalizer)
if (!entry.normalizedBaseDir || !normalizer.isWithinDirectory(normalizedPath, entry.normalizedBaseDir)) continue;

// describeSkillReadGate(tcc, normalizer, getActiveSkillEntries)
const normalizedReadPath = normalizer.comparableValue(path);
const matchedSkill = findSkillPathMatch(normalizedReadPath, activeSkillEntries, normalizer);
```

`SkillPromptEntry.normalizedLocation` / `normalizedBaseDir` stay `string` — only how they are computed changes.
`resolveSkillPromptEntries`, `createResolvedSkillEntry`, and `findSkillPathMatch` swap their `cwd`/`platform` parameters for a single `normalizer: PathNormalizer`.
`before-agent-start.ts` passes `this.session.getPathNormalizer()` instead of `ctx.cwd, this.session.getPlatform()`.

`skill-prompt-sanitizer.ts` drops its `normalizePathForComparison` and `isPathWithinDirectory` imports (replaced by normalizer calls) and adds a `PathNormalizer` type import.
`skill-read.ts` drops its `normalizePathForComparison` import.

#### Pipeline call sites

`ToolCallGatePipeline.evaluate` drops `platform` from the `describeSkillReadGate` and `describeExternalDirectoryGate` calls.
It keeps `const platform = this.inputs.getPlatform();` for `describeToolGate` (the #502 site), so `getPlatform()` is unchanged — see Non-Goals and #513.

#### Behavior-preservation argument

- Infra-read: `tcc.cwd === normalizer.cwd` and the platform passed today equals the normalizer's platform in production (both from the same composition-root injection), so `normalizer.isInfrastructureRead(toolName, accessPath, infraDirs)` computes the identical predicate.
- Skill: `normalizer.comparableValue(x) === normalizePathForComparison(x, normalizer.cwd, normalizer.platform)` by definition, and `normalizer.cwd`/`platform` equal the `cwd`/`platform` threaded today; `normalizer.isWithinDirectory(a, b) === isPathWithinDirectory(a, b, normalizer.platform)`.
  No filesystem access is introduced (lexical only).

### Module-Level Changes

- `src/path-normalizer.ts` — add `comparableValue(pathValue)` and `isInfrastructureRead(toolName, accessPath, infraDirs)`; add imports `normalizePathForComparison`, `isPiInfrastructureRead` from `#src/path-utils`.
- `src/handlers/gates/external-directory.ts` — remove the `platform: NodeJS.Platform` parameter; replace the direct `isPiInfrastructureRead(...)` call (and the `canonicalExtPath` local) with `normalizer.isInfrastructureRead(tcc.toolName, accessPath, infraDirs)`; drop the `isPiInfrastructureRead` import (keep `getToolInputPath`).
- `src/skill-prompt-sanitizer.ts` — `createResolvedSkillEntry`, `findSkillPathMatch`, `resolveSkillPromptEntries` swap `cwd`/`platform` params for `normalizer: PathNormalizer`; use `normalizer.comparableValue` / `normalizer.isWithinDirectory`; drop `normalizePathForComparison` + `isPathWithinDirectory` imports; add `PathNormalizer` type import.
- `src/handlers/gates/skill-read.ts` — `describeSkillReadGate` swaps `platform` param for `normalizer: PathNormalizer`; use `normalizer.comparableValue(path)` and pass `normalizer` to `findSkillPathMatch`; drop `normalizePathForComparison` import.
- `src/handlers/before-agent-start.ts` — pass `this.session.getPathNormalizer()` to `resolveSkillPromptEntries` (replacing `ctx.cwd, this.session.getPlatform()`).
- `src/handlers/gates/tool-call-gate-pipeline.ts` — drop `platform` from the `describeSkillReadGate` and `describeExternalDirectoryGate` calls; keep the `getPlatform()` read for `describeToolGate`.

Tests:

- `test/handlers/gates/external-directory.test.ts` — `gateUnderTest` drops the `"linux"` platform arg.
- `test/handlers/gates/skill-read.test.ts` — pass a `PathNormalizer` (e.g. `new PathNormalizer("linux", tcc.cwd)`) instead of `"linux"`.
- `test/skill-prompt-sanitizer.test.ts` — pass `new PathNormalizer("linux", CWD)` instead of `CWD, "linux"` to `resolveSkillPromptEntries` and `findSkillPathMatch`.
- `test/path-normalizer.test.ts` — add coverage for `comparableValue` (lexical, no FS) and `isInfrastructureRead` (read-only tool in/out of infra dirs; write tool not bypassed), posix and win32 flavors.

Docs:

- `docs/architecture/architecture.md` — extend the `path-normalizer.ts` method list (line ~676) with `comparableValue` and `isInfrastructureRead`; update the "Residual `getPlatform()` threading (follow-up [#511])" subsection so the infra-read and skill-sanitizer bullets read as *routed through `PathNormalizer`* (done), leaving only the three Phase 7-step reads outstanding, and note that the `getPlatform()` accessor itself persists until #502 (tracked in #513).
- `.pi/skills/package-pi-permission-system/SKILL.md` — add `comparableValue`/`isInfrastructureRead` to the normalizer method list in the Debugging section (line ~175).

No README change: this is internal threading, not a user-facing command or feature.

### Test Impact Analysis

1. **New tests enabled.**
   `comparableValue` and `isInfrastructureRead` become directly unit-testable on `PathNormalizer` (with the baked `cwd`/`platform`), instead of only through the gate.
   `isInfrastructureRead` gets focused coverage (read-only tool inside an infra dir → true; write tool inside → false; outside → false) on both platform flavors via injected `PathNormalizer`.
2. **Redundant tests.**
   None become redundant — the existing gate-level and `pi-infrastructure-read.test.ts` tests still exercise the predicate through the full path and remain valuable as integration coverage.
   The leaf `isPiInfrastructureRead`/`normalizePathForComparison`/`isPathWithinDirectory` tests in `test/path-utils.test.ts` and `test/pi-infrastructure-read.test.ts` stay as-is (the leaves are unchanged).
3. **Tests that must stay.**
   `external-directory.test.ts`, `skill-read.test.ts`, and `skill-prompt-sanitizer.test.ts` continue to exercise the gates/sanitizer end-to-end; they only shed the `platform` argument in favor of a `PathNormalizer`.

### Invariants at risk

The #510 seam (the precursor refactor) established that no interior `src/` module reads `process.platform` and that `PathNormalizer` is the single platform home.
This change preserves both — it consolidates injected-`platform` reads onto `PathNormalizer` and adds no `process.platform` read (the ESLint `no-restricted-syntax` guard pins this; `pnpm run lint` fails on a violation).
The #418/#486 external-directory matching invariant (config patterns match the typed and symlink-resolved aliases) is untouched: the `accessPath`/`matchValues()`/`boundaryValue()` usage in the gate is unchanged — only the infra-read call moves onto the normalizer.
`external-directory.test.ts`'s "resolves the typed and symlink-resolved aliases (#418)" test and the infra-bypass tests pin these.

### TDD Order

Each cycle is behavior-preserving; suggested commit type `refactor:` (with `test:` where a step is test-only).
Because removing the `platform` parameter from an exported function breaks every caller and its tests at the type level in the same commit, each site's production change, its call-site updates, and its test updates land together.

1. **Add `PathNormalizer.comparableValue` + `isInfrastructureRead`.**
   Surface: `test/path-normalizer.test.ts`.
   Red: assert `comparableValue` returns the lexical absolute form (posix + win32, no FS) and `isInfrastructureRead` matches `isPiInfrastructureRead` for read-only-in-infra (true), write-in-infra (false), outside (false).
   Green: add both methods + imports.
   Commit: `refactor(pi-permission-system): add PathNormalizer comparableValue + isInfrastructureRead`.

2. **Route the external-directory infra-read through `PathNormalizer`.**
   Surface: `src/handlers/gates/external-directory.ts`, `src/handlers/gates/tool-call-gate-pipeline.ts` (call site), `test/handlers/gates/external-directory.test.ts`.
   Red/Green: drop the `platform` parameter; call `normalizer.isInfrastructureRead(tcc.toolName, accessPath, infraDirs)`; update the pipeline call and `gateUnderTest` (drop `"linux"`).
   Commit: `refactor(pi-permission-system): route external-directory infra-read through PathNormalizer`.

3. **Route skill-prompt sanitization through `PathNormalizer`.**
   Surface: `src/skill-prompt-sanitizer.ts`, `src/handlers/gates/skill-read.ts`, `src/handlers/before-agent-start.ts`, `src/handlers/gates/tool-call-gate-pipeline.ts` (skill-read call site), `test/skill-prompt-sanitizer.test.ts`, `test/handlers/gates/skill-read.test.ts`.
   Red/Green: swap `cwd`/`platform` params for `normalizer` across `createResolvedSkillEntry`/`findSkillPathMatch`/`resolveSkillPromptEntries`/`describeSkillReadGate`; use `comparableValue`/`isWithinDirectory`; pass the normalizer from `before-agent-start` and the pipeline; migrate tests to construct a `PathNormalizer`.
   Commit: `refactor(pi-permission-system): route skill-prompt sanitization through PathNormalizer`.

4. **Docs.**
   Surface: `docs/architecture/architecture.md`, `.pi/skills/package-pi-permission-system/SKILL.md`.
   Update the normalizer method lists and the residual-threading subsection (infra-read + skill routed through `PathNormalizer`; `getPlatform()` persists until #502, tracked in #513).
   Commit: `docs(pi-permission-system): record PathNormalizer infra-read/comparable-value routing`.

### Risks and Mitigations

- **Risk: introducing filesystem access via `AccessPath` in the skill path.**
  Mitigation: use the lexical `comparableValue` (no `realpathSync`), not `forPath`; verified in step 1's test (default identity `realpathSync` mock + lexical assertions).
- **Risk: a `cwd`/`platform` mismatch between the threaded values and the normalizer's baked values changing a decision.**
  Mitigation: confirmed `tcc.cwd === ctx.cwd === normalizer.cwd` and a single composition-root `platform` injection; the existing gate/sanitizer tests pin the decisions.
- **Risk: a dropped edit in a multi-site `Edit` batch silently leaving a stale `platform` arg.**
  Mitigation: each step removes a parameter, so `tsc` (`pnpm run check`) fails immediately on any missed caller; run it per step.
- **Risk: stale docs/skill prose referencing the old threading.**
  Mitigation: step 4 updates `architecture.md` and the package SKILL; the pre-completion reviewer greps for residual references.

### Open Questions

- **Final `getPlatform()` removal** — deferred to #513 (depends on #502 also landing).
  If #502 has already merged when this issue is implemented, fold the `getPlatform()` removal into step 3 and close #513.
