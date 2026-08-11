import { type KeyId, matchesKey } from "@earendil-works/pi-tui";
import type { PromptKey } from "#src/authority/permission-prompt-decision";
import type { DecisionKeybindings } from "#src/extension-config";

/**
 * Shared input-key → decision-action mapping for the overlay permission dialog
 * and the diff-view decision area. Both surfaces consume the same
 * {@link DecisionKeybindings} so a configured key behaves identically wherever
 * it appears.
 *
 * The decision lookup order is fixed: `approve → approveSession → deny →
 * denyWithReason`. When two actions share a key, the earlier action wins.
 */

export function matchDecisionHotkey(
  kb: DecisionKeybindings,
  data: string,
): PromptKey | undefined {
  if (matchesAny(kb.approve, data)) return "y";
  if (matchesAny(kb.approveSession, data)) return "s";
  if (matchesAny(kb.deny, data)) return "n";
  if (matchesAny(kb.denyWithReason, data)) return "r";
  return undefined;
}

export function matchNavUp(kb: DecisionKeybindings, data: string): boolean {
  return matchesAny(kb.navUp, data);
}

export function matchNavDown(kb: DecisionKeybindings, data: string): boolean {
  return matchesAny(kb.navDown, data);
}

export function matchConfirm(kb: DecisionKeybindings, data: string): boolean {
  return matchesAny(kb.confirm, data);
}

export function matchCancel(kb: DecisionKeybindings, data: string): boolean {
  return matchesAny(kb.cancel, data);
}

function matchesAny(keys: string[], data: string): boolean {
  return keys.some((key) => keyEq(data, key));
}

/**
 * Match input against one configured key.
 *
 * - **Single letters** compare strictly (`y` and `Y` are different keys, so
 *   `["Y", "s"]` keeps uppercase Y distinct from a default lowercase `y`).
 * - **Combinations / special keys** go through pi's `matchesKey`, which treats
 *   modifier-case equivalently (`ctrl+Y` ≡ `ctrl+y`) — modifier combos carry
 *   no case meaning.
 */
function keyEq(data: string, key: string): boolean {
  if (key.length === 1 && /[a-zA-Z]/.test(key)) {
    return data.length === 1 && data === key;
  }
  return matchesKey(data, key as KeyId);
}

/** Display labels for special keys in help/hint text. */
const KEY_LABELS: Record<string, string> = {
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  pageup: "PgUp",
  pagedown: "PgDn",
  home: "Home",
  end: "End",
  escape: "Esc",
  esc: "Esc",
  tab: "Tab",
  enter: "Enter",
};

export function keyLabel(key: string): string {
  return KEY_LABELS[key] ?? key;
}
