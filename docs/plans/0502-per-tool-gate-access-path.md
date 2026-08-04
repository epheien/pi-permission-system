---
issue: 502
issue_title: "pi-permission-system: migrate the per-tool path-bearing gate onto AccessPath (Phase 7 Step 1)"
---

# Migrate the per-tool path-bearing gate onto `AccessPath`

## Release Recommendation

**Release:** mid-batch — defer (batch "symlink-resistant-path-matching"); confirm at ship time

This is Phase 7 Step 1 of the [#487] roadmap.
The architecture's `Release batches` subsection puts Steps 1, 2, 3 in the breaking batch "symlink-resistant-path-matching", with the **tail at Step 3** ([#504]).
This issue is Step 1, not the tail, so it lands on `main` and auto-batches; the major-bump release cuts when Step 3 lands.
The breaking `feat!:` commit does not cut a release on its own here because the batch is still mid-flight — confirm the deferral at ship time.

## Problem Statement

The per-tool path-bearing gate (`read` / `write` / `edit` / `grep` / `find` / `ls`) still matches **lexically only**, while the cross-cutting `path` surface matches the lexical aliases ∪ canonical (symlink-resolved) form after [#486].
The per-tool gate's sixth gate producer in `tool-call-gate-pipeline.ts` emits a `kind: "tool"` intent, which the manager normalizes via `normalizeInput` → `normalizePathSurfaceValues` → `getPathPolicyValues` — lexical only.
So a per-tool rule like `read: deny *.env` can be evaded through a symlink alias, whereas the same rule on `path` cannot.
This asymmetry is the residual gap Phase 7 Step 1 closes: route the per-tool path-bearing gate onto `AccessPath` so its match set becomes lexical ∪ canonical — the same set [#486] already gives `path` and `external_directory`.

## Goals

- For path-bearing built-in tools (`read` / `write` / `edit` / `grep` / `find` / `ls`), build an `AccessPath` via the session `PathNormalizer` and emit a `kind: "access-path"` intent with `surface: toolName`, so the per-tool gate matches the lexical aliases ∪ canonical form.
- Keep non-path tools (bash, MCP, extension tools, and a path-bearing tool with no `input.path`) on the existing `kind: "tool"` intent — no behavior change for them.
- Derive the per-tool session-approval suggestion value from `accessPath.value()` instead of re-deriving it with `normalizePathForComparison`, dropping the `platform` parameter that `describeToolGate` threaded only to feed that derivation.
- Remove the now-unused `getPlatform()` session accessor (this resolves [#513]): with [#511] already landed, this issue is the second of the two consumers to fold, so after the per-tool gate read goes, `ToolCallGatePipeline.evaluate`'s `getPlatform()` read — and the accessor it backs — has no caller and must be removed (the `pnpm fallow dead-code` CI gate would otherwise flag it).

This is a **breaking change**: adding the canonical alias to the per-tool match set alters which rules fire on upgrade with no user edit.
A symlink whose resolved target matches a per-tool `deny`/`allow` pattern now matches it where it previously did not.
The behavior step's commit is `feat(pi-permission-system)!:` with a `BREAKING CHANGE:` footer.

## Non-Goals

- No migration of the service/RPC path queries onto `AccessPath` — that is Phase 7 Step 2 ([#503]).
- No removal of `input-normalizer`'s `normalizePathSurfaceValues` / `PATH_BEARING_TOOLS` branch — that is Phase 7 Step 3 ([#504]), after both Step 1 and Step 2 strip its callers.
  This plan leaves `normalizeInput` intact; the path-bearing tool with no `input.path` still routes through the `tool` branch (so the missing-path `["*"]` fallback is preserved).
- No change to MCP or extension per-tool gating: they stay on the `tool` intent (their path is already covered symlink-resistantly by the cross-cutting `path` gate, which emits `access-path` since [#486]).
- No change to dedup/approval-key identity: keys continue to derive from the **lexical** form (`accessPath.value()`), so existing session approvals stay stable.
- No principal identity on `AccessIntent`; cross-session path portability stays deferred.

## Background

Relevant modules (all in `packages/pi-permission-system/`):

- `src/handlers/gates/tool-call-gate-pipeline.ts` — `ToolCallGatePipeline.evaluate` assembles six gate producers.
  The **sixth** producer is the per-tool gate: for bash it calls `resolveBashCommandCheck`, otherwise it resolves `{ kind: "tool", surface: tcc.toolName, input: tcc.input }` and feeds the result into `describeToolGate`.
  It currently reads `const platform = this.inputs.getPlatform()` and threads it only into `describeToolGate` (after [#511] removed the skill-read and external-directory `platform` threading).
- `src/handlers/gates/tool.ts` — `describeToolGate(tcc, check, formatter, platform)` builds the descriptor; `deriveSuggestionValue` returns the session-approval suggestion (`bash` → command, `mcp` → target, path-bearing → `normalizePathForComparison(path, tcc.cwd, platform)`, else `*`).
- `src/handlers/gates/path.ts` — the cross-cutting `path` gate, already migrated by [#486]: builds `normalizer.forPath(filePath)`, emits `{ kind: "access-path", surface: "path", path }`, derives the approval pattern from `accessPath.value()`.
  This is the template for the per-tool change.
- `src/path-normalizer.ts` — `PathNormalizer.forPath(pathValue, options?)` builds an `AccessPath` resolved against the baked session `cwd` + `platform`.
- `src/path-utils.ts` — `getPathBearingToolPath(toolName, input)` returns `input.path` for the six built-in `PATH_BEARING_TOOLS`, else `null`; `PATH_SURFACES` includes the path-bearing tool names, so the manager's `buildCheckResult` already routes a `surface: "read"` path-values intent through `evaluateAnyValue` (last-match-wins across aliases).
- `src/permission-resolver.ts` — `toResolvedIntent` unwraps an `access-path` intent to `path-values` via `path.matchValues()`; the manager stays string-based and never imports `AccessPath`.
- `src/access-intent/access-intent.ts` — `AccessPathAccessIntent`; its doc comment names only the `path` and `external_directory` surfaces as emitters.
- `src/permission-session.ts` — `getPlatform()` returns `this.platform` (still used internally by `getPathNormalizer()`); the accessor is consumed only by the pipeline's `getPlatform()` read.

`getPlatform()` consumers (grep-verified): `PermissionSession.getPlatform()` (definition), `ToolCallGateInputs.getPlatform()` (interface member), and the single `const platform = this.inputs.getPlatform()` read in `ToolCallGatePipeline.evaluate`.
The test fixture `makeGateInputs` (`test/helpers/gate-fixtures.ts`) provides a `getPlatform` stub.
No other `src/` or `test/` reader exists.

Key constraint (AGENTS.md / SKILL): the manager stays string-based and never imports `AccessPath`; the resolver does the `matchValues()` unwrap.
This change preserves that — the per-tool gate emits `access-path`, the resolver unwraps, the manager is untouched (mechanically parallel to [#486]).

[#513] designates "whichever of [#502]/[#511] lands second drops the accessor." [#511] is already merged, so [#502] is second and folds the removal in; [#513] closes when this ships.

## Design Overview

### The match set is already single-sourced

`AccessPath.matchValues()` returns exactly `lexical aliases ∪ canonical`.
The resolver already unwraps an `access-path` intent through `matchValues()`, and `PATH_SURFACES.has("read")` is `true`, so the manager already evaluates a `surface: "read"` path-values intent with `evaluateAnyValue`.
So the change is purely: make the per-tool gate emit `access-path` (for path-bearing tools with a path) instead of `tool`.
No manager or resolver change is needed — the only behavior change is the canonical alias joining the match set.

### Per-tool gate producer (`tool-call-gate-pipeline.ts`)

The sixth producer gains an `AccessPath` branch for path-bearing tools, keyed off `getPathBearingToolPath` (which is non-`null` only for the six built-ins with a present `input.path`):

```typescript
const path = getPathBearingToolPath(tcc.toolName, tcc.input);
let accessPath: AccessPath | undefined;
let toolCheck: PermissionCheckResult;
if (tcc.toolName === "bash" && bashProgram) {
  toolCheck = resolveBashCommandCheck(command ?? "", bashProgram.commands(), tcc.agentName ?? undefined, this.resolver);
} else if (path !== null) {
  accessPath = normalizer.forPath(path);
  toolCheck = this.resolver.resolve({
    kind: "access-path",
    surface: tcc.toolName,
    path: accessPath,
    agentName: tcc.agentName ?? undefined,
  });
} else {
  toolCheck = this.resolver.resolve({
    kind: "tool",
    surface: tcc.toolName,
    input: tcc.input,
    agentName: tcc.agentName ?? undefined,
  });
}
const toolDescriptor = describeToolGate(tcc, toolCheck, formatter, accessPath);
toolDescriptor.preCheck = toolCheck;
return toolDescriptor;
```

`normalizer` is the `PathNormalizer` already obtained at the top of `evaluate`; the `const platform = this.inputs.getPlatform()` read and its threading into `describeToolGate` are removed. (`prefer-const` does not fire here: `accessPath`/`toolCheck` are each assigned once across the branches, but a `let` with no initializer assigned in mutually exclusive branches is fine; if the linter objects, hoist the branch into a small helper that returns `{ accessPath, toolCheck }`.)

The discriminator `path !== null` preserves the missing-path case: a path-bearing tool whose `input.path` is absent routes through the `tool` intent, where `normalizeInput` collapses it to `["*"]` exactly as today.

### Per-tool descriptor (`tool.ts`)

`describeToolGate` takes an optional `accessPath` in place of `platform`; `deriveSuggestionValue` reads `accessPath.value()` for the path branch:

```typescript
function deriveSuggestionValue(
  tcc: ToolCallContext,
  check: PermissionCheckResult,
  accessPath?: AccessPath,
): string {
  if (tcc.toolName === "bash") return check.command ?? "";
  if (tcc.toolName === "mcp") return check.target ?? "mcp";
  if (accessPath) return accessPath.value();
  return "*";
}

export function describeToolGate(
  tcc: ToolCallContext,
  check: PermissionCheckResult,
  formatter: ToolPreviewFormatter,
  accessPath?: AccessPath,
): GateDescriptor { /* ... */ }
```

`accessPath.value()` is behavior-identical to today's `normalizePathForComparison(path, tcc.cwd, platform)`: `value()` returns `normalizePathForComparison(pathValue, resolveBase = cwd, platform)`, and the pipeline's normalizer is built from the same session `cwd` + `platform` as `tcc.cwd`.
The `normalizePathForComparison` import is removed from `tool.ts`.
`decision.value` is unchanged — it keeps using `getPathBearingToolPath(tcc.toolName, tcc.input)` (the **raw** referenced path) via `deriveDecisionValue`, so `getPathBearingToolPath` and `PATH_BEARING_TOOLS` imports stay.

This honors Tell-Don't-Ask (the descriptor asks the `AccessPath` for `value()`) and removes a parameter relay: `platform` was threaded session → pipeline → `describeToolGate` solely to feed one derivation that the `AccessPath` the gate already builds now owns.

### Remove the dead `getPlatform()` accessor (resolves [#513])

After the per-tool gate stops reading `platform`, `ToolCallGatePipeline.evaluate` no longer calls `getPlatform()`, and the accessor is dead.
Remove `getPlatform()` from `ToolCallGateInputs` (the pipeline's narrow input interface) and from `PermissionSession`, and drop the `getPlatform` field from `makeGateInputs`.
`this.platform` stays on `PermissionSession` (still feeds `getPathNormalizer()`); only the session-level accessor that existed to feed the residual reads is retired.

### Edge cases

- **Missing `input.path`:** `getPathBearingToolPath` returns `null` → `tool` intent → `["*"]` (preserved).
- **Not a symlink:** `matchValues()` collapses to the lexical aliases when canonical equals one of them — no spurious extra value.
- **Unresolvable path (ELOOP / EACCES / empty):** `canonicalNormalizePathForComparison` falls back to the lexical form; no new match beyond today's lexical behavior.
- **MCP / extension tools:** stay on `tool` (no change); their path is gated symlink-resistantly by the cross-cutting `path` gate.

## Module-Level Changes

Source:

- `src/handlers/gates/tool-call-gate-pipeline.ts` — sixth producer builds an `AccessPath` and emits `access-path` for path-bearing tools (else `tool`); pass `accessPath` to `describeToolGate`; remove the `const platform = this.inputs.getPlatform()` read and its arg.
  Add imports: `getPathBearingToolPath` (`#src/path-utils`) and the `AccessPath` type (`#src/access-intent/access-path`).
- `src/handlers/gates/tool.ts` — `describeToolGate` and `deriveSuggestionValue` take an optional `accessPath` in place of `platform`; suggestion path branch reads `accessPath.value()`; remove the `normalizePathForComparison` import; add an `AccessPath` type import.
- `src/handlers/gates/tool-call-gate-pipeline.ts` (interface) — remove `getPlatform()` from `ToolCallGateInputs` and its doc comment.
- `src/permission-session.ts` — remove the `getPlatform()` method (keep the private `platform` field).
- `src/access-intent/access-intent.ts` — update the `AccessPathAccessIntent` doc comment: emitters now include the per-tool path-bearing surfaces (`read`/`write`/`edit`/`grep`/`find`/`ls`), not just `path` and `external_directory`.

Tests:

- `test/handlers/gates/tool.test.ts` — drop the `"linux"` fourth argument from every `describeToolGate` call; for the two session-approval cwd tests, build an `AccessPath` via `new PathNormalizer("linux", "/test/project").forPath(...)` and pass it; non-path / bash / mcp calls pass `undefined`; add a case asserting the suggestion derives from `accessPath.value()`.
- `test/handlers/gates/tool-call-gate-pipeline.test.ts` — add a test that a path-bearing tool with `input.path` emits an `access-path` intent on its tool-name surface (assert via a resolver mock dispatching on `intent.kind`/`intent.surface`); add a test that a per-tool `deny` matched against a symlinked path's canonical alias blocks; confirm non-path tools still emit `tool`.
- `test/helpers/gate-fixtures.ts` — remove the `getPlatform` override field and default from `makeGateInputs`.

Documentation (grep-verified — symbol/behavior named in prose):

- `docs/architecture/architecture.md` — mark Phase 7 Step 1 ([#502]) complete (`✅` on the step heading and the `S1` Mermaid node); update the `access-intent.ts` module entry (line ~678, per-tool surfaces now emit `access-path`) and the `tool.ts` entry (line ~712, approval value from `accessPath.value()`, no `platform`); rewrite the residual-`getPlatform()`-threading subsection (lines ~880–892) to record that both [#511] and [#502] have landed, so `getPlatform()` is removed and [#513] is resolved.
  Leave the Phase-7 health-metric/target table unchanged (its rows describe the phase endpoint, not a per-step state).
- `docs/configuration.md` — the per-tool patterns section (lines ~356, ~404–407, and the per-tool surface description): state that per-tool path rules now also match the canonical (symlink-resolved) form, at parity with `path` (generalize the existing "Symlinked paths" note ~469–483 to name the per-tool surfaces).
- `README.md` — the per-tool path-patterns description (lines ~74–75): add that per-tool path rules now resist symlink-alias evasion like the cross-cutting `path` rule.
- `.pi/skills/package-pi-permission-system/SKILL.md` — update line ~127 (`getPathBearingToolPath` now also builds the per-tool gate's `AccessPath`, no longer only "cosmetic"), lines ~150–153 (the per-tool gate emits `access-path` on its tool-name surface; the `makeHandler` adapter still maps `path-values` → `surfaceCheck(surface, { path: values[0] })`), and line ~174 (drop the `/ getPlatform()` mention from the `PathNormalizer` exposure note).

## Test Impact Analysis

1. **New tests the change enables:**
   - The per-tool gate denying/asking a symlink whose canonical target matches a per-tool `deny` pattern (e.g. `read: deny *.env` reached via a symlink) — testable at the pipeline level with an intent-kind-dispatching resolver mock.
   - `describeToolGate` deriving the session-approval suggestion from an injected `AccessPath` — a more direct unit than the prior `input` + `cwd` + `platform` derivation.
2. **Tests that become redundant:** none removed; existing lexical-match and cwd-bounding assertions stay valid (lexical aliases are still in `matchValues()`, and `accessPath.value()` equals the old `normalizePathForComparison` result).
3. **Tests that must stay as-is:** the [#438] session-approval cwd-bounding tests in `tool.test.ts` ("binds a current-directory file's session approval to the cwd subtree", "resolves a sub-directory file's session approval to an absolute pattern") — they now pass an `AccessPath` but must keep asserting `/test/project/*` and `/test/project/src/*`; the bash/mcp suggestion and decision-value tests.

## Invariants at risk

This change touches surfaces [#486], [#438], and [#510] refactored.
Documented invariants and their pinning tests:

- **[#486] `path`/`external_directory` match lexical ∪ canonical** — extended (not regressed) to the per-tool surfaces; `path.ts` is untouched.
  Pinned by `test/handlers/gates/path.test.ts` and `test/access-intent/access-path.test.ts`.
- **[#438] session approval is cwd-bounded (absolute, not `./*`)** — preserved: `accessPath.value()` equals the old `normalizePathForComparison(path, cwd, platform)`.
  Pinned by the two cwd-bounding tests in `test/handlers/gates/tool.test.ts` — keep them green with the `AccessPath` argument.
- **[#510] `PathNormalizer` is the single platform/cwd home** — preserved: the per-tool gate now routes its path through `normalizer.forPath`, removing the last `platform` thread into the gate layer.
- **Missing-path `["*"]` fallback** — preserved by routing the no-`input.path` case through the `tool` intent; add/keep a pipeline test for a path-bearing tool with empty input.

## TDD Order

1. **`feat(pi-permission-system)!: match the canonical form on the per-tool path gate`** Test surface: `test/handlers/gates/tool.test.ts` + `test/handlers/gates/tool-call-gate-pipeline.test.ts`.
   Migrate the sixth producer in `tool-call-gate-pipeline.ts` to emit `access-path` for path-bearing tools and pass the `AccessPath` to `describeToolGate`; change `describeToolGate`/`deriveSuggestionValue` to take the optional `accessPath` and read `value()`; remove the `platform` param, the `normalizePathForComparison` import, and the pipeline's `getPlatform()` read.
   These break together at the type level (the `describeToolGate` signature change has a single call site and the test file), so they land in one commit.
   Red: a `read`/`edit` on a symlink whose canonical target matches a per-tool `deny` is now blocked; the cwd-bounding approval tests stay green via the injected `AccessPath`.
   Breaking — `feat!:` with a `BREAKING CHANGE:` footer.
   `ToolCallGateInputs.getPlatform()` / `PermissionSession.getPlatform()` / `makeGateInputs.getPlatform` remain (defined but uncalled — a valid green state); run `pnpm run check` after this commit.

2. **`refactor(pi-permission-system): remove the unused getPlatform session accessor`** Test surface: type-level + `makeGateInputs`.
   Remove `getPlatform()` from `ToolCallGateInputs` and `PermissionSession`, and the `getPlatform` field from `makeGateInputs`.
   These break together (excess-property on the fixture literal once the interface drops the member), so one commit.
   `tsc` + `pnpm fallow dead-code` confirm no remaining consumer.
   Resolves [#513] (close it at ship with a "folded into #502" note).

3. **`docs(pi-permission-system): document canonical per-tool path matching`** Update `docs/architecture/architecture.md` (mark Step 1 ✅ + `S1` node ✅; module entries; residual-`getPlatform()` subsection), `docs/configuration.md`, `README.md`, `.pi/skills/package-pi-permission-system/SKILL.md`, and the `access-intent.ts` doc comment per Module-Level Changes.
   No release impact on its own — rides the breaking `feat!:`.

## Risks and Mitigations

- **Risk: the suggestion value silently drifts from the policy values.**
  Mitigation: `accessPath.value()` is provably identical to the old `normalizePathForComparison(path, cwd, platform)` (same cwd + platform via the session normalizer); the [#438] cwd-bounding tests pin it.
- **Risk: removing `getPlatform()` breaks an unseen consumer.**
  Mitigation: grep confirms exactly three `src/` references and one fixture; `tsc` + `fallow dead-code` gate the removal.
- **Risk: a `prefer-const` / `no-unused-vars` lint snag on the new branch structure.**
  Mitigation: if the two-`let` form trips a linter, extract a small `selectToolCheck` helper returning `{ accessPath, toolCheck }` (Code Design stepdown).
- **Risk: an existing user's per-tool rule starts matching a previously-unmatched symlinked path on upgrade.**
  This is the intended breaking behavior; mitigation is the `BREAKING CHANGE:` footer and the docs update describing the new symlink-resistant per-tool matching.

## Open Questions

- **Close [#513] when this ships.**
  Its scope (the `getPlatform()` removal) is folded into Step 2 here; no separate change remains, so close it at ship time with a pointer to the [#502] SHA.
- No other blocking questions.
  The residual Phase 7 scope (Steps 2–5) is unaffected; this plan only completes Step 1 and the [#513] cleanup it forces.

[#438]: https://github.com/gotgenes/pi-packages/issues/438
[#486]: https://github.com/gotgenes/pi-packages/issues/486
[#487]: https://github.com/gotgenes/pi-packages/issues/487
[#503]: https://github.com/gotgenes/pi-packages/issues/503
[#504]: https://github.com/gotgenes/pi-packages/issues/504
[#510]: https://github.com/gotgenes/pi-packages/issues/510
[#511]: https://github.com/gotgenes/pi-packages/issues/511
[#513]: https://github.com/gotgenes/pi-packages/issues/513
