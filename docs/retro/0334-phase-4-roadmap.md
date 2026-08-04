---
issue_title: "Phase 4 improvement roadmap"
---

# Retro: Phase 4 improvement roadmap

## Stage: Final Retrospective (2026-06-04T16:57:30Z)

### Session summary

Ran the `plan-improvements` workflow for `pi-permission-system` and produced a Phase 4 roadmap in `docs/architecture/architecture.md`.
The first draft mis-diagnosed the package as having reached a "structural plateau" and targeted the test tree; the user pushed back, the analysis was redone against the production code, and the roadmap was rewritten to a production-first refactor (inject `PermissionManagerFactory`, de-god `ExtensionRuntime`, split the `PermissionSession` god object, then a test-cleanup tail).
Committed as `docs(pi-permission-system): propose Phase 4 improvement roadmap` (`3d8a72ae`).

### Observations

#### What went well

- The second-pass analysis grounded every finding in a specific test-pain artifact: the `GateRunner(session, session, session, reporter)` triple, the `vi.mock("../src/runtime")` + `as unknown as PermissionManager` in `permission-session.test.ts`, and the 17-field `makeSession` fixture in `handler-fixtures.ts`.
  This is the rigor that should have appeared in the first pass.
- Quantifying the smell with `grep` produced a "constructibility table" as a measurable success metric for a debt-reduction phase: 20 `index.ts` closures/`.bind` adapters, 5 `runtime`-as-first-arg free functions, 6 interfaces implemented by one class, 23 test files using `vi.mock`, ~37 `as unknown as` casts.
  Framing a refactoring plan around moving those counts to zero is a stronger contract than a prose narrative.
- The `ask_user` scope/sequencing gate worked cleanly once the analysis pivoted — a single two-question batch (ambition: Full; sequencing: production-first) shaped the 9-step plan without further back-and-forth.

#### What caused friction (agent side)

- `premature-convergence` — produced a complete Phase 4 plan (wrote it into `architecture.md`, validated the Mermaid render, presented a summary, asked to commit) after reading only two production files (`index.ts`, `handlers/permission-gate-handler.ts`) plus `fallow` metrics.
  Concluded "production is at a structural plateau" without reading `runtime.ts`, `permission-session.ts`, or a single test file.
  Impact: the entire findings table, step list, dependency diagram, and tracks were wrong and had to be rewritten (one large `Edit` replacing three blocks); the user had to write a substantial redirecting correction.
- `instruction-violation` (user-caught) — the `package-pi-permission-system` skill already says "When planning a refactoring that targets testability, read the test files alongside the production code" and "When planning a refactoring that touches handler wiring or shared interfaces, load the `design-review` skill to audit for structural smells before writing the plan."
  Neither was done before the first plan was written; `design-review` was never loaded at all.
  Impact: same rework as above.
  Because it was user-caught, the rule needs to be more salient at the point of use (the `plan-improvements` workflow), not just resident in the package skill.
- `wrong-abstraction` — trusted the architecture document's own narrative at face value, quoting its self-justification ("established injection-bag wiring kept inline per the anti-procedure-splitting rule") to rationalize *not* treating the `index.ts` closure bags as a finding.
  `fallow`'s clean metrics (avg cyclomatic 1.4, zero complexity targets) reinforced the false comfort.
  Impact: operated at "summarize the doc" level when "audit the doc's claims against the code and tests" was needed; compounded the premature-convergence failure.

#### What caused friction (user side)

- The user's redirection was a strong, correct strategic intervention ("tests tell us how difficult something is to use; helpers are a sign a fixture is hard to test — look at the production code: closures, function factories instead of easy-to-`new` dependencies").
  This is on the agent: the package skill already encoded the rule that would have prevented it, so the user could not reasonably have pre-empted the miss.
  The opportunity is to capture the user's heuristic ("test setup difficulty is a production-design signal") in the reusable workflow so it fires without a manual nudge.

### Diagnostic details

- **Unused-tool detection** — for the `missing-context` / `premature-convergence` failure, three available aids went unused: the `design-review` skill (explicitly recommended by the package skill for handler-wiring/shared-interface plans), the `Plan`/`Explore` subagents offered by the planning workflow (a fresh-context read of the test setup plus production wiring would likely have surfaced the god-object smell), and `colgrep` for an intent search such as "closures wrapping mutable shared runtime state."
  None was dispatched before the first plan was written.
- **Feedback-loop gap analysis** — no gap.
  This was a docs-only session; `lint:md` and `mmdc` were run after each roadmap write, incrementally, and both passed.
- **Escalation-delay and model-performance lenses** — nothing notable.
  No error loop occurred (the first analysis was a confident wrong conclusion, not a stuck retry), and no subagents were dispatched.

### Changes made

1. Added `.pi/prompts/plan-improvements.md` Step 4 "Read the tests as evidence of constructibility" (tests-as-evidence, no doc-self-justification at face value, load `design-review` for handler-wiring/shared-interface plans); renumbered the later steps.
2. Added two lessons to `.pi/skills/improvement-discovery/SKILL.md` ("Test setup is a production-design signal" and "Audit the architecture doc against the code").
3. Created this retro file, `packages/pi-permission-system/docs/retro/0334-phase-4-roadmap.md`.
4. Filed Phase 4 Steps 1-9 as issues [#334]-[#342] and linked the architecture roadmap back to them (step headings, Mermaid nodes, reference definitions).
5. Added a "File the issues" section to `.pi/prompts/plan-improvements.md` so the roadmap workflow files one issue per step and links the doc back — the step this session forgot until prompted.

[#334]: https://github.com/gotgenes/pi-packages/issues/334
[#342]: https://github.com/gotgenes/pi-packages/issues/342
