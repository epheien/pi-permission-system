---
issue: 333
issue_title: "Permission prompt for chained bash commands only shows the triggering sub-command, hiding the rest of the chain from the user"
---

# Retro: #333 — Permission prompt for chained bash commands only shows the triggering sub-command, hiding the rest of the chain from the user

## Stage: Planning (2026-06-09T01:34:25Z)

### Session summary

Planned a localized bug fix for `formatAskPrompt` in `src/permission-prompts.ts`: the bash branch ignores the raw `input` and prompts only with the matched sub-command, hiding the rest of a chained command.
The plan appends a `(full command: '...')` suffix when the raw `input.command` differs from `result.command`, using the existing `toRecord` / `getNonEmptyString` helpers from `src/common.ts`.

### Observations

- The fix is fully isolated to one branch of one function; `input` is already forwarded by the call site in `src/handlers/gates/tool.ts` (`tcc.input`), so no wiring change is needed.
- Existing bash tests pass `input` as `undefined`, which normalises to `null` via `toRecord` + `getNonEmptyString` — they stay green and serve as the "no chain context" case.
- The `fullCommand !== subCommand` guard is the key behavior decision: it suppresses the suffix for single (non-chained) commands so prompts don't get noisier.
- No schema, config, README, or architecture-doc changes — behavior-preserving prompt-text fix, single TDD cycle (`fix:`).
- The issue's proposed code was treated as a spec only after confirming the referenced helpers exist and the call site already supplies `input`; no ambiguity remained, so `ask_user` was skipped.

## Stage: Implementation — TDD (2026-06-09T01:48:55Z)

### Session summary

Completed the single TDD cycle: added 6 new tests to `test/permission-prompts.test.ts` covering chain-present, no-chain, `undefined` input, missing `command`, empty `command`, and qualifier-ordering cases, then implemented the two-line bash-branch change in `src/permission-prompts.ts`.
Test count went from 23 to 29 in the target file, and from 1894 to 1900 across the full suite.
All deterministic checks (`check`, `lint`, `test`, `fallow dead-code`) passed before and after the change.

### Observations

- No deviations from the plan: the fix was exactly the two helpers + `fullCommandInfo` conditional described in Design Overview.
- Four of the six new tests were green immediately (the suppress-suffix cases); only the two `toBe` assertions exercising the suffix string were red — the minimal red set confirmed the right code path was untested.
- Pre-completion reviewer returned **PASS** with no warnings.

## Stage: Final Retrospective (2026-06-09T01:58:10Z)

### Session summary

Shipped a localized bug fix for issue #333 across three stages (planning, TDD, ship) in a single sitting: `formatAskPrompt`'s bash branch now appends the full chained command when it differs from the matched sub-command.
The work landed as `fix: surface full chained command in bash permission prompt (#333)` (`7f448fb6`), passed CI, closed the issue, and released `pi-permission-system-v10.7.1`.
Zero rework, zero deviations from the plan, and a clean pre-completion **PASS**.

### Observations

#### What went well

- The plan correctly judged the issue unambiguous and skipped `ask_user` — the issue body supplied a near-complete spec, and the planning stage verified the referenced helpers (`toRecord`, `getNonEmptyString`) and the `tcc.input` call site existed before trusting the proposed code.
  This pre-verification is why the TDD stage had no surprises.
- The red set was minimal and precise: of the 6 new tests, only the 2 exercising the suffix string were red, and the 4 suppress-suffix cases were green immediately against the unchanged code.
  This confirmed the new code path was the only untested behavior and that the existing branches were preserved.
- Mid-planning, the user asked for concrete before/after examples; the plan's design was specific enough to produce them directly without re-deriving anything — a sign the Design Overview captured the behavior crisply.
- Strong assertions: the suffix and qualifier-ordering tests used exact `toBe` on the full prompt string rather than `toContain`, pinning the exact layout the fix must not disturb.

#### What caused friction (agent side)

- None material.
  No corrections, no rework, no follow-up fix commits across all three stages.

#### What caused friction (user side)

- None.
  User involvement was light and well-timed (the before/after request during planning was a useful verification checkpoint, not a redirect).

### Diagnostic details

- **Model-performance correlation** — the session interleaved `anthropic/claude-opus-4-8`, `anthropic/claude-sonnet-4-6`, and `opencode-go/deepseek-v4-flash` across stage boundaries.
  Output quality stayed high throughout (clean plan, precise tests, no rework), so no mismatch surfaced for this small, well-specified change.
  Worth keeping an eye on whether the weaker model lands judgment-heavy turns on a more ambiguous future issue.
- **Feedback-loop gap analysis** — verification was incremental, not end-loaded: `pnpm run check` / `lint` / the target test file ran at the green-baseline gate, again after the red set, and again after the green implementation, with the full suite before commit.
  No gap.
- **Escalation-delay tracking** and **unused-tool detection** — no `rabbit-hole` or `missing-context` friction points, so both lenses are not applicable.

### Changes made

1. Appended this Final Retrospective stage entry to `packages/pi-permission-system/docs/retro/0333-bash-prompt-full-chain-context.md`.
   No `AGENTS.md` or `.pi/prompts/` changes — the session had no friction evidence to justify one.
