---
issue: 153
issue_title: "Create Pi extension with GitHub CI/release tools for deterministic `/ship-issue`"
---

# Pi GitHub Tools Extension

## Problem Statement

The `/ship-issue` template instructs the agent to poll CI status via prose — `sleep 15`, re-check `gh run list`, interpret "up to ~3 times" loosely.
This consumes turns and context on mechanical polling, produces non-deterministic behavior (the LLM sometimes gives up early), and has no structured progress reporting.
The same friction applies to watching the release workflow after merging a release-please PR.

The `@repone/agent-tools` package in the repone project already solves this with purpose-built CI tools that have polling, exponential backoff, progress streaming, and structured success/timeout returns.
Those tools are host-agnostic business logic with thin OpenCode wrappers.
The goal is to port and generalize this pattern into a Pi extension.

## Goals

- Create a **new standalone Pi extension** (`pi-github-tools`) in a separate repository.
- Register deterministic tools via `pi.registerTool()`: `ci_find`, `ci_watch`, `ci_list`, `release_pr_find`, `release_pr_merge`, `release_watch`, `issue_close`.
- Port the portable business logic pattern from `@repone/agent-tools`: pure `lib/` functions accept `onProgress` callbacks; the Pi wrapper maps to `onUpdate`.
- Auto-detect `owner/repo` from `gh repo view --json owner,name` with git-remote parsing as fallback — no hardcoded org/repo constants.
- Return structured text results (not JSON to the LLM) with clear success/timeout/error states.
- Map `onProgress` callbacks to Pi's `onUpdate` streaming mechanism for real-time progress in the TUI.

## Non-Goals

- Board/project integration (move to column, set rank) — repo-specific, not portable.
- Issue creation, editing, triaging, or dependency management — too repo-specific for a general tool.
- Modifying the `/ship-issue` template in this plan — that's a follow-up after the tools are available.
- Publishing to npm — the extension is installed via git URL in Pi settings; npm publishing is a follow-up.
- Integrating with `pi-permission-system` — this is a separate extension with no permission surface.

## Background

### Prior art: `@repone/agent-tools`

Located at `~/tinyigsoftware/repone/agent-tools/`.
Architecture: portable business logic in `src/` (`ci.ts`, `issue.ts`, `release.ts`) backed by helpers in `src/lib/` (`ci-helpers.ts`, `github-project.ts`, `process.ts`).
OpenCode-specific wrappers in `.opencode/tools/` are thin adapters that call the business logic and map `onProgress` to `context.metadata({ title })`.

Key patterns to port:

- **`findRun`** — exponential backoff (5 s base, 30 s cap), polls `gh run list` until a run matching a SHA appears or timeout.
- **`watchRun`** — 15 s poll interval, `formatProgress` produces compact `[2/5] deploy — in_progress (120s)` lines.
- **`listRuns`** — simple `gh run list` with structured output.
- **`ci-helpers.ts`** — `CIJob` type, `findRetryDelay()`, `formatProgress()`.
- **`process.ts`** — `runCommand()` wrapping `child_process.spawn`, `sleep()` helper.

Things to **not** port:

- `github-project.ts` — hardcoded `ORG`, `REPO`, `PROJECT_NUMBER`, `STATUS_OPTIONS`, `PRODUCTION_URL`.
  Replace with auto-detected owner/repo.
- `board.ts`, `milestone.ts`, `retro.ts`, `devserver.ts`, `dod-preflight.ts` — repo-specific.
- `temp-file.ts` — only needed for issue body creation (not in scope).

### Pi `registerTool` API

```typescript
pi.registerTool<TParams>({
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TParams; // TypeBox schema
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
});
```

Progress streaming: call `onUpdate?.({ type: "progress", content })` during execution.
Pi uses `typebox` v1 (`import { Type } from "typebox"`).

### Repo detection strategy

1. Try `gh repo view --json owner,name` — authoritative, requires `gh auth`.
2. Fallback: parse `git remote get-url origin` — handles `git@github.com:owner/repo.git` and `https://github.com/owner/repo.git` formats.
3. Cache the result for the extension lifetime (detect once at first tool call, not at load time).

