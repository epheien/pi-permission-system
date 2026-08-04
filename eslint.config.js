import path from "node:path";

import globals from "globals";
import tseslint from "typescript-eslint";

// ---------------------------------------------------------------------------
// Custom rule: no parent-relative imports
//
// Flags any `from "../..."` import in src/ or test/ and offers an auto-fix that
// rewrites to the package's #src/ or #test/ alias.
// Same-directory `./` imports are intentionally allowed.
// ---------------------------------------------------------------------------

/** @type {import("eslint").Rule.RuleModule} */
const noParentRelativeImports = {
  meta: {
    type: "suggestion",
    fixable: "code",
    messages: {
      noParent:
        'Use the #src/ or #test/ alias instead of a relative parent import ("{{value}}").',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const value = node.source.value;
        if (typeof value !== "string" || !value.startsWith("../")) return;

        const filePath = context.filename;
        const configDir = import.meta.dirname;
        const resolved = path.resolve(path.dirname(filePath), value);
        const rel = path.relative(configDir, resolved);
        // rel is e.g. "src/lib/args"
        const match = /^(src|test)\/(.+)$/.exec(rel);

        context.report({
          node: node.source,
          messageId: "noParent",
          data: { value },
          fix: match
            ? (fixer) =>
                fixer.replaceText(node.source, `"#${match[1]}/${match[2]}"`)
            : undefined,
        });
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Files that receive full type-aware linting. */
const PACKAGE_TS_FILES = ["src/**/*.ts", "test/**/*.ts"];

export default tseslint.config(
  // Global ignores
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      ".pi/**",
      ".fallow/**",
    ],
  },

  // Always report unused disable directives as errors so they don't
  // silently pile up when violations are fixed.
  { linterOptions: { reportUnusedDisableDirectives: "error" } },

  // Type-aware rules only — no overlap with Biome's non-type-aware lint.
  // Scoped to src/ and test/ so the projectService parser is only invoked
  // where a tsconfig covers the file.
  {
    files: PACKAGE_TS_FILES,
    extends: [
      tseslint.configs.recommendedTypeCheckedOnly,
      tseslint.configs.stylisticTypeCheckedOnly,
    ],
    plugins: {
      "local-rules": {
        rules: { "no-parent-relative-imports": noParentRelativeImports },
      },
    },
    rules: {
      // --- Import path enforcement ---
      "local-rules/no-parent-relative-imports": "error",

      // --- Cherry-picked strictTypeChecked rules ---
      // High-value: catches real bugs
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-unnecessary-condition": "error",
      "@typescript-eslint/no-misused-spread": "error",
      "@typescript-eslint/no-mixed-enums": "error",
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
      "no-return-await": "off",
      "@typescript-eslint/return-await": [
        "error",
        "error-handling-correctness-only",
      ],
      "@typescript-eslint/no-unnecessary-type-conversion": "error",
      // Medium-value: enforces good patterns
      "@typescript-eslint/no-confusing-void-expression": [
        "error",
        { ignoreArrowShorthand: true },
      ],
      "@typescript-eslint/no-invalid-void-type": [
        "error",
        { allowInGenericTypeArguments: true },
      ],
      "@typescript-eslint/no-non-null-asserted-nullish-coalescing": "error",
      "@typescript-eslint/prefer-literal-enum-member": "error",
      "@typescript-eslint/related-getter-setter-pairs": "error",
      "@typescript-eslint/no-dynamic-delete": "error",
      "@typescript-eslint/no-extraneous-class": "error",
      // Low-value but zero-cost
      "@typescript-eslint/no-unnecessary-boolean-literal-compare": "error",
      "@typescript-eslint/no-unnecessary-template-expression": "error",
      "@typescript-eslint/no-unnecessary-type-arguments": "error",
      "@typescript-eslint/no-meaningless-void-operator": "error",
      "no-useless-constructor": "off",
      "@typescript-eslint/no-useless-constructor": "error",
      "@typescript-eslint/no-useless-default-assignment": "error",
      "@typescript-eslint/prefer-reduce-type-parameter": "error",
      "@typescript-eslint/prefer-return-this-type": "error",
      "@typescript-eslint/unified-signatures": "error",
    },
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ---------------------------------------------------------------------------
  // Test file overrides:
  // - Relax unsafe-any rules to match Biome's relaxation for test mocks
  // - unbound-method: vi.fn() stubs are designed to be passed by reference
  // - require-await: mock implementations are async to satisfy async interfaces
  //   but return synchronously; disabling avoids noise on valid test patterns
  // ---------------------------------------------------------------------------
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/require-await": "off",
    },
  },

  // ---------------------------------------------------------------------------
  // Forbid interior `process.platform` reads (#510).
  // The host platform is read once at the composition root (`index.ts`) and
  // injected into interior modules (PathNormalizer, rule evaluation, subagent
  // context). Reading `process.platform` anywhere else re-introduces the hidden
  // global-state dependency the PathNormalizer seam removed.
  // ---------------------------------------------------------------------------
  {
    files: ["src/**/*.ts"],
    ignores: ["src/index.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'MemberExpression[object.name="process"][property.name="platform"]',
          message:
            "Read process.platform only at the composition root (index.ts); inject the platform (PathNormalizer / rule platform / subagent-context) into interior modules.",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Keep permission-manager string-based (ADR-0002).
  // The manager consumes ResolvedAccessIntent (path-values) and must not import
  // AccessPath — the resolver is the sole matchValues() unwrap site. Collapsing
  // that boundary requires an explicit, reviewed exception, not an unremarked
  // import. See docs/decisions/0002-path-values-string-boundary.md.
  // ---------------------------------------------------------------------------
  {
    files: ["src/permission-manager.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/access-intent/access-path",
                "#src/access-intent/access-path",
              ],
              message:
                "permission-manager stays string-based: it consumes ResolvedAccessIntent (path-values) and must not import AccessPath. See docs/decisions/0002-path-values-string-boundary.md.",
            },
          ],
        },
      ],
    },
  },
);
