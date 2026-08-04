---
issue: 428
issue_title: "pi-permission-system: permission-system using incorrect path for `projectAgentsDir`"
---

# Fix project agents directory path resolution

## Problem Statement

A user defined a project-scoped custom agent at `<project>/.pi/agents/my-custom-agent.md` with a `permission:` block in its YAML frontmatter. pi-subagents discovered and ran the agent correctly, but its permission frontmatter was never applied.
The `config.resolved` log shows why: pi-permission-system computed `projectAgentsDir` as `<cwd>/.pi/agent/agents`, then found nothing there and resolved no project-agent config.
The correct location — the one pi-subagents uses — is `<cwd>/.pi/agents`.

## Goals

- Resolve the project agents directory at `<cwd>/.pi/agents`, matching the Pi platform convention that pi-subagents already follows.
- Extract a small named helper inside pi-permission-system that owns this convention, with a comment cross-referencing pi-subagents' sibling encoding.
- Add a regression test that exercises the real `agentDir`-derived resolution end-to-end (a project agent's `permission:` frontmatter is actually enforced).
- Correct the project-agent override path documented in `docs/configuration.md`, which currently repeats the same wrong path.

This change is **breaking** (`fix!:`).
On upgrade, project agents' `permission:` frontmatter — silently ignored today — starts being read and enforced without any user edit, which can make a session *more* restrictive than before.

## Non-Goals

- No new shared package and no `pi-permission-system → pi-subagents` code dependency.
  The two packages are decoupled by design (event-bus only, ADR-0002); the path is a Pi platform convention that each client encodes independently, exactly as both already do for the global agents directory.
- No change to pi-subagents — its `loadCustomAgents` (`config/custom-agents.ts`) already resolves `<cwd>/.pi/agents` correctly.
- No change to the global agents directory derivation (`<agentDir>/agents`); it is already correct.
- No change to the config schema, example config, or the `permission:` frontmatter format.

## Background

The resolution lives in `src/permission-manager.ts`.
`derivePolicyLoaderOptions(agentDir, cwd)` builds `PolicyLoaderOptions` for a `FilePolicyLoader`, and it is the sole place the project agents directory is derived from a `cwd`:

```typescript
return {
  globalConfigPath: getGlobalConfigPath(agentDir),
  agentsDir: join(agentDir, "agents"),
  projectGlobalConfigPath: cwd ? getProjectConfigPath(cwd) : undefined,
  projectAgentsDir: cwd ? join(cwd, ".pi", "agent", "agents") : undefined, // ← bug
};
```

It is called from the `PermissionManager` constructor (when built with `{ agentDir }`) and from `configureForCwd(cwd)`.
The derived `projectAgentsDir` feeds `FilePolicyLoader.loadProjectAgentConfig(agentName)`, which reads `<projectAgentsDir>/<agentName>.md`, extracts its frontmatter, and contributes the `project-agent` scope to the merged ruleset.

Pi-convention paths in this package already live in `src/config-paths.ts` (`getGlobalConfigPath`, `getProjectConfigPath`, etc.) — the natural home for an agents-directory helper. pi-subagents encodes the same project convention independently in `config/custom-agents.ts` (`join(cwd, ".pi", "agents")`); the global convention (`join(getAgentDir(), "agents")`) is *also* duplicated between the two packages and has never been a coupling problem, because both are honoring the same platform contract rather than depending on each other.

The SDK (`@earendil-works/pi-coding-agent`) exposes `getAgentDir()` — the single Pi agent's home — but no agents-*directory* helper, because Pi is single-agent and has no concept of multiple named agents (see the next subsection and Open Questions).
So independent encoding plus a test is the pragmatic, decoupling-preserving answer.

### Per-agent frontmatter is a multi-agent integration concern, not a core one

Pi is single-agent by deliberate design — it has no concept of multiple named agents.
The notion of agent *types* is introduced entirely by external extensions (pi-subagents, pi-agent-router, some MasuRii packages); `/agents` is itself a pi-subagents command. pi-permission-system already reflects this: it learns the active agent's name from a generic `<active_agent name="...">` tag injected into the system prompt (by pi-agent-router) or an `active_agent` session entry — never from a hard dependency on any one multi-agent extension.
It does not enumerate or discover agents (pi-subagents owns that); it reads only the `permission:` sub-document of an agent file, by the active agent's name, on demand.
Because pps bridges to multi-agent tooling through generic, extension-agnostic signals rather than a pi-subagents dependency, it likewise reads the agent file itself rather than relying on any one extension to push the data — so encoding the `<cwd>/.pi/agents` convention is, for now, pps's own integration-layer responsibility.
See Open Questions for the longer-term direction.

## Design Overview

Add a convention helper to `src/config-paths.ts`:

```typescript
/**
 * Directory holding project-scoped custom agent definitions.
 *
 * `<cwd>/.pi/agents` is a Pi platform convention, also encoded by
 * @gotgenes/pi-subagents' `loadCustomAgents` (`config/custom-agents.ts`).
 * The two packages encode it independently — pi-permission-system has no
 * dependency on pi-subagents (ADR-0002) — so this is this package's
 * authoritative copy.
 */
export function getProjectAgentsDir(cwd: string): string {
  return join(cwd, ".pi", "agents");
}
```

`derivePolicyLoaderOptions` then calls it:

```typescript
projectAgentsDir: cwd ? getProjectAgentsDir(cwd) : undefined,
```

No data shape changes — `PolicyLoaderOptions`, `ResolvedPolicyPaths`, and the merge precedence are untouched.
The only observable difference is the resolved path value, which now points at the correct directory.

### Edge cases

- `cwd` absent (global-only) — `projectAgentsDir` stays `undefined`; unchanged.
- A project agent file present at the new path but absent at the old one — now found and applied (the bug's scenario).
- Cache stamping (`getCacheStamp`) already keys off `this.projectAgentsDir`, so correcting the directory makes change-detection track the right file with no further work.

## Module-Level Changes

- `src/config-paths.ts` — add `getProjectAgentsDir(cwd)` with the convention comment.
- `src/permission-manager.ts` — import `getProjectAgentsDir`; replace the inline `join(cwd, ".pi", "agent", "agents")` in `derivePolicyLoaderOptions` with `getProjectAgentsDir(cwd)`.
- `test/config-paths.test.ts` — add a unit test for `getProjectAgentsDir`.
- `test/permission-manager-unified.test.ts` — extend the `makeAgentDirSetup` helper (in the `configureForCwd and agentDir option` describe block) to optionally write a project agent `.md`; add a path-level assertion and a behavior-level regression test.
- `docs/configuration.md` — under "Project Agent Override", change the path from `<cwd>/.pi/agent/agents/<agent>.md` to `<cwd>/.pi/agents/<agent>.md`.

Searched for other affected references:

- The `package-pi-permission-system` SKILL.md documents the per-agent override mechanism without stating the project path, so it needs no change.
- `README.md` references per-agent overrides without a path; no change.
- `test/config-reporter.test.ts` uses `/projects/my-app/.pi/agent/agents` as an arbitrary sample string fed to the reporter (not a derived value); leaving it is harmless — an optional cosmetic update only (see Open Questions).

## Test Impact Analysis

1. New tests enabled by the fix:
   - A unit test for the pure `getProjectAgentsDir` helper.
   - A regression test that drives the *real* `agentDir`-based derivation through `configureForCwd(cwd)` and asserts a project agent's `permission:` frontmatter is enforced — previously impossible because every existing test passed `projectAgentsDir` explicitly and so never exercised the buggy derivation.
2. Redundant tests: none.
   The existing `getResolvedPolicyPaths` tests pass explicit paths and exercise reporting, not derivation.
3. Tests that must stay as-is: the explicit-path `getResolvedPolicyPaths` tests and the existing `configureForCwd` precedence tests, which genuinely exercise the loader rebuild and merge precedence.

## Invariants at risk

- The global agents directory derivation (`join(agentDir, "agents")`) must stay unchanged.
  It is pinned by the existing `construction with { agentDir } reads global config from getGlobalConfigPath(agentDir)` test in `test/permission-manager-unified.test.ts`; the new path-level assertion will additionally confirm `agentsDir` is unaffected alongside the corrected `projectAgentsDir`.
- The project/global config-path derivations (`getProjectConfigPath`, `getGlobalConfigPath`) must stay unchanged; the existing precedence tests in the same describe block pin them.

## TDD Order

1. `fix!`: correct the project agents directory resolution.
   - Add `getProjectAgentsDir(cwd)` to `src/config-paths.ts`.
   - Add its unit test to `test/config-paths.test.ts`.
   - Extend `makeAgentDirSetup` to optionally write a project agent file, then add to the `configureForCwd and agentDir option` describe block: (a) a path-level test asserting `getResolvedPolicyPaths().projectAgentsDir === join(cwd, ".pi", "agents")` (and that `agentsDir` is unchanged), and (b) a behavior-level test that writes `<cwd>/.pi/agents/coder.md` with `permission:\n  read: deny`, calls `configureForCwd(cwd)`, and asserts `checkPermission("read", { path: "foo.txt" }, "coder").state === "deny"`.
     These fail against the current code.
   - Wire `getProjectAgentsDir` into `derivePolicyLoaderOptions` to make them pass.
   - Run `pnpm --filter @gotgenes/pi-permission-system exec vitest run` (the helper change touches shared resolution).
   - Commit (`fix!:`) with a `BREAKING CHANGE:` footer: project agents' `permission:` frontmatter at `<cwd>/.pi/agents/<name>.md` is now read and enforced; previously the wrong directory was checked and the frontmatter was silently ignored, so a session may become more restrictive on upgrade.
     Remediation: if a project agent's `permission:` block restricts tools unexpectedly, edit or remove that block in `<cwd>/.pi/agents/<name>.md`.
     Reference the issue as `(#428)` in the subject.
2. `docs`: correct the documented project-agent override path in `docs/configuration.md` from `<cwd>/.pi/agent/agents/<agent>.md` to `<cwd>/.pi/agents/<agent>.md`.
   Commit (`docs:`), referencing `(#428)`.

## Risks and Mitigations

- Behavior change on upgrade (sessions may become more restrictive when a project agent declares `permission:`).
  Mitigated by the `fix!:` classification, the `BREAKING CHANGE:` footer with remediation, and the corrected documentation; `/ship-issue` surfaces the same summary in the close comment.
- Drift between this package's and pi-subagents' encoding of the convention.
  Mitigated by the cross-reference comment on `getProjectAgentsDir` and the behavior-level regression test pinning the resolved path.
- Cache-key correctness: `getCacheStamp` already keys off `projectAgentsDir`, so correcting the directory only improves change detection — no regression risk.

## Open Questions

- Long-term, per-agent `permission:` frontmatter is best modeled as an **extension bridge on top of pps's single-agent core**, not a core responsibility.
  Pi is single-agent by deliberate design, so neither the SDK nor a hypothetical "small core" should own an agents directory or parse agent frontmatter — doing so would push a multi-agent concept into a core that rejects it. (Earlier drafts of this plan suggested upstreaming `getProjectAgentsDir` to the SDK and having the core parse agent frontmatter; both are withdrawn for this reason.)
- A cleaner evolution keeps the bridge generic, mirroring how pps already consumes the active-agent signal: the multi-agent extension that owns agent definitions (and already parses them) would supply the active agent's `permission:` overrides to pps through an extension-agnostic channel, so pps's core never locates or parses agent files.
  Until such a channel exists, pps encodes the `<cwd>/.pi/agents` convention itself — which is what this fix does.
- Optional symmetry: extract `getGlobalAgentsDir(agentDir)` and dedupe `join(agentDir, "agents")` across `derivePolicyLoaderOptions` and `defaultAgentsDir()`.
  Deferred — the global path is not buggy, and touching it widens the blast radius.
