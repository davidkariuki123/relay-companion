import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withCodexAppServer } from "./codex-app-server.js";
import { cliBinaryPath, installedCliVersions } from "./desktop-wake.js";

const execFileDefault = promisify(execFileCallback);
const PROVIDERS = Object.freeze({
  claude: {
    id: "claude",
    label: "Claude Code",
    candidates: (env = process.env) => [
      env.CLAUDE_CLI_PATH,
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      path.join(os.homedir(), ".local", "bin", "claude"),
      ...installedCliVersions().reverse().map((version) => cliBinaryPath(version)),
      "claude",
    ],
    statusArgs: ["auth", "status", "--json"],
    loginArgs: ["auth", "login", "--claudeai"],
  },
  codex: {
    id: "codex",
    label: "Codex",
    candidates: (env = process.env) => [
      env.CODEX_CLI_PATH,
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
      path.join(os.homedir(), ".local", "bin", "codex"),
      "codex",
    ],
    statusArgs: ["login", "status"],
    loginArgs: ["login"],
  },
});

const activeLogins = new Map();
const lastAttempts = new Map();
const activeRemoteLogins = new Map();
const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const REMOTE_AUTH_OUTPUT_MAX_BYTES = 128 * 1024;
const REMOTE_AUTH_CONTEXT = "relay-provider-auth-code-v1";
const CLAUDE_MCP_BATCH_SIZE = "8";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { linuxTerminalEnvironment, linuxTerminalInvocation } = require("../overlay/linux-terminal.cjs");
const EXPECT_RUNNER = path.join(MODULE_DIR, "provider-auth-runner.exp");
const TERMINAL_APP = "Terminal";

function configPath(root = process.env.RELAY_HOME || process.env.RELAY_COMPANION_HOME || path.join(os.homedir(), ".relay-companion")) {
  return path.join(root, "provider-connections.json");
}

