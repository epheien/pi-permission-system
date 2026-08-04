# Migration guide: project-trust gating

Starting with the release that closes #644, the permission-system loads project-scoped configuration only after Pi reports the project as **trusted** (`ctx.isProjectTrusted()`).
This is a **breaking change** in how config is loaded in an untrusted directory.

## What changed

The extension used to load project-scoped config from the current working directory unconditionally — it never consulted Pi's project-trust decision.
Because project scope has higher precedence than global, an untrusted repository could ship a `.pi/extensions/pi-permission-system/config.json` that **loosened** an operator's global policy before the user granted trust — for example flipping a global `bash: deny` to `bash: allow`, or setting `yoloMode: true`.

Now, when the project is **not** trusted:

- Project and project-agent **permission policy** scopes are not loaded — only global (and global-agent) policy participates in resolution.
- Project **runtime config** (`yoloMode`, `permissionReviewLog`, `piInfrastructureReadPaths`, `shellTools`, `authorizerChain`, …) is not merged.
- Each skip is surfaced loudly: a UI warning and a `project_trust.skipped` entry in the permission review log.

This aligns the extension with Pi's own trust model, which already withholds project-local skills, prompts, and agents from untrusted directories.

## Timing and recovery

Pi resolves the trust decision (including any `defaultProjectTrust` setting) before `session_start`, so the guard sees the effective decision from the first tool call.
If you grant trust after the session starts, Pi fires `resources_discover` with `reason: "reload"`, and the extension re-reads trust and loads the project **policy** at that point.
Project **runtime** config (e.g. `yoloMode`) is re-read on the next session start.

## What you need to do

If you only use global config, nothing changes.

If you rely on a project's `.pi/extensions/pi-permission-system/config.json`, **grant the project trust** when Pi prompts (or configure `defaultProjectTrust` to always trust).
Until then, the project's permission rules and runtime knobs are ignored and only your global policy applies.

If a project's rules stop taking effect after upgrading (surfaces you allowed at the project scope start prompting or denying per global policy), check whether the project is trusted — the review log will contain a `project_trust.skipped` entry naming the untrusted `cwd`.
