---
issue: 123
issue_title: "Support trailing wildcard optionality (`command *` matches bare `command`)"
---

# Retro: #123 — Support trailing wildcard optionality

## Final Retrospective (2026-05-08T04:55:00Z)

### Session summary

Implemented trailing wildcard optionality in `compileWildcardPattern` so that patterns ending with `*` (space + wildcard) also match the bare command.
The change was a 2-line regex transformation mirroring OpenCode's implementation exactly.
Shipped as v5.12.0 with 10 new tests and doc updates to `docs/opencode-compatibility.md` and `docs/configuration.md`.

### Observations

#### What went well

- TDD cycle was textbook: exactly 2 targeted failures in red, all 1291 tests green after the one-function change, zero downstream breakage.
- The change was surgically scoped — one function (`compileWildcardPattern`), one conditional, affecting all permission surfaces uniformly through the existing abstraction.
- Doc updates were comprehensive: moved the divergence to shared concepts, cleaned up the porting guide (removed duplicate bare-command entries and renumbered steps), and added a note to the bash surface section in `docs/configuration.md`.

#### What caused friction (agent side)

- `instruction-violation` (self-identified) — Used padded table style (`| Risk | Mitigation |`) in the plan file despite the `markdown-conventions` skill specifying compact/tight style with no cell padding.
  Caught by markdownlint MD060 on the first commit attempt.
  Impact: one failed commit, one extra edit call, minor time waste (~30s).
- `missing-context` — Attempted an 8-edit batch on `docs/opencode-compatibility.md` where edit 5 referenced step `5. **Add .env rules manually**` but step 4 was being removed by edit 4 in the same batch, shifting the original step 5 to `5. **Replace...`**`. Since all`oldText` matches run against the original file, edit 5 couldn't find its target.
  Impact: one failed edit call, one re-read of the file, one retry — added ~1 minute of friction but no rework in the final output.

#### What caused friction (user side)

- No user-side friction observed.
  The issue was thoroughly specified with prior art, risk assessment, and exact code snippets, which made the plan and implementation straightforward.
