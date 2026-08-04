import { dts } from "rollup-plugin-dts";

// Roll the public type surface into a self-contained declaration bundle.
// We ship .ts source, so we want only .d.ts — no JS emit.
// Internal #src/* modules are inlined; peer-dependency types are kept external.

const external = [/^@earendil-works\//, /^node:/];

export default [
  // . entry: cross-extension service contract (Symbol.for() accessors,
  // PermissionsService, permission-events types and channel constants)
  {
    input: "src/service.ts",
    output: { file: "dist/public.d.ts", format: "es" },
    external,
    plugins: [dts({ tsconfig: "./tsconfig.json" })],
  },
];
