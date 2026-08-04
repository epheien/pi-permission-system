---
issue: 43
issue_title: "Eliminate module-scope mutable state and cached getAgentDir() in src/index.ts"
---

# Retro: #43 — Eliminate module-scope mutable state

## Final Retrospective (2026-05-03T19:04:00Z)

### Session summary

Replaced all module-scope mutable state in `src/index.ts` (cached `getAgentDir()` paths, mutable config, logger singletons, setter-injection functions) with an `ExtensionRuntime` context object created at factory invocation time.
`src/index.ts` went from 466 → 99 lines; `src/runtime.ts` (318 lines) now holds the runtime interface, factory, and all relocated helpers.
The forwarded-permissions IO module was also refactored to accept an explicit logger parameter instead of using a module-scope singleton.

### Observations

#### What went well

- The 7-step TDD sequence from the plan executed cleanly — each commit was independently valid and the full test suite stayed green throughout.
  The plan's decision to add `runtime` to `HandlerDeps` alongside the old stubs (step 3) before removing the stubs (step 4) allowed both phases to compile and test independently.
- The `createExtensionRuntime({ agentDir: tmpDir })` pattern immediately proved its value: 29 tests in `tests/runtime.test.ts` exercise the runtime in isolation without any `PI_CODING_AGENT_DIR` timing hacks.
- Forwarded-permissions logger threading touched 30+ call sites but landed in a single clean commit with no rework — the mechanical nature of "prepend logger parameter" made it safe to do in bulk.

#### What caused friction (agent side)

1. `missing-context` — Used `vi.fn(() => ({}))` to mock `PermissionManager` constructor in `tests/runtime.test.ts`.
   Arrow functions are not constructable, so `new PermissionManager()` threw `"() => ({}) is not a constructor"`.
   The same pattern caused friction in #42.
   Impact: 1 failed test run + 1 edit to fix; added friction but no rework beyond the immediate fix.
   Self-identified.

2. `missing-context` — Wrote `await import("../src/permission-manager")` inside non-async `it()` callbacks in step 2 tests for `createPermissionManagerForCwd`.
   Biome flagged `await` outside async function.
   Impact: 1 failed lint + 1 edit to switch to a static top-level import of the already-mocked `PermissionManager`.
   Self-identified.

3. `wrong-abstraction` — The plan's step 3 ("update test mocks") and step 4 ("update handlers + type") were described as sequential, but TypeScript rejects extra properties on typed object literals, so `runtime` couldn't be added to test mocks until `HandlerDeps` declared the field.
   The solution was to add `runtime` to `HandlerDeps` (with old stubs still present) in step 3, making the type change part of the same commit.
   Impact: minor plan deviation but no rework — the commit sequence remained valid.
   Self-identified.

#### What caused friction (user side)

- Nothing notable.
  The user provided a clear plan, and the session ran without corrections or redirections.

### Changes made

1. Added class-constructor mocking rule to `AGENTS.md` § Testing.