function readPrefs(file = configPath()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function enabledFromPrefs(provider, prefs) {
  return prefs?.providers?.[provider]?.enabled !== false;
}

function writePrefs(provider, enabled, file = configPath()) {
  const prefs = readPrefs(file);
  const next = {
    ...prefs,
    version: 1,
    providers: {
      ...(prefs.providers && typeof prefs.providers === "object" ? prefs.providers : {}),
      [provider]: {
        ...(prefs?.providers?.[provider] && typeof prefs.providers[provider] === "object" ? prefs.providers[provider] : {}),
        enabled: Boolean(enabled),
      },
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  return next;
}

function normalizedProviderCommand(candidate) {
  const value = String(candidate || "").trim();
  if (!value) return "";
  if (!value.includes(path.sep) && !value.includes("/")) return value;
  const absolute = path.resolve(value);
  try {
    fs.accessSync(absolute, fs.constants.X_OK);
    return fs.statSync(absolute).isFile() ? absolute : "";
  } catch {
    return "";
  }
}

function commandExists(candidate, { platform = process.platform } = {}) {
  // Target-platform unit tests exercise macOS paths on other hosts. The actual
  // target still verifies its files; a cross-platform probe can only preserve
  // the injected command and let the spawn boundary report a real failure.
  if (platform !== process.platform) return Boolean(String(candidate || "").trim());
  return Boolean(normalizedProviderCommand(candidate));
}

export function resolveProviderCommand(provider, { command = "", env = process.env } = {}) {
  const spec = PROVIDERS[String(provider || "")];
  if (!spec) throw new Error("Unknown provider connection.");
  if (command) return String(command).trim();
  return spec.candidates(env).map(normalizedProviderCommand).find(Boolean) || "";
}

function safeMessage(value, max = 500) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

function stripTerminalControl(value) {
  return String(value || "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function remoteAuthorizeUrl(provider, output) {
  const matches = stripTerminalControl(output).match(/https:\/\/[^\s<>"']+/g) || [];
  for (const candidate of matches) {
    let parsed;
    try { parsed = new URL(candidate); } catch { continue; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) continue;
    if (provider === "claude" && parsed.hostname === "claude.com" && parsed.pathname === "/cai/oauth/authorize") {
      return parsed.href;
    }
    if (provider === "codex" && parsed.hostname === "auth.openai.com" && parsed.pathname === "/codex/device"
        && !parsed.search && !parsed.hash) return parsed.href;
  }
  return "";
}

function codexDeviceCode(output) {
  return stripTerminalControl(output).match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/)?.[0] || "";
}

function canonicalBase64Url(value, bytes) {
  const text = String(value || "");
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("The encrypted authorization response is invalid.");
  const decoded = Buffer.from(text, "base64url");
  if ((bytes && decoded.length !== bytes) || decoded.toString("base64url") !== text) {
    throw new Error("The encrypted authorization response is invalid.");
  }
  return decoded;
}

function validateClaudeAuthorizationCode(value) {
  const code = String(value || "");
  if (!code || code !== code.trim() || code.length > 4096 || /[\u0000-\u001f\u007f]/.test(code)) {
    throw new Error("The Claude authorization code is invalid.");
  }
  return code;
}

function decryptClaudeAuthorizationCode(authId, privateKey, envelope) {
  if (!envelope || envelope.version !== 1) throw new Error("The encrypted authorization response is invalid.");
  const peer = createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: canonicalBase64Url(envelope.ephemeralPublicKey, 32).toString("base64url") },
    format: "jwk",
  });
  const shared = diffieHellman({ privateKey, publicKey: peer });
  const key = Buffer.from(hkdfSync(
    "sha256",
    shared,
    Buffer.from(authId, "utf8"),
    Buffer.from(REMOTE_AUTH_CONTEXT, "utf8"),
    32,
  ));
  const nonce = canonicalBase64Url(envelope.nonce, 12);
  const sealed = canonicalBase64Url(envelope.ciphertext);
  if (sealed.length < 17 || sealed.length > 5_000) throw new Error("The encrypted authorization response is invalid.");
  const ciphertext = sealed.subarray(0, -16);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(Buffer.from(authId, "utf8"));
  decipher.setAuthTag(sealed.subarray(-16));
  let plaintext;
  try { plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"); }
  catch { throw new Error("The encrypted authorization response could not be opened on this computer."); }
  return validateClaudeAuthorizationCode(plaintext);
}

export function providerAuthenticationFailure(value) {
  return /authentication_failed|login expired|failed to authenticate|oauth access token.*revoked|not logged in|please run \/login/i
    .test(String(value?.message || value || ""));
}

function safeIntegrationName(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9 ._+-]/g, "").slice(0, 80);
}

function localIntegrationNames(provider, homedir = os.homedir()) {
  const names = new Set();
  if (provider === "claude") {
    try {
      const config = JSON.parse(fs.readFileSync(process.env.CLAUDE_CODE_CONFIG || path.join(homedir, ".claude.json"), "utf8"));
      for (const name of Object.keys(config?.mcpServers || {})) names.add(safeIntegrationName(name));
    } catch {}
  } else if (provider === "codex") {
    try {
      const source = fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(homedir, ".codex"), "config.toml"), "utf8");
      for (const match of source.matchAll(/^\s*\[mcp_servers\.([^\].]+)\]\s*$/gm)) names.add(safeIntegrationName(match[1]));
    } catch {}
  }
  return [...names].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function integrationRecord(name, status = "Configured", source = "local") {
  const safeName = safeIntegrationName(name);
  if (!safeName) return null;
  return { name: safeName, status: safeMessage(status, 80) || "Configured", source };
}

export function configuredProviderInventory({ homedir = os.homedir() } = {}) {
  const providers = {};
  for (const id of Object.keys(PROVIDERS)) {
    providers[id] = {
      integrations: {
        mcpServers: localIntegrationNames(id, homedir).map((name) => integrationRecord(name)).filter(Boolean),
        apps: [],
      },
    };
  }
  return { ok: true, providers };
}

