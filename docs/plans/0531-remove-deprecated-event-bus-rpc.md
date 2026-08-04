---
issue: 531
issue_title: "pi-permission-system: remove the deprecated permissions:rpc:check / permissions:rpc:prompt event-bus channel"
---

# Remove the deprecated `permissions:rpc:check` / `permissions:rpc:prompt` event-bus channel

## Release Recommendation

**Release:** ship independently

This is Phase 8 Step 7, tagged `Release: independent` in the roadmap and explicitly called out as "ships as its own major-bump release, separate from the other Phase 8 batches."
It is a **breaking** change for event-bus RPC consumers, so it cuts its own `feat(pi-permission-system)!:` major release rather than batching with the yolo-recorded-authority batch (Steps 2–3, already shipped) or the auto-batching refactors (Steps 5, 6, 8).

## Problem Statement

The package exposes two cross-extension mechanisms for the same jobs: a `Symbol.for()`-backed `PermissionsService` (the modern, synchronous, type-safe path) and an event-bus RPC channel pair (`permissions:rpc:check` for policy queries, `permissions:rpc:prompt` for prompt forwarding).
The RPC check channel and its request/reply types are already marked `@deprecated` in favor of the service accessor.
The RPC prompt handler is a third, parallel elicitation path — with its own `hasUI` check, its own review-log entry, and its own UI-prompt event — alongside the gate prompt and the file-based forwarded inbox.
The Phase 9 authority spine would otherwise have to adapt all three elicitation paths.
Removing the RPC channel now collapses the cross-extension surface to a single service accessor and narrows the spine's scope from three elicitation paths to two.

## Goals

