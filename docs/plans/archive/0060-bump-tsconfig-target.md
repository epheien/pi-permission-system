---
issue: 60
issue_title: "Investigate bumping tsconfig target/lib to ES2023+"
---

# Investigate bumping tsconfig target/lib to ES2023+

## Problem Statement

The project pins `target: ES2022` in `tsconfig.json` (with no explicit `lib`), mirroring pi-mono's `tsconfig.base.json`.
Node ≥ 20 is required, and Node 20 fully supports ES2023 APIs (`findLast`, `Array.fromAsync`, `Object.groupBy`, etc.) at runtime.
Since `noEmit: true`, bumping `lib`/`target` only affects type-checking — there is zero runtime risk.
The current constraint forces manual workarounds (reverse loops instead of `findLast`) and a corresponding AGENTS.md rule that forbids post-ES2022 APIs.

## Goals

- Determine whether pi-mono's ES2022 pin is intentional policy or inertia.
- If safe, bump `lib` (and optionally `target`) to `ES2023` so newer built-in type definitions are available.
- Update `AGENTS.md` to reflect the new minimum (remove the ES2022 restriction, document ES2023 as the floor).
- Simplify any existing manual workarounds that `findLast` or other ES2023 APIs would replace.

## Non-Goals

- Bumping to ES2024 or later — out of scope; ES2023 is the conservative step.
- Proposing the bump upstream in pi-mono — that can be done independently.
- Refactoring code that does not benefit from ES2023 APIs.

## Background

- `tsconfig.json` sets `target: ES2022`, no explicit `lib` (inherits from target).
- `AGENTS.md` lines 47–48 explicitly forbid post-ES2022 APIs.
- Issue #55 (closed) required replacing `findLast` with a manual loop (commit `1911f37`).
- `src/rule.ts` `evaluate()` and `src/wildcard-matcher.ts` `findCompiledWildcardMatch` use reverse iteration that `findLast` would simplify.
- pi-mono's `tsconfig.base.json` pins `ES2022` with `engines.node: ">=20.0.0"`.

### Permission surface

None — this is a build/tooling change with no permission semantics impact.

## Design Overview

Since `noEmit: true`, both `target` and `lib` only gate which type definitions TypeScript makes available.
Bumping either (or both) to `ES2023` has identical effect: `Array.prototype.findLast`, `Array.prototype.findLastIndex`, and related types become available.

### Decision

Bump both `target` and `lib` to `ES2023`.
Rationale: with `noEmit: true` there is no emitted-code difference between the two fields, and keeping them aligned is simplest.
This diverges from pi-mono's base config, which is acceptable — this repo already has its own `tsconfig.json`.

## Module-Level Changes

| File                      | Change                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `tsconfig.json`           | Set `target: "ES2023"` (lib inherits automatically).                                      |
| `AGENTS.md`               | Update lines 47–48: replace ES2022 floor with ES2023; list newly allowed APIs.            |
| `src/wildcard-matcher.ts` | Replace manual reverse loop in `findCompiledWildcardMatch` with `findLast` if applicable. |
| `src/rule.ts`             | Replace manual reverse loop in `evaluate()` with `findLast` if applicable.                |

## TDD Order

1. **feat: bump tsconfig target to ES2023** — Change `target` in `tsconfig.json`.
   Run `pnpm run build` to verify no type errors.
   Commit: `feat: bump tsconfig target to ES2023 (#60)`.
2. **docs: update AGENTS.md ES2022 constraint to ES2023** — Rewrite the two-line restriction.
   Commit: `docs: update AGENTS.md ES version floor to ES2023 (#60)`.
3. **refactor: use findLast in wildcard-matcher and rule** — Replace manual reverse loops with `findLast`.
   Existing tests must continue to pass (no new tests needed — behavior is unchanged).
   Commit: `refactor: use findLast in evaluate and wildcard matcher (#60)`.

## Risks and Mitigations

| Risk                                     | Mitigation                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Could this silently weaken a permission? | No — purely a type-checking change; no permission logic is altered.                                   |
| Diverging from pi-mono tsconfig          | Acceptable — this repo already maintains its own tsconfig. Document the divergence in a code comment. |
| `findLast` not available at runtime      | Node ≥ 20 is required by `engines.node`; `findLast` shipped in Node 18.0. No risk.                    |

## Open Questions

- Whether to propose the same bump upstream in pi-mono (deferred — independent concern).