## Design Overview

### Package structure

```text
pi-github-tools/
├── package.json              # pi.extensions entry, typebox peer dep
├── tsconfig.json             # ES2023, noEmit
├── biome.json
├── vitest.config.ts
├── src/
│   ├── extension.ts          # default export: registers all tools
│   ├── tools/
│   │   ├── ci-find.ts        # Pi tool wrapper for findRun
│   │   ├── ci-watch.ts       # Pi tool wrapper for watchRun
│   │   ├── ci-list.ts        # Pi tool wrapper for listRuns
│   │   ├── release-pr-find.ts
│   │   ├── release-pr-merge.ts
│   │   ├── release-watch.ts
│   │   └── issue-close.ts
│   ├── lib/
│   │   ├── ci.ts             # portable: findRun, watchRun, listRuns
│   │   ├── ci-helpers.ts     # CIJob, findRetryDelay, formatProgress
│   │   ├── release.ts        # portable: findReleasePR, mergeReleasePR, watchRelease
│   │   ├── issue.ts          # portable: closeIssue
│   │   ├── github.ts         # portable: gh(), ghJson(), detectRepo()
│   │   └── process.ts        # portable: runCommand(), sleep()
│   └── progress.ts           # maps onProgress → Pi onUpdate
└── tests/
    ├── lib/
    │   ├── ci.test.ts
    │   ├── ci-helpers.test.ts
    │   ├── release.test.ts
    │   ├── issue.test.ts
    │   ├── github.test.ts
    │   └── process.test.ts
    └── tools/
        └── (integration-style tests if needed)
```

### Data flow

```text
LLM calls ci_find(workflow, expected_sha, timeout)
  → Pi dispatches to tools/ci-find.ts execute()
    → calls lib/ci.ts findRun({ workflow, expectedSha, timeout, onProgress })
      → onProgress mapped to Pi onUpdate via progress.ts
      → lib/ci.ts calls lib/github.ts ghJson() for polling
        → ghJson() calls runCommand() which spawns `gh`
    → returns structured text result
  → Pi returns AgentToolResult to LLM
```

### Tool specifications

#### `ci_find`

| Field      | Value                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| Parameters | `workflow: string`, `expected_sha: string`, `timeout?: number` (default 120)                                       |
| Behavior   | Exponential backoff polling (5 s base, 30 s cap). Polls `gh run list` until a run matching `expected_sha` appears. |
| Success    | Returns `run_id`, `url`, `status`, `sha`, `title`, and job list.                                                   |
| Timeout    | Returns structured timeout message with last-seen SHA and retry count.                                             |
| Progress   | Emits `awaiting <workflow> run for <short_sha>... (attempt N, Ns elapsed)`                                         |

#### `ci_watch`

| Field      | Value                                                                  |
| ---------- | ---------------------------------------------------------------------- |
| Parameters | `workflow: string`, `run_id: number`, `timeout?: number` (default 300) |
| Behavior   | 15 s poll interval. Polls `gh run view` by run ID.                     |
| Success    | Returns full progress log and final status.                            |
| Timeout    | Returns progress log with timeout line.                                |
| Progress   | Emits `[completed/total] active_job — in_progress (Ns)` per cycle      |

#### `ci_list`

| Field      | Value                                            |
| ---------- | ------------------------------------------------ |
| Parameters | `workflow: string`, `limit?: number` (default 5) |
| Behavior   | Single `gh run list` call.                       |
| Returns    | Status, name, SHA, run ID, URL per run.          |

#### `release_pr_find`

| Field      | Value                                                                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------- |
| Parameters | `timeout?: number` (default 120)                                                                            |
| Behavior   | Polls `gh pr list` filtering for release-please PRs until one appears or timeout. Uses exponential backoff. |
| Success    | Returns PR number, title, head branch, mergeable status, URL.                                               |
| Timeout    | Structured timeout with retry count.                                                                        |

#### `release_pr_merge`

