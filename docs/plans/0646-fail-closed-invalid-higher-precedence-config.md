---
issue: 646
issue_title: "pi-permission-system: invalid higher-precedence config inherits lower-scope allow rules"
---

# Fail closed when a higher-precedence config scope is invalid

## Release Recommendation

**Release:** ship independently

This issue is not part of any architecture-roadmap phase (no `(#646)` step in `docs/architecture/architecture.md`), so it carries no batch tag and ships on its own.
It is a self-contained security fix to the config-composition path.

## Problem Statement

When a higher-precedence scope (project, per-agent, or project-agent) config fails to load or validate, the loader records the problem but substitutes an **empty** scope.
`mergeScopesWithOrigins` skips an empty scope (`if (!scope.permission) continue;`), so policy composition inherits the lower-precedence configuration unchanged.

This can fail **open** relative to the user's intended policy: if the global scope allows a tool and a project scope was meant to deny it but contains a typo or invalid field, the effective result stays the global `allow` instead of being clamped to `ask` or `deny`.
The startup warning is emitted, but a warning alone must not leave a permissive effective policy in place.

The [#547] strict-validation "fail-closed" is only correct for a **single** scope in isolation — an invalid scope's *missing* surfaces fall through to the universal `ask` default.
It does not clamp a *lower* scope's **explicit** `allow`, which is exactly the cross-scope gap this issue identifies.

## Goals

- When a **non-global** scope (project, agent, project-agent) fails to load or validate, floor the composed effective policy so nothing resolves more permissively than `ask` — `allow` → `ask`, while `deny` and `ask` pass through unchanged.
- Keep the existing per-issue validation warnings, and add a distinct notice explaining that the effective policy has been clamped fail-closed.
- Preserve a hard `deny`: the clamp only removes permissive `allow`, it never weakens a deny.
- This is a **breaking change** (`fix(pi-permission-system)!:`): a session that previously inherited a lower-scope `allow` behind an invalid higher scope will now prompt (`ask`) for those surfaces on upgrade, without a user edit.

## Non-Goals

- No change to the tolerant per-key handling of agent frontmatter: `normalizeFlatPermissionValue` still drops individual malformed `permission` entries silently.
  Only a whole-file read/parse failure of an **existing** agent file counts as an invalid scope.
- No fail-closed trigger for an invalid **global** scope: global is the lowest precedence, so nothing more permissive is inherited when it fails, and `#547` already routes its missing surfaces to the universal `ask` default.
- No opt-out config knob: the clamp is always-on (operator decision).
  No new schema field, and no `schemas/permissions.schema.json` regeneration.
- No change to yolo semantics: yolo (`rewriteAsksToYolo`) remains an explicit full-permissive opt-in applied at check time (see Risks).
- No hard "refuse to activate / universal deny" behavior: the operator chose the proportionate `allow`→`ask` overlay, not a session-wide block.

## Background

Relevant modules:

- `src/config-loader.ts` — `validateUnifiedConfig` returns `{ config: {}, issues }` on a schema/JSON failure; `loadUnifiedConfig` returns `{ config: {}, issues: [] }` for an **absent** file and a non-empty `issues` array only for a **present-but-invalid** file.
  So `issues.length > 0` from `loadUnifiedConfig` distinguishes present-invalid from absent.
- `src/policy-loader.ts` — `FilePolicyLoader.loadProjectConfig` builds a `ScopeConfig` from `config.permission` and drops the fact that the file was rejected; `loadScopeConfigFrom` (agent / project-agent) catches any read/parse error and returns `{}`, losing the same signal.
- `src/scope-merge.ts` — `mergeScopesWithOrigins` merges permission maps lowest → highest precedence and skips a scope with no `permission`.
- `src/permission-manager.ts` — `resolvePermissions` loads the four scopes, merges them, composes the ruleset (defaults → baseline → config), caches by `getCacheStamp` (file mtimes), and appends session rules at `check()` time.
  `getToolPermission` and `getComposedConfigRules` read the same cached composition; `getConfigIssues` returns the loader's accumulated issues.
- `src/rule.ts` — `RuleOrigin` union and `rewriteAsksToYolo` (a pure, non-mutating composition-stage overlay that rewrites `ask` → `allow` tagged `origin: "yolo"`).
  This is the exact mirror image of the overlay this plan adds.
- `src/handlers/lifecycle.ts` — `handleSessionStart` surfaces `getConfigIssues` via `logger.warn`, so any notice appended there reaches the user at session start.

Constraints from AGENTS.md / the package skill:

- `docs/architecture/architecture.md` inline-copies the `RuleOrigin` union; adding a value must update that listing in the same commit.
- Default to least privilege — when in doubt, prompt (`ask`).
- The `check()` path applies the yolo rewrite **post-cache**; the fail-closed overlay is applied **at composition** so the display surfaces (`getComposedConfigRules`, `getToolPermission`) also reflect the clamp.

## Design Overview

### Carry the "invalid scope" signal

Add one optional field to `ScopeConfig` (`src/types.ts`):

```typescript
export interface ScopeConfig {
  permission?: FlatPermissionConfig;
  /**
   * True when the scope's config file was present but failed to load or
   * validate (JSON parse error or schema rejection). Absent and valid files
   * leave this unset. Drives the fail-closed allow→ask clamp for non-global
   * scopes.
   */
  invalid?: boolean;
}
```

The loader is the single decision point for `invalid` (decide-once): a `ScopeConfig` is either produced valid, empty-absent, or present-invalid, and downstream code never re-derives the condition.

### Populate it in the loader

- `FilePolicyLoader.loadProjectConfig` — set `invalid: issues.length > 0` from the `loadUnifiedConfig` result.
  A missing project file yields `issues: []` → `invalid` stays unset; a rejected file yields issues → `invalid: true`.
- `FilePolicyLoader.loadScopeConfigFrom` (agent / project-agent) — distinguish absent from present-but-unreadable.
  When `getFileStamp(filePath) === "missing"` the file is absent → return `{}` (not invalid).
  Otherwise read; on a thrown read/parse error of the existing file, return `{ invalid: true }`.
  A file that exists but has no frontmatter (`extractFrontmatter` → `null`) is a valid empty scope, **not** invalid.
- `loadGlobalConfig` is left unchanged — global never triggers the clamp.

### Floor allow → ask at composition

Add a pure overlay to `src/rule.ts`, mirroring `rewriteAsksToYolo`:

```typescript
export function floorAllowsToAsk(rules: Ruleset): Ruleset {
  return rules.map((rule) =>
    rule.action === "allow"
      ? { ...rule, action: "ask", origin: "fail-closed" }
      : rule,
  );
}
```

Extend `RuleOrigin` with `"fail-closed"`.
`deriveSource` keys on `rule.layer` and tool kind, **not** on `origin`, so the new origin does not ripple into source derivation; the floored rule keeps its `layer` (e.g. `"config"`) and derives the correct `source`.
The runner's yolo auto-approve check (`check.origin === "yolo"`) simply does not match `"fail-closed"`, so a floored decision prompts normally.

### Apply the clamp and surface the notice in the manager

`ResolvedPermissions` gains the invalid scope names so both the ruleset and the notice derive from one resolution:

```typescript
type ResolvedPermissions = {
  composedRules: Ruleset;
  /** Non-global scopes whose config failed to load — drives the clamp + notice. */
  failClosedScopes: RuleOrigin[];
};
```

In `resolvePermissions`, after composing:

```typescript
const failClosedScopes: RuleOrigin[] = [];
if (projectConfig.invalid === true) failClosedScopes.push("project");
if (agentConfig.invalid === true) failClosedScopes.push("agent");
if (projectAgentConfig.invalid === true) failClosedScopes.push("project-agent");

const effectiveRules =
  failClosedScopes.length > 0 ? floorAllowsToAsk(composedRules) : composedRules;
```

Applying at composition (not at `check()`) means `getToolPermission` and `getComposedConfigRules` see the clamp too: a formerly-allowed tool becomes `ask`, so it stays **visible** to the agent (ask tools are not hidden) rather than being silently allowed.

`getConfigIssues` reads the cached resolution and appends a clear notice when the clamp is active, so the warning is not just retained but strengthened:

```typescript
getConfigIssues(agentName?: string): string[] {
  const { failClosedScopes } = this.resolvePermissions(agentName);
  const issues = [...this.loader.getConfigIssues()];
  if (failClosedScopes.length > 0) {
    issues.push(
      `Invalid ${failClosedScopes.join(", ")} configuration detected — failing ` +
        `closed: 'allow' rules are clamped to 'ask' for this session until the ` +
        `configuration is corrected.`,
    );
  }
  return issues;
}
```

### Consumer call site (composition parity)

The three read surfaces all flow through the one clamped resolution — no consumer re-derives the condition:

```typescript
// resolvePermissions() → { composedRules: floored, failClosedScopes }
manager.getToolPermission("bash");        // "ask" (was "allow") under an invalid project scope
manager.check(bashIntent);                // resolves "ask"
manager.getComposedConfigRules();         // shows the floored rules (origin "fail-closed")
manager.getConfigIssues(agentName);       // loader issues + the fail-closed notice
```

### Edge cases

- Invalid global only → no clamp (excluded), existing `#547` behavior unchanged.
- Invalid project scope + global `bash: allow` → bash resolves `ask` (the reproduction in the issue).
- Invalid project scope + global `bash: deny` → stays `deny` (deny preserved).
- Absent project/agent file → not invalid, no clamp.
- Agent file present but with a malformed single `permission` entry → tolerant drop, **not** invalid (Non-Goal).
- Session rules are appended in `check()` **after** `resolvePermissions`, so a runtime "allow once" grant is not floored — the clamp targets config inheritance only.
- yolo enabled + invalid scope → the composition floors `allow` → `ask`, then `check()` rewrites `ask` → `allow` under yolo; yolo users are unaffected (documented, intentional — yolo is an explicit full-permissive opt-in and can only ever produce `allow` from `ask`).

## Module-Level Changes

- `src/types.ts` — add the optional `invalid?: boolean` field to `ScopeConfig` with a doc comment.
- `src/rule.ts` — add `"fail-closed"` to the `RuleOrigin` union (and its doc comment); add the pure `floorAllowsToAsk` overlay below `rewriteAsksToYolo`.
- `src/policy-loader.ts` — set `invalid` in `loadProjectConfig` (from `issues.length > 0`) and in `loadScopeConfigFrom` (absent vs. present-but-unreadable split, guarded on `getFileStamp === "missing"`).
- `src/permission-manager.ts` — add `failClosedScopes` to `ResolvedPermissions`; compute it and apply `floorAllowsToAsk` in `resolvePermissions`; import `floorAllowsToAsk`; append the fail-closed notice in `getConfigIssues`.
- `docs/architecture/architecture.md` — update the inline `RuleOrigin` copy (lines ~39–47) to include `"fail-closed"`; update the `config-loader.ts` / composition narrative if it states the invalid-scope behavior.
- `docs/configuration.md` — document the cross-scope fail-closed clamp near `## Merge Precedence` and/or the existing `#### Fail-closed behavior` section (an invalid non-global scope floors `allow` → `ask` for the whole session).
- `docs/migration/strict-config-validation.md` — add a section noting the cross-scope hardening: a rejected higher-precedence scope now clamps inherited `allow` to `ask` (the `#547` doc's "surfaces fall back to ask — never allow" line was only true in single-scope isolation).
- `README.md` — update the migration-table row description for strict config validation to mention the cross-scope hardening (no new row needed).
- `.pi/skills/package-pi-permission-system/SKILL.md` — extend the "Config files are validated strictly … rejected fail-closed on any invalid field (empty scope → universal `ask`)" bullet to note that an invalid **non-global** scope additionally floors `allow` → `ask` across the composed policy.

No schema change: no new config field, so `schemas/permissions.schema.json` and `pnpm run gen:schema` are untouched.

## Test Impact Analysis

1. New unit tests the change enables:
   - `test/rule.test.ts` — `floorAllowsToAsk`: `allow` → `ask`, `deny` unchanged, `ask` unchanged, origin becomes `"fail-closed"`, purity/non-mutation, `surface`/`pattern`/`layer` preserved (mirrors the existing `rewriteAsksToYolo` block).
   - `test/policy-loader.test.ts` — `loadProjectConfig` sets `invalid: true` on a rejected file and leaves it unset for an absent/valid file; `loadScopeConfigFrom` (agent) sets `invalid: true` for a present-but-unreadable file and `{}` for a missing file.
   - `test/permission-manager-unified.test.ts` (or a new `test/permission-manager-fail-closed.test.ts`) — via `createInMemoryManager`, an invalid non-global scope floors a lower-scope `allow` to `ask`, preserves a lower-scope `deny`, and an invalid **global** scope does **not** floor; `getConfigIssues` includes the fail-closed notice naming the invalid scope(s).
2. Existing tests that become redundant: none.
   The `#547` single-scope "empty scope → universal ask" tests still hold — the clamp is additive and only fires for invalid non-global scopes.
3. Tests that must stay as-is: the existing `scope-merge` and single-scope validation tests genuinely exercise the merge/validation layers underneath the new clamp and remain valid.

## Invariants at risk

- [#526] yolo invariant — "yolo is deny-preserving; an `ask` becomes a standing `allow`."
  The fail-closed overlay floors to `ask`, which yolo then rewrites to `allow`; this must not change yolo's deny-preservation.
  Pin with a test asserting: invalid scope + yolo → a floored surface resolves `allow` (yolo wins over the `ask` clamp), while a `deny` still denies.
  The existing yolo tests (`test/permission-manager-yolo.test.ts`) cover deny-preservation; add the fail-closed-under-yolo case.
- `#547` strict-validation invariant — a rejected scope contributes no rules.
  Still true; the clamp is a separate composition-stage overlay, not a change to what the rejected scope contributes to the merge.

## TDD Order

1. **`test:` + `feat:` — `floorAllowsToAsk` overlay.**
   Red: add `test/rule.test.ts` cases for the new overlay (allow→ask, deny/ask untouched, origin `"fail-closed"`, non-mutation).
   Green: add `"fail-closed"` to `RuleOrigin` and implement `floorAllowsToAsk` in `src/rule.ts`.
   Commit: `feat(pi-permission-system): add floorAllowsToAsk allow→ask overlay (#646)`.
2. **`test:` + `feat:` — loader marks invalid non-global scopes.**
   Red: `test/policy-loader.test.ts` — project rejected → `invalid: true`; project absent/valid → unset; agent present-but-unreadable → `invalid: true`; agent missing → `{}`.
   Green: add `invalid?: boolean` to `ScopeConfig` (`src/types.ts`) and set it in `loadProjectConfig` and `loadScopeConfigFrom`.
   Commit: `feat(pi-permission-system): mark invalid non-global config scopes (#646)`.
3. **`feat!:` — clamp the composed policy and strengthen the notice.**
   Red: manager tests — invalid non-global scope floors a lower `allow` to `ask`, preserves `deny`, invalid global does not floor, `getConfigIssues` includes the notice; plus the fail-closed-under-yolo invariant test.
   Green: add `failClosedScopes` to `ResolvedPermissions`, apply `floorAllowsToAsk` in `resolvePermissions`, and append the notice in `getConfigIssues`.
   Commit: `fix(pi-permission-system)!: fail closed when a higher-precedence config scope is invalid (#646)` with a `BREAKING CHANGE:` footer describing the allow→ask clamp on upgrade.
4. **`docs:` — documentation and architecture alignment.**
   Update `docs/architecture/architecture.md` (inline `RuleOrigin` copy), `docs/configuration.md`, `docs/migration/strict-config-validation.md`, `README.md`, and the package skill.
   Commit: `docs(pi-permission-system): document cross-scope fail-closed config clamp (#646)`.

Steps 2 and 3 could merge if the `ScopeConfig` field and the manager clamp prove hard to land separately (the field is unused until step 3), but keeping them split isolates the loader-signal tests from the composition tests; land them together only if step 2's tests cannot compile without the manager change.

## Risks and Mitigations

- **Over-clamping surfaces the invalid scope never intended to touch.**
  Because an invalid config's intent is unrecoverable, the clamp is deliberately broad (any lower `allow` → `ask`).
  Mitigation: the overlay is `ask`, not `deny` — the user is prompted, not blocked, and a fix + reload restores the intended policy immediately.
- **yolo neutralizes the clamp.**
  Under yolo the floored `ask` is rewritten back to `allow`.
  This is intentional and documented: yolo is an explicit opt-in to full permissiveness and can only ever turn `ask` into `allow`.
  Mitigation: an invariant test pins the interaction so it is a conscious contract, not an accident.
- **Breaking behavior on upgrade.**
  A session with an already-invalid higher scope will start prompting.
  Mitigation: the change ships as `fix!:` with a `BREAKING CHANGE:` footer and a migration-doc section; only sessions that already emit a validation warning are affected.

## Open Questions

- None blocking.
  The notice wording (`getConfigIssues`) is provisional and can be refined during implementation without affecting behavior.

[#526]: https://github.com/gotgenes/pi-packages/issues/526
[#547]: https://github.com/gotgenes/pi-packages/issues/547
