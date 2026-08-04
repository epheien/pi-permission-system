---
issue: 428
issue_title: "pi-permission-system: permission-system using incorrect path for `projectAgentsDir`"
---

# Retro: #428 — pi-permission-system: permission-system using incorrect path for `projectAgentsDir`

## Stage: Planning (2026-06-17T00:00:00Z)

### Session summary

Planned the fix for `derivePolicyLoaderOptions` computing `projectAgentsDir` as `<cwd>/.pi/agent/agents` instead of the Pi-convention `<cwd>/.pi/agents`.
The plan corrects the path via a new `getProjectAgentsDir(cwd)` helper in `config-paths.ts`, adds a behavior-level regression test, and fixes the same wrong path propagated into `docs/configuration.md`.

### Observations

- Third-party issue (author `robertpeteuil`, not the operator), so the direction was confirmed through `ask_user` rather than assumed.
- The operator initially leaned toward a shared cross-package path helper, then toward `pi-subagents` owning it.
  Surfaced that pi-permission-system currently has **zero** code dependency on pi-subagents — they couple only via the Pi event bus (channels re-declared independently per ADR-0002), so pps works standalone.
  Importing from pi-subagents would have introduced the first hard dependency and ended standalone use.
- Reframed `<cwd>/.pi/agents` as a **Pi platform convention**, not pi-subagents' private knowledge: pps already independently (and correctly) encodes three sibling convention paths, including the global agents dir it shares with pi-subagents.
  Operator agreed on a local fix with a named helper + cross-reference comment + regression test, preserving the decoupling.
- Classified as **breaking** (`fix!:`): project-agent `permission:` frontmatter, silently ignored today, starts being enforced on upgrade and can make sessions more restrictive.
- Per-agent permissions apply to directly-activated agents too (via `/agents`), not only pi-subagents children — so the path cannot be pushed via pi-subagents lifecycle events without missing cases.
  This confirmed the path belongs in pps.
- Found a propagated documentation bug at `docs/configuration.md:532` repeating the same wrong path; folded its correction into the plan as a separate `docs:` step.
- Long-term framing corrected by the operator after the initial draft: Pi is **single-agent by deliberate design**; multiple named agents are an external concept (pi-subagents, pi-agent-router, MasuRii packages), not Pi core.
  Verified in the wiring — pps learns the active agent from a generic `<active_agent>` tag injected by pi-agent-router / an `active_agent` session entry, and `/agents` is a pi-subagents command; there is no agent activation independent of external tooling.
  So my earlier "directly-activated via `/agents`" justification was wrong, and both initial Open Questions (upstream `getProjectAgentsDir` to the SDK; have the core parse agent frontmatter) were withdrawn — they would push a multi-agent concept into a core that rejects it.
- Corrected long-term direction now in the plan: per-agent `permission:` frontmatter is an **extension bridge on pps's single-agent core**; a cleaner future keeps that bridge generic (the multi-agent extension supplies the active agent's overrides via an extension-agnostic channel, like the active-agent signal pps already consumes), so pps need not locate or parse agent files.
  Short-term fix is unchanged.
- Recorded the settled part of this framing in `docs/architecture/architecture.md` at the operator's request: a new design principle 9 ("Single-agent core, multi-agent by extension") plus a framing note annotating the `Agent frontmatter` (`AF`) input in the architecture-overview diagram.
  The forward-looking generic-channel evolution stays in the plan's Open Questions, not the architecture doc.

## Stage: Implementation — TDD (2026-06-17T14:15:00Z)

### Session summary

Completed both TDD steps from the plan in one session.
Added `getProjectAgentsDir(cwd)` to `src/config-paths.ts`, wired it into `derivePolicyLoaderOptions`, and covered it with a unit test plus two regression tests (path-level and behavior-level).
Test count went from 2015 to 2018 (+3).

### Observations

- No deviations from the plan; the one-line fix plus helper extraction went exactly as planned.
- The pre-completion reviewer returned **WARN** (not FAIL) with two stale path references not covered by the plan: `docs/troubleshooting.md:31` (sample `config.resolved` log) and `docs/decisions/0001-project-trust-adoption.md:30` (code comment in ADR-0001).
  Both were fixed in an additional `docs:` commit before writing these notes.