function parseClaudeMcpList(stdout) {
  const integrations = [];
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^checking mcp server health/i.test(line) || /^no mcp servers/i.test(line)) continue;
    const separator = line.lastIndexOf(" - ");
    if (separator < 0) continue;
    const left = line.slice(0, separator).trim();
    const colon = left.indexOf(":");
    if (colon < 0) continue;
    let name = left.slice(0, colon).trim();
    let source = "local";
    if (name.startsWith("claude.ai ")) {
      name = name.slice("claude.ai ".length).trim();
      source = "account";
    }
    const rawStatus = line.slice(separator + 3).replace(/^[✔!✘✖]\s*/, "").trim();
    const record = integrationRecord(name, rawStatus, source);
    if (record) integrations.push(record);
  }
  return integrations.sort((a, b) => a.name.localeCompare(b.name));
}

async function installedCodexApps() {
  return withCodexAppServer(async (client) => {
    const snapshot = await client.request("app/installed", { forceRefresh: false });
    return (Array.isArray(snapshot?.apps) ? snapshot.apps : [])
      // These are Codex's own control surfaces, not user-connected apps.
      .filter((app) => !String(app?.id || "").startsWith("connector_openai_"))
      .map((app) => ({
        name: safeIntegrationName(app?.runtimeName),
        status: app?.callable ? "Connected" : app?.enabled ? "Unavailable" : "Disabled",
        source: "account",
      }))
      .filter((app) => app.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

async function providerIntegrations(provider, {
  runtime,
  execFile = execFileDefault,
  timeoutMs = 8_000,
  codexApps = installedCodexApps,
  homedir = os.homedir(),
  mcpBatchSize = CLAUDE_MCP_BATCH_SIZE,
} = {}) {
  const configured = localIntegrationNames(provider, homedir)
    .map((name) => integrationRecord(name))
    .filter(Boolean);
  if (!runtime) return { mcpServers: configured, apps: [] };
  if (provider === "claude") {
    try {
      const result = await execFile(runtime, ["mcp", "list"], {
        timeout: Math.max(timeoutMs, 15_000),
        maxBuffer: 512 * 1024,
        // Claude Code health-checks MCPs in batches. Its default of three makes
        // Settings wait through multiple waves on connector-heavy accounts.
        env: {
          ...process.env,
          MCP_SERVER_CONNECTION_BATCH_SIZE: process.env.MCP_SERVER_CONNECTION_BATCH_SIZE || String(mcpBatchSize),
        },
      });
      const discovered = parseClaudeMcpList(result?.stdout);
      return { mcpServers: discovered.length ? discovered : configured, apps: [] };
    } catch {
      return { mcpServers: configured, apps: [] };
    }
  }
  if (provider === "codex") {
    try {
      return { mcpServers: configured, apps: await codexApps() };
    } catch {
      return { mcpServers: configured, apps: [] };
    }
  }
  return { mcpServers: configured, apps: [] };
}

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'"'"'`)}'`;
}

function removeAttemptFiles(state) {
  for (const file of [state?.scriptPath, state?.markerPath]) {
    if (!file) continue;
    try { fs.unlinkSync(file); } catch {}
  }
}

function finishAttempt(id, state, message) {
  if (!state || state.finished) return;
  state.finished = true;
  if (state.timer) clearTimeout(state.timer);
  if (activeLogins.get(id) === state) activeLogins.delete(id);
  removeAttemptFiles(state);
  lastAttempts.set(id, { at: Date.now(), message });
}

function settleTerminalAttempt(id) {
  const state = activeLogins.get(id);
  if (!state?.markerPath || state.finished) return;
  let result = "";
  try { result = fs.readFileSync(state.markerPath, "utf8").trim(); } catch { return; }
  const code = Number.parseInt(result, 10);
  finishAttempt(id, state, code === 0
    ? "Authorization finished, but the subscription connection was not saved. Check the Terminal window, then try again."
    : "Authorization did not complete. Check the Terminal window for the provider's error, then try again.");
}

function terminalAttemptPaths(id, prefsFile) {
  const directory = path.join(path.dirname(prefsFile), "provider-auth");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  const nonce = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  return {
    scriptPath: path.join(directory, `${id}-${nonce}.command`),
    markerPath: path.join(directory, `${id}-${nonce}.result`),
  };
}

function writeTerminalLoginScript(id, runtime, loginArgs, paths, { platform = process.platform } = {}) {
  const label = PROVIDERS[id].label;
  const script = `#!${platform === "linux" ? "/bin/sh" : "/bin/zsh"}
set -u
echo "Relay opened ${label}'s official subscription sign-in."
echo "Complete the provider and browser prompts in this window."
${[runtime, ...loginArgs].map(shellQuote).join(" ")}
result=$?
printf '%s\\n' "$result" > ${shellQuote(paths.markerPath)}
echo ""
if [ "$result" -eq 0 ]; then
  echo "${label} finished. Return to Relay Settings to confirm the connection."
else
  echo "${label} did not finish signing in. Resolve the error above, then reconnect from Relay Settings."
fi
echo "You may close this Terminal window."
exit "$result"
`;
  fs.writeFileSync(paths.scriptPath, script, { mode: 0o700 });
  try { fs.chmodSync(paths.scriptPath, 0o700); } catch {}
  return paths;
}

function loginInvocation(runtime, loginArgs, {
  platform = process.platform,
  expectCommand = "/usr/bin/expect",
  expectRunner = EXPECT_RUNNER,
} = {}) {
  // Both provider CLIs own their OAuth callback and credential persistence.
  // On macOS they must run inside a real pseudo-terminal. `script(1)` cannot
  // provide that when Electron's stdio is a pipe/socket: it exits immediately
  // with tcgetattr/ioctl ENOTTY and takes the OAuth callback listener with it.
  // The system `expect` binary owns the PTY independently of Electron stdio.
  if (platform === "darwin" && commandExists(expectCommand, { platform }) && commandExists(expectRunner, { platform })) {
    return {
      command: expectCommand,
      args: ["-f", expectRunner, "--", runtime, ...loginArgs],
    };
  }
  return { command: runtime, args: [...loginArgs] };
}

function attemptDetail(id, parsed) {
  if (parsed.connected) {
    lastAttempts.delete(id);
    return parsed.detail;
  }
  const attempt = lastAttempts.get(id);
  if (!attempt) return parsed.detail;
  return attempt.message || "Authorization did not complete. Try again.";
}

function parseClaudeStatus(stdout) {
  let payload = null;
  const text = String(stdout || "").trim();
  try { payload = JSON.parse(text); } catch {
    // Some CLI builds print an update notice around --json output. Do not
    // mislabel a valid first-party login as signed out because of that noise.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { payload = JSON.parse(text.slice(start, end + 1)); } catch {}
    }
  }
  const loggedIn = payload?.loggedIn === true;
  const apiProvider = String(payload?.apiProvider || "");
  const authMethod = String(payload?.authMethod || "");
  const subscription = loggedIn && apiProvider === "firstParty" && authMethod !== "api_key";
  const authState = subscription ? "subscription" : loggedIn ? "api_billing" : "signed_out";
  return {
    connected: subscription,
    subscription,
    authState,
    method: subscription ? (authMethod || "claude.ai") : "",
    detail: subscription
      ? "Claude subscription"
      : loggedIn
        ? "Claude is signed in with API billing, not a subscription."
        : "Sign in with your Claude subscription.",
  };
}

function parseCodexStatus(stdout, stderr, exitCode = 0) {
  const text = `${stdout || ""}\n${stderr || ""}`.trim();
  const chatgpt = exitCode === 0 && /logged in using chatgpt/i.test(text);
  const apiKey = /api key/i.test(text) && /logged in/i.test(text);
  return {
    connected: chatgpt,
    subscription: chatgpt,
    authState: chatgpt ? "subscription" : apiKey ? "api_billing" : "signed_out",
    method: chatgpt ? "chatgpt" : "",
    detail: chatgpt
      ? "ChatGPT subscription"
      : apiKey
        ? "Codex is signed in with API billing, not ChatGPT."
        : "Sign in with your ChatGPT subscription.",
  };
}

export async function providerAuthStatus(provider, {
  command = "",
  execFile = execFileDefault,
  prefsFile = configPath(),
  timeoutMs = 8_000,
  codexApps = installedCodexApps,
  homedir = os.homedir(),
  includeIntegrations = false,
} = {}) {
  const id = String(provider || "");
  const spec = PROVIDERS[id];
  if (!spec) throw new Error("Unknown provider connection.");
  settleTerminalAttempt(id);
  const enabled = enabledFromPrefs(id, readPrefs(prefsFile));
  const runtime = resolveProviderCommand(id, { command });
  const base = {
    id,
    label: spec.label,
    enabled,
    installed: Boolean(runtime),
    connected: false,
    subscription: false,
    authState: "signed_out",
    method: "",
    detail: runtime ? "Checking connection…" : `${spec.label} is not installed.`,
    busy: activeLogins.has(id),
    busyDetail: activeLogins.get(id)?.busyDetail || "",
    requirement: id === "claude" ? "Claude subscription required" : "ChatGPT subscription required",
    signInAction: id === "claude" ? "Sign in to Claude Code" : "Sign in to Codex",
    integrations: { mcpServers: [], apps: [] },
  };
  if (!runtime) return base;
  const integrationsPromise = includeIntegrations
    ? providerIntegrations(id, { runtime, execFile, timeoutMs, codexApps, homedir })
    : Promise.resolve(base.integrations);
  try {
    const result = await execFile(runtime, spec.statusArgs, { timeout: timeoutMs, maxBuffer: 256 * 1024 });
    const parsed = id === "claude"
      ? parseClaudeStatus(result?.stdout)
      : parseCodexStatus(result?.stdout, result?.stderr, 0);
    if (parsed.connected && activeLogins.has(id)) finishAttempt(id, activeLogins.get(id), "");
    return { ...base, ...parsed, integrations: await integrationsPromise, detail: attemptDetail(id, parsed), busy: activeLogins.has(id) };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { ...base, installed: false, detail: `${spec.label} is not installed.`, busy: false };
    }
    const stdout = error?.stdout || "";
    const stderr = error?.stderr || "";
    const parsed = id === "claude"
      ? parseClaudeStatus(stdout)
      : parseCodexStatus(stdout, stderr, Number(error?.code) || 1);
    return {
      ...base,
      ...parsed,
      busy: activeLogins.has(id),
      integrations: await integrationsPromise,
      detail: attemptDetail(id, parsed) || safeMessage(stderr || error?.message),
    };
  }
}

export async function providerAuthStatuses(options = {}) {
  const [claude, codex] = await Promise.all([
    providerAuthStatus("claude", { ...options, includeIntegrations: false }),
    providerAuthStatus("codex", { ...options, includeIntegrations: false }),
  ]);
  return { ok: true, providers: { claude, codex } };
}

export async function providerInventoryStatuses(options = {}) {
  const claudeRuntime = resolveProviderCommand("claude", options);
  const codexRuntime = resolveProviderCommand("codex", options);
  const [claude, codex] = await Promise.all([
    providerIntegrations("claude", { ...options, runtime: claudeRuntime }),
    providerIntegrations("codex", { ...options, runtime: codexRuntime }),
  ]);
  return {
    ok: true,
    providers: {
      claude: { integrations: claude },
      codex: { integrations: codex },
    },
  };
}

export async function setProviderEnabled(provider, enabled, { prefsFile = configPath() } = {}) {
  const id = String(provider || "");
  if (!PROVIDERS[id]) throw new Error("Unknown provider connection.");
  writePrefs(id, Boolean(enabled), prefsFile);
  return { ok: true, provider: id, enabled: Boolean(enabled) };
}

export function providerSpawnEnvironment(env = process.env) {
  // A provider login needs the graphical/user session, not the pill's complete
  // deployment environment. Keep the same explicit allowlist used for normal
  // Linux terminal opens so unknown URLs, cloud credentials, cookies, and Relay
  // authority never cross into an external CLI by accident.
  return linuxTerminalEnvironment(env);
}

/**
 * Start the provider's official mobile-safe login flow without moving a
 * credential into Relay. The returned challenge contains only an allowlisted
 * provider URL/code. Claude's reply is encrypted to this attempt's ephemeral
 * X25519 key before it crosses Relay's API.
 */
export function beginRemoteProviderAuth(provider, {
  command = "",
  execFile = execFileDefault,
  spawn = spawnChild,
  prefsFile = configPath(),
  env = process.env,
  now = Date.now,
} = {}) {
  const id = String(provider || "");
  const spec = PROVIDERS[id];
  if (!spec) throw new Error("Unknown provider connection.");
  const existing = activeRemoteLogins.get(id);
  if (existing && !existing.terminal && existing.expiresAt > now()) return existing.publicAttempt;
  const runtime = resolveProviderCommand(id, { command, env });
  if (!runtime) throw new Error(`${spec.label} is not installed.`);

  const authId = `pa_${randomBytes(16).toString("base64url")}`;
  const ttlMs = id === "codex" ? 15 * 60 * 1_000 : 10 * 60 * 1_000;
  const expiresAt = now() + ttlMs;
  const replyKeys = id === "claude" ? generateKeyPairSync("x25519") : null;
  let resolveChallenge;
  let rejectChallenge;
  let resolveCompletion;
  let rejectCompletion;
  const challenge = new Promise((resolve, reject) => { resolveChallenge = resolve; rejectChallenge = reject; });
  const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  // Callers normally await both, but attach guards immediately so a spawn
  // failure cannot become a process-level unhandled rejection.
  challenge.catch(() => {});
  completion.catch(() => {});

  const args = id === "codex" ? ["login", "--device-auth"] : [...spec.loginArgs];
  let child;
  try {
    child = spawn(runtime, args, {
      windowsHide: true,
      env: providerSpawnEnvironment(env),
      stdio: [id === "claude" ? "pipe" : "ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(`Could not start ${spec.label} authorization: ${safeMessage(error?.message || error)}`);
  }
  const state = {
    id: authId,
    provider: id,
    child,
    terminal: false,
    challengeResolved: false,
    submitted: false,
    expiresAt,
    output: "",
    outputBytes: 0,
    timer: null,
    privateKey: replyKeys?.privateKey || null,
    publicAttempt: null,
  };
  const finish = (error = null) => {
    if (state.terminal) return;
    state.terminal = true;
    clearTimeout(state.timer);
    if (activeRemoteLogins.get(id) === state) activeRemoteLogins.delete(id);
    state.output = "";
    if (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (!state.challengeResolved) rejectChallenge(failure);
      rejectCompletion(failure);
    } else {
      if (!state.challengeResolved) {
        state.challengeResolved = true;
        resolveChallenge(null);
      }
      resolveCompletion({ ok: true, provider: id, authId });
    }
  };
  const maybeResolveChallenge = () => {
    if (state.challengeResolved) return;
    const authorizeUrl = remoteAuthorizeUrl(id, state.output);
    const userCode = id === "codex" ? codexDeviceCode(state.output) : "";
    if (!authorizeUrl || (id === "codex" && !userCode)) return;
    state.challengeResolved = true;
    const view = {
      kind: "provider_auth",
      authId,
      provider: id,
      providerLabel: id === "claude" ? "Anthropic" : "OpenAI",
      status: "waiting_for_user",
      authorizeUrl,
      ...(userCode ? { userCode } : {}),
      ...(replyKeys ? { replyPublicKey: String(replyKeys.publicKey.export({ format: "jwk" }).x || "") } : {}),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    state.output = "";
    resolveChallenge(view);
  };
  const collect = (chunk) => {
    if (state.terminal || state.challengeResolved) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    state.outputBytes += bytes.length;
    if (state.outputBytes > REMOTE_AUTH_OUTPUT_MAX_BYTES) {
      try { child.kill(); } catch {}
      finish(new Error(`${spec.label} sign-in returned too much output.`));
      return;
    }
    state.output += bytes.toString("utf8");
    maybeResolveChallenge();
  };
  child.stdout?.on?.("data", collect);
  child.stderr?.on?.("data", collect);
  child.stdin?.on?.("error", () => {});
  child.once?.("error", (error) => finish(new Error(`Could not start ${spec.label} authorization: ${safeMessage(error?.message || error)}`)));
  child.once?.("close", async (code) => {
    if (state.terminal) return;
    try {
      const status = await providerAuthStatus(id, { command: runtime, execFile, prefsFile });
      if (status.connected) {
        finish();
        return;
      }
      finish(new Error(code === 0
        ? `${spec.label} sign-in completed without the required subscription.`
        : `${spec.label} sign-in was cancelled or did not complete.`));
    } catch (error) {
      finish(new Error(code === 0
        ? `Could not verify ${spec.label} sign-in: ${safeMessage(error?.message || error)}`
        : `${spec.label} sign-in was cancelled or did not complete.`));
    }
  });
  state.timer = setTimeout(() => {
    try { child.kill?.("SIGTERM"); } catch {}
    finish(new Error(`${spec.label} sign-in expired before it completed.`));
  }, ttlMs);
  state.timer.unref?.();
  const publicAttempt = {
    id: authId,
    provider: id,
    challenge,
    completion,
    expiresAt,
    submit(envelope) {
      if (id !== "claude" || state.terminal || state.submitted || !state.challengeResolved || !state.privateKey) {
        throw new Error("Claude sign-in is not waiting for an authorization code.");
      }
      const code = decryptClaudeAuthorizationCode(authId, state.privateKey, envelope);
      state.submitted = true;
      child.stdin.end(`${code}\n`, "utf8");
    },
    cancel() {
      try { child.kill?.("SIGTERM"); } catch {}
      finish(new Error(`${spec.label} sign-in was cancelled.`));
    },
  };
  state.publicAttempt = publicAttempt;
  activeRemoteLogins.set(id, state);
  return publicAttempt;
}

export async function connectProvider(provider, {
  command = "",
  execFile = execFileDefault,
  spawn = spawnChild,
  prefsFile = configPath(),
  platform = process.platform,
  expectCommand = "/usr/bin/expect",
  expectRunner = EXPECT_RUNNER,
  openCommand = "/usr/bin/open",
  terminalApp = TERMINAL_APP,
  linuxTerminalInvocationImpl = linuxTerminalInvocation,
  loginTimeoutMs = LOGIN_TIMEOUT_MS,
  env = process.env,
} = {}) {
  const id = String(provider || "");
  const spec = PROVIDERS[id];
  if (!spec) throw new Error("Unknown provider connection.");
  const runtime = resolveProviderCommand(id, { command, env });
  if (!runtime) throw new Error(`${spec.label} is not installed.`);
  await setProviderEnabled(id, true, { prefsFile });
  const current = await providerAuthStatus(id, { command: runtime, prefsFile, execFile });
  if (current.connected) {
    return { ok: true, provider: id, started: false, busy: false, alreadyConnected: true };
  }
  if (activeLogins.has(id)) return { ok: true, provider: id, started: false, busy: true };
  lastAttempts.delete(id);
  let paths = null;
  let invocation = loginInvocation(runtime, spec.loginArgs, { platform, expectCommand, expectRunner });
  if (platform === "darwin" && commandExists(openCommand, { platform })) {
    paths = writeTerminalLoginScript(id, runtime, spec.loginArgs, terminalAttemptPaths(id, prefsFile), { platform });
    invocation = { command: openCommand, args: ["-a", terminalApp, paths.scriptPath] };
  } else if (platform === "linux") {
    paths = writeTerminalLoginScript(id, runtime, spec.loginArgs, terminalAttemptPaths(id, prefsFile), { platform });
    invocation = linuxTerminalInvocationImpl(paths.scriptPath, [], { env });
    if (!invocation) {
      removeAttemptFiles(paths);
      throw new Error(`Could not start ${spec.label} authorization: no supported graphical terminal was found.`);
    }
  }
  let child;
  try {
    child = spawn(invocation.command, invocation.args, {
      env: providerSpawnEnvironment(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    removeAttemptFiles(paths);
    throw new Error(`Could not start ${spec.label} authorization: ${safeMessage(error?.message || error)}`);
  }
  const state = {
    child,
    startedAt: Date.now(),
    timer: null,
    finished: false,
    scriptPath: paths?.scriptPath || "",
    markerPath: paths?.markerPath || "",
    busyDetail: paths ? `Finish ${spec.label} sign-in in Terminal.` : "Waiting for authorization…",
  };
  activeLogins.set(id, state);
  // Never retain or return CLI output: it can contain short-lived OAuth URLs
  // and codes. The authoritative success signal is a fresh provider status
  // check after the official CLI exits.
  child.stdout?.resume?.();
  child.stderr?.resume?.();
  child.stdin?.on?.("error", () => {});
  child.once?.("error", (error) => {
    finishAttempt(id, state, `Could not start authorization: ${safeMessage(error?.message || error)}`);
  });
  child.once?.("close", (code) => {
    // `open` exits after handing the user-owned flow to Terminal. The result
    // marker, not this launcher process, owns completion for that flow.
    if (paths && code === 0) return;
    finishAttempt(id, state, code === 0
      ? "Authorization finished, but the subscription connection was not saved. Try again."
      : "Authorization was cancelled or did not complete. Try again.");
  });
  state.timer = setTimeout(() => {
    try { child.kill?.("SIGTERM"); } catch {}
    finishAttempt(id, state, "Authorization timed out. Check the Terminal window, then try again.");
  }, Math.max(1_000, Number(loginTimeoutMs) || LOGIN_TIMEOUT_MS));
  state.timer.unref?.();
  return { ok: true, provider: id, started: true, busy: true, interaction: paths ? "terminal" : "inline" };
}

export async function assertProviderReady(provider, options = {}) {
  const status = await providerAuthStatus(provider, options);
  if (!status.enabled) {
    throw new Error(`${status.label} is disabled in Relay. Enable it in Settings before starting this request.`);
  }
  if (!status.installed) {
    throw new Error(`${status.label} is not installed. Install it, then open Relay Settings → Agent connections.`);
  }
  if (!status.connected) {
    const subscription = status.id === "claude" ? "Claude subscription" : "ChatGPT subscription";
    const action = status.id === "claude" ? "Sign in to Claude Code" : "Sign in to Codex";
    if (status.authState === "api_billing") {
      throw new Error(`${status.label} is signed in with API billing, but Tasks use your ${subscription}. Open Relay Settings → Agent connections and choose “${action}”.`);
    }
    throw new Error(`${status.label} needs your ${subscription} before this Task can start. Open Relay Settings → Agent connections and choose “${action}”.`);
  }
  return status;
}

export const _test = {
  parseClaudeStatus,
  parseCodexStatus,
  readPrefs,
  writePrefs,
  configPath,
  activeLogins,
  lastAttempts,
  loginInvocation,
  shellQuote,
  terminalAttemptPaths,
  writeTerminalLoginScript,
  settleTerminalAttempt,
  localIntegrationNames,
  parseClaudeMcpList,
  providerIntegrations,
  stripTerminalControl,
  remoteAuthorizeUrl,
  codexDeviceCode,
  decryptClaudeAuthorizationCode,
  activeRemoteLogins,
};
