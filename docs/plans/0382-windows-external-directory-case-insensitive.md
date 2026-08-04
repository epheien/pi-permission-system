---
issue: 382
issue_title: "pi-permission-system: external_directory base permission doesn't auto-detect or allow overrides for pi docs directory when installed via npm on Windows"
---

# Windows: case-insensitive `external_directory` matching and Pi-install auto-detect

## Problem Statement

On Windows, a base (null) agent cannot read Pi's own docs even with an explicit `external_directory` allow override, and the built-in infrastructure auto-allow never fires either.
The reporter's config denies all external directories (`external_directory["*"]: "deny"`) but allows the Pi install path (`~/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/*: "allow"`); every `read`/`find`/`grep` against Pi's docs is still denied by the `external_directory` policy, contradicting the documented last-match-wins semantics.

The root cause is a Windows-only path-comparison asymmetry.
The path under test is canonicalized **and lowercased** on `win32` (`normalizePathForComparison` / `canonicalNormalizePathForComparison`), but the other side of every comparison keeps native case:

- Infrastructure-read containment (`isPathWithinDirectory`) uses a case-sensitive `startsWith`, so Pi's install dir under the discovered `node_modules` root (or `agentDir`) never matches the lowercased path — the auto-allow silently fails.
- `external_directory` / `path` config patterns compile to case-sensitive regexes (`compileWildcardPattern`), so the user's mixed-case `~/AppData/...` allow pattern never matches the lowercased value and the policy falls through to `*: "deny"` — the override is silently ignored.

Windows filesystems are case-insensitive, so both comparisons should fold case.
Separately, the existing auto-discovery finds the directory where the **extension** is installed, which need not contain Pi's docs; Pi exposes its own install location and we should use it.

## Goals

- On Windows, match `external_directory` / `path` / path-bearing-tool patterns case-insensitively (and separator-agnostically) so explicit allow/deny overrides work as documented.
- On Windows, make the Pi infrastructure-read auto-allow case-insensitive so Pi's own files are auto-allowed for read-only tools.
- Adopt Node's platform-native containment idiom (`path.relative`) for the path-containment checks in `path-utils.ts`, matching how Pi itself decides containment (`getCwdRelativePath`).
- Auto-detect Pi's install directory via the coding-agent public API (`getPackageDir()`) and add it to the read-only infrastructure dirs, so Pi docs are auto-allowed regardless of install layout.
- Keep POSIX behavior byte-for-byte unchanged.

Compatibility note (not a runtime breaking change): the coding-agent peer-dependency floor rises from `>=0.75.0` to `>=0.79.0` because `getPackageDir()` is only re-exported from the package entry point as of v0.79.0.
Runtime behavior, config shape, and defaults are unchanged on upgrade; this is a `fix:`, not a `feat!:`/`fix!:`.

## Non-Goals

- Removing the existing `win32` lowercasing in `normalizePathForComparison`.
  After this change it is redundant for matching (the regex `i` flag and `path.relative` both fold case), but removing it widens the blast radius into `skill-prompt-sanitizer` and `bash-program`; defer it.
- Dissolving the duplicate containment helper in `subagent-context.ts` (`isPathWithinDirectoryForSubagent`) into the shared `path-utils` helper.
  It serves a different concern (subagent detection) and is not implicated in this bug; track as a follow-up.
- Switching the wildcard engine to `path.matchesGlob`.
  Its `*` does not cross separators and it is case-sensitive even on `win32`, so it would change the established `*`→`.*` semantics and not fix the case bug.
- Changing the `bash`, `skill`, or `mcp` matching surfaces — only path surfaces fold case.

## Background

Relevant modules and how they relate:

