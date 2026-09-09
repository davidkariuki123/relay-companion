"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { runtimeProcessCommands } = require("./runtime-health.cjs");
function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function installationId({ homeDir = os.homedir(), create = false } = {}) {
  const file = path.join(homeDir, ".relay", "installation-id.json");
  const existing = read(file);
  if (/^ins_[a-f0-9]{32}$/.test(existing?.id || "")) return existing.id;
  if (!create || fs.existsSync(file)) return null;
  const id = `ins_${crypto.randomBytes(16).toString("hex")}`;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, JSON.stringify({ schema: 1, id }), { mode: 0o600, flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  return read(file)?.id || null;
}
function componentInventory(commands, activeVersion = null) {
  const roles = new Map();
  for (const command of commands) {
    if (!/node_modules[\\/]relay-companion[\\/]/i.test(command)) continue;
    const role = /[\\/]mcp-broker-entry\.js\b/.test(command) ? "mcp-broker"
      : /[\\/]relay\.js.*\bdaemon\b/.test(command) ? "daemon"
      : /[\\/]overlay[\\/]main\.cjs(?:"|'|\s|$)/.test(command) ? "pill" : null;
    if (!role) continue;
    const version = /[\\/]releases[\\/](\d+\.\d+\.\d+)(?:-|[\\/])/.exec(command)?.[1] || null;
    const key = `${role}:${version}`;
    const item = roles.get(key) || { role, version, count: 0 };
    item.count++; roles.set(key, item);
  }
  const components = [...roles.values()];
  const duplicates = ["daemon", "pill"].some(role => components.filter(c => c.role === role).reduce((n,c) => n+c.count,0) > 1);
  const mixed = components.some(c => c.version && activeVersion && c.version !== activeVersion);
  return { components: components.slice(0, 12), duplicates, mixed };
}
function collectInstallationHealth({ homeDir = os.homedir(), platform = process.platform, arch = process.arch,
  osVersion = os.release(), commands, now = Date.now() } = {}) {
  const root = path.join(homeDir, ".relay"), current = read(path.join(root, "runtime", "current.json"));
  const activeVersion = current?.active === true ? current.version : null;
  const inventory = componentInventory(commands || runtimeProcessCommands(platform), activeVersion);
  const supervisor = read(path.join(root, "recovery", "status.json"));
  const heartbeat = read(path.join(root, "recovery", "daemon.json"));
  const transport = (name) => {
    const report = read(path.join(root, "transport-health", `${name}.json`));
    return report?.at > 0 && now >= report.at ? new Date(report.at).toISOString() : null;
  };
  return {
    installationId: installationId({ homeDir }), os: platform, osVersion: osVersion.slice(0, 80), arch,
    ...inventory, daemonResponsive: Boolean(heartbeat?.at <= now && now - heartbeat.at < 60_000),
    recovery: supervisor ? { status: supervisor.status, version: supervisor.launcherVersion || null,
      checkedAt: supervisor.checkedAt > 0 ? new Date(supervisor.checkedAt).toISOString() : null,
      desiredVersion: supervisor.desiredVersion || null,
      lastSuccessAt: supervisor.lastSuccessAt > 0 ? new Date(supervisor.lastSuccessAt).toISOString() : null,
      // Do not upload logs, URLs, usernames, or raw errors. These stay in doctor.
      failureCode: supervisor.ok === false ? "recovery-failed" : null } : null,
    transports: { mcpLastUsedAt: transport("mcp"), httpsLastUsedAt: transport("https") },
  };
}
function recordTransport(name, { homeDir = os.homedir(), now = Date.now() } = {}) {
  if (!["mcp", "https"].includes(name)) return;
  const root = path.join(homeDir, ".relay", "transport-health");
  try { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify({ at: now }), { mode: 0o600 }); } catch {}
}
module.exports = { installationId, componentInventory, collectInstallationHealth, recordTransport };
