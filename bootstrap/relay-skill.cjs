"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SKILL_NAME = "relay";
const STATE_FILE = ".relay-managed.json";
const MANIFEST_URL = "https://sendrelays.com/skills/relay/manifest.json";
const BUNDLED_ROOT = path.resolve(__dirname, "..", "skill");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactVersion(value) {
  const version = String(value || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Relay's skill manifest has an invalid version.");
  return version;
}

function compareVersions(left, right) {
  const a = exactVersion(left).split(".").map(BigInt);
  const b = exactVersion(right).split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function safeRelativeFile(value) {
  const clean = String(value || "").replace(/\\/g, "/");
  if (!clean || clean.startsWith("/") || clean.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Relay's skill manifest contains an unsafe file path.");
  }
  return clean;
}

function validateManifest(value, { requireRemote = false } = {}) {
  if (!value || value.schemaVersion !== 1 || value.name !== SKILL_NAME || !Array.isArray(value.files) || !value.files.length) {
    throw new Error("Relay's skill manifest is invalid.");
  }
  const version = exactVersion(value.version);
  const consentVersion = Number(value.consentVersion);
  if (!Number.isSafeInteger(consentVersion) || consentVersion < 1) throw new Error("Relay's skill consent version is invalid.");
  let baseUrl = String(value.baseUrl || "");
  if (requireRemote || baseUrl) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Relay's skill manifest has an unsafe download URL.");
    }
    baseUrl = parsed.href.replace(/\/$/, "");
  }
  const seen = new Set();
  const files = value.files.map((entry) => {
    const filePath = safeRelativeFile(entry?.path);
    const digest = String(entry?.sha256 || "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(digest) || seen.has(filePath)) throw new Error("Relay's skill manifest has an invalid file digest.");
    seen.add(filePath);
    return { path: filePath, sha256: digest };
  });
  if (!seen.has("SKILL.md")) throw new Error("Relay's skill manifest does not contain SKILL.md.");
  return { schemaVersion: 1, name: SKILL_NAME, version, consentVersion, baseUrl, files };
}

function parseManifest(bytes, options) {
  let value;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { throw new Error("Relay's skill manifest is not valid JSON."); }
  return validateManifest(value, options);
}

function defaultTargets({ homeDir = os.homedir(), env = process.env, host = "all" } = {}) {
  const selected = String(host || "all").toLowerCase();
  if (!["all", "codex", "claude"].includes(selected)) throw new Error("Relay skill host must be all, codex, or claude.");
  const targets = [];
  if (selected === "all" || selected === "codex") {
    const root = env.CODEX_HOME || path.join(homeDir, ".codex");
    targets.push({ host: "codex", directory: path.join(root, "skills", SKILL_NAME) });
  }
  if (selected === "all" || selected === "claude") {
    const root = env.CLAUDE_HOME || path.join(homeDir, ".claude");
    targets.push({ host: "claude", directory: path.join(root, "skills", SKILL_NAME) });
  }
  return targets;
}

function pathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function fileHash(file) {
  return sha256(fs.readFileSync(file));
}

function readState(directory) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(directory, STATE_FILE), "utf8"));
    if (state?.schemaVersion !== 1 || state?.name !== SKILL_NAME || !Array.isArray(state.files)) return null;
    return state;
  } catch {
    return null;
  }
}

function localChanges(directory, state = readState(directory)) {
  if (!state) return fs.existsSync(directory) ? ["<unmanaged skill>"] : [];
  const changed = [];
  const managed = new Set();
  for (const entry of state.files) {
    let relative;
    try { relative = safeRelativeFile(entry.path); } catch { changed.push("<invalid managed state>"); continue; }
    managed.add(relative);
    const file = path.join(directory, ...relative.split("/"));
    try {
      if (fileHash(file) !== entry.sha256) changed.push(relative);
    } catch {
      changed.push(relative);
    }
  }
  // Preserve user-created resources too. An update swaps the whole directory,
  // so ignoring an extra file would silently delete it even though no managed
  // file had changed.
  const inspect = (current, prefix = "") => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch { changed.push(prefix || "<unreadable skill>"); return; }
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (relative === STATE_FILE) continue;
      if (entry.isDirectory()) inspect(path.join(current, entry.name), relative);
      else if (!managed.has(relative)) changed.push(relative);
    }
  };
  inspect(directory);
  return changed;
}

