---
package: pi-permission-system
phase: 12
---

# Retro: pi-permission-system — Phase 12 Planning (cross-session-intent-authorizer-chain)

## Stage: Improvement Planning (2026-07-15T18:03:28Z)

### Session summary

The cause hypothesis — corroborated by the code trace — is a boundary flaw at the escalation edge: the gate's structured `AccessIntent`/`AccessPath` product dies at the session boundary, so a forwarded request carries only display-only `surface`/`value` strings and the serving node re-derives a child's path through the **parent's** `PathNormalizer`/cwd (the declared Phase 12 candidate from the Phase 11 planning record).
Phase 12 is a **full two-track phase**: Track A (Steps 1–3) is the cross-session access-intent spine that dissolves `#565` items 2–3; Track B (Steps 4–6) implements `#472`'s deny-first slice on the `Authorizer` chain that ADR 0007 designed.
The deferral gate did not fire — two independent cause-level (Category C) findings survived discovery.

### Observations

- **Cause traced to code, not fallow.**
  The spine is principle-driven: `ForwardedPermissionRequest` carries `message` + optional display `surface`/`value`; `ServingPolicy.check(surface, value)` re-interprets a bare string via the parent's normalizer; `hasDisplayFields` floors a display-less request to `ask`.
  Fallow (health 88 A, dead code 0, dup 0.1%) supplied only baselines — cited as symptoms, never as a step's motivation.
- **`#565` was the designed probe.**
  Its items 2 (undefined agent-scope semantics) and 3 (single-`(surface, value)` re-resolution lossiness) name exactly the two losses; both were accepted at `#557` ship time pending this spine.
  Kept open through Phase 12 by user decision, closes at phase end with an item-1 (external-consumer fidelity) best-effort note — no in-monorepo notification consumer exists to verify against.
- **`#472` scheduled after three consecutive deferrals.**
  ADR 0007 (`docs/decisions/0007-model-judge-authorizer-chain-adr.md`) is accepted and explicitly assigns the implementation's decomposition "to the next `/plan-improvements` pass" — this pass.
  User chose to schedule it (Track B).
  The decomposition follows ADR 0007's own capability gradient: deny-first typo-path reviewer ships (`deny | defer` only); the allow-capable opaque-bash adjudicator stays deferred.
- **`#519` kept open with recorded rationale** (user decision, not a silent re-defer): externally blocked on Pi SDK `UIContext` evolution; the `select`/`input` fallback covers frontends meanwhile.
- **Feasibility probes reshaped nothing but confirmed both tracks.**
  `@earendil-works/pi-ai` exports `complete`/`completeSimple` (verified in the installed `0.79.1` `.d.ts`) and pi-subagents already depends on it, so the Step 6 dogfood judge can invoke a model on the real surface.
  `registerAuthorizer` mirrors the existing `registerToolAccessExtractor`/`registerToolInputFormatter` service precedent — no new SDK surface needed.
  The `authorizerChain` config carry-through must go through `mergeUnifiedConfigs()` (the `#332`/`#347` drop class, now compiler-flagged post-`#356`).
- **Deferral gate / craftsmanship scout.**
  The scout found no concentrated debt.
  The two fallow "giant function" test flags (`program.test.ts` 921 lines, `bash-external-directory.test.ts` 879 lines) are **false positives** — nested `describe` trees of small behavior-named tests, not fused mega-tests; confirmed by spot-reading both.
  Churn-hotspot test files all use the shared `test/helpers/` fixtures cleanly.
  The only real finding (a flat ungrouped test run in `permission-manager-unified.test.ts`) is scattered mechanical trivia → boy-scout tidying, not a phase step.
  First-live-use calibration of the scout's concentrated/scattered split: I spot-checked one flagged-scattered file (`permission-manager-unified.test.ts:1712+`, confirmed ~50 flat well-named tests under a comment banner) and the two flagged-false-positive files — the calls matched my own read.
- **No directory reorg this phase.**
  Root is 56 modules (already domain-grouped: `access-intent/`, `authority/`, `handlers/`, `path/`).
  Both tracks land in the existing `authority/` domain plus a new top-level package; the next flat-root grouping opportunity should ride a phase that rewrites those files (tidy-first), not a big-bang move.
- **Release shape:** two batches (`cross-session-intent` = Steps 1–3, tail Step 3; `authorizer-chain` = Steps 4–5, tail Step 5) plus Step 6 independently releasable (a new package with its own release-please component, lands after Step 5).
  The Step 1 and Step 4 ADR/infra steps have no cross-track dependency, so `#595` and `#598` can start in parallel.
