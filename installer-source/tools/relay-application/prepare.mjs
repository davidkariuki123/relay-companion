import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { verifyRuntimeManifestEnvelope, verifyRuntimeArtifactFile } from "../../packages/companion/scripts/verify-runtime-manifest.mjs";
import { copyCompanionAppAssets } from "./lib/app-assets.mjs";
import migration from "./lib/migration.cjs";
import { treeDigest } from "./lib/integrity.mjs";
import { packagingIdentity } from "./lib/source-identity.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const bootstrap = require("../../packages/companion/bootstrap/relay-setup.cjs");

export function assertNewOutput(directory) {
  if (!directory || !path.isAbsolute(directory)) throw new Error("Use a new absolute output directory");
  const output = path.resolve(directory);
  if (fs.existsSync(output)) throw new Error("Refusing to overwrite an existing output directory");
  // No recursive delete is used, even after failure. Failed staging is evidence.
  fs.mkdirSync(output, { recursive: true });
  return output;
}

export function builderConfiguration({ appDir, resourcesDir, electronDist, outputDir, platform, electronVersion, mode = "preview" }) {
  if (!migration.PLATFORMS.includes(platform)) throw new Error("Unsupported application platform");
  if (!["preview", "application-candidate"].includes(mode)) throw new Error("Unsupported application build mode");
  const application = mode === "application-candidate";
  return {
    appId: application ? "work.relay.application" : "work.relay.migration.preview", productName: application ? "Relay" : "Relay Migration Preview",
    executableName: application ? "relay" : "relay-migration-preview", asar: true, npmRebuild: false,
    electronDist, electronVersion,
    directories: { app: appDir, output: outputDir },
    files: ["**/*"], extraResources: [{ from: resourcesDir, to: ".", filter: ["**/*"] }],
    artifactName: application ? `Relay-\${version}-${platform}.\${ext}` : "Relay-Migration-Preview-${version}-${os}-${arch}.${ext}",
    ...(application ? { protocols: [{ name: "Relay", schemes: ["relay"] }] } : {}),
    publish: null,
    // Without an icon electron-builder ships Electron's atom, which is what a
    // fresh Mac showed in the Dock, the DMG and Finder (live run 29, 2026-10-08).
    mac: { target: ["dmg", "zip"], category: "public.app-category.productivity", identity: null,
      ...(resourcesDir ? { icon: path.join(resourcesDir, "relay.icns") } : {}) },
    win: { target: ["nsis"], signExecutable: false, ...(resourcesDir ? { icon: path.join(resourcesDir, "relay.ico") } : {}) },
    nsis: { oneClick: false, perMachine: false, allowElevation: false,
      allowToChangeInstallationDirectory: false, runAfterFinish: application,
      deleteAppDataOnUninstall: false, createDesktopShortcut: false,
      ...(application ? { include: path.join(root, "application-uninstall.nsh") } : {}) },
    linux: { target: ["deb", "rpm"], category: "Utility",
      maintainer: "Relay <hello@sendrelays.com>", executableName: application ? "relay" : "relay-migration-preview" },
  };
}

