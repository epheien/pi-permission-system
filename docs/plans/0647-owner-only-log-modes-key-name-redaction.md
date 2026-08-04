---
issue: 647
issue_title: "pi-permission-system: permission review logs may persist secrets with inherited file modes"
---

# Owner-only log file modes and key-name redaction

## Release Recommendation

**Release:** ship independently

No roadmap step in `packages/pi-permission-system/docs/architecture/architecture.md` references [#647], and the doc carries no `Release:` batch annotations at all — the flat phase list was slimmed out in [#601].
The change lands as `fix:` commits, which cut a patch release for `@gotgenes/pi-permission-system` at ship time.

## Problem Statement

[#647] is a third-party report from `marcoscale98` against release `pi-permission-system-v20.10.0`.
It makes three claims about the permission review log, which is enabled by default:

1. Bash decisions persist the complete command string.
2. Generic tool decisions persist a serialized input preview up to the configured log limit.
3. Log files are appended without an explicit mode, so their permissions follow the process umask.

All three are accurate.
Measured on the operator's own machine at planning time, `~/.pi/agent/extensions/pi-permission-system/logs/pi-permission-system-permission-review.jsonl` is 6.7 MB across 8380 lines with mode `-rw-r--r--` (0644) — world-readable on a shared host.

The report proposes two remedies: redact common secret forms before persistence, and create the files owner-only.
Because the issue is third-party, the proposal was treated as a request to evaluate rather than a spec.
An `ask_user` gate established the direction: the file-mode hardening lands as proposed, and the log-content half lands as **key-name masking only** — the boring, standard, zero-maintenance technique — with value-shape secret detection explicitly declined.

## Goals

- Both JSONL logs and the logs directory are created owner-only (`0600` / `0700`), and an already-created log inherited from an earlier version is tightened on next write.
- Permission-forwarding request and response JSON files are created owner-only, and their directories `0700`.
- A value bound to a sensitive **key name** is masked with `[redacted]` before it is persisted to either log stream, including the `toolInputPreview` field that carries a generic tool's serialized input.
- The permission **ask-prompt** continues to display the unredacted input — the user must see what is actually being run to make a permission decision.
- The reasoning, the threat model, and the declined alternatives are recorded as ADR 0010 so the next reporter's identical issue can be triaged against a written contract.
- No new configuration field is introduced.

This change is **not** breaking.
The file-mode change tightens permissions on a diagnostic artifact with no documented consumer contract.
The redaction changes the content of that artifact, but the docs have never guaranteed verbatim payloads, and the masked values are precisely the ones no consumer has a legitimate need to read.
The commits are `fix:`, not `fix!:`.

## Non-Goals

- **Value-shape secret detection is declined, not deferred.**
  No `sk-`/`ghp_`/`AKIA`/`Bearer` prefix list, no entropy heuristic, no regex over the serialized line.
  ADR 0010 records why; see Design Overview.
- **Redacting the bash `command` field is out of scope.**
  A command string has no keys, so key-name masking cannot reach it.
  The grammar-anchored alternative (masking the value side of a `variable_assignment` in the existing tree-sitter parse) was costed and declined for this issue; it is recorded in ADR 0010 as the option a future report would reopen, not as filed work.
- **No `registerLogRedactor` downstream seam.**
  A fourth registry mirroring `ToolInputFormatterRegistry` / `ToolAccessExtractorRegistry` / `AuthorizerRegistry` would ship with zero consumers, which is exactly what the package's maintenance-trap rule targets.
- **`config-store.ts` config writes keep their current mode.**
  The saved `config.json` holds permission policy, not secret payloads.
  It was offered in the direction gate and deliberately not selected.
- **The forwarding request/response payloads are not redacted**, only mode-restricted.
  The parent reads those files to render the ask-prompt, so masking them would break the prompt the same way masking the prompt path would.
- No change to `permissionReviewLog`'s default, and no new `logToolInput`-style opt-in.

## Background

### Where the payload comes from

`ToolPreviewFormatter.getPermissionLogContext` (`src/tool-preview-formatter.ts`) builds four fields for every review entry: `command`, `target`, `toolInputPreview`, `origin`.
The `toolInputPreview` value for a non-path-bearing tool comes from `formatGenericToolInputForLog`, which calls `serializeToolInputPreview` (`src/tool-input-preview.ts`) → `safeJsonStringify` (`src/logging.ts`) and truncates at `TOOL_INPUT_LOG_PREVIEW_MAX_LENGTH` (1000).

The critical structural fact: **the tool input is flattened to a string before it reaches the logger.**
`PermissionPrompter.writeReviewEntry` (`src/authority/permission-prompter.ts:135`) hands `logger.review` a record of flat scalars, and `toolInputPreview` is already `"input {\"authorization\":\"Bearer …\"}"` by then.
So a redaction pass applied only at the log-write boundary would **not** catch the reporter's own repro.
Redaction has to happen while the input is still an object.

That gives two application points, and the plan uses both:

- `formatGenericToolInputForLog` — the only place the generic tool input is still structured.
- `writeLine` in `src/logging.ts` — the persistence choke point, covering both streams and any future call site that logs a nested object.

### Where the files come from

- `src/logging.ts` `writeLine` calls `ensureLogsDirectory()` then `appendFileSync(path, line, "utf-8")` — no mode on either.
- `src/extension-config.ts` `ensurePermissionSystemLogsDirectory` calls `mkdirSync(logsDir, { recursive: true })` — no mode.
- `src/authority/forwarding-io.ts` `ensureDirectoryExists` calls `mkdirSync(path, { recursive: true })`, and `writeJsonFileAtomic` calls `writeFileSync(tempPath, …, "utf-8")` then `renameSync`.
  `rename` preserves the temp file's mode, so setting the mode at temp-file creation is sufficient there — no chmod needed.

`ForwardedPermissionRequest` (`src/authority/permission-forwarding.ts:109`) carries `message`, `surface`, and `value` — the flattened display strings the parent renders — so these files hold the same command text as the log.

### Constraints from AGENTS.md and the package skill

- Do not read `process.platform` inside `src/`; an ESLint `no-restricted-syntax` guard blocks it and only `index.ts` is exempt.
  The design therefore performs **no platform branching** — `chmod` is attempted unconditionally and its failure is swallowed.
- Do not park session-scoped mutable state at module level; it now persists across same-cwd session switches.
  The "already hardened this session" set lives in the `createPermissionSystemLogger` closure, which is rebuilt per session.
- CI runs `ubuntu-latest` only (`.github/workflows/ci.yml`), so POSIX mode assertions in tests are safe.

## Design Overview

### Why key names and not value shapes

The direction gate was settled against measured evidence from the live 6.7 MB review log:

| Probe                                                        | Hits | What they actually are                                                                                                                                                    |
| ------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sk-`                                                        | 403  | 356 `task-approval`, 275 `task-user`, 146 `task-no-ui` — substrings of `task-*`. The 4 genuine `sk-ant-oat…` shapes are inside a grep pattern the agent typed, not a key. |
| `xox`                                                        | 2    | Inside the tool-use id `toolu_01VdGtvuHfmxox86kCCkY3`.                                                                                                                    |
| `API_KEY`                                                    | 8    | The literal env-var **name** `ANTHROPIC_API_KEY` in grep commands; no value.                                                                                              |
| `Bearer `, `ghp_`, `github_pat_`, `AKIA`, `AIza`, `password` | 0    | —                                                                                                                                                                         |

Anchoring would fix those specific false positives, but the corpus also contains **zero true positives**, so the shape list would be pure maintenance burden with an unstatable failure boundary.
A redactor that silently misses a key is worse than a documented warning, because it invites treating the log as safe to share.
This mirrors the stance already recorded for [#599] / ADR 0007, where a hard-coded secret denylist was declined because the codebase has no formal secrets model.

Key-name masking has the opposite profile: it is structural rather than predictive, so it has no false-positive tail worth worrying about (a key literally named `password` holding a non-secret is not a real concern), and it has a boundary statable in one sentence.
It is also what the logging ecosystem actually ships — pino's `redact`, Winston's format pipeline, and Serilog's destructuring policies are all declarative key-path masking, not detection.

Decisively, it catches the reporter's literal repro: their step 2 is a generic tool call with a field `authorization: "Bearer TEST_VALUE"`, and that field is a real object key at the moment `formatGenericToolInputForLog` runs.

### Module shape

Step 1 is a preparatory tidy.
`safeJsonStringify` currently lives in `src/logging.ts` but is imported by `src/tool-input-preview.ts` for **prompt** serialization, which has nothing to do with logging.
Extracting it makes the change easy: the redacted variant then has an obvious home, and the two test files that mock `#src/logging` to get at it have to move their mock target anyway.

```typescript
// src/json-safe-stringify.ts — extracted in step 1
type ReplacerTransform = (key: string, value: unknown) => unknown;

/** Shared replacer: Error → plain object, bigint → string, cycles → "[Circular]". */
export function createJsonSafeReplacer(
  transform?: ReplacerTransform,
): (key: string, value: unknown) => unknown;

export function safeJsonStringify(value: unknown): string | undefined;
```

```typescript
// src/log-redaction.ts — new in step 2
export const REDACTED_PLACEHOLDER = "[redacted]";

/** True when a log key names a credential-bearing value. */
export function isSensitiveLogKey(key: string): boolean;

/** `safeJsonStringify` with sensitive-keyed values masked. */
export function redactedJsonStringify(value: unknown): string | undefined;
```

The transform is a **predicate collaborator**, not a boolean flag, so the two entry points share one traversal without threading a discriminator.
Masking inside the replacer means the nested structure below a sensitive key is never visited, and the existing `WeakSet` cycle guard is reused unchanged — no second walk, no separate cycle handling.

The key set is fixed and narrow: `authorization`, `api_key` / `apiKey` / `api-key`, `secret`, `token`, `password`, `passwd`, `credential`, `cookie`, `private_key` / `privateKey`.
Matching is case-insensitive and substring-based **within the key only**, so `ANTHROPIC_API_KEY` and `x-api-key` both match.
A `null` or `undefined` value is left alone rather than replaced with the placeholder, so an absent field does not read as a suppressed one.

```typescript
// src/log-file-permissions.ts — new in step 4
export const OWNER_ONLY_FILE_MODE = 0o600;
export const OWNER_ONLY_DIRECTORY_MODE = 0o700;

/**
 * Best-effort tightening of an existing path's mode. Never throws:
 * on Windows `chmod` only toggles the read-only bit and may reject a
 * directory outright, and a hardening failure must not break the gate.
 */
export function restrictExistingPathToOwner(path: string, mode: number): void;
```

### Consumer call sites

The logger closure gains one small piece of per-session state so the upgrade-path `chmod` runs once per file rather than once per line:

```typescript
// src/logging.ts — inside createPermissionSystemLogger
const hardened = new Set<string>();

// inside writeLine, after a successful append:
appendFileSync(path, `${line}\n`, { encoding: "utf-8", mode: OWNER_ONLY_FILE_MODE });
if (!hardened.has(path)) {
  hardened.add(path);
  restrictExistingPathToOwner(path, OWNER_ONLY_FILE_MODE);
}
```

The `mode` option applies only when `appendFileSync` creates the file, which is why the `chmod` is needed at all — the operator's existing 6.7 MB log would otherwise stay 0644 forever.
The directory is handled inside `ensurePermissionSystemLogsDirectory`, which is stateless and already called on every write; it gains a `mode` on `mkdirSync` plus an unconditional `restrictExistingPathToOwner`, trading one syscall per log line for not needing a second piece of closure state.

### Edge cases

- `mkdirSync(logsDir, { recursive: true, mode })` applies the mode to every directory it **creates**, so on a fresh install `~/.pi/agent/extensions/pi-permission-system/` also becomes `0700`.
  That is desirable — it holds `config.json`.
  Directories that already exist are untouched, so `~/.pi/agent` is never modified.
- `mode` is masked by the process umask at creation.
  `0600 & ~0022` is still `0600`, so a default umask is harmless, and the `chmod` covers any umask that would have widened it.
- A `chmod` failure is swallowed with no user-facing warning.
  On Windows the call is a near-no-op and could otherwise emit a benign warning every session; the log there is governed by NTFS ACL inheritance, which this change does not attempt to manage.
  ADR 0010 states that explicitly rather than leaving it implied.
- A path-bearing tool's log preview goes through `formatToolInputForPrompt`, which produces human-readable summaries with no JSON, so redaction is a no-op there — except for a custom formatter registered via `ToolInputFormatterRegistry`, whose output is an opaque string this change cannot mask.
  Noted in the ADR as a residual.
- `writeJsonFileAtomic` writes to `${filePath}.${pid}.${now}.tmp` and renames.
  Setting the mode at `writeFileSync` is sufficient because `rename` preserves it, and a response file overwritten later goes through a fresh temp file.

## Module-Level Changes

### New files

- `packages/pi-permission-system/src/json-safe-stringify.ts` — `createJsonSafeReplacer` + `safeJsonStringify`, moved out of `logging.ts`.
- `packages/pi-permission-system/src/log-redaction.ts` — `REDACTED_PLACEHOLDER`, `isSensitiveLogKey`, `redactedJsonStringify`.
- `packages/pi-permission-system/src/log-file-permissions.ts` — mode constants + `restrictExistingPathToOwner`.
- `packages/pi-permission-system/test/json-safe-stringify.test.ts` — characterization tests for the moved behavior (cycles, `Error`, `bigint`), which no test covers today.
- `packages/pi-permission-system/test/log-redaction.test.ts` — key predicate + masking, including the nested and array cases and the `null`-value guard.
- `packages/pi-permission-system/test/log-file-permissions.test.ts` — mode tightening on an existing file and directory; a nonexistent path does not throw.
- `packages/pi-permission-system/docs/decisions/0010-permission-log-secret-exposure.md` — ADR 0010.

### Changed files

- `src/logging.ts` — drops `safeJsonStringify` (re-homed); `writeLine` serializes with `redactedJsonStringify`, appends with `mode: OWNER_ONLY_FILE_MODE`, and tightens the file once per session via a closure-held `Set`.
- `src/extension-config.ts` — `ensurePermissionSystemLogsDirectory` passes `mode: OWNER_ONLY_DIRECTORY_MODE` to `mkdirSync` and calls `restrictExistingPathToOwner`.
- `src/tool-input-preview.ts` — imports `safeJsonStringify` from the new module; gains `serializeRedactedToolInputPreview`.
- `src/tool-preview-formatter.ts` — `formatGenericToolInputForLog` switches to `serializeRedactedToolInputPreview`; `formatJsonInputForPrompt` is left on the unredacted path deliberately.
- `src/authority/forwarding-io.ts` — `ensureDirectoryExists` passes `mode: OWNER_ONLY_DIRECTORY_MODE`; `writeJsonFileAtomic` passes `mode: OWNER_ONLY_FILE_MODE` on the temp write.
- `test/tool-input-preview.test.ts` — `vi.mock("../src/logging.js", …)` retargets to `../src/json-safe-stringify.js`.
- `test/tool-preview-formatter.test.ts` — same mock retarget, plus the new redaction and prompt-stays-unredacted cases.
- `test/logging.test.ts` — extended with file/directory mode assertions and a redaction case.
- `test/authority/forwarding-io.test.ts` — mode assertions on a written request file and its directory.

### Documentation

- `docs/configuration.md` — the `permissionReviewLog` table row (line 104) gains a sensitivity note; the "Additional behaviors" bullet about bounded `toolInputPreview` values (line 906) is reworded to state that sensitive-keyed values are masked and bash command strings are not.
- `docs/troubleshooting.md` — the Threat Model "Limitations" list (line 39 onward) gains an entry stating that the review log records bash command strings verbatim, that files are owner-only, and that `permissionReviewLog: false` is the lever for a session handling credentials.
- `docs/architecture/architecture.md` — the module tree gains the three new modules near the existing `logging.ts` / `tool-input-preview.ts` entries.
  The `logging.ts` entry is reworded from "JSONL review/debug log writer" to note owner-only creation and the redaction pass.
- `.pi/skills/package-pi-permission-system/SKILL.md` — a short note under Configuration or Testing recording that log writes are owner-only and key-name redacted, so a future change does not reintroduce a raw write path.

### Grep verification performed at planning time

- `safeJsonStringify` importers: `src/tool-input-preview.ts`, plus `test/tool-input-preview.test.ts` and `test/tool-preview-formatter.test.ts`, which mock it by **relative** path (`../src/logging.js`), not the `#src/` alias — an alias-only grep would have missed both.
- `appendFileSync` / `writeFileSync` / `mkdirSync` call sites in `src/`: five total, three in scope (`logging.ts`, `extension-config.ts`, `forwarding-io.ts` ×2), two deliberately excluded (`config-store.ts`).
- `permissionReviewLog` in user-facing docs: `docs/configuration.md` lines 39, 57, 104; `config/config.example.json`; `src/config-schema.ts`.
  No `README.md` hit, so no README section goes stale.
- No roadmap step, health-metric row, or Mermaid node references [#647], so there is no `✅` step-mark to land.

## Test Impact Analysis

1. **What the extraction enables that was previously impractical.**
   `safeJsonStringify`'s cycle, `Error`, and `bigint` handling is currently untested — both consumers mock it away, and `logging.test.ts` only exercises the toggle behavior.
   Moving it to its own module gives it a natural test home, and step 1 adds the characterization tests before the move so the move is verifiably behavior-preserving.
   `restrictExistingPathToOwner` and `isSensitiveLogKey` are likewise directly unit-testable as pure/near-pure functions.
2. **What becomes redundant.**
   Nothing.
   The existing `logging.test.ts` case covers the enable/disable toggles, which no new test duplicates.
3. **What must stay as-is.**
   `test/tool-preview-formatter.test.ts`'s prompt-formatting cases genuinely exercise the layer being changed and must keep asserting unredacted prompt output — they are the regression guard for the invariant below.

## Invariants at risk

- **The ask-prompt shows the unredacted input.**
  This is the package's core function: a user cannot make a permission decision about input they cannot see.
  Currently pinned only implicitly by `test/tool-preview-formatter.test.ts`'s prompt cases, none of which use a sensitive key.
  Step 3 adds an explicit test — same input, sensitive key present, prompt unmasked and log masked in one assertion pair.
- **`safeJsonStringify` survives the move byte-identically** for cycles, `Error` values, and `bigint`.
  Measured at planning time: no test asserts any of the three (`grep -rn "safeJsonStringify\|Circular\|bigint" test/` returns only the two mock files).
  Step 1 adds them **before** the move, so the move is guarded rather than assumed.
- **A log IO failure stays non-fatal** and is surfaced once via `PermissionSessionLogger.reportOnce`.
  The new `chmod` must not re-enter that path — it swallows its own errors and returns nothing, so `writeLine`'s `string | undefined` warning contract is unchanged.
- **The gate never blocks on a hardening failure.**
  `restrictExistingPathToOwner` cannot throw, so no new failure mode reaches `createFailClosedToolCall`.

## TDD Order

1. **`refactor:` extract JSON-safe stringification.**
   Test surface: new `test/json-safe-stringify.test.ts`.
   First add characterization tests for cycles / `Error` / `bigint` against `safeJsonStringify` in its current home (red only in the sense that the file is new; they pass immediately), then move the function plus a new `createJsonSafeReplacer` into `src/json-safe-stringify.ts`, update `src/logging.ts` and `src/tool-input-preview.ts`, and retarget the two `vi.mock` calls.
   Removing the export from `logging.ts` breaks every importer at the type level, so the move and all consumer + consumer-test updates are one commit.
   Commit: `refactor(pi-permission-system): extract JSON-safe stringify from logging`.
2. **`fix:` mask sensitive-keyed values at the log-write boundary.**
   Test surface: new `test/log-redaction.test.ts` plus a case in `test/logging.test.ts`.
   Red: a review entry whose details carry a nested `{ headers: { authorization: "Bearer TEST_VALUE" } }` is written verbatim.
   Green: `src/log-redaction.ts` lands and `writeLine` serializes through `redactedJsonStringify`.
   Covers the predicate, nested objects, arrays, the `null`-value guard, and non-sensitive keys passing through untouched.
   Wiring lands in the same commit as the module so no unconsumed export exists for `fallow dead-code` to flag.
   Commit: `fix(pi-permission-system): mask sensitive-keyed values in permission logs`.
3. **`fix:` mask the generic tool-input preview.**
   Test surface: `test/tool-preview-formatter.test.ts`.
   Red: the reporter's repro — a generic extension tool called with `{ authorization: "Bearer TEST_VALUE" }` produces a log preview containing the value.
   Green: `serializeRedactedToolInputPreview` in `src/tool-input-preview.ts`, wired into `formatGenericToolInputForLog`.
   The paired assertion pins the invariant: the same input through `formatToolInputForPrompt` stays unredacted.
   Commit: `fix(pi-permission-system): redact generic tool input in the review log`.
4. **`fix:` create permission logs owner-only.**
   Test surface: new `test/log-file-permissions.test.ts` plus mode assertions in `test/logging.test.ts`.
   Red: after a review write into a temp dir, `statSync(reviewLogPath).mode & 0o777` is not `0o600`, and the logs directory is not `0o700`; a pre-created 0644 file stays 0644 across a write.
   Green: `src/log-file-permissions.ts`, the `mode` options in `logging.ts` / `extension-config.ts`, and the once-per-session `chmod`.
   Commit: `fix(pi-permission-system): create permission logs owner-only`.
5. **`fix:` create permission-forwarding artifacts owner-only.**
   Test surface: `test/authority/forwarding-io.test.ts`.
   Red: a request written via `writeJsonFileAtomic` is 0644 and its directory 0755.
   Green: the `mode` options in `ensureDirectoryExists` and `writeJsonFileAtomic`.
   Commit: `fix(pi-permission-system): create forwarding request files owner-only`.
6. **`docs:` record the decision and refresh the user docs.**
   ADR 0010, the two `docs/` edits, the architecture module-tree entries, and the SKILL.md note.
   Commit: `docs(pi-permission-system): record ADR 0010 on permission-log secret exposure`.

## Risks and Mitigations

- **False confidence in the redaction.**
  A user could read "logs are redacted" and paste a log containing a bash command with an inline secret.
  Mitigated by stating the boundary in the same sentence everywhere it appears — in `docs/configuration.md`, in the troubleshooting Threat Model limitation, and in ADR 0010 — as "a value bound to a sensitive key name is masked; a secret embedded in a bash command string is not."
- **Over-redaction of a legitimately non-secret key.**
  A key named `token` carrying a parser token would read `[redacted]` in the log, hurting debuggability.
  Accepted: the key set is fixed and narrow, and the debug stream's structured fields (`toolName`, `action`, `reason`, `matchedPattern`, `origin`) are all outside it.
- **Windows behavior differs.**
  `chmod` there toggles only the read-only bit, and the `mode` options are ignored, so the change is POSIX-effective only.
  Mitigated by swallowing the failure silently rather than warning every session, and by stating the limitation in ADR 0010.
  CI is `ubuntu-latest`, so the mode assertions are deterministic there.
- **`mkdirSync` mode applied to a newly created parent.**
  On a fresh install the extension's config directory becomes `0700` rather than umask-default.
  Judged desirable, since it holds `config.json`; existing directories are never modified, so no upgrade regresses an operator's chosen layout.
- **The step-1 move silently dropping a consumer.**
  Both mocking test files use a relative specifier, so the `#src/` alias grep the project convention suggests would miss them.
  Mitigated by the explicit relative-path grep recorded above and by running the full suite, not just the cycle-scoped file — the mock returns a partial module, so a missed retarget surfaces as `undefined is not a function` at run time rather than a `tsc` error.

## Open Questions

- Whether ADR 0010 should also state a position on the **debug** stream's `permission.decision` traces, which duplicate the payload when `debugLog` is on.
  The redaction covers them automatically because both streams share `writeLine`, so this is a wording question rather than a scope question; resolve while drafting the ADR.
- Whether the sensitive-key set belongs in `log-redaction.ts` as a module constant or eventually as a documented, overridable list.
  Landing it as a constant now; revisit only if a concrete report names a key the fixed set misses.

[#599]: https://github.com/gotgenes/pi-packages/issues/599
[#601]: https://github.com/gotgenes/pi-packages/issues/601
[#647]: https://github.com/gotgenes/pi-packages/issues/647
