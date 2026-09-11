"use strict";
const fs = require("node:fs"), path = require("node:path");
function verifyCanonicalTreeComplete(packageRoot, {
  platform = process.platform,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  limit = 5000,
} = {}) {
  const api = (platform === "win32" ? path.win32 : path.posix);
  const root = api.resolve(String(packageRoot || ""));
  const releaseRoot = api.resolve(root, "..", "..");
  const normalize = (value) => (platform === "win32" ? value.toLowerCase() : value);
  const manifestOf = (directory) => {
    try {
      const parsed = JSON.parse(String(readFileSync(api.join(directory, "package.json"), "utf8")));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const own = manifestOf(root);
  if (!own) return { ok: true, verified: false, reason: "release-tree-absent" };
  const resolveDependency = (from, name) => {
    let directory = from;
    for (let depth = 0; depth < 64; depth += 1) {
      const candidate = api.join(directory, "node_modules", name);
      let present = false;
      try { present = existsSync(api.join(candidate, "package.json")); } catch { present = false; }
      if (present) return candidate;
      if (normalize(directory) === normalize(releaseRoot)) return null;
      const parent = api.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
    return null;
  };
  const seen = new Set([normalize(root)]);
  const queue = [root];
  const missing = [];
  while (queue.length && seen.size <= limit) {
    const directory = queue.shift();
    const manifest = manifestOf(directory);
    if (!manifest) { missing.push(`invalid package manifest: ${directory}`); continue; }
    const dependencies = manifest.dependencies && typeof manifest.dependencies === "object" ? Object.keys(manifest.dependencies) : [];
    for (const name of dependencies) {
      const resolved = resolveDependency(directory, name);
      if (!resolved) {
        missing.push(`${manifest.name || api.basename(directory)} needs ${name}`);
        continue;
      }
      const key = normalize(resolved);
      if (!seen.has(key)) {
        seen.add(key);
        queue.push(resolved);
      }
    }
  }
  if (missing.length) {
    return { ok: false, verified: true, reason: "release-tree-incomplete", detail: missing.slice(0, 8).join("; "), missing };
  }
  if (queue.length) return { ok: false, verified: false, reason: "release-tree-verification-limit" };
  return { ok: true, verified: true, packages: seen.size };
}

module.exports = { verifyCanonicalTreeComplete };
