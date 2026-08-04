---
issue: 507
issue_title: "fix(pi-permission-system): external-directory prompt shows the typed path, not the resolved path that triggered the gate"
---

# Disclose the resolved symlink target in external-directory messages

## Release Recommendation

**Release:** ship independently

This is a standalone message-clarity bug fix, not part of any roadmap phase (Phase 7 is complete).
It touches no shared release batch, so it ships on its own as a patch.

## Problem Statement

When a tool or bash call names a path that is lexically *inside* the working directory but resolves, via a symlink, to a location *outside* it, the external-directory prompt names the typed path while asserting it is "outside working directory".
That reads as a contradiction: the typed path (`demo-symlink-passwd`) is plainly inside the working directory, and the resolved path (`/etc/passwd`) that actually tripped the gate is never shown.
The gating decision is correct — this is the [#418] / [#486] dual-match protection working — but the message hides *why* it fired.

The fix is purely about message clarity.
When the resolved (canonical, symlink-followed) path differs from the typed path, every external-directory message should disclose it as `(resolves to '<canonical>')`; when they are equal (the common non-symlink case), the message is unchanged.

## Goals

- Disclose the resolved canonical path in the tool external-directory ask prompt when it differs from the typed path.
- Disclose the resolved canonical path(s) in the bash external-directory ask prompt when any differ.
- Disclose the resolved path in the tool external-directory denial messages (deny / no-UI / user-denied bodies).
- Disclose the resolved path(s) in the bash external-directory denial message (deny body — the only bash denial body that lists paths).
- Keep the message unchanged when the typed and resolved forms are equal (non-symlink case).
- Non-breaking: the gating decision, the review-log values, and the session-approval patterns are unchanged; only human-facing message text changes.

## Non-Goals

- No change to the gating decision, boundary check, infra-read bypass, or dual-match logic — the gate already resolves symlinks correctly ([#418], [#486]).
- No change to the review-log `path` / `externalPaths` values or the derived session-approval patterns — those stay the lexical policy-matching values.
- No change to the `path` / per-tool / `bash_path` surfaces — the contradiction is specific to `external_directory` messages, which are the only ones that assert "outside working directory".
- No public-API change — the message builders and `DenialContext` are internal (not exported from `index.ts`).

## Background

The canonical (symlink-resolved) path is already computed at both gates via `AccessPath` (`src/access-intent/access-path.ts`), which holds three type-distinct forms:

- `value()` — the lexical absolute form (as-typed, normalized, not symlink-resolved).
- `boundaryValue()` — the canonical form (symlink-resolved via `realpathSync`, win32-lowercased per [#382]).
- `matchValues()` — the lexical ∪ canonical alias union for pattern matching.

Both `value()` and `boundaryValue()` are win32-lowercased (`path-normalization.ts`), so a case-only difference on Windows does not spuriously diverge — the two forms differ only when a symlink actually resolves elsewhere.
`canonicalizePath` (`src/canonicalize-path.ts`) returns its input unchanged for non-symlink or unresolvable paths, so `boundaryValue()` equals `value()` exactly when there is no distinct symlink target.

The four message-producing sites (issue scope), plus the two additional denial bodies the same `DenialContext` feeds (confirmed in Decide):

- `src/handlers/gates/external-directory-messages.ts` — `formatExternalDirectoryAskPrompt` (tool prompt) and `formatBashExternalDirectoryAskPrompt` (bash prompt).
- `src/denial-messages.ts` — the `external_directory` and `bash_external_directory` bodies in `buildDenyBody`, `buildUnavailableBody`, and `buildUserDeniedBody`.

The tool gate (`describeExternalDirectoryGate`) already builds `const accessPath = normalizer.forPath(externalDirectoryPath)`; the bash gate (`describeBashExternalDirectoryGate`) already holds an `AccessPath` per uncovered entry (`uncoveredEntries.map(({ path }) => …)`).

Constraint from the package skill: `PathNormalizer` owns platform handling; the gates already hold their `AccessPath` values, so this fix reads from those value objects and adds no new `process.platform` / `cwd` threading.

## Design Overview

### Decision: disclose only when the canonical form is distinct

The comparison must be `value()` (lexical absolute) vs `boundaryValue()` (canonical absolute) — not the *raw typed* string vs canonical, because the typed string is relative (`demo-symlink-passwd`) and would always differ from an absolute canonical.
This comparison is domain logic about a path's own representations, so it belongs on the value object (give behavior to data), not scattered at two call sites.

Add one accessor to `AccessPath`:

```typescript
/**
 * The canonical (symlink-resolved) form when it names a location distinct
 * from the lexical form — for disclosing the resolved target in a prompt or
 * denial message. `undefined` when the path is not a symlink (canonical
 * equals lexical) or has no canonical (literal-only / empty input).
 */
resolvedAlias(): string | undefined {
  if (!this.canonical || this.canonical === this.lexical) {
    return undefined;
  }
  return this.canonical;
}
```

`resolvedAlias()` fields which fields it reads: `canonical` and `lexical` — both already held.
It carries no unused inputs and follows the existing accessor style (`value()` / `boundaryValue()`).

### Shared formatting primitive and disclosure type

The displayed suffix is identical everywhere the resolved path is disclosed, so it is single-sourced as one primitive.
The bash case lists several paths, each independently symlinked-or-not, so it needs a per-path pairing of display value and resolved alias.

In `src/denial-messages.ts` (the module that already owns `DenialContext`), add:

```typescript
/** A displayed external path paired with its resolved target, when distinct. */
export interface ExternalPathDisclosure {
  /** The path as displayed (typed for tools, lexical-absolute for bash). */
  path: string;
  /** The canonical symlink-resolved target; present only when it differs. */
  resolvedPath?: string;
}

/** ` (resolves to '<canonical>')` when a distinct target exists, else "". */
export function resolvesToSuffix(resolvedPath?: string): string {
  return resolvedPath ? ` (resolves to '${resolvedPath}')` : "";
}
```

`external-directory-messages.ts` (handler layer) imports `resolvesToSuffix` and `ExternalPathDisclosure` from `denial-messages.ts` (core-ish leaf) — a handler→leaf dependency in the correct direction, with no cycle (`denial-messages.ts` imports nothing from `external-directory-messages.ts`).

### Tool external-directory path (scalar disclosure)

`formatExternalDirectoryAskPrompt` gains a `resolvedPath` parameter positioned right after `pathValue` (so the message reads `path '<typed>' (resolves to '<canonical>') outside working directory '<cwd>'`):

```typescript
export function formatExternalDirectoryAskPrompt(
  toolName: string,
  pathValue: string,
  resolvedPath: string | undefined,
  cwd: string,
  agentName?: string,
): string {
  const subject = agentName ? `Agent '${agentName}'` : "Current agent";
  return `${subject} requested tool '${toolName}' for path '${pathValue}'${resolvesToSuffix(resolvedPath)} outside working directory '${cwd}'. Allow this external directory access?`;
}
```

The `external_directory` `DenialContext` variant gains an optional `resolvedPath?: string` (additive), and all three body builders append `resolvesToSuffix(ctx.resolvedPath)` where they render `ctx.pathValue`.

Tool gate call site (`describeExternalDirectoryGate`):

```typescript
const resolvedAlias = accessPath.resolvedAlias();
const extDirMessage = formatExternalDirectoryAskPrompt(
  tcc.toolName, externalDirectoryPath, resolvedAlias, tcc.cwd, tcc.agentName ?? undefined,
);
// denialContext: { kind: "external_directory", …, resolvedPath: resolvedAlias }
```

The displayed primary path stays the raw typed `externalDirectoryPath` (the path the agent requested); only the suffix is derived from the value object.

### Bash external-directory paths (list disclosure)

`formatBashExternalDirectoryAskPrompt`'s `externalPaths` parameter changes from `string[]` to `ExternalPathDisclosure[]`, and each entry renders as `<path>${resolvesToSuffix(resolvedPath)}` before joining (preserving the current unquoted-path list style).
The `bash_external_directory` `DenialContext` variant's `externalPaths` changes from `string[]` to `ExternalPathDisclosure[]`; `buildDenyBody` maps the disclosures through the same rendering (`buildUnavailableBody` / `buildUserDeniedBody` for bash render only `ctx.command`, so they are unchanged).

Bash gate call site (`describeBashExternalDirectoryGate`):

```typescript
const disclosures = uncoveredEntries.map(({ path }) => ({
  path: path.value(),
  resolvedPath: path.resolvedAlias(),
}));
// prompt + denialContext.externalPaths take `disclosures`
// uncoveredPaths (string[]) is retained unchanged for deriveApprovalPattern + logContext.externalPaths
```

`uncoveredPaths` (the lexical `value()` strings) stays the source for session-approval patterns and the review log — those match on the policy value, not the disclosure.

### Edge cases

- Non-symlink path: `resolvedAlias()` is `undefined`, `resolvesToSuffix` is `""`, message unchanged.
- macOS `/etc` → `/private/etc`: the disclosed canonical is the fully-resolved `/private/etc/passwd` (what the gate actually matched), which is more accurate than the issue's idealized `/etc/passwd`.
- win32: both forms are lowercased, so a case-only difference yields `undefined` (no spurious disclosure); a real symlink target is disclosed lowercased.
- `forLiteral` bash token (unknown base): `canonical` is `""`, so `resolvedAlias()` is `undefined` — no disclosure, correct.

## Module-Level Changes

- `src/access-intent/access-path.ts` — add `resolvedAlias(): string | undefined`; extend the class doc comment's accessor list.
- `src/denial-messages.ts` — add `ExternalPathDisclosure` interface and `resolvesToSuffix` helper; add `resolvedPath?: string` to the `external_directory` `DenialContext` variant; change `bash_external_directory.externalPaths` from `string[]` to `ExternalPathDisclosure[]`; apply the suffix in `buildDenyBody` / `buildUnavailableBody` / `buildUserDeniedBody` (external_directory) and in `buildDenyBody` (bash_external_directory).
- `src/handlers/gates/external-directory-messages.ts` — add `resolvedPath` param to `formatExternalDirectoryAskPrompt`; change `formatBashExternalDirectoryAskPrompt`'s `externalPaths` to `ExternalPathDisclosure[]`; import the type + helper from `denial-messages.ts`.
- `src/handlers/gates/external-directory.ts` — compute `accessPath.resolvedAlias()`, pass it to the prompt, and set `denialContext.resolvedPath`.
- `src/handlers/gates/bash-external-directory.ts` — build the `disclosures` array; pass it to the prompt and `denialContext.externalPaths`; retain `uncoveredPaths` for patterns/logs.
- `docs/architecture/architecture.md` — line 679: add `resolvedAlias(): string | undefined` to the `AccessPath` accessor enumeration; line 703: note `describeExternalDirectoryGate` discloses the resolved alias in prompts/denials; add a `[#507]` reference-link definition.

Doc-grep results (no other stale references):

- Grepped `src/` + `test/` for `formatExternalDirectoryAskPrompt` / `formatBashExternalDirectoryAskPrompt` / `DenialContext` / `boundaryValue` / `resolvedAlias` — call sites and tests enumerated below; no other producers.
- `bash_external_directory` / `external_directory` `DenialContext` each have a single producer (their gate).
- `README.md` documents commands/config, not these message internals — no change.
- `.pi/skills/package-*/SKILL.md` mentions `DenialContext` only via the caller-supplied `makeDenialDescriptor` fixture (no shape enumeration) — no change; `makeDenialDescriptor` takes a caller-supplied context, so no fixture edit.
- No sample-log / ADR prose in `docs/` renders these message strings — no stale literals.

## Test Impact Analysis

1. New unit tests enabled: `AccessPath.resolvedAlias()` gets direct value-object tests (symlink → canonical; non-symlink → `undefined`; literal-only → `undefined`; empty → `undefined`; win32 real symlink → lowercased canonical; win32 case-only → `undefined`) — previously the lexical/canonical comparison did not exist as a testable unit.
2. Redundant tests: none removed — existing `.toContain("outside working directory")` assertions stay valid (the suffix is inserted before that phrase).
3. Tests that must change (type/signature-coupled, so they land in the same commit as their production change):
   - `test/handlers/gates/external-directory-messages.test.ts` — both prompt signatures; add resolves-to and non-symlink cases.
   - `test/denial-messages.test.ts` — external_directory cases gain a `resolvedPath` case; bash `externalPaths: ["…"]` literals become `[{ path: "…" }]`, plus a resolves-to case.
   - `test/bash-external-directory.test.ts` — `formatBashExternalDirectoryAskPrompt` calls (lines ~923–946) take `ExternalPathDisclosure[]`; add a symlink-disclosure assertion.
   - `test/handlers/external-directory-integration.test.ts` — `formatExternalDirectoryAskPrompt` call (line ~50) takes the new `resolvedPath` arg.

## Invariants at risk

The dual-match symlink protection ([#418], [#486]) and the outside-CWD boundary decision must remain unchanged — this fix reads `AccessPath` for display only and touches no matching or boundary code.

- Invariant: external-directory gating still fires on the canonical form for an in-CWD symlink to an outside target.
  Pinned by the existing symlink external-directory tests in `test/handlers/gates/external-directory-policy.test.ts` and `test/bash-external-directory.test.ts` (assert the gate resolves/denies) — unchanged by this plan.
- Invariant: session-approval patterns and review-log values stay the lexical policy values.
  Pinned by keeping `uncoveredPaths` / `deriveApprovalPattern(accessPath.value())` untouched; the bash gate's existing approval/log assertions cover this.

## TDD Order

1. **`AccessPath.resolvedAlias()` accessor.**
   Red: add `resolvedAlias()` tests in `test/access-intent/access-path.test.ts` (symlink, non-symlink, literal-only, empty, win32 real symlink, win32 case-only).
   Green: implement the accessor.
   Commit: `fix(pi-permission-system): add AccessPath.resolvedAlias() for symlink-target disclosure`. (An internal enabler with no standalone user-facing effect — kept `fix:` so the issue ships as one patch release, not a minor bump.)

2. **Tool external-directory message disclosure.**
   Red: assert `formatExternalDirectoryAskPrompt` and the three external_directory denial bodies emit `(resolves to '<canonical>')` when `resolvedPath` is set and omit it when `undefined`.
   Green: add `resolvesToSuffix` + `resolvedPath?` to `DenialContext.external_directory` in `denial-messages.ts`; add the `resolvedPath` param to the tool prompt; wire `accessPath.resolvedAlias()` through `describeExternalDirectoryGate`; update the coupled tests (`external-directory-messages.test.ts`, `denial-messages.test.ts` external_directory cases, `external-directory-integration.test.ts`).
   Commit: `fix(pi-permission-system): disclose resolved symlink target in tool external-directory messages`.

3. **Bash external-directory message disclosure.**
   Red: assert the bash prompt and bash deny body render `(resolves to '<canonical>')` per uncovered entry that differs, and plain otherwise.
   Green: add `ExternalPathDisclosure`; change `formatBashExternalDirectoryAskPrompt` and `DenialContext.bash_external_directory.externalPaths` to the disclosure type; render disclosures in the bash deny body; build `disclosures` in `describeBashExternalDirectoryGate` (retaining `uncoveredPaths` for patterns/logs); update the coupled tests (`external-directory-messages.test.ts`, `denial-messages.test.ts` bash cases, `bash-external-directory.test.ts`).
   Commit: `fix(pi-permission-system): disclose resolved symlink targets in bash external-directory messages`.

4. **Docs.**
   Update `docs/architecture/architecture.md` (accessor enumeration + gate note + `[#507]` link def).
   Commit: `docs(pi-permission-system): record resolved-path disclosure on external-directory messages (#507)`.

Steps 1–4 land on one branch and are pushed together; CI/fallow run on the final SHA, where `resolvedAlias()` has production callers (steps 2–3), so no transient dead-code gate fires.

## Risks and Mitigations

- Risk: message-string test assertions elsewhere break.
  Mitigation: the suffix is inserted before "outside working directory", so `.toContain(...)` assertions hold; only the four enumerated test files (signature/type-coupled) change, and they land with their production commits.
- Risk: `resolvedAlias()` transiently has no production caller after step 1.
  Mitigation: steps 2–3 add the callers on the same branch; fallow gates on the pushed final state, and step 1's tests reference the method.
- Risk: over-disclosure noise on non-symlink paths.
  Mitigation: `resolvedAlias()` returns `undefined` whenever canonical equals lexical (including win32 case-only and unresolvable paths), so the common case is unchanged.

## Open Questions

None — scope confirmed in Decide (disclose across all external-directory message variants: ask prompts + deny + no-UI + user-denied).

[#382]: https://github.com/gotgenes/pi-packages/issues/382
[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#486]: https://github.com/gotgenes/pi-packages/issues/486
