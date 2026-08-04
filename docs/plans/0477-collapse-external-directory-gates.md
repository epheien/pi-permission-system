---
issue: 477
issue_title: "pi-permission-system: collapse the two external-directory gates onto one AccessPath policy check (Phase 6 Step 5)"
---

# Collapse the two external-directory gates onto one AccessPath policy check

## Release Recommendation

**Release:** ship now — batch "access-path-unification" tail (this issue completes the batch)

This issue is Phase 6 Step 5, the tail of the two-member release batch "access-path-unification" (Steps 4 and 5).
Step 4 ([#476]) landed the `AccessPath` value object but left the duplicated external-directory policy logic in place — a transitional state the roadmap explicitly defers shipping until Step 5 collapses it.
Its release-please PR (#485) was held open by Step 4's `mid-batch — defer` marker; landing this step completes the batch, so both ship together.

## Problem Statement

`describeExternalDirectoryGate` (the single-tool path) and `describeBashExternalDirectoryGate` (the multi-path bash command path) each independently derive a path's `external_directory` policy.
Both call `resolver.resolvePathPolicy(path.matchValues(), agentName, "external_directory")` — the alias-derivation-plus-surface-tagged resolve that the [#418] fix introduced — and the bash gate additionally selects the worst uncovered path.
Because the same `external_directory` resolution lives in two places, the [#418] lexical/canonical conflation bug was acquired twice and had to be fixed twice.
Once `AccessPath` ([#476]) exists to hold the typed and canonical forms behind distinct accessors, the policy-resolution line belongs in one place with both gates delegating to it.

## Goals

- Single-source the `external_directory` policy resolution (`resolvePathPolicy(path.matchValues(), agentName, "external_directory")`) so the [#418]-prone line exists exactly once.
- Route both gate factories through the shared helper, removing the duplicated inline logic.
- Preserve behavior exactly — no change to any allow/ask/deny decision, log shape, or descriptor.
- This change is **not breaking**: it is a behavior-preserving internal refactor with no change to config, output shape, or defaults.

## Non-Goals

- Merging the two gate *functions* into one.
  The gates have genuinely different control flow (the single gate does an infra-read bypass and an outside-CWD boundary check, always emits a descriptor; the bash gate filters N paths to uncovered and early-bypasses when all are covered) and remain two separate pipeline producers — only the duplicated policy-check logic is collapsed.
- Narrowing `ScopedPermissionResolver` to a single `resolve(intent)` — that is Phase 6 Step 6 ([#478]).
- Extracting shared test fixtures for the external-directory integration tests — that is Phase 6 Step 8 ([#480]), which targets the collapsed gate this step produces.
- Touching the outside-CWD boundary derivation (`isPathOutsideWorkingDirectory`, `BashProgram.externalPaths()`), the infra-read bypass, or message formatting.

## Background

Relevant modules under `packages/pi-permission-system/`:

- `src/handlers/gates/external-directory.ts` — `describeExternalDirectoryGate`: extracts one tool-input path, checks the outside-CWD boundary, bypasses Pi infrastructure reads, builds an `AccessPath`, resolves its `external_directory` policy as `preCheck`, and emits a single-pattern descriptor.
- `src/handlers/gates/bash-external-directory.ts` — `describeBashExternalDirectoryGate`: reads `AccessPath[]` from the injected `BashProgram.externalPaths()`, resolves each path's `external_directory` policy, filters to uncovered (state ≠ `allow`), early-bypasses when all are covered, selects the worst uncovered via `pickMostRestrictive`, and emits a multi-pattern descriptor.
- `src/access-intent/access-path.ts` — `AccessPath` value object ([#476]): `matchValues()` (lexical alias union ∪ canonical, the [#418] match set), `boundaryValue()` (canonical, for the outside-CWD boundary and infra-read containment), `value()` (lexical display form).
- `src/handlers/gates/candidate-check.ts` — `pickMostRestrictive(results)`: selects the worst (`deny` > `ask` > `allow`) `PermissionCheckResult`, first-occurrence-wins on ties.
  Already shared by the bash path, bash command, and bash external-directory gates.

Constraints from AGENTS.md and the package skill that apply:

- Run `pnpm fallow dead-code` locally before pushing — a new export with no live consumer fails the CI gate.
  The new helper functions must land with their gate consumers, not as a standalone pure-addition commit.
- Biome's `noUnusedImports` is warning-level (exit 0), so the pre-completion reviewer is the only backstop for orphaned imports left after the bash gate's inline logic is removed.
- When a gate resolves through a resolver method, the test fixture must wire it through the same surface dispatcher in `makeHandler` — the helper makes the same `resolvePathPolicy(..., "external_directory")` call the gates made, so the existing `makeHandler` wiring already covers it.

## Design Overview

### Decision model

The truly shared, [#418]-prone operation is resolving a single `AccessPath`'s `external_directory` policy: `resolver.resolvePathPolicy(path.matchValues(), agentName, "external_directory")`.
Worst-path selection is inherently bash-only — the single-tool gate has exactly one path and no selection to make.
Per the operator's design decision, the helper is **two focused functions sharing a private per-path core** rather than one combined helper over `AccessPath[]` returning a wide result object (which each consumer would read only a subset of — a dependency-width smell).

### New module

`src/handlers/gates/external-directory-policy.ts`:

```typescript
import type { AccessPath } from "#src/access-intent/access-path";
import type { ScopedPermissionResolver } from "#src/permission-resolver";
import type { PermissionCheckResult } from "#src/types";
import { pickMostRestrictive } from "./candidate-check";

/** An external path whose resolved external_directory state is not "allow". */
export interface UncoveredExternalPath {
  path: AccessPath;
  check: PermissionCheckResult;
}

/** The uncovered external paths plus the most restrictive check among them. */
export interface UncoveredExternalPaths {
  uncovered: UncoveredExternalPath[];
  /** Worst check among uncovered paths; undefined only when none are uncovered. */
  worstCheck: PermissionCheckResult | undefined;
}

/**
 * Resolve one external path's policy on the `external_directory` surface.
 *
 * Matches against the typed and symlink-resolved aliases (AccessPath.matchValues())
 * so a config pattern on either form applies (#418). Single source for the
 * alias-derivation + surface-tagged resolve the two gates previously duplicated.
 */
export function resolveExternalDirectoryPolicy(
  path: AccessPath,
  resolver: ScopedPermissionResolver,
  agentName: string | undefined,
): PermissionCheckResult {
  return resolver.resolvePathPolicy(
    path.matchValues(),
    agentName,
    "external_directory",
  );
}

/**
 * Resolve a set of external paths and select those not already allowed.
 *
 * Filters on state (not source) so config-level allow rules suppress the prompt
 * just as session-level allow rules do; returns the most restrictive uncovered
 * check so a config "deny" is not downgraded to the catch-all "ask".
 */
export function selectUncoveredExternalPaths(
  paths: readonly AccessPath[],
  resolver: ScopedPermissionResolver,
  agentName: string | undefined,
): UncoveredExternalPaths {
  const uncovered: UncoveredExternalPath[] = [];
  for (const path of paths) {
    const check = resolveExternalDirectoryPolicy(path, resolver, agentName);
    if (check.state !== "allow") {
      uncovered.push({ path, check });
    }
  }
  return {
    uncovered,
    worstCheck: pickMostRestrictive(uncovered.map(({ check }) => check)),
  };
}
```

### Consumer call sites

Single-tool gate (`external-directory.ts`) — the boundary check, `AccessPath` construction, and infra-read bypass are unchanged; only the inline `resolvePathPolicy` call is replaced:

```typescript
const accessPath = AccessPath.forExternalDirectory(externalDirectoryPath, tcc.cwd);
// ... infra-read bypass on accessPath.boundaryValue() (unchanged) ...
// The runner consumes this preCheck and skips its own resolve.
const preCheck = resolveExternalDirectoryPolicy(
  accessPath,
  resolver,
  tcc.agentName ?? undefined,
);
```

Bash gate (`bash-external-directory.ts`) — the inline loop and worst-selection are replaced by one call:

```typescript
const { uncovered: uncoveredEntries, worstCheck } = selectUncoveredExternalPaths(
  externalPaths,
  resolver,
  tcc.agentName ?? undefined,
);
const uncoveredPaths = uncoveredEntries.map(({ path }) => path.value());
if (uncoveredPaths.length === 0) {
  return { action: "allow", /* session_approved log (unchanged) */ };
}
const preCheck = worstCheck ?? uncoveredEntries[0].check;
```

### Upstream-interaction check

The helper reads `path.matchValues()` (Tell-Don't-Ask compliant — `AccessPath` owns its alias derivation) and calls `resolver.resolvePathPolicy` and `pickMostRestrictive`.
It mutates no received argument, performs no reverse search, and carries no output-argument pattern from the original gates.
`ScopedPermissionResolver` is the resolver interface the gates already depend on — no widening.
`resolveExternalDirectoryPolicy` reads only `AccessPath.matchValues()`; `selectUncoveredExternalPaths` reads only `AccessPath.matchValues()` (via the per-path core) and `.value()` is read by the caller, not the helper — ISP-clean.

### Edge cases

- Empty `externalPaths` in the bash gate is handled *before* the helper call (the gate returns `null`); `selectUncoveredExternalPaths([])` would return `{ uncovered: [], worstCheck: undefined }`, but that path is unreachable.
- After the early bypass, `uncoveredEntries.length > 0`, so `worstCheck` is defined; TypeScript cannot narrow that across the early return, so the `?? uncoveredEntries[0].check` fallback is retained exactly as today.
- The single-tool gate does not filter on `allow` — it always emits a descriptor with `preCheck`, and the runner handles the allow.
  This is why the per-path `resolveExternalDirectoryPolicy` (not the filtering `selectUncoveredExternalPaths`) is the right fit for that gate.

## Module-Level Changes

- `src/handlers/gates/external-directory-policy.ts` — **new**.
  Exports `resolveExternalDirectoryPolicy`, `selectUncoveredExternalPaths`, and the `UncoveredExternalPath` / `UncoveredExternalPaths` interfaces.
- `src/handlers/gates/external-directory.ts` — replace the inline `resolver.resolvePathPolicy(accessPath.matchValues(), …, "external_directory")` call with `resolveExternalDirectoryPolicy(accessPath, resolver, …)`; add the helper import.
  `AccessPath` (the class) stays imported — still used for `AccessPath.forExternalDirectory` and `boundaryValue()`.
- `src/handlers/gates/bash-external-directory.ts` — replace the inline uncovered-collection loop and `pickMostRestrictive` worst-selection with one `selectUncoveredExternalPaths(...)` call.
  Remove three imports that become orphaned: `AccessPath` (only used in the inline array-entry type), `PermissionCheckResult` (same), and `pickMostRestrictive` (now called inside the helper).
- `docs/architecture/architecture.md` — doc updates (see below).
- No README change: README documents the user-facing `external_directory` surface and config, not internal gate symbols (verified by grep — only config/precedence prose, no symbol references).
- No package SKILL change: the skill's external-directory reference (line 150) describes behavior ("both external-directory gates pass `external_directory` … to match a path's typed and symlink-resolved aliases (#418)") that remains accurate — both gates still drive that resolution, now via the shared helper (verified by grep — no removed symbol the skill names).

### Architecture doc updates (`docs/architecture/architecture.md`)

- Reword the `external-directory.ts` tree entry to note the policy resolution now delegates to `resolveExternalDirectoryPolicy` (from the new `external-directory-policy.ts`).
- Reword the `bash-external-directory.ts` tree entry to note it delegates to `selectUncoveredExternalPaths` (which owns the per-path resolve and `pickMostRestrictive` worst-selection) instead of resolving and selecting inline.
- Add a tree entry for the new `external-directory-policy.ts` module under `handlers/gates/`.
- Apply the ✅ completion marker to the Step 5 ([#477]) heading and to the `S5` node in the Phase 6 Mermaid diagram (per the package convention of marking a roadmap step complete as part of the change that lands it, as Step 4 did).

## Test Impact Analysis

1. **Newly enabled** — `test/handlers/gates/external-directory-policy.test.ts` (new) can unit-test the policy resolution directly, which was previously only reachable through each gate's full descriptor assembly:
   - `resolveExternalDirectoryPolicy` calls `resolvePathPolicy` with `path.matchValues()` and the `"external_directory"` surface ([#418]).
   - `selectUncoveredExternalPaths` filters out `allow` results, collects uncovered entries, and returns the worst uncovered (config `deny` not downgraded to catch-all `ask`, [#393]); returns `{ uncovered: [], worstCheck: undefined }` for an all-allowed set.
2. **Redundant but retained** — the gate-level [#418] alias assertions (`external-directory.test.ts` line 137; `bash-external-directory.test.ts` line 79) and the bash worst-check assertions (lines 136, 220) are now also backstopped by the helper unit tests.
   They stay as-is: they pin the gate → helper wiring and the gates' full descriptor assembly (sessionApproval shape, denialContext, decision value), which the helper tests do not cover.
   This is behavior-preserving — no gate test is rewritten.
3. **Must stay as-is** — both gate test files genuinely exercise the gate layer (descriptor assembly, infra bypass, early bypass, message formatting) and are unaffected by the extraction.
   The existing `makeHandler` surface dispatcher already routes the `"external_directory"` resolve, so integration tests (`external-directory-integration.test.ts`, `external-directory-session-dedup.test.ts`, `external-directory-symlink-acceptance.test.ts`) stay green unchanged.

## Invariants at risk

This step touches the external-directory surface that [#418], [#382], [#393], and [#476] (Step 4) refactored.
The extraction preserves each invariant; each is already pinned by a test that stays green:

| Invariant                                                                    | Source | Pinned by (stays green)                                                |
| ---------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| Both gates match on `external_directory` against typed ∪ canonical aliases   | [#418] | `external-directory.test.ts:137`; `bash-external-directory.test.ts:79` |
| Config `deny` not downgraded to catch-all `ask` (worst uncovered wins)       | [#393] | `bash-external-directory.test.ts:136,220`                              |
| `matchValues()` for matching, `boundaryValue()` for the boundary/infra check | [#476] | `external-directory.test.ts` boundary/infra cases (unchanged)          |
| Win32-lowercased canonical boundary                                          | [#382] | `external-directory-symlink-acceptance.test.ts`                        |

No new test is needed to guard an invariant living only in prose — all four are already test-pinned, and the new helper unit tests additionally lower-source the [#418] and [#393] invariants.

## TDD Order

1. **Collapse the duplicated policy logic into the shared helper** (red → green → one commit).
   - Red: add `test/handlers/gates/external-directory-policy.test.ts` asserting `resolveExternalDirectoryPolicy` resolves on the `external_directory` surface with `matchValues()`, and `selectUncoveredExternalPaths` filters `allow` and returns the worst uncovered.
   - Green: add `src/handlers/gates/external-directory-policy.ts`; rewire `external-directory.ts` (single-path) and `bash-external-directory.ts` (multi-path) to delegate; remove the bash gate's three orphaned imports (`AccessPath`, `PermissionCheckResult`, `pickMostRestrictive`).
   - This is one atomic commit: `fallow dead-code` flags an unconsumed export, so the helper must land with both gate consumers in the same commit; the gate test files are untouched (behavior-preserving), so no large test rewrite is involved.
   - Verify: `pnpm --filter @gotgenes/pi-permission-system run check`, full `vitest run` (all external-directory tests green), `pnpm fallow dead-code` (no new dead export, `pickMostRestrictive` still has live callers in `bash-command.ts`, `bash-path.ts`, and the new helper).
   - Suggested commit: `refactor(pi-permission-system): collapse external-directory gates onto a shared policy helper (#477)`.
2. **Update the architecture roadmap** (docs commit).
   - Reword the `external-directory.ts` and `bash-external-directory.ts` tree entries to note delegation; add the `external-directory-policy.ts` tree entry; apply ✅ to the Step 5 heading and the `S5` Mermaid node.
   - Verify: `pnpm --filter @gotgenes/pi-permission-system run lint` (rumdl), and a grep that no architecture prose still describes the inline duplication in the present tense.
   - Suggested commit: `docs(pi-permission-system): mark Phase 6 Step 5 complete (#477)`.

## Risks and Mitigations

- **Risk:** orphaned imports left in the bash gate after removing its inline logic (Biome `noUnusedImports` is warning-level, exit 0).
  **Mitigation:** the TDD step explicitly enumerates the three imports to remove; the pre-completion reviewer and `tsc` (`AccessPath`/`PermissionCheckResult` become unused type imports — `tsc` does not error on those, so this relies on the reviewer and an explicit re-read of the file) guard it.
- **Risk:** `fallow dead-code` flags a helper export if a gate is not actually rewired.
  **Mitigation:** single atomic commit lands the helper with both consumers; `pnpm fallow dead-code` runs in the step's verify.
- **Risk:** silently changing the bash gate's worst-check fallback semantics.
  **Mitigation:** the `worstCheck ?? uncoveredEntries[0].check` fallback is preserved verbatim; the [#393] worst-check tests stay green.

## Open Questions

None.
No follow-up issues are introduced by this plan — Steps 6 ([#478]) and 8 ([#480]) are already filed and tracked in the roadmap.

[#382]: https://github.com/gotgenes/pi-packages/issues/382
[#393]: https://github.com/gotgenes/pi-packages/issues/393
[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#476]: https://github.com/gotgenes/pi-packages/issues/476
[#478]: https://github.com/gotgenes/pi-packages/issues/478
[#480]: https://github.com/gotgenes/pi-packages/issues/480