| Field      | Value                                                                                  |
| ---------- | -------------------------------------------------------------------------------------- |
| Parameters | `pr_number: number`                                                                    |
| Behavior   | Checks PR is `MERGEABLE` + `CLEAN`. Merges with `--rebase`. Runs `git pull --ff-only`. |
| Success    | Returns merge confirmation with new HEAD SHA.                                          |
| Error      | Structured error if not mergeable (with reason).                                       |

#### `release_watch`

| Field      | Value                                                                |
| ---------- | -------------------------------------------------------------------- |
| Parameters | `expected_sha?: string`, `timeout?: number` (default 180)            |
| Behavior   | Polls for a new git tag on HEAD or watches the release workflow run. |
| Success    | Returns version, tag name, tag SHA.                                  |
| Timeout    | Structured timeout.                                                  |

#### `issue_close`

| Field      | Value                                                                                     |
| ---------- | ----------------------------------------------------------------------------------------- |
| Parameters | `issue_number: number`, `comment?: string`, `reason?: string` (default "completed")       |
| Behavior   | `gh issue close` with optional comment. Validates reason is `completed` or `not_planned`. |
| Returns    | Confirmation message.                                                                     |

### Progress mapping

```typescript
// src/progress.ts
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";

export function createProgressCallback(
  onUpdate: AgentToolUpdateCallback<unknown> | undefined,
): ((line: string) => void) | undefined {
  if (!onUpdate) return undefined;
  return (line: string) => {
    onUpdate({ type: "progress", content: line });
  };
}
```

### Repo detection

```typescript
// src/lib/github.ts
interface RepoInfo { owner: string; repo: string }

let cachedRepo: RepoInfo | undefined;

export async function detectRepo(): Promise<RepoInfo> {
  if (cachedRepo) return cachedRepo;

  // Try gh first
  try {
    const result = await ghJson<{ owner: { login: string }; name: string }>(
      "repo", "view", "--json", "owner,name",
    );
    cachedRepo = { owner: result.owner.login, repo: result.name };
    return cachedRepo;
  } catch {
    // Fall back to git remote
  }

  const { stdout } = await runCommand({ cmd: "git", args: ["remote", "get-url", "origin"] });
  const match = stdout.trim().match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!match) throw new Error("Could not detect GitHub repository from git remote");
  cachedRepo = { owner: match[1], repo: match[2] };
  return cachedRepo;
}
```

The `gh()` and `ghJson()` helpers accept repo-aware commands by prepending `-R owner/repo` when the command targets a specific repo, or omitting it for commands that infer from CWD (like `gh run list`).
Since all CI/release tools run in the project directory, most `gh` commands can rely on CWD detection.
`detectRepo()` is primarily needed for tools that construct URLs or display owner/repo in output.

### Error handling

All tools return `AgentToolResult` with `{ content, isError }`:

- **Success**: `{ content: structuredText, isError: false }`
- **Timeout**: `{ content: structuredTimeoutMessage, isError: false }` — timeouts are expected outcomes, not errors.
- **Error** (gh not installed, auth failure, network): `{ content: errorMessage, isError: true }`

This matches the repone pattern where timeouts return structured messages rather than throwing.

## Module-Level Changes

This is a new standalone repository.
All files are new — no changes to `pi-permission-system`.

### `src/lib/process.ts` — NEW

Port from `@repone/agent-tools/src/lib/process.ts`.
`runCommand()` and `sleep()` — unchanged.

### `src/lib/github.ts` — NEW

Replaces `@repone/agent-tools/src/lib/github-project.ts`.
Drops all hardcoded constants (`ORG`, `REPO`, `PROJECT_NUMBER`, `PRODUCTION_URL`, `STATUS_OPTIONS`).
Adds `detectRepo()` with `gh repo view` + git remote fallback.
Keeps `gh()` and `ghJson()` helpers.

### `src/lib/ci-helpers.ts` — NEW

Port from `@repone/agent-tools/src/lib/ci-helpers.ts`.
`CIJob`, `findRetryDelay()`, `formatProgress()` — unchanged.

### `src/lib/ci.ts` — NEW