- `src/path-utils.ts` — `normalizePathForComparison` (resolve + normalize + lowercase on `win32`), `canonicalNormalizePathForComparison` (adds `realpathSync`), `isPathWithinDirectory` (case-sensitive `startsWith`), `isPathOutsideWorkingDirectory`, and `isPiInfrastructureRead` (the read-only auto-allow).
- `src/handlers/gates/external-directory.ts` — builds the `external_directory` descriptor with `input.path = canonicalNormalizePathForComparison(...)` (lowercased on `win32`) and short-circuits to allow when `isPiInfrastructureRead` returns true.
- `src/wildcard-matcher.ts` — `compileWildcardPattern` (home-expands, then builds a case-sensitive `RegExp`) and `wildcardMatch`.
- `src/rule.ts` — `evaluate(surface, value, rules)` calls `wildcardMatch(r.pattern, value)`; this is the single surface-aware matching point.
- `src/extension-paths.ts` — `computeExtensionPaths(agentDir)` builds `piInfrastructureDirs = [agentDir, agentDir/git, globalNodeModulesRoot?]`.
- `src/node-modules-discovery.ts` — `discoverGlobalNodeModulesRoot()` walks up from the **extension's** `import.meta.url`; falls back to `npm root -g`.
- `src/index.ts` — composition root; already imports `getAgentDir` from `@earendil-works/pi-coding-agent` and calls `computeExtensionPaths(agentDir)`.

How Node and Pi handle this (verified):

- `path.win32.relative('C:\\Users\\FOO\\dir', 'c:\\users\\foo\\dir\\sub\\x.md')` → `'sub\\x.md'`; the `win32` implementation folds case natively, and an outside path yields a `..`-prefixed result.
- Pi's own containment idiom (`packages/coding-agent/src/utils/paths.ts` `getCwdRelativePath`, and `core/tools/read.ts` `getPiDocsClassification`) is `relative(dir, target)` plus a `..`/absolute-prefix check, with **no** manual lowercasing.
- Pi locates its own files via `getPackageDir()` / `getDocsPath()` (walk up from `__dirname` to `package.json`, honoring `PI_PACKAGE_DIR`); these are re-exported from the package entry as of v0.79.0 (commit `eb43bd44`, first released in `v0.79.0`; the reporter runs `0.79.1`).

Constraints from AGENTS.md that apply:

- Keep Pi SDK imports at the composition root — `getPackageDir()` is imported in `index.ts` and the value is passed into `computeExtensionPaths`; `path-utils.ts` / `extension-paths.ts` stay SDK-independent.
- Do not read `process.platform` inside library functions where avoidable — thread it as a defaulted parameter so tests can simulate `win32` on a POSIX CI (stubbing `process.platform` does not switch Node's `path` implementation).
- Keep schema, example config, `docs/configuration.md`, `README.md`, and types aligned.
- A `package.json` dependency change requires `pnpm install` and the updated `pnpm-lock.yaml` in the same commit (CI uses `--frozen-lockfile`).
- `permission["*"]` last-match-wins ordering and wildcard explicitness must stay tested — silent over-match is a permission bypass.

## Design Overview

Two comparison sites fail on `win32`; each gets a targeted, platform-correct fix.

### 1. Containment — adopt `path.relative` (Pi's idiom)

Rewrite `isPathWithinDirectory` to use the platform-native `relative()` instead of a hand-rolled lowercase-one-side `startsWith`.
Select the path flavor explicitly so tests can simulate Windows:

```typescript
import { win32 as winPath, posix as posixPath } from "node:path";

export function isPathWithinDirectory(
  child: string,
  parent: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!child || !parent) return false;
  const impl = platform === "win32" ? winPath : posixPath;
  if (child === parent) return true;
  const rel = impl.relative(parent, child);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${impl.sep}`) &&
    !impl.isAbsolute(rel)
  );
}
```

`isPathOutsideWorkingDirectory(pathValue, cwd, platform = process.platform)` and `isPiInfrastructureRead(..., platform = process.platform)` thread `platform` into the containment call.
On `win32`, `winPath.relative` folds case, so a lowercased value matches a mixed-case infra dir.

Call-site interaction (verify no Tell-Don't-Ask / output-arg regression): `isPiInfrastructureRead` only *reads* its inputs and returns a boolean; the new `platform` parameter is a defaulted scalar, not a dependency bag.
The project-local branches (`join(cwd, ".pi", "npm" | "git")`) reuse the same `isPathWithinDirectory(..., platform)` and therefore become case-correct too.

### 2. Glob pattern matching — fold case and separators for path surfaces

Add optional matching behavior, off by default (pure addition, no call-site breakage):

```typescript
interface WildcardMatchOptions {
  caseInsensitive?: boolean; // adds the "i" RegExp flag
  windowsSeparators?: boolean; // normalizes "/" → "\" in the expanded pattern
}
export function compileWildcardPattern<TState>(
  pattern: string,
  state: TState,
  options?: WildcardMatchOptions,
): CompiledWildcardPattern<TState>;
export function wildcardMatch(
  pattern: string,
  value: string,
  options?: WildcardMatchOptions,
): boolean;
```

`evaluate` is the single surface-aware site; it gains a defaulted `platform` and folds only the **pattern→value** match for path surfaces (the surface→surface match stays exact):

```typescript
const PATH_SURFACES = new Set([
  ...PATH_BEARING_TOOLS, // read, write, edit, find, grep, ls
  "external_directory",
  "path",
]);

