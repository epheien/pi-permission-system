---
issue: 145
issue_title: "Add Symbol.for()-backed service accessor, deprecate permissions:rpc:check"
---

# Symbol.for()-backed service accessor

## Problem Statement

The current cross-extension API for policy queries (`permissions:rpc:check`) wraps a synchronous `checkPermission()` call in async RPC ceremony: `requestId` → scoped reply channel → timeout handling → `as`-cast deserialization.
This works, but the ergonomics are poor for what is fundamentally a direct function call.

`Symbol.for()` is process-global by spec and survives jiti's per-extension module isolation.
A service object stored on `globalThis` via `Symbol.for()` enables direct, type-safe, synchronous function calls from any extension — eliminating the RPC envelope entirely.

## Goals

1. Add `src/service.ts` with a `PermissionsService` interface and `Symbol.for()`-backed accessor functions (`getPermissionsService`, `publishPermissionsService`, `unpublishPermissionsService`).
2. Add an `exports` field to `package.json` so `import("@gotgenes/pi-permission-system")` resolves to the service module.
3. Publish the service during the extension factory and clear it on shutdown.
4. Deprecate `permissions:rpc:check` — keep the handler working but document the service accessor as the preferred path.

## Non-Goals

- **Remove `permissions:rpc:check`** — it stays as a zero-dependency fallback for consumers who do not want to add an optional peer dep.
- **Move `permissions:rpc:prompt` to the service** — prompt forwarding is genuinely async and the event bus is a reasonable fit.
- **Move `permissions:decision` broadcasts** — fire-and-forget observation belongs on the event bus.
- **Add a Proxy delegate for reload safety** — during `/reload`, all extensions re-initialize; both provider and consumer call their factories anew, so captured references are naturally refreshed.
  Document the "call per use, don't cache" pattern as a best practice.
- **Add a JS build step** — consumers are Pi extensions that use jiti; pointing `exports` to `.ts` source is sufficient.
- **Upstream `registerService`/`getService`** — tracked in earendil-works/pi#4207; this plan works independently.

## Background

### Dependency status

| Issue                  | Description                         | Status                                         |
| ---------------------- | ----------------------------------- | ---------------------------------------------- |
| #29                    | Permission event channel with RPC   | ✅ Implemented                                 |
| earendil-works/pi#4207 | Upstream registerService/getService | Open — independent; this plan works without it |

### jiti isolation model

Pi's extension loader creates a fresh jiti instance per extension with `moduleCache: false`.
Module-scoped state is invisible across extensions.
The only shared channels are:

- `pi.events` — the event bus, explicitly passed by the loader.
- `globalThis` + `Symbol.for()` — process-global by spec, survives jiti isolation.

When a consumer does `import("@gotgenes/pi-permission-system")`, their jiti loads a fresh module copy.
That copy's `getPermissionsService()` reads `globalThis[Symbol.for(...)]`, which was set by the provider's factory running in a different jiti instance.
The accessor works because `globalThis` and `Symbol.for()` are both process-global.

### Affected permission surfaces

This change adds a new **cross-extension access layer**.
It does not alter any allow/deny/ask decision logic.
All six surfaces (tools, bash, mcp, skills, special, external\_directory) are queryable through the service's `checkPermission` method.

### Existing `buildInputForSurface` utility

`src/permission-event-rpc.ts` contains a non-exported `buildInputForSurface()` helper that translates `(surface, value)` into the input object `PermissionManager.checkPermission()` expects.
The new service adapter needs the same logic.
The plan extracts it to `src/input-normalizer.ts` so both the RPC handler and the service factory can import it.

## Design Overview

### Service interface

```typescript
import type { PermissionCheckResult } from "./types";

export interface PermissionsService {
  /**
   * Query the permission policy for a surface and value.
   * Returns the full check result including state, matched pattern, and origin.
   * Session rules are included automatically.
   */
  checkPermission(
    surface: string,
    value?: string,
    agentName?: string,
  ): PermissionCheckResult;
}
```

The interface exposes a single method matching the simplified RPC signature.
Internally it delegates to `PermissionManager.checkPermission()` with the current session rules, mirroring the existing `permissions:rpc:check` handler logic.

The return type is the existing `PermissionCheckResult` — re-exported from the service module so consumers get full type safety without importing internal modules.

### globalThis accessor

```typescript
const SERVICE_KEY = Symbol.for("@gotgenes/pi-permission-system:service");

export function publishPermissionsService(service: PermissionsService): void {
  (globalThis as Record<symbol, unknown>)[SERVICE_KEY] = service;
}

export function getPermissionsService(): PermissionsService | undefined {
  return (globalThis as Record<symbol, unknown>)[SERVICE_KEY] as
    | PermissionsService
    | undefined;
}

export function unpublishPermissionsService(): void {
  delete (globalThis as Record<symbol, unknown>)[SERVICE_KEY];
}
```