- Delete the entire event-bus RPC subsystem: both the `permissions:rpc:check` and `permissions:rpc:prompt` handlers.
- Remove the RPC request/reply payload types, channel constants, the shared `PermissionsRpcReply` envelope, and the RPC-only `PERMISSIONS_PROTOCOL_VERSION` from the public event contract.
- Remove the now-dead `rpc_prompt` UI-prompt source and its `buildRpcUiPrompt` builder.
- Unwire RPC registration from `index.ts` and drop the two RPC unsubscribe handles from the `PermissionServiceLifecycle` subscription list.
- Repoint the cross-extension docs exclusively at the `Symbol.for()` service accessor.
- Mark Phase 8 Step 7 complete in `docs/architecture/architecture.md`.
- Comment on [#309] to record that this narrows its scope to the service bash path only.
- **Breaking** for any external event-bus RPC consumer — carried as `feat(pi-permission-system)!:` with a `BREAKING CHANGE:` footer.

## Non-Goals

- The Phase 9 authority spine itself (the `Authorizer` interface and its implementations).
  This step only removes friction in its way.
- The file-based forwarded inbox (`src/authority/` escalation/serving machinery).
  It is a distinct elicitation path and stays; the RPC prompt channel is a separate, parallel path.
- The `Symbol.for()` service accessor (`PermissionsService`) and its broadcast channels (`permissions:ready`, `permissions:ui_prompt`, `permissions:decision`).
  These are the surviving cross-extension surface.
- Editing the frozen phase-history docs (`docs/architecture/history/phase-4-constructibility.md`, `phase-7-accesspath-universal-representation.md`).
  They record past-phase state accurately and are intentionally left unchanged; their RPC references describe what was true then.
- Resolving [#309] itself — this plan only leaves a scope-narrowing comment on it.

## Background

Relevant modules (all under `packages/pi-permission-system/`):

- `src/permission-event-rpc.ts` — the whole RPC subsystem: `registerPermissionRpcHandlers` registers both `permissions:rpc:check` (routes policy queries through the shared `PermissionResolver` as an `access-path` intent, #503) and `permissions:rpc:prompt` (forwards a prompt to the parent UI).
  Both handlers are removed with the file.
- `src/permission-events.ts` — the public event contract: channel-name constants, `PERMISSIONS_PROTOCOL_VERSION`, the `PermissionsRpcReply` envelope, the RPC request/reply types, plus the surviving broadcast types (`PermissionsReadyEvent`, `PermissionUiPromptEvent`, `PermissionDecisionEvent`) and emit helpers.
- `src/service.ts` — the `package.json` `exports` entry point; re-exports a subset of `permission-events.ts` symbols, including the RPC prompt channel, the RPC prompt types, `PermissionsRpcReply`, and `PERMISSIONS_PROTOCOL_VERSION`.
- `src/permission-ui-prompt.ts` — centralized `permissions:ui_prompt` payload construction; `buildRpcUiPrompt` / `RpcPromptInput` build the `rpc_prompt`-source event, called only by the RPC prompt handler.
- `src/authority/forwarding-io.ts` — `UI_PROMPT_SOURCES` whitelists valid persisted prompt sources for tolerant forwarded-request reads; includes `"rpc_prompt"`.
- `src/index.ts` — the composition root; constructs the resolver, calls `registerPermissionRpcHandlers`, and threads `rpcHandles.unsubCheck` / `rpcHandles.unsubPrompt` into `PermissionServiceLifecycle`.
- `src/service-lifecycle.ts` — `PermissionServiceLifecycle` receives the subscription list as an opaque `readonly (() => void)[]`; it has **no** direct RPC reference, so "unwire from `PermissionServiceLifecycle`" means dropping the two handles at the `index.ts` construction site, not editing this file.

Tests: `test/permission-event-rpc.test.ts` (deleted whole), `test/permission-events.test.ts` (RPC type/constant blocks), `test/permission-ui-prompt.test.ts` (`buildRpcUiPrompt` block), `test/composition-root.test.ts` (the RPC-check arm of the single-source-of-truth test).

Docs: `docs/cross-extension-api.md` (RPC sections + event tables), `docs/architecture/architecture.md` (cross-extension paragraph, directory tree, Phase 8 Step 7 marker + Mermaid node + metric row).

Constraints from AGENTS.md and the package skill:

- Removing a public export breaks every importer at the type level in the same commit — fold the export removal, `service.ts` re-export drop, and all consumer-test updates into one atomic step.
- The `package.json` `exports` field points at `src/service.ts`; whatever it re-exports is the public cross-extension API.
- Mark the roadmap step ✅ in the implementation doc-update commit (`✅` on both the step heading and its Mermaid node, plus any stale metric row), not a deferred `/ship-issue` commit.
- Use `feat(pi-permission-system)!:` — `!` after the scope — with a `BREAKING CHANGE:` footer separated from the body by a blank line.
- Do not put `Closes #531` in the commit; reference as `Refs #531`.

## Design Overview

This is a pure subtractive change: no new collaborator, no new parameter, no widened interface.
A design-review pass finds nothing to fix — removing the RPC subsystem strictly narrows the cross-extension surface and removes one elicitation path.
The only judgment calls are how far the dead-code removal cascades, resolved below.

### What is removed vs. what survives

The surviving cross-extension surface after this change:

- `PermissionsService` via `getPermissionsService()` (the `Symbol.for()` accessor) — policy queries and prompt-relevant registration.
- Broadcast channels: `permissions:ready`, `permissions:ui_prompt`, `permissions:decision` (fire-and-forget observation).
- The file-based forwarded inbox (subagent → parent prompt forwarding) — unchanged.

Everything RPC-specific is removed:

- Channel constants `PERMISSIONS_RPC_CHECK_CHANNEL`, `PERMISSIONS_RPC_PROMPT_CHANNEL`.
- Request/reply types `PermissionsCheckRequest`, `PermissionsCheckReplyData`, `PermissionsPromptRequest`, `PermissionsPromptReplyData`.
- The RPC envelope `PermissionsRpcReply<T>`.
- `PERMISSIONS_PROTOCOL_VERSION` — an RPC-only concept.
  The surviving broadcasts explicitly carry no `protocolVersion`; their contract is "the published types plus package semver" (documented in `permission-events.ts` and `cross-extension-api.md`).
  With no RPC envelope, the version constant has no remaining reader.

### Dead-code cascade (removed, dictated by code-design)

Once both RPC handlers are gone, three symbols become dead and are removed in the same change rather than left as orphans:

- `buildRpcUiPrompt` / `RpcPromptInput` (`permission-ui-prompt.ts`) — sole caller was the RPC prompt handler.
- `"rpc_prompt"` member of the `PermissionUiPromptSource` union (`permission-events.ts`) — only the RPC prompt handler ever emitted a `permissions:ui_prompt` event with this source.
  The file-based forwarded inbox never persisted `"rpc_prompt"` (forwarded requests are written by `ApprovalEscalator`, which never used the RPC path), so narrowing the union cannot orphan a persisted request.
- `"rpc_prompt"` entry in `UI_PROMPT_SOURCES` (`forwarding-io.ts`) — the tolerant-read whitelist for persisted forwarded sources; safe to drop for the same reason.

Narrowing the public `PermissionUiPromptSource` union is itself a breaking type change, but it is subsumed by the major bump this change already requires, and it is correct: no runtime `permissions:ui_prompt` event will carry `"rpc_prompt"` after the handlers are gone.

### `permission-events.ts` doc touch-up

The `PermissionsReadyEvent` doc comment currently reads "Version negotiation lives in the RPC envelope (`PermissionsRpcReply`)."
With the envelope removed, reword it to state the broadcast contract is defined by the published types plus package semver (matching the existing `ui_prompt`/`decision` comments), with no reference to a removed symbol.

### Migration note (verified against the real surface)

The RPC check consumer migrates to the service accessor.
Verified against the real `PermissionsService` interface in `src/service.ts`:

```typescript
const { getPermissionsService } = await import("@gotgenes/pi-permission-system");
const service = getPermissionsService();
if (service) {
  const result = service.checkPermission("bash", "git push");
  // result: PermissionCheckResult { state, matchedPattern, origin, ... }
}
```

`checkPermission(surface, value?, agentName?)` is the replacement for `permissions:rpc:check`.
There is **no** service-accessor replacement for `permissions:rpc:prompt` — prompt forwarding is an internal subagent→parent mechanism (the file-based inbox), not a public cross-extension operation.
The migration note must say the prompt-forwarding RPC is removed with no public replacement, rather than inventing one.

## Module-Level Changes

Deleted:

- `src/permission-event-rpc.ts` — the whole RPC subsystem.
- `test/permission-event-rpc.test.ts` — its test.

`src/permission-events.ts`:

- Remove `PERMISSIONS_PROTOCOL_VERSION`.
- Remove `PERMISSIONS_RPC_CHECK_CHANNEL`, `PERMISSIONS_RPC_PROMPT_CHANNEL`.
- Remove `PermissionsRpcReply`, `PermissionsCheckRequest`, `PermissionsCheckReplyData`, `PermissionsPromptRequest`, `PermissionsPromptReplyData`.
- Remove the `"rpc_prompt"` member from the `PermissionUiPromptSource` union.
- Reword the `PermissionsReadyEvent` doc comment to drop the `PermissionsRpcReply` reference.

`src/service.ts`:

- Drop `PermissionsPromptReplyData`, `PermissionsPromptRequest`, `PermissionsRpcReply` from the `export type { … }` block.
- Drop `PERMISSIONS_PROTOCOL_VERSION`, `PERMISSIONS_RPC_PROMPT_CHANNEL` from the `export { … }` block.

`src/permission-ui-prompt.ts`:

- Remove `RpcPromptInput` and `buildRpcUiPrompt`.

`src/authority/forwarding-io.ts`:

- Remove `"rpc_prompt"` from the `UI_PROMPT_SOURCES` array (and confirm the `satisfies readonly PermissionUiPromptSource[]` assertion still holds against the narrowed union).

`src/index.ts`:

- Remove the `import { registerPermissionRpcHandlers } from "./permission-event-rpc"`.
- Remove the `const rpcHandles = registerPermissionRpcHandlers(...)` call and its explanatory comment (the resolver is still constructed — only its RPC consumer is removed; adjust the comment that says "the RPC and service route their policy queries through it" to name only the service).
- Change the `PermissionServiceLifecycle` subscription list from `[rpcHandles.unsubCheck, rpcHandles.unsubPrompt, unsubSubagentLifecycle]` to `[unsubSubagentLifecycle]`.

Tests:

- `test/permission-events.test.ts` — remove the `PERMISSIONS_PROTOCOL_VERSION is 1` test; remove the two RPC channel-name assertions from the `channel names` test (keep the surviving broadcast channel assertions); remove the `type shapes (PermissionsRpcReply)`, `PermissionsCheckRequest`, `PermissionsCheckReplyData`, `PermissionsPromptRequest`, `PermissionsPromptReplyData` describe blocks and their imports.
- `test/permission-ui-prompt.test.ts` — remove the `buildRpcUiPrompt` describe block and its import.
- `test/composition-root.test.ts` — remove the RPC-check arm of the single-source-of-truth test (the `PERMISSIONS_RPC_CHECK_CHANNEL` emit/reply assertions and the import) while keeping the `getPermissionsService()!.checkPermission("demo")` assertion that the same test makes; that service-accessor assertion still proves session-approval visibility, so the test's purpose survives.

Docs:

- `docs/cross-extension-api.md` — remove the "Policy Query RPC (deprecated)" and "Prompt Forwarding RPC" sections; remove the four RPC rows from the event-bus channel table; remove the `PERMISSIONS_PROTOCOL_VERSION` paragraph and the ping-style-RPC-readiness paragraph; drop `"rpc_prompt"` from the `source` field description; reword the opening "Event bus — broadcasts and RPC" framing to "broadcasts only" and point the "how to query policy" guidance exclusively at the service accessor.
- `docs/architecture/architecture.md` — update the cross-extension paragraph (drop the "event-bus RPC remains as a zero-dependency fallback" and "`permissions:rpc:prompt` remain on the event bus" sentences); remove the `permission-event-rpc.ts` line from the directory-tree listing and adjust the `permission-events.ts` line if it enumerates RPC types; mark Phase 8 Step 7 ✅ on its heading and on the `S7` Mermaid node; flip the "Elicitation paths the spine must adapt" metric row (3 → 2) to done.

Not changed (verified — no stale references remain):

- `docs/architecture/history/*.md` — frozen phase history, intentionally unchanged (see Non-Goals).
- `README.md`, `docs/configuration.md` — grep confirms no RPC references.
- `schemas/permissions.schema.json`, `config/config.example.json` — RPC is not a config surface.
- No other package in the monorepo imports any RPC symbol (grep of `packages/` confirms zero external consumers).

## Test Impact Analysis

This is a removal, not an extraction, so the analysis is inverted — what tests go away, and what must be preserved:

1. **New tests enabled:** none.
   Removal enables no new lower-level test surface.
2. **Tests that become redundant / removed:** `test/permission-event-rpc.test.ts` (whole file — it exercises only the deleted handlers); the RPC type-shape and constant blocks in `test/permission-events.test.ts`; the `buildRpcUiPrompt` block in `test/permission-ui-prompt.test.ts`; the RPC-check arm of the composition-root single-source-of-truth test.
3. **Tests that must stay as-is:** the surviving broadcast tests in `test/permission-events.test.ts` (`emitReadyEvent`, `emitUiPromptEvent`, `emitDecisionEvent`, the ready-event wiring test); the `buildDirectUiPrompt` / `buildForwardedUiPrompt` blocks in `test/permission-ui-prompt.test.ts`; the session-approval assertion via `getPermissionsService()` in the composition-root test (it must keep proving session rules reach the surviving service path).

No regression test is added for "the RPC channel no longer replies" — asserting the absence of a deleted handler tests nothing meaningful; the deletion is proven by the removed handler tests and a green suite.

## Invariants at risk

- **Single-source-of-truth for tool policy (#296 / composition-root test).**
  The composition-root test currently proves session approvals reach *both* the RPC channel and the service accessor.
  After removing the RPC arm, the service-accessor assertion must remain and continue to prove the invariant.
  Pinned by the surviving `getPermissionsService()!.checkPermission("demo")` assertion in that test — no new test needed.
- **`permissions:ui_prompt` broadcast contract.**
  Narrowing `PermissionUiPromptSource` must not break the surviving `buildDirectUiPrompt` / `buildForwardedUiPrompt` builders or `forwarding-io.ts`'s tolerant read.
  Pinned by the retained builder tests and by `tsc` (the `satisfies readonly PermissionUiPromptSource[]` assertion on `UI_PROMPT_SOURCES` fails to compile if the array and the narrowed union disagree).

## TDD Order

This is a subtractive change with no new behavior to drive red→green; each step's "green" is the existing suite passing after the removal, gated by `pnpm run check` + `pnpm run lint` + `pnpm run test`.
Because removing public exports from `permission-events.ts` breaks `service.ts`, the deleted handler file, and every consumer test at the type level simultaneously, the code+test removal is one atomic step.

1. **Remove the RPC subsystem and all consumers (atomic).**
   Delete `src/permission-event-rpc.ts` and `test/permission-event-rpc.test.ts`; remove the RPC constants, request/reply types, `PermissionsRpcReply`, `PERMISSIONS_PROTOCOL_VERSION`, and the `"rpc_prompt"` union member from `src/permission-events.ts` (and reword the `PermissionsReadyEvent` comment); remove `buildRpcUiPrompt` / `RpcPromptInput` from `src/permission-ui-prompt.ts`; remove `"rpc_prompt"` from `src/authority/forwarding-io.ts`; drop the RPC re-exports from `src/service.ts`; unwire registration and the two unsub handles from `src/index.ts`; update `test/permission-events.test.ts`, `test/permission-ui-prompt.test.ts`, and the RPC arm of `test/composition-root.test.ts`.
   Verify: `pnpm --filter @gotgenes/pi-permission-system run check` (tsc catches any missed importer), `pnpm --filter @gotgenes/pi-permission-system run lint`, `pnpm --filter @gotgenes/pi-permission-system run test`, and `pnpm fallow dead-code` (confirms no orphaned RPC symbol survives).
   Commit: `feat(pi-permission-system)!: remove deprecated event-bus RPC channel (#531)` with a `BREAKING CHANGE:` footer stating the `permissions:rpc:check` / `permissions:rpc:prompt` channels are removed, that `permissions:rpc:check` consumers migrate to `getPermissionsService().checkPermission(surface, value?, agentName?)`, and that `permissions:rpc:prompt` is removed with no public replacement (prompt forwarding is internal).

2. **Repoint the docs and mark the roadmap step complete.**
   Rewrite the RPC sections of `docs/cross-extension-api.md` to point exclusively at the service accessor (remove the two RPC sections, the four channel-table rows, the protocol-version and readiness-ping paragraphs, and the `rpc_prompt` source mention); update `docs/architecture/architecture.md` (cross-extension paragraph, directory tree, Phase 8 Step 7 ✅ + `S7` Mermaid node ✅, "Elicitation paths" metric row → done).
   Verify: `pnpm run lint` (rumdl) passes; no dangling `[#N]:` link definitions; grep confirms no surviving RPC reference outside the frozen history docs.
   Commit: `docs(pi-permission-system): repoint cross-extension docs off the removed RPC channel (#531)`.

3. **Comment on [#309].**
   Post a comment via `gh issue comment 309` noting that removing the event-bus RPC narrows #309's scope to the advisory service bash path only — the RPC bash path referenced in its proposed-change item 3 no longer exists.
   Not a commit; an issue action taken during implementation.

## Risks and Mitigations

- **Missed importer of a removed symbol.**
  `tsc` (via `pnpm run check`) fails the build on any dangling import, and `pnpm fallow dead-code` catches orphaned symbols.
  The atomic step 1 keeps the tree compiling at every commit boundary.
  Mitigated.
- **External event-bus RPC consumers break silently on upgrade.**
  This is the intended breaking change.
  Mitigated by the `feat!:` major bump, the `BREAKING CHANGE:` footer, the migration note, and the repointed cross-extension docs.
- **Narrowing the public `PermissionUiPromptSource` union surprises a broadcast consumer.**
  A consumer with an exhaustive switch over the old union still compiles against their own copy; no runtime event will carry `"rpc_prompt"` after removal, so the narrowing is behavior-correct.
  Documented in the migration note.
  Mitigated.
- **Stale RPC mention left in a doc.**
  A repo-wide grep after step 2 confirms the only remaining references live in the frozen `docs/architecture/history/*.md` files, which are intentionally preserved.
  Mitigated.

## Open Questions

None.
The scope is fully determined by the issue, the Phase 8 roadmap (Step 7), and the code grep; the two judgment calls (removing the RPC-only `PERMISSIONS_PROTOCOL_VERSION` / `PermissionsRpcReply`, and the dead `rpc_prompt` source cascade) are resolved in Design Overview and dictated by code-design's remove-dead-code rule.

[#309]: https://github.com/gotgenes/pi-packages/issues/309
