---
issue: 366
issue_title: "Narrow `LocalPermissionsService` collaborators to interfaces"
---

# Narrow `LocalPermissionsService` collaborators to interfaces

## Problem Statement

`LocalPermissionsService` (`src/permissions-service.ts`) is constructed with three concrete classes — `PermissionManager`, `SessionRules`, and `ToolInputFormatterRegistry` — but it only calls `checkPermission` / `getToolPermission`, `getRuleset`, and `register`.
Concrete-class parameter types expose the classes' private members to TypeScript's structural checker, so a plain test double can never satisfy them.
`permissions-service.test.ts` is therefore forced into three `as unknown as` casts to build its mocks.
The awkward test object is the symptom; depending on concretions instead of abstractions is the cause.

## Goals

- Type the three constructor parameters of `LocalPermissionsService` as narrow interfaces, not concrete classes.
- Reuse the existing `ScopedPermissionManager` interface for the manager dependency.
- Use `Pick<SessionRules, "getRuleset">` for the ruleset read, matching the existing precedent in `permission-resolver.ts` and `permission-event-rpc.ts`.
- Introduce a named `{ register }` formatter interface that mirrors the existing read-side `ToolInputFormatterLookup`.
- Remove the three `as unknown as` casts in `permissions-service.test.ts`; mocks become plain objects.

This change is not breaking: it narrows internal parameter types only.
There is no change to observable behavior, output shape, public config, or any default.
The construction site in `index.ts` passes the same concrete instances, which structurally satisfy the narrower interfaces, so it needs no edit.

## Non-Goals

