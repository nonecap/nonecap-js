import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Options } from "tsup";

type Plugin = NonNullable<Options["esbuildPlugins"]>[number];

const LICENSES_FILE = "THIRD_PARTY_LICENSES.txt";

// MIT and ISC require their notice to travel with the code; most bundled deps carry no
// @license comment for esbuild to keep, so collect each package's LICENSE file instead.
const thirdPartyLicenses: Plugin = {
  name: "third-party-licenses",
  setup(build) {
    build.onEnd((result) => {
      if (!result.metafile) return;
      const roots = new Set<string>();
      for (const input of Object.keys(result.metafile.inputs)) {
        const m = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
        if (m) roots.add(m[1]!);
      }
      const sections = [...roots]
        .map((root) => {
          const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
          const file = readdirSync(root).find((f) => /^(licen[cs]e|copying)/i.test(f));
          const text = file ? readFileSync(join(root, file), "utf8").trim() : `License: ${pkg.license ?? "unknown"}`;
          return { id: `${pkg.name}@${pkg.version}`, text };
        })
        .sort((a, b) => a.id.localeCompare(b.id))
        .filter((s, i, all) => i === 0 || all[i - 1]!.id !== s.id);
      const header =
        "dist/mcp.cjs (the nonecap-mcp bin) bundles the following packages. Their licenses follow.\n";
      const body = sections.map((s) => `${"=".repeat(72)}\n${s.id}\n${"=".repeat(72)}\n\n${s.text}\n`).join("\n");
      if (!existsSync("dist")) mkdirSync("dist");
      writeFileSync(join("dist", LICENSES_FILE), `${header}\n${body}`);
    });
  },
};

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    // Both configs build in parallel, so only this one cleans, and it spares the bin's outputs.
    clean: ["!mcp.cjs", `!${LICENSES_FILE}`],
    sourcemap: true,
    treeshake: true,
    target: "es2022",
    outExtension: ({ format }) => ({ js: format === "cjs" ? ".cjs" : ".js" }),
  },
  {
    // The MCP SDK and zod are bundled into the bin so the library itself keeps zero dependencies.
    entry: { mcp: "src/mcp/bin.ts" },
    format: ["cjs"],
    platform: "node",
    target: "node18",
    noExternal: [/.*/],
    treeshake: true,
    minify: true,
    esbuildPlugins: [thirdPartyLicenses],
    outExtension: () => ({ js: ".cjs" }),
  },
]);
