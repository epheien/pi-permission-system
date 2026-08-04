import type { PlatformPath } from "node:path";
import { posix as posixPath, win32 as winPath } from "node:path";

import {
  type BashTokenShape,
  classifyWin32BashToken,
} from "#src/access-intent/bash/msys-bash-tokens";
import type { WildcardMatchOptions } from "#src/wildcard-matcher";

/**
 * The resolved product of the single win32-vs-POSIX platform decision: the
 * platform's path *language* as one immutable collaborator.
 *
 * The win32-vs-POSIX difference is not variant growth (the set is closed) but
 * **connascence of algorithm** — every path leaf must re-derive the same
 * mapping identically, and in a permission system a leaf that misses the case
 * fold or separator fold is a silent bypass (the #382 / #508 class). `PathFlavor`
 * captures that mapping once so the leaves consume the resolved capability
 * instead of re-interpreting a raw `NodeJS.Platform` string. It owns platform
 * **semantics** — syntax ({@link hasPathSeparator}), token shape
 * ({@link bashTokenShape}), and the equivalence relation ({@link fold} /
 * {@link comparable} / {@link isWithin} / {@link matchOptions}); domain policy
 * (lexical cleanup, alias generation, safe-system-path exclusions, rule
 * dispatch) stays in the functions that consume it.
 */
export interface PathFlavor {
  /**
   * Node's own platform path strategy (`path.win32` | `path.posix`). Exposed
   * directly — its post-migration consumers are all path-domain primitives and
   * `PlatformPath` is itself a maintained strategy object, so wrapping it would
   * be pure forwarding.
   */
  readonly impl: PlatformPath;
  /**
   * Wildcard match options for path-surface rule matching: the win32
   * case-and-separator fold, or `undefined` on POSIX.
   */
  readonly matchOptions: WildcardMatchOptions | undefined;
  /** Comparison case fold: win32 lowercases, POSIX returns the value unchanged. */
  fold(value: string): string;
  /**
   * Resolve `pathValue` against `base`, normalize, and fold — the single home
   * of the #382 case-fold invariant for absolute comparison values.
   */
  comparable(pathValue: string, base: string): string;
  /** `path.relative`-based containment: is `pathValue` `directory` itself or nested inside it? */
  isWithin(pathValue: string, directory: string): boolean;
  /**
   * True when `token` contains a path separator under this platform: `/` on
   * POSIX; `/` or `\` on win32 (where a backslash is a separator, #520).
   */
  hasPathSeparator(token: string): boolean;
  /**
   * The MSYS/Git-Bash interpretation of a bash-command token. On win32 this
   * carries device / drive-mount / posix-absolute / plain semantics; on POSIX
   * every token is an ordinary path, so the shape is always `{ kind: "plain" }`.
   */
  bashTokenShape(token: string): BashTokenShape;
}

class PlatformPathFlavor implements PathFlavor {
  readonly matchOptions: WildcardMatchOptions | undefined;

  constructor(
    readonly impl: PlatformPath,
    private readonly windows: boolean,
  ) {
    this.matchOptions = windows
      ? { caseInsensitive: true, windowsSeparators: true }
      : undefined;
  }

  fold(value: string): string {
    return this.windows ? value.toLowerCase() : value;
  }

  comparable(pathValue: string, base: string): string {
    return this.fold(this.impl.normalize(this.impl.resolve(base, pathValue)));
  }

  isWithin(pathValue: string, directory: string): boolean {
    if (!pathValue || !directory) return false;
    if (pathValue === directory) return true;
    const rel = this.impl.relative(directory, pathValue);
    return (
      rel !== "" &&
      rel !== ".." &&
      !rel.startsWith(`..${this.impl.sep}`) &&
      !this.impl.isAbsolute(rel)
    );
  }

  hasPathSeparator(token: string): boolean {
    return token.includes("/") || (this.windows && token.includes("\\"));
  }

  bashTokenShape(token: string): BashTokenShape {
    return this.windows ? classifyWin32BashToken(token) : { kind: "plain" };
  }
}

export const posixPathFlavor: PathFlavor = new PlatformPathFlavor(
  posixPath,
  false,
);
export const win32PathFlavor: PathFlavor = new PlatformPathFlavor(
  winPath,
  true,
);

/** The one win32-vs-POSIX platform decision in the package. */
export function pathFlavorForPlatform(platform: NodeJS.Platform): PathFlavor {
  return platform === "win32" ? win32PathFlavor : posixPathFlavor;
}
