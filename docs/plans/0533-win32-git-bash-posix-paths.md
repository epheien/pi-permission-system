---
issue: 533
issue_title: 'Windows/Git Bash: POSIX paths like /dev/null and /tmp are normalized as C:\dev\null / C:\tmp'
---

# Interpret POSIX-shaped bash tokens with Git Bash semantics on win32

## Release Recommendation

**Release:** ship independently

This issue is not part of any architecture-roadmap phase (no `Release:` tag references it), and the change is a user-facing `fix:` for Windows Git Bash users, so it cuts its own release.

## Problem Statement

On Windows, the permission system normalizes every bash path token with `node:path.win32` semantics.
POSIX-shaped absolute tokens — which Git Bash interprets through its MSYS mount table — are thereby reinterpreted as native Windows paths the shell will never touch:

- `/dev/null` becomes `c:\dev\null`, so `isSafeSystemPath()` never matches and `echo hi > /dev/null` triggers an `external_directory` prompt.
- `/tmp` becomes `C:\tmp`, so prompts display a misleading path, and a user rule for the real `C:\tmp\*` directory can wrongly match Git Bash `/tmp` tokens (which actually point at `%TEMP%` under Git Bash).
- `/c/Users/x` becomes `C:\c\Users\x`, so a project file referenced through the MSYS drive mount is wrongly flagged external.

This contradicts the package's own documented contract (`docs/configuration.md`: "OS device paths (`/dev/null`, …) are always excluded"), so the change is a `fix:`, not a behavior redesign.
The issue was filed by an external contributor (`ThreeIce`); the operator confirmed the direction via the planning-session decision gate.

## Goals

