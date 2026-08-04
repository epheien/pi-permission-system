---
issue: 91
issue_title: "Bash external-directory guard false-positive on sed regex containing absolute-path-like patterns"
---

# Fix sed/awk/grep false-positive in bash external-directory guard

## Problem Statement

The bash external-directory guard extracts path candidates from ALL command arguments indiscriminately, then attempts to classify each token as path-or-not using character-level heuristics (`classifyTokenAsPathCandidate`).
This is fundamentally flawed for commands like `sed`, `awk`, and `grep`, whose arguments mix regex patterns with file paths.
A sed address pattern like `/source: "tool",/{/origin:/!s/...}` starts with `/` and passes the heuristic classifier, triggering a false-positive prompt for an "external directory" that is actually a regex pattern.

The root cause is not a missing heuristic — it is that the classifier is **command-blind**.
The tree-sitter AST already gives us the command name, but we discard that context and classify each token independently.
No amount of character heuristics can reliably distinguish `/pattern/d` (sed command) from `/pattern/d` (real path) without knowing the command.

### How OpenCode handles this

OpenCode takes a strict allowlist approach: only extract path arguments from a known set of file-manipulating commands (`cat`, `cp`, `mv`, `rm`, `mkdir`, `chmod`, `chown`).
All other commands — including `sed`, `grep`, `awk` — get zero external-directory scanning.
This eliminates false positives entirely, but creates a false-negative gap: `sed 's/foo/bar/' /etc/hosts` does not trigger an external-directory prompt even though `/etc/hosts` is a real file argument.

### Unified approach

Use command context from the tree-sitter AST to make *better* classification decisions rather than binary include/exclude.
For known pattern-first commands (sed, awk, grep), identify and skip the script/pattern argument while still extracting the file arguments.
For unknown commands, fall back to the current heuristic classification.
Redirect targets remain universally extracted — they are syntactically unambiguous paths.

## Goals