Port from `@repone/agent-tools/src/ci.ts`.
Remove `PRODUCTION_URL` references from `formatFind` and `formatWatch`.
Remove the `workflow` parameter from `formatWatch` and `formatFind` (it was only used for the production URL conditional).

### `src/lib/release.ts` — NEW

New module.
`findReleasePR()` — polls `gh pr list --label "autorelease: pending"` or `--search "release-please"` with backoff.
`mergeReleasePR()` — checks mergeable state, merges with `--rebase`, pulls.
`watchRelease()` — polls `git tag --points-at HEAD` or watches the release workflow.

### `src/lib/issue.ts` — NEW

Port simplified `closeIssue()` from `@repone/agent-tools/src/issue.ts`.
Drop board integration (`moveToStatus`).
Keep reason validation (`completed` | `not_planned`).

### `src/progress.ts` — NEW

Maps `onProgress` callback to Pi's `onUpdate`.

### `src/tools/*.ts` — NEW (7 files)

Thin Pi wrappers.
Each file exports a function that accepts `pi: ExtensionAPI` and calls `pi.registerTool()` with TypeBox parameter schema, description, `promptSnippet`, and an `execute` function that delegates to the corresponding `lib/` function.

### `src/extension.ts` — NEW

Default export `piGithubToolsExtension(pi: ExtensionAPI)`.
Calls each tool registration function.

### `tests/lib/*.test.ts` — NEW (6 files)

Unit tests for all portable business logic.
Mock `runCommand` to avoid real `gh` calls.
Test backoff timing, progress formatting, timeout handling, structured output.

## Repository Scaffolding

The new `pi-github-tools` repo must mirror the conventions established in `pi-permission-system`.
This section specifies every config file and its contents.

### `package.json`

```jsonc
{
  "name": "@gotgenes/pi-github-tools",
  "version": "0.0.0",
  "description": "Pi extension providing deterministic GitHub CI, release, and issue tools.",
  "type": "module",
  "files": ["src", "README.md", "CHANGELOG.md", "LICENSE"],
  "scripts": {
    "prepare": "command -v prek >/dev/null 2>&1 && prek install || echo 'prek not found — skipping hook install (see README)'",
    "build": "tsc -p tsconfig.json",
    "lint": "biome check .",
    "lint:fix": "biome check --write .",
    "lint:md": "markdownlint-cli2 '*.md' 'docs/**/*.md'",
    "lint:md:fix": "markdownlint-cli2 --fix '*.md' 'docs/**/*.md'",
    "lint:imports": "! grep -rn --include='*.ts' 'from \"\\.[./][^\"]*\\.js\"' src/ tests/",
    "lint:all": "pnpm run lint && pnpm run lint:md && pnpm run lint:imports",
    "format": "biome format --write .",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "pnpm run build && pnpm run lint:all && pnpm run test"
  },
  "keywords": ["pi-package", "pi", "pi-extension", "pi-coding-agent", "github", "ci", "release"],
  "author": { "name": "Chris Lasher" },
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/gotgenes/pi-github-tools.git"
  },
  "homepage": "https://github.com/gotgenes/pi-github-tools#readme",
  "bugs": { "url": "https://github.com/gotgenes/pi-github-tools/issues" },
  "packageManager": "pnpm@11.0.8",
  "engines": { "node": ">=20" },
  "publishConfig": { "access": "public" },
  "pi": {
    "extensions": ["./src/extension.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.4.14",
    "@earendil-works/pi-coding-agent": "^0.74.0",
    "@types/node": "^25.6.2",
    "markdownlint-cli2": "^0.22.1",
    "typescript": "6.0.3",
    "vitest": "^4.1.5"
  }
}
```

Notes:

- No `@earendil-works/pi-tui` peer dependency — this extension does not import TUI types.
- No runtime `dependencies` — all work is done via `child_process.spawn` calling the `gh` CLI.
- `typebox` is re-exported by `@earendil-works/pi-coding-agent`; no separate dependency needed.
- Version starts at `0.0.0`; release-please bumps it on first release.

