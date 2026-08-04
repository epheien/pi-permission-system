---
issue: 478
issue_title: "pi-permission-system: narrow ScopedPermissionResolver to a single resolve(intent) (Phase 6 Step 6)"
---

# Retro: #478 — Narrow `ScopedPermissionResolver` to a single `resolve(intent)`

## Stage: Planning (2026-06-26T00:00:00Z)

### Session summary

Produced `docs/plans/0478-narrow-resolver-resolve-intent.md` for Phase 6 Step 6: introduce a three-variant `AccessIntent` that each gate emits, collapse the resolver's `resolve` + `resolvePathPolicy` into one `resolve(intent)`, and unify the manager's `checkPermission` + `checkPathPolicy` into one `check(intent, sessionRules?)`.
The change is behavior-preserving and ships independently (roadmap `Release: independent`).
Filed two follow-up issues surfaced during the design discussion: [#486] (should the `path` surface match canonical like `external_directory`?) and [#487] (adopt `AccessPath` as the universal internal path representation).

### Observations

- **Three-variant union, not two.**
  The decisive design call was the shape of `AccessIntent`.
  The operator pushed back on suppressing `AccessPath` ("we built it — why prevent it flowing?").
  Investigating the actual data settled it: bash-path's `path` surface matches the lexical aliases only (`getPathPolicyValues`), while `AccessPath.matchValues()` adds the canonical alias for `external_directory` (the [#418] set).
  So `path-values` and `access-path` are genuinely distinct variants — forcing bash-path through `AccessPath` would inject a canonical alias the `path` surface does not match today (a behavior change).
  The `tool` variant stays separate because only the manager can normalize raw input.
  Result: `tool | path-values | access-path`.
- **Resolver unwraps, manager stays string-based.**
  The operator chose to let `AccessPath` flow into the resolver (Tell-Don't-Ask: the resolver asks `path.matchValues()`), but keep the low-level `PermissionManager` matching over plain strings.
  Hence two types: public `AccessIntent` (3 variants) and `ResolvedAccessIntent` (2 variants) for the manager — the access-path variant is unwrapped in `toResolvedIntent` before the manager sees it.
- **Full manager collapse kills the false-green structurally.**
  The [#393] false-green was a stubbed-but-unrouted manager method.
  The operator chose full collapse to a single `check(intent)` (migrating the raw query callers `permissions-service` / `skill-prompt-sanitizer` / `permission-event-rpc`, plus the resolver's raw `checkPermission`), so there is no second method to forget.
- **Scope discipline.**
  Resisted scope creep into `path`-surface canonical matching and the universal-`AccessPath` migration; both were filed as separate issues ([#486], [#487]) rather than folded in.
  The plan's `path-values` variant is explicitly the transitional accommodation that shrinks under [#487].
- **TDD sequencing risk.**
  The interface removals (manager `check`, resolver `resolve(intent)`) break every typed mock at once.
  Planned lift-and-shift (new method alongside old → incremental gate migration → removal/rename) to avoid a single giant test rewrite, with a noted fallback to an atomic resolver commit if `/tdd-plan` judges the six call sites manageable.
- **Doc-staleness surface.**
  `architecture.md` carries the resolver surface in a health-metric row, the access-intent directory listing, and per-module narrative descriptions (`bash-path.ts`, `external-directory-policy.ts`); the package `SKILL.md` carries the [#393] / [#418] fixture-wiring notes that become obsolete (single method).
  Both are listed as doc updates.

## Stage: Implementation — TDD (2026-06-26T23:15:00Z)

### Session summary

Implemented Phase 6 Step 6 across six commits: added `ScopedPermissionManager.check(intent)` alongside the old pair, routed all manager callers through it (keeping thin class wrappers temporarily), removed `checkPermission`/`checkPathPolicy` from the interface, narrowed `ScopedPermissionResolver` to one `resolve(intent: AccessIntent)`, dropped the manager class wrappers, and updated docs.
Net test delta: +9 manager `check` cases in step 1, then a net −1 from consolidating the redundant `resolve`/`resolvePathPolicy` resolver tests into intent-variant cases (2125 → 2124 total).
Final state: 103 test files, 2124 tests green; `tsc`, root `lint`, and `fallow dead-code` all clean.

### Observations

- **Steps 3-4 collapsed into one atomic resolver-narrowing commit**, as the plan's TDD Order explicitly permitted.
  Surveying the gate tests showed `runner.test.ts` (35 resolve refs) mostly uses the `resolveResult` fixture param (return-value config, unaffected by the signature change) — only one assertion checked call args.
  The atomic narrowing was clearly less total churn than lift-and-shift's add-then-rename pass.
- **Step 2 split into two commits.**
  To avoid rewriting the 3500-line `permission-manager-unified.test.ts` (184 `checkPermission` + 6 `checkPathPolicy` call sites) in the interface-removal commit, I kept `checkPermission`/`checkPathPolicy` as thin class-only wrappers over `check` (off the interface — the false-green guarantee holds on the interface), then removed them in a follow-up `refactor` commit that migrated the test file via two local intent-building adapters (`checkTool` / `checkPathValues`).
  A `sed` prefix-replacement (`manager.checkPermission(` → `checkTool(manager, `) made the 190-site migration safe and mechanical.
- **`PermissionResolver implements SkillPermissionChecker`** (not in the plan's exact wording) resolved a fallow finding: once `resolve` stopped calling `this.checkPermission` internally, the raw `checkPermission` was only reachable via two structural interfaces (skill-input gate, skill-prompt sanitizer) that fallow can't trace.
  Declaring the documented contract is the fallow-skill-preferred fix over suppression; it also made `PermissionManager` no longer satisfy `SkillPermissionChecker` (it lost `checkPermission`), so two sanitizer tests gained a small `asChecker` adapter.
- **Fixture simplification killed the #393 false-green structurally.**
  `makeFakePermissionManager` went from `checkPermission` + `checkPathPolicy` stubs to a single `check`; `makeHandler` routes the surface-check override onto that one method via an intent→(surface, input) adapter.
  There is no second method a fixture can stub-but-forget.
- **Pre-completion reviewer: WARN** (no FAILs).
  Two non-blocking findings.
  Fixed #1 (Track B in `architecture.md` now marked ✅ complete since Steps 4-6 all landed, following the Track A convention).
  Left #2: the reviewer noted `SkillPermissionChecker` lives in `skill-prompt-sanitizer.ts` (its role-defining consumer) rather than co-located with its sole implementor `permission-resolver.ts`; the `type`-only import is benign (no cycle) and the fallow rationale justifies the current placement — relocating the interface is out of scope.

## Stage: Final Retrospective (2026-06-26T23:31:26Z)

### Session summary

Shipped Phase 6 Step 6 end-to-end in a single conversation spanning plan → TDD → ship → retro: a behavior-preserving narrowing of `ScopedPermissionResolver` to one `resolve(intent)` and `ScopedPermissionManager` to one `check(intent)`, released as `pi-permission-system-v16.2.0`.
The run was notably clean — no rework loops, no user-caught instruction violations, and every friction point was self-corrected within one or two tool calls.

### Observations

#### What went well

1. **Evidence-based design dialogue (planning).**
   The operator probed the `AccessIntent` shape across several `ask_user` rounds ("why prevent `AccessPath` from flowing?", "what is a plain path?").
   Each answer was grounded in the actual code — reading `getPathPolicyValues` vs `AccessPath.matchValues()` to show the `path` surface matches lexical aliases only while `external_directory` adds the canonical alias ([#418]).
   That investigation produced a better design (the three-variant union) than the issue's original "value-or-`AccessPath`" hypothesis, and the agent self-corrected an overstatement ("specifically designed to ignore" → "today matches lexical-only, changing it is out of scope").
2. **Lift-and-shift under a hard constraint.**
   The 3,500-line `permission-manager-unified.test.ts` had 184 `manager.checkPermission` + 6 `manager.checkPathPolicy` direct call sites.
   Rather than rewriting each into an intent literal, the migration introduced two test-local adapters (`checkTool` / `checkPathValues`) and bulk-replaced the call prefix with `sed` (`manager.checkPermission(` → `checkTool(manager, `), then removed the production wrappers — safe, mechanical, and it kept the production class free of test-only methods.
3. **Clean release-please nuance handling (ship).**
   The release PR was `UNSTABLE` with a `check` still `IN_PROGRESS`; the flow correctly polled `statusCheckRollup` until the check passed before merging, instead of falling back to `gh pr merge` mid-run — exactly the prompt's distinction between "no checks ran" and "check still running."

#### What caused friction (agent side)

1. `missing-context` — the Step 1 Red test called `createManagerWithProject({ agentName, globalPermission, agentPermission })`, but the helper's real signature is `(config, agentFiles, options)`.
   Caught on the first `vitest run` (one failing test) and rewritten to the agent-file frontmatter form.
   Impact: ~2 tool calls, no rework beyond the one test.
2. `other` (emergent) — narrowing made `PermissionResolver.checkPermission` reachable only via two structural interfaces, so `fallow dead-code` flagged it once `resolve` stopped calling it internally.
   Resolved with `implements SkillPermissionChecker` (which then required a small `asChecker` adapter in two sanitizer tests, since `PermissionManager` no longer satisfies that contract).
   This exact pattern is already documented in the `fallow` skill (gotcha #6: declare `implements` over suppression), so the resolution matched existing guidance.
   Impact: added friction but no rework.
3. `other` (mechanical) — the `sed` transform left `permission-manager-unified.test.ts` unformatted; `pnpm run lint` flagged it pre-commit and `biome check --write` fixed it.
   Impact: trivial; the existing lint gate caught it before commit.

#### What caused friction (user side)

1. The first design `ask_user` offered "values-only vs `AccessPath`-variant" without leading with the underlying data — the per-surface match-set difference (`path` = lexical only; `external_directory` = lexical ∪ canonical) that ultimately decided the choice.
   The operator had to probe across follow-ups to surface it.
   Opportunity, not criticism: when a design fork hinges on a concrete data distinction the agent can compute, leading the first question with that distinction (a two-line match-set comparison) may collapse several elaboration rounds into one.
   The rounds were still productive — operator-driven elaboration on materially new questions, not question-spew.

### Diagnostic details

- **Feedback-loop gap analysis** — no gap.
  Verification ran incrementally: `pnpm run check` after every interface-changing step, the affected test file after each Red/Green, and the full suite + `lint` + `fallow dead-code` before each interface-removal commit.
  Notably, the resolver narrowing passed `tsc` while 9 `toHaveBeenCalledWith` positional-mock assertions still failed at runtime — the full `vitest run` (not `tsc`) was the necessary backstop, and it was run before committing.
  This is already covered by the `testing` skill ("run the full suite before committing" when shared helpers change).
- **Escalation-delay tracking** — no `rabbit-hole` points; no error sequence exceeded ~2 consecutive tool calls.
- **Model-performance / unused-tool** — the pre-completion-reviewer subagent ran on its configured model for fresh-context review (appropriate, judgment-heavy); no mechanical work was mis-routed to an expensive model, and no `rabbit-hole`/`missing-context` point had an unused tool that would have helped.

### Changes made

1. Added this Final Retrospective stage entry to `packages/pi-permission-system/docs/retro/0478-narrow-resolver-resolve-intent.md`.
   No prompt or `AGENTS.md` changes: the one proposal (a test-local-adapter + bulk-rename tactic for the `testing` skill) was declined by the operator, and the fallow `implements` pattern is already covered by the `fallow` skill's gotcha #6.

[#393]: https://github.com/gotgenes/pi-packages/issues/393
[#418]: https://github.com/gotgenes/pi-packages/issues/418
[#486]: https://github.com/gotgenes/pi-packages/issues/486
[#487]: https://github.com/gotgenes/pi-packages/issues/487
