# Migration guide: forwarded asks and the bounded-delegation checkpoint

Starting with the release that closes #635, a permission request forwarded up from a subagent carries the **child-fixed access facts** through to the authorizer chain.
As a side effect, the bounded-delegation checkpoint now applies to forwarded asks the same way it already applied to local ones.
This is a **breaking change** for one narrow configuration.

## Who is affected

You are affected only if **all** of the following hold:

- You name an authorizer chain link in `authorizerChain`, and
- that link is **allow-capable** (it can return `allow`, not only `deny` / `defer`), and
- a subagent forwards an `ask` to your session that was raised by the `path` or `external_directory` gate.

If you run no chain link, or run only a deny-first link — including the first-party [`@gotgenes/pi-permission-model-judge`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-model-judge), which only ever denies or defers — **nothing changes for you**.

## What changed

The checkpoint downgrades a link's `allow` to `defer` on the excluded surfaces (`path`, `external_directory`), so the request falls through to an interactive prompt instead.
It selects the surface from the **gate** surface — the surface the matching rule lives on — falling back to the displayed surface when no gate surface is available.

A forwarded request previously arrived with no gate surface, so the checkpoint fell back to the child's *display* surface, which is the tool name (`write`, `edit`, `read`).
A tool name is not an excluded surface, so a link's `allow` on a forwarded `path`-gated request was honored.
The identical request made directly in the same session was capped, because a local request always carries its gate surface.

Forwarding was therefore a way around your own delegation boundary: a link could approve `~/.ssh/config` for a subagent that it could not approve for the main session.
Now the gate surface crosses the forwarding hop, and both paths behave identically.

Unchanged: a forwarded `bash` ask, and a forwarded tool ask gated by a per-tool rule (`write: ask`), are both already on non-excluded surfaces and are not capped.
`deny` and `defer` verdicts were never capped and still are not.

## What you need to do

Nothing, unless you run an allow-capable link.

If you do, expect an interactive prompt where that link previously auto-approved a forwarded subagent request for a path.
To keep such a request from prompting, grant it in policy rather than through the link — the `path` and `external_directory` rules in your config are consulted before the chain runs, so an `allow` there resolves the request without reaching an authorizer at all.

## Related

Issue #620 will replace the whole-`path` exclusion with a narrower secret-shaped one, letting a link allow a non-secret path again while keeping secret-shaped paths capped.
That refinement applies to local and forwarded asks alike, so the two paths stay aligned.
