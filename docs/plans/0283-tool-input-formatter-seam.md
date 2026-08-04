---
issue: 283
issue_title: "Formatter extension seam for custom tool input previews"
---

# Tool input formatter extension seam

## Problem Statement

Permission prompts exist so the user can make an informed allow/deny decision about a tool call.
For tools with structured JSON input — especially MCP tools — the default truncated-JSON preview is hard to read, which defeats the prompt's purpose.
The issue asks for a generative provider seam on `ToolPreviewFormatter` so other extensions can register a custom preview formatter for a specific tool name, with the core calling registered formatters during prompt construction and falling back to the default preview when a formatter declines (returns `undefined`).
This follows the pi-subagents extension-surface model (`registerWorkspaceProvider(provider): () => void`): a registration method that returns a disposer, where the core invokes the registered provider at execution time.

## Goals

- Add a persistent `ToolInputFormatterRegistry` that maps a tool name to a single custom formatter and hands back a disposer on registration.
- Expose `registerToolInputFormatter(toolName, formatter): () => void` on the cross-extension `PermissionsService` (the `Symbol.for()` accessor) — the only channel a sibling extension can reach.
- Consult a registered formatter first inside `ToolPreviewFormatter.formatToolInputForPrompt`; when it returns a string, use it verbatim; when it returns `undefined`, fall through to the existing built-in switch (and ultimately the JSON default).
- Ship one reference built-in: an MCP input summarizer keyed to the `mcp` tool, registered through the public seam at startup (dogfooding the API), that renders a compact argument summary instead of leaving the MCP prompt argument-blind.
- Keep the change additive and non-breaking: the new constructor and service members are optional/new; existing prompt behavior is unchanged when no formatter is registered.

## Non-Goals