- On win32, recognize the four safe device paths (`/dev/null`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr`) in bash commands so they never trigger `external_directory` prompts — matching the existing POSIX behavior and the documented contract.
- On win32, translate MSYS drive-mount bash tokens (`/c/…`, `/d/…`) to their Windows equivalents (`C:\…`) so containment and rule matching operate on the path Git Bash will actually access.
- On win32, treat all other POSIX-absolute bash tokens (`/tmp/foo`, `/usr/bin`) as literal-only external paths: always outside the working directory, matched and displayed exactly as typed, never fabricated into `C:\tmp\foo`.
- Keep `cd`-folding coherent with the same semantics: `cd /c/x` folds to a translated known base; `cd /tmp` folds to the conservative unknown base.
- Zero behavior change on POSIX platforms, and zero behavior change for tool-input paths (`read`/`write`/`edit`) on any platform.
- Not breaking: behavior changes only on win32 where the current behavior contradicts the documented safe-path contract and MSYS shell semantics.

## Non-Goals

- No `cygpath` shell-outs and no Git Bash/MSYS environment detection — resolution must stay deterministic (same policy + same input → same decision), and the permission system cannot know which bash Pi core resolved.
- No resolution of `/tmp` to `%TEMP%`/`os.tmpdir()` — the target varies by bash flavor (Git Bash mounts `/tmp` to `%TEMP%`; MSYS2 mounts it to `<msysroot>\tmp`; Cygwin to its own root), so any concrete mapping would be wrong for some installs.
- No MSYS install-root resolution for `/usr`, `/etc`, `/mingw64` — literal-only external handling covers them conservatively.
- No UNC (`//server/share`) special-casing — such tokens fall into the literal-only external branch, which is conservative-correct.
- No POSIX-token translation for tool-input paths on win32: Node's `fs` (which the built-in tools use) genuinely resolves `/dev/null` to `C:\dev\null` on Windows, so the current prompt for a tool-input `/dev/null` is correct and must stay (least privilege).
- No change to `NUL`-token handling — Pi core already rewrites `> NUL` to `> /dev/null` before spawning Git Bash (`normalizeNulRedirects()`, pi#4751).
- No parity change for `PermissionsService` RPC path queries: an external query for a POSIX-shaped path on win32 still answers with win32 semantics (a path query carries no bash-surface context); accepted inconsistency, revisit only if a consumer reports it.
- No WSL considerations — WSL bash runs in a Linux environment with a Linux Pi process; this plan is about Git Bash/MSYS on a win32 host.

## Background

Research findings that drive the design:

1. **Pi core always executes bash through Git Bash on Windows.**
   `pi/packages/coding-agent/src/utils/shell.ts` resolves the shell on win32 as custom `shellPath` → `%ProgramFiles%\Git\bin\bash.exe` → any `bash.exe` on PATH (MSYS2/Cygwin); there is no cmd/PowerShell branch.
   So every bash command this package gates on Windows runs with POSIX/MSYS path semantics.
2. **Pi core has committed to `/dev/null` as the canonical device-redirect form on win32.**
   Because MSYS does not recognize `NUL`, core's `normalizeNulRedirects()` (pi#4731 / pi#4751) rewrites `> NUL` → `> /dev/null` before spawning the shell — core actively produces the exact token this package currently mangles.
3. **MSYS mount semantics** for the shapes in question: `/dev/*` are runtime devices (never filesystem paths); `/c/…` is a deterministic drive mount (`C:\…`); `/tmp` and other POSIX absolutes resolve inside install-dependent mounts that this package cannot know deterministically.

Relevant existing modules:

- `src/access-intent/bash/bash-path-resolver.ts` — `BashPathResolver` walks the parsed bash AST and projects tokens into `externalPaths` (the `external_directory` surface) and `ruleCandidates` (the `path` surface); both projections build `AccessPath`s via `PathNormalizer.forPath`; `foldCd` folds literal `cd` targets via `normalizer.isAbsolute`/`joinBase`.
- `src/path-normalizer.ts` — `PathNormalizer`, the single platform home ([#510]): platform + cwd baked in at the session edge; the bash resolver asks it all platform-dependent questions.
- `src/access-intent/access-path.ts` — `AccessPath` value object ([#476]) with `forPath`/`forLiteral` factories and type-distinct lexical/canonical accessors ([#418]).
- `src/access-intent/path-normalization.ts` — the representation primitives (`normalizePathForComparison`, `getPathPolicyValues`, `canonicalNormalizePathForComparison`).
- `src/safe-system-paths.ts` — `SAFE_SYSTEM_PATHS` + `isSafeSystemPath`, consumed by `path-containment.ts` (canonical boundary check) and the resolver's unknown-base branch.
- `src/access-intent/bash/token-classification.ts` — pure shape classifiers; `/dev/null` and `/tmp` already pass `classifyTokenAsPathCandidate` (leading `/`), so no classifier change is needed.
- `src/handlers/gates/external-directory.ts` — the tool-input external-directory gate; a separate consumer of `normalizer.isOutsideWorkingDirectory` that this plan must not disturb.

Constraint from AGENTS.md / package skill: never read `process.platform` in `src/` — the platform is injected, and Windows behavior is tested by constructing a `PathNormalizer("win32", …)`, never by `vi.mock("node:path")`.
Constraint from the package skill: default to least privilege — the literal-only branch must stay conservative (always external, prompt under `external_directory: ask`).

## Design Overview

The organizing principle: **on a win32 host, the bash surface's path semantics are MSYS, not win32** — because Pi core always spawns Git Bash there.
Tool-input paths keep pure win32 semantics (Node `fs` semantics), so the interpretation layer hooks into the bash token pipeline only.

### Token interpretation table (win32 bash tokens)

| Token shape                                 | Git Bash meaning        | New handling                                                                               |
| ------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `/dev/null`, `/dev/std{in,out,err}` (exact) | MSYS runtime device     | Device `AccessPath`: lexical = canonical = token → safe-path check matches, never external |
| `/c/…`, `/d/…` (drive mount)                | `C:\…`                  | Translate, then existing `forPath` win32 resolution; typed form kept as a match alias      |
| Other `/…` (POSIX absolute)                 | Install-dependent mount | Literal-only `AccessPath` ([#393] machinery): always external, matched/displayed as typed  |
| `C:\…`, `C:/…`, relative, `~/…`             | Same as win32           | Unchanged — existing behavior ([#508], [#382])                                             |

Case handling: device recognition is an exact match against the four lowercase literals (a non-matching `/DEV/NULL` or `/dev/random` falls into the conservative literal-only branch); drive-mount translation accepts either letter case.

### New collaborator surface

A new pure module owns the shape knowledge:

```typescript
// src/access-intent/bash/msys-bash-tokens.ts
export type Win32BashTokenKind =
  | { kind: "device" }
  | { kind: "drive-mount"; windowsPath: string }
  | { kind: "posix-absolute" }
  | { kind: "plain" };

export function classifyWin32BashToken(token: string): Win32BashTokenKind;
```

`PathNormalizer` grows one factory method (and stays the only consumer of the classifier):

```typescript
// PathNormalizer
forBashToken(token: string, options?: { resolveBase?: string }): AccessPath {
  if (this.platform !== "win32") return this.forPath(token, options);
  const shape = classifyWin32BashToken(token);
  // device → AccessPath.forDevice(token)
  // drive-mount → this.forPath(shape.windowsPath, { ...options, literalAliases: [token] })
  // posix-absolute → this.forLiteral(normalizePathPolicyLiteral(token))
  // plain → this.forPath(token, options)
}
```

`AccessPath` grows a `forDevice(devicePath)` factory (lexical = canonical = the device path, `matchValues()` = `[devicePath]`), and `forPath`/`getPathPolicyValues` accept an optional `literalAliases: readonly string[]` so a drive-mount token's typed form (`/c/Users/x`) stays matchable alongside the translated forms.

### Consumer call sites (Tell-Don't-Ask check)

`BashPathResolver.projectExternalPaths` switches to the new factory and derives the external decision from the returned value object instead of re-normalizing the lexical string:

```typescript
const accessPath = this.normalizer.forBashToken(candidate, { resolveBase });
const canonical = accessPath.boundaryValue();
const isExternal = canonical
  ? this.normalizer.isBoundaryOutsideWorkingDirectory(canonical)
  : true; // literal-only bash token: POSIX-absolute, foreign to the win32 cwd
const dedupKey = canonical || accessPath.value();
```

`isBoundaryOutsideWorkingDirectory(canonical)` is a thin `PathNormalizer` delegation to the existing pure `isPathOutsideWorkingDirectory(canonical, canonicalCwd, platform)` — it removes the current double derivation (`isOutsideWorkingDirectory(lexical)` re-canonicalizes a string the `AccessPath` already canonicalized) and gives the device branch its safe-path exclusion for free (`isSafeSystemPath` already runs inside the pure check).
The existing `isOutsideWorkingDirectory(pathValue)` method stays for its other consumer (`handlers/gates/external-directory.ts`, tool inputs).

`buildRuleCandidatePath` switches `forPath` → `forBashToken` (one-line change); the [#393] unknown-base literal branch stays first and unchanged.

`foldCd` routes the literal `cd` target through the same semantics via one new normalizer query:

```typescript
// PathNormalizer
interpretBashCdTarget(target: string):
  | { kind: "absolute"; value: string } // POSIX: any absolute; win32: C:\…, C:/…, or translated /c/…
  | { kind: "relative" }
  | { kind: "unknown" }; // win32: POSIX-absolute non-mount (cd /tmp) — conservative
```

`cd /tmp && cat foo` therefore degrades to the existing `UNKNOWN_BASE` machinery: `foo` becomes a literal-only conservative candidate, which is exactly right — the permission system cannot know where Git Bash's `/tmp` lives.

### Edge cases

- Bare `/c` or `/c/` → translates to `C:\`.
- `/dev/null/sub`, `/dev/random` → not exact device matches → literal-only external (conservative, prompts).
- `//server/share` → literal-only external (the bare-slash rejection in `rejectNonPathToken` only drops `/`, `//`, etc. with no content).
- Dedup: two distinct literal-only paths previously both had `boundaryValue() === ""`; the `canonical || lexical` dedup key prevents the second from being silently dropped.
- ISP check: `forBashToken` takes `(token, { resolveBase? })` — identical shape to `forPath`, no unused fields; `classifyWin32BashToken` takes only the token string.

### Behavior deltas (win32 only)

| Command (cwd `C:\Projects\App`) | Before                               | After                                                                                   |
| ------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------- |
| `echo hi > /dev/null`           | Prompt for `C:\dev\null`             | No prompt (safe device)                                                                 |
| `ls /tmp`                       | Prompt displaying `C:\tmp`           | Prompt displaying `/tmp`; `/tmp*`-style `external_directory` allow rules match as typed |
| `cat /c/Projects/App/src/x`     | Prompt for `C:\c\Projects\App\src\x` | No prompt (inside cwd after translation)                                                |
| `cat /c/Other/x`                | Prompt for `C:\c\Other\x`            | Prompt for `C:\Other\x`, `/c/Other/x` kept as a match alias                             |
| `cat C:\Other\x`                | Prompt                               | Unchanged ([#508])                                                                      |

## Module-Level Changes

- `src/access-intent/bash/msys-bash-tokens.ts` (new) — `classifyWin32BashToken` + `Win32BashTokenKind`; pure string classification, no filesystem, no platform read.
- `src/access-intent/access-path.ts` — add `AccessPath.forDevice(devicePath)`; add optional `literalAliases` to the `forPath` options, threaded to `getPathPolicyValues`.
- `src/access-intent/path-normalization.ts` — add optional `literalAliases?: readonly string[]` to `PathPolicyValueOptions`; `getPathPolicyValues` appends them to the match set.
- `src/path-normalizer.ts` — add `forBashToken`, `isBoundaryOutsideWorkingDirectory`, `interpretBashCdTarget`; no changes to existing methods.
- `src/access-intent/bash/bash-path-resolver.ts` — `projectExternalPaths` and `buildRuleCandidatePath` call `forBashToken`; external decision via `isBoundaryOutsideWorkingDirectory(boundaryValue())` with literal-only → unconditionally external; dedup key `canonical || lexical`; `foldCd` uses `interpretBashCdTarget`.
- `src/safe-system-paths.ts` — unchanged (the device factory and the pure boundary check both reuse `isSafeSystemPath`); `src/access-intent/bash/token-classification.ts` — unchanged (POSIX absolutes already classify as candidates).
- `test/access-intent/bash/msys-bash-tokens.test.ts` (new) — classifier unit tests.
- `test/access-intent/access-path.test.ts` — `forDevice` + `literalAliases` coverage.
- `test/path-normalizer.test.ts` — `forBashToken` win32 flavor (device / drive-mount / posix-absolute / plain), POSIX delegation identity, `interpretBashCdTarget`.
- `test/bash-external-directory.test.ts` — win32 end-to-end scenarios (extends the existing `Windows drive-letter paths (win32 semantics)` describe block pattern with an injected `PathNormalizer("win32", …)`).
- `test/access-intent/bash/program.test.ts` — `cd /c/…` and `cd /tmp` folding scenarios on win32.
- `docs/configuration.md` — extend the Windows paragraph (currently case-insensitivity only) with Git Bash semantics: device paths honored, `/c/` mounts translated, other POSIX absolutes matched as typed; reconcile the "OS device paths are always excluded" sentence with a note that this now holds on Windows too.
- `docs/architecture/architecture.md` — module-tree entries: add `msys-bash-tokens.ts`; update `path-normalizer.ts`, `access-path.ts`, `path-normalization.ts`, and `bash-path-resolver.ts` entries for the new methods/options.
- `docs/decisions/0003-git-bash-posix-path-semantics.md` (new ADR) — records the "bash surface is MSYS on win32" decision, the deterministic subset chosen (devices, drive mounts, literal-only absolutes), and the rejected alternatives (`cygpath`, `%TEMP%` mapping).
- `.pi/skills/package-pi-permission-system/SKILL.md` — the `Windows and Git Bash` platform-facts section was added during planning; update its final sentence from "planned in" to the implemented behavior, and extend the bash-token platform note in `Notes for Agents` with the win32 POSIX-token branches.

No exports are removed or renamed, so no removed-symbol grep is required.

## Test Impact Analysis

1. **New unit tests enabled:** the classifier is testable in isolation (pure string shapes); `forBashToken` is testable on a bare `PathNormalizer("win32", …)` without parsing bash or spinning gates — previously the only way to observe win32 bash-token semantics was through the full resolver.
2. **Redundant tests:** none removed.
   The existing win32 drive-letter tests ([#508]) and unknown-base literal tests ([#393]) pin invariants this change must preserve, not behavior it replaces.
3. **Tests that must stay as-is:** `test/bash-external-directory.test.ts` `Windows drive-letter paths (win32 semantics)` block (pins #508); `test/path-normalization.test.ts` win32 assertions for non-device tokens (generic win32 resolution is unchanged); `test/safe-system-paths.test.ts` (the set and predicate are untouched); [#418] symlink-alias tests (lexical ∪ canonical matching unchanged).

## Invariants at risk

- **[#418] — `external_directory` patterns match the typed (lexical) form**, pinned by `test/bash-external-directory.test.ts` symlink/alias tests.
  The change only adds aliases (`literalAliases`) and never drops the lexical form.
- **[#382] — win32 comparisons are case-insensitive**, pinned in `test/path-containment.test.ts`.
  The device branch bypasses lowercasing for four already-lowercase literals only; drive-mount translation feeds the existing lowercasing path.
- **[#508] — Windows drive-letter tokens are gated**, pinned in `test/bash-external-directory.test.ts`.
  `forBashToken`'s `plain` branch must delegate to `forPath` unchanged.
- **[#393] — unknown-base relative tokens stay literal-only**, pinned in resolver tests.
  The unknown-base branch runs before the new interpretation and is untouched.
- **[#454] — cd-fold pipeline semantics**, pinned in `test/access-intent/bash/program.test.ts`.
  `foldCd`'s walk position is unchanged; only the target interpretation is delegated.
- **Documented contract** — `docs/configuration.md` "OS device paths are always excluded": currently prose-only on win32; TDD cycle 1 adds the pinning test.
- **Projection refactor equivalence** — replacing `isOutsideWorkingDirectory(lexical)` with the boundary-based check must be observationally equivalent on POSIX; the full existing resolver suite pins this.

## TDD Order

1. **Devices in bash on win32** — red: `forBashToken("/dev/null")` on a win32 normalizer returns a boundary value that `isSafeSystemPath` accepts, and a resolver test asserting `echo hi > /dev/null` yields no external paths on win32 (currently yields `c:\dev\null`); green: `AccessPath.forDevice`, `PathNormalizer.forBashToken` (device branch + delegate-to-`forPath` fallback), projection switch to `forBashToken` + `isBoundaryOutsideWorkingDirectory`.
   Covers: `test/access-intent/access-path.test.ts`, `test/path-normalizer.test.ts`, `test/bash-external-directory.test.ts`.
   Commit: `fix(pi-permission-system): recognize POSIX device paths in bash commands on win32 (#533)`.
2. **Drive-mount translation** — red: classifier tests for `/c/…`/`/C/…`/bare `/c` shapes, and resolver tests asserting `cat /c/<cwd>/x` is not external while `cat /c/Other/x` is external with the typed alias in `matchValues()`; green: `msys-bash-tokens.ts` classifier, `literalAliases` option on `getPathPolicyValues`/`forPath`, drive-mount branch in `forBashToken`.
   Covers: `test/access-intent/bash/msys-bash-tokens.test.ts`, `test/access-intent/access-path.test.ts`, `test/bash-external-directory.test.ts`.
   Commit: `fix(pi-permission-system): translate MSYS drive-mount bash tokens on win32 (#533)`.
3. **POSIX-absolute literal-only handling** — red: resolver tests asserting `ls /tmp` on win32 yields an external path whose `value()` is `/tmp` (not `c:\tmp`) with `matchValues()` `["/tmp"]`, plus a dedup test with two distinct literal-only paths; green: posix-absolute branch in `forBashToken`, unconditional-external for empty boundary values, dedup key `canonical || lexical`, `buildRuleCandidatePath` switch.
   Covers: `test/bash-external-directory.test.ts`, `test/path-normalizer.test.ts`.
   Commit: `fix(pi-permission-system): match Git Bash POSIX-absolute bash tokens as typed on win32 (#533)`.
4. **cd folding** — red: `cd /c/Other && cat x` resolves `x` against `C:\Other` on win32; `cd /tmp && cat foo` degrades to the unknown-base conservative flag; green: `interpretBashCdTarget` + `foldCd` delegation.
   Covers: `test/access-intent/bash/program.test.ts`, `test/path-normalizer.test.ts`.
   Commit: `fix(pi-permission-system): fold Git Bash cd targets with MSYS semantics on win32 (#533)`.
5. **Gate-level integration** — end-to-end win32 coverage through the external-directory bash gate: `> /dev/null` under `external_directory: {"*": "ask"}` produces no prompt; `ls /tmp` prompts displaying `/tmp`; an `external_directory` allow rule on `/tmp*` suppresses the prompt.
   Covers: `test/bash-external-directory.test.ts` (or the handler-level fixture file if gate wiring is needed).
   Commit: `test(pi-permission-system): cover Git Bash POSIX path gating end to end (#533)`.
6. **Docs** — `docs/configuration.md` Windows section, `docs/architecture/architecture.md` module-tree entries, new ADR `docs/decisions/0003-git-bash-posix-path-semantics.md`, package skill note.
   Commit: `docs(pi-permission-system): document Git Bash path semantics on Windows (#533)`.

## Risks and Mitigations

- **Loosening on win32 (devices, in-cwd drive mounts no longer prompt).**
  Mitigated by exact-match device recognition (four literals, no globs, no case folding) and by translation feeding the existing containment logic; anything ambiguous falls into the conservative literal-only branch that always prompts.
- **Regression in the projection refactor (boundary-based external check).**
  Mitigated by the full existing resolver/gate suite (POSIX and win32 blocks) staying green, and by keeping `isOutsideWorkingDirectory` untouched for the tool gate.
- **`fallow dead-code` gate on intermediate commits.**
  New exports (`forDevice`, classifier) are wired within the same or next cycle; the CI gate runs on the pushed tree, where all exports have consumers.
- **Wildcard-matcher case handling for literal aliases.**
  Cycle 3's red test asserts a `/tmp*` allow rule matches the typed token on win32; if the matcher's win32 case folding interferes, the fix lands inside that cycle rather than as a surprise later.
- **tree-sitter parse shapes for redirect targets.**
  The issue's headline repro (`> /dev/null`) flows through `collectRedirectTokens`; cycle 1's resolver test uses the literal repro string per the package-skill rule (trace the token through the classifier first).

## Open Questions

- Exact naming (`msys-bash-tokens.ts`, `forBashToken`, `interpretBashCdTarget`) may be refined during implementation; the seam placement (classifier module consumed only by `PathNormalizer`) is settled.
- Whether the drive-mount typed alias needs lowercasing before it enters `matchValues()` on win32 (the wildcard matcher may already fold case); decided by cycle 2's red test.

[#382]: https://github.com/gotgenes/pi-packages/issues/382
[#393]: https://github.com/gotgenes/pi-packages/issues/393
[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#454]: https://github.com/gotgenes/pi-packages/issues/454
[#476]: https://github.com/gotgenes/pi-packages/issues/476
[#508]: https://github.com/gotgenes/pi-packages/issues/508
[#510]: https://github.com/gotgenes/pi-packages/issues/510
