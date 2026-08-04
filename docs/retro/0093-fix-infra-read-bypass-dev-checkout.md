---
issue: 93
issue_title: "Infrastructure read bypass fails in local development checkout"
---

# Retro: #93 — Infrastructure read bypass fails in local development checkout

## Final Retrospective (2026-05-05T17:40:00Z)

### Session summary

Fixed `discoverGlobalNodeModulesRoot()` to fall back to `npm root -g` when the walk-up-from-self strategy finds no `node_modules` ancestor (dev checkout).
Shipped as v5.1.1 with 6 new tests.
The initial plan proposed a `createRequire` fallback that was empirically proven broken mid-session; the user's question about Bun compatibility triggered the investigation that caught the flaw before implementation.

### Observations

#### What went well

- The user's question about Bun/cross-runtime compatibility during the planning phase redirected the design before any broken code was written.
  This saved a full implement-test-debug-rewrite cycle.
  The resulting `npm root -g` subprocess fallback is simpler and more reliable than the original `createRequire` approach.
- The empirical verification approach — running `import.meta.resolve`, `createRequire`, and `process.argv[1]` walk-up in real scripts — built a clear compatibility matrix across Node.js global install, pnpm dev checkout, and Bun binary.
  This made the strategy decision evidence-based rather than speculative.
- The fix itself was clean and minimal: extract a `walkUpToNodeModules` helper, add a `discoverGlobalNodeModulesViaSubprocess` function, wire them in sequence.
  No API changes, no config changes, no schema changes.
- The fix immediately validated itself — the `ask-user` skill loaded without an external-directory prompt during the retro session, confirming the `npm root -g` fallback works from the dev checkout.

#### What caused friction (agent side)

- `premature-convergence` — The initial plan committed a `createRequire` fallback without empirical verification.
  `createRequire(import.meta.url).resolve('@mariozechner/pi-coding-agent')` resolves to the local `node_modules/.pnpm/...` devDependency, not the global root.
  Walking up from that path finds pnpm's internal `node_modules`, not `/opt/homebrew/lib/node_modules`.
  The plan was plausible on paper but wrong in practice.
  Impact: the plan was committed, then had to be fully rewritten after the user's Bun question triggered investigation — two plan commits instead of one, ~15 minutes of investigation and rewrite.
- `missing-context` — The plan's "Module-Level Changes" section listed `tests/external-directory.test.ts` for new tests and `tests/runtime.test.ts` as "no changes needed" but missed `tests/pi-infrastructure-read.test.ts`, which directly tests `discoverGlobalNodeModulesRoot`.
  When the subprocess fallback went live, three tests in that file started calling real `npm root -g` and getting real results instead of `null`.
  Impact: one extra commit (`082bde2`) to add `spawnSync` mocking to that file, plus a full-suite rerun to catch it.

#### What caused friction (user side)

- The user's Bun compatibility question was the critical intervention that saved the session from shipping a broken fix.
  This was strategic judgment at exactly the right moment — before implementation started.
  Without it, the `createRequire` approach would have been implemented, would have appeared to pass tests (since tests mock `discoverGlobalNodeModulesRoot` at the runtime level), and would have failed silently in the actual dev checkout scenario it was meant to fix.

### Changes made

1. Added empirical verification rule to `AGENTS.md` § Implementation Priorities for environment-dependent strategies.
