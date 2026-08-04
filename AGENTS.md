# AGENTS.md

## Repository status

This directory is the `@gotgenes/pi-permission-system` package, extracted from the `gotgenes/pi-packages` pnpm workspace monorepo.
It was `packages/pi-permission-system/` there; the monorepo lives at `/Users/eph/wsp/pi-packages` locally.
It is now a **standalone repository** with its own git remote (`origin` → `https://github.com/epheien/pi-permission-system.git`) and its own lockfile.
There is no `pnpm-workspace.yaml` here, so there are no workspace-wide `pnpm -r` / `--filter` semantics.
The monorepo's release-please + CI auto-publish flow is not wired into this repo.

**Launch Pi from this directory** — it is the repo root.
The old "start from the monorepo root" guidance no longer applies.

## Missing monorepo-root context

The monorepo root supplied `.pi/settings.json`, `.pi/prompts/`, and the full skill set; none of that is present in this repo, and Pi does not discover it from this CWD.

- Prompt templates (`/plan-issue`, `/tdd-plan`, `/ship-issue`, `/retro`, …) and root skills (`code-design`, `testing`, `markdown-conventions`, `mermaid`, `pre-completion`, `tidy-first`, …) are **not** loaded when Pi runs here.
- The authoritative package-specific skill is `package-pi-permission-system`, still at `/Users/eph/wsp/pi-packages/.pi/skills/package-pi-permission-system/SKILL.md`.
  Read it there for architecture priorities, the test-fixture inventory, and debugging guidance this file does not inline.
- The `/plan-issue` → `/tdd-plan` → `/ship-issue` → `/retro` life cycle runs from `/Users/eph/wsp/pi-packages`, not here.

## Package

`pi-permission-system` enforces deterministic permission gates (tool, bash, MCP, skill, special operations) so the agent cannot exceed its configured policy.
It began as a fork of `MasuRii/pi-permission-system` and has diverged substantially.

- `docs/architecture/architecture.md` — improvement phases, module tree, Mermaid roadmap; read before architectural changes.
- `docs/plans/` — one numbered plan per issue.
- `docs/decisions/` — ADRs.
- `docs/retro/` — per-session retrospective notes.
- `docs/plans/archive/` — pre-monorepo plans; issue numbers there refer to the upstream fork, not this repo.

`[#N]` / `Refs #N` / `(#N)` citations elsewhere refer to **`gotgenes/pi-packages`** issues — read them with `gh issue view N --repo gotgenes/pi-packages`, not web search.

## Commands

Use `pnpm` only — never `npm`/`npx`.
This is a standalone package, so run scripts directly (no `--filter`).
If `node_modules` lacks the binaries (a fresh clone), run `pnpm install` first.

- `pnpm run check` — `tsc --noEmit`
- `pnpm test` — vitest run (watch: `pnpm run test:watch`)
- `pnpm run lint` — biome + eslint + rumdl (`pnpm run lint:md` for markdown only)
- `pnpm run build:types` — `rollup -c rollup.dts.config.mjs` (also `prepack`)
- `pnpm run gen:schema` — regenerate `schemas/permissions.schema.json` from `src/config-schema.ts`; never hand-edit the schema (a parity test guards drift)
- `pnpm run verify:public-types` — `scripts/verify-public-types.sh`

## Core invariants

- Default to least privilege — when in doubt, prompt (`ask`), never silently allow.
- Enforce deterministically: the same policy + same input must always produce the same decision.
- The gate fails closed — a thrown gate is blocked and recorded (`permission_request.blocked`, `resolution: "gate_error"`), never allowed.
- Config files are the source of truth; do not bake policy into code.
- Keep `src/config-schema.ts`, `config/config.example.json`, `docs/configuration.md`, and `README.md` aligned when the config shape changes.
- Preserve the `/permission-system` slash command name — renaming it is a breaking change.
- In the permission map, `permission["*"]` is the universal fallback; pattern ordering is last-match-wins.
- The four path layers (`path`, `external_directory`, per-tool, `bash`) compose with most-restrictive-wins across surfaces.
- Wildcard matching must be explicit and tested — silent over-matching is a permission bypass.

## Workflow

- Keep scope tight.
- Prefer small, reversible changes.
- Preserve intentional behavior unless there is a clear reason to change it.
- Ask before removing functionality or changing defaults.
- Do not edit `CHANGELOG.md` — release-please owns it.
