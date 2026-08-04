---
issue: 368
issue_title: "Remove the `config-modal` controller reach-through"
---

# Remove the `config-modal` controller reach-through

## Problem Statement

The `show` branch of the `/permission-system` command handler reaches through the controller dependency bag to two strangers in a single expression:

```typescript
const rules = controller.permissionManager.getComposedConfigRules(
  controller.session.lastKnownActiveAgentName ?? undefined,
);
```

The command should not know that the active agent name lives on `session.lastKnownActiveAgentName` and that it must be threaded into `permissionManager.getComposedConfigRules`.
That is a Law-of-Demeter violation: the handler talks to two collaborators it reaches through the controller bag.
The same coupling keeps `PermissionSession.lastKnownActiveAgentName` alive only through object-literal wiring in the composition root, which is why `fallow` flags the getter as a false-positive unused member (carried today with a suppression).

This is Phase 5 Step 7 (Track D) of the `pi-permission-system` improvement roadmap.
It is independent of all other tracks and touches only `config-modal.ts` and its composition-root wiring.

## Goals

- Collapse the controller's `permissionManager` + `session` fields into a single `getActiveAgentConfigRules(): Ruleset` accessor.
- Wire that accessor in the composition root (`index.ts`) as a thin adapter closure, so the reach-through lives where both collaborators are already in scope.
- Have the `show` handler issue a single tell (`controller.getActiveAgentConfigRules()`) instead of chaining through the bag.
- Retire the `fallow` false-positive suppression on `PermissionSession.lastKnownActiveAgentName` now that it is consumed through a real closure body (a traced read) rather than object-literal wiring.
- Mark Phase 5 Step 7 complete in `docs/architecture/architecture.md`.

This change is **not breaking**: `PermissionSystemConfigController` is a package-internal type, the wiring is internal to `index.ts`, and the observable behavior of `/permission-system show` is unchanged.

## Non-Goals

- No change to `getComposedConfigRules` on `PermissionManager` — its signature and behavior stay as-is.
- No change to the `lastKnownActiveAgentName` getter itself — it stays on `PermissionSession`; only the suppression comment and its doc comment change.
- No change to any other Phase 5 track (Steps 1–6).
- No change to the `show` output format, the config summary, or rule-origin display.

## Background

Relevant modules:

- `src/config-modal.ts` — defines the package-internal `PermissionSystemConfigController` interface and the `registerPermissionSystemCommand` factory.
  The `handleArgs` function's `show` branch performs the reach-through.
- `src/index.ts` (≈ line 113) — the composition root constructs `permissionManager` and `session` as locals, then passes them into the controller bag via `registerPermissionSystemCommand(pi, { config, configPath, permissionManager, session })`.
- `src/permission-manager.ts` (≈ line 195) — `getComposedConfigRules(agentName?: string): Ruleset` returns the composed config-layer rules; it always returns a `Ruleset` (never `undefined`).
- `src/permission-session.ts` (≈ line 153) — the `lastKnownActiveAgentName` getter carries a `fallow-ignore-next-line unused-class-member` suppression plus a comment explaining the object-literal-wiring blind spot.

Constraint from the package skill / retro `0341`: `fallow`'s blind spot is the object-literal wiring in `index.ts` — config-modal receives `session` as an object-literal property, not a traced positional argument, so `fallow` cannot see the getter being read.
Moving the read into a real arrow-function body in `index.ts` (`session.lastKnownActiveAgentName`) makes it a directly traced property access, which is exactly the usage `fallow` can follow.
This is what makes retiring the suppression safe.

Constraint from AGENTS.md / package skill: keep schema, example config, loader, and docs aligned — none of those are touched here (no config surface changes), but the architecture roadmap step must be marked complete in the same change.

## Design Overview

Replace the two narrow collaborator references on the controller interface with a single value-returning accessor.

Before:

```typescript
interface PermissionSystemConfigController {
  config: CommandConfigStore;
  configPath: string;
  permissionManager: { getComposedConfigRules(agentName?: string): Ruleset };
  session: { readonly lastKnownActiveAgentName: string | null };
}
```

After:

```typescript
interface PermissionSystemConfigController {
  config: CommandConfigStore;
  configPath: string;
  /** Returns the composed config-layer ruleset for the active agent scope. */
  getActiveAgentConfigRules(): Ruleset;
}
```

The `show` branch becomes a single tell:

```typescript
if (normalized === "show") {
  const rules = controller.getActiveAgentConfigRules();
  ctx.ui.notify(
    `permission-system: ${summarizeConfig(controller.config.current(), rules)}`,
    "info",
  );
  return true;
}
```

Composition-root wiring (`index.ts`) — the reach-through collapses into a thin adapter closure where both locals are already in scope:

```typescript
registerPermissionSystemCommand(pi, {
  config: configStore,
  configPath,
  getActiveAgentConfigRules: () =>
    permissionManager.getComposedConfigRules(
      session.lastKnownActiveAgentName ?? undefined,
    ),
});
```

Design rationale:

- The accessor returns a value (the `Ruleset`), so this is a genuine encapsulation of a query, not procedure-splitting — it removes a Law-of-Demeter reach-through and gives the handler one collaborator to tell.
- Field count on `PermissionSystemConfigController` drops from 4 to 3; two fields that always travelled together (`permissionManager` + `session`, used only to compute one ruleset) collapse into the one query the handler actually needs (ISP).
- `getComposedConfigRules` always returns a `Ruleset`, so `getActiveAgentConfigRules()` always returns a defined `Ruleset` (possibly empty).
  `summarizeConfig` already handles an empty ruleset via `formatRulesSummary` returning `""`, so the existing "omit rule summary when no config rules" behavior is preserved without any optionality.