- `publishPermissionsService` overwrites the slot — safe for `/reload`.
- `unpublishPermissionsService` clears the slot — called during `session_shutdown` to avoid stale references after the extension is torn down.
- `getPermissionsService` returns `undefined` when the extension has not loaded (or has been unloaded).
  Consumers handle this with a `try/catch` around the dynamic import plus an `if` guard.

### Consumer usage

```typescript
try {
  const { getPermissionsService } = await import(
    "@gotgenes/pi-permission-system"
  );
  const permissions = getPermissionsService();
  if (permissions) {
    const result = permissions.checkPermission("bash", "git push");
    // Direct call, full type safety, no async envelope
  }
} catch {
  // Not installed — graceful degradation
}
```

### Reload safety

During `/reload`, the Pi extension loader:

1. Fires `session_shutdown` to all extensions (provider calls `unpublishPermissionsService()`).
2. Tears down all extension runtimes.
3. Creates fresh jiti instances and calls each extension factory anew.
4. Provider's factory calls `publishPermissionsService(newImpl)`.
5. Consumer's factory calls `getPermissionsService()` and gets the new impl.

Both sides re-initialize, so there is no stale-reference window in the normal flow.
The plan documents "call `getPermissionsService()` per use, do not cache the reference" as a best practice for resilience against load-order edge cases.

### `package.json` exports

```json
{
  "exports": {
    ".": "./src/service.ts"
  }
}
```

Points to the TypeScript source — jiti consumers resolve it natively.
TypeScript consumers with `moduleResolution: "Bundler"` get full type inference from the source.
No build step is required.

### Deprecation of `permissions:rpc:check`

- Add `@deprecated` JSDoc annotations to `PERMISSIONS_RPC_CHECK_CHANNEL`, `PermissionsCheckRequest`, and `PermissionsCheckReplyData` in `src/permission-events.ts`.
- The RPC handler in `src/permission-event-rpc.ts` continues to function — no runtime change.
- README and architecture docs note the service accessor as the preferred API.

## Module-Level Changes