- No pi-subagents source changes.
  The issue carries a `pkg:pi-subagents` label because the seam mirrors pi-subagents' provider-surface model, not because pi-subagents registers a formatter — doing so would make pi-subagents reach outward to a consumer, violating its "arrows point inward" principle.
  This is therefore filed as a single-package plan beside its prerequisites [#266] and [#282].
- No new config field, schema entry, or example — this is a runtime registration mechanism, not a config knob.
- No per-tool override of an already-registered formatter — a tool name holds at most one formatter (see Design Overview, duplicate handling).
- No formatter for arbitrary third-party batch tools (e.g. the `ctx_batch_execute` example from the issue body); those are exactly what a third-party extension would register through this seam.
- No change to bash or skill prompts, or to the review-log preview path.

## Background

The prerequisites are both shipped and closed:

- [#282] extracted `ToolPreviewFormatter` (`src/tool-preview-formatter.ts`) — a class constructed from `ToolPreviewFormatterOptions`.
- [#266] wired configurable limits: `handleToolCall` constructs the formatter fresh on every tool call via `new ToolPreviewFormatter(resolveToolPreviewLimits(this.session.config))` (`src/handlers/permission-gate-handler.ts:146`).

Key existing structure this plan builds on:

- `ToolPreviewFormatter.formatToolInputForPrompt(toolName, input)` is the dispatch point: a `switch` over `edit`/`write`/`read`/`find`/`grep`/`ls` with a `default` that calls `formatJsonInputForPrompt` (inline truncated JSON).
- `formatAskPrompt(result, agentName, input, formatter?)` (`src/permission-prompts.ts:30`) builds the ask-prompt sentence.
  It early-returns for `bash` and for MCP (when `result.target` is set, rendering `requested MCP target 'server:tool'`); only the generic tail calls `formatter.formatToolInputForPrompt`.
  MCP calls therefore never reach `formatToolInputForPrompt` today — the reference built-in requires a second, deliberate integration in the MCP branch.
- The formatter is constructed per tool call, so a registry of custom formatters cannot live as instance state on the formatter; it needs a persistent owner.
- `PermissionsService` (`src/service.ts`) is a `Symbol.for()`-backed object published from `index.ts`; sibling extensions retrieve it with `getPermissionsService()`.
  This is the cross-extension channel — a per-call formatter instance is unreachable from another extension.
- pi-subagents' precedent: `SubagentsService.registerWorkspaceProvider(provider): () => void` stores a single provider, throws if one already exists, and returns an identity-guarded disposer (`subagent-manager.ts:96`).

Constraints from AGENTS.md and the package skill that apply:

- Cross-extension communication must go through `pi.events` or `globalThis` + `Symbol.for()`; module-scoped singletons do not survive jiti's per-extension isolation — so the registry must be owned by the extension factory and reached via the published service.
- Enforce permissions deterministically — duplicate-registration behavior must be explicit and testable, not last-write-wins-by-accident.
- "Mechanism is forever" — keep the seam minimal; ship one built-in that proves it rather than a speculative catalog.
- When adding a new exported function that accepts domain objects, keep the parameter type narrow (ISP).

## Design Overview

### New collaborator: `ToolInputFormatterRegistry`

A persistent registry owned by the extension factory (`index.ts`), shared by the service (write side) and the per-call formatter (read side).

```typescript
// src/tool-input-formatter-registry.ts

/** A custom preview formatter for one tool's input. Returns `undefined` to decline. */
export type ToolInputFormatter = (
  input: Record<string, unknown>,
) => string | undefined;

/** Read-only lookup the formatter depends on (ISP — no register/dispose surface). */
export interface ToolInputFormatterLookup {
  get(toolName: string): ToolInputFormatter | undefined;
}

export class ToolInputFormatterRegistry implements ToolInputFormatterLookup {
  private readonly formatters = new Map<string, ToolInputFormatter>();

  /** Register a formatter for `toolName`. Throws if one already exists. Returns a disposer. */
  register(toolName: string, formatter: ToolInputFormatter): () => void {
    if (this.formatters.has(toolName)) {
      throw new Error(
        `A tool input formatter is already registered for '${toolName}'.`,
      );
    }
    this.formatters.set(toolName, formatter);
    return () => {
      if (this.formatters.get(toolName) === formatter) {
        this.formatters.delete(toolName);
      }
    };
  }

  get(toolName: string): ToolInputFormatter | undefined {
    return this.formatters.get(toolName);
  }
}
```

Duplicate handling: one formatter per tool name; a second `register` for the same name throws.
This mirrors `registerWorkspaceProvider` and keeps resolution deterministic (a package priority).
The identity-guarded disposer prevents a stale disposer from evicting a later registration.

### Read side: seam-first dispatch in `ToolPreviewFormatter`

The formatter gains an optional `ToolInputFormatterLookup` (defaulting to absent — backward compatible).
`formatToolInputForPrompt` consults the lookup first and falls through to the existing switch when the custom formatter declines:

```typescript
constructor(
  private readonly options: ToolPreviewFormatterOptions,
  private readonly customFormatters?: ToolInputFormatterLookup,
) {}

formatToolInputForPrompt(toolName: string, input: unknown): string {
  const inputRecord = toRecord(input);
  const custom = this.customFormatters?.get(toolName);
  if (custom) {
    const rendered = custom(inputRecord);
    if (rendered !== undefined) {
      return rendered;
    }
  }
  switch (toolName) {
    /* …existing edit/write/read/find/grep/ls/default cases, unchanged… */
  }
}
```

This realizes the chosen precedence: a registered formatter is checked first for any tool; `undefined` falls through to built-ins; the registrant returns a self-contained fragment to splice after `requested tool 'X'`.

### Write side: `registerToolInputFormatter` on `PermissionsService`

The service delegates to the registry — a one-line forward, no reach-through (Tell-Don't-Ask):

```typescript
const permissionsService: PermissionsService = {
  checkPermission(/* … */) {/* … */},
  getToolPermission(/* … */) {/* … */},
  registerToolInputFormatter(toolName, formatter) {
    return registry.register(toolName, formatter);
  },
};
```

Consumer call site (a sibling extension):

```typescript
const svc = getPermissionsService();
const dispose = svc?.registerToolInputFormatter("my-server:run", (input) =>
  Array.isArray(input.commands)
    ? `runs ${input.commands.length} commands`
    : undefined,
);
// later: dispose?.();
```

### Wiring: thread the registry to the per-call formatter

`index.ts` owns the registry and passes it both to the service and to `PermissionGateHandler`.
`PermissionGateHandler` gains an optional `ToolInputFormatterLookup` constructor parameter and forwards it when constructing the per-call formatter:

```typescript
// index.ts
const registry = new ToolInputFormatterRegistry();
// …
const gates = new PermissionGateHandler(session, pi.events, toolRegistry, registry);

// permission-gate-handler.ts → handleToolCall
const formatter = new ToolPreviewFormatter(
  resolveToolPreviewLimits(this.session.config),
  this.customFormatters,
);
```

The parameter is optional, so the existing handler constructions in `test/helpers/handler-fixtures.ts` (`makeHandler`) and the two `external-directory-*.test.ts` files compile unchanged and exercise the no-formatter path (current behavior).
Only `index.ts` passes the shared registry.

### Reference built-in: MCP input summarizer

A pure formatter that summarizes an MCP call's arguments, plus a registrar that installs it through the public registry:

```typescript
// src/builtin-tool-input-formatters.ts
export function formatMcpInputForPrompt(
  input: Record<string, unknown>,
): string | undefined {
  const args = toRecord(input.arguments);
  // …compact, truncated "key=value, …" summary of args; undefined when empty…
}

export function registerBuiltinToolInputFormatters(
  registry: ToolInputFormatterRegistry,
): void {
  registry.register("mcp", formatMcpInputForPrompt);
}
```

`index.ts` calls `registerBuiltinToolInputFormatters(registry)` after constructing the registry — the built-in goes through the same `register` path a third party would use.

MCP integration point: the MCP branch in `formatAskPrompt` appends the seam result so a registered `mcp` formatter enriches the prompt; when it declines (no arguments) the prompt is unchanged:

```typescript
if ((result.source === "mcp" || result.toolName === "mcp") && result.target) {
  const patternInfo = result.matchedPattern ? ` (matched '${result.matchedPattern}')` : "";
  const preview = formatter ? formatter.formatToolInputForPrompt("mcp", input) : "";
  const previewSuffix = preview ? ` ${preview}` : "";
  return `${subject} requested MCP target '${result.target}'${patternInfo}${previewSuffix}. Allow this call?`;
}
```

### Edge cases

- No registry / no formatter for a tool → `customFormatters?.get` is `undefined` → existing behavior verbatim.
- Custom formatter throws → not caught here; a registrant is responsible for not throwing.
  (Noted in Open Questions: whether to guard the call.)
- MCP call with empty/absent `arguments` → built-in returns `undefined` → MCP prompt unchanged.
- A registered formatter for a built-in tool (`edit`, etc.) returning a string overrides the built-in preview (intended by the chosen precedence); returning `undefined` preserves the built-in.
- Duplicate registration for the same tool name → throws (deterministic).

### Design-review summary

| Check             | Finding                                                                                     | Resolution                                                    |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Dependency width  | `ToolPreviewFormatter` gains one optional narrow dep (`ToolInputFormatterLookup`, 1 method) | Acceptable; ISP-narrow read interface                         |
| Law of Demeter    | service → `registry.register`; formatter → `lookup.get`; no reach-through chains            | Clean                                                         |
| Output arguments  | none (registry mutates its own `Map` via its own method)                                    | Clean                                                         |
| Parameter relay   | registry threads `index.ts` → handler ctor → per-call formatter                             | Justified: one stable field, not a per-call multi-layer relay |
| ISP on new export | `ToolInputFormatter` takes `Record<string, unknown>`; lookup exposes only `get`             | Narrow                                                        |

Verdict: inline (no follow-up extraction needed).

## Module-Level Changes

- `src/tool-input-formatter-registry.ts` (new) — `ToolInputFormatter` type, `ToolInputFormatterLookup` interface, `ToolInputFormatterRegistry` class.
- `src/tool-preview-formatter.ts` — add the optional `customFormatters?: ToolInputFormatterLookup` constructor parameter; add the seam-first check at the top of `formatToolInputForPrompt`.
  No existing method signature changes.
- `src/service.ts` — add `registerToolInputFormatter(toolName: string, formatter: ToolInputFormatter): () => void` to the `PermissionsService` interface; import/re-export `ToolInputFormatter` for consumers.
- `src/handlers/permission-gate-handler.ts` — add the optional `customFormatters?: ToolInputFormatterLookup` constructor parameter; pass `this.customFormatters` into the per-call `ToolPreviewFormatter`.
- `src/builtin-tool-input-formatters.ts` (new) — `formatMcpInputForPrompt` (pure) and `registerBuiltinToolInputFormatters(registry)`.
- `src/permission-prompts.ts` — in `formatAskPrompt`, append the seam preview in the MCP branch.
- `src/index.ts` — construct `ToolInputFormatterRegistry`; call `registerBuiltinToolInputFormatters(registry)`; pass `registry` to `PermissionGateHandler`; add `registerToolInputFormatter` to the `permissionsService` object.
- `docs/cross-extension-api.md` — document `registerToolInputFormatter` (signature, disposer, decline-via-`undefined`, duplicate-throws) and the `ToolInputFormatter` type.
- `docs/architecture/architecture.md` — add the two new modules to the Module structure listing; add a short "Tool input formatter seam (#283)" note.
- `README.md` — add a brief mention of the formatter seam under the cross-extension API section if one exists (verify during the docs step).

No exported symbol is removed or renamed; no broad grep-and-replace is required.
Grep confirmed the only `PermissionGateHandler` constructions are `test/helpers/handler-fixtures.ts` and the two `external-directory-*.test.ts` files; the optional parameter keeps them compiling unchanged.

## Test Impact Analysis

1. New tests the seam enables (previously impossible — there was no registry or injection point):
   - `test/tool-input-formatter-registry.test.ts` — `register` stores and returns a working disposer; `get` returns the formatter; duplicate `register` throws; disposer is identity-guarded (a stale disposer does not evict a re-registration).
   - `test/builtin-tool-input-formatters.test.ts` — `formatMcpInputForPrompt` summarizes arguments, truncates, and returns `undefined` for empty/absent arguments; `registerBuiltinToolInputFormatters` installs the `mcp` entry.
   - `test/tool-preview-formatter.test.ts` (extend) — seam-first: custom string is used verbatim; custom `undefined` falls through to the built-in switch; absent lookup preserves current behavior.
   - `test/service.test.ts` (extend) — `registerToolInputFormatter` delegates to the registry and returns the disposer.
2. Existing tests that must change in lockstep:
   - `test/permission-prompts.test.ts` — the MCP ask-prompt cases gain the appended argument summary when a formatter is supplied; the no-formatter case stays unchanged.
     These updates land in the same step as the MCP-branch change.
3. Existing tests that stay as-is (genuinely exercise unchanged layers):
   - The `edit`/`write`/`read`/`find`/`grep`/`ls` formatter cases in `tool-preview-formatter.test.ts` (switch fallthrough unchanged when no custom formatter).
   - `extension-config.test.ts`, the bash/skill prompt cases, and the review-log preview tests.

## TDD Order

1. Registry (red → green → commit).
   - Surface: `test/tool-input-formatter-registry.test.ts`.
   - Red: `register`/`get`/disposer/duplicate-throws/identity-guarded-disposer.
   - Green: add `src/tool-input-formatter-registry.ts`.
   - No consumers yet, so this commits in isolation.
   - Commit: `feat: add ToolInputFormatterRegistry (#283)`.
2. Seam-first dispatch in the formatter (red → green → commit).
   - Surface: `test/tool-preview-formatter.test.ts`.
   - Red: custom formatter string used verbatim; `undefined` falls through to the switch; absent lookup unchanged.
   - Green: add the optional `customFormatters` parameter and the seam-first check.
   - Run `pnpm run check` — the constructor signature changed (optional, so call sites still compile).
   - Commit: `feat: consult custom formatter registry in ToolPreviewFormatter (#283)`.
3. Public API + wiring (red → green → commit).
   - Surface: `test/service.test.ts`.
   - Red: `registerToolInputFormatter` delegates and returns a disposer.
   - Green: add the method to the `PermissionsService` interface (`service.ts`) and to the `permissionsService` object in `index.ts`; add the optional `customFormatters` parameter to `PermissionGateHandler` and forward it in `handleToolCall`; construct the registry in `index.ts` and pass it to the handler.
   - The interface change and its sole implementer (the `index.ts` object literal), plus the handler-ctor change and its sole production call site (`index.ts`), land together — the type checker rejects splitting them.
   - Run `pnpm run check`.
   - Commit: `feat: expose registerToolInputFormatter on PermissionsService (#283)`.
4. Built-in MCP summarizer + MCP-branch integration (red → green → commit).
   - Surface: `test/builtin-tool-input-formatters.test.ts` and `test/permission-prompts.test.ts`.
   - Red: `formatMcpInputForPrompt` behavior; the MCP ask-prompt appends the summary when a formatter is supplied and is unchanged when arguments are empty/absent.
   - Green: add `src/builtin-tool-input-formatters.ts`; append the seam preview in the MCP branch of `formatAskPrompt`; register the built-in in `index.ts`.
   - Update the existing MCP prompt assertions in the same commit.
   - Commit: `feat: add built-in MCP input summarizer (#283)`.
5. Documentation (build → commit).
   - Update `docs/cross-extension-api.md`, `docs/architecture/architecture.md` (module listing + seam note), and `README.md` if applicable.
   - Commit: `docs: document tool input formatter seam (#283)`.

This is an additive, non-breaking feature throughout — all `feat:`/`docs:`, no `feat!:`.

## Risks and Mitigations

- Risk: appending an argument summary changes the MCP prompt text for every MCP call, breaking existing snapshot-style assertions.
  Mitigation: the MCP-branch change and its test updates are bundled in step 4; the summary is omitted when arguments are empty, preserving the prior text for those cases.
- Risk: a registry shared across the per-call formatter and the service drifts out of sync (two registries).
  Mitigation: `index.ts` constructs exactly one registry and passes the same instance to both the handler and the service; tests assert delegation.
- Risk: a misbehaving custom formatter throws and aborts prompt construction (a denial-of-service on prompts).
  Mitigation: documented contract that formatters must not throw; whether to wrap the call in a try/catch is raised in Open Questions — defaulting to no guard keeps behavior transparent, but a guard is cheap if desired.
- Risk: the MCP input shape (`{ tool, server, arguments }`) differs from assumptions.
  Mitigation: write a disposable exploratory check against a realistic MCP tool-call payload before finalizing `formatMcpInputForPrompt`'s argument extraction (per the testing skill).
- Risk: duplicate-throws surprises a user who wants to override a built-in (e.g. replace the `mcp` summarizer).
  Mitigation: documented as a deliberate limitation; overriding is a follow-up if requested (the registry could grow a `replace` or precedence model later).

## Open Questions

- Should `formatToolInputForPrompt` wrap the custom formatter call in a try/catch so a throwing registrant cannot break the prompt?
  Defer to implementation; lean toward no guard initially (transparent failure), revisit if a real registrant misbehaves.
- Exact wording of the appended MCP summary (`with input …` vs. `(args: …)`); resolve when writing step 4 against real payloads.
- Whether `docs/architecture/architecture.md` should record this as a formal roadmap phase entry or just a module note; resolve in the docs step.

[#266]: https://github.com/gotgenes/pi-packages/issues/266
[#282]: https://github.com/gotgenes/pi-packages/issues/282
