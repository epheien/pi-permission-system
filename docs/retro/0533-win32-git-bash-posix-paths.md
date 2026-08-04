---
issue: 533
issue_title: 'Windows/Git Bash: POSIX paths like /dev/null and /tmp are normalized as C:\dev\null / C:\tmp'
---

# Retro: #533 — Windows/Git Bash: POSIX paths like /dev/null and /tmp are normalized as C:\dev\null / C:\tmp

## Stage: Planning (2026-07-04T00:00:00Z)

### Session summary

Researched Git Bash/MSYS path semantics before planning (the operator explicitly asked for research over a band-aid), confirmed direction via two `ask_user` rounds, and produced `docs/plans/0533-win32-git-bash-posix-paths.md`.
The plan introduces a bash-surface-only POSIX-token interpretation layer on win32: exact device paths preserved, `/c/` drive mounts translated, other POSIX absolutes handled as literal-only external paths.

### Observations

- **Decisive research finding:** Pi core always executes bash via Git Bash on Windows (`pi/packages/coding-agent/src/utils/shell.ts`), and core's `normalizeNulRedirects()` (pi#4731 / pi#4751) rewrites `> NUL` → `> /dev/null` on win32 before spawning the shell — so core actively produces the exact token this package mangles into `C:\dev\null`.
  This turned the issue from "special-case a path" into "the bash surface's platform is MSYS on win32".
