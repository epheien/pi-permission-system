---
issue: 418
issue_title: '[Bug] Even though "Allow" is configured, the permission system still prompts for confirmation on access requests'
---

# Retro: #418 — Even though "Allow" is configured, the permission system still prompts

## Stage: Planning (2026-06-17T14:17:37Z)

### Session summary

Diagnosed the reported false external-directory prompt as a symlink-vs-pattern-matching bug: both external-directory gates resolve `/tmp` → `/private/tmp` (the macOS symlink) before matching, so the user's `/tmp/*` pattern never hits.
The actual firing surface in the report is the **bash** gate (`toolName: "bash"`, `ls -la /tmp/`), driven by `BashProgram.externalPaths` returning the canonical path; the tool gate (`describeExternalDirectoryGate`) has the same defect via `canonicalNormalizePathForComparison` (whose own docstring says "not for pattern matching").
Produced a 6-step TDD plan that matches `external_directory` patterns against both the typed and the symlink-resolved forms as aliases, keeping the canonical path only for the outside-CWD boundary and infra-read checks.

### Observations

- This is a third-party issue (`lipaysamart`); ran the `ask_user` direction gate.
  Operator chose **fix it** and **match both typed and resolved forms** (not lexical-only).
- Deliberately reused the existing resolver surface by adding an optional `surface` param to `resolvePathPolicy`/`checkPathPolicy` rather than adding a new method — architecture.md lines 594–595 flag resolver-surface widening as a risk, and `evaluateAnyValue` (last-match-wins across aliases) is already wired for `PATH_SURFACES`, so the alias mechanism is free.
- Kept `BashProgram.externalPaths(): string[]` shape (value semantics change canonical → lexical, dedup identity stays canonical) to avoid churning its 29 test references; most use synthetic non-existent paths where `canonicalizePath` no-ops.
- Flagged the #393 false-green risk: the gates now resolve through `checkPathPolicy`, so `makeHandler` must route the `external_directory` surface onto `checkPathPolicy` or `makeSurfaceCheck`-driven tests silently pass `allow`.
  The step-5 real-instance acceptance test (real tmpdir symlink) is the backstop.
- Noted a security upside worth keeping in the commit body: the fix also closes a silent-allow hole where a symlinked **deny** (`/tmp/*: deny`) previously fell through to the `*` fallback.
- The tool gate gains a `resolver` parameter (mirroring `describePathGate`); its `input` becomes `{}` and it carries a `preCheck`, like the bash gate already does.
- Distinct from #413 (docs-only discoverability of the `external_directory` allow-list): #418 is a genuine matching bug where the right surface and pattern were already configured.

## Stage: Implementation — TDD (2026-06-17T14:53:29Z)

### Session summary