### `tsconfig.json`

```jsonc
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "noEmit": true,
    "strict": false,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowSyntheticDefaultImports": true
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "exclude": ["node_modules"]
}
```

### `biome.json`

Identical to `pi-permission-system/biome.json` — same formatter, linter, and test-file overrides.

### `.markdownlint-cli2.yaml`

```yaml
ignores:
  - "CHANGELOG.md"

config:
  line-length: false
  no-duplicate-heading:
    siblings_only: true
  no-inline-html:
    allowed_elements:
      - p
      - img
  first-line-heading: false
```

### `prek.toml`

Identical to `pi-permission-system/prek.toml` — trailing-whitespace, end-of-file-fixer, check-added-large-files, biome check, and markdownlint-cli2 hooks.

### `mise.toml`

```toml
[env]
_.path = ["scripts/bin"]
```

### `scripts/bin/npm`

Copy from `pi-permission-system/scripts/bin/npm` — the pnpm-enforcement shim.

### `.gitignore`

```text
node_modules/
*.log
.DS_Store
dist/
coverage/
logs/
*.tmp
```

### `.github/workflows/ci.yml`

Same structure as `pi-permission-system`:

1. `check` job — checkout, pnpm setup, `pnpm install --frozen-lockfile`, type check (`pnpm run build`), lint (`pnpm run lint:all`), test (`pnpm test`).
2. `release-please` job — runs on `main` after `check` passes, uses `googleapis/release-please-action@v5`, publishes to npm via OIDC trusted publishing.

### `release-please-config.json`

Identical to `pi-permission-system/release-please-config.json` — same changelog sections and `include-v-in-tag: true`.

### `.release-please-manifest.json`

```json
{
  ".": "0.0.0"
}
```

### `AGENTS.md`

Project-specific agent instructions covering:

- Project purpose (deterministic GitHub CI/release tools for Pi).
- pnpm-only rule, ES2023 target, Conventional Commits.
- Portable `lib/` code must not import Pi SDK types — only the `tools/` and `progress.ts` wrappers touch Pi.
- `gh` CLI is the sole external dependency; no other binaries assumed.
- Testing strategy: mock `runCommand` in `lib/` tests; `tools/` wrappers are thin and tested lightly.

### `LICENSE`

MIT license, matching `pi-permission-system`.

## Test Impact Analysis

This is a greenfield package — no existing tests to consider.

1. **New unit tests enabled**: The portable `lib/` layer is fully testable by mocking `runCommand`.
   This includes backoff timing (`findRetryDelay`), progress formatting (`formatProgress`), poll loop exit conditions, timeout vs. success branching, repo detection fallback logic, and PR merge precondition checking.
2. **No existing tests to simplify**: Greenfield.
3. **Integration tests**: The `tools/` wrappers are thin enough that integration tests are optional.
   The `onUpdate` mapping in `progress.ts` is a one-liner.

## TDD Order

### Cycle 0: Repository scaffolding

- **Covers**: Create the GitHub repo, initialize with all config files from the Repository Scaffolding section, run `pnpm install`, verify `pnpm run build` and `pnpm run lint:all` pass on an empty `src/extension.ts` stub (`export default function piGithubToolsExtension() {}`).
- **Commit**: `chore: initialize pi-github-tools repo with project scaffolding`

### Cycle 1: Process helpers

- **Test surface**: `tests/lib/process.test.ts`
- **Covers**: `runCommand` spawns a process and captures stdout/stderr/exitCode; `sleep` resolves after delay.
- **Commit**: `feat: add process helpers (runCommand, sleep)`

### Cycle 2: CI helpers (pure functions)

- **Test surface**: `tests/lib/ci-helpers.test.ts`
- **Covers**: `findRetryDelay` backoff curve (attempt 1→0, 2→5, 3→10, 4→20, 5→30, 6→30 cap); `formatProgress` output for no-jobs, queued, in-progress, mixed states.
- **Commit**: `feat: add CI helper functions (findRetryDelay, formatProgress)`

### Cycle 3: GitHub helpers and repo detection

