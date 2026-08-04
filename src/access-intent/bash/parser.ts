import { createRequire } from "node:module";
import { memoizeAsyncWithRetry } from "#src/async-cache";

/**
 * Minimal subset of web-tree-sitter's SyntaxNode used by the AST walker.
 * Defined locally so callers do not need to import web-tree-sitter types.
 */
export interface TSNode {
  readonly type: string;
  readonly text: string;
  /** Absolute byte offset of this node's start in the parsed source. */
  readonly startIndex: number;
  readonly childCount: number;
  /** False for anonymous tokens (operators, delimiters); true for named nodes. */
  readonly isNamed: boolean;
  child(index: number): TSNode | null;
}

/**
 * Minimal subset of web-tree-sitter's Parser used by this module.
 */
interface TSParser {
  parse(input: string): { rootNode: TSNode; delete(): void } | null;
  delete(): void;
}

async function initParser(): Promise<TSParser> {
  // Use named imports — web-tree-sitter exports Parser as a named class.
  const { Parser, Language } = await import("web-tree-sitter");
  const req = createRequire(import.meta.url);
  const treeSitterWasm = req.resolve("web-tree-sitter/web-tree-sitter.wasm");
  await Parser.init({ locateFile: () => treeSitterWasm });

  const parser = new Parser();
  const bashWasm = req.resolve("tree-sitter-bash/tree-sitter-bash.wasm");
  const bash = await Language.load(bashWasm);
  parser.setLanguage(bash);
  return parser;
}

// Memoize on success but drop a rejected result so a transient init failure
// (e.g. a slow WASM load) is retried on the next tool call instead of poisoning
// the parser for the process lifetime.
export const getParser = memoizeAsyncWithRetry(initParser);

// Resolved parser cached for synchronous access after warm-up. The tree-sitter
// parser is stateless (parse is a pure function of its input), so caching it at
// module scope is safe even though module state now persists across same-cwd
// session switches.
let warmedParser: TSParser | null = null;

/**
 * Warm the tree-sitter parser so {@link getWarmBashParser} can hand it out
 * synchronously. Triggered at `before_agent_start` (which precedes any tool
 * call) so the synchronous advisory bash path can decompose at gate parity
 * (#309).
 *
 * Best-effort and idempotent: it swallows a WASM init failure (the sync
 * accessor stays cold and callers fall back to whole-string matching), and it
 * returns immediately once warm, so calling it every turn is free.
 */
export async function warmBashParser(): Promise<void> {
  if (warmedParser) return;
  try {
    warmedParser = await getParser();
  } catch {
    // Leave cold → advisory bash queries fall back to whole-string matching.
    // getParser's own retry memoization re-attempts init on the next call.
  }
}

/**
 * The warmed parser for synchronous use, or `null` when it has not been warmed
 * yet (the pre-warm window). Callers that get `null` must degrade gracefully.
 */
export function getWarmBashParser(): TSParser | null {
  return warmedParser;
}

/** Test-only: clear the warmed-parser cache so cold/warm cases are isolatable. */
export function resetWarmBashParser(): void {
  warmedParser = null;
}
