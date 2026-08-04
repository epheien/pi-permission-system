import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Real-filesystem fixtures for tests that must exercise filesystem *state*
 * rather than lexical path logic — existence probes (`PathNormalizer.entryExists`)
 * and symlink resolution (`canonicalizePath`).
 *
 * Every directory created is registered for cleanup; call {@link TmpFixture.cleanup}
 * from an `afterEach`. Mirrors the `{ …, cleanup }` shape of `manager-harness.ts`.
 */
export interface TmpFixture {
  /** Create a registered temp directory and return its absolute path. */
  dir(prefix?: string): string;
  /**
   * Write a file under `parent` (creating intermediate directories) and return
   * its absolute path. `name` may contain separators (`sub/file.txt`).
   */
  file(parent: string, name: string, content?: string): string;
  /** Create a directory under `parent` and return its absolute path. */
  subdir(parent: string, name: string): string;
  /**
   * Create a symlink at `parent/name` pointing at `target`, and return the link's
   * absolute path. `target` need not exist — pass a nonexistent path to build a
   * dangling symlink.
   */
  symlink(parent: string, name: string, target: string): string;
  /** Remove every directory this fixture created. */
  cleanup(): void;
}

export function createTmpFixture(): TmpFixture {
  const roots: string[] = [];

  return {
    dir(prefix = "pi-perm-") {
      const created = mkdtempSync(join(tmpdir(), prefix));
      roots.push(created);
      return created;
    },

    file(parent, name, content = "") {
      const target = join(parent, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
      return target;
    },

    subdir(parent, name) {
      const target = join(parent, name);
      mkdirSync(target, { recursive: true });
      return target;
    },

    symlink(parent, name, target) {
      const link = join(parent, name);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link);
      return link;
    },

    cleanup() {
      while (roots.length > 0) {
        const root = roots.pop();
        if (root) rmSync(root, { recursive: true, force: true });
      }
    },
  };
}
