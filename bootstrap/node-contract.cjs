"use strict";
// Shared by setup, application workers and the independent recovery bundle.
// An interpreter is an executable contract, never the identity of its caller.
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");

function isElectronExecutable(executable, { realpath = fs.realpathSync } = {}) {
  const electron = value => /(?:^|[\\/])(?:electron|relay)(?:\.exe|\.app(?:[\\/]|$)|$)|\.app[\\/]Contents[\\/]MacOS[\\/]/i.test(String(value || ""));
  if (electron(executable) || (executable === process.execPath && process.versions.electron)) return true;
  try { return electron(realpath(executable)); } catch { return false; }
}
function nodeEnvironment(env = process.env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(key)) delete clean[key];
  }
  return clean;
}
function verifyNode(executable, { run = spawnSync, env = process.env, realpath = fs.realpathSync } = {}) {
  if (!executable || isElectronExecutable(executable, { realpath })) return { ok: false, reason: "node-is-electron" };
  try {
    const result = run(executable, ["-p", "process.versions.electron ? '' : process.versions.node"],
      { encoding: "utf8", windowsHide: true, timeout: 5000, env: nodeEnvironment(env) });
    const version = String(result?.stdout ?? result?.out ?? "").trim();
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    const ok = !result?.error && (result?.status === 0 || result?.ok === true)
      && match && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 12));
    return { ok: Boolean(ok), version, reason: ok ? null : "node-contract-failed" };
  } catch (error) { return { ok: false, reason: "node-contract-failed", detail: error.message }; }
}
function resolveManagedNode({ homeDir = os.homedir(), node = process.execPath, run = spawnSync,
  env = process.env, read = file => JSON.parse(fs.readFileSync(file, "utf8")) } = {}) {
  const candidates = [];
  for (const file of ["recovery/current.json", "recovery/known-good.json", "recovery/launcher-node.json", "runtime/current.json"]) {
    try { const value = read(path.join(homeDir, ".relay", file)); if (value?.node) candidates.push(value.node); } catch {}
  }
  candidates.push(node);
  for (const candidate of new Set(candidates)) if (verifyNode(candidate, { run, env }).ok) return candidate;
  throw Error("No verified Relay Node runtime is available; open the Relay installer to restore it.");
}
module.exports = { isElectronExecutable, nodeEnvironment, verifyNode, resolveManagedNode };