export function evaluate(
  surface: string,
  value: string,
  rules: Ruleset,
  defaultAction?: PermissionState,
  platform: NodeJS.Platform = process.platform,
): Rule {
  const win = platform === "win32" && PATH_SURFACES.has(surface);
  const opts = win
    ? { caseInsensitive: true, windowsSeparators: true }
    : undefined;
  const rule = rules.findLast(
    (r) =>
      wildcardMatch(r.surface, surface) &&
      wildcardMatch(r.pattern, value, opts),
  );
  // …unchanged fallback…
}
```

`PATH_SURFACES` is exported from `path-utils.ts` (where `PATH_BEARING_TOOLS` already lives) and imported by `rule.ts` (no import cycle: `path-utils` does not import `rule`).

Why this fixes the reporter's case: the gate hands `evaluate` a lowercased, backslash value; the allow pattern `~/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/*` home-expands (via `join`) to a mixed-case backslash absolute path; with `caseInsensitive` it now matches and, being last in config order, wins over `*: "deny"`.
`windowsSeparators` additionally rescues forward-slash absolute patterns (e.g. `C:/Users/.../*`) that never pass through `join`.

`isPiInfrastructureRead`'s glob-dir branch (`wildcardMatch(dir, normalizedPath)`, added in [#122]) passes the same `{ caseInsensitive, windowsSeparators }` on `win32`.

### 3. Auto-detect Pi's install directory

`computeExtensionPaths` accepts an optional `piPackageDir` and adds it to `piInfrastructureDirs` when non-empty:

```typescript
export function computeExtensionPaths(
  agentDir: string,
  piPackageDir?: string,
): ExtensionPaths {
  // …existing…
  const piInfrastructureDirs: string[] = [
    agentDir,
    join(agentDir, "git"),
    ...(globalNodeModulesRoot ? [globalNodeModulesRoot] : []),
    ...(piPackageDir ? [piPackageDir] : []),
  ];
  // …
}
```

`index.ts` wires it from Pi's public API (composition root keeps the SDK import):

```typescript
import { getAgentDir, getPackageDir } from "@earendil-works/pi-coding-agent";
// …
const paths = computeExtensionPaths(getAgentDir(), getPackageDir());
```

`getPackageDir()` always returns a non-empty string (walks up to `package.json`, falls back to `__dirname`, honors `PI_PACKAGE_DIR`), so the guard is belt-and-suspenders.
Because `getInfrastructureReadDirs()` (in `permission-session.ts`) already unions `piInfrastructureDirs` with config `piInfrastructureReadPaths`, the new entry flows through without further wiring.
This entry is strictly narrower than the `node_modules` root already auto-allowed for reads, and read-only tools only.

### Edge cases

- POSIX: `platform` defaults to `process.platform`; on non-`win32`, `opts` is `undefined` and `isPathWithinDirectory` uses `posixPath` — identical to today.
- Pin/UNC/drive-relative oddities are delegated to Node's `path.win32` rather than re-implemented.
- A file target as an infra dir (not applicable here — `getPackageDir()` is a directory) would still work via `relative`, but we add the directory, not individual files.

## Module-Level Changes

- `src/path-utils.ts`
  - Rewrite `isPathWithinDirectory(child, parent, platform = process.platform)` to use `path.win32`/`path.posix` `relative()` + `..`/absolute check.
  - Thread `platform` through `isPathOutsideWorkingDirectory` and `isPiInfrastructureRead`; pass `{ caseInsensitive, windowsSeparators }` to the glob-dir `wildcardMatch` on `win32`.
  - Add and export `PATH_SURFACES` (`PATH_BEARING_TOOLS` ∪ `{ "external_directory", "path" }`).
- `src/wildcard-matcher.ts`
  - Add `WildcardMatchOptions` and the optional `options` parameter to `compileWildcardPattern` and `wildcardMatch`; apply the `"i"` flag and `/`→`\` separator normalization on the expanded pattern.
- `src/rule.ts`
  - Add the defaulted `platform` parameter to `evaluate`; fold the pattern match for `PATH_SURFACES` on `win32`.
    Import `PATH_SURFACES` from `path-utils`.
- `src/extension-paths.ts`
  - Add optional `piPackageDir` parameter to `computeExtensionPaths`; append to `piInfrastructureDirs`.
    Update the `ExtensionPaths` / `computeExtensionPaths` doc comment.
- `src/index.ts`
  - Import `getPackageDir`; pass `getPackageDir()` to `computeExtensionPaths`.
- `package.json`
  - Bump peer `@earendil-works/pi-coding-agent` to `>=0.79.0`; bump devDependency to `0.79.1`.
    Bump `@earendil-works/pi-tui` only if `pnpm install` reports a peer mismatch.
    Run `pnpm install`, commit `pnpm-lock.yaml`.
- Docs
  - `docs/configuration.md` — add Pi's install directory to the infrastructure list; add a "Windows path matching is case-insensitive" note under the `external_directory` / Home Directory Expansion sections.
  - `schemas/permissions.schema.json` — update the `piInfrastructureReadPaths` `markdownDescription` (mention Pi's package dir auto-discovery and `win32` case-insensitivity).
  - `docs/architecture/architecture.md` — refresh the `path-utils.ts` and `extension-paths.ts` line descriptions (lines ~538/545) to mention `path.relative` containment and `piPackageDir`.
  - `README.md` — no change required (does not enumerate infra dirs); confirm during the docs step.

Files in Module-Level Changes do not appear in Non-Goals; the two `path-utils` items (containment rewrite vs. lowercasing) are distinct concerns.

## Test Impact Analysis

This is primarily a bug fix; the only refactor is `isPathWithinDirectory`.

1. New tests enabled
   - `path-utils.test.ts`: `isPathWithinDirectory(child, parent, "win32")` is now directly testable for case-insensitive containment on a POSIX CI by injecting the platform and `C:\…` paths — previously impossible because the function read `process.platform` implicitly and lowercased only one side.
   - `wildcard-matcher.test.ts`: `caseInsensitive` and `windowsSeparators` options.
   - `rule.test.ts`: surface-scoped case folding (path surfaces fold on `win32`; `bash`/`skill` stay exact).
   - `extension-paths.test.ts`: `piPackageDir` inclusion.
2. Tests that become redundant — none.
   The existing POSIX assertions for `isPathWithinDirectory` / `isPiInfrastructureRead` keep their meaning (default `platform` → POSIX path) and act as regression guards.
3. Tests that must stay as-is
   - The POSIX `pi-infrastructure-read.test.ts` and `path-utils.test.ts` cases continue to exercise the default-platform path and must remain green unchanged.

## TDD Order

1. `fix` — containment via `path.relative` in `path-utils.ts`.
   Test surface: `test/path-utils.test.ts`.
   Red: `isPathWithinDirectory` with `platform: "win32"` returns true for case-different child/parent and false for a sibling/`..` path; `platform: "linux"` stays case-sensitive; `isPathOutsideWorkingDirectory` honors the injected platform.
   Green: rewrite using `win32`/`posix` `relative()`; thread `platform` (defaulted) through `isPathOutsideWorkingDirectory`.
   Run `pnpm run check` (signature change with defaults — no call-site edits required).
   Commit: `fix(pi-permission-system): make path containment case-insensitive on Windows via path.relative`.

2. `fix` — infrastructure-read auto-allow folds case on Windows.
   Test surface: `test/pi-infrastructure-read.test.ts` (and `test/path-utils.test.ts`).
   Red: with `platform: "win32"`, a lowercased path inside a mixed-case infra dir is allowed; a `win32` glob infra dir matches case-insensitively; POSIX cases unchanged.
   Green: thread `platform` into `isPiInfrastructureRead`; pass `{ caseInsensitive, windowsSeparators }` to the glob-dir `wildcardMatch`; export `PATH_SURFACES`.
   Commit: `fix(pi-permission-system): auto-allow infrastructure reads case-insensitively on Windows`.

3. `fix` — case-insensitive, separator-normalized path-surface pattern matching.
   Test surface: `test/wildcard-matcher.test.ts`, then `test/rule.test.ts`, then `test/handlers/gates/external-directory.test.ts`.
   Red A: `compileWildcardPattern` / `wildcardMatch` with `caseInsensitive` match mixed-case input; `windowsSeparators` make a `/`-pattern match a `\`-value.
   Green A: add `WildcardMatchOptions` and apply the flag + separator normalization.
   Red B: `evaluate("external_directory", <lowercased win path>, rules, undefined, "win32")` selects a mixed-case `~`-expanded allow rule over a preceding `*: deny` (last-match-wins); the same surfaces stay exact under `platform: "linux"`; `bash`/`skill` stay case-sensitive on `win32`.
   Green B: add the defaulted `platform` to `evaluate`; fold the pattern match for `PATH_SURFACES`.
   Red C (integration): the external-directory gate allows a read of a mixed-case Pi-install path under a `win32` allow override.
   Green C: covered by A+B (no new production code expected).
   Run `pnpm run check`.
   Commit: `fix(pi-permission-system): match external_directory/path patterns case-insensitively on Windows`.

4. `fix` — add optional `piPackageDir` to `computeExtensionPaths`.
   Test surface: `test/extension-paths.test.ts`.
   Red: `computeExtensionPaths(agentDir, "/pi/install")` includes `/pi/install` in `piInfrastructureDirs`; omitting it preserves the current list.
   Green: add the parameter and append guarded.
   Commit: `fix(pi-permission-system): include an optional Pi package dir in infrastructure reads`.

5. `fix` — bump the coding-agent dependency and wire `getPackageDir()`.
   Test surface: `test/composition-root.test.ts` (smoke), real `@earendil-works/pi-coding-agent`.
   Steps: bump peer to `>=0.79.0` and devDependency to `0.79.1` (and `@earendil-works/pi-tui` if `pnpm install` flags a peer mismatch); run `pnpm install`; update `index.ts` to import and pass `getPackageDir()`.
   This step must carry the dependency bump and the `index.ts` import together — the import only type-checks once the floor moves to v0.79.x (the installed `0.75.4` does not re-export `getPackageDir`).
   Commit (single, with `pnpm-lock.yaml`): `fix(pi-permission-system): auto-detect Pi's install directory for infrastructure reads (#382)`.

6. `docs` — align documentation and schema.
   Update `docs/configuration.md`, `schemas/permissions.schema.json`, and `docs/architecture/architecture.md` (and confirm `README.md` needs nothing).
   Commit: `docs(pi-permission-system): document Windows case-insensitive matching and Pi-install auto-allow`.

## Risks and Mitigations

- Peer-floor bump excludes Pi `<0.79.0`.
  Mitigation: pi-permission-system tracks Pi closely via peers; the reporter is on `0.79.1`; call it out in the changelog-facing commit body and `Goals`.
  Not a runtime breaking change.
- Simulating `win32` on a POSIX CI: stubbing `process.platform` does **not** switch Node's top-level `path` functions to `win32`.
  Mitigation: the production code selects `path.win32`/`path.posix` from an injected `platform`, and tests pass `"win32"` plus `C:\…`-style absolute paths.
- `getPackageDir()` resolution under jiti per-extension isolation could differ from expectations or (in exotic setups) point at an unexpected dir.
  Mitigation: it is additive (does not remove the existing `node_modules` discovery), read-only, and guarded for non-empty; `PI_PACKAGE_DIR` provides an escape hatch.
- Bumping the coding-agent devDependency may force a matching `@earendil-works/pi-tui` bump for peer consistency.
  Mitigation: run `pnpm install` and bump `pi-tui` in lockstep only if peer resolution complains; keep both in the same commit as the lockfile.
- Folding case could make a `deny` pattern match more paths on Windows.
  Mitigation: this is the correct semantics for a case-insensitive filesystem and is Windows-only; covered by explicit over-match tests.

## Open Questions

- Should the redundant `win32` lowercasing in `normalizePathForComparison` be removed in a follow-up now that matching folds case independently?
  (Deferred — non-goal.)
- Should `subagent-context.ts`'s `isPathWithinDirectoryForSubagent` be dissolved into the shared `path-utils` containment helper?
  (Deferred — separate concern.)

[#122]: https://github.com/gotgenes/pi-packages/issues/122
