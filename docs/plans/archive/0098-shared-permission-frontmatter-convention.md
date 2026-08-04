---
issue: 98
issue_title: "Explore a shared permission frontmatter convention for pi-subagent extensions"
---

# Shared Permission Frontmatter Convention Guide

## Problem Statement

Three major pi-subagent extensions (nicobailon/pi-subagents, tintinweb/pi-subagents, HazAT/pi-interactive-subagents) each define their own tool restriction frontmatter keys (`tools:`, `disallowed_tools:`, `deny-tools:`).
Users must configure restrictions in two places — once for tool visibility in the subagent extension and again for ask/deny/allow policy in the `permission:` frontmatter.
Now that all prerequisites (#78, #29, #96, #97) are landed, we can propose the `permission:` frontmatter as a shared convention that provides richer semantics (ask/deny/allow), broader surface coverage (bash, MCP, skills, external directories), and a single configuration point.

## Goals

- Draft a self-contained guide (`docs/guides/permission-frontmatter-for-subagent-extensions.md`) explaining the convention, benefits, and adoption path for upstream extension authors.
- Include concrete frontmatter examples showing the flat format alongside existing subagent extension keys.
- Link to existing docs (`docs/subagent-integration.md`, `docs/event-api.md`) for deeper reference.
- Prepare template text for upstream issues/discussions to be opened on the three repos once the guide is reviewed.

## Non-Goals

- Changing any runtime behavior or code in this extension.
- Requiring upstream extensions to depend on or import our package.
- Defining a formal specification or versioned protocol — this is a convention proposal, not a contract.
- Actually opening the upstream issues — that is a manual outreach step after the guide is merged and reviewed.

## Background

### Existing Documentation

- `docs/subagent-integration.md` documents the two-layer model (visibility vs. policy) and coexistence rules.
- `docs/event-api.md` documents the event bus RPC for in-process permission queries and prompt forwarding.
- `config/config.example.json` shows the flat permission format.
- `schemas/permissions.schema.json` defines the schema.

### Permission Surfaces Involved

All surfaces are relevant to the guide since we're documenting the full capability:

- **tools** — per-tool allow/ask/deny
- **bash** — pattern-matched bash commands
- **mcp** — MCP tool-level policy
- **skill** — skill invocation policy
- **external_directory** — path-based access control
- **special** — special operations (subagent spawning, etc.)

### Prerequisites (all closed)

| Issue | Status | Purpose                                          |
| ----- | ------ | ------------------------------------------------ |
| #78   | Closed | Correct README flat format examples              |
| #29   | Closed | Event bus API for runtime permission queries     |
| #96   | Closed | Permission forwarding with CLI-spawned subagents |
| #97   | Closed | Coexistence documentation                        |

## Design Overview

The guide is a standalone Markdown document aimed at extension authors (not end users).
It should answer:

1. **What is the `permission:` frontmatter?**
   — A flat policy map in agent `.md` files that pi-permission-system reads.
2. **Why adopt it?**
   — Richer semantics (ask), broader coverage (bash/mcp/skills/directories), forwarding support.
3. **How does it compose with existing keys?**
   — The two-layer model: visibility first, then policy.
   Both apply independently.
4. **What does adoption look like?**
   — Extension authors document `permission:` as an optional key in their agent frontmatter docs.
   They do NOT need to evaluate it — pi-permission-system handles that.
5. **Runtime integration (optional)** — Extensions running in-process can query policy via the event bus API instead of re-implementing evaluation.

### Flat Format (for reference in guide)

```typescript
// Per-agent frontmatter shape
interface AgentPermissionFrontmatter {
  permission: FlatPermissionPolicy;
}

type FlatPermissionPolicy = {
  "*"?: Decision;                    // universal fallback
  [toolName: string]: Decision | PatternMap;
};

type Decision = "allow" | "ask" | "deny";
type PatternMap = { [pattern: string]: Decision };
```

## Module-Level Changes

| File                                                            | Action | Description                                                       |
| --------------------------------------------------------------- | ------ | ----------------------------------------------------------------- |
| `docs/guides/permission-frontmatter-for-subagent-extensions.md` | Add    | Main guide document for upstream authors                          |
| `docs/guides/upstream-issue-template.md`                        | Add    | Template text for issues to open on the three repos               |
| `docs/architecture/target-architecture.md`                      | Update | Note the guide under "External Integration" or equivalent section |
| `README.md`                                                     | Update | Add a link to the guide in the documentation section              |

## TDD Order

This is a docs-only change — no test cycles are needed.

1. **docs: add permission frontmatter convention guide for subagent extensions**
   - Create `docs/guides/permission-frontmatter-for-subagent-extensions.md` with sections: motivation, the two-layer model, flat format reference, composition examples, runtime integration (event bus), adoption checklist.
2. **docs: add upstream issue template for subagent extension outreach**
   - Create `docs/guides/upstream-issue-template.md` with customizable template text for nicobailon, tintinweb, and HazAT repos.
3. **docs: link permission frontmatter guide from README and target architecture**
   - Update `README.md` docs section and `docs/architecture/target-architecture.md`.

## Risks and Mitigations

| Risk                                                  | Mitigation                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream authors reject the convention as too complex | Guide emphasizes that adoption is purely documentation — no code dependency, no schema enforcement. Extensions can ignore `permission:` entirely. |
| Flat format changes after guide is published          | #78 is closed and the format is stable. Guide links to the schema for canonical reference.                                                        |
| Could this silently weaken a permission?              | No. This is a documentation-only change. No runtime behavior is modified.                                                                         |
| Users confused by two overlapping keys in frontmatter | Guide explicitly explains the two-layer model and includes examples showing both keys coexisting.                                                 |

## Open Questions

- Should we propose a formal "convention version" number in case the flat format evolves, or is linking to the schema sufficient?
  Defer until upstream feedback arrives.
- Should the guide live in this repo or in a separate shared repo?
  Start here; move to a shared location only if multiple extensions want to co-maintain it.
