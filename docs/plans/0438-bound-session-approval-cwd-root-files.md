---
issue: 438
issue_title: "pi-permission-system: Session approval for path-bearing tools on files in the current working directory never matches (always re-prompts)"
---

# Bound session approval for current-directory files

## Release Recommendation

**Release:** ship independently

Issue #438 is a standalone bug fix.
It is not a member of any architecture-roadmap phase or release batch, so it ships on its own once verified.

## Problem Statement

When a path-bearing tool (`edit`, `write`, `read`, …) acts on a file directly in the current working directory (e.g. `index.html`), choosing "Allow for this session" never sticks — every subsequent call on that file (or any other root-level file) prompts again.

The root cause is a pattern/value mismatch in `deriveApprovalPattern()`.
For a root-level relative path the function takes `dirname("index.html") === "."`, builds the prefix `"./"`, and returns the glob `"./*"`.
But the values the rule is later matched against come from `getPathPolicyValues()` and carry **no** `"./"` prefix: `["<abs-cwd>/index.html", "index.html"]`.
The compiled regex for `"./*"` is `^\.\/.*$`, which requires the value to start with `./`, so neither value matches.
The session rule is recorded but is dead — the next call falls back to the configured default (`ask`) and re-prompts.

The issue's reproduction configures the `edit` **tool** surface (`edit: { "*": "ask" }`), so the primary affected gate is the per-tool gate (`describeToolGate` → `suggestSessionPattern`), with the cross-cutting `path` gate and the bash `path` gate affected by the same root-relative case.

## Goals

- A "Allow for this session" choice on a current-working-directory file stops further prompts for that file (and other files reachable under CWD) for the rest of the session.
- The fix is **bounded to the working-directory subtree**: approving a CWD-root file must not silently approve paths outside CWD.
- The fix covers every gate that derives a session-approval pattern from a possibly-relative path: the per-tool gate, the cross-cutting `path` gate, and the bash `path` gate.
- No regression to the existing sub-directory behavior (`src/foo.ts` → `src/*`) or to its dialog label readability.

This change is **not breaking**: it only makes a currently-dead session rule live, and only for the CWD-root case that previously re-prompted.
No existing pattern, default, or output shape changes for paths that already matched.

## Non-Goals

- Changing the directory-glob semantics for sub-directory files (`src/foo.ts` keeps deriving the relative `src/*`).
- Re-deriving approval patterns from absolute paths for the common sub-directory case (would make dialog labels show long absolute paths — see Design).
- Fixing the `cwd`-absent edge case (no working directory threaded to the gate).
  With no CWD there is no absolute policy value to bind to; the function keeps its current safe-but-re-prompting `"./*"` output.
  This path is unreachable for real tool calls (`tcc.cwd` is always set), so it is left as documented behavior, not a fix target.
- The Windows backslash variant (`.\*`) is the same code path — `dirname` collapses both to `.`, and the bounded fix produces a single normalized pattern — so no separate Windows-only branch is added.

## Background

Relevant modules:

- `src/session-rules.ts` — `deriveApprovalPattern(normalizedPath)` turns a path into a directory-scoped glob (`<parent-dir>/*`) recorded as a session `allow` rule.
  This is the single function with the bug.
- `src/pattern-suggest.ts` — `suggestSessionPattern(surface, value)` wraps `deriveApprovalPattern` for the per-tool gate and builds the dialog label (`buildLabel`).
- `src/handlers/gates/tool.ts` — `describeToolGate` / `deriveSuggestionValue`: the per-tool gate, the **primary** repro path.
  For a path-bearing tool it passes the raw `input.path` (e.g. `index.html`) to `suggestSessionPattern`.
