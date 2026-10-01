import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { builderConfiguration } from "./prepare.mjs";
import { treeDigest } from "./lib/integrity.mjs";
import { verifyRuntimeManifestEnvelope, verifyRuntimeArtifactFile } from "../../packages/companion/scripts/verify-runtime-manifest.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error("Usage: node package.mjs <absolute prepared candidate directory> [--dir]");
if (process.argv.slice(3).some((arg) => arg !== "--dir")) throw new Error("Only --dir is supported; publication and signing are disabled");
const candidate = JSON.parse(fs.readFileSync(path.join(directory, "resources", "candidate.json"), "utf8"));
const preview = candidate.activationEnabled === false && candidate.distribution === "application-preview";
const application = candidate.activationEnabled === true && candidate.distribution === "application" && candidate.buildMode === "application-candidate";
if ((!preview && !application) || candidate.publishable !== false || candidate.platform !== `${process.platform}-${process.arch}`) {
  throw new Error("Only a matching, non-publishable candidate can be packaged");
}
const envelope = JSON.parse(fs.readFileSync(path.join(directory, "resources", "runtime-manifest.json"), "utf8"));
const payload = verifyRuntimeManifestEnvelope(envelope, { version: candidate.version, sourceSha: candidate.runtimeSourceSha });
const runtimeDelivery = candidate.runtimeDelivery || "bundled";
if (!["bundled", "download"].includes(runtimeDelivery)) throw new Error("Unsupported runtime delivery");
if (runtimeDelivery === "download" && fs.existsSync(path.join(directory, "resources", "runtime.tar.gz"))) throw new Error("Online installer must not bundle the runtime archive");
await verifyRuntimeArtifactFile(path.join(directory, runtimeDelivery === "download" ? "build-input" : "resources", "runtime.tar.gz"), payload.artifacts[candidate.platform]);
const prepared = JSON.parse(fs.readFileSync(path.join(directory, "prepared-integrity.json"), "utf8"));
for (const [key, subdirectory] of [["app", "app"], ["resources", "resources"], ["runtime", "verified-runtime"]]) {
  if (prepared.schema !== 1 || prepared[key] !== await treeDigest(path.join(directory, subdirectory))) throw new Error(`Prepared ${key} changed; prepare a new candidate`);
}
// Rebuild configuration rather than execute hooks or publication settings from
// an editable builder.json. These candidates have no signing credentials.
const config = builderConfiguration({ appDir: path.join(directory, "app"), resourcesDir: path.join(directory, "resources"),
  electronDist: path.join(directory, "verified-runtime", "node_modules", "electron", "dist"),
  outputDir: path.join(directory, "installers"), platform: candidate.platform, electronVersion: candidate.electronVersion,
  mode: application ? "application-candidate" : "preview" });
const configPath = path.join(directory, "builder.json");
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const env = { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
for (const key of Object.keys(env)) {
  if (/^(CSC_|WIN_CSC_|APPLE_|GH_TOKEN$|GITHUB_TOKEN$|AWS_)/.test(key) && key !== "CSC_IDENTITY_AUTO_DISCOVERY") delete env[key];
}
const platformFlag = process.platform === "win32" ? "--win" : process.platform === "darwin" ? "--mac" : "--linux";
// On hosted macOS runners the DMG step intermittently fails to detach its disk
// image ("hdiutil: couldn't eject ... Resource busy"); the same build succeeds
// on a later attempt. A real packaging fault still fails every attempt.
const attempts = process.platform === "darwin" ? 3 : 1;
let result;
for (let attempt = 1; attempt <= attempts; attempt++) {
  if (attempt > 1) {
    fs.rmSync(config.directories.output, { recursive: true, force: true });
    console.error(`Packaging failed (${result.status}); retrying (${attempt}/${attempts}).`);
    spawnSync("sleep", [String(15 * attempt)]);
  }
  result = spawnSync(process.execPath, [path.join(root, "node_modules", "electron-builder", "cli.js"),
    platformFlag, `--${process.arch}`, "--config", configPath, "--publish", "never", ...(process.argv.includes("--dir") ? ["--dir"] : [])],
  { cwd: root, env, stdio: "inherit", windowsHide: true });
  if (!result.error && result.status === 0) break;
}
if (result.error || result.status !== 0) throw new Error(result.error?.message || `Packaging failed (${result.status})`);
const artifacts = [];
for (const entry of fs.readdirSync(config.directories.output, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.(exe|dmg|zip|deb|rpm)$/.test(entry.name)) continue;
  const file = path.join(config.directories.output, entry.name);
  const hash = createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  artifacts.push({ filename: entry.name, bytes: fs.statSync(file).size, sha512: `sha512-${hash.digest("base64")}` });
}
fs.writeFileSync(path.join(directory, "packaging-receipt.json"), `${JSON.stringify({ ...candidate, artifacts }, null, 2)}\n`);
