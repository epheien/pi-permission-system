---
issue: 41
issue_title: "Extract a reusable permission-gate function to eliminate repeated deny/ask/allow branching"
---

# Retro: #41 — Extract a reusable permission-gate function

## Final Retrospective (2026-05-03T15:00:00Z)

### Session summary

Planned, implemented, and shipped a new `src/permission-gate.ts` module exporting `applyPermissionGate()` — a pure decision function that replaces five inline deny/ask/allow branches in `src/index.ts`.
Released as v3.3.0 with 14 new unit tests and no semantic changes to permission behavior.
The session executed cleanly across `/plan-issue`, `/tdd-plan`, and `/ship-issue` with no rework or user corrections.

### Observations

#### What went well

- The gate function's callback-injection design (`promptForApproval`, `writeLog`) kept it free of `ExtensionContext` coupling, making unit tests trivial — 14 tests with zero mocking complexity.
- Combining TDD steps 1–5 into a single commit was the right pragmatic call for a ~75-line pure function with independent branches.
  Each branch wasn't meaningfully testable without the module skeleton existing first.

#### What caused friction (agent side)

- `wrong-abstraction` — The plan estimated a ~150-line net reduction but the actual was 59 lines (1058 → 999).
  The `PermissionGateParams` construction at each call site adds ~20 lines per site × 5 sites = ~100 lines back.
  The plan counted lines removed but not lines added for param objects.
  Impact: no rework, but the plan's Goals section overpromised.
- `missing-context` — The plan's Risks section didn't flag log-schema widening as a risk category.
  The unified gate passes `...logContext` (including `message`) to deny log entries that previously omitted it.
  This was caught during implementation and documented in the commit body.
  Impact: added friction but no rework; the integration tests confirmed it was safe.

#### What caused friction (user side)

- Nothing — the session ran without user intervention beyond the initial `/plan-issue`, `/tdd-plan`, and `/ship-issue` invocations.

### Changes made

1. `docs/retro/0041-extract-permission-gate.md` — this file.