- **Test surface**: `tests/lib/github.test.ts`
- **Covers**: `gh()` throws on non-zero exit; `ghJson()` parses JSON output; `detectRepo()` uses `gh repo view` when available; `detectRepo()` falls back to git remote parsing for SSH and HTTPS URLs; `detectRepo()` caches result.
- **Commit**: `feat: add GitHub helpers with auto repo detection`

### Cycle 4: CI find/watch/list

- **Test surface**: `tests/lib/ci.test.ts`
- **Covers**: `findRun` — success on first poll, success after retries, timeout with last-seen info, onProgress callback invocation; `watchRun` — run completes immediately, run completes after polls, timeout, progress lines; `listRuns` — formats output, handles empty list.
- **Commit**: `feat: add CI business logic (findRun, watchRun, listRuns)`

### Cycle 5: Release tools

- **Test surface**: `tests/lib/release.test.ts`
- **Covers**: `findReleasePR` — finds PR on first poll, timeout; `mergeReleasePR` — success, not-mergeable error, pull failure; `watchRelease` — tag appears, timeout.
- **Commit**: `feat: add release business logic (findReleasePR, mergeReleasePR, watchRelease)`

### Cycle 6: Issue close

- **Test surface**: `tests/lib/issue.test.ts`
- **Covers**: `closeIssue` — success with comment, success without comment, invalid reason rejected, `not_planned` normalized.
- **Commit**: `feat: add issue close business logic`

### Cycle 7: Progress adapter

- **Test surface**: `tests/progress.test.ts`
- **Covers**: `createProgressCallback` returns undefined when onUpdate is undefined; returns a function that calls onUpdate with progress type.
- **Commit**: `feat: add Pi progress adapter`

### Cycle 8: Pi tool wrappers and extension entry

- **Test surface**: `tests/tools/` (light integration) or manual verification.
- **Covers**: Each tool is registered with correct name, description, and parameter schema; execute delegates to lib function.
- **Commit**: `feat: register all tools via Pi extension entry point`

### Cycle 9: Documentation

- **Covers**: README with installation, tool reference, and usage examples.
- **Commit**: `docs: add README with tool reference and setup instructions`

## Risks and Mitigations

### Could this silently weaken a permission?

No. This extension registers new tools — it does not modify any permission surface, policy, or gate in `pi-permission-system`.
The tools invoke `gh` CLI commands via `child_process.spawn`, which flow through Pi's normal bash permission gate if the permission system is active.

### `gh` CLI availability

All tools depend on the `gh` CLI being installed and authenticated.
**Mitigation**: Tools return a clear `isError: true` result if `gh` is not found or auth fails, rather than crashing.

### `onUpdate` API stability

Pi's `AgentToolUpdateCallback` type is not documented as stable.
**Mitigation**: The progress adapter is a single function — easy to update if the API changes.

### Module-scope cache for `detectRepo()`

A module-scope `cachedRepo` variable works here because this is a single extension loaded once — unlike `pi-permission-system`, there's no jiti isolation concern within the same extension.
**Mitigation**: Document the caching behavior; expose a `resetRepoCache()` for tests.

### Exponential backoff timing in tests

Testing real backoff delays would make tests slow.
**Mitigation**: Mock `sleep()` in tests; test `findRetryDelay` as a pure function separately.

## Open Questions

1. **Workflow name defaults** — Should tools default to a workflow name (e.g., `ci.yml`) or require it explicitly?
   Leaning toward requiring it — workflow names vary across projects.
   The `promptSnippet` can guide the LLM.
2. **Release-please detection heuristic** — Should `release_pr_find` search by label (`autorelease: pending`) or title pattern (`chore(main): release`)?
   Both are release-please conventions.
   May need to try both.
3. **`release_pr_merge` merge strategy** — The issue says `--rebase`.
   Some repos use `--squash` or `--merge`.
   Consider making it a parameter with a default.
4. **TypeBox version alignment** — Pi uses `typebox` v1.
   Confirm the extension's `peerDependencies` should declare `typebox` v1 or rely on Pi's copy.
