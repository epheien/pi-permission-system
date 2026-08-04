---
issue: 592
issue_title: "TSC Error when importing publicly available types from the package"
---

# Retro: #592 — TSC Error when importing publicly available types from the package

## Stage: Planning (2026-06-24T00:00:00Z)

### Session summary

Diagnosed the reported `TS2307` as a Node subpath-imports resolution failure: the published `exports` points at raw `./src/service.ts`, whose transitive `#src/*` imports map to `./src/*` (no extension), and subpath-imports resolution — unlike TypeScript `paths` — does not probe extensions.
Confirmed the sibling `pi-subagents` already solved the identical problem with a `rollup-plugin-dts` bundled `dist/public.d.ts` behind an `exports.types` condition, guarded by a `verify:public-types` CI check.
Produced a build-plan-style plan that adopts that convention verbatim for this package's single `.` entry.

### Observations

- Third-party issue (author `enolive`, not the operator), so the direction gate ran even though the reporter's proposed fix was concrete.
  The reporter's one-line fix — appending `.ts` to the `imports` map — is deliberately **not** taken.
- Operator answers walked the decision: first toward the bundled `dist` artifact plus a dogfood guard, then relaxed to "recommend the robust, `pi-subagents`-consistent approach."
  Final direction: fully consistent with `pi-subagents` — bundled declarations + `verify:public-types` guard, and **no** `imports`/`paths` dogfood (which would diverge from the sibling's config shape).
  The `verify:public-types` guard is stronger than the internal dogfood for this bug class because it type-checks the real packaged tarball from an external consumer.
- Verified the public surface is plain TS (`z.infer` types resolve structurally; `permission-events.ts` has no imports), so `external: [/^@earendil-works\//]` suffices and the emitted `.d.ts` inlines with no `zod`/pi-sdk leakage.
- Verified no workspace package imports `@gotgenes/pi-permission-system` as a type dependency, so `pnpm -r run check` never needs `dist/` prebuilt.
- Not breaking: the runtime `default` condition still resolves to `src/service.ts`, so jiti loading is unchanged; only type resolution gains the bundle.
  Ship independently (`fix:` cuts the release; surrounding `build:`/`test:`/`docs:` commits batch in).
- Late scope addition (operator): lift `rollup` + `rollup-plugin-dts` into the `pnpm-workspace.yaml` catalog now that a second package uses them, and update to the latest versions.
  Plan revised to catalog `rollup ^4.62.2` (bumped from the `^4.61.1` pinned in `pi-subagents`) and `rollup-plugin-dts ^6.4.1`, migrate `pi-subagents`' two pins to `catalog:`, and add both as `catalog:` devDeps here.
  The bump moves `pi-subagents` within `rollup@4.x`, so step 1 re-verifies its `verify:public-types` + tests.
  This is the only touch to a second package (a specifier-only swap), so the plan stays single-package under `pi-permission-system`.
- Next step is `/build-plan` (no new Vitest red→green cycles; the regression guard is a shell script mirroring the sibling).

## Stage: Implementation — Build (2026-06-24T00:00:00Z)

### Session summary

Executed all 4 plan steps as 4 commits: catalog-lift + `rollup.dts.config.mjs` (`build:`), the `exports.types` publish (`fix:`, the release-cutting commit), the `verify-public-types.sh` regression guard + CI wiring (`test:`), and the `architecture.md`/`cross-extension-api.md` doc updates (`docs:`).
No `src/`/`test/` files in `pi-permission-system` were touched, so `tidy-first` was skipped per its applicability gate.
Full suite (2472 tests in `pi-permission-system`, 965 in `pi-subagents`, 3068 total across the workspace), `pnpm -r run check`, `pnpm run lint`, and `pnpm fallow dead-code` are all green; `pre-completion-reviewer` returned **PASS**.

### Observations

- One deviation from the plan snippet, folded into step 1's commit rather than treated as a separate stop-and-ask: the first `build:types` run emitted a non-fatal Rollup warning (`Unresolved dependencies: node:path`, imported transitively by `src/path/path-flavor.ts` even though `PathFlavor` is not part of the public surface).
  Added `/^node:/` to `rollup.dts.config.mjs`'s `external` array (alongside `/^@earendil-works\//`) for a warning-free build; verified `dist/public.d.ts` still has zero `#src` leakage and all public symbols present.
  The reviewer flagged this as "harmless" and confirmed it's inert (no `node:` import actually reaches the emitted bundle).
- The sibling regression check (plan's stated mitigation for the `rollup` catalog bump 4.61.1 → 4.62.2) was run twice: once right after the catalog migration (step 1) and once more after the full doc pass, both green — `pi-subagents`' `verify:public-types` and its 965-test suite.
- The reporter's exact repro symbol (`PERMISSIONS_UI_PROMPT_CHANNEL`) is the first import in `verify-public-types.sh`'s consumer probe; the probe's `tsconfig.json` mirrors the reporter's `moduleResolution: "Bundler"` / `verbatimModuleSyntax: true` settings from the issue body.
  One adjustment from the sibling script: dropped `"types": ["node"]` (present in the reporter's own tsconfig) since it requires `@types/node` in the throwaway consumer and is incidental to the bug being verified (subpath-imports extension resolution, not `@types/node` availability) — the sibling script's leaner tsconfig omits it too.
- No `docs/architecture/architecture.md` roadmap-step `✅` marker was needed — confirmed in planning that #592 has no roadmap step (`Release: ship independently`).
- Pre-completion reviewer: **PASS**.
  All deterministic checks, Conventional Commits, forward/reverse docs, Mermaid parse, and dead-code passed; several sections were correctly `SKIP` (no `src/` changes → code-design skip; no Vitest cycles in the plan → test-artifact skip against Vitest specifically; no roadmap step → invariants skip; no named follow-up → follow-up skip).

## Stage: Final Retrospective (2026-07-15T00:00:00Z)

### Session summary

Shipped `@gotgenes/pi-permission-system@20.7.3` cleanly across four stages (plan → build → ship → retro): the fix bundles the public type surface into a self-contained `dist/public.d.ts` behind `exports.types`, mirroring the `pi-subagents` convention, and lifts `rollup`/`rollup-plugin-dts` into the shared pnpm catalog.
The whole change was near-mechanical because planning found an existing sibling convention to port verbatim; the only friction was two minor, self-resolved `missing-context` moments (a `node:` builtin and a `types: ["node"]` probe setting), neither causing rework.

### Observations

#### What went well

1. Porting the `pi-subagents` declaration-bundling convention verbatim turned a fiddly packaging fix into a repeatable, low-risk port — the first reuse of that convention across a second package, which validates it as a pattern rather than a one-off.
2. The `verify:public-types` guard reproduces the reporter's *exact* repro (the `PERMISSIONS_UI_PROMPT_CHANNEL` import plus the `moduleResolution: "Bundler"` / `verbatimModuleSyntax: true` tsconfig from the issue body), so it fails before the fix and passes after — a true black-box regression guard, not a synthetic proxy.
3. Ship-stage `release_pr_merge` `UNSTABLE` handling was a clean traversal of the nuanced step-6.4 branch: correctly distinguished a genuine `IN_PROGRESS` PR-branch check from the empty-rollup `GITHUB_TOKEN` case, waited via `ci_watch`, re-verified `mergeStateStatus: CLEAN`, then merged by rebase — no premature `gh pr merge` fallback while a check was running.

#### What caused friction (agent side)

1. `missing-context` — the `rollup.dts.config.mjs` `external` list, copied from `pi-subagents`, lacked `/^node:/`; this package's public surface transitively imports `node:path` (via `src/path/path-flavor.ts`, pulled in through `rule.ts`'s `RuleOrigin`), so the first `build:types` emitted an unresolved-dependency warning.
   Impact: one edit (add `/^node:/`) folded into the same `build:` commit; warning-only (exit 0 throughout), no rework.
   Self-identified.
2. `missing-context` — the `verify-public-types.sh` consumer-probe `tsconfig.json` initially copied the reporter's `types: ["node"]`, which failed `TS2688` in the throwaway consumer (no `@types/node` installed there).
   Impact: one edit (drop the line, matching the sibling script's leaner tsconfig) + one re-run, ~1 tool cycle; the script was uncommitted, so no commit rework.
   Self-identified.

#### What caused friction (user side)

1. None material.
   The operator's planning-stage direction-walking (bundled-`dist`-plus-dogfood → fully `pi-subagents`-consistent) and the mid-planning catalog-lift addition were productive strategic steering that sharpened the plan, not rework — the catalog need only became visible once a second consumer of `rollup` existed.

### Diagnostic details

- **Model-performance correlation** — one subagent dispatch this issue: `pre-completion-reviewer` on `anthropic/claude-sonnet-5` (its frontmatter model), a judgment-heavy review task — appropriate; no reasoning-weak-on-judgment or high-cost-on-mechanical mismatch.
- **Escalation-delay tracking** — no `rabbit-hole` friction; both `missing-context` items resolved in a single tool cycle each, well under the 5-call flag.
- **Unused-tool detection** — none applicable; no `missing-context` moment would have been shortened by an `Explore`/`colgrep`/`web_search` dispatch (both were config-mechanics gotchas surfaced immediately by running the build).
- **Feedback-loop gap analysis** — verification ran incrementally after each step (`build:types` → `pnpm pack` + `tar tzf` → `verify:public-types` → `lint:md` → full `pnpm -r run test`/`check`/`lint`), not batched at the end; the sibling regression check ran twice (post-catalog-migration and post-doc-pass).
  No gap.

### Changes made

1. `packages/pi-permission-system/docs/retro/0592-bundle-public-declaration-types.md` — appended this Final Retrospective stage entry.
2. No `AGENTS.md` or prompt changes: the one candidate (a `/^node:/` rollup-`external` note for dist-bundling packages) was surfaced but declined by the operator as too low-frequency; it stays captured in the friction notes above.
