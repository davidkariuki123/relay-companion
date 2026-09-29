import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { verifyRuntimeManifest } from "../../packages/companion/scripts/verify-runtime-manifest.mjs";
import { assertNewOutput } from "./prepare.mjs";

const require = createRequire(import.meta.url);
const { downloadVerifiedArtifact } = require("../../packages/companion/bootstrap/relay-setup.cjs");
const args = process.argv.slice(2);
const option = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const version = option("--version");
const sourceSha = option("--source-sha");
const platform = `${process.platform}-${process.arch}`;
let envelope;
const payload = await verifyRuntimeManifest({ version, sourceSha, fetchImpl: async (url) => {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Runtime manifest returned ${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("Runtime manifest too large");
  envelope = JSON.parse(text);
  return { ok: true, json: async () => envelope };
} });
const output = assertNewOutput(option("--output"));
fs.writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(envelope)}\n`);
await downloadVerifiedArtifact(payload.artifacts[platform].url, path.join(output, "runtime.tar.gz"), payload.artifacts[platform]);
console.log(JSON.stringify({ version, sourceSha, platform, output }));
