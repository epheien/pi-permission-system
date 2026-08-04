---
issue: 249
issue_title: "Bash external-directory gate ignores config-level allow rules for /tmp/* paths"
---

# Fix bash external-directory gate config-level allow bypass

## Problem Statement

The bash external-directory gate in `bash-external-directory.ts` ignores config-level `"allow"` rules when filtering uncovered paths.
A config like `"/tmp/*": "allow"` should suppress the permission prompt for bash commands referencing `/tmp/` paths, but instead the prompt fires every time.
This is especially disruptive for subagents that run tools writing to `/tmp/`.

## Goals

- Config-level `"allow"` rules for `external_directory` patterns suppress the prompt, matching behavior of `read`/`write` tool calls to the same paths.
- Config-level `"deny"` rules for `external_directory` patterns produce a deny outcome (not a downgraded "ask").
- Consistent with how `path.ts` and `bash-path.ts` handle config-level allow/deny.

## Non-Goals

- Changing `bash-path.ts` — it already uses `check.state` for filtering and is not affected.
- Changing the `path.ts` gate — it already returns `null` on `state === "allow"`.
- Refactoring the bypass log event names (cosmetic; defer).

## Background

### Root cause

The `uncoveredPaths` filter in `describeBashExternalDirectoryGate` checks `source !== "session"`:

```typescript
const uncoveredPaths = externalPaths.filter(
  (p) =>
    checkPermission("external_directory", { path: p }, agentName, bashSessionRules)
      .source !== "session",
);
```

For `external_directory`, `deriveSource()` in `permission-manager.ts` always returns `"special"` for non-session rules (because the surface is in `SPECIAL_PERMISSION_KEYS`).
A config rule like `"/tmp/*": "allow"` produces `{ state: "allow", source: "special" }`, which fails the `source !== "session"` check and is treated as uncovered.

### Secondary issue

The path-less `extCheck` call (`checkPermission("external_directory", {}, agentName)`) always evaluates against the `"*"` catch-all.
When uncovered paths include a `"deny"` pattern, the descriptor's `preCheck` reports `"ask"` (from the catch-all) instead of `"deny"`, downgrading the restriction.

### Sibling gate comparison

- `path.ts`: checks `check.state === "allow"` to bypass — correct.
- `bash-path.ts`: uses `check.state` for deny/ask tracking and `source` only for bypass log semantics — correct.
- `bash-external-directory.ts`: uses `source` for filtering — **buggy**.

## Design Overview

### Fix 1 — Filter by state, not source

Change the `uncoveredPaths` filter from `source !== "session"` to `state !== "allow"`.
Any path that resolves to `"allow"` — whether from config, session, or any other source — is excluded from the uncovered set.

```typescript
const uncoveredPaths = externalPaths.filter((p) => {
  const result = checkPermission(
    "external_directory",
    { path: p },
    tcc.agentName ?? undefined,
    bashSessionRules,
  );
  return result.state !== "allow";
});
```

### Fix 2 — Use worst uncovered path for preCheck

Replace the path-less `extCheck` with the most restrictive check among uncovered paths.
This ensures `deny` rules produce a deny descriptor, not a downgraded `"ask"`.

Reuse check results from the filter to avoid double evaluation:

```typescript
const uncoveredEntries: Array<{ path: string; check: PermissionCheckResult }> = [];
for (const p of externalPaths) {
  const check = checkPermission(
    "external_directory",
    { path: p },
    tcc.agentName ?? undefined,
    bashSessionRules,
  );
  if (check.state !== "allow") {
    uncoveredEntries.push({ path: p, check });
  }
}

if (uncoveredEntries.length === 0) {
  // All paths allowed — bypass
  return { action: "allow", log: { ... } };
}

const uncoveredPaths = uncoveredEntries.map(({ path }) => path);

// Most restrictive check: deny > ask
const worstCheck = uncoveredEntries.reduce((worst, { check }) => {
  if (check.state === "deny") return check;
  if (worst.state === "deny") return worst;
  return worst; // both "ask" — keep first
}, uncoveredEntries[0].check);
```

The descriptor uses `worstCheck` as `preCheck` instead of the old `extCheck`.

## Module-Level Changes

### `src/handlers/gates/bash-external-directory.ts`

1. Replace the `uncoveredPaths` filter with a loop that collects `{ path, check }` entries where `check.state !== "allow"`.
2. Remove the path-less `extCheck` call.
3. Compute `worstCheck` from the collected entries (deny > ask).
4. Use `worstCheck` as the descriptor's `preCheck`.
5. Remove the `PermissionCheckResult` import if it was only needed for the old `extCheck` type — verify.

### `test/handlers/gates/bash-external-directory.test.ts`

1. Update "uses config-level checkPermission for the policy state" — this test asserts the buggy behavior (config-level `allow` paths remain uncovered).
   After the fix, config-level `allow` causes a bypass.
   Rename and rewrite to verify config-level `allow` produces a `GateBypass`.
2. Add a new test: config-level `deny` for a specific path produces a `GateDescriptor` with `preCheck.state === "deny"`.
3. Add a new test: mixed paths — one config-allowed, one config-ask — produces a descriptor with only the ask path.
4. Add a new test: mixed paths — one config-denied, one config-ask — produces a descriptor with `preCheck.state === "deny"` (worst wins).
5. Verify "only includes uncovered paths when some are session-covered" still passes (it should — session `allow` is still filtered out by `state !== "allow"`).

## Test Impact Analysis

1. The filter fix enables testing config-level policy integration directly on the descriptor factory, which was previously impossible because all non-session sources were treated identically.
2. The test "uses config-level checkPermission for the policy state" becomes redundant since its scenario (config allow → still uncovered) is the bug.
   It is replaced by a config-allow bypass test.
3. All other existing tests remain valid — they exercise session-approved bypass, descriptor structure, and denial context, none of which change.

## TDD Order

1. **Red → Green:** Update the test "uses config-level checkPermission for the policy state" to expect a `GateBypass` when all paths are config-allowed.
   Add a test for config-level `deny` producing a `GateDescriptor` with `preCheck.state === "deny"`.
   Implement the filter + worst-check changes in `bash-external-directory.ts`.
   Commit: `fix: respect config-level allow/deny in bash external-directory gate (#249)`

2. **Green → Green:** Add tests for mixed-state paths (config-allow + config-ask, config-deny + config-ask).
   Verify they pass with the implementation from step 1.
   Commit: `test: add mixed-state path tests for bash external-directory gate (#249)`

## Risks and Mitigations

1. **Bypass log says "session_approved" for config-allowed paths.**
   The bypass `GateBypass` log event uses `"permission_request.session_approved"` and `resolution: "session_approved"`.
   After the fix, config-allowed paths also produce this bypass.
   The log text is slightly misleading but functionally harmless — the gate correctly allows access.
   A follow-up could introduce a distinct event, but it is not blocking.
   Mitigated: documented as non-goal.

2. **Double `checkPermission` call eliminated.**
   The old code called `checkPermission` once per path in the filter, then once more (path-less) for `extCheck`.
   The new code calls once per path and reuses the result.
   This is strictly fewer calls — no regression risk.

## Open Questions

None — the fix direction is specified in the issue and consistent with sibling gates.
