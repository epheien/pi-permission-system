---
status: accepted
date: 2026-07-04
---

# 0003 — Interpret POSIX-shaped bash tokens with Git Bash semantics on win32

## Status

Accepted.

## Context

On Windows, Pi core executes every bash tool command through Git Bash (`pi/packages/coding-agent/src/utils/shell.ts` resolves the shell as custom `shellPath` → `%ProgramFiles%\Git\bin\bash.exe` → any `bash.exe` on PATH; there is no cmd/PowerShell branch).
A bash token that looks like a POSIX absolute path therefore carries MSYS mount semantics, not native `node:path.win32` semantics.

Before this decision, the permission system normalized every bash token with `node:path.win32`, reinterpreting POSIX-shaped tokens as native Windows paths the shell never touches ([#533]):

- `/dev/null` became `c:\dev\null`, so the safe-device exclusion never matched and `echo hi > /dev/null` prompted — even though Pi core itself rewrites `> NUL` to `> /dev/null` before spawning Git Bash (`normalizeNulRedirects()`, [earendil-works/pi#4731]).
- `/tmp` became `C:\tmp`, so prompts displayed a fabricated path and a rule for the real `C:\tmp` could cross-match a Git Bash `/tmp` token.
- `/c/Users/x` became `C:\c\Users\x`, so a project file referenced through the MSYS drive mount was wrongly flagged external.

This contradicted the package's own documented contract that OS device paths are always excluded.

## Decision

On a win32 host, the **bash surface's** path semantics are MSYS, not win32.
The bash token pipeline classifies each POSIX-shaped absolute token (`msys-bash-tokens.ts`, consumed only by `PathNormalizer`) into a deterministic subset and interprets it accordingly:

| Token shape                                 | Interpretation                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `/dev/null`, `/dev/std{in,out,err}` (exact) | MSYS device — preserved verbatim, never external (matches the POSIX exclusion)              |
| `/c/…`, `/d/…` (drive mount)                | Translated to the Windows equivalent (`C:\…`), then resolved with win32 rules               |
| Other `/…` (POSIX absolute)                 | Literal-only external path — matched and displayed as typed, never fabricated into `C:\tmp` |
| `C:\…`, `C:/…`, relative, `~/…`             | Unchanged native win32 handling ([#508], [#382])                                            |

Tool-input paths (`read`/`write`/`edit`) keep native win32 semantics: Node's `fs` genuinely resolves `/dev/null` to `C:\dev\null` on Windows, so prompting for a tool-input `/dev/null` is correct (least privilege).

### Rejected alternatives

- **`cygpath` shell-outs / MSYS environment detection.**
  Rejected: non-deterministic (depends on which bash Pi core resolved and the ambient environment), slow, and it breaks the invariant that the same policy plus the same input always produces the same decision.
- **Mapping `/tmp` to `%TEMP%` / `os.tmpdir()`.**
  Rejected: the target varies by bash flavor (Git Bash mounts `/tmp` to `%TEMP%`, MSYS2 to its own root, Cygwin to another), so any concrete mapping is wrong for some installs and reads ambient host state.
  A literal-only external path is the honest deterministic treatment.

## Consequences

- Non-mount POSIX absolutes are always external on win32 and cannot resolve inside the working directory, so they always reach the `external_directory` gate — conservative by design.
- A win32 POSIX-absolute literal is matched and displayed exactly as typed (`/tmp/foo`), so a natural `external_directory` rule (`/tmp/*`) suppresses the prompt.
  This relies on the win32 path matcher folding separators on **both** the rule and the value ([#653]).
  It originally carried a backslash match alias (`\tmp\foo`) instead, because the fold reached only the rule pattern; that alias was removed once the fold became symmetric.
- `PathNormalizer` owns the win32/MSYS branching (`forBashToken`, `interpretBashCdTarget`, `isBoundaryOutsideWorkingDirectory`); the shape knowledge lives in the pure, separately-tested `msys-bash-tokens.ts`.
- The `PermissionsService` RPC path-query surface is unchanged: an external query for a POSIX-shaped path on win32 still answers with win32 semantics, since a path query carries no bash-surface context.
  This is an accepted inconsistency, to revisit only if a consumer reports it.

[#382]: https://github.com/gotgenes/pi-packages/issues/382
[#508]: https://github.com/gotgenes/pi-packages/issues/508
[#533]: https://github.com/gotgenes/pi-packages/issues/533
[#653]: https://github.com/gotgenes/pi-packages/issues/653
[earendil-works/pi#4731]: https://github.com/earendil-works/pi/issues/4731
