---
issue: 111
issue_title: "refactor: narrow handler dependencies and runtime access"
---

# Retro: #111 — narrow handler dependencies and runtime access

## Final Retrospective (2026-05-07T03:00:00Z)

### Session summary

Decomposed the 18-field `ExtensionRuntime` god-object so that gate functions accept flat per-gate dep interfaces (7 leaf methods each) and handler tests use a 7-field `SessionState` instead of the full runtime.
The plan went through three revisions before landing — initial versions proposed rearranging bags rather than flattening them.
A batch `sed` approach to test migration caused a rollback mid-session.
Discussion after implementation led to filing #118 (gates as pure descriptor functions), which is a deeper improvement than the original plan.

### Observations

#### What went well

- The per-gate interface pattern worked cleanly — each gate migration was a self-contained commit, existing handler tests stayed green throughout, and the 4 gate test files became dramatically simpler.
- The user's pushback on the plan drove real design improvement: the first plan proposed sub-object bags (just smaller bags); the final plan delivered flat leaf methods.
  The discussion *after* shipping led to #118, which is architecturally sharper than anything in the plan.
- Phase 1 (gate interfaces) landed independently of Phase 2 (SessionState), so each phase was shippable alone.

#### What caused friction (agent side)

1. `wrong-abstraction` — The first two plan revisions proposed reorganizing production types (`RuntimePaths`, `RuntimeSessionState`, shared `GateDeps` bag) without examining the test files.
   The test files showed the real pain: 18-field `makeRuntime()` with `as unknown as` casts and 3-level-deep mock nesting.
   The production structure was what we were escaping, not what we should model the target on.
   Impact: two full plan rewrites before the user redirected to #114 and test-first thinking.
   User-caught.

2. `wrong-abstraction` — Used `sed` and shell loops to batch-rename `runtime` → `session` across 6 test files simultaneously.
   The `sed` after `session: makeSession` pattern-matched inside test *bodies* (not just helper factories), injecting promoted fields into assertion blocks and producing syntax errors.
   Required a full `git checkout --` rollback and per-file redo with the Edit tool.
   Impact: ~10 minutes of rework, 3 user interventions ("what is going on here?", "sorry, what is going on here?", "roll back").
   User-caught.

#### What caused friction (user side)

- The user had to redirect the plan twice before implementation started — once to look at tests ("you're looking at the production code, but you need to look at the tests") and once to point to #114.
  Earlier framing in the issue body or a convention in `AGENTS.md` about planning refactorings from test ergonomics would have avoided both redirections.

### Changes made

1. Added rule to `AGENTS.md` § Notes for Agents: when planning a refactoring for testability, read the test files alongside the production code — tests reveal consumption ergonomics.