- Track C Step 6 ([#367], narrowing `PermissionForwarder`'s `ExtensionContext` dependency) — a sibling roadmap step, out of scope here.
- Narrowing `ScopedPermissionManager` itself to only the two methods the service uses — see Risks; this plan deliberately reuses the established shared interface.
- Marking the roadmap step `✓ complete` in `docs/architecture/architecture.md` — that is a shipping-time action performed during `/ship-issue`, not part of this refactor commit.

## Background

Relevant existing modules:

- `src/permissions-service.ts` — the class under change.
  Its three methods delegate straight to the collaborators: `checkPermission` → `permissionManager.checkPermission(...)` with `sessionRules.getRuleset()`; `getToolPermission` → `permissionManager.getToolPermission(...)`; `registerToolInputFormatter` → `formatterRegistry.register(...)`.
- `src/permission-manager.ts` — already exports `ScopedPermissionManager`, a narrow interface implemented by the concrete `PermissionManager`.
  It declares `configureForCwd`, `checkPermission`, `getToolPermission`, `getConfigIssues`, `getPolicyCacheStamp`.
  `PermissionSession` and `PermissionResolver` already depend on this interface rather than the concrete class.
- `src/session-rules.ts` — exports the concrete `SessionRules` class with `getRuleset(): Ruleset`.
  `permission-resolver.ts` and `permission-event-rpc.ts` already depend on `Pick<SessionRules, "getRuleset">`.
- `src/tool-input-formatter-registry.ts` — exports the concrete `ToolInputFormatterRegistry` plus the read-side interface `ToolInputFormatterLookup { get(...) }`.
  There is no write-side interface yet; this plan adds one.
- `src/index.ts` (line ~126) — the sole production construction site: `new LocalPermissionsService(permissionManager, sessionRules, formatterRegistry)`.

Constraint from the `code-design` skill (Structural Design → Dependency width): "When a shared interface references a collaborator, use a narrow interface type — not the concrete class.
Concrete class types expose private fields to TypeScript's structural checker, forcing test mocks to cast or replicate internals."
This issue is the direct remediation of that smell.

Constraint from the package skill: when a refactor targets testability, read the test files alongside the production code (done — see Test Impact Analysis).

## Design Overview

The change replaces three concrete parameter types with abstractions.
No runtime behavior changes; this is a pure type-narrowing refactor.

New write-side interface, added in `tool-input-formatter-registry.ts` directly above `ToolInputFormatterLookup` so the read/write pair sits together:

```typescript
/**
 * Registration side of the formatter registry (ISP — exposes only the
 * write surface, mirroring the read-only {@link ToolInputFormatterLookup}).
 */
export interface ToolInputFormatterRegistrar {
  register(toolName: string, formatter: ToolInputFormatter): () => void;
}
```

The concrete `ToolInputFormatterRegistry` gains `ToolInputFormatterRegistrar` in its `implements` clause (alongside the existing `ToolInputFormatterLookup`) so the contract is locked at the class declaration, not only inferred structurally.

Narrowed constructor in `permissions-service.ts`:

```typescript
export class LocalPermissionsService implements PermissionsService {
  constructor(
    private readonly permissionManager: ScopedPermissionManager,
    private readonly sessionRules: Pick<SessionRules, "getRuleset">,
    private readonly formatterRegistry: ToolInputFormatterRegistrar,
  ) {}
  // method bodies unchanged
}
```

Construction site (`index.ts`) — unchanged.
`PermissionManager implements ScopedPermissionManager`, `SessionRules` has `getRuleset`, and `ToolInputFormatterRegistry` has `register`, so all three concrete instances satisfy the narrower parameter types with no edit.

Test mocks become plain objects (the payoff):

```typescript
function makePermissionManager() {
  return {
    checkPermission: vi.fn(...).mockReturnValue(makeCheckResult()),
    getToolPermission: vi.fn(...).mockReturnValue("allow"),
  } satisfies Pick<ScopedPermissionManager, "checkPermission" | "getToolPermission">;
}
```

The mock only needs the two methods the service calls — `ScopedPermissionManager` does not force the other three onto the literal because the parameter is structurally satisfied by a value typed as the `Pick`.
The factory return types use `Pick<ScopedPermissionManager, "checkPermission" | "getToolPermission">`, `Pick<SessionRules, "getRuleset">`, and `Pick<ToolInputFormatterRegistrar, "register">` (or the bare interface) so no field beyond what the test exercises is required, and no `as unknown as` cast survives.

### Edge cases

- None affecting runtime — the method bodies are untouched.
- The only failure mode is a compile error if a parameter type is narrowed incorrectly; `pnpm run check` catches it at the commit boundary.

## Module-Level Changes

- `src/tool-input-formatter-registry.ts` — add the exported `ToolInputFormatterRegistrar` interface; add it to the `ToolInputFormatterRegistry` class `implements` clause.
- `src/permissions-service.ts` — change the three constructor parameter types; update imports (`PermissionManager` → `ScopedPermissionManager` from `./permission-manager`; keep `type SessionRules` for the `Pick`; replace `ToolInputFormatterRegistry` with `ToolInputFormatterRegistrar`, keep `ToolInputFormatter`).
- `test/permissions-service.test.ts` — drop the three `as unknown as` casts; retype the three mock factories to the narrow interfaces; update imports to match.
- `src/index.ts` — no change (construction site already passes satisfying concrete instances).
- `docs/architecture/architecture.md` — no change in this plan; the `✓ complete` mark on Track C Step 5 is applied at ship time.

Grep confirmation: `LocalPermissionsService` is constructed only in `src/index.ts` and `test/permissions-service.test.ts`.
No barrel re-export, skill doc, or other module references the concrete-class parameter types of this constructor.

## Test Impact Analysis

1. New tests enabled — none required.
   The existing four/`describe` blocks already cover all three methods (`checkPermission` input building + delegation + return passthrough, `getToolPermission` delegation + optional `agentName`, `registerToolInputFormatter` delegation + disposer passthrough).
   The narrowing makes those tests cleaner (plain-object mocks) without adding coverage.
2. Tests becoming redundant — none.
   The existing assertions still pertain; only the mock construction simplifies.
3. Tests that must stay as-is — all of them.
   They genuinely exercise `LocalPermissionsService`'s delegation contract, which is the layer being kept; the change only removes the casts they were forced into.

## TDD Order

1. Red → Green → Commit — narrow the collaborators.
   - Red: in `test/permissions-service.test.ts`, remove the three `as unknown as PermissionManager` / `SessionRules` / `ToolInputFormatterRegistry` casts and retype the mock factories to the narrow interfaces.
     `pnpm run check` (tsc) fails: a plain object typed as the narrow interface does not satisfy the still-concrete constructor parameters.
   - Green: add `ToolInputFormatterRegistrar` to `src/tool-input-formatter-registry.ts` (interface + `implements`); narrow the three constructor parameter types in `src/permissions-service.ts` and fix its imports.
     `pnpm run check`, `pnpm run lint`, and `pnpm run test` pass; `index.ts` needs no change.
   - This is a single atomic type change — the test simplification and the production narrowing must land in the same commit to keep the tree green.
   - Commit: `refactor: narrow LocalPermissionsService collaborators to interfaces (#366)`.

## Risks and Mitigations

- Risk: reusing `ScopedPermissionManager` (5 methods) when the service calls only 2 is wider than strict ISP would prescribe.
  Mitigation: this is a deliberate, documented decision — both the issue and the Phase 5 Track C roadmap (`docs/architecture/architecture.md`) specify reusing the established shared interface that `PermissionSession` and `PermissionResolver` already depend on, keeping the manager's contract consistent across consumers rather than fragmenting into per-consumer `Pick`s.
  The testability goal (no `as unknown as` cast) is fully met regardless, because the test's mock factory return type is a `Pick` of the two methods it exercises.
- Risk: a hidden second construction site would break on the narrowed types.
  Mitigation: grep confirms `index.ts` and the test file are the only constructors; the concrete instances `index.ts` passes satisfy the narrower interfaces unchanged.
- Risk: forgetting to add `implements ToolInputFormatterRegistrar` would leave the contract only structurally enforced.
  Mitigation: the step adds it to the class declaration so the compiler verifies the registry still satisfies the write side.

## Open Questions

- None.
  The design is fully specified by the issue and the roadmap; deferred items ([#367], roadmap completion mark) are captured under Non-Goals.

[#367]: https://github.com/gotgenes/pi-packages/issues/367
