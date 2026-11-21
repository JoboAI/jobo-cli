import { defineConfig } from "tsup";

// @jobo-ai/connector-core is a devDependency inlined here (`noExternal`), the
// same way the n8n node consumes it: the published package then has no runtime
// dependencies at all, so `npx jobo-cli` installs one tarball and nothing else.
// Pin the core exactly in package.json — bundled code leaves no lockfile signal.
//
// The entry file's shebang is kept and the output marked executable by tsup.
export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: false,
  sourcemap: false,
  clean: true,
  splitting: false,
  treeshake: true,
  noExternal: ["@jobo-ai/connector-core"],
});
