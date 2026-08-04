---
issue: 398
issue_title: "Subagent stuck in a permission-asking loop"
---

# Fix overlapping forwarded-permission cleanup race

## Problem Statement

When two or more in-process subagents have overlapping forwarded-permission lifecycles — one request finishing while another is still pending — the parent re-prompts the still-pending request immediately and indefinitely, and selecting Yes or No has no effect.
Only killing the `pi` process exits the loop.

The race opens between a finishing request and the next cleanup pass:

1. Subagent A's request is answered; A reads the response and deletes both its request and response files, leaving `requests/` and `responses/` momentarily empty.
2. Subagent B drops its request into `requests/` before the parent's cleanup pass runs.
3. `cleanupPermissionForwardingLocationIfEmpty()` removes each empty sub-directory independently: it sees `responses/` empty and removes it, while `requests/` (now holding B's file) is kept.
4. The parent's next `processInbox()` resolves the location via `getExistingPermissionForwardingLocation()`, which only checks that `requests/` exists, then proceeds.
5. The eventual `writeJsonFileAtomic(location.responsesDir, …)` fails with `ENOENT` because `responses/` is gone.
6. The error is caught and the function returns without writing a response; the requester never sees a response file, re-emits the forwarded request, and the parent re-prompts — the loop.

A single subagent issuing serial requests never hits this, because each lifecycle ends with both directories empty and cleanly removed.
The race requires `requests/` to become non-empty (B's arrival) between A's response file disappearing and cleanup running, which only exists with overlapping requests.

## Goals

- Preserve response delivery when forwarded-permission requests from multiple subagents overlap in time.
- Stop `responses/` from being removed while `requests/` still holds a pending request (root-cause invariant — fix (b)).
- Defensively recreate `responses/` in `processInbox()` before any response write, also guarding against external directory removal (defense-in-depth — fix (a)).
- This is a non-breaking bug fix: no config, output shape, or default changes; commit as `fix:`.

## Non-Goals

- No change to the file-based forwarding protocol, request/response JSON shapes, or directory layout.
- No change to `getExistingPermissionForwardingLocation()`'s `requests/`-only existence check — the fix makes the downstream write resilient instead of widening that probe.
- No change to the polling/timeout constants or the requester-side `pollForForwardedResponse` cleanup.
- No new locking primitive or cross-process mutex — the fix keeps the cheap fast-path and relies on the coupled-directory invariant plus on-demand recreation.

## Background

Relevant modules, both under `src/forwarded-permissions/`:

- `io.ts`
  - `cleanupPermissionForwardingLocationIfEmpty(logger, location)` (line 218) removes `requestsDir`, `responsesDir`, and `sessionRootDir` independently via `tryRemoveDirectoryIfEmpty`.
  - `tryRemoveDirectoryIfEmpty(logger, path, description)` (line 178) returns `void` today; it removes a directory only when it exists and is empty, swallowing `ENOENT`/`ENOTEMPTY`.
  - `ensureDirectoryExists(logger, path, description)` (line 97) `mkdirSync(recursive)` and returns a `boolean` success flag — already exported and used by `ensurePermissionForwardingLocation`.
- `permission-forwarder.ts`
  - `processInbox(ctx)` (line 239) resolves the location via `getExistingPermissionForwardingLocation()`, lists request files, and processes each via `processSingleForwardedRequest`, then runs cleanup.
  - `processSingleForwardedRequest()` (line 451) writes the response with `writeJsonFileAtomic(this.logger, join(location.responsesDir, …))` (the line that throws `ENOENT`).

Constraint from the package skill (`package-pi-permission-system`): the forwarding round-trip is exercised by real-filesystem tests, not mocks — `test/permission-forwarder.test.ts`'s `processInbox` block already uses `mkdtempSync`/`mkdirSync` against a tmp `forwardingDir`.
The fix follows that pattern rather than mocking `node:fs`.

## Design Overview

Two coordinated changes that together close the race at its source and harden the write site.

### Fix (b) — couple `responses/` removal to `requests/` emptiness

Make `tryRemoveDirectoryIfEmpty` report whether the directory is gone after the call, then gate the `responses/` removal on the `requests/` removal:

```typescript
/** Returns true if the directory is absent after the call (removed or never existed). */
export function tryRemoveDirectoryIfEmpty(
  logger: DebugReviewLogger | null,
  path: string,
  description: string,
): boolean {
  if (!existsSync(path)) return true;
  // …read entries; on non-empty return false…
  // …rmdirSync; ENOENT → true, ENOTEMPTY → false, other → log + false…
}

export function cleanupPermissionForwardingLocationIfEmpty(logger, location): void {
  const requestsGone = tryRemoveDirectoryIfEmpty(logger, location.requestsDir, …);
  if (requestsGone) {
    tryRemoveDirectoryIfEmpty(logger, location.responsesDir, …);
  }
  tryRemoveDirectoryIfEmpty(logger, location.sessionRootDir, …);
}
```

Return-value semantics for `tryRemoveDirectoryIfEmpty`:

| Situation                      | Return                          |
| ------------------------------ | ------------------------------- |
| Directory absent on entry      | `true`                          |
| `readdirSync` throws           | `false` (still present, logged) |
| Directory non-empty            | `false`                         |
| `rmdirSync` succeeds           | `true`                          |
| `rmdirSync` throws `ENOENT`    | `true` (already gone)           |
| `rmdirSync` throws `ENOTEMPTY` | `false` (raced re-fill)         |
| `rmdirSync` throws other       | `false` (logged)                |

When B's request sits in `requests/`, `requestsGone` is `false`, so `responses/` is preserved even though it is momentarily empty — the invariant "while a request is pending, its response directory survives" holds.
`sessionRootDir` removal is unchanged: it only succeeds when both sub-directories are already gone, so it stays naturally guarded.
The return type widening from `void` to `boolean` is additive — both existing call sites are in `cleanupPermissionForwardingLocationIfEmpty` within the same file, and no other module imports the function.

### Fix (a) — recreate `responses/` before writing in `processInbox`

After confirming non-empty `requestFiles`, ensure `responses/` exists before processing any request:

```typescript
const requestFiles = listRequestFiles(this.logger, location.requestsDir);
if (requestFiles.length === 0) return;

if (
  !ensureDirectoryExists(
    this.logger,
    location.responsesDir,
    "permission forwarding responses",
  )
) {
  return;
}

for (const fileName of requestFiles) { … }
```

This preserves the cheap fast-path (no `mkdir` when the inbox is empty), recreates `responses/` if a concurrent cleanup or external actor removed it, and returns early (logging via `ensureDirectoryExists`) only if the directory genuinely cannot be created.
`ensureDirectoryExists` is already exported from `io.ts`; the change adds it to the existing import block in `permission-forwarder.ts`.

### Why both

Fix (b) removes the window where `responses/` is deleted out from under a pending request, addressing the documented cause.
Fix (a) is cheap insurance: even if a future code path or an external process removes `responses/`, the parent recreates it on demand rather than failing the write.
The reporter applied (a) locally and confirmed it stops the loop; (b) makes the directory pair behave correctly without relying on the recreate.

### Edge cases

- Empty inbox: `processInbox` still returns before the `ensureDirectoryExists` call — fast-path intact.
- `requests/` non-empty but `responses/` present (normal): fix (a) is a no-op `mkdirSync(recursive)`; fix (b) leaves both in place.
- `requests/` empty, `responses/` empty (serial single-subagent lifecycle): `requestsGone` is `true`, so `responses/` is removed exactly as today — no regression.
- `requests/` removed but `responses/` non-empty (a stale response with no pending request): `requestsGone` is `true`, `responses/` removal is attempted and skipped because it is non-empty — unchanged.

## Module-Level Changes

- `src/forwarded-permissions/io.ts`
  - `tryRemoveDirectoryIfEmpty`: change return type `void → boolean`; return `true`/`false` per the table above.
  - `cleanupPermissionForwardingLocationIfEmpty`: capture the `requests/` result and only attempt `responses/` removal when `requests/` is gone.
- `src/forwarded-permissions/permission-forwarder.ts`
  - Add `ensureDirectoryExists` to the `./io` import block.
  - `processInbox`: insert the `ensureDirectoryExists(location.responsesDir)` guard after the non-empty `requestFiles` check, returning early on failure.
- `test/forwarded-permissions/io.test.ts`
  - Add a `cleanupPermissionForwardingLocationIfEmpty` describe block with real-tmpdir cases (currently the file only covers pure helpers).
- `test/permission-forwarder.test.ts`
  - Add a `processInbox` case where `responses/` is absent on entry.

No architecture-doc references to these functions exist (`docs/architecture/` does not list `cleanupPermissionForwardingLocationIfEmpty`, `tryRemoveDirectoryIfEmpty`, or `responsesDir`); the only doc mention is the prior plan `0317`, which is historical and not updated.

## Test Impact Analysis

1. New tests enabled:
   - `tryRemoveDirectoryIfEmpty` / `cleanupPermissionForwardingLocationIfEmpty` gain direct unit coverage that did not exist — `io.test.ts` previously only tested the pure string/error helpers.
     The key new case: `requests/` non-empty + `responses/` empty ⇒ `responses/` survives.
   - `processInbox` gains a case proving it recreates a missing `responses/` and still writes a response (the (a) guard).
2. Redundant tests: none.
   The existing `processInbox` tests construct `responses/` explicitly and assert UI-prompt behavior; they remain valid and are untouched.
3. Tests that must stay as-is: the three existing `processInbox` real-filesystem tests genuinely exercise the prompt/auto-approve paths and the happy-path response write; they continue to assert current behavior unchanged.

## TDD Order

1. Red → Green → Commit — cleanup invariant (fix (b)).
   - Test surface: `test/forwarded-permissions/io.test.ts`, new `cleanupPermissionForwardingLocationIfEmpty` describe.
   - Cover: (i) `requests/` non-empty + `responses/` empty ⇒ `responses/` still exists after cleanup, `requests/` still exists; (ii) both empty ⇒ both removed (and `sessionRoot` removed); (iii) optional direct `tryRemoveDirectoryIfEmpty` return-value assertions (absent ⇒ `true`, non-empty ⇒ `false`).
   - Green: widen `tryRemoveDirectoryIfEmpty` to return `boolean`; gate `responses/` removal on `requestsGone` in `cleanupPermissionForwardingLocationIfEmpty`.
   - Commit: `fix: preserve forwarded-permission responses dir while requests pending (#398)`.
2. Red → Green → Commit — recreate `responses/` before write (fix (a)).
   - Test surface: `test/permission-forwarder.test.ts`, new `processInbox` case.
   - Cover: write a request file into `requests/` but do not create `responses/`; run `processInbox` with a stubbed `requestPermissionDecisionFromUi` returning approval; assert a response file now exists under `responsesDir` (recreated) and no `permission_forwarding.error` was logged.
   - Green: add `ensureDirectoryExists` import and the early-return guard in `processInbox`.
   - Commit: `fix: recreate forwarded-permission responses dir before write (#398)`.

Both steps change only internal behavior and add no shared interface field, so each can land independently; run `pnpm --filter @gotgenes/pi-permission-system run check` after step 1 (the return-type widening) to confirm no caller breaks.

## Risks and Mitigations

- Risk: widening `tryRemoveDirectoryIfEmpty`'s return type breaks an external caller.
  Mitigation: grep confirms both call sites are inside `cleanupPermissionForwardingLocationIfEmpty` in the same file; the widening is additive (callers may ignore the boolean).
- Risk: fix (b) leaves an orphaned empty `responses/` if a pending request later times out without a matching cleanup.
  Mitigation: the requester-side `pollForForwardedResponse` and the parent-side `processInbox` both call `cleanupPermissionForwardingLocationIfEmpty` after their lifecycles; once `requests/` drains, the next cleanup removes `responses/` and `sessionRoot` normally.
- Risk: real-filesystem tests are flaky on slow CI.
  Mitigation: follow the established `mkdtempSync` + `try/finally rmSync` pattern already used in `permission-forwarder.test.ts`; no timing or polling is involved in the new assertions.

## Open Questions

- None blocking.
  A deeper hardening (a single atomic "claim" of the session directory per inbox pass) is out of scope; the coupled-invariant plus on-demand recreation resolves the reported loop without new mechanism.
