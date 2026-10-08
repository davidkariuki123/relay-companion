import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { assertNewOutput } from "./prepare.mjs";
import { buildMacDmg } from "./lib/mac-dmg.mjs";

// Separate from packaging: a build never discovers a certificate. This runs
// either in sign-application-mac.yml, where the mac-signing environment lends
// the Developer ID and notary key to a temporary keychain named in
// APPLE_KEYCHAIN, or on a signing Mac whose login keychain holds them.
const [source, output] = process.argv.slice(2);
if (process.platform !== "darwin") throw new Error("Developer ID signing requires macOS");
if (!source?.endsWith(".app") || !path.isAbsolute(source) || !output || !path.isAbsolute(output)) throw new Error("Usage: node sign-mac-candidate.mjs ABSOLUTE_CANDIDATE.app ABSOLUTE_NEW_OUTPUT");
const identity = process.env.RELAY_MAC_SIGNING_IDENTITY;
const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE;
if (!identity?.startsWith("Developer ID Application:") || !keychainProfile) throw new Error("Set RELAY_MAC_SIGNING_IDENTITY and an existing APPLE_KEYCHAIN_PROFILE on the signing Mac");
const original = JSON.parse(fs.readFileSync(path.join(source, "Contents/Resources/candidate.json"), "utf8"));
const preview = original.distribution === "application-preview" && original.activationEnabled === false;
const application = original.distribution === "application" && original.activationEnabled === true && original.buildMode === "application-candidate";
if ((!preview && !application) || original.publishable !== false || original.packagingSourceDirty !== false) throw new Error("Only a clean, non-publishable candidate can use this signing step");
const root = assertNewOutput(output);
const appPath = path.join(root, path.basename(source));
fs.cpSync(source, appPath, { recursive: true, verbatimSymlinks: true });
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 20 * 60_000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${command} failed`);
  return result.stdout;
}
const require = createRequire(import.meta.url);
// One keychain for every signing tool: codesign, osx-sign and notarytool all
// look in the same place, so a CI keychain outside the search list still works.
const auth = { keychainProfile, ...(process.env.APPLE_KEYCHAIN ? { keychain: process.env.APPLE_KEYCHAIN } : {}) };
const keychainArgs = auth.keychain ? ["--keychain", auth.keychain] : [];
const { signAsync } = require("@electron/osx-sign");
const { notarize } = require("@electron/notarize");
const entitlements = path.join(root, "node-entitlements.plist");
fs.writeFileSync(entitlements, '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
const node = path.join(appPath, "Contents/Resources/node");
run("codesign", ["--force", "--sign", identity, ...keychainArgs, "--options", "runtime", "--timestamp", "--entitlements", entitlements, node]);
// Seal the final signed Node bytes before signing the enclosing application.
const candidate = { ...original, nodeSha256: createHash("sha256").update(fs.readFileSync(node)).digest("hex"), applicationSigning: "developer-id-candidate" };
fs.writeFileSync(path.join(appPath, "Contents/Resources/candidate.json"), `${JSON.stringify(candidate, null, 2)}\n`);
await signAsync({ app: appPath, identity, platform: "darwin", type: "distribution", ...(auth.keychain ? { keychain: auth.keychain } : {}),
  ignore: (file) => path.resolve(file) === path.resolve(node), optionsForFile: () => ({ hardenedRuntime: true }) });
await notarize({ appPath, ...auth });
run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
run("xcrun", ["stapler", "validate", appPath]);
run("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
if (createHash("sha256").update(fs.readFileSync(node)).digest("hex") !== candidate.nodeSha256) throw new Error("Nested signing changed the sealed Node runtime");
const dmg = path.join(root, `${preview ? "Relay-Migration-Preview" : "Relay"}-${candidate.applicationVersion || candidate.version}-${candidate.platform}.dmg`);
// The disk image opens as the install window: Relay.app left, an arrow, the
// Applications folder right, on a picture that says what to do. See
// lib/mac-dmg.mjs; the layout is checked on the mounted volume before the
// image is compressed, then signed and notarized below exactly as before.
buildMacDmg({ app: appPath, output: dmg, volumeName: preview ? "Relay Migration Preview" : "Relay", run });
run("codesign", ["--sign", identity, ...keychainArgs, "--timestamp", dmg]);
const authArgs = ["--keychain-profile", keychainProfile, ...(auth.keychain ? ["--keychain", auth.keychain] : [])];
const submission = JSON.parse(run("xcrun", ["notarytool", "submit", dmg, ...authArgs, "--wait", "--output-format", "json"]));
if (submission.status !== "Accepted") throw new Error("Apple did not accept the installer for notarization");
run("xcrun", ["stapler", "staple", dmg]);
run("xcrun", ["stapler", "validate", dmg]);
// The updater archive must contain this same signed, stapled app, rather than
// the unsigned ZIP emitted by the earlier packaging step.
const zip = dmg.replace(/\.dmg$/, ".zip");
run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zip]);
const artifacts = [];
for (const file of [dmg, zip]) {
  const hash = createHash("sha512");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  artifacts.push({ artifact: path.basename(file), bytes: fs.statSync(file).size, sha512: `sha512-${hash.digest("base64")}` });
}
fs.writeFileSync(path.join(root, "signing-receipt.json"), `${JSON.stringify({ ...candidate, developerId: true,
  notarized: true, stapled: true, notarySubmissionId: submission.id,
  ...artifacts[0], artifacts }, null, 2)}\n`);
console.log(`Signed and notarized candidate retained at ${dmg}; no publication or installation was performed.`);
