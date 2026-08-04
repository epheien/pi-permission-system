---
issue: 527
issue_title: "pi-permission-system: delete dead yolo arms from the prompt path; dissolve yolo-mode.ts"
---

# Delete the dead yolo arms from the prompt path; dissolve `yolo-mode.ts`

## Release Recommendation

**Release:** ship now — batch "yolo-recorded-authority" tail (this issue completes the batch)

This issue is Phase 8 Step 3, the tail of the two-step "yolo-recorded-authority" release batch (Steps 2, 3).
Step 2 ([#526]) relocated the yolo decision to the composition stage with observable review-log/decision-event field changes and left its release-please PR open per a `mid-batch — defer` marker; this cleanup completes the batch, so shipping it releases the batch.
The commits here are `refactor:` (a hidden changelog type that does not cut a release on its own), but merging them to `main` finalizes the open release-please PR that Step 2's `feat`/`fix` opened.

## Problem Statement

Step 2 ([#526]) moved yolo-mode from the prompt path into the composed ruleset: `PermissionManager.check` now applies `rewriteAsksToYolo` so every `ask` becomes an `allow` (tagged `origin: "yolo"`) before it ever leaves the manager, and `GateRunner` writes the `permission_request.auto_approved` review entry from a yolo fast-path.
As a result, `evaluate()` never returns `ask` under yolo, so two decision-path branches became unreachable:

- the auto-approve arm at the top of `PermissionPrompter.prompt()` (via `shouldAutoApprovePermissionState`), and
- the yolo arm inside `PromptingGateway.canConfirm()` (via `canResolveAskPermissionRequest`).

This issue deletes those dead arms, dissolves `src/yolo-mode.ts`, and reduces `canConfirm()` to the two Authorizer-selection predicates the Phase 9 spine will consume.

## Goals

- Remove the unreachable auto-approve arm from `PermissionPrompter.prompt()`.
- Reduce `PromptingGateway.canConfirm()` to `hasUI ∨ isSubagent`; delete `canResolveAskPermissionRequest` and its `AskPermissionResolutionOptions` interface.
- Dissolve `src/yolo-mode.ts`: move `isYoloModeEnabled` next to its config in `src/extension-config.ts`; delete `shouldAutoApprovePermissionState`.
- Keep the forwarded-inbox serve arm's yolo check in place, re-pointed at `isYoloModeEnabled`, with a code comment noting it dissolves in the Phase 9 spine work when `processInbox` is refactored onto `evaluate()`.
- Drop the now-unused `config` dependency from `PermissionPrompterDeps` and `PromptingGatewayDeps`.
- Non-breaking: no config, schema, review-log, or decision-event output changes.

## Non-Goals

- Refactoring `processInbox` / serving-as-resolution onto `evaluate()` — that is Phase 9 spine work, and the serve arm's yolo check stays until then.
- Any change to `PermissionManager.check`, `rewriteAsksToYolo`, `GateRunner`'s yolo fast-path, or `deriveResolution` — Step 2 owns those and they are unchanged here.
- Any change to the yolo status footer semantics in `src/status.ts` (only its import path moves).
- Changing the `yoloMode` config field, its schema, its example, or `/permission-system show` display.

## Background

Relevant modules and their current yolo coupling:

- `src/yolo-mode.ts` — three exports: `isYoloModeEnabled(config)` (reads `config.yoloMode`), `shouldAutoApprovePermissionState(state, config)` (= `state === "ask" && isYoloModeEnabled`), and `canResolveAskPermissionRequest({config, hasUI, isSubagent})` (= `hasUI || isSubagent || isYoloModeEnabled`), plus the `AskPermissionResolutionOptions` interface used only by the last.
- `src/permission-prompter.ts` — `prompt()` opens with `if (shouldAutoApprovePermissionState("ask", this.deps.config.current())) { … return autoApproved }`; `config` is its only other use of `this.deps.config`.
- `src/prompting-gateway.ts` — `canConfirm()` delegates to `canResolveAskPermissionRequest({ config, hasUI, isSubagent })`; `config` is its only use of `this.deps.config`.
- `src/forwarded-permissions/permission-forwarder.ts:509` — the serve arm calls `shouldAutoApprovePermissionState("ask", this.config.current())`; this check is intentionally retained.
- `src/status.ts` — the yolo footer calls `isYoloModeEnabled(config)`; retained, import path moves.
- `src/index.ts` — imports `isYoloModeEnabled` from `./yolo-mode` (wires the manager's `isYoloEnabled` reader), and passes `config: configStore` into both the `PermissionPrompter` and `PromptingGateway` constructors.

Constraints from AGENTS.md / package skill:

- The roadmap step completion marker (`✅` on the Step 3 heading and its Mermaid node, plus stale metric rows) must land in the implementation doc-update commit, not a deferred ship commit.
- `docs/architecture/architecture.md` names internal symbols in narrative prose and a module-layout tree — both must be swept for the removed `yolo-mode.ts` / `canResolveAskPermissionRequest` / `shouldAutoApprovePermissionState`.
- The #526 retro documented that `permission-prompter.md` (which still describes the prompter's yolo-mode arm) updates ride with this issue.

## Design Overview

The change is a pure narrowing: it deletes two unreachable branches and the config dependency they required, and relocates the one surviving predicate (`isYoloModeEnabled`) next to its config.
No new collaborator, no new interface, no behavior on the reachable path.

### Decision model after the change

- `PermissionPrompter.prompt()` — no yolo branch; always writes the `waiting` entry, emits the UI-prompt event when `ctx.hasUI`, and delegates to `forwarder.requestApproval`.
- `PromptingGateway.canConfirm()` — `this.context !== null && (hasUI || isSubagent)`.
- The composition-stage rewrite (`PermissionManager.check`, unchanged) remains the sole yolo decision point on the *ask* path; the serve arm remains the sole yolo decision point on the *forwarded serving* path.

### `isYoloModeEnabled` moves to `extension-config.ts`

`isYoloModeEnabled` is a one-line reader over `PermissionSystemExtensionConfig`, which is defined in `extension-config.ts` — its natural home.
The move eliminates the `yolo-mode.ts` module entirely.
The serve arm's `shouldAutoApprovePermissionState("ask", config)` collapses to `isYoloModeEnabled(config)` — with the prompter arm gone, the only surviving caller always passed the literal `"ask"`, so the `state` parameter is dead and `shouldAutoApprovePermissionState` is deleted rather than moved.

Serve-arm call site after the change (`permission-forwarder.ts`):

```typescript
// Yolo serve-arm: auto-approve a forwarded request under yolo mode.
// This is the last yolo check outside the composed ruleset; it dissolves
// when `processInbox` is refactored onto evaluate() + Authorizer selection
// in the Phase 9 spine work (#530 seeds this; the spine consumes it).
if (isYoloModeEnabled(this.config.current())) {
  this.logger.review("forwarded_permission.auto_approved", details);
  decision = { approved: true, state: "approved" };
}
```

### Dependency narrowing

Both `PermissionPrompterDeps` and `PromptingGatewayDeps` lose their `config: ConfigReader` field, because the only reader of `config` in each class was the deleted yolo branch.
`index.ts` drops `config: configStore` from both constructor calls.
This is a dependency-width improvement, not a widening — no design-review smell is introduced.

### Design-review checklist (applied)

- Dependency width: the change *removes* a field (`config`) from two dependency bags — narrowing, not widening.
- Law of Demeter: no new reach-through; `this.deps.config.current()` chains are deleted, not added.
- Output arguments / scattered resets / parameter relay: none introduced.
- Test mock depth: `makeDeps` helpers in the prompter and gateway tests shrink (drop the `config` field).

No structural smell is added; the checklist confirms the change is a clean narrowing, so the fixes are inline (this PR), not a follow-up.

## Module-Level Changes

Source:

- `src/extension-config.ts` — add `isYoloModeEnabled(config: PermissionSystemExtensionConfig): boolean` (moved verbatim, including its `no-unnecessary-type-conversion` disable comment).
- `src/yolo-mode.ts` — deleted.
- `src/permission-prompter.ts` — remove the auto-approve arm from `prompt()`; remove `config` from `PermissionPrompterDeps`; remove the `ConfigReader` import and the `shouldAutoApprovePermissionState` import; update the class/deps doc comments to drop the "Yolo-mode auto-approval check" step and the "config access" mention.
- `src/prompting-gateway.ts` — `canConfirm()` returns `this.context !== null && (this.context.hasUI || isSubagentExecutionContext(...))`; remove `config` from `PromptingGatewayDeps`; remove the `ConfigReader` and `canResolveAskPermissionRequest` imports; update the deps and `canConfirm()` doc comments to drop the yolo-mode branch.
- `src/forwarded-permissions/permission-forwarder.ts` — switch the serve arm to `isYoloModeEnabled(this.config.current())`; change the import from `#src/yolo-mode` to `#src/extension-config`; add the retention comment shown above; update the `config` deps JSDoc that says "yolo-mode auto-approve check".
- `src/status.ts` — change the `isYoloModeEnabled` import from `./yolo-mode` to `./extension-config`.
- `src/index.ts` — change the `isYoloModeEnabled` import from `./yolo-mode` to `./extension-config`; drop `config: configStore` from the `PermissionPrompter` and `PromptingGateway` constructor calls.

Tests:

- `test/permission-prompter.test.ts` — delete the `describe("yolo-mode auto-approve")` block (4 tests for removed behavior); drop the `config` field from the `makeDeps` helper (and remove `makeConfigReader` if it becomes unused).
- `test/prompting-gateway.test.ts` — delete the "returns true when yolo mode is enabled (no UI, not subagent)" test; simplify the two remaining `yoloMode`-parameterized `canConfirm` tests to drop the now-irrelevant yolo config; drop `config` from the gateway `makeDeps` helper.
- `test/yolo-mode.test.ts` — deleted: its two subjects (`shouldAutoApprovePermissionState`, `canResolveAskPermissionRequest`) are removed, and its lone `resolvePermissionForwardingTargetSessionId` assertion is already covered by `test/permission-forwarding.test.ts` ("isSubagent=true, no candidates set returns null").
- `test/extension-config.test.ts` — add an `isYoloModeEnabled` describe block (on/off/undefined `yoloMode`), giving the relocated function direct unit coverage at its new home.
- `test/permission-forwarder.test.ts` — no change: the serve-arm yolo test (`yoloMode: true` → `forwarded_permission.auto_approved`) stays green because `isYoloModeEnabled` is behavior-identical to the old `shouldAutoApprovePermissionState("ask", …)`; it pins the retained serve arm.

Docs (in the implementation doc-update commit):

- `docs/architecture/architecture.md` — mark Step 3 `✅` on both the step heading and its Mermaid node; remove the `yolo-mode.ts` line from the module-layout tree; update the `prompting-gateway.ts` tree description to drop "yolo-mode" from the can-prompt policy; flip the "yolo checks on the ask path" and "canConfirm() predicates" metric rows to their post-Step-3 values.
- `docs/architecture/permission-prompter.md` — remove the yolo-mode step (item 1), the `getConfig()` yolo comment, and the "Yolo-mode is handled at the prompter level" paragraph so the doc reflects the arm's removal.

## Test Impact Analysis

1. New tests enabled: a direct `isYoloModeEnabled` unit test in `test/extension-config.test.ts`.
   Previously the function had no direct test — it was exercised only transitively through `shouldAutoApprovePermissionState` / `canResolveAskPermissionRequest` in the now-deleted `yolo-mode.test.ts`.
2. Redundant tests removed: the prompter `yolo-mode auto-approve` block (the behavior moved to `GateRunner` in Step 2 and is tested there); the whole `yolo-mode.test.ts` file (its subjects are deleted and its forwarding-target assertion duplicates existing `permission-forwarding.test.ts` coverage).
3. Tests that must stay: the `permission-forwarder.test.ts` serve-arm yolo test (genuinely exercises the retained serve-arm check) and the Step 2 `permission-manager` / `GateRunner` yolo tests (pin the composition-stage invariant this cleanup must not regress).

## Invariants at risk

Step 2 ([#526]) landed three documented outcomes that this step must not regress:

- `evaluate()` is the only yolo decision point on the ask path; yolo `ask`→`allow` happens in `PermissionManager.check` via `rewriteAsksToYolo`.
  Pinned by the `PermissionManager` yolo-rewrite tests — untouched here (the manager is not modified).
- A yolo-origin `allow` reports resolution `auto_approved` via `GateRunner`'s yolo fast-path and the `permission_request.auto_approved` review entry.
  Pinned by the `GateRunner` yolo tests — untouched here (the runner is not modified).
- The forwarded-inbox serve arm auto-approves under yolo and logs `forwarded_permission.auto_approved`.
  Pinned by `test/permission-forwarder.test.ts` (`yoloMode: true`) — this step re-points the arm from `shouldAutoApprovePermissionState` to the behavior-identical `isYoloModeEnabled`, and the test stays green, confirming no regression.

The removal of the prompter arm is safe because the #526 retro recorded an exhaustive reachability trace: every `ask`-producing surface (tool / bash / mcp / path / `external_directory` / skill-input via `manager.check`, and skill-read via the yolo-aware sanitizer) resolves to `allow` under yolo before the prompter is reached, so no `ask` reaches `PermissionPrompter.prompt()` under yolo.

## TDD Order

1. **Remove the prompter auto-approve arm.**
   Test surface: `test/permission-prompter.test.ts`.
   Delete the `describe("yolo-mode auto-approve")` block and drop `config` from `makeDeps`; then remove the arm and the `config` field from `permission-prompter.ts`, drop `config: configStore` from the prompter constructor in `index.ts`. (`shouldAutoApprovePermissionState` still exists for the serve arm, so `yolo-mode.ts` still compiles.) Verify: `pnpm --filter @gotgenes/pi-permission-system run test` green; `grep -n "config" src/permission-prompter.ts` shows no `ConfigReader`.
   Commit: `refactor(pi-permission-system): remove dead yolo arm from PermissionPrompter`.

2. **Reduce `canConfirm()` and delete `canResolveAskPermissionRequest`.**
   Test surface: `test/prompting-gateway.test.ts`, `test/yolo-mode.test.ts`.
   Delete/simplify the gateway yolo tests and drop `config` from its `makeDeps`; remove the `canResolveAskPermissionRequest` describe and catch-all tests from `yolo-mode.test.ts`; then set `canConfirm()` to `hasUI ∨ isSubagent` and drop `config` from `prompting-gateway.ts`, delete `canResolveAskPermissionRequest` + `AskPermissionResolutionOptions` from `yolo-mode.ts`, and drop `config: configStore` from the gateway constructor in `index.ts`.
   Because removing the `config` field from `PromptingGatewayDeps` breaks its constructor call site and its `makeDeps` at the type level in the same commit, all three land together.
   Verify: suite green.
   Commit: `refactor(pi-permission-system): reduce canConfirm to hasUI or isSubagent`.

3. **Dissolve `yolo-mode.ts`.**
   Test surface: `test/extension-config.test.ts` (new `isYoloModeEnabled` block), delete `test/yolo-mode.test.ts`.
   Move `isYoloModeEnabled` into `extension-config.ts`; re-point the serve arm in `permission-forwarder.ts` to `isYoloModeEnabled` (import from `#src/extension-config`) with the retention comment; update `status.ts` and `index.ts` imports to `./extension-config`; delete `shouldAutoApprovePermissionState` and the now-empty `yolo-mode.ts`.
   Deleting `yolo-mode.ts` breaks every importer at the type level in this commit, so all import updates land together.
   Verify: suite green; `grep -rn "yolo-mode" src/ test/` returns nothing; `pnpm --filter @gotgenes/pi-permission-system run check` and `pnpm fallow dead-code` clean.
   Commit: `refactor(pi-permission-system): dissolve yolo-mode.ts into extension-config`.

4. **Doc updates + roadmap completion marker.**
   No test surface.
   Mark Step 3 `✅` (heading + Mermaid node) in `architecture.md`, remove the `yolo-mode.ts` tree line, update the `prompting-gateway.ts` tree description, flip the two metric rows; strip the yolo-mode content from `permission-prompter.md`.
   Verify: `pnpm --filter @gotgenes/pi-permission-system run lint` (rumdl) clean; Mermaid renders.
   Commit: `docs(pi-permission-system): mark Phase 8 Step 3 complete; drop yolo-mode from prompt-path docs`.

## Risks and Mitigations

- Risk: an `ask` still reaches the prompter under yolo, making the removed arm load-bearing.
  Mitigation: the #526 reachability trace proves no `ask` reaches the prompter under yolo; the serve-arm and composition-stage tests continue to pin the two surviving yolo decision points.
- Risk: `import type { ConfigReader }` or `shouldAutoApprovePermissionState` left dangling after an interface-field removal (a dropped edit passes `tsc` because unused type imports are not errors).
  Mitigation: run `pnpm run check` unpiped and re-read each edited file; `pnpm fallow dead-code` in Step 3 gates unused exports.
- Risk: a stale `yolo-mode.ts` / `canResolveAskPermissionRequest` reference left in a live doc.
  Mitigation: Step 4 sweeps `docs/architecture/architecture.md` and `permission-prompter.md`; historical `docs/plans/*` and `docs/retro/*` are frozen and intentionally not edited.

## Open Questions

None.
No follow-up issues are filed by this plan — the retained serve-arm yolo check already has its Phase 9 dissolution tracked by the spine steps ([#530] and the Phase 9 roadmap).

[#526]: https://github.com/gotgenes/pi-packages/issues/526
[#530]: https://github.com/gotgenes/pi-packages/issues/530
