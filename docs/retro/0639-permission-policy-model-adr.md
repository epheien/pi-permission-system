---
issue: 639
issue_title: "pi-permission-system: decide the permission policy model — capabilities, config shape, prior art (ADR 0009)"
---

# Retro: #639 — decide the permission policy model (ADR 0009)

## Stage: Planning (2026-02-14T00:00:00Z)

### Session summary

This session began as `/plan-issue` for [#609] (third-party, `hcrosse`: govern bash output redirects separately from the command) and deliberately widened.
Successive `ask_user` gates moved the operator from a wrapper-style `ask` floor, through path-surface routing, through a `path_read`/`path_write` capability-facet design, to the decision that the permission policy model itself deserves a deliberative ADR with nothing locked down — including the current config format.
Filed [#639] as the dedicated ADR issue (the [#581]/[#591] precedent), committed plan `docs/plans/0639-permission-policy-model-adr.md`, and left [#609] open to be re-planned after the ADR lands.

### Observations

- Key technical findings from [#609] exploration, needed by the eventual implementation: `BashProgram.commands()` strips redirects from command text; `collectRedirectTokens` gathers targets but they are shape-filtered like any token, so a bare in-cwd target (`> out.txt`) is not a rule candidate today; tree-sitter `file_redirect` nodes expose the operator as an anonymous child (`>`, `>>`, `&>`, `>&`) plus an optional `file_descriptor`, and a `>&`-to-`number` form (`2>&1`) is an fd-duplication, not a file write; `<> rw.txt` parses with an `ERROR` node.
- Operator's decision criteria, stated verbatim: clarity, simplicity ("straightforward, avoiding complex calculus of interactions between rules, and ambiguity"), user-first.
  The "calculus of interactions" phrase puts the most-restrictive multi-surface lattice itself on the table — the plan's option O6 (single ordered rule list) exists for that reason.
- Leanings recorded but explicitly reopened by the operator: `path_read`/`path_write` naming over `fs.*`; shipped `ask` default for redirect writes (breaking, `feat!:`); the effect-centered sketch (structural proof + command-effects knowledge base + explicit unknowns) as one candidate, not the target.
- Nesting facets under `path` was analyzed and found grammatically ambiguous (`path: { "read": "allow" }` already means a file literally named `read`; `denyWithReason` object values collide with a map-valued discriminator) — the analysis should ride into the ADR.
- Prior-art naming survey done in-session (Node `--allow-fs-read`/`--allow-fs-write`, Landlock `ACCESS_FS_*`, Seatbelt `file-read*`, Deno, WASI, systemd); the full survey with citations is Build Order step 1.
- Process note: the operator answered only part of some `ask_user` gates and asked follow-up questions in the notes — treating each partial answer as a redirection (not re-asking the same question) kept the conversation productive.
- The `/build-plan` session must run survey → `ask_user` decision gates → prose, in that order; the [#581] revert (transcription instead of deliberation) is the named failure mode.

[#581]: https://github.com/gotgenes/pi-packages/issues/581
[#591]: https://github.com/gotgenes/pi-packages/issues/591
[#609]: https://github.com/gotgenes/pi-packages/issues/609
