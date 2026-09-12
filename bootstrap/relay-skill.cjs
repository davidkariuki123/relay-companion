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
    targets.push({ host: "codex", target: "primary", directory: path.join(root, "skills", SKILL_NAME) });
    targets.push({ host: "codex", target: "compatibility", directory: path.join(homeDir, ".agents", "skills", SKILL_NAME) });
  }
  if (selected === "all" || selected === "claude") {
    const root = env.CLAUDE_HOME || path.join(homeDir, ".claude");
    targets.push({ host: "claude", target: "primary", directory: path.join(root, "skills", SKILL_NAME) });
  }
  return targets.filter((target, index) => targets.findIndex((other) => path.resolve(other.directory) === path.resolve(target.directory)) === index);
}

function configuredManifestUrl({ homeDir = os.homedir(), env = process.env, webOrigin } = {}) {
  const configRoot = env.RELAY_CONFIG_DIR || path.join(homeDir, ".relay");
  function read(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  }
  const config = read(env.RELAY_CONFIG || path.join(configRoot, "config.json"));
  const agent = config.webUrl || config.apiUrl ? {} : read(env.RELAY_AGENT_CONFIG || path.join(configRoot, "agent-protocol.json"));
  const api = config.apiUrl || agent.apiUrl;
  const knownOrigin = !api || api === "https://api.sendrelays.com" ? "https://sendrelays.com"
    : api === "https://dev-api.sendrelays.com" ? "https://dev.sendrelays.com"
    : api === "https://cti37jd7vx.us-east-1.awsapprunner.com" ? "https://8epdrqim29.us-east-1.awsapprunner.com" : null;
  const origin = webOrigin || env.RELAY_WEB_URL || config.webUrl || knownOrigin;
  if (!origin) throw new Error("Relay requires a configured web origin for this API environment's skill updates.");
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Relay requires a secure configured web origin for skill updates.");
  }
  return new URL("/skills/relay/manifest.json", url).href;
}

function pathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Where the previous skill tree is kept for `relay skill rollback`. It used to
// be a sibling of the installed skill (`.relay-rollback` inside the host's
// skills folder), and Claude Code and Codex load any directory there that has
// a SKILL.md, so every session saw the Relay skill twice. It now lives under
// Relay's own state directory, keyed by the target it backs.
function rollbackRoot({ homeDir = os.homedir(), env = process.env } = {}) {
  return path.join(env.RELAY_CONFIG_DIR || path.join(homeDir, ".relay"), "skill-rollback");
}

function rollbackPathFor(directory, options = {}) {
  return path.join(rollbackRoot(options), sha256(path.resolve(directory)).slice(0, 16));
}

function legacyRollbackPath(directory) {
  return path.join(path.dirname(directory), `.${SKILL_NAME}-rollback`);
}

// A rename when both paths share a volume; a copy and remove when they do not
// (CODEX_HOME or RELAY_CONFIG_DIR may point at another drive).
function moveTree(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
  try {
    fs.renameSync(from, to);
    return;
  } catch (error) {
    if (error.code !== "EXDEV") throw error;
  }
  fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
  fs.rmSync(from, { recursive: true, force: true });
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

function installedStateEntries(state) {
  if (!state || state.schemaVersion !== 1 || state.name !== SKILL_NAME || !Array.isArray(state.files)) return null;
  try { exactVersion(state.version); } catch { return null; }
  const entries = new Map();
  for (const entry of state.files) {
    let relative;
    try { relative = safeRelativeFile(entry?.path); } catch { return null; }
    const digest = String(entry?.sha256 || "").toLowerCase();
    if (relative === STATE_FILE || !/^[a-f0-9]{64}$/.test(digest) || entries.has(relative)) return null;
    entries.set(relative, digest);
  }
  return entries.has("SKILL.md") ? entries : null;
}

function treeLeaves(directory, current = directory, prefix = "") {
  const leaves = [];
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      leaves.push(...treeLeaves(directory, path.join(current, entry.name), relative));
    } else {
      leaves.push({ relative, file: path.join(directory, ...relative.split("/")), regular: entry.isFile() });
    }
  }
  return leaves;
}