Edge cases:

- Empty ruleset → `formatRulesSummary` returns `""`, summary shows knobs only (unchanged).
- `lastKnownActiveAgentName` is `null` → coalesced to `undefined`, passed to `getComposedConfigRules` (unchanged — this logic simply moves from the handler into the closure).

## Module-Level Changes

- `src/config-modal.ts`
  - Replace the `permissionManager` and `session` fields on `PermissionSystemConfigController` with a single `getActiveAgentConfigRules(): Ruleset` method.
  - Update the `show` branch in `handleArgs` to call `controller.getActiveAgentConfigRules()`.
  - The `Ruleset` import stays (still referenced by `getActiveAgentConfigRules` and `formatRulesSummary`).
- `src/index.ts`
  - Change the `registerPermissionSystemCommand` call site to pass `getActiveAgentConfigRules: () => permissionManager.getComposedConfigRules(session.lastKnownActiveAgentName ?? undefined)` in place of the `permissionManager` and `session` properties.
- `src/permission-session.ts`
  - Remove the `fallow-ignore-next-line unused-class-member` suppression on the `lastKnownActiveAgentName` getter.
  - Update the preceding comment from "Read by config-modal (`controller.session.lastKnownActiveAgentName`)" to note it is read by the `index.ts` config-modal adapter closure.
- `test/config-modal.test.ts`
  - Update all four controller literals: replace `permissionManager: { getComposedConfigRules: () => ... }` + `session: { lastKnownActiveAgentName: null }` with `getActiveAgentConfigRules: () => ...` (preserving each test's intended ruleset: `[] as Ruleset` or the `composedRules` fixture).
- `docs/architecture/architecture.md`
  - Append `✓ complete` to the Phase 5 Step 7 line (Track D, `[#368]`).
  - The metrics table row "`config-modal` controller reach-throughs" baseline `1` → target `0` is now met; leave the table as the historical baseline record (no edit needed beyond the step-complete marker, consistent with how prior steps were marked).

## Test Impact Analysis

1. New tests enabled by the change: none of substance.
   The new `getActiveAgentConfigRules` is a wiring closure in `index.ts`, not a new extracted module with independently testable logic.
   The existing `config-modal.test.ts` show-output tests already exercise the accessor seam (they inject the ruleset directly), so behavior remains covered at the same layer.
2. Tests that become redundant: none.
   The two behavioral show-output tests (rule origins present / rule summary omitted) remain meaningful — they now drive the single accessor instead of the two-field bag.
3. Tests that must stay as-is: `test/permission-session.test.ts` "exposes lastKnownActiveAgentName" genuinely exercises the getter on `PermissionSession` and is unaffected by the controller-interface change.

## TDD Order

This is a behavior-preserving refactor whose interface change breaks `index.ts` and every `config-modal.test.ts` controller literal at the type level in the same commit, so it lands as one atomic step (per the AGENTS.md rule: removing/replacing interface fields with constructed call sites must update production wiring and consumer tests together).

1. `refactor: collapse config-modal controller reach-through into getActiveAgentConfigRules accessor (#368)`
   - Test surface: `test/config-modal.test.ts` — update all four controller literals to the `getActiveAgentConfigRules` shape; the existing show-output assertions ("includes rule origins", "omits rule summary") are the behavior-preserving safety net and must continue to pass unchanged.
   - Production: replace the two controller fields with `getActiveAgentConfigRules(): Ruleset` in `config-modal.ts`; update the `show` branch to a single tell; move the reach-through into the adapter closure in `index.ts`; remove the `fallow` suppression and update the doc comment in `permission-session.ts`.
   - Verify: `pnpm --filter @gotgenes/pi-permission-system run check`, `run lint`, `run test`, and `pnpm fallow dead-code` (confirming `lastKnownActiveAgentName` is no longer reported now that the closure reads it directly).
2. `docs: mark Phase 5 Step 7 complete in architecture roadmap (#368)`
   - Surface: `docs/architecture/architecture.md` — append `✓ complete` to the Step 7 (Track D) line.
   - Commit separately so the doc-only change does not couple to the code commit's review; it touches an excluded path and does not trigger a release.

## Risks and Mitigations

- Risk: `fallow` still flags `lastKnownActiveAgentName` after the change (the retro `0341` attempt with a named interface did not satisfy `fallow`).
  Mitigation: the prior failure was object-literal wiring; this change makes `session.lastKnownActiveAgentName` a direct read in a real arrow-function body in `index.ts`, which `fallow` traces.
  The verify step in cycle 1 runs `pnpm fallow dead-code` before commit — if the getter is still flagged, restore a single justified suppression (with an updated rationale) rather than blocking, and note the residual blind spot in the retro.
- Risk: a missed controller literal in `test/config-modal.test.ts` leaves a stale `permissionManager`/`session` shape.
  Mitigation: TypeScript's excess-property checking rejects the stale fields immediately at `pnpm run check`; all four literals are enumerated in Module-Level Changes.
- Risk: silently changing `show` output when the ruleset is empty.
  Mitigation: `getComposedConfigRules` always returns a `Ruleset` and `formatRulesSummary` already returns `""` for an empty config layer; the "omits rule summary" test guards this.

## Open Questions

- None blocking.
  The `fallow` outcome is the only thing to confirm empirically during cycle 1; the plan carries a documented fallback if the suppression cannot be fully retired.
