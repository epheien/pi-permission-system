import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  resolveNodeText,
  SKIP_SUBTREE_TYPES,
} from "#src/access-intent/bash/node-text";
import { makeTSNode } from "#test/helpers/fake-ts-node";

describe("SKIP_SUBTREE_TYPES", () => {
  it("contains the three node types that must not be descended", () => {
    expect(SKIP_SUBTREE_TYPES.has("heredoc_body")).toBe(true);
    expect(SKIP_SUBTREE_TYPES.has("heredoc_end")).toBe(true);
    expect(SKIP_SUBTREE_TYPES.has("comment")).toBe(true);
  });

  it("does not contain common argument node types", () => {
    expect(SKIP_SUBTREE_TYPES.has("word")).toBe(false);
    expect(SKIP_SUBTREE_TYPES.has("string")).toBe(false);
    expect(SKIP_SUBTREE_TYPES.has("raw_string")).toBe(false);
  });
});

describe("resolveNodeText", () => {
  describe("word nodes", () => {
    it("returns the node text unchanged", () => {
      expect(resolveNodeText(makeTSNode("word", "hello"))).toBe("hello");
    });
  });

  describe("raw_string nodes (single-quoted)", () => {
    it("strips surrounding single quotes", () => {
      expect(resolveNodeText(makeTSNode("raw_string", "'content'"))).toBe(
        "content",
      );
    });

    it("strips single quotes around a path", () => {
      expect(resolveNodeText(makeTSNode("raw_string", "'/etc/hosts'"))).toBe(
        "/etc/hosts",
      );
    });

    it("returns text as-is when not fully single-quoted", () => {
      // A raw_string node without enclosing quotes (defensive fallback)
      expect(resolveNodeText(makeTSNode("raw_string", "noquotes"))).toBe(
        "noquotes",
      );
    });
  });

  describe("string nodes (double-quoted)", () => {
    it("concatenates inner word children, skipping quote delimiters", () => {
      const quoteOpen = makeTSNode('"', '"');
      const content = makeTSNode("string_content", "hello world");
      const quoteClose = makeTSNode('"', '"');
      const node = makeTSNode("string", '"hello world"', [
        quoteOpen,
        content,
        quoteClose,
      ]);
      expect(resolveNodeText(node)).toBe("hello world");
    });

    it("concatenates multiple inner children", () => {
      const quoteOpen = makeTSNode('"', '"');
      const part1 = makeTSNode("string_content", "foo");
      const part2 = makeTSNode("simple_expansion", "$BAR");
      const quoteClose = makeTSNode('"', '"');
      const node = makeTSNode("string", '"foo$BAR"', [
        quoteOpen,
        part1,
        part2,
        quoteClose,
      ]);
      expect(resolveNodeText(node)).toBe("foo$BAR");
    });

    it("returns empty string for an empty double-quoted string", () => {
      const quoteOpen = makeTSNode('"', '"');
      const quoteClose = makeTSNode('"', '"');
      const node = makeTSNode("string", '""', [quoteOpen, quoteClose]);
      expect(resolveNodeText(node)).toBe("");
    });
  });

  describe("string_content, simple_expansion, and expansion nodes", () => {
    it("returns text as-is for string_content", () => {
      expect(resolveNodeText(makeTSNode("string_content", "plain text"))).toBe(
        "plain text",
      );
    });

    it("resolves a plain $HOME reference to the home directory", () => {
      // The children matter: the resolver discriminates a plain reference from
      // an operator-bearing expansion structurally, not by text prefix (#694).
      const node = makeTSNode("simple_expansion", "$HOME", [
        makeTSNode("$", "$"),
        makeTSNode("variable_name", "HOME"),
      ]);
      expect(resolveNodeText(node)).toBe(homedir());
    });

    it("resolves a plain ${HOME} reference to the home directory", () => {
      const node = makeTSNode("expansion", "${HOME}", [
        makeTSNode("${", "${"),
        makeTSNode("variable_name", "HOME"),
        makeTSNode("}", "}"),
      ]);
      expect(resolveNodeText(node)).toBe(homedir());
    });

    it("returns text as-is for a variable outside the resolvable set", () => {
      const node = makeTSNode("expansion", "${VAR}", [
        makeTSNode("${", "${"),
        makeTSNode("variable_name", "VAR"),
        makeTSNode("}", "}"),
      ]);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal — a braced shell expansion, not a template string
      expect(resolveNodeText(node)).toBe("${VAR}");
    });

    it("returns text as-is for an expansion carrying an operator", () => {
      const node = makeTSNode("expansion", "${HOME:-/tmp}", [
        makeTSNode("${", "${"),
        makeTSNode("variable_name", "HOME"),
        makeTSNode(":-", ":-"),
        makeTSNode("word", "/tmp"),
        makeTSNode("}", "}"),
      ]);
      // biome-ignore lint/suspicious/noTemplateCurlyInString: intentional literal — a braced shell expansion, not a template string
      expect(resolveNodeText(node)).toBe("${HOME:-/tmp}");
    });
  });

  describe("concatenation nodes", () => {
    it("concatenates resolved children", () => {
      const word = makeTSNode("word", "/etc/");
      const expansion = makeTSNode("simple_expansion", "$FILE", [
        makeTSNode("$", "$"),
        makeTSNode("variable_name", "FILE"),
      ]);
      const node = makeTSNode("concatenation", "/etc/$FILE", [word, expansion]);
      expect(resolveNodeText(node)).toBe("/etc/$FILE");
    });

    it("concatenates a resolved $HOME reference with its suffix", () => {
      const expansion = makeTSNode("simple_expansion", "$HOME", [
        makeTSNode("$", "$"),
        makeTSNode("variable_name", "HOME"),
      ]);
      const suffix = makeTSNode("word", "/sub");
      const node = makeTSNode("concatenation", "$HOME/sub", [
        expansion,
        suffix,
      ]);
      expect(resolveNodeText(node)).toBe(`${homedir()}/sub`);
    });

    it("handles nested concatenation-of-string", () => {
      // A concatenation whose child is a double-quoted string
      const quoteOpen = makeTSNode('"', '"');
      const content = makeTSNode("string_content", "bar");
      const quoteClose = makeTSNode('"', '"');
      const inner = makeTSNode("string", '"bar"', [
        quoteOpen,
        content,
        quoteClose,
      ]);
      const prefix = makeTSNode("word", "foo");
      const node = makeTSNode("concatenation", 'foo"bar"', [prefix, inner]);
      expect(resolveNodeText(node)).toBe("foobar");
    });
  });

  describe("default fallback", () => {
    it("returns the raw text for unknown node types", () => {
      expect(resolveNodeText(makeTSNode("unknown_type", "rawtext"))).toBe(
        "rawtext",
      );
    });
  });
});