| File                                 | Action    | Detail                                                                                                                                                                                                                           |
| ------------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/service.ts`                     | **new**   | `PermissionsService` interface, `SERVICE_KEY` constant, `publishPermissionsService()`, `getPermissionsService()`, `unpublishPermissionsService()`. Re-exports `PermissionCheckResult` and `PermissionState` from `src/types.ts`. |
| `src/input-normalizer.ts`            | changed   | Export new `buildInputForSurface(surface, value)` function (moved from `src/permission-event-rpc.ts`).                                                                                                                           |
| `src/permission-event-rpc.ts`        | changed   | Remove local `buildInputForSurface`; import from `src/input-normalizer.ts`.                                                                                                                                                      |
| `src/permission-events.ts`           | changed   | Add `@deprecated` JSDoc to `PERMISSIONS_RPC_CHECK_CHANNEL`, `PermissionsCheckRequest`, `PermissionsCheckReplyData`.                                                                                                              |
| `src/index.ts`                       | changed   | Build service adapter object, call `publishPermissionsService()` after RPC registration. Pass `unpublishPermissionsService` to `SessionLifecycleHandler` cleanup.                                                                |
| `src/handlers/lifecycle.ts`          | changed   | Call the additional cleanup function (unpublish) alongside `cleanupRpc()`.                                                                                                                                                       |
| `package.json`                       | changed   | Add `"exports": { ".": "./src/service.ts" }`.                                                                                                                                                                                    |
| `tests/service.test.ts`              | **new**   | Unit tests for accessor functions and service delegation.                                                                                                                                                                        |
| `tests/permission-event-rpc.test.ts` | unchanged | Existing RPC tests remain valid — the handler still works.                                                                                                                                                                       |
| `docs/architecture/architecture.md`  | changed   | Add "Cross-extension service accessor" section describing the `Symbol.for()` pattern.                                                                                                                                            |
| `README.md`                          | changed   | Add "Service API" section; mark RPC check as deprecated in the event API section.                                                                                                                                                |

## Test Impact Analysis

1. **New unit tests enabled**: `tests/service.test.ts` tests the `globalThis` accessor in isolation — publish, get, unpublish, overwrite.
   Also tests the service adapter's `checkPermission` delegation via a mock `PermissionManager`.
2. **No existing tests become redundant**: the RPC handler tests cover the event-bus path which remains the fallback API.
3. **Existing tests that must stay**: `tests/permission-event-rpc.test.ts` — the RPC handler is not removed, only deprecated.
4. **`buildInputForSurface` extraction**: no test changes needed — the function is non-exported today and tested only indirectly through the RPC handler tests, which continue to exercise it after the move.

## TDD Order

### Step 1 — Service accessor module

- **Red**: `tests/service.test.ts` — assert `getPermissionsService()` returns `undefined` by default; assert `publishPermissionsService(mock)` makes it retrievable; assert `unpublishPermissionsService()` clears it; assert a second publish overwrites the first.
- **Green**: implement `src/service.ts` with the `PermissionsService` interface, `SERVICE_KEY`, and the three accessor functions.
  Re-export `PermissionCheckResult` and `PermissionState`.
- **Commit**: `feat: add Symbol.for()-backed service accessor module (#145)`

### Step 2 — Extract `buildInputForSurface`

- **Green**: move `buildInputForSurface` from `src/permission-event-rpc.ts` to `src/input-normalizer.ts` as a named export.
  Update `src/permission-event-rpc.ts` to import it.
  Run existing tests to confirm no breakage.
- **Commit**: `refactor: extract buildInputForSurface to input-normalizer (#145)`

### Step 3 — Service adapter and lifecycle wiring

- **Red**: `tests/service.test.ts` — add tests that construct a service adapter object using a mock `PermissionManager` and mock `SessionRules`, call `checkPermission("bash", "git push")`, and assert it delegates correctly with the right input shape and session rules.
- **Red**: verify that `getPermissionsService()` returns `undefined` after the shutdown cleanup runs (test the cleanup callback separately or via the `SessionLifecycleHandler` test).
- **Green**: in `src/index.ts`, build the service adapter object and call `publishPermissionsService()`.
  Pass `unpublishPermissionsService` into the lifecycle handler's cleanup callback.
  Update `src/handlers/lifecycle.ts` to accept and call the additional cleanup.
- **Build**: run `pnpm run build` to verify the `handlers/lifecycle.ts` signature change compiles.
- **Commit**: `feat: publish permissions service on startup, clear on shutdown (#145)`

### Step 4 — Package exports

- Add `"exports": { ".": "./src/service.ts" }` to `package.json`.
- **Verify**: `pnpm run build` passes; `node -e "import('@gotgenes/pi-permission-system').then(m => console.log(Object.keys(m)))"` lists the exported names (or verify via a simpler smoke test).
- **Commit**: `feat: add package.json exports field for cross-extension import (#145)`

### Step 5 — Deprecate `permissions:rpc:check`

- Add `@deprecated` JSDoc to `PERMISSIONS_RPC_CHECK_CHANNEL`, `PermissionsCheckRequest`, and `PermissionsCheckReplyData` in `src/permission-events.ts`.
- **Commit**: `docs: deprecate permissions:rpc:check types in favor of service accessor (#145)`

### Step 6 — Documentation

- Update `README.md`: add "Service API" section documenting the `Symbol.for()` accessor, consumer usage pattern, and reload behavior.
  Mark `permissions:rpc:check` as deprecated in the existing event API section.
- Update `docs/architecture/architecture.md`: add cross-extension service accessor description.
- **Commit**: `docs: document service accessor and deprecate RPC check (#145)`

## Risks and Mitigations

| Risk                                                                | Mitigation                                                                                                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Could this silently weaken a permission?                            | No. The service delegates to the same `PermissionManager.checkPermission()` and `SessionRules` that the event-bus RPC and tool-call handler use. No decision logic changes.                                  |
| Stale service reference after `/reload`                             | Both provider and consumer re-initialize during reload. Document "call per use, don't cache" as best practice. `unpublishPermissionsService()` on shutdown clears the slot as extra safety.                  |
| `exports` field breaks Pi's jiti loader resolution                  | Pi's loader uses `pi.extensions` (not `exports`) to find the extension factory. The `exports` field only affects bare-specifier `import()` from other extensions. Verify with `pnpm run build` + smoke test. |
| Consumer calls `getPermissionsService()` before provider has loaded | Returns `undefined` — the consumer's `if (permissions) { ... }` guard handles this. Same as the RPC fallback path's timeout. Document load-order independence.                                               |
| `buildInputForSurface` extraction breaks RPC handler                | The function body is unchanged; only its location moves. Existing `permission-event-rpc.test.ts` tests pass as-is.                                                                                           |
| `globalThis` pollution across unrelated processes                   | `Symbol.for()` keys are scoped by the full string name (`"@gotgenes/pi-permission-system:service"`). Collision with other packages is infeasible. Cleanup on shutdown removes the slot.                      |

## Open Questions

1. **Should the service expose `getToolPermission()` for tool-filtering queries?**
   The current RPC only exposes `checkPermission`.
   Adding `getToolPermission` would let consumers replicate before\_agent\_start filtering.
   Deferred — add when a consumer needs it.
2. **Should additional event types be re-exported from `src/service.ts`?**
   Consumers using the service accessor for policy queries may also want `PermissionDecisionEvent` for observation.
   Subpath exports (`"./events"`) can be added later without breaking changes.
3. **Should the `exports` field include a `"types"` condition?**
   Since the entry point is a `.ts` file and jiti consumers resolve types natively, a `"types"` condition adds no value today.
   Revisit if a JS build step is added.