- `src/handlers/gates/path.ts` — `describePathGate`: the cross-cutting `path` gate, passes the raw `filePath` to `deriveApprovalPattern`.
- `src/handlers/gates/bash-path.ts` — `describeBashPathGate`: the bash `path` gate, passes the raw `worstToken`.
- `src/handlers/gates/external-directory.ts` — already passes the **absolute** path (`normalizePathForComparison(...)`) to `deriveApprovalPattern`, so external-directory approvals are not affected (an external path's `dirname` is never `.`).
- `src/path-utils.ts` — `getPathPolicyValues` / `normalizePathForComparison` produce the policy values and the canonical absolute form.

Relevant invariant (from the `package-pi-permission-system` skill): "Wildcard matching must be explicit and tested — silent over-matching is a permission bypass," and "Default to least privilege."
This is why the bounded form (`<cwd>/*`) is chosen over the issue's suggested universal `"*"`, which would match every path — including files outside CWD — for the rest of the session (operator-confirmed direction).

`tcc.cwd` is available to all three gates via `ToolCallContext` (`src/handlers/gates/types.ts`).

## Design Overview

### Decision

`deriveApprovalPattern` gains an optional second argument carrying the working directory.
When the path is a CWD-root relative file (`dirname === "."`) **and** a CWD is supplied, it returns the CWD-absolute directory glob; otherwise it behaves exactly as today.

```typescript
export function deriveApprovalPattern(
  normalizedPath: string,
  options?: { cwd?: string },
): string {
  if (normalizedPath.endsWith(sep)) return `${normalizedPath}*`;
  const dir = dirname(normalizedPath);
  if (dir === normalizedPath) return `${dir}*`; // filesystem root "/"
  if (dir === "." && options?.cwd) {
    // Relative file in the current directory. A relative "*" glob would
    // over-match every path; resolve against cwd so the approval is bounded
    // to the working-directory subtree and matches the absolute policy value.
    const base = normalizePathForComparison(options.cwd, options.cwd);
    return `${base}${sep}*`;
  }
  const prefix = dir.endsWith(sep) ? dir : `${dir}${sep}`;
  return `${prefix}*`;
}
```

`normalizePathForComparison(cwd, cwd)` returns the normalized (and, on Windows, lowercased) absolute CWD — the same transform applied to the policy values' absolute form, so `<cwd>/*` matches `<cwd>/index.html` consistently across platforms.
The trailing `*` compiles to `.*`, which crosses `/`, so `<cwd>/*` covers the whole CWD subtree — identical recursive semantics to today's `src/*`.

### Why bounded, not relative `*`

The policy values for a CWD-root file always include the absolute form (`<abs-cwd>/index.html`) when CWD is known.
Binding the pattern to `<abs-cwd>/*` matches that absolute value while **excluding** any path outside CWD (e.g. `/etc/passwd` produces values `["/etc/passwd"]`, which `<abs-cwd>/*` does not match).
The issue's suggested `"*"` would match `/etc/passwd` too — disabling a configured `ask` after a single approval.

### Why not absolute for the sub-directory case

Sub-directory files already work: `deriveApprovalPattern("src/foo.ts")` → `"src/*"` matches the relative policy value `"src/foo.ts"`.
Keeping that branch untouched preserves the readable dialog label (`Yes, allow edit "src/*" for this session`); switching it to absolute would render `Yes, allow edit "/Users/.../project/src/*" for this session`.
Only the `dirname === "."` branch — currently broken, so nothing to regress — changes, and only it must show the absolute CWD glob (unavoidable for boundedness).

### Threading CWD to the call sites

- `suggestSessionPattern(surface, value, cwd?)` — new optional `cwd`, forwarded to `deriveApprovalPattern` in the `path`, `external_directory`, and path-bearing-tool branches.
  `tool.ts` passes `tcc.cwd`.
- `path.ts` — `deriveApprovalPattern(filePath, { cwd: tcc.cwd })`.
- `bash-path.ts` — `deriveApprovalPattern(worstToken, { cwd: tcc.cwd })`.
  For a bash token after a literal `cd <sub>` (within CWD), the token's absolute value (`<cwd>/sub/index.html`) is still a descendant of `<cwd>`, so `<cwd>/*` matches it.
  This is marginally broader than `<cwd>/sub/*` but remains bounded to CWD; tokens that `cd` outside CWD are handled by the external-directory gate, not this one.

### Call-site sketch (per-tool gate, the repro)

```typescript
// tool.ts — describeToolGate
const suggestion = suggestSessionPattern(
  tcc.toolName,                      // "edit"
  deriveSuggestionValue(tcc, check), // "index.html"
  tcc.cwd,                           // "/Users/.../project"
);
// → suggestion.pattern === "/Users/.../project/*"
// Recorded as session rule { surface: "edit", pattern, action: "allow" }.
// Next edit of index.html → values ["/Users/.../project/index.html", "index.html"]
//   → "/Users/.../project/*" matches the absolute value → allow → no re-prompt.
```

### Import direction

`session-rules.ts` will import `normalizePathForComparison` from `path-utils.ts`.
`path-utils.ts` imports neither `session-rules` nor `pattern-suggest`, so no import cycle is introduced.

## Module-Level Changes

- `src/session-rules.ts` — add the optional `options?: { cwd?: string }` parameter to `deriveApprovalPattern`; add the bounded `dirname === "."` branch; import `normalizePathForComparison` from `./path-utils`.
- `src/pattern-suggest.ts` — add an optional `cwd?: string` parameter to `suggestSessionPattern`; forward it to `deriveApprovalPattern` in the `path`, `external_directory`, and path-bearing-tool branches.
- `src/handlers/gates/tool.ts` — pass `tcc.cwd` as the third argument to `suggestSessionPattern`.
- `src/handlers/gates/path.ts` — pass `{ cwd: tcc.cwd }` to `deriveApprovalPattern`.
- `src/handlers/gates/bash-path.ts` — pass `{ cwd: tcc.cwd }` to `deriveApprovalPattern`.

No exported symbol is removed or renamed; both signature changes are additive (optional trailing parameters), so existing call sites compile unchanged.

Docs/skill check: `grep` of `.pi/skills/package-pi-permission-system/SKILL.md` and `packages/pi-permission-system/docs/` for `deriveApprovalPattern` / `suggestSessionPattern` finds no prose describing the derived pattern shape that this change contradicts; the architecture `rule.ts` type listing is untouched (no `Rule`/`Ruleset` field change).
No `docs/architecture/` layout, complexity, or health table references these files by the changed behavior.

## Test Impact Analysis

This is a behavior fix, not an extraction, so the analysis is narrow:

1. **New tests enabled** — `deriveApprovalPattern` gains direct unit coverage for the CWD-root case (with and without `cwd`), which was previously untested and silently wrong.
   A round-trip test (record the derived pattern on a tool surface, then evaluate the CWD-root file's policy values) pins the end-to-end "no re-prompt" behavior and the boundedness (an outside-CWD file still evaluates to `ask`).
2. **Redundant tests** — none.
   No existing test asserted the broken `"./*"` output, so nothing is removed.
3. **Tests that must stay** — the existing `deriveApprovalPattern` cases (absolute file, trailing-separator directory, filesystem root, sub-directory glob, "matches under directory" / "not sibling directories") continue to pin the unchanged branches.

## Invariants at risk

- The "produces a pattern that matches paths under the approved directory" and "does not match sibling directories" tests in `test/session-rules.test.ts` pin the recursive-but-bounded directory-glob invariant.
  The new branch must preserve it: `<cwd>/*` matches descendants of CWD and excludes siblings of CWD.
  A new round-trip test adds the CWD-root counterpart (root file matches; outside-CWD file does not).

This change touches no surface refactored by a prior architecture-roadmap phase step, so there is no earlier `Outcome:` invariant to re-pin beyond the above.

## TDD Order

1. **`deriveApprovalPattern` bounded CWD-root pattern** — `test/session-rules.test.ts`.
   Red: assert `deriveApprovalPattern("index.html", { cwd: "/test/project" })` → `"/test/project/*"`; `deriveApprovalPattern("index.html")` (no cwd) → `"./*"` (documents the safe, unchanged fallback); sub-directory and absolute cases unchanged; round-trip — record the derived pattern on the `edit` surface, then `evaluate("edit", "/test/project/index.html", ruleset)` → `allow` and `evaluate("edit", "/etc/passwd", ruleset)` → `ask` (boundedness).
   Green: add the optional `options` parameter and the `dirname === "." && options?.cwd` branch; import `normalizePathForComparison`.
   Commit: `fix(session-rules): bound current-directory approval pattern to cwd (#438)`.
2. **Per-tool gate threads CWD (primary repro)** — `test/handlers/gates/tool.test.ts` and `test/pattern-suggest.test.ts`.
   Red: `describeToolGate` for `edit` on `{ path: "index.html" }` with `cwd: "/test/project"` → `sessionApproval.representativePattern === "/test/project/*"` (not `"./*"`); `suggestSessionPattern("edit", "index.html", "/test/project")` → bounded pattern and a label showing it.
   Green: add the optional `cwd` parameter to `suggestSessionPattern` and forward it; pass `tcc.cwd` from `deriveSuggestionValue`'s call site in `tool.ts`.
   Commit: `fix(pattern-suggest): scope per-tool session approval for cwd-root files (#438)`.
3. **Cross-cutting `path` gate threads CWD** — `test/handlers/gates/path.test.ts`.
   Red: `describePathGate` for a `read`/`edit` on `{ path: "index.html" }` (ask) with `cwd: "/test/project"` → `sessionApproval.representativePattern === "/test/project/*"`.
   Green: pass `{ cwd: tcc.cwd }` to `deriveApprovalPattern` in `path.ts`.
   Commit: `fix(path-gate): scope path session approval for cwd-root files (#438)`.
4. **Bash `path` gate threads CWD** — `test/handlers/gates/bash-path.test.ts`.
   Red: a bash command referencing a CWD-root token (e.g. `cat index.html`) that resolves to `ask` with `cwd: "/test/project"` → `sessionApproval.representativePattern === "/test/project/*"`.
   Green: pass `{ cwd: tcc.cwd }` to `deriveApprovalPattern` in `bash-path.ts`.
   Commit: `fix(bash-path-gate): scope bash path session approval for cwd-root files (#438)`.

Step 1 must land first — steps 2–4 depend on the new optional parameters, but because the parameters are optional the suite stays green after every step.
Run `pnpm run check` after step 1 (signature change) and `pnpm -r run test` before the pre-completion review.

## Risks and Mitigations

- **Risk: over-broad approval (the operator-rejected universal `"*"`).**
  Mitigation: bind to `<cwd>/*`; the round-trip test asserts an outside-CWD path still evaluates to `ask`.
- **Risk: platform divergence (Windows lowercasing / separators).**
  Mitigation: derive the CWD base via `normalizePathForComparison`, the same transform applied to policy values; `path` surfaces already fold case and separators in `wildcardMatch`.
- **Risk: a stray `dirname === "."` call without CWD silently returns `"./*"` again.**
  Mitigation: all three live gates thread `tcc.cwd`; the no-cwd fallback is documented and unit-tested as the safe (re-prompting, not over-approving) behavior.
- **Risk: import cycle from `session-rules` → `path-utils`.**
  Mitigation: verified `path-utils` imports neither `session-rules` nor `pattern-suggest`.

## Open Questions

- Bash tokens after a literal `cd <sub>` within CWD approve the whole `<cwd>/*` subtree rather than `<cwd>/sub/*`.
  This is bounded and acceptable; tightening to the per-token absolute (`policyValues[0]`) is a possible follow-up if a narrower bash approval is ever requested, but it is out of scope here.
