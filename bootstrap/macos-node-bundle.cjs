"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const systemLibrary = (name) => name.startsWith("/usr/lib/") || name.startsWith("/System/Library/");

// Homebrew Node is not a standalone executable. Preserve its complete Mach-O
// dependency closure, rewriting only our copies, so brew upgrades/removal cannot
// strand the independent recovery scheduler. No downloads or version switching.
function preserveMacOSNodeBundle(source, { runtimeRoot, fsImpl: fs, runCommand, version, verify }) {
  function command(executable, args) {
    const result = runCommand(executable, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    if (result?.error || result?.status !== 0) {
      throw new Error(`${path.basename(executable)} failed: ${result?.error?.message || result?.stderr || "command failed"}`);
    }
    return String(result.stdout || "");
  }
  const executableDir = path.dirname(source);
  function expand(value, owner) {
    return value.replace(/^@loader_path(?=\/|$)/, path.dirname(owner))
      .replace(/^@executable_path(?=\/|$)/, executableDir);
  }
  const images = new Map();
  function visit(filename, inheritedRpaths = []) {
    const real = fs.realpathSync(filename);
    if (images.has(real)) return images.get(real);
    if (images.size >= 128) throw new Error("Node shared-library dependency limit exceeded");
    const loads = command("/usr/bin/otool", ["-l", real]);
    const ownRpaths = [...loads.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.+?) \(offset \d+\)/g)]
      .map((match) => expand(match[1], real));
    const rpaths = [...ownRpaths, ...inheritedRpaths];
    const image = { source: real, digest: hash(fs.readFileSync(real)), edges: [],
      name: real === source ? "node" : `lib/${hash(real).slice(0, 24)}.dylib` };
    images.set(real, image);
    // Read load commands, not `otool -L`: LC_ID_DYLIB is an identity, not an edge.
    const dependencies = [...loads.matchAll(/cmd LC_(?:LOAD_DYLIB|LOAD_WEAK_DYLIB|REEXPORT_DYLIB|LOAD_UPWARD_DYLIB|LAZY_LOAD_DYLIB)\s+cmdsize \d+\s+name (.+?) \(offset \d+\)/g)]
      .map((match) => match[1]);
    for (const name of dependencies) {
      if (systemLibrary(name)) continue;
      const expanded = expand(name, real);
      const candidates = expanded.startsWith("@rpath/")
        ? rpaths.map((root) => path.join(root, expanded.slice(7))) : [expanded];
      const resolved = candidates.find((candidate) => path.isAbsolute(candidate) && fs.existsSync(candidate));
      if (!resolved) throw new Error(`Cannot preserve Node shared library ${name} required by ${real}`);
      if (systemLibrary(fs.realpathSync(resolved))) continue;
      image.edges.push({ name, target: visit(resolved, rpaths) });
    }
    return image;
  }
  visit(source);
  if (images.size === 1) throw new Error("Node failed relocation but no non-system shared libraries were found");
  const entries = [...images.values()].sort((a, b) => a.name.localeCompare(b.name));
  // Include the transformation version and resolved edges, not only node bytes:
  // Homebrew can upgrade a linked formula without changing the Node executable.
  const identity = hash(JSON.stringify({ schema: 1, entries: entries.map((item) => ({
    source: item.source, digest: item.digest, name: item.name,
    edges: item.edges.map((edge) => [edge.name, edge.target.name]),
  })) }));
  const parent = path.join(runtimeRoot, "node");
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  // Generations are immutable. A failed repair never deletes/replaces the bundle
  // referenced by an existing launch agent. The small index is only a reuse hint.
  const indexPath = path.join(parent, `${identity}.bundle.json`);
  try {
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    if (typeof index.directory === "string" && new RegExp(`^${identity}-[a-f0-9]{16}$`).test(index.directory)
      && Array.isArray(index.files) && index.files.length === entries.length
      && entries.every((item, i) => index.files[i]?.name === item.name)) {
      const root = path.join(parent, index.directory);
      if (index.files.every((item) => hash(fs.readFileSync(path.join(root, item.name))) === item.digest)) {
        const result = verify(path.join(root, "node"));
        if (result.ok && result.version === version) return path.join(root, "node");
      }
    }
  } catch {}
  const generation = `${identity}-${crypto.randomBytes(8).toString("hex")}`;
  const directory = path.join(parent, generation);
  const staging = path.join(parent, `.${generation}`);
  const indexTemp = path.join(parent, `.${generation}.json`);
  try {
    fs.mkdirSync(staging, { mode: 0o700 });
    fs.mkdirSync(path.join(staging, "lib"), { mode: 0o700 });
    for (const item of entries) {
      const bytes = fs.readFileSync(item.source);
      if (hash(bytes) !== item.digest) throw new Error(`Node dependency changed during preservation: ${item.source}`);
      const copied = path.join(staging, item.name);
      fs.writeFileSync(copied, bytes, { mode: 0o700, flag: "wx" });
      if (hash(fs.readFileSync(copied)) !== item.digest) throw new Error(`Copied Node dependency failed integrity verification: ${item.name}`);
    }
    for (const item of entries) {
      const file = path.join(staging, item.name);
      const changes = item.edges.flatMap((edge) => ["-change", edge.name,
        `@loader_path/${path.posix.relative(path.posix.dirname(item.name), edge.target.name)}`]);
      if (item.name !== "node") changes.push("-id", `@loader_path/${path.posix.basename(item.name)}`);
      if (changes.length) command("/usr/bin/install_name_tool", [...changes, file]);
      // Mach-O edits invalidate the existing signature; ad-hoc signing local
      // owned copies is required by Apple Silicon. The originals are untouched.
      command("/usr/bin/codesign", ["--force", "--sign", "-", file]);
    }
    const checked = verify(path.join(staging, "node"));
    if (!checked.ok || checked.version !== version) throw new Error(`Bundled Node failed verification: ${checked.detail || checked.version}`);
    const files = entries.map((item) => ({ name: item.name, digest: hash(fs.readFileSync(path.join(staging, item.name))) }));
    for (const item of files) {
      const fd = fs.openSync(path.join(staging, item.name), "r+");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    fs.renameSync(staging, directory);
    const installed = verify(path.join(directory, "node"));
    if (!installed.ok || installed.version !== version) throw new Error(`Published Node bundle failed verification: ${installed.detail || installed.version}`);
    fs.writeFileSync(indexTemp, JSON.stringify({ directory: generation, files }), { mode: 0o600, flag: "wx" });
    fs.renameSync(indexTemp, indexPath);
    return path.join(directory, "node");
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(indexTemp, { force: true });
  }
}

module.exports = { preserveMacOSNodeBundle };
