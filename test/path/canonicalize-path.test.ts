import { beforeEach, describe, expect, test, vi } from "vitest";

const realpathSync = vi.hoisted(() => vi.fn<(path: string) => string>());

vi.mock("node:fs", () => ({
  realpathSync,
  default: { realpathSync },
}));

import { canonicalizePath } from "#src/path/canonicalize-path";
import { posixPathFlavor, win32PathFlavor } from "#src/path/path-flavor";

function enoent(p: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: no such file or directory '${p}'`), {
    code: "ENOENT",
  });
}

describe("canonicalizePath", () => {
  beforeEach(() => {
    realpathSync.mockReset();
  });

  test("returns empty string for empty input", () => {
    expect(canonicalizePath("", posixPathFlavor)).toBe("");
  });

  test("returns realpathSync result when path exists", () => {
    realpathSync.mockReturnValueOnce("/real/projects/app");
    expect(canonicalizePath("/projects/link", posixPathFlavor)).toBe(
      "/real/projects/app",
    );
  });

  test("re-appends a non-existent leaf to the canonical parent", () => {
    realpathSync
      .mockImplementationOnce(() => {
        throw enoent("/projects/app/new-file.ts");
      })
      .mockReturnValueOnce("/canonical/app");
    expect(canonicalizePath("/projects/app/new-file.ts", posixPathFlavor)).toBe(
      "/canonical/app/new-file.ts",
    );
  });

  test("walks up multiple levels for a deeply non-existent path", () => {
    realpathSync
      .mockImplementationOnce(() => {
        throw enoent("/projects/app/src/new-file.ts");
      })
      .mockImplementationOnce(() => {
        throw enoent("/projects/app/src");
      })
      .mockImplementationOnce(() => {
        throw enoent("/projects/app");
      })
      .mockReturnValueOnce("/canonical/projects");
    expect(
      canonicalizePath("/projects/app/src/new-file.ts", posixPathFlavor),
    ).toBe("/canonical/projects/app/src/new-file.ts");
  });

  test("returns input unchanged when walk reaches filesystem root (all ENOENT)", () => {
    realpathSync.mockImplementation(() => {
      throw enoent("");
    });
    expect(canonicalizePath("/nonexistent/path/file.ts", posixPathFlavor)).toBe(
      "/nonexistent/path/file.ts",
    );
  });

  test("returns input unchanged on ELOOP (symlink loop)", () => {
    realpathSync.mockImplementation(() => {
      throw Object.assign(new Error("ELOOP"), { code: "ELOOP" });
    });
    expect(canonicalizePath("/some/looping/path", posixPathFlavor)).toBe(
      "/some/looping/path",
    );
  });

  test("returns input unchanged on EACCES (permission denied)", () => {
    realpathSync.mockImplementation(() => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    });
    expect(canonicalizePath("/restricted/path", posixPathFlavor)).toBe(
      "/restricted/path",
    );
  });

  test("handles ENOTDIR by walking up (like ENOENT)", () => {
    realpathSync
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" });
      })
      .mockReturnValueOnce("/real/parent");
    expect(canonicalizePath("/real/parent/not-a-dir", posixPathFlavor)).toBe(
      "/real/parent/not-a-dir",
    );
  });

  // ── injected platform flavor (win32-separator splitting) ──────────────

  test("win32: splits and rejoins on the backslash separator", () => {
    realpathSync
      .mockImplementationOnce(() => {
        throw enoent("C:\\projects\\link\\file.ts");
      })
      .mockReturnValueOnce("C:\\real\\app");
    expect(
      canonicalizePath("C:\\projects\\link\\file.ts", win32PathFlavor),
    ).toBe("C:\\real\\app\\file.ts");
  });

  test("win32: resolves an existing path via realpathSync", () => {
    realpathSync.mockReturnValueOnce("C:\\real\\app");
    expect(canonicalizePath("C:\\projects\\link", win32PathFlavor)).toBe(
      "C:\\real\\app",
    );
  });
});
