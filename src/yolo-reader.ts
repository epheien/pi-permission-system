/**
 * Defensive read of the yolo-mode predicate.
 *
 * Two seams consult yolo mid-decision (the `tool_call` fail-closed boundary and
 * the gate runner's pre-resolved normalization). A reader that throws must not
 * mask a real gate failure: an unreadable flag falls back to `false` — yolo
 * off — so the fail-closed default is preserved.
 */
export function readYoloSafe(isYoloEnabled: () => boolean): boolean {
  try {
    return isYoloEnabled();
  } catch {
    return false;
  }
}
