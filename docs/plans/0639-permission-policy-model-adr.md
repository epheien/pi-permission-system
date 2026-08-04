---
issue: 639
issue_title: "pi-permission-system: decide the permission policy model — capabilities, config shape, prior art (ADR 0009)"
---

# ADR 0009 — permission policy model: capabilities, config shape, prior art

## Release Recommendation

**Release:** ship independently

This is a documentation-only decision record: it touches `docs/decisions/` and `docs/architecture/`, both release-please `exclude-paths`, so it cuts no physical release on its own — the same posture as the ADR 0007 plan ([#591]).
The decisions it records are implemented later (starting with [#609]'s re-plan), and those changes release on their own merits.

## Problem Statement

Issue [#609] (third-party, filed by `hcrosse`) asks for output redirects to be governed separately from the command: an allowed bash command should not implicitly carry the right to write files through `>`/`>>`.
Planning it exposed a general gap: access direction/capability is not a first-class fact anywhere in the model — the cross-cutting `path` surface is direction-blind, and bash path tokens have no read/write identity at all.
The operator widened the question deliberately: rather than bolt on one key, decide the permission policy model itself, with nothing locked down going in — including the current config format.

The deliverable is ADR 0009, settled interactively during the build session.
The [#581] lesson applies in full: the deliberation is the deliverable; the ADR must record decisions actually made with the operator, not transcribe the sketches produced during this planning conversation.

The operator's decision criteria, stated verbatim in planning: clarity; simplicity ("straightforward, avoiding complex calculus of interactions between rules, and ambiguity"); designed for our users first.

## Goals

- Author `docs/decisions/0009-permission-policy-model.md` deciding the future shape of the permission policy model, with every decision settled interactively during the `/build-plan` session.
- Survey prior art with citations before deciding — agent tools (OpenCode, Claude Code, Codex CLI) and capability systems (Deno permissions, Node's permission model, Linux Landlock, macOS Seatbelt, WASI preopens, systemd sandboxing) — extracting each system's policy axis, naming, composition semantics, default stance, and unknown-handling.
- State the threat model explicitly in the ADR: a cooperative-but-fallible agent; attention routing, not containment; an OS sandbox as the eventual enforcement seam this design should be able to hand classifications to.
- Evaluate the full option space (documented in Design Overview) against the operator's criteria, recording rejected alternatives with reasons.
- Decide the staging: what [#609]'s implementation builds first, unblocking its re-plan.

## Non-Goals

- Implementing anything — no `src/`, `test/`, `schemas/`, `config/`, or `README.md` change; current behavior is untouched.
  Issue [#609] stays open and is re-planned after the ADR lands.
- Executing any config migration or renaming, even if the ADR decides one — implementation issues carry that work.
- Filing speculative follow-up issues for stages beyond [#609] (e.g. read-side wiring, a command-effects knowledge base, net-egress effects) — the ADR's staging section names them; filing happens at the next `/plan-improvements` pass or during [#609]'s re-plan, whichever the ADR directs.
- Redesigning the live-authority layer (the ADR 0007 authorizer chain) — this ADR is about the deterministic policy model the chain consults, not about who holds live authority.

## Background

### The current model, mapped

Every gated action has three independent facts: an actor (which tool/channel), an object (which path, command, server:tool, skill name), and a capability (read fs, write fs, execute, cross the cwd boundary).
Today's flat permission map expresses:

| Key today                             | Axis expressed                    | Notes                                            |
| ------------------------------------- | --------------------------------- | ------------------------------------------------ |
| `read`/`grep`/`find`/`ls`             | actor (implies capability: read)  | path-matched                                     |
| `write`/`edit`                        | actor (implies capability: write) | two keys, one capability; users must set both    |
| `bash`                                | actor (capability: exec)          | command patterns; decomposition + wrapper floors |
| `mcp`, `skill`, `special`, tool names | actor                             |                                                  |
| `path`                                | object, capability-blind          | any file access, any direction, any actor        |
| `external_directory`                  | boundary                          | outside-cwd guard, orthogonal to the above       |
| `*`                                   | universal fallback                |                                                  |

Composition is most-restrictive-wins across surfaces, last-match-wins within a surface.
OpenCode's model (the fork's origin) is actor-keyed with two guards; its only nod to direction is collapsing `edit`/`write`/`patch` into one `edit` key, and its bash gating is command-pattern only.

### The engine seams that price the options

- `AccessIntent` (`tool` | `access-path`) carries a free-form `surface` string; the resolver and manager do not care what the keys mean.
  New surface keys are additive.
- Every policy channel speaks flat `(surface, pattern)` pairs: session-approval rules, the forwarded-intent wire ([#596]), the cross-extension `PermissionsService` queries, and per-agent frontmatter.
  A nested config shape would be flattened internally regardless; a format remodel churns all four channels.
- Bash path tokens are gated on `path` + `external_directory` only.
  Redirect targets are collected by `collectRedirectTokens` but then shape-filtered like any other token, so a bare in-cwd target (`> out.txt`) is not even a rule candidate today, and `BashProgram.commands()` deliberately strips redirects from command text — the exact [#609] gap.

### The evidence: capability keeps escaping pattern matching

The fork's history is a catalog of the same event — a capability escaping command-pattern rules through a syntactic synonym:

| Issue          | Escape channel                                                 |
| -------------- | -------------------------------------------------------------- |
| [#301]         | whole-string matching bypassed by chained commands             |
| [#306]         | command/process substitution executes unseen                   |
| [#393]         | `cd` folding; unknown bases must stay literal-only             |
| [#452]         | unparseable commands must fail closed                          |
| [#481]         | `bash -c`/`eval` opacity; env-var prefixes                     |
| [#490], [#575] | indirection wrappers (`sudo`, `env`, `xargs`, `find -exec`, …) |
| [#509]         | bare tokens invisible to shape classifiers                     |
| [#533]         | platform reinterprets the same token                           |
| [#574]         | other extensions re-expose bash under new names                |
| [#609]         | output redirects ride the command's allow                      |

The structural parts age well (`AccessPath` alias matching [#418], the boundary gate, fail-closed floors, determinism); the command-spelling parts are a treadmill.
This evidence motivates the reframe the ADR must weigh: policy keyed by effects, with command patterns as evidence and refinement.

### Leanings from the planning conversation — explicitly not decisions

The operator unlocked everything ("none of the decisions we've explored today are locked-down"), so these are inputs to the deliberation, not settled outcomes:

- Naming leaning: `path_read`/`path_write` (path-family) over `fs.read`/`fs.write` — though the `fs` prefix is the cross-ecosystem convention (Node's `--allow-fs-read`/`--allow-fs-write`, Landlock `ACCESS_FS_*`, Seatbelt `file-read*`/`file-write*`), Deno-style bare `read`/`write` collides with our existing tool keys.
- Nesting (`path: { read: …, write: …, "*": … }`) was analyzed and found grammatically ambiguous: `path: { "read": "allow" }` is already a valid pattern rule matching a file literally named `read`, and the map-valued discriminator collides with `denyWithReason` object values.
  The analysis rides into the ADR; nesting remains evaluable as sugar over flat keys.
- An earlier gate (under the narrower flooring framing) chose a shipped default of `ask` for output-redirect writes (breaking, `feat!:`) — recorded as a leaning toward least-privilege defaults, explicitly reopened with everything else.
- The effect-centered sketch (effects primary; structural proof + a command-effects knowledge base + honest unknowns; `net` as a future effect; effect-level session approvals; sandbox-handoff seam) is one candidate among several, not the presumed target.

### Standing constraints

- Config files are the source of truth; no policy baked into code; a declared config field not read at runtime is a maintenance trap.
- Determinism: same policy + same input → same decision (no `cygpath`, no environment reads in matching).
- Least privilege and fail-closed stay non-negotiable; the composition semantics that deliver them are what the ADR may redesign.
- The architecture doc inline-copies the `rule.ts` types; this ADR changes no types, but any implementation that does must update that listing.
- ADR markdown follows the `markdown-conventions` skill (one-sentence-per-line, reference-style issue links, MD053 discipline).

## Design Overview

This plan deliberately does not settle the design.
It defines the decision framework the build session executes.

### Decision criteria

1. Clarity — a user can predict what a config does by reading it.
2. Simplicity — straightforward; avoid a complex calculus of interactions between rules.
   This criterion cuts at the multi-surface most-restrictive lattice itself, so composition semantics are on the table, not just key names.
3. No ambiguity — no config text with two plausible readings (the nesting analysis is the cautionary example).
4. User-first — ergonomics of authoring, reading prompts, and approving sessions outrank internal elegance.
5. Retained unless deliberately revisited: determinism, least privilege, fail-closed unknowns.

### Option space to evaluate

- **O1 — status quo + targeted `path_write` key.**
  Smallest change; fixes [#609]; direction stays a bolt-on.
- **O2 — capability family as flat keys.**
  `path_read`/`path_write` join `path` + `external_directory` as a capability/boundary layer; actor keys become refinement; most-restrictive lattice retained.
- **O3 — nested facets under `path`.**
  Grouping sugar; carries the documented grammar ambiguity; internally flattens to O2.
- **O4 — effect-centered model.**
  Effects primary (`fs read/write`, `exec`, later `net`), classified by structural proof, a curated command-effects knowledge base (consolidating `PATTERN_FIRST_COMMANDS`, the wrapper sets, `SAFE_SYSTEM_PATHS`), and an explicit unknown category the user must deliberately allow; flat keys; actor keys as refinement.
- **O5 — full config remodel.**
  A v2 format with capability domains primary and tools demoted; prices in a dual-format loader window and churn across all four flat-pair channels.
- **O6 — single ordered rule list.**
  A firewall-style model: one ordered list of typed rules (match on effect/path/command/tool → action), first- or last-match wins; trades the lattice's cross-surface calculus for explicit ordering.
  Included because criterion 2 questions the lattice; the ADR must evaluate whether ordering is simpler or merely different.

### Prior-art survey scope

For each system, extract: policy axis (actor/capability/effect), key naming, composition and conflict semantics, default stance, unknown-handling, and prompt/escalation UX.

| System                | Why it matters                                                                   |
| --------------------- | -------------------------------------------------------------------------------- |
| OpenCode              | the fork's origin; actor-keyed baseline                                          |
| Claude Code           | agent-adjacent; `Tool(specifier)` allow/ask/deny lists + sandbox modes           |
| Codex CLI             | agent-adjacent; approval modes paired with an OS sandbox                         |
| Deno                  | cleanest capability flags (`--allow-read/--allow-write/--allow-net/--allow-run`) |
| Node permission model | literally `--allow-fs-read`/`--allow-fs-write`                                   |
| Linux Landlock        | kernel fs capability rights (`ACCESS_FS_*`)                                      |
| macOS Seatbelt        | operation-named profile rules (`file-read*`, `process-exec`)                     |
| WASI                  | capability handles; preopened dirs; `path_open` rights                           |
| systemd               | path-scoped mode lists (`ReadOnlyPaths=`, `ReadWritePaths=`)                     |

### Open parameters the build session settles interactively

1. Policy axis: actor-keyed (status quo), +capability layer, or effect-primary.
2. Composition semantics: retain the most-restrictive lattice, or simplify (O6-style ordering, or a narrower layer set).
3. Key naming and shape: `path_read`/`path_write` vs `fs`-prefixed vs nesting sugar.
4. Unknown-effects stance: inert-when-absent vs an explicit unknown category in policy.
5. Defaults and breaking posture for redirect writes (leaning: shipped `ask` default, `feat!:` — reopened).
6. Whether the command-effects knowledge base becomes a named, curated asset (and when).
7. Staging: what [#609] implements first; which follow-ups the ADR names and where they get filed.

The gate protocol during `/build-plan`: complete the survey first, present findings and option evaluations, then run `ask_user` gates per parameter cluster before authoring a word of the ADR — decisions precede prose.

## Module-Level Changes

Documentation only.

- **New:** `packages/pi-permission-system/docs/decisions/0009-permission-policy-model.md` — the ADR: threat model, decision criteria, current-model inventory, prior-art survey with citations, options considered with rejected alternatives and reasons, the settled decisions (parameters 1–7), staging, and consequences.
  The 0009 slot is next (0001–0008 taken); the file slug may sharpen at build time to reflect the settled decision, keeping the 0009 number.
- **Changed:** `packages/pi-permission-system/docs/architecture/architecture.md` — link ADR 0009 from the design-principles section and reconcile any prose the settled decision contradicts (candidates: the most-restrictive-wins principle statement, the `path`-surface description, any aspirational prose about policy evolution).
  Grep the whole file for stale framing after the decision is known — the [#581] failure mode was un-reconciled prose surviving an internally consistent ADR.
- **Not edited:** `docs/architecture/history/*`, `docs/plans/*`, `docs/retro/*` — frozen point-in-time records; `README.md`, `docs/configuration.md`, `schemas/`, `config/` — they describe current behavior, which this ADR does not change; `.pi/skills/package-pi-permission-system/SKILL.md` — it documents current behavior and constraints, all still true.

## Test Impact Analysis

Not applicable — the deliverable is a decision record with no code.
Tests the settled design enables (recorded for [#609]'s re-plan to inherit): redirect-operator classification (output vs input vs fd-duplication), unconditional collection of output-redirect targets, capability-surface resolution and composition, and — if the ADR adopts them — knowledge-base row lookups and unknown-category resolution.

## Invariants at risk

- **The [#581] transcription failure.**
  This planning conversation produced sketches and leanings; the ADR must not launder them into settled status.
  Mitigation is structural: the Build Order places the survey and the `ask_user` decision gates before ADR authoring, and the plan marks every leaning as reopened.
- **Cross-doc consistency.**
  If the decision revises composition semantics or the `path` family, the architecture doc's principle statements must be reconciled in the same change, verified by a whole-file grep for the superseded framing (`most-restrictive`, `path` family descriptions, aspirational policy prose).
- **Current-behavior docs stay true.**
  `README.md` and `docs/configuration.md` describe shipped behavior; the ADR decides future direction and must not cause edits that make current-behavior docs describe unshipped design.

## Build Order

Documentation-only, so `/build-plan` (no red→green cycles).
Numbered `docs:` commits, each leaving the docs internally consistent.

1. **Survey prior art.**
   Research the nine systems in scope (web sources with citations; `librarian`/`fetch_content` for primary docs), producing per-system extractions of policy axis, naming, composition, defaults, unknown-handling, and prompt UX.
   No commit — this is input to the deliberation.
2. **Deliberate and settle.**
   Present the survey findings and the O1–O6 evaluations against the criteria; run `ask_user` gates covering the seven open parameters (clustered: axis+composition; naming+shape; unknowns+defaults; knowledge base+staging).
   No commit — decisions precede prose.
3. **Author ADR 0009.**
   Write `docs/decisions/0009-permission-policy-model.md` recording the threat model, criteria, survey, options with rejected alternatives, the settled decisions, staging for [#609], and consequences.
   Verify with `pnpm exec rumdl check` on the new file.
   Commit: `docs(pi-permission-system): record ADR 0009 deciding the permission policy model (#639)`.
4. **Reconcile the architecture doc.**
   Link ADR 0009 and reconcile any contradicted prose in `docs/architecture/architecture.md` in one commit; run the whole-file grep from *Invariants at risk*; verify any touched Mermaid diagrams still render.
   Commit: `docs(pi-permission-system): reconcile architecture with ADR 0009 (#639)`.

## Risks and Mitigations

- **Risk: transcription instead of deliberation (the [#581] revert).**
  Mitigated: survey-then-gates-then-prose ordering in the Build Order; leanings explicitly marked reopened in Background.
- **Risk: a shallow survey that just confirms the effect-model sketch.**
  Mitigated: the per-system extraction template forces comparable facts (axis, composition, defaults, unknowns) rather than cherry-picked naming; O6 is in the option space specifically because it challenges the sketch's lattice.
- **Risk: the ADR over-commits implementation detail.**
  Mitigated: the ADR settles model, semantics, naming, defaults, and staging; schemas, migration mechanics, and knowledge-base contents belong to the implementation issues.
- **Risk: scope creep into code.**
  Mitigated: Non-Goals fences this to `docs/`; [#609] and successors implement.
- **Risk: a breaking-default decision ships without migration discipline.**
  Mitigated: if the settled decision is breaking, the ADR records the posture, and the implementing issue's plan carries the `feat!:`/`BREAKING CHANGE:` footer and a verified migration note — not this ADR.

## Open Questions

- The seven open parameters in Design Overview — deliberately open; they are the ADR's subject.
- Whether nesting sugar over flat keys is ever worth its grammar cost — evaluable in the ADR, decidable later without model change if deferred.
- Where the ADR-named follow-ups get filed (during [#609]'s re-plan vs the next `/plan-improvements` pass) — settled by the ADR's staging section.

[#301]: https://github.com/gotgenes/pi-packages/issues/301
[#306]: https://github.com/gotgenes/pi-packages/issues/306
[#393]: https://github.com/gotgenes/pi-packages/issues/393
[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#452]: https://github.com/gotgenes/pi-packages/issues/452
[#481]: https://github.com/gotgenes/pi-packages/issues/481
[#490]: https://github.com/gotgenes/pi-packages/issues/490
[#509]: https://github.com/gotgenes/pi-packages/issues/509
[#533]: https://github.com/gotgenes/pi-packages/issues/533
[#574]: https://github.com/gotgenes/pi-packages/issues/574
[#575]: https://github.com/gotgenes/pi-packages/issues/575
[#581]: https://github.com/gotgenes/pi-packages/issues/581
[#591]: https://github.com/gotgenes/pi-packages/issues/591
[#596]: https://github.com/gotgenes/pi-packages/issues/596
[#609]: https://github.com/gotgenes/pi-packages/issues/609