function stateFor(manifest) {
  return {
    schemaVersion: 1,
    name: SKILL_NAME,
    version: manifest.version,
    consentVersion: manifest.consentVersion,
    installedAt: new Date().toISOString(),
    files: manifest.files.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function materialize(manifest, staging, readFile) {
  for (const entry of manifest.files) {
    const destination = path.join(staging, ...entry.path.split("/"));
    if (!pathInside(staging, destination)) throw new Error("Relay refused an unsafe skill destination.");
    const bytes = Buffer.from(await readFile(entry));
    if (sha256(bytes) !== entry.sha256) throw new Error(`Relay refused a modified skill file (${entry.path}).`);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, bytes, { mode: entry.path.startsWith("scripts/") ? 0o700 : 0o600 });
  }
  writeJson(path.join(staging, STATE_FILE), stateFor(manifest));
}

async function installOne(directory, manifest, readFile, { consent = false, renewConsent = false } = {}) {
  const parent = path.dirname(directory);
  const existing = readState(directory);
  const changes = localChanges(directory, existing);
  if (changes.length) return { ok: false, status: existing ? "modified" : "unmanaged", directory, changedFiles: changes };
  if (!existing && !consent) return { ok: false, status: "consent_required", directory, consentVersion: manifest.consentVersion };
  if (existing && compareVersions(manifest.version, existing.version) < 0) {
    return { ok: true, status: "downgrade_refused", directory, version: existing.version, offeredVersion: manifest.version };
  }
  if (existing && manifest.consentVersion > Number(existing.consentVersion || 0) && !renewConsent) {
    return { ok: false, status: "renewed_consent_required", directory, consentVersion: manifest.consentVersion };
  }
  if (existing?.version === manifest.version) return { ok: true, status: "current", directory, version: manifest.version };

  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(parent, `.${SKILL_NAME}-staging-`));
  const rollback = path.join(parent, `.${SKILL_NAME}-rollback`);
  if (!pathInside(parent, staging) || !pathInside(parent, rollback)) throw new Error("Relay refused an unsafe skill update location.");
  try {
    await materialize(manifest, staging, readFile);
    if (fs.existsSync(rollback)) fs.rmSync(rollback, { recursive: true, force: true });
    if (fs.existsSync(directory)) fs.renameSync(directory, rollback);
    try {
      fs.renameSync(staging, directory);
    } catch (error) {
      if (!fs.existsSync(directory) && fs.existsSync(rollback)) fs.renameSync(rollback, directory);
      throw error;
    }
    return { ok: true, status: existing ? "updated" : "installed", directory, version: manifest.version, rollback: fs.existsSync(rollback) ? rollback : null };
  } finally {
    if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function fetchBytes(url, { fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(url, { headers: { "X-Relay-Client": "relay-skill-updater" }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Relay skill download failed (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

async function installManifest(manifest, readFile, options = {}) {
  const targets = options.targets || defaultTargets(options);
  const results = [];
  for (const target of targets) {
    try { results.push({ host: target.host, ...(await installOne(target.directory, manifest, readFile, options)) }); }
    catch (error) { results.push({ host: target.host, ok: false, status: "failed", directory: target.directory, error: error?.message || String(error) }); }
  }
  return { ok: results.every((item) => item.ok), version: manifest.version, results };
}

async function installBundled(options = {}) {
  const manifest = parseManifest(fs.readFileSync(path.join(BUNDLED_ROOT, "manifest.json")));
  const root = path.join(BUNDLED_ROOT, SKILL_NAME);
  return installManifest(manifest, (entry) => fs.readFileSync(path.join(root, ...entry.path.split("/"))), options);
}

async function updateFromRemote(options = {}) {
  const manifestUrl = String(options.manifestUrl || MANIFEST_URL);
  const parsedUrl = new URL(manifestUrl);
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.hash) {
    throw new Error("Relay requires a secure skill manifest URL.");
  }
  const manifest = parseManifest(await fetchBytes(parsedUrl.href, options), { requireRemote: true });
  return installManifest(manifest, (entry) => fetchBytes(`${manifest.baseUrl}/${entry.path.split("/").map(encodeURIComponent).join("/")}`, options), options);
}

function rollbackOne(directory) {
  const parent = path.dirname(directory);
  const rollback = path.join(parent, `.${SKILL_NAME}-rollback`);
  if (!pathInside(parent, rollback) || !fs.existsSync(rollback)) return { ok: false, status: "no_rollback", directory };
  const currentChanges = localChanges(directory);
  if (currentChanges.length) return { ok: false, status: readState(directory) ? "modified" : "unmanaged", directory, changedFiles: currentChanges };
  const rollbackChanges = localChanges(rollback);
  if (rollbackChanges.length) return { ok: false, status: "rollback_modified", directory, changedFiles: rollbackChanges };
  const current = path.join(parent, `.${SKILL_NAME}-replaced-${process.pid}-${Date.now()}`);
  if (!pathInside(parent, current)) throw new Error("Relay refused an unsafe rollback location.");
  if (fs.existsSync(directory)) fs.renameSync(directory, current);
  try {
    fs.renameSync(rollback, directory);
    if (fs.existsSync(current)) fs.rmSync(current, { recursive: true, force: true });
    return { ok: true, status: "rolled_back", directory, version: readState(directory)?.version || "" };
  } catch (error) {
    if (!fs.existsSync(directory) && fs.existsSync(current)) fs.renameSync(current, directory);
    throw error;
  }
}

async function runCli(argv = process.argv.slice(2), options = {}) {
  const [command = "status", ...rest] = argv;
  const hostFlag = rest.indexOf("--host");
  const host = hostFlag >= 0 ? rest[hostFlag + 1] : "all";
  const common = {
    ...options,
    host,
    consent: rest.includes("--consent"),
    renewConsent: rest.includes("--renew-consent"),
  };
  if (command === "install") return installBundled(common);
  if (command === "update") return updateFromRemote(common);
  if (command === "rollback") {
    const results = defaultTargets(common).map((target) => ({ host: target.host, ...rollbackOne(target.directory) }));
    return { ok: results.every((item) => item.ok), results };
  }
  if (command === "status") {
    const results = defaultTargets(common).map((target) => ({
      host: target.host,
      directory: target.directory,
      state: readState(target.directory),
      changedFiles: localChanges(target.directory),
    }));
    return { ok: true, results };
  }
  throw new Error("Usage: relay skill install --consent [--host all|codex|claude] | update [--renew-consent] | status | rollback");
}

if (require.main === module) {
  runCli().then((result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BUNDLED_ROOT,
  MANIFEST_URL,
  SKILL_NAME,
  STATE_FILE,
  compareVersions,
  defaultTargets,
  installBundled,
  installManifest,
  installOne,
  localChanges,
  parseManifest,
  readState,
  rollbackOne,
  runCli,
  sha256,
  updateFromRemote,
  validateManifest,
};