// The signed Relay runtime renames its macOS Electron executable to
// MacOS/Relay, keeping MacOS/Electron as a link to it, so the pill's launch
// agent is not named "Electron" (packages/companion/bootstrap/mac-background-identity.cjs).
// electron-builder builds this application from the same dist and renames
// MacOS/Electron to the executableName "relay": handed the link it would
// produce a symlinked main executable, and on a case-insensitive volume
// "relay" is "Relay", so the rename would replace the binary with a link to
// itself. Give the builder the stock layout it expects; it re-brands and the
// application is signed afterwards, so this copy's ad-hoc signature is moot.
export function stockElectronLayoutForBuilder(electronDist, { platform = process.platform, runCommand = run, fsImpl = fs } = {}) {
  if (platform !== "darwin") return { restored: false, reason: "not-darwin" };
  const app = path.join(electronDist, "Electron.app");
  const macos = path.join(app, "Contents", "MacOS");
  const stock = path.join(macos, "Electron");
  const renamed = path.join(macos, "Relay");
  const stockStat = fsImpl.lstatSync(stock, { throwIfNoEntry: false });
  // Runtimes built before the rename already have the stock layout.
  if (!fsImpl.lstatSync(renamed, { throwIfNoEntry: false })) return { restored: false, reason: "stock-layout" };
  if (!stockStat?.isSymbolicLink() || fsImpl.readlinkSync(stock) !== "Relay" || !fsImpl.lstatSync(renamed).isFile()) {
    throw new Error("Verified runtime has an unexpected Electron executable layout");
  }
  fsImpl.unlinkSync(stock);
  fsImpl.renameSync(renamed, stock);
  runCommand("/usr/bin/plutil", ["-replace", "CFBundleExecutable", "-string", "Electron", path.join(app, "Contents", "Info.plist")]);
  return { restored: true };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, ...options });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${command} failed`);
  return result.stdout.trim();
}

export function portableTarInvocation(invocation, platform = process.platform) {
  // Git Bash puts GNU tar ahead of Windows bsdtar on CI. Both accept forward
  // slashes; GNU tar treats backslashes in relative destinations literally.
  return { ...invocation, args: platform === "win32"
    ? invocation.args.map((arg) => arg.replaceAll("\\", "/")) : invocation.args };
}

export async function prepareCandidate({ manifestFile, artifactFile, version, sourceSha, outputDir,
  platform = `${process.platform}-${process.arch}`, trustStore, mode = "preview", applicationVersion = version, channel = "stable",
  runtimeDelivery = mode === "application-candidate" ? "download" : "bundled" } = {}) {
  if (!["bundled", "download"].includes(runtimeDelivery)) throw new Error("Unsupported runtime delivery");
  if (!["stable", "dev"].includes(channel)) throw new Error("Unsupported application channel");
  if (!/^\d+\.\d+\.\d+$/.test(applicationVersion || "")) throw new Error("Use an exact application version");
  if (!["preview", "application-candidate"].includes(mode)) throw new Error("Unsupported application build mode");
  const application = mode === "application-candidate";
  bootstrap.assertCompatibleNode();
  if (platform !== `${process.platform}-${process.arch}`) throw new Error("Build each native candidate on its matching OS and architecture");
  const envelopeBytes = fs.readFileSync(manifestFile);
  const payload = verifyRuntimeManifestEnvelope(JSON.parse(envelopeBytes), { version, sourceSha, trustStore });
  const artifact = payload.artifacts[platform];
  await verifyRuntimeArtifactFile(artifactFile, artifact);
  // Validate the signed archive before creating output. The production bootstrap
  // validates names, types, traversal and link rules; no archive code is executed.
  bootstrap.validateArchiveListing(artifactFile);
  const output = assertNewOutput(outputDir);
  const extracted = path.join(output, "verified-runtime");
  fs.mkdirSync(extracted);
  const unpack = portableTarInvocation(bootstrap.tarInvocation({ archivePath: path.resolve(artifactFile), mode: "extract", destination: extracted }));
  run(unpack.command, unpack.args, { cwd: unpack.cwd, timeout: 5 * 60_000 });
  bootstrap.restoreRuntimeLinks(extracted);
  const packageRoot = path.join(extracted, "node_modules", "relay-companion");
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (metadata.name !== "relay-companion" || metadata.version !== version) throw new Error("Extracted runtime identity mismatch");
  if (application && !fs.existsSync(path.join(packageRoot, "bootstrap", "application-owner.cjs"))) throw new Error("Publish a stock bridge runtime with application ownership before building an activating application candidate");
  const electronMetadata = JSON.parse(fs.readFileSync(path.join(extracted, "node_modules", "electron", "package.json"), "utf8"));
  const electronDist = path.join(extracted, "node_modules", "electron", "dist");
  stockElectronLayoutForBuilder(electronDist);
  const appDir = path.join(output, "app");
  const resourcesDir = path.join(output, "resources");
  fs.cpSync(path.join(root, "app"), appDir, { recursive: true, force: false, errorOnExist: true });
  copyCompanionAppAssets(appDir);
  fs.copyFileSync(path.join(root, "lib", "migration.cjs"), path.join(appDir, "migration.cjs"));
  fs.copyFileSync(path.join(packageRoot, "overlay", "deep-link.cjs"), path.join(appDir, "deep-link.cjs"));
  fs.mkdirSync(resourcesDir);
  fs.cpSync(path.join(root, "../../packages/companion/bootstrap"), path.join(resourcesDir, "installer", "bootstrap"), { recursive: true });
  fs.copyFileSync(path.join(root, "../../packages/companion/package.json"), path.join(resourcesDir, "installer", "package.json"));
  fs.copyFileSync(path.join(root, "app", "activate.cjs"), path.join(resourcesDir, "activate.cjs"));
  const desktopOnboarding = fs.existsSync(path.join(packageRoot, "onboarding", "START-HERE.md"));
  if (desktopOnboarding) {
    fs.cpSync(path.join(packageRoot, "onboarding"), path.join(resourcesDir, "onboarding"), { recursive: true });
    fs.mkdirSync(path.join(resourcesDir, "installer", "src"), { recursive: true });
    for (const file of ["desktop-onboarding.cjs", "atomic-json.cjs"]) fs.copyFileSync(path.join(packageRoot, "src", file), path.join(resourcesDir, "installer", "src", file));
  }
  // Keep the verified archive as a build input without shipping it in online installers.
  const archiveDirectory = runtimeDelivery === "download" ? path.join(output, "build-input") : resourcesDir;
  fs.mkdirSync(archiveDirectory, { recursive: true });
  fs.copyFileSync(artifactFile, path.join(archiveDirectory, "runtime.tar.gz"));
  fs.writeFileSync(path.join(resourcesDir, "runtime-manifest.json"), envelopeBytes);
  fs.copyFileSync(path.join(packageRoot, "overlay", "relay.ico"), path.join(resourcesDir, "relay.ico"));
  fs.copyFileSync(path.join(root, "lib", "relay.icns"), path.join(resourcesDir, "relay.icns"));
  // Preserve Node as an installer resource; no dependency on the user's PATH.
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  fs.copyFileSync(process.execPath, path.join(resourcesDir, nodeName));
  if (process.platform !== "win32") fs.chmodSync(path.join(resourcesDir, nodeName), 0o755);
  const candidate = {
    schema: 1, distribution: application ? "application" : "application-preview", activationEnabled: application,
    appId: application ? "work.relay.application" : "work.relay.migration.preview", buildMode: mode,
    version, applicationVersion, channel, runtimeSourceSha: sourceSha, platform, electronVersion: electronMetadata.version,
    desktopOnboarding,
    nodeVersion: process.versions.node,
    nodeSha256: crypto.createHash("sha256").update(fs.readFileSync(process.execPath)).digest("hex"),
    runtimeSha512: artifact.sha512, runtimeDelivery, runtimeDownloadBytes: runtimeDelivery === "download" ? artifact.bytes : 0,
    // Runtime provenance does not imply this outer application is OS-signed.
    applicationSigning: application ? "unsigned-candidate" : "unsigned-preview", publishable: false,
    ...packagingIdentity(root),
  };
  fs.writeFileSync(path.join(resourcesDir, "candidate.json"), `${JSON.stringify(candidate, null, 2)}\n`);
  fs.writeFileSync(path.join(appDir, "package.json"), `${JSON.stringify({
    name: application ? "relay-application" : "relay-migration-preview", productName: application ? "Relay" : "Relay Migration Preview", version: applicationVersion,
    main: "main.cjs", private: true, description: application ? "Relay application installation candidate" : "Read-only Relay application migration preview",
    author: "Relay <hello@sendrelays.com>", license: "MIT", homepage: "https://sendrelays.com",
  }, null, 2)}\n`);
  const config = builderConfiguration({ appDir, resourcesDir, electronDist,
    outputDir: path.join(output, "installers"), platform, electronVersion: electronMetadata.version, mode });
  fs.writeFileSync(path.join(output, "builder.json"), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(output, "prepared-integrity.json"), `${JSON.stringify({ schema: 1,
    app: await treeDigest(appDir), resources: await treeDigest(resourcesDir), runtime: await treeDigest(extracted) }, null, 2)}\n`);
  return candidate;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
  for (const flag of ["--manifest", "--artifact", "--version", "--source-sha", "--output"]) {
    if (!process.argv.includes(flag) || !arg(flag) || arg(flag).startsWith("--")) throw new Error(`Missing ${flag}`);
  }
  console.log(JSON.stringify(await prepareCandidate({ manifestFile: arg("--manifest"), artifactFile: arg("--artifact"),
    version: arg("--version"), sourceSha: arg("--source-sha"), outputDir: arg("--output"),
    applicationVersion: process.argv.includes("--application-version") ? arg("--application-version") : arg("--version"),
    channel: process.argv.includes("--channel") ? arg("--channel") : "stable",
    ...(process.argv.includes("--runtime-delivery") ? { runtimeDelivery: arg("--runtime-delivery") } : {}),
    mode: process.argv.includes("--application-candidate") ? "application-candidate" : "preview" }), null, 2));
}