Implemented the fix across 6 commits (the plan's 6 TDD steps), though steps 3 and 4 were merged into one `fix:` commit (see Observations).
The full suite went from 2003 to 2015 tests (+12, +1 new acceptance test file); `pnpm run check`, `pnpm run lint`, and `pnpm fallow dead-code` are all clean.
Both external-directory gates now match a path's typed and symlink-resolved aliases on the `external_directory` surface, fixing the reported `/tmp/*` false prompt while keeping the canonical path for the outside-CWD boundary.

### Observations

- **Steps 3 and 4 merged.**
  The plan listed the bash gate (step 3) and tool gate (step 4) as separate commits, but the `external-directory-session-dedup` test couples them: a bash command approves a directory for the session, then a `read` must reuse that approval.
  Because step 3 moved the bash approval pattern from the canonical (`/private/tmp/*`) to the lexical (`/tmp/*`) namespace, the tool gate had to move to the same namespace in the same commit or the cross-tool dedup test would fail with a green suite.
  Folded both into one `fix:` commit with the rationale in the body.
- **#393 false-green bit twice.**
  Two integration tests (`external-directory-session-dedup.test.ts`, `tool-call.test.ts`) and the dedup shutdown test silently passed `allow` once the gates routed through `checkPathPolicy`.
  Fixed by threading the `surface` arg through `makeHandler`'s `checkPathPolicy` dispatcher, and by adding a delegating `checkPathPolicy` mock to the two inline handlers in the dedup test that override `permissionManager.checkPermission` directly (not via the session bag).
  The full suite — not the edited file — was the only thing that caught these, exactly as the package skill warns.
- **Acceptance test fixture artifact.**
  The real-symlink acceptance test's "allow keyed on the resolved path" case initially failed on macOS because `mkdtemp` returns an unresolved `/var/folders/...` path while `realpathSync` resolves `/var` → `/private/var`.
  Fixed by keying that one config pattern on `realpathSync(realDir)`.
  The typed-path and bash cases needed no such adjustment.
- **No new resolver method.**
  Generalized the existing `resolvePathPolicy`/`checkPathPolicy` with an optional `surface` param (default `"path"`) rather than adding a method, honoring the architecture's resolver-surface-widening risk note.
  `gate-fixtures.ts` needed no change — its `vi.fn<ScopedPermissionResolver["resolvePathPolicy"]>()` stubs picked up the new optional param automatically.
- **Pre-completion reviewer: PASS** — all deterministic checks green, docs/architecture/SKILL alignment verified, Mermaid diagrams validated, cross-step invariants (#352, #393, bash config-deny, canonical boundary) confirmed test-pinned.
  No WARN findings.

## Stage: Final Retrospective (2026-06-17T15:07:00Z)

### Session summary

Shipped the #418 fix end-to-end in one continuous session: plan → a mid-stream architecture design exchange → 6-step TDD implementation → ship (released `pi-permission-system` 13.2.0).
Both external-directory gates now match a path's typed and symlink-resolved aliases, fixing the reported `/tmp/*` false prompt; the full suite grew 2003 → 2015 and the pre-completion reviewer returned PASS.
The session also produced durable roadmap documentation: #418 was registered in `architecture.md` as the access-path probe for the deferred access-intent extraction.

### Observations

#### What went well

- **Architecture breadcrumb from a mid-stream question.**
  The user's "are there architectural improvements that would make this easier" question (between planning and TDD) surfaced the path-representation conflation as the root smell and connected it to the existing access-intent roadmap item.
  "Bolster the documentation with this issue" turned that insight into a persistent breadcrumb (`architecture.md` § Remaining design work now cites both #393 and #418).
  A future session inherits the structural framing for free — a novel, durable win beyond the bug fix itself.
- **Real-symlink acceptance test.**
  `external-directory-symlink-acceptance.test.ts` exercises the fix through a real `symlinkSync` + real `PermissionManager`/`PermissionResolver`, not a mocked `realpathSync`.
  This is the backstop the plan promised for the #393 false-green class and it caught the macOS `/var` → `/private/var` nesting subtlety.
- **Full suite as the false-green backstop.**
  Running the full suite (not just edited files) after the shared-helper change caught three silent-allow regressions the edited test file alone would have passed — exactly the failure mode the package skill warns about.

#### What caused friction (agent side)

1. `missing-context` (planning) — the plan split the bash gate (step 3) and tool gate (step 4) into separate commits, but they share the session-approval namespace: step 3 moved the bash approval pattern from the canonical to the lexical form, so the cross-tool dedup test (bash approves, `read` reuses) could not pass until the tool gate moved too.
   The plan noted the namespace coupling in prose but did not translate it into step ordering.
   Impact: steps 3 and 4 merged into one `fix:` commit mid-TDD; no rework beyond the merge, caught immediately by the full suite.
2. `missing-context` (planning) — the plan flagged the #393 false-green risk and named `makeHandler` routing, but missed the two *inline* test handlers that mock `permissionManager.checkPermission` directly (bypassing the session bag and `makeHandler`'s dispatcher).
   Impact: two extra test-helper edits discovered via full-suite failures during TDD; low rework (the suite caught them), and the gap is now documented in the package skill.
3. `instruction-violation` (self-identified, recurring) — used a non-existent `oldText2`/`newText2`/`oldText3` shorthand on the `Edit` tool three times (steps 1, 3, 4) instead of separate `edits[]` entries, despite the system-prompt rule to use one call with multiple `edits[]` entries.
   Impact: three rejected `Edit` calls, each retried immediately; no downstream rework, but the same mechanical slip recurred rather than being learned after the first rejection.
4. `missing-context` — the acceptance test's "allow keyed on the resolved path" case failed once because `mkdtemp` returns an unresolved `/var/folders/...` path while `realpathSync` resolves `/var` → `/private/var`.
   Impact: one test iteration; fixed by keying that pattern on `realpathSync(realDir)`.

#### What caused friction (user side)

- None.
  The third-party direction gate (`ask_user`: fix + match both forms) and the mid-stream design question were both well-timed and moved the work forward; the latter produced durable documentation value rather than a correction.

### Diagnostic details

- **Model-performance correlation** — the `pre-completion-reviewer` subagent ran on `anthropic/claude-sonnet-4-6` (its frontmatter alias), appropriate for a deterministic-check-plus-judgment-checklist review; no mismatch.
  The main session ran mostly on `anthropic/claude-opus-4-8` (judgment-heavy planning, design, and architecture work) with one `claude-sonnet-4-6` segment; no high-cost-on-mechanical or reasoning-weak-on-judgment mismatch surfaced.
- **Feedback-loop gap analysis** — verification ran incrementally: each TDD step ran its affected test file, `pnpm run check` ran after every shared-interface change before committing, and the full suite ran after step 3 (the shared-helper change), which is what caught the three #393 false-green regressions.
  No end-only verification gap.
- **Escalation-delay / unused-tool** — no `rabbit-hole` friction; no sequence exceeded a couple of tool calls on the same error, so no subagent-dispatch or tool-gap finding.

### Changes made

1. `.pi/skills/testing/SKILL.md` — added a rule under `### Step sequencing and breakage` (after the "moves *when* a value becomes available" rule): a step changing the *format* of a runtime-recorded value replayed by a different consumer must fold every producer and consumer of that namespace into one commit, since only a cross-consumer runtime test catches the mismatch.
   Generalizes the steps-3/4 session-approval-namespace coupling from this session.
2. `packages/pi-permission-system/docs/retro/0418-external-directory-symlink-pattern-matching.md` — this Final Retrospective stage entry.
