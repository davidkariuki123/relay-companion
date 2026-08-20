#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const companionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NORMALIZED_ARCHIVE_TIME = new Date("2000-01-01T00:00:00.000Z");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "pipe", windowsHide: true, ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message || result.stderr || result.stdout || result.status}`);
  }
  return String(result.stdout || "").trim();
}

export function npmRuntimeInvocation(args, {
  platform = process.platform,
  npmExecPath = process.env.npm_execpath,
  execPath = process.execPath,
  comspec = process.env.ComSpec,
  existsSync = fs.existsSync,
} = {}) {
  if (npmExecPath && existsSync(npmExecPath)) {
    return { command: execPath, args: [npmExecPath, ...args] };
  }
  if (platform === "win32") {
    return { command: comspec || "cmd.exe", args: ["/d", "/s", "/c", "npm.cmd", ...args] };
  }
  return { command: "npm", args };
}

function option(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

export function runtimePlatform(platform = process.platform, arch = process.arch) {
  const value = `${platform}-${arch}`;
  if (!["darwin-arm64", "darwin-x64", "win32-x64", "win32-arm64"].includes(value)) {
    throw new Error(`Unsupported Relay runtime platform: ${value}`);
  }
  return value;
}

export function runtimePackageJson(packageJson, dependencies) {
  return {
    name: "relay-companion",
    version: packageJson.version,
    description: packageJson.description,
    homepage: packageJson.homepage,
    repository: packageJson.repository,
    bugs: packageJson.bugs,
    author: packageJson.author,
    license: packageJson.license,
    engines: packageJson.engines,
    type: "module",
    bin: { relay: "bin/relay.js" },
    main: "bin/relay.js",
    dependencies,
  };
}

function insideRoot(root, candidate) {
  const boundary = `${path.resolve(root)}${path.sep}`;
  const resolved = path.resolve(candidate);
  return resolved === path.resolve(root) || resolved.startsWith(boundary);
}

export function captureInternalLinks(root, { platform = process.platform } = {}) {
  const boundary = `${fs.realpathSync(root)}${path.sep}`;
  const links = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(absolute);
        if (target !== boundary.slice(0, -1) && !target.startsWith(boundary)) {
          throw new Error(`Runtime dependency link escapes the locked install: ${absolute}`);
        }
        const relativeTarget = fs.readlinkSync(absolute);
        if (path.isAbsolute(relativeTarget)) throw new Error(`Runtime dependency link uses an absolute target: ${absolute}`);
        const lexicalTarget = path.resolve(path.dirname(absolute), relativeTarget);
        if (!insideRoot(root, lexicalTarget)) throw new Error(`Runtime dependency link escapes the locked install: ${absolute}`);
        const targetStat = fs.statSync(absolute);
        links.push({
          path: path.relative(root, absolute).replaceAll(path.sep, "/"),
          target: relativeTarget.replaceAll(path.sep, "/"),
          type: targetStat.isDirectory() ? "directory" : targetStat.isFile() ? "file" : "unsupported",
          absolute,
        });
      } else if (stat.isDirectory()) {
        visit(absolute);
      }
    }
  }
  visit(root);
  if (links.some((link) => link.type === "unsupported")) {
    throw new Error("Runtime dependency link targets an unsupported entry");
  }
  if (platform === "win32" && links.length) {
    throw new Error("Windows runtime dependencies unexpectedly contain links");
  }
  for (const { absolute } of links.sort((left, right) => right.absolute.length - left.absolute.length)) {
    fs.rmSync(absolute, { force: true });
  }
  return links
    .map(({ absolute: _absolute, ...link }) => link)
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function normalizeTreeMetadata(root) {
  const paths = [];
  function visit(absolute) {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Deterministic runtime archive cannot contain a link: ${absolute}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(absolute, name));
    } else if (!stat.isFile()) {
      throw new Error(`Deterministic runtime archive contains an unsupported entry: ${absolute}`);
    }
    paths.push(absolute);
  }
  visit(root);
  // Directories are visited after their children, so their normalized mtimes
  // are not dirtied again by a later filesystem mutation.
  for (const absolute of paths) fs.utimesSync(absolute, NORMALIZED_ARCHIVE_TIME, NORMALIZED_ARCHIVE_TIME);
  return paths.length;
}