function removeSkillArtifact(directory) {
  if (!fs.existsSync(directory)) return { ok: true, status: "already_absent", directory };
  let root;
  let leaves;
  try {
    root = fs.lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) {
      return { ok: false, status: "unmanaged", directory, changedFiles: ["<unmanaged skill>"] };
    }
    leaves = treeLeaves(directory);
  } catch (error) {
    return { ok: false, status: "failed", directory, error: error?.message || String(error) };
  }

  const state = readState(directory);
  const managed = installedStateEntries(state);
  if (!managed) {
    // A killed or older uninstall can leave the known Relay directory shell
    // behind after its files are gone. Empty directories contain no human data
    // and are safe to finish removing without an ownership marker.
    if (leaves.length !== 0) {
      return { ok: false, status: "unmanaged", directory, changedFiles: ["<unmanaged skill>"] };
    }
  } else {
    const changedFiles = [];
    for (const leaf of leaves) {
      if (leaf.relative === STATE_FILE) continue;
      const expected = managed.get(leaf.relative);
      if (!leaf.regular || !expected) {
        changedFiles.push(leaf.relative);
        continue;
      }
      try {
        if (fileHash(leaf.file) !== expected) changedFiles.push(leaf.relative);
      } catch {
        changedFiles.push(leaf.relative);
      }
    }
    // Missing manifest files are already removed and therefore harmless. Any
    // surviving modified or additional file may belong to the human, so leave
    // the entire artifact intact and make the top-level uninstall fail loudly.
    if (changedFiles.length) {
      return { ok: false, status: "modified", directory, changedFiles };
    }
  }

  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (error) {
    return { ok: false, status: "failed", directory, error: error?.message || String(error) };
  }
  return fs.existsSync(directory)
    ? { ok: false, status: "failed", directory, error: "The skill directory still exists after removal." }
    : { ok: true, status: managed ? "removed" : "empty_debris_removed", directory };
}

function skillArtifacts(directory, options = {}) {
  const parent = path.dirname(directory);
  const name = path.basename(directory);
  const artifacts = [directory];
  const rollback = rollbackPathFor(directory, options);
  if (fs.existsSync(rollback)) artifacts.push(rollback);
  let entries = [];
  try { entries = fs.readdirSync(parent, { withFileTypes: true }); }
  catch (error) {
    if (error.code === "ENOENT") return artifacts;
    throw error;
  }
  const generated = [`.${name}-rollback`, `.${name}-staging-`, `.${name}-replaced-`];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    if (entry.name === generated[0] || generated.slice(1).some((prefix) => entry.name.startsWith(prefix))) {
      artifacts.push(path.join(parent, entry.name));
    }
  }
  return artifacts;
}

function uninstallManaged(options = {}) {
  const targets = options.targets || defaultTargets(options);
  const results = [];
  const seen = new Set();
  for (const target of targets) {
    let artifacts;
    try { artifacts = skillArtifacts(target.directory, options); }
    catch (error) {
      results.push({ host: target.host, ok: false, status: "failed", directory: target.directory, error: error?.message || String(error) });
      continue;
    }
    for (const directory of artifacts) {
      const key = path.resolve(directory);
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ host: target.host, ...removeSkillArtifact(directory) });
    }
  }
  const failures = results.filter((result) => !result.ok);
  return {
    ok: failures.length === 0,
    results,
    failures,
    ...(failures.length ? {
      detail: failures.map((failure) => {
        const changed = failure.changedFiles?.length ? ` (${failure.changedFiles.join(", ")})` : "";
        return `${failure.directory}: ${failure.error || failure.status}${changed}`;
      }).join("; "),
    } : {}),
  };
}