- After the WARN fixes, all checks are clean: `pnpm run check`, `pnpm run lint`, `pnpm run test` (2018 pass), `pnpm fallow dead-code` all pass.
- Pre-completion reviewer verdict: **WARN → resolved** (both stale-path findings addressed; effectively PASS at ship time).

## Stage: Final Retrospective (2026-06-17T15:30:00Z)

### Session summary

Shipped a one-line path fix (`<cwd>/.pi/agent/agents` → `<cwd>/.pi/agents`) end-to-end across planning, TDD, and ship in a single continuous session, releasing `@gotgenes/pi-permission-system` v14.0.0.
The planning stage did the heavy lifting: three `ask_user` rounds converged on a decoupling-preserving local fix and surfaced the single-agent-architecture framing now recorded as architecture design principle 9.

### Observations

#### What went well

- **The `ask_user` reframe loop changed the outcome.**
  The third-party-direction question plus two helper-shape questions stopped me from building the first-ever hard `pps → pi-subagents` dependency (the initial "shared helper" instinct).
  Verifying that pps has zero existing code dependency on pi-subagents, then reframing `<cwd>/.pi/agents` as a Pi platform convention, landed the correct local fix.
  The gate earned its keep on a bug that looked trivial.
- **The pre-completion reviewer caught what planning missed.**
  The fresh-context reviewer (`anthropic/claude-sonnet-4-6`) flagged two stale `agent/agents` references the planning grep never checked (`docs/troubleshooting.md`, `docs/decisions/0001-project-trust-adoption.md`), turning a would-be post-release doc drift into one pre-ship `docs:` commit.
- **Clean TDD execution.**
  Red→green→commit ran exactly as planned with incremental verification (baseline check, per-file vitest in red/green, full suite + check + lint + fallow before the reviewer); no rework, +3 tests.

#### What caused friction (agent side)

- `missing-context` — the planning-stage stale-path grep was scoped to two hand-picked files (`packages/pi-permission-system/docs/configuration.md` and `README.md`) instead of the whole package `docs/` tree.
  A `grep -rn "agent/agents" packages/pi-permission-system/docs/` would have surfaced `troubleshooting.md` (sample `config.resolved` log) and `docs/decisions/0001-project-trust-adoption.md` (ADR code comment) at plan time.
  Impact: reviewer-caught (not self-identified at plan time); one extra `docs:` commit (`95effebf`) at the TDD/ship boundary.
- `other` (tool usage) — an `Edit` batch was rejected for carrying `oldText2`/`newText2` keys on a single edit object instead of separate `edits[]` entries.
  Impact: one retry, self-corrected, no rework.
- `missing-context` (minor) — tried to load the `colgrep` skill from `.pi/skills/colgrep/SKILL.md` (ENOENT); the real path is `packages/pi-colgrep/skills/colgrep/SKILL.md`.
  Impact: negligible — proceeded with `grep`, which suited the exact-string search.

#### What caused friction (user side)

- The single-agent-architecture framing arrived as operator pushback *after* the plan was drafted with SDK-upstreaming Open Questions ("upstream `getProjectAgentsDir` to the SDK"; "have the core parse agent frontmatter").
  This is durable, reusable knowledge — Pi is single-agent by design; multiple named agents are an external-extension concept — now captured in `docs/architecture/architecture.md` design principle 9.
  Opportunity: the `package-pi-permission-system` skill (loaded at the start of every planning session) does not point to it, so a future session could re-derive the same wrong framing.

### Diagnostic details

- **Model-performance correlation** — the sole subagent dispatch (pre-completion-reviewer) ran on `anthropic/claude-sonnet-4-6`, appropriate for judgment-heavy read-only review; it found two real issues.
  No mismatch.
- **Escalation-delay tracking** — no `rabbit-hole` sequences; the only tool errors (one `Edit` rejection, one skill ENOENT) self-corrected on the next call.
- **Feedback-loop gap analysis** — verification ran incrementally throughout TDD (baseline → per-file vitest → full suite + check + lint + fallow), not just at the end.
  No gap.

### Changes made

1. `.pi/skills/package-pi-permission-system/SKILL.md` — added a `### Single-agent core` note under Cross-Extension Integration (pointing to architecture design principle 9) and gave the pre-existing jiti prose a `### Jiti isolation` heading so the two stay separate.
2. `.pi/prompts/plan-issue.md` — added a Module-Level Changes grep rule: when correcting a literal value that appears in prose, grep the whole `packages/<PKG>/docs/` tree, not a hand-picked subset.
