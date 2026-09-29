import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertNewOutput, portableTarInvocation } from "./prepare.mjs";

// Carries a signed Mac candidate from the signing Mac to the Dev publisher.
// `pack` runs on the signing Mac over sign-mac-candidate.mjs output and emits
// one archive per platform holding only the stapled DMG, the updater ZIP and
// the signing receipt. `unpack` runs in the publisher, admits exactly those
// three regular files and nothing else, then re-checks every hash. Neither
// command signs, publishes or installs anything.
export const RECEIPT = "signing-receipt.json";
export function archiveName(platform) { return `signed-mac-${platform}.tar.gz`; }

// Like the bootstrap's tarInvocation: run from the archive's directory with
// relative paths, so a Windows drive letter never reads as a remote host to
// GNU tar; the archive and the directory it packs or fills must share a volume.
function relativeTo(cwd, target) {
  const relative = path.relative(cwd, target) || ".";
  if (path.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) throw new Error("Signed Mac archive and its directory must share a local volume");
  return relative;
}
function tar(archive, args) {
  const cwd = path.dirname(archive);
  const invocation = portableTarInvocation({ command: "tar", args: args.map(arg => arg === archive ? path.basename(archive) : arg) });
  const result = spawnSync(invocation.command, invocation.args, { cwd, encoding: "utf8", windowsHide: true, timeout: 10 * 60_000,
    env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || "tar failed");
  return result.stdout;
}

async function sha512(file) {
  const hash = createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return `sha512-${hash.digest("base64")}`;
}

// The receipt must describe a final Developer ID candidate with exactly its
// DMG and ZIP; the publisher's assembler repeats the identity checks later.
export async function verifySignedDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error("Use an absolute signed output directory");
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, RECEIPT), "utf8"));
  if (!/^darwin-(arm64|x64)$/.test(receipt.platform || "")) throw new Error("Signing receipt is not for a Mac platform");
  if (receipt.applicationSigning !== "developer-id-candidate" || receipt.developerId !== true || receipt.notarized !== true
    || receipt.stapled !== true || typeof receipt.notarySubmissionId !== "string" || !receipt.notarySubmissionId.trim()) throw new Error("Signing receipt is not a final notarized, stapled Developer ID receipt");
  if (receipt.distribution !== "application" || receipt.buildMode !== "application-candidate" || receipt.packagingSourceDirty !== false) throw new Error("Only a clean application candidate can be packed");
  const version = receipt.applicationVersion || receipt.version;
  const expected = ["dmg", "zip"].map(kind => `Relay-${version}-${receipt.platform}.${kind}`);
  const names = (receipt.artifacts || []).map(entry => entry.artifact || entry.filename);
  if (names.length !== 2 || expected.some(name => !names.includes(name))) throw new Error("Signing receipt must list exactly the DMG and ZIP of this candidate");
  for (const entry of receipt.artifacts) {
    const file = path.join(directory, entry.artifact || entry.filename);
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error(`Signed artifact is not a regular file: ${file}`);
    if (stat.size !== entry.bytes || await sha512(file) !== entry.sha512) throw new Error(`Signed artifact does not match its receipt: ${file}`);
  }
  return { receipt, files: [RECEIPT, ...expected], version };
}

export async function packSignedMac({ directory, output }) {
  const { receipt, files, version } = await verifySignedDirectory(directory);
  const root = assertNewOutput(output);
  const archive = path.join(root, archiveName(receipt.platform));
  tar(archive, ["-czf", archive, "-C", relativeTo(root, directory), ...files]);
  const digest = createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  const summary = { schema: 1, platform: receipt.platform, version, packagingSourceSha: receipt.packagingSourceSha,
    notarySubmissionId: receipt.notarySubmissionId, archive: path.basename(archive), bytes: fs.statSync(archive).size, sha256: digest, published: false };
  fs.writeFileSync(path.join(root, `signed-mac-${receipt.platform}.json`), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

export async function unpackSignedMac({ archive, output }) {
  if (!path.isAbsolute(archive) || !fs.statSync(archive).isFile()) throw new Error("Use an absolute signed Mac archive");
  const platform = /^signed-mac-(darwin-(?:arm64|x64))\.tar\.gz$/.exec(path.basename(archive))?.[1];
  if (!platform) throw new Error("Archive name must be signed-mac-<platform>.tar.gz");
  // Inspect before extracting: only bare file names, no directories or links.
  const entries = tar(archive, ["-tzf", archive]).split(/\r?\n/).filter(Boolean);
  const allowed = new RegExp(`^(${RECEIPT}|Relay-\\d+\\.\\d+\\.\\d+-${platform}\\.(dmg|zip))$`);
  if (entries.length !== 3 || new Set(entries).size !== 3 || entries.some(entry => !allowed.test(entry))) throw new Error("Signed Mac archive must contain exactly the receipt, DMG and ZIP");
  const root = assertNewOutput(output);
  tar(archive, ["-xzf", archive, "-C", relativeTo(path.dirname(archive), root), ...entries]);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entries.includes(entry.name)) throw new Error("Extraction produced an unexpected entry");
  }
  const { receipt } = await verifySignedDirectory(root);
  if (receipt.platform !== platform) throw new Error("Archive name does not match its receipt platform");
  return { directory: root, receipt: path.join(root, RECEIPT), platform };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
  if (args[0] === "pack" && args.includes("--directory") && args.includes("--output")) {
    console.log(JSON.stringify(await packSignedMac({ directory: path.resolve(value("--directory")), output: value("--output") }), null, 2));
  } else if (args[0] === "unpack" && args.includes("--archive") && args.includes("--output")) {
    console.log(JSON.stringify(await unpackSignedMac({ archive: path.resolve(value("--archive")), output: value("--output") }), null, 2));
  } else throw new Error("Use pack --directory SIGNED_OUTPUT --output NEW_DIRECTORY, or unpack --archive signed-mac-PLATFORM.tar.gz --output NEW_DIRECTORY");
}