function stateFor(manifest, target = {}, existing = null) {
  return {
    schemaVersion: 1,
    name: SKILL_NAME,
    version: manifest.version,
    consentVersion: manifest.consentVersion,
    host: target.host || null,
    target: target.target || "primary",
    installationId: /^ski_[A-Za-z0-9_-]{20,80}$/.test(String(existing?.installationId || ""))
      ? existing.installationId
      : `ski_${crypto.randomBytes(18).toString("base64url")}`,
    installedAt: new Date().toISOString(),
    files: manifest.files.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function materialize(manifest, staging, readFile, target, existing) {
  for (const entry of manifest.files) {
    const destination = path.join(staging, ...entry.path.split("/"));
    if (!pathInside(staging, destination)) throw new Error("Relay refused an unsafe skill destination.");
    const bytes = Buffer.from(await readFile(entry));
    if (sha256(bytes) !== entry.sha256) throw new Error(`Relay refused a modified skill file (${entry.path}).`);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, bytes, { mode: entry.path.startsWith("scripts/") ? 0o700 : 0o600 });
  }
  writeJson(path.join(staging, STATE_FILE), stateFor(manifest, target, existing));
}

async function installOne(directory, manifest, readFile, options = {}) {
  const { consent = false, renewConsent = false } = options;
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
  const rollback = rollbackPathFor(directory, options);
  const legacyRollback = legacyRollbackPath(directory);
  if (!pathInside(parent, staging) || !pathInside(rollbackRoot(options), rollback) || !pathInside(parent, legacyRollback)) {
    throw new Error("Relay refused an unsafe skill update location.");
  }
  try {
    await materialize(manifest, staging, readFile, options, existing);
    // One rollback copy per target. A copy an earlier installer left beside
    // the skill goes too: hosts load it as a second skill.
    for (const stale of [rollback, legacyRollback]) {
      if (fs.existsSync(stale)) fs.rmSync(stale, { recursive: true, force: true });
    }
    if (fs.existsSync(directory)) moveTree(directory, rollback);
    try {
      fs.renameSync(staging, directory);
    } catch (error) {
      if (!fs.existsSync(directory) && fs.existsSync(rollback)) moveTree(rollback, directory);
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
    try { results.push({ host: target.host, target: target.target, ...(await installOne(target.directory, manifest, readFile, { ...options, ...target })) }); }
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
  const manifestUrl = String(options.manifestUrl || configuredManifestUrl(options));
  const parsedUrl = new URL(manifestUrl);
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password || parsedUrl.hash) {
    throw new Error("Relay requires a secure skill manifest URL.");
  }
  const manifest = parseManifest(await fetchBytes(parsedUrl.href, options), { requireRemote: true });
  if (new URL(manifest.baseUrl).origin !== parsedUrl.origin) throw new Error("Relay's skill bundle must use the configured web origin.");
  return installManifest(manifest, (entry) => fetchBytes(`${manifest.baseUrl}/${entry.path.split("/").map(encodeURIComponent).join("/")}`, options), options);
}

function rollbackOne(directory, options = {}) {
  const parent = path.dirname(directory);
  // The current location first; a copy an earlier installer left beside the
  // skill still rolls back once.
  const rollback = [rollbackPathFor(directory, options), legacyRollbackPath(directory)].find((candidate) => fs.existsSync(candidate));
  if (!rollback) return { ok: false, status: "no_rollback", directory };
  if (!pathInside(rollbackRoot(options), rollback) && !pathInside(parent, rollback)) throw new Error("Relay refused an unsafe rollback location.");
  const currentChanges = localChanges(directory);
  if (currentChanges.length) return { ok: false, status: readState(directory) ? "modified" : "unmanaged", directory, changedFiles: currentChanges };
  const rollbackChanges = localChanges(rollback);
  if (rollbackChanges.length) return { ok: false, status: "rollback_modified", directory, changedFiles: rollbackChanges };
  const current = path.join(parent, `.${SKILL_NAME}-replaced-${process.pid}-${Date.now()}`);
  if (!pathInside(parent, current)) throw new Error("Relay refused an unsafe rollback location.");
  if (fs.existsSync(directory)) fs.renameSync(directory, current);
  try {
    moveTree(rollback, directory);
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
    const results = defaultTargets(common).map((target) => ({ host: target.host, ...rollbackOne(target.directory, common) }));
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
  configuredManifestUrl,
  defaultTargets,
  installBundled,
  installManifest,
  installOne,
  localChanges,
  parseManifest,
  readState,
  rollbackOne,
  rollbackPathFor,
  runCli,
  sha256,
  uninstallManaged,
  updateFromRemote,
  validateManifest,
};
