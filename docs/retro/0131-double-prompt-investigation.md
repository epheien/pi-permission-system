---
issue_title: "Investigate double-prompt on external directory permission checks"
---

# Retro: double-prompt investigation

## Final Retrospective (2026-05-08T14:45:00Z)

### Session summary

Investigated a user report that external-directory permission prompts required two Enter presses.
After extensive instrumentation and bisection, the root cause was the extension being loaded twice — once from the global `npm:@gotgenes/pi-permission-system` package and once from the project `.pi/settings.json` entry `"../"`.
Two handler instances meant two identical `ui.select` prompts for every gate check.
Fixed by suppressing the npm copy's extension in project settings with `{ "source": "npm:@gotgenes/pi-permission-system", "extensions": [] }`.
Also closed a testing gap with integration tests for session-rule dedup across sequential tool calls.

### Observations

#### What went well

- The instrumentation approach (file-based trace at multiple layers: handler entry, gate runner, prompter, `ui.select`) was effective once applied — it definitively proved one `ui.select` call per prompt.
- The integration tests written for session-rule dedup (`tests/handlers/external-directory-session-dedup.test.ts`) are genuine value — they use stateful mocks that model the real `checkPermission`/`approveSessionRule`/`getSessionRuleset` interaction, covering same-path, same-directory, different-directory, approve-once vs approve-for-session, and cross-tool (bash→read) scenarios.
- Bisection via `pi --no-extensions -e .` was the decisive experiment — it immediately proved the bug vanished in isolation.

#### What caused friction (agent side)

1. `rabbit-hole` — spent multiple instrumentation rounds and reload cycles investigating hypotheses (concurrent tool calls, working-indicator focus stealing, Pi TUI `ExtensionSelectorComponent` regression, forwarding poller interference) before checking the simplest environmental explanation: whether the extension was loaded twice.
   Impact: ~45 minutes of user time across 6+ reload-and-test cycles, 4 files instrumented then cleaned up, several dead-end hypotheses explored.

2. `missing-context` — did not inspect `.pi/settings.json` or cross-reference it with `~/.pi/agent/settings.json` early in the session.
   The project settings file was right there and showed both `"../"` and the global npm package loading the same extension.
   Impact: this single check would have resolved the investigation in minutes.

3. `premature-convergence` — after confirming Pi dispatches `beforeToolCall` sequentially (via the agent-loop source), concluded "the bug can't exist" and almost closed the investigation.
   The user had to push back ("From my perspective it seems to be the same prompt, twice") to keep investigating.
   Impact: nearly missed the real bug by trusting the theoretical model over the user's observation.

4. `wrong-abstraction` — early instrumentation wrote to `/tmp/gate-trace.log`, which bash commands like `: > /tmp/gate-trace.log` then truncated, destroying the trace.
   Switched to `/tmp/gate-trace-2.log` mid-investigation.
   Impact: lost trace data from several experiments, required re-running them.

#### What caused friction (user side)

- The user's initial framing ("two tool calls with the same path") sent the investigation toward concurrent-dispatch dedup, which was a plausible but incorrect hypothesis.
  Reframing to "I had to press Enter twice" and "I had to answer twice" were the pivotal observations that redirected the investigation.
  Opportunity: when reporting UI bugs, "what did the screen do" is more diagnostic than "what I think the system did."

### Changes made

1. `tests/handlers/external-directory-session-dedup.test.ts` — 6 integration tests for session-rule dedup across sequential tool calls.
2. `.pi/settings.json` — added `{ "source": "npm:@gotgenes/pi-permission-system", "extensions": [] }` to prevent double-loading.
3. `AGENTS.md` — added § Debugging with isolation-first heuristic.
4. Commented on [earendil-works/pi#4033](https://github.com/earendil-works/pi/issues/4033) with the cross-scope variant of the duplicate-package bug.