- Extract the command name from each tree-sitter `command` node and use it to guide argument classification.
- For known pattern-first commands (sed, awk, grep and variants), skip the inline script/pattern argument positionally and extract only the file arguments.
- Preserve path detection for file arguments in pattern-first commands (fewer false negatives than OpenCode's allowlist approach).
- Preserve the current heuristic fallback for commands not in the pattern-first set.
- Continue extracting redirect targets (`> /path`, `< /path`) for all commands.
- No config, schema, or policy changes.

## Non-Goals

- Full POSIX/GNU option parser for every command.
- Combined flag handling (`-ni`, `-ie`) — deferred; regular flags that are not recognized are skipped without consuming the next argument.
- Long option handling (`--regexp=PATTERN`, `--file=FILE`) — deferred.
- PowerShell support — out of scope; this extension targets bash commands only.
- Changing any permission surface, default policy state, or merge precedence.
- Renaming the `/permission-system` slash command.

## Background

### Permission surface

`external_directory` (bash variant) — the special permission gate for bash commands referencing paths outside the working directory.

### Existing modules

| File                                    | Role                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/external-directory.ts`             | `extractExternalPathsFromBashCommand` (entry point), `collectPathCandidateTokens` (AST walker), `classifyTokenAsPathCandidate` (heuristic classifier), tree-sitter parser init |
| `src/handlers/tool-call.ts`             | Calls `extractExternalPathsFromBashCommand` for bash tool invocations                                                                                                          |
| `tests/bash-external-directory.test.ts` | Test suite for extraction, classification, and formatting                                                                                                                      |

### Current flow

```text
extractExternalPathsFromBashCommand(command, cwd)
  → tree-sitter parse → AST
  → collectPathCandidateTokens(root) → flat string[]
      walks ALL command nodes, extracts ALL arguments (command-blind)
      walks file_redirect nodes, extracts redirect targets
  → for each token: classifyTokenAsPathCandidate(token)
      heuristic reject: flags, env assignments, URLs, @scope, bare-slash, regex metachar
      heuristic accept: starts with /, starts with ~/, contains ..
  → resolve + isPathOutsideWorkingDirectory
```

### False-positive reproducer from the issue

```bash
sed -i '' '/source: "tool",/{/origin:/!s/source: "tool",/source: "tool",\n      origin: "builtin",/;}' tests/tool-input-preview.test.ts
```

tree-sitter parses the single-quoted sed script as a `raw_string` argument.
After quote stripping, the token is `/source: "tool",/{/origin:/!s/...}`.
It starts with `/`, does not match `REGEX_METACHAR_PATTERN`, and is classified as a path candidate.
The user sees a prompt about "external directory `/source: "tool",/{...}`".

## Design Overview

### Command name extraction

When visiting a `command` node in `collectPathCandidateTokens`, extract the command name from the `command_name` child node.
Normalize it with `basename` to handle full-path invocations (`/usr/bin/sed` → `sed`).
Look it up in a `PATTERN_FIRST_COMMANDS` map.

### Pattern-first command config

```typescript
interface PatternCommandConfig {
  /** Flags that consume the next argument as a non-path value (pattern, separator, etc.) */
  readonly argConsumingFlags: ReadonlySet<string>;
  /** Flags that consume the next argument as a file path */
  readonly fileConsumingFlags: ReadonlySet<string>;
  /**
   * Number of leading positional arguments that are patterns/scripts, not paths.
   * Default: 1 (covers sed, awk, grep, rg).
   * sd uses 2 (FIND and REPLACE_WITH are both non-path positionals).
   */
  readonly patternPositionals?: number;
}

const PATTERN_FIRST_COMMANDS: ReadonlyMap<string, PatternCommandConfig> = new Map([
  ["sed",   { argConsumingFlags: new Set(["-e", "-i"]),
              fileConsumingFlags: new Set(["-f"]) }],
  ["awk",   { argConsumingFlags: new Set(["-e", "-F", "-v"]),
              fileConsumingFlags: new Set(["-f"]) }],
  ["gawk",  { argConsumingFlags: new Set(["-e", "-F", "-v"]),
              fileConsumingFlags: new Set(["-f"]) }],
  ["nawk",  { argConsumingFlags: new Set(["-e", "-F", "-v"]),
              fileConsumingFlags: new Set(["-f"]) }],
  ["grep",  { argConsumingFlags: new Set(["-e", "-A", "-B", "-C", "-m"]),
              fileConsumingFlags: new Set(["-f"]) }],
  ["egrep", { argConsumingFlags: new Set(["-e", "-A", "-B", "-C", "-m"]),
              fileConsumingFlags: new Set(["-f"]) }],
  ["fgrep", { argConsumingFlags: new Set(["-e", "-A", "-B", "-C", "-m"]),
              fileConsumingFlags: new Set(["-f"]) }],
  ["rg",    { argConsumingFlags: new Set(["-e", "-A", "-B", "-C", "-m",
                                           "-g", "-t", "-T", "-j", "-M",
                                           "-r", "-E"]),
              fileConsumingFlags: new Set(["-f"]) }],
  ["sd",    { argConsumingFlags: new Set(["-n", "-f"]),
              fileConsumingFlags: new Set([]),
              patternPositionals: 2 }],
]);
```

### Position-based argument skipping

For a command in `PATTERN_FIRST_COMMANDS`, process arguments with state tracking:

```text
let hasExplicitScript = false   // set true when -e or -f is encountered
let positionalsSeen = 0
const patternPositionals = config.patternPositionals ?? 1
let nextArgAction: "skip" | "extract" | null = null

for each child node after command_name:
  if nextArgAction is "skip":
    nextArgAction = null; continue        // consumed by previous flag
  if nextArgAction is "extract":
    collect token; nextArgAction = null; continue  // file consumed by -f

  if child is a flag (word starting with "-", length > 1):
    if flag == "--":
      mark all remaining as positional; continue
    if flag in argConsumingFlags:
      nextArgAction = "skip"
      if flag == "-e" or flag == "-f":
        hasExplicitScript = true          // no inline script expected
    elif flag in fileConsumingFlags:
      nextArgAction = "extract"
      hasExplicitScript = true
    continue                              // regular flag, skip

  // positional argument
  if !hasExplicitScript && positionalsSeen < patternPositionals:
    positionalsSeen++
    continue                              // skip: this is an inline pattern/script

  collect token                           // file argument → path candidate
```

For commands NOT in `PATTERN_FIRST_COMMANDS`, the existing generic logic applies unchanged (extract all non-command-name arguments).

### Redirect targets

Unchanged — `file_redirect` handling remains command-blind because redirect destinations are always filesystem paths regardless of the command.

### classifyTokenAsPathCandidate

Unchanged — it remains as defense-in-depth for tokens that pass through the position-based filter.
The existing heuristics (URL rejection, regex metachar rejection, bare-slash rejection, etc.) still apply to all collected tokens.

### Worked examples

#### Issue reproducer

```bash
sed -i '' '/source: "tool",/{/origin:/!s/source: "tool",/source: "tool",\n      origin: "builtin",/;}' tests/tool-input-preview.test.ts
```

1. Command name: `sed` → in `PATTERN_FIRST_COMMANDS`.
2. `-i` → argConsumingFlag → `nextArgAction = "skip"`.
3. `''` → consumed by `-i` → skipped.
4. `'/source: ...'` → first positional, `!hasExplicitScript && positionalsSeen < 1` → skipped as inline script.
5. `tests/tool-input-preview.test.ts` → second positional → collected as path candidate → relative path, within CWD → not flagged.
6. Result: no false-positive prompt. ✓

#### sed with external file argument

```bash
sed 's/foo/bar/g' /etc/hosts
```

1. Command name: `sed`.
2. `'s/foo/bar/g'` → first positional → skipped as inline script.
3. `/etc/hosts` → second positional → collected → classified as path → flagged as external.
4. Result: external-directory prompt for `/etc/hosts`. ✓

#### sed with -e flag

```bash
sed -e 's/foo/bar/' /etc/hosts
```

1. `-e` → argConsumingFlag, `hasExplicitScript = true`, `nextArgAction = "skip"`.
2. `'s/foo/bar/'` → consumed by `-e` → skipped.
3. `/etc/hosts` → positional, `hasExplicitScript` is true → collected → flagged.
4. Result: prompt for `/etc/hosts`. ✓

#### grep with pattern and external file

```bash
grep '/etc/' /var/log/syslog
```

1. Command name: `grep`.
2. `'/etc/'` → first positional → skipped as pattern.
3. `/var/log/syslog` → second positional → collected → flagged.
4. Result: prompt for `/var/log/syslog`. ✓

#### Unknown command (fallback)

```bash
some-tool /etc/hosts
```

1. Command name: `some-tool` → not in `PATTERN_FIRST_COMMANDS`.
2. Falls through to existing generic extraction logic.
3. `/etc/hosts` → collected → classified → flagged.
4. Result: prompt for `/etc/hosts`. ✓ (no regression)

#### rg with pattern and external path

```bash
rg '/usr/local' /etc/profile.d/
```

1. Command name: `rg` → in `PATTERN_FIRST_COMMANDS`.
2. `'/usr/local'` → first positional → skipped as pattern.
3. `/etc/profile.d/` → second positional → collected → flagged.
4. Result: prompt for `/etc/profile.d/`. ✓

#### sd with two pattern positionals

```bash
sd '/usr/local/bin' '/opt/bin' /etc/profile
```

1. Command name: `sd` → in `PATTERN_FIRST_COMMANDS`, `patternPositionals = 2`.
2. `'/usr/local/bin'` → first positional (`positionalsSeen < 2`) → skipped.
3. `'/opt/bin'` → second positional (`positionalsSeen < 2`) → skipped.
4. `/etc/profile` → third positional (`positionalsSeen == 2`) → collected → flagged.
5. Result: prompt for `/etc/profile`. ✓

#### Redirect target on sed

```bash
sed 's/foo/bar/' input.txt > /tmp/output.txt
```

1. Script and `input.txt` handled by position logic.
2. `> /tmp/output.txt` → `file_redirect` node → `/tmp/output.txt` collected → flagged.
3. Result: prompt for `/tmp/output.txt`. ✓

### Known limitation: `sed -i` without extension (GNU sed)

```bash
sed -i 's/foo/bar/' /etc/hosts
```

GNU sed treats `-i` as a flag with no argument; `'s/foo/bar/'` is the inline script, `/etc/hosts` is the input.
Our logic treats `-i` as arg-consuming, so `'s/foo/bar/'` is consumed as the `-i` extension, and `/etc/hosts` becomes the first positional — which is skipped as the inline script.
This is a false negative: we miss `/etc/hosts`.

Mitigation:

- This invocation pattern (in-place edit of an external file with no backup) is uncommon.
- The bash permission gate still applies — if bash is set to `ask`, the user gets prompted for the command itself.
- A follow-up can refine `-i` handling by inspecting whether the consumed argument looks like a sed script (contains `/` delimiters) vs an extension suffix.

## Module-Level Changes

| File                                    | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/external-directory.ts`             | Add `PatternCommandConfig` interface and `PATTERN_FIRST_COMMANDS` map. Add `extractCommandName` helper (extracts command name from `command_name` child, applies `basename`). Refactor the `command` branch in `collectPathCandidateTokens` to dispatch to `collectPatternCommandTokens` for pattern-first commands vs existing generic logic for others. Add `collectPatternCommandTokens` implementing position-based skipping. Import `basename` from `node:path` (already imported). |
| `tests/bash-external-directory.test.ts` | Add `describe("command-aware extraction")` block with sub-describes for sed, grep, awk, rg, sd, unknown commands, and edge cases. Add the issue reproducer as a named test. Update any existing tests whose behavior changes (if any — the position-based skipping should only REDUCE the set of extracted tokens for pattern commands, never increase it for non-pattern commands).                                                                                                     |

No changes to schema, config, docs/architecture, or other source modules.

## TDD Order

### Step 1

Surface: `extractExternalPathsFromBashCommand` — sed command-aware extraction.
Coverage: the exact reproducer from the issue, plus simple `sed 'script' /external/file` and `sed 'script' internal-file`.
Suggested commit: `test: add failing tests for sed pattern false-positive (#91)`

### Step 2

Surface: `extractExternalPathsFromBashCommand` — sed flag handling.
Coverage: `sed -e 'script' /external/file`, `sed -n 'script' /external/file`, `sed -f /script/file input`, `sed -i '' 'script' /external/file`.
Suggested commit: `test: add failing tests for sed flag-aware extraction (#91)`

### Step 3

Surface: `extractExternalPathsFromBashCommand` — grep, awk, rg, and sd.
Coverage: `grep 'pattern' /external/file`, `grep -e 'pattern' /external/file`, `awk '{print}' /external/file`, `awk -F: '{print $1}' /external/file`, `rg '/pattern' /external/dir`, `rg -e '/pattern' /external/dir`, `sd '/find' '/replace' /external/file` (two pattern positionals then file).
Suggested commit: `test: add failing tests for grep/awk/rg/sd pattern-first extraction (#91)`

### Step 4

Surface: `collectPathCandidateTokens` — implement command-aware extraction.
Coverage: all tests from steps 1–3 go green.
Run full suite to verify no regressions.
Changes: add `PATTERN_FIRST_COMMANDS`, `PatternCommandConfig`, `extractCommandName`, `collectPatternCommandTokens`.
Refactor `command` branch in `collectPathCandidateTokens` to dispatch based on command name.
Suggested commit: `feat: command-aware path extraction for pattern-first commands (#91)`

### Step 5

Surface: `extractExternalPathsFromBashCommand` — edge cases and defense-in-depth.
Coverage: full-path command invocation (`/usr/bin/sed 'script' /ext/file`), `--` end-of-flags, unknown commands still use generic extraction, redirect targets still extracted for pattern-first commands, pipeline with sed piped to cat (`sed 'script' file | cat /external/file`).
Suggested commit: `test: cover command-aware edge cases and fallback (#91)`

### Step 6

Surface: `extractExternalPathsFromBashCommand` — known limitation documentation.
Coverage: add `test.todo` or comment documenting the `sed -i 'script' /external/file` (GNU sed no-extension) false negative.
Suggested commit: `test: document sed -i no-extension known limitation (#91)`

## Risks and Mitigations

| Risk                                                                | Mitigation                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Could this silently weaken a permission?                            | Position-based skipping only skips the inline script/pattern argument for known pattern-first commands. File arguments are still extracted. For unknown commands, behavior is unchanged. Redirect targets are still universally extracted. The only tokens we stop detecting are pattern arguments — which were false positives, not real paths. |
| `PATTERN_FIRST_COMMANDS` set is incomplete                          | The set covers the most common pattern-first commands (sed, awk, grep, rg, sd and variants). Uncommon commands with similar argument structure can be added incrementally. Commands NOT in the set fall through to the existing generic extraction — no regression.                                                                              |
| Flag config is incomplete (combined flags, long options)            | Unrecognized flags are treated as regular flags (no arg consumed). This may cause misidentification of argument positions in rare cases, but `classifyTokenAsPathCandidate` provides defense-in-depth. Combined flag and long option support can be added incrementally.                                                                         |
| `sed -i` without extension (GNU sed) causes false negative          | Documented as a known limitation. The bash permission gate still applies. A follow-up can refine `-i` handling.                                                                                                                                                                                                                                  |
| Command name extraction fails (variable expansion, alias, subshell) | If the command name cannot be extracted (e.g., `$CMD /etc/hosts`), fall back to generic extraction. No regression.                                                                                                                                                                                                                               |
| Refactoring `collectPathCandidateTokens` breaks existing tests      | The refactor only changes behavior for pattern-first commands. Generic extraction path is preserved as-is. Full test suite run confirms no regressions.                                                                                                                                                                                          |

## Open Questions

- **Should `-i` for sed consume the next argument?**
  Current plan says yes (handles BSD `sed -i ''` correctly).
  The trade-off is a false negative for GNU `sed -i 'script' file`.
  An alternative is to peek at the next argument's content — if it looks like a sed script (contains `/` delimiters and is longer than a typical extension), don't consume it.
  Defer this refinement unless test coverage reveals it matters in practice.
- **Should we add `perl`, `ruby`, `python`, `node` to the command map?**
  These interpreters' first positional argument is a script FILE (a real path), not inline code.
  They are not "pattern-first" — they are "script-first" and their arguments ARE paths.
  They should NOT be in `PATTERN_FIRST_COMMANDS`.
  Only commands whose first argument is an inline pattern/script (not a file reference) belong here.
- **Should character-based defense-in-depth be added to `classifyTokenAsPathCandidate`?**
  Adding script-indicator characters (`{`, `}`, `!`, `;`) as a rejection heuristic would catch patterns that slip through position-based skipping.
  This is orthogonal and could be a follow-up.
