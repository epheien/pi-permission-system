---
issue: 42
issue_title: "Extract event handlers from piPermissionSystemExtension into separate modules"
---

# Retro: #42 — Extract event handlers from piPermissionSystemExtension into separate modules

## Final Retrospective (2026-05-03T20:00:00Z)

### Session summary

Extracted all 6 inline event-handler closures from `piPermissionSystemExtension()` in `src/index.ts` into dedicated modules under `src/handlers/`.
Defined a `HandlerDeps` interface as a stepping stone toward the `ExtensionRuntime` context object in #43.
Added 80 new unit tests across 4 handler test files.
`src/index.ts` reduced from 1066 → 466 lines (56%); released as v3.7.0 with zero behavioral change.

### Observations

#### What went well

- **`shouldExposeTool` extracted as a pure function** in `src/handlers/before-agent-start.ts` (takes `PermissionManager` as a parameter, not a deps entry) — aligns with the target architecture's "pure evaluation, IO at the edges" principle and makes it independently testable.
- **Lean local payload interfaces** for handler event parameters (`SessionStartPayload`, `BeforeAgentStartPayload`, etc.) avoided coupling to full SDK event types and simplified test fixtures.
  The SDK does not export `ResourcesDiscoverEvent` at all, so this approach was necessary.
- **Helper relocation was a no-op step** — because `src/index.ts` was rewritten from scratch in the wiring step, `extractSkillNameFromInput`, `getEventInput`, and `getEventToolName` were never re-added.
  This collapsed steps 6 and 7 into a single commit.

#### What caused friction (agent side)

1. `missing-context` — SDK type mismatch hit late in step 6: `npm run build` revealed ~40 type errors across test files (missing `type` field on `SessionStartEvent`, `systemPromptOptions` on `BeforeAgentStartEvent`, wrong `InputSource` value `"user"`, nonexistent `matchedRule` field on `PermissionCheckResult`, Vitest `vi.fn` generic syntax, duplicate import alias).
   The `HandlerDeps` type used SDK event types that weren't checked against the actual SDK `.d.ts` until the full-wiring step.
   A single grep of the SDK exports during step 1 would have caught this.
   Impact: one compile-fix cycle with 6 distinct fixes; no rework to handler logic itself.
   Self-identified at the typecheck step.
2. `instruction-violation` — `vi.mock()` factory in `tests/handlers/lifecycle.test.ts` referenced `mockGetActiveAgentName` before initialization because the `vi.fn()` stub was not wrapped in `vi.hoisted()`.
   AGENTS.md says "extract each `vi.fn()` stub to a module-scope variable" but does not mention `vi.hoisted()`, and the existing rule is ambiguous about what "module-scope" means when `vi.mock()` factories are hoisted.
   Impact: one quick fix, no rework.
   Self-identified on the first red-phase test run.
3. `missing-context` — `isToolCallEventType("read", event)` checks `event.toolName`, not `event.name`.
   The skill-read gate test used `name: "read"` in the event fixture, causing the gate to silently not trigger.
   Fixed by adding `toolName: "read"` to the fixture.
   Impact: one test fix; no rework to handler code.
   Self-identified in the green phase of step 5.
4. `wrong-abstraction` — Plan's ≤200 line target for `src/index.ts` was structurally unreachable given the non-goals.
   Module-scope state, config save, permission polling, review/prompt helpers, and the deps object all require #43 to move.
   The plan should have set "≤500 lines" as the #42 target and "≤200 lines" as the post-#43 target.
   Impact: added friction at the end when verifying the target; documented as a deviation.
5. `missing-context` — `before-agent-start.test.ts` used `<available_tools>` XML-style tags in the system prompt fixture, but `sanitizeAvailableToolsSection` looks for a `"Available tools:"` section header.
   Impact: one test fixture fix.
   Self-identified in step 3 green phase.

#### What caused friction (user side)

- No significant friction.
  The plan was clear, the issue was well-scoped, and the user intervened only for the autoformat notifications.

### Changes made

1. Added `vi.hoisted()` guidance to `AGENTS.md` § Testing.
2. Added SDK event payload interface guidance to `AGENTS.md` § Code Style.