function archiveEntryList(sourceRoot, entryRoot) {
  const absoluteRoot = path.join(sourceRoot, entryRoot);
  const entries = [];
  function visit(absolute, relative) {
    if (/[\r\n\0]/.test(relative)) throw new Error(`Runtime archive path contains a control character: ${relative}`);
    entries.push(relative.replaceAll(path.sep, "/"));
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(absolute, name), path.join(relative, name));
    }
  }
  visit(absoluteRoot, entryRoot);
  return entries;
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
}

function writeTarText(header, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`USTAR field is too long: ${value}`);
  bytes.copy(header, offset);
}

function writeTarOctal(header, offset, length, value) {
  const encoded = Math.trunc(value).toString(8);
  if (encoded.length > length - 1) throw new Error(`USTAR numeric field is too large: ${value}`);
  writeTarText(header, offset, length, `${encoded.padStart(length - 1, "0")}\0`);
}

function splitUstarPath(relative, directory) {
  const archivePath = directory && !relative.endsWith("/") ? `${relative}/` : relative;
  if (Buffer.byteLength(archivePath) <= 100) return { name: archivePath, prefix: "" };
  for (let slash = archivePath.lastIndexOf("/"); slash > 0; slash = archivePath.lastIndexOf("/", slash - 1)) {
    const prefix = archivePath.slice(0, slash);
    const name = archivePath.slice(slash + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`Runtime archive path is not representable as USTAR: ${relative}`);
}

function createUstarArchive({ sourceRoot, entries, outputPath }) {
  const output = fs.openSync(outputPath, "wx", 0o600);
  const copyBuffer = Buffer.allocUnsafe(1024 * 1024);
  const zeroBlock = Buffer.alloc(512);
  try {
    for (const relative of entries) {
      const absolute = path.join(sourceRoot, ...relative.split("/"));
      const stat = fs.lstatSync(absolute);
      const directory = stat.isDirectory();
      if (!directory && !stat.isFile()) {
        throw new Error(`Deterministic runtime archive contains an unsupported entry: ${absolute}`);
      }
      const { name, prefix } = splitUstarPath(relative, directory);
      const header = Buffer.alloc(512);
      writeTarText(header, 0, 100, name);
      writeTarOctal(header, 100, 8, directory ? 0o755 : (stat.mode & 0o111 ? 0o755 : 0o644));
      writeTarOctal(header, 108, 8, 0);
      writeTarOctal(header, 116, 8, 0);
      writeTarOctal(header, 124, 12, directory ? 0 : stat.size);
      writeTarOctal(header, 136, 12, Math.floor(NORMALIZED_ARCHIVE_TIME.getTime() / 1000));
      header.fill(0x20, 148, 156);
      header[156] = directory ? 0x35 : 0x30;
      writeTarText(header, 257, 6, "ustar\0");
      writeTarText(header, 263, 2, "00");
      writeTarText(header, 265, 32, "root");
      writeTarText(header, 297, 32, "root");
      writeTarOctal(header, 329, 8, 0);
      writeTarOctal(header, 337, 8, 0);
      writeTarText(header, 345, 155, prefix);
      const checksum = header.reduce((total, byte) => total + byte, 0);
      writeTarText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
      writeAll(output, header);

      if (!directory) {
        const input = fs.openSync(absolute, "r");
        try {
          for (;;) {
            const bytesRead = fs.readSync(input, copyBuffer, 0, copyBuffer.length, null);
            if (!bytesRead) break;
            writeAll(output, copyBuffer.subarray(0, bytesRead));
          }
        } finally {
          fs.closeSync(input);
        }
        const padding = (512 - (stat.size % 512)) % 512;
        if (padding) writeAll(output, zeroBlock.subarray(0, padding));
      }
    }
    writeAll(output, zeroBlock);
    writeAll(output, zeroBlock);
  } finally {
    fs.closeSync(output);
  }
}

export function createDeterministicArchive({ sourceRoot, entryRoot = "node_modules", outputPath } = {}) {
  const absoluteSource = path.resolve(sourceRoot);
  const absoluteOutput = path.resolve(outputPath);
  normalizeTreeMetadata(path.join(absoluteSource, entryRoot));
  const entries = archiveEntryList(absoluteSource, entryRoot);
  const nonce = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const tarPath = `${absoluteOutput}.${nonce}.tar`;
  const gzipPath = `${absoluteOutput}.${nonce}.gz`;
  try {
    // Write USTAR directly instead of depending on incompatible GNU/BSD tar
    // flag sets. USTAR has no pax atime/ctime headers, and the writer fixes
    // ownership, permissions, ordering, and timestamps on every platform.
    createUstarArchive({ sourceRoot: absoluteSource, entries, outputPath: tarPath });
    run(process.execPath, [path.join(companionRoot, "scripts", "deterministic-gzip.mjs"), tarPath, gzipPath], {
      timeout: 15 * 60_000,
    });
    fs.rmSync(absoluteOutput, { force: true });
    fs.renameSync(gzipPath, absoluteOutput);
    return absoluteOutput;
  } finally {
    for (const temporary of [tarPath, gzipPath]) fs.rmSync(temporary, { force: true });
  }
}

function sha512File(file) {
  const hash = crypto.createHash("sha512");
  const fd = fs.openSync(file, "r");
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!bytes) break;
      hash.update(chunk.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return `sha512-${hash.digest("base64")}`;
}

export function deterministicSbomSerial({ version, platformKey, sourceSha, dependencyLockSha512 }) {
  const hex = crypto.createHash("sha256")
    .update(`${version}\n${platformKey}\n${sourceSha}\n${dependencyLockSha512}`)
    .digest("hex")
    .slice(0, 32);
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function buildRuntimeArtifact({
  outputDir,
  platformKey = runtimePlatform(),
  sourceSha = String(process.env.SOURCE_SHA || process.env.GITHUB_SHA || "").trim(),
} = {}) {
  if (!/^[0-9a-f]{40}$/i.test(sourceSha)) throw new Error("A full source commit SHA is required");
  const packageJson = JSON.parse(fs.readFileSync(path.join(companionRoot, "package.json"), "utf8"));
  if (runtimePlatform() !== platformKey) {
    throw new Error(`Runner is ${runtimePlatform()}, refusing to label its binaries as ${platformKey}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(packageJson.version)) throw new Error("An exact runtime version is required");
  const dependencies = JSON.parse(fs.readFileSync(path.join(companionRoot, "runtime-dependencies.json"), "utf8"));
  const runtimeLockRoot = path.join(companionRoot, "runtime-lock");
  const lockedPackage = JSON.parse(fs.readFileSync(path.join(runtimeLockRoot, "package.json"), "utf8"));
  if (JSON.stringify(lockedPackage.dependencies) !== JSON.stringify(dependencies)) {
    throw new Error("runtime-dependencies.json has drifted from the committed runtime lock");
  }
  const dependencyLockBytes = fs.readFileSync(path.join(runtimeLockRoot, "package-lock.json"));
  const dependencyLockSha512 = `sha512-${crypto.createHash("sha512").update(dependencyLockBytes).digest("base64")}`;
  const destination = path.resolve(outputDir || path.join(companionRoot, "dist"));
  fs.mkdirSync(destination, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "relay-runtime-build-"));
  const packageRoot = path.join(temporary, "node_modules", "relay-companion");
  try {
    fs.copyFileSync(path.join(runtimeLockRoot, "package.json"), path.join(temporary, "package.json"));
    fs.copyFileSync(path.join(runtimeLockRoot, "package-lock.json"), path.join(temporary, "package-lock.json"));
    const npmInstall = npmRuntimeInvocation([
      "ci", "--ignore-scripts", "--no-audit", "--no-fund",
    ]);
    run(npmInstall.command, npmInstall.args, { timeout: 15 * 60_000, cwd: temporary });
    fs.rmSync(path.join(temporary, "node_modules", ".bin"), { recursive: true, force: true });
    fs.mkdirSync(packageRoot, { recursive: true });
    for (const entry of ["bin", "bootstrap", "src", "overlay", "licenses"]) {
      fs.cpSync(path.join(companionRoot, entry), path.join(packageRoot, entry), { recursive: true });
    }
    fs.copyFileSync(path.join(companionRoot, "THIRD_PARTY_NOTICES.md"), path.join(packageRoot, "THIRD_PARTY_NOTICES.md"));
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify(runtimePackageJson(packageJson, dependencies), null, 2)}\n`,
    );
    const electronInstall = path.join(temporary, "node_modules", "electron", "install.js");
    run(process.execPath, [electronInstall], { timeout: 15 * 60_000, env: { ...process.env } });
    // Signed archives intentionally reject every link entry. Electron's macOS
    // framework layout contains a small set of internal links; record those in
    // a signed map and remove them from the tar instead of dereferencing ~500MB
    // of duplicate framework bytes.
    const runtimeLinks = captureInternalLinks(temporary, { platform: process.platform });
    fs.writeFileSync(path.join(packageRoot, "runtime-links.json"), `${JSON.stringify({ schema: 1, links: runtimeLinks }, null, 2)}\n`);
    const filename = `relay-runtime-${packageJson.version}-${platformKey}.tar.gz`;
    const artifactPath = path.join(destination, filename);
    createDeterministicArchive({ sourceRoot: temporary, entryRoot: "node_modules", outputPath: artifactPath });
    if (fs.statSync(artifactPath).size > 300 * 1024 * 1024) {
      throw new Error("Relay runtime artifact exceeds the 300 MiB no-bloat budget");
    }
    // Prove the exact archived bytes reconstruct their signed internal links,
    // import the updater, and launch the pinned Electron runtime.
    const smokeRoot = path.join(temporary, "artifact-smoke");
    fs.mkdirSync(smokeRoot);
    run("tar", ["-xzf", artifactPath, "-C", smokeRoot]);
    const smokePackageRoot = path.join(smokeRoot, "node_modules", "relay-companion");
    const smokeBootstrap = createRequire(import.meta.url)(
      path.join(smokePackageRoot, "bootstrap", "relay-setup.cjs"),
    );
    smokeBootstrap.restoreRuntimeLinks(smokeRoot);
    run(process.execPath, [path.join(companionRoot, "scripts", "verify-installed-runtime.mjs"),
      "--package-root", smokePackageRoot, "--version", packageJson.version]);
    const artifactBytes = fs.statSync(artifactPath).size;
    const artifactSha512 = sha512File(artifactPath);
    const installedLock = JSON.parse(fs.readFileSync(path.join(temporary, "node_modules", ".package-lock.json"), "utf8"));
    const components = Object.entries(installedLock.packages || {})
      .filter(([location, metadata]) => location && metadata?.version)
      .map(([location, metadata]) => ({
        type: "library",
        name: location.split("node_modules/").at(-1),
        version: metadata.version,
        ...(metadata.license ? { licenses: [{ license: { id: metadata.license } }] } : {}),
        properties: [
          { name: "relay:npm-location", value: location },
          ...(metadata.integrity ? [{ name: "relay:npm-integrity", value: metadata.integrity }] : []),
          ...(metadata.resolved ? [{ name: "relay:npm-resolved", value: metadata.resolved }] : []),
        ],
      }))
      .sort((left, right) => `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`));
    const sbom = {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      serialNumber: deterministicSbomSerial({ version: packageJson.version, platformKey, sourceSha, dependencyLockSha512 }),
      version: 1,
      metadata: {
        timestamp: NORMALIZED_ARCHIVE_TIME.toISOString(),
        component: { type: "application", name: "Relay", version: packageJson.version },
        properties: [
          { name: "relay:source-sha", value: sourceSha.toLowerCase() },
          { name: "relay:platform", value: platformKey },
          { name: "relay:dependency-lock-sha512", value: dependencyLockSha512 },
        ],
      },
      components,
    };
    const sbomFilename = `relay-runtime-${packageJson.version}-${platformKey}.sbom.cdx.json`;
    const sbomPath = path.join(destination, sbomFilename);
    fs.writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
    const sbomBytes = fs.readFileSync(sbomPath);
    const fragment = {
      platform: platformKey,
      version: packageJson.version,
      sourceSha: sourceSha.toLowerCase(),
      dependencyLockSha512,
      filename,
      bytes: artifactBytes,
      sha512: artifactSha512,
      sbom: {
        filename: sbomFilename,
        bytes: sbomBytes.length,
        sha512: `sha512-${crypto.createHash("sha512").update(sbomBytes).digest("base64")}`,
      },
    };
    const fragmentPath = path.join(destination, `${platformKey}.json`);
    fs.writeFileSync(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`);
    return { artifactPath, sbomPath, fragmentPath, fragment };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = buildRuntimeArtifact({ outputDir: option("--output"), platformKey: option("--platform", runtimePlatform()) });
    console.log(JSON.stringify(result.fragment));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
