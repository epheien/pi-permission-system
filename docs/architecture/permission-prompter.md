# PermissionPrompter

`src/authority/permission-prompter.ts`

## Responsibility

`PermissionPrompter` brackets the ask-path flow with review-log entries and delegates the live decision to the selected `Authorizer` ([#555]):

1. **Review log — waiting** — write `permission_request.waiting` before the authorizer is consulted.
2. **`authorizer.authorize(details)`** — the selected `Authorizer` (`LocalUserAuthorizer`, `ParentAuthorizer`, or `DenyingAuthorizer`) resolves the decision.
   The UI-prompt broadcast and the UI/forwarding branching this class previously owned now live on the individual `Authorizer` implementations — see [architecture.md's authority model](architecture.md#the-authority-model).
3. **Review log — outcome** — write `permission_request.approved` or `permission_request.denied` with the final decision state and any denial reason.
   The denied entry's `resolution` is the decision state, or `confirmation_unavailable` when the decision carries that marker — a `DenyingAuthorizer` denial, i.e. no live authority was reachable (a no-UI, non-subagent session) ([#556]).

Yolo-mode auto-approval is resolved upstream, at the composition stage (`PermissionManager.check`'s `rewriteAsksToYolo`) — an `ask` never reaches this class under yolo, so `PermissionPrompter` has no yolo-mode knowledge.

## Why a class instead of a free function

The previous implementation was `promptPermission(runtime, forwardingDeps, ctx, details)` in `runtime.ts`.
Adding a new field to `PromptPermissionDetails` (e.g. `sessionLabel` in #51) required touching four files: `types.ts` → `runtime.ts` → `polling.ts` → `index.ts`.

With `PermissionPrompter`, adding a new field touches two files:

- `src/authority/permission-prompter.ts` — add the field to `PromptPermissionDetails`.
- The `Authorizer` implementation(s) that read the new field — currently `local-user-authorizer.ts` and `approval-escalator.ts` (`ParentAuthorizer`).

Handler code and wiring in `index.ts` are unaffected.

## Interfaces

```typescript
interface PermissionPrompterApi {
  prompt(authorizer: Authorizer, details: PromptPermissionDetails): Promise<PermissionPromptDecision>;
}

interface PermissionPrompterDeps {
  logger: ReviewLogger; // review-log bracketing only
}
```

`PermissionPrompterApi` is the narrow seam `AuthorizerSelection` depends on (not the concrete class) — a private field on the concrete class would create a nominal brand a structural test mock (`{ prompt: vi.fn() }`) cannot satisfy without a cast.

`Authorizer` is the single live-authority role, defined in `src/authority/authorizer.ts`:

```typescript
interface Authorizer {
  authorize(details: PromptPermissionDetails): Promise<PermissionPromptDecision>;
}
```

## Relationship to the Authorizer spine

`PermissionPrompter` no longer assembles or holds any UI/forwarding dependency — it receives the already-selected `Authorizer` as a call-time argument from `AuthorizerSelection.prompt(details)`, rather than threading `ExtensionContext` through a `forwarder.requestApproval(ctx, …)` call.
`AuthorizerSelection` (the rewrite of the former `PromptingGateway`) owns the selection: `selectAuthorizer(ctx, deps)` runs once per session activation and returns the `Authorizer` for that context — `LocalUserAuthorizer` when `ctx.hasUI`, `ParentAuthorizer` when the context is a no-UI subagent, `DenyingAuthorizer` otherwise.

## Wiring

`PermissionPrompter` is instantiated once in `piPermissionSystemExtension()` (`src/index.ts`) and injected into `AuthorizerSelection`:

```typescript
const prompter = new PermissionPrompter({ logger });

const authorizerSelection = new AuthorizerSelection({
  detection: subagentDetection,
  events: pi.events,
  requestPermissionDecisionFromUi,
  forwardingDir: paths.forwardingDir,
  registry: subagentRegistry,
  logger,
  prompter,
});
```

`authorizerSelection` implements `AskEscalator` and is passed to both `PermissionSession` (as the `activate`/`deactivate` lifecycle) and `GateRunner` (as the `escalate(details)` ask-escalation role).
`GateRunner` calls `this.prompter.escalate(details)` for every `ask` — there is no `canConfirm()` pre-check ([#556] dissolved it); the selected `Authorizer` always answers, the `DenyingAuthorizer` by denying with the `confirmationUnavailable` marker.
The Authorizer spine is entirely behind that seam.

[#555]: https://github.com/gotgenes/pi-packages/issues/555
[#556]: https://github.com/gotgenes/pi-packages/issues/556
