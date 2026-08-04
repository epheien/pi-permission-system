---
issue: 521
issue_title: "Is it possible to setup allow for all read-only commands?"
---

# Read-Only Bash Command Allowlist Recipe

## Release Recommendation

**Release:** ship independently

This is Phase 10, Step 6 of the package roadmap (`docs/architecture/architecture.md`), tagged `Release: independent`.
It is an unhidden `docs:` change, so it cuts its own release rather than batching.
No code changes and no dependency on the other Phase 10 steps.

## Problem Statement

The issue (filed by third-party `johnsyin-nextbe`, not the operator) asks two things:

1. Can the extension be configured to allow "all read-only commands" so it prompts less often — the author is willing to paste "a long config file that someone can share"?
2. Can a rule like `find *` be allowed while chained commands and `find -exec` still fall through to `ask`?

The operator has already scoped the answer in the roadmap: a documentation recipe, not a new runtime mechanism, per the package's "mechanism is forever; docs are reversible" and "keep config files the source of truth" principles.
The `ask-user` gate (run because this is a third-party issue) confirmed the direction: a single recipe in `docs/configuration.md` (no new shippable example file), with a **conservative** curated allowlist.

Question 2 is already fully implemented today — the recipe's job is to document it, not build it:

- `find`/`fd` carrying a per-result exec flag are indirection wrappers whose decision is floored from `allow` to `ask` (`<indirection-bash-wrapper>` sentinel, [#490]), so `find *: allow` cannot ride an `-exec` into a silent destructive run.
- A bash chain (`&&`, `||`, `;`, `|`, `&`, newline) decomposes into per-command units resolved most-restrictive, so `cat x && rm y` still prompts because `rm` is not allowed.

## Goals

- Add a **Read-Only Bash Command Allowlist** recipe to `docs/configuration.md`'s "Common Recipes" section.
- Curate a conservative allowlist of commands whose only effect is to read or report — commands that cannot create or modify a file, register, or system state by themselves.
- Document the four safety nets that keep such an allowlist safe (redirect gating, exec-flag floor, wrapper floor, chain most-restrictive), tying each to the relevant configuration behavior already documented elsewhere in the file.
- Explicitly answer the issue's `find *` + `-exec` + chains question inline in the recipe.
- Mark roadmap Phase 10, Step 6 complete in `docs/architecture/architecture.md` (both the step heading and its Mermaid node), in the same commit as the recipe.

## Non-Goals

- No new runtime mechanism (no `"readonly"` preset keyword, no built-in command classification) — a code-baked read-only list is a silent-allow bypass surface and violates "config files are the source of truth."
- No standalone `config/read-only-bash.example.json` — the `ask-user` answer chose the in-doc recipe only; copy-paste from the doc is the sharing mechanism.
- No change to the existing "Read-Only Mode" recipe (which gates *tools*: `read`/`grep`/`find`/`ls` allow, `write`/`edit` deny) — the new recipe covers the *bash* surface and is complementary.
- No broad convenience commands (`echo`, `printf`, `tee`, `sort`, `sed`, `awk`) — the operator chose the conservative set; these carry write vectors (redirect payloads, `-o`, `-i`) and are excluded with a one-line rationale.
- No README edit — `README.md` links to `configuration.md`'s recipes generically ("common recipes"), naming no individual recipe, so no section goes stale.

## Background

Relevant existing behavior in `docs/configuration.md`, all of which the recipe leans on and cross-references:

- **`bash` surface, last-match-wins**: patterns match each top-level command in a chain; a pattern ending in `*` also matches the bare command (`find *` matches bare `find`).
  Put the catch-all (`"*": "ask"`) first, allow rules after.
- **Chain decomposition / most-restrictive**: `cd /repo && npm install` evaluates both units; the most restrictive wins.
  Commands nested in substitutions/subshells are evaluated too.
- **Indirection-wrapper floor ([#490])**: `sudo`, `env`, `xargs`, `time`, `nohup`, `timeout`, `nice`, and `find`/`fd` with an exec flag are floored `allow` → `ask`.
- **Opaque-wrapper floor ([#481])**: `bash`/`sh`/`dash`/`zsh`/`ksh -c` and `eval` are floored `allow` → `ask`.
- **Redirect targets are a `path`-surface concern, not `bash`**: `echo secret > .env` writes via the `path`/`external_directory` gate; the bash-command pattern only gates the *command*, so a `path` deny on `*.env`/`~/.ssh/*` still catches the write target even when the command is allowed.

Constraint from AGENTS.md / the package skill: when the implementation completes a numbered roadmap step, mark it complete (`✅` on both the step heading and its Mermaid node) in the same doc-update commit — not deferred to ship.

## Design Overview

### Recipe placement

Insert a new `### Read-Only Bash Command Allowlist` subsection in the "Common Recipes" section of `docs/configuration.md`, immediately after `### Restricted Bash Surface` (currently ends near the `MCP Discovery Only` recipe).
It pairs naturally with the tool-level `### Read-Only Mode` recipe just above it — one gates tools, the other gates bash commands.

### The curated conservative allowlist

The recipe's config block sets `"*": "ask"` first, then allow rules for read-only commands.
The organizing principle stated in prose: **every listed command's only effect is to read or report; none can create or modify a file, register, or system state by itself.**

Grouped allow rules (final list refined at build time; this is the intended set):

```jsonc
{
  "permission": {
    "*": "ask",
    "write": "deny",
    "edit": "deny",
    "path": {
      "*": "allow",
      "*.env": "deny",
      "*.env.*": "deny",
      "~/.ssh/*": "deny"
    },
    "bash": {
      "*": "ask",

      // File inspection
      "cat *": "allow",
      "head *": "allow",
      "tail *": "allow",
      "less *": "allow",
      "more *": "allow",

      // Listing and metadata
      "ls *": "allow",
      "tree *": "allow",
      "stat *": "allow",
      "file *": "allow",
      "wc *": "allow",
      "du *": "allow",
      "df *": "allow",

      // Search (find/fd with -exec are auto-floored to ask)
      "grep *": "allow",
      "egrep *": "allow",
      "fgrep *": "allow",
      "rg *": "allow",
      "find *": "allow",
      "fd *": "allow",

      // Comparison and hashing
      "diff *": "allow",
      "cmp *": "allow",
      "comm *": "allow",
      "md5sum *": "allow",
      "sha1sum *": "allow",
      "sha256sum *": "allow",
      "cksum *": "allow",

      // System info
      "pwd": "allow",
      "whoami": "allow",
      "id": "allow",
      "hostname": "allow",
      "uname *": "allow",
      "date": "allow",
      "uptime": "allow",
      "ps *": "allow",
      "printenv *": "allow",
      "which *": "allow",
      "type *": "allow",

      // Git read-only subcommands (never a broad "git *")
      "git status": "allow",
      "git diff *": "allow",
      "git log *": "allow",
      "git show *": "allow",
      "git blame *": "allow",
      "git ls-files *": "allow",
      "git branch": "allow",
      "git remote -v": "allow"
    }
  }
}
```

### Design rationale documented in the recipe prose

1. **Why `git` is enumerated, never `git *`**: `git` has mutating subcommands (`commit`, `push`, `branch -D`, `remote add`, `config <k> <v>`).
   The recipe lists only read subcommands.
   Exact patterns (`git status`, `git branch`, `git remote -v`) match only their literal form, so `git branch -D feature` falls through to `"*": "ask"`.
   `*`-suffixed git patterns (`git diff *`, `git log *`) are safe because those subcommands are read-only regardless of arguments.
2. **Why `find *` / `fd *` are safe to allow (answers issue Q2)**: a bare `find`/`fd` search is read-only; the moment an exec flag appears (`-exec`/`-execdir`/`-ok`/`-okdir`, `fd -x`/`-X`), the indirection-wrapper floor ([#490]) clamps the decision to `ask`.
   So the destructive form always prompts even under `find *: allow`.
3. **Why chains still prompt (answers issue Q2)**: `find . -name '*.log' && rm -f found` decomposes; `rm` matches only `"*": "ask"`, and the most-restrictive result governs the whole invocation, so the chain prompts.
4. **The redirect caveat (the one real hole to warn about)**: allowing a read command allows the command, not a redirect it carries — `cat secret > out.txt` writes `out.txt` through the `path`/`external_directory` surface, not the bash surface.
   The recipe therefore ships with `write`/`edit` denied and a `path` deny block for sensitive files, and states plainly: keep the `path` surface locked down for anything you would not want an allowed read command to overwrite via `>`.
5. **Why `echo`/`printf`/`tee`/`sort`/`sed`/`awk` are excluded**: `echo`/`printf` are the usual content source for a write redirect; `tee` writes; `sort -o` and `sed -i`/`awk` redirects write in place.
   Excluding them keeps the allowlist to commands that never originate a write.
6. **Wrappers can't ride the allowlist**: `sudo grep …`, `env X=1 cat …`, `sh -c "…"`, `eval "…"` are floored to `ask` ([#481], [#490]), so the allowlist can't be smuggled past through a wrapper.

## Module-Level Changes

- `packages/pi-permission-system/docs/configuration.md` — add the `### Read-Only Bash Command Allowlist` recipe (config block + rationale prose + the four safety-net cross-references) to "Common Recipes", after `### Restricted Bash Surface`.
  Use reference-style prose that points at the already-documented `bash` chain/wrapper/redirect behavior rather than re-explaining it in full.
- `packages/pi-permission-system/docs/architecture/architecture.md` — mark Phase 10, Step 6 complete: `✅` on the `#### Step 6: Read-only bash allowlist recipe ([#521])` heading and on the `S6["Step 6 - Read-only allowlist recipe (#521)"]` Mermaid node; update the step's `Outcome`/status line to reflect the landed recipe.
  Verify no health-metric or target row references Step 6 as pending.

Grep confirmation performed during planning:

- `README.md` references `configuration.md` recipes generically (three links, no per-recipe name) → no README edit needed.
- No `src/` symbol, schema, or example config changes — this is a pure documentation addition, so the `src/`/schema/example alignment checklist does not apply.
- The `#521` roadmap reference already carries a `[#521]:` link definition in both `architecture.md` and the Phase 9 history file; no new link definitions needed there.

## Test Impact Analysis

Not applicable — documentation-only change, no code or test surface.
The behaviors the recipe describes ([#490] exec floor, [#481] wrapper floor, chain most-restrictive, redirect path-gating) are already covered by existing tests in the bash-command and path gates; the recipe adds no new behavior to test.

## Invariants at risk

None.
The change touches no code and no shared interface.
The recipe *documents* existing gate invariants (the exec/wrapper floors and chain decomposition); it does not alter them.
Accuracy is the only risk — mitigated by tracing each claimed behavior to its documented section and issue (see Design Overview rationale, each tied to [#481]/[#490] or the existing `bash`/`path` surface docs).

## Build Steps

This is a docs-only change, so `/build-plan` (not `/tdd-plan`) executes it.
Single commit — the recipe and the roadmap-completion marker land together (the skill requires the `✅` marker in the same commit as the work).

1. **Write the recipe** in `docs/configuration.md` (config block + rationale prose + safety-net cross-references), and mark roadmap Step 6 complete in `docs/architecture/architecture.md` (heading `✅`, Mermaid node `✅`, status line).
   Verify: `pnpm exec rumdl check packages/pi-permission-system/docs/configuration.md packages/pi-permission-system/docs/architecture/architecture.md` passes; the Mermaid node renders (per the `mermaid` skill's verification step); the config block is valid JSONC and every allow pattern is a genuinely read-only command.
   Commit: `docs(pi-permission-system): add read-only bash command allowlist recipe (#521)`.

## Risks and Mitigations

- **Risk: a listed command is not actually read-only** (a silent-allow bug shipped as a "safe" recipe).
  Mitigation: the conservative list contains only inspectors; each `git` entry is a specific read subcommand; `find`/`fd` rely on the documented exec floor; the build step's verify criterion requires confirming each pattern is read-only before commit.
- **Risk: a reader copies the recipe but leaves `path`/`write`/`edit` permissive**, so a redirect (`cat x > y`) writes silently.
  Mitigation: the recipe ships `write: deny`, `edit: deny`, and a `path` deny block inline, and the redirect caveat states the dependency explicitly rather than as a footnote.
- **Risk: the recipe drifts from the actual floor behavior** if [#490]/[#481] semantics later change.
  Mitigation: the recipe cross-references the existing `bash`-surface documentation (single source) rather than restating floor mechanics, so a future behavior change updates one place.
- **Risk: forgetting the roadmap `✅` marker**, splitting it from the work (the [#479]/[#480] failure mode).
  Mitigation: the single build step bundles the marker into the same commit as the recipe.

## Open Questions

None outstanding.
The direction (docs recipe, no example file, conservative breadth) and the two design ambiguities (artifacts, allowlist breadth) were resolved via the `ask-user` gate during planning.

[#481]: https://github.com/gotgenes/pi-packages/issues/481
[#490]: https://github.com/gotgenes/pi-packages/issues/490
[#479]: https://github.com/gotgenes/pi-packages/issues/479
[#480]: https://github.com/gotgenes/pi-packages/issues/480
