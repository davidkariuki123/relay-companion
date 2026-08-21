import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entryPoint = path.join(packageRoot, "overlay/preview-preload-source.cjs");
const outputPath = path.join(packageRoot, "overlay/preview-preload.cjs");

// The checked-in bundle is produced from packages/companion in the monorepo,
// where dependencies resolve through ../../node_modules. A standalone checkout
// installs those same dependencies beside package.json. Normalize esbuild's
// source labels only; executable code and dependency bytes remain untouched.
function monorepoStableSourceLabels(text) {
  // Those three direct/transitive packages were hoisted at the monorepo root
  // when the canonical bundle was produced; markdown-it's other dependencies
  // remained package-local. Preserve that exact, harmless annotation split.
  return String(text).replace(
    /(^\/\/ |^  ")node_modules\/(mdurl|punycode\.js|dompurify)\//gm,
    "$1../../node_modules/$2/",
  );
}

export async function buildPreview({ write = true, logLevel = "info" } = {}) {
  const result = await build({
    absWorkingDir: packageRoot,
    entryPoints: [entryPoint],
    outfile: outputPath,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    write: false,
    logLevel,
  });
  const outputFiles = result.outputFiles.map((file) => ({
    ...file,
    text: monorepoStableSourceLabels(file.text),
  }));
  if (write) {
    for (const file of outputFiles) fs.writeFileSync(file.path, file.text);
  }
  return { ...result, outputFiles };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildPreview();
}
