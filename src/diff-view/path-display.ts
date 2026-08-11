import { isAbsolute, relative } from "node:path";
import type { PathStyle } from "./keybindings.js";

export type { PathStyle };

export function formatDisplayPath(
  path: string,
  style: PathStyle,
  cwd: string,
): string {
  if (style !== "short" || !cwd) return path;
  if (!isAbsolute(path)) return path;

  const rel = relative(cwd, path);
  if (!rel) return path;
  const outside =
    rel === ".." ||
    rel.startsWith("../") ||
    rel.startsWith("..\\") ||
    isAbsolute(rel);
  return outside ? path : rel;
}
