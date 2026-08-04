---
issue: 88
issue_title: "Track and report provenance of each permission rule"
---

# Retro: #88 — Track and report provenance of each permission rule

## Final Retrospective (2026-05-05T14:50:00Z)

### Session summary

Added deterministic provenance tracking to every permission rule.
`Rule.origin` and `PermissionCheckResult.origin` are now required fields with 7 values covering all rule sources: config scopes (`"global"`, `"project"`, `"agent"`, `"project-agent"`), synthesized rules (`"builtin"`, `"baseline"`), and runtime approvals (`"session"`).
The dead `"override"` layer value was removed, review log entries include origin, and `/permission-system show` displays effective rules with their origin annotations.
Shipped as v5.0.0 (major bump due to breaking type change).
Filed #91 (bash external-directory false-positive on sed regex patterns) as a side-discovery.

### Observations

#### What went well

- The user's challenge ("Talk to me about why it's optional") was precisely timed — after the initial 7-step plan was implemented but before downstream code depended on the optional shape.
  This led to expanding `RuleOrigin` from 4 optional config-scope values to 7 required provenance values, which is a strictly better design: consumers never need to check for `undefined`.
- The origin-map approach (building a parallel `Map<surface, Map<pattern, RuleOrigin>>` alongside the existing `mergeFlatPermissions()` loop) preserved merge semantics perfectly with zero behavioral change to permission decisions.
  No bugs surfaced from the tracking logic itself.
- The `ask_user` interaction for the 7-value `RuleOrigin` design was efficient: two focused questions resolved the full type shape (`"builtin"` + `"baseline"` + `"session"`) without over-asking.

#### What caused friction (agent side)

- `instruction-violation` — When making `Rule.origin` required, I edited 4 source files (`src/rule.ts`, `src/synthesize.ts`, `src/types.ts`, `src/session-rules.ts`) before writing any tests.
  The user caught this: "Wait, we should always update tests first."
  I reverted all source changes with `git checkout -- src/` and restarted with test fixtures first.
  Impact: one revert cycle; no rework beyond re-applying the same edits in the correct order.
  **User-caught.**
- `other` — Used `sed` to bulk-add `origin: "builtin"` to `PermissionCheckResult` literals in `tests/tool-input-preview.test.ts`.
  The `sed` regex triggered a false-positive external-directory prompt (#91) because the `/source: "tool",/` pattern looked like an absolute path.
  Additionally, the `sed` command double-inserted `origin` on two objects that already had it (the tests added in step 5), causing `TS1117: duplicate property` errors.
  Impact: two follow-up edits to remove duplicates; filed #91.
- `other` — The `export type { RuleOrigin } from "./rule"` re-export in `src/types.ts` made `RuleOrigin` available to importers but not for local use within the same file.
  TypeScript errored with `TS2304: Cannot find name 'RuleOrigin'`.
  Required changing to `import type { RuleOrigin } from "./rule"; export type { RuleOrigin };`.
  Impact: one extra edit cycle, no rework.
- `missing-context` — Did not anticipate that `normalizeFlatConfig()` in `src/normalize.ts` constructs `Rule` objects without `origin`, which would fail when `origin` became required.
  Also missed `tests/normalize.test.ts` (11 deep-equal assertions), `tests/permission-prompts.test.ts`, `tests/skill-prompt-sanitizer.test.ts`, and `tests/handlers/tool-call.test.ts` during the initial test update pass.
  These all surfaced via `pnpm run build` after the test pass.
  Impact: multiple incremental fix rounds instead of one clean pass.

#### What caused friction (user side)

- The skill file read for `ask-user` at `/opt/homebrew/lib/node_modules/pi-ask-user/skills/ask-user/SKILL.md` triggered an external-directory permission prompt despite the #48 infrastructure read bypass.
  Investigation revealed that `discoverGlobalNodeModulesRoot()` walks up from the extension's own `import.meta.url` — when running from a local dev checkout (not inside a `node_modules` tree), it returns `null` and the global `node_modules` root is never added to `piInfrastructureDirs`.
  This is a real bug in development environments; production installations are unaffected.
  Filed as #93.