- **Operator confusion resolved:** the prior win32 issues (#382 case folding, #508 drive-letter tokens) are *not* contradicted — they handle Windows-shaped tokens, which Git Bash also accepts; this change adds branches for POSIX-shaped absolute tokens that previously fell through into `win32.resolve()`.
- **Scope decisions (operator-confirmed):** full POSIX-token branch (not device-only); `/tmp` and other non-mount POSIX absolutes as literal-only external paths (deterministic; `external_directory` rules like `/tmp/*` match the typed form), explicitly rejecting `cygpath` shell-outs and `os.tmpdir()` mapping (bash-flavor-dependent, ambient state).
- **Design refinement during planning:** device recognition must be bash-surface-only, not in the shared normalization primitives — Node `fs` on win32 genuinely resolves `/dev/null` to `C:\dev\null`, so a *tool-input* `/dev/null` should keep prompting (least privilege).
  This forced the projection in `BashPathResolver` to derive the external decision from `AccessPath.boundaryValue()` (new `isBoundaryOutsideWorkingDirectory`) instead of re-normalizing the lexical string — a small structural improvement that removes a double derivation.
- **Latent bug found while planning:** `projectExternalPaths` dedups on `boundaryValue()`, which is `""` for every literal-only path — two distinct literal-only externals would collapse to one.
  The plan fixes the dedup key (`canonical || lexical`) in cycle 3.
- **Evidence for `fix:` classification:** `docs/configuration.md` line ~469 already promises "OS device paths (`/dev/null`, …) are always excluded" — current win32 behavior violates the package's own documented contract.
- Third-party issue (author `ThreeIce`); the `ask_user` direction gate was applied as required, and the operator's answers (not the issue body) drove the Goals.
- No follow-up issues filed — the deferred alternatives (cygpath, `%TEMP%` mapping) were declined, not deferred.

## Stage: Implementation — TDD (2026-07-04T19:05:00Z)

### Session summary

Implemented all 6 planned TDD cycles: `AccessPath.forDevice`, the pure `msys-bash-tokens.ts` classifier, `PathNormalizer.forBashToken`/`interpretBashCdTarget`/`isBoundaryOutsideWorkingDirectory`, the `BashPathResolver` projection/`foldCd` switch to `forBashToken`, gate-level integration, and docs (configuration, architecture, new ADR `0003`, skill).
Test count went from 2233 to 2283 (+50); `check`, root `lint`, `test`, and `fallow dead-code` all green; lockfile untouched.
Pre-completion reviewer returned PASS.

### Observations

- **Deviation 1 — `literalAliases` dropped from `path-normalization.ts`.**
  The plan added an optional `literalAliases` to `getPathPolicyValues`/`forPath` for drive mounts.
  An empirical probe (`wildcardMatch` with `{caseInsensitive, windowsSeparators}`) showed the win32 path matcher folds a rule's separators (`/` → `\`), so a forward-slash alias in a match value is unmatchable by any win32 pattern.
  For drive mounts the translation to `C:\…` already yields backslashes, so the alias was dead weight and was dropped.
  `path-normalization.ts` was left untouched.
- **Deviation 2 — cycle 5 became a `fix:`, not `test:`.**
  Gate-level integration exposed that a forward-slash `/tmp` literal value could not be allow-listed by any `external_directory` rule (same separator-folding cause).
  To honor the plan's scenario 3 (a `/tmp/*` allow rule suppresses the prompt) and the operator's stated intent, the win32 posix-absolute literal now carries a backslash **match alias** (`\tmp\foo`) while `value()` (display) stays as typed.
  `AccessPath.forLiteral` gained an optional `matchAliases` param (the alias mechanism the plan had placed on `forPath`, relocated to where it is actually load-bearing).
  Pinned end-to-end by a new `permission-manager-unified.test.ts` case (parse `ls /tmp` → matchValues → win32 manager + `/tmp*` allow → allow).
- **Test-assumption corrections during cycle 4:** a bare `cat x` token is not an external-directory path candidate, and a `cd` argument is itself collected as a candidate — so the cd-fold tests were rewritten to use parent-traversal tokens (`cat ../x`) that actually exercise the folded base.
- **One existing test intentionally updated:** `program.test.ts` win32 `cat /etc/hosts` flipped from `c:\etc\hosts` to the literal `/etc/hosts` — the intended behavior change (a non-mount POSIX absolute is install-root-relative in Git Bash, matched as typed).
- **Latent dedup bug fixed (cycle 3):** `projectExternalPaths` dedup key changed to `canonical || lexical` so two distinct literal-only paths no longer collapse on an empty boundary value.
- Pre-completion reviewer: PASS (no blocking or non-blocking findings beyond the two documented deviations, both test-covered).

## Stage: Final Retrospective (2026-07-05T15:26:26Z)

### Session summary

Shipped #533 end to end across plan → skill-doc → TDD (6 cycles) → ship: `pi-permission-system` `18.1.1` → `18.1.2`, five `fix:` commits plus docs, `+50` tests, pre-completion PASS, release-please PR #544 merged.
The arc was clean; the only rework traced to one planning gap and one prematurely-grounded `ask_user` round.

### Observations

#### What went well

- **Research-first planning turned a band-aid into a principled fix.**
  Reading the local `pi` checkout (`packages/coding-agent/src/utils/shell.ts`) to confirm Git Bash is always the win32 shell, and finding core's own `normalizeNulRedirects()`, reframed the issue from "special-case `/dev/null`" to "the bash surface's platform is MSYS on win32."
  This is the load-bearing insight the whole design rests on.
- **Empirical probe prevented a wrong abstraction from shipping (novel win).**
  In cycle 5, before committing to the backslash-alias design, a throwaway `wildcardMatch` test confirmed the win32 matcher folds a rule's separators (`/` → `\`) so a forward-slash value is unmatchable.
  Probing the actual matcher (rather than reasoning about it) located the alias correctly on `AccessPath.forLiteral` in backslash form in one shot.
- **Exemplary incremental verification.**
  Each TDD cycle ran red → green → `pnpm run check` (on shared-type changes) → full suite (on shared-projection changes) → commit; no end-of-session verification pile-up and no post-hoc fixup commits.

#### What caused friction (agent side)

- `missing-context` — the plan designed a `literalAliases`/match-alias mechanism (on `path-normalization.ts`/`forPath`) without probing the package's **own** win32 wildcard matcher (`pathMatchOptions` separator folding).
  Both TDD deviations trace to this single gap: the alias had to be dropped from `path-normalization.ts` (dead weight for drive mounts, which already yield backslashes) and relocated to `AccessPath.forLiteral` in backslash form for literal-only paths, and cycle 5 grew from `test:` to `fix:`.
  Impact: no wasted commits (caught by an empirical probe during TDD before implementing), but the plan's Module-Level Changes and one cycle's commit type were both inaccurate; two prior-cycle test assertions were updated in cycle 5.
- `instruction-violation` (self-identified at retro; user-caught in session) — the first `ask_user` direction gate offered options (device-only vs. full MSYS translation vs. decline) **before** researching Git Bash/MSYS mechanics, so the options were ungrounded.
  The operator bounced it ("I don't know enough about Git Bash/MSYS… research this before we propose"), which cost an extra `ask_user` round.
  The `ask-user` skill already says "gather evidence first from code/docs/tools"; the evidence gathered was the package code, not the external platform mechanics the direction options depended on.
  Impact: one extra decision round; no rework of artifacts.

#### What caused friction (user side)

- None material.
  The operator's early redirect ("research over a band-aid") and the mid-planning "I feel so confused" about the prior win32 issues were both productive — the latter surfaced a genuine reconciliation need (additive vs. contradictory) that strengthened the plan's framing.
  Both are examples of a redirecting question arriving at the right moment, not oversight friction.

### Changes made

1. `.pi/prompts/plan-issue.md` — added one sentence to the third-party `Decide` guidance: for an unfamiliar-domain issue, research the domain facts before the direction `ask-user` gate, since the direction options depend on them (an ungrounded ask gets bounced).
   Refs #533.
2. `packages/pi-permission-system/docs/retro/0533-win32-git-bash-posix-paths.md` — appended this Final Retrospective stage entry.
