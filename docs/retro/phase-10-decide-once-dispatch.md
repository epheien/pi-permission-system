---
package: pi-permission-system
phase: 10
---

# Retro: pi-permission-system — Phase 10 Planning (decide-once-dispatch)

## Stage: Improvement Planning (2026-07-10T18:36:25Z)

### Session summary

The cause hypothesis (Step 1) was the architecture doc's one declared open piece — the cross-session access intent (principal identity + path portability across cwds), which deep-tracing confirmed as *live* code rather than theory: `ForwardedPermissionRequest` is a stringly `(surface?, value?)` payload, `ServingPolicy` normalizes a child's forwarded value against the parent's `PathNormalizer`/cwd, and pi-subagents' `WorkspaceProvider` seam makes cross-cwd children real.
The owner deferred that spine to a later phase (recorded as the leading Phase 11 candidate) and chose a **lean-to-full** phase shape focused on the two filed Category C repeated-discriminator families (`#561` tool-kind, `#562` win32 flavor) plus scheduled bash-surface work (`#309`, `#490`) and a docs recipe (`#521`) — six steps, four parallel tracks.

### Observations

- **The cause the phase dissolves** is the decide-once principle (OCP) violated at two boundaries: tool-kind re-decided by silent `===` at 21 sites (extraction + presentation), and the win32 path flavor re-derived from a raw `platform` string at 13 sites (connascence of algorithm with the silent-bypass security property, the `#382`/`#508` class).
  Neither is fallow-visible; the repeated-discriminator grep sweep was the only detector, corroborated by the two issues filed 2026-07-08 explicitly as planning input.
- **Deferral gate did not fire** — there were genuine Category C cause-level findings, so no "defer/lean" prompt was needed.
  But the primary architectural cause (cross-session intent) was deferred *by owner choice*, not for lack of merit; the phase spine is therefore the second-tier discriminator work.
  Recorded the cross-session gap prominently in the roadmap Findings so Phase 11 planning starts from it.
- **Repeat-deferral gate fired on four issues**, each given an explicit decision this phase rather than a silent re-sweep:
  - `#23` (per-agent overrides = "dead code") — **closed resolved-by-events**: the "no consumers" premise was stale; `@gotgenes/pi-subagents` emits `<active_agent name="…"/>` (`src/session/prompts.ts:37`), the exact signal `active-agent.ts` reads.
    This is the sanctioned migration path off pi-subagents' removed `disallowed_tools`.
    Verified before closing rather than trusting the issue's own claim.
  - `#309` (advisory bash fidelity) — **scheduled** as Step 4 after three rounds of owner questions.
    Key finding surfaced during Q&A: the internal serving path is *not* affected (the child forwards the offending sub-command unit via `check.command`, not the whole chained command, so the parent's whole-string re-resolution of a single unit is correct fidelity).
    Provenance settled: `#309` is our own self-filed limitation note on the `Symbol.for()` service (the RPC-over-event-bus successor, `#531`), not upstream-fork debris.
    No in-monorepo consumer imports `getPermissionsService()`; scheduled anyway by owner decision despite the low Priority score (6).
  - `#490` (indirection-wrapper flooring) — **scheduled** as Step 5; direction confirmed (re-target prefix wrappers, floor `xargs`/`find -exec`).
    *(Superseded 2026-07-12 during `#490` planning: floor **all** listed wrappers to `ask` uniformly — re-targeting needs per-wrapper option-arity tables whose errors silently under-match.*
    *See `docs/plans/0490-floor-indirection-wrappers.md`.)*
  - `#521` (read-only allowlist) — **scheduled** as a docs step (Step 6), owner preferred a recipe over closing with a comment.
  - `#519` (SDK UIContext) — **explicit deferral** recorded in the roadmap (blocked on SDK evolution), not a silent sweep.
- **Feasibility probes that reshaped steps:**
  - Step 4 (sync bash parse): confirmed `TSParser.parse` is synchronous once initialized — `BashProgram.parse` is async only for `await getParser()`, and the async `before_agent_start` hook precedes any tool call, so the warm-then-sync path the step promises actually exists.
  - Step 1 (`permission-manager.ts` constraint): the classification value is plain data, so it can be consumed at the string boundary without importing `AccessPath` (honors `docs/decisions/0002-path-values-string-boundary.md`).
  - Step 3 (`PathFlavor`): `forLiteral(literal, matchAliases?)` and the existing `PathNormalizer` construction site confirm the flavor can be built once from the single `process.platform` read and injected into both the normalizer and `rule.ts`'s `pathMatchOptions`.
- **Directory placement decided inline** (no `ask_user` — avoided decision fatigue after four question rounds): Step 3 seeds `src/path/` by relocating the three co-rewritten leaves (`path-containment.ts`, `canonicalize-path.ts`, `pi-infrastructure-read.ts`) alongside the new `path-flavor.ts`, tidy-first, dropping the flat root 62 → 59.
  A full `src/path/` domain (folding `path-normalizer.ts`, `path-surfaces.ts`, `tool-input-path.ts`) was noted as a forward-looking opportunity, not scheduled.
- **Mislabel caught:** `#564` targets `packages/pi-github-tools/src/lib/ci.ts` (verified the path exists); removed the stray `pkg:pi-permission-system` label rather than planning around it.
- **Health baseline:** score 88 (A), 0 dead code, 0.2% duplication (two small clone groups, both benign), maintainability 91.2.
  The single fallow "refactoring target" (`value-guards.ts`, 17 LOC / 19 dependents) is noise — it was already split by cohesion in `#532`; high fan-in on a tiny pure util is expected, not a finding.
- **Release shape:** Steps 1–3 are `refactor:` (hidden — batch into the next release rather than cutting one); Steps 4–5 are `feat:`/`fix:` behavior changes that cut releases; Step 6 is an unhidden `docs:`.
  The "tool-kind-dispatch" batch (Steps 1→2, tail Step 2) is the only multi-step coordination; the rest are independently releasable.
