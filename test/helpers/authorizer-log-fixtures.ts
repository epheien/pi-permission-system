import { vi } from "vitest";

/**
 * A fake `AuthorizerLog` / `DebugReviewLogger`: `review` and `debug` as
 * `vi.fn()` stubs.
 *
 * The return type is intentionally unannotated so callers keep full `Mock`
 * access (`toHaveBeenCalledWith`, `mock.calls`); the shape structurally
 * satisfies both the narrow authorizer-log seam and the session logger.
 */
export function makeAuthorizerLog() {
  return { review: vi.fn(), debug: vi.fn() };
}
