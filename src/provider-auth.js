import { execFile as execFileCallback, spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withCodexAppServer } from "./codex-app-server.js";

const execFileDefault = promisify(execFileCallback);
const PROVIDERS = Object.freeze({
  claude: {
    id: "claude",
    label: "Claude Code",
    candidates: () => [
      process.env.CLAUDE_CLI_PATH,
      "/opt/homebrew/bin/claude",
      "/usr/local/bin/claude",
      path.join(os.homedir(), ".local", "bin", "claude"),
      "claude",
    ],
    statusArgs: ["auth", "status", "--json"],
    loginArgs: ["auth", "login", "--claudeai"],
  },
  codex: {
    id: "codex",
    label: "Codex",
    candidates: () => [
      process.env.CODEX_CLI_PATH,
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
const LOGIN_TIMEOUT_MS = 10 * 60 * 1_000;
const CLAUDE_MCP_BATCH_SIZE = "8";
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
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

function commandExists(candidate) {
  if (!candidate) return false;
  if (!candidate.includes(path.sep)) return true;
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

export function resolveProviderCommand(provider, { command = "" } = {}) {
  const spec = PROVIDERS[String(provider || "")];
  if (!spec) throw new Error("Unknown provider connection.");
  if (command) return command;
  return spec.candidates().filter(Boolean).find(commandExists) || "";
}

function safeMessage(value, max = 500) {
  return String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, max);
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

function writeTerminalLoginScript(id, runtime, loginArgs, paths) {
  const label = PROVIDERS[id].label;
  const keychainPrelude = id === "claude" ? `
login_keychain="$HOME/Library/Keychains/login.keychain-db"
if [[ -f "$login_keychain" ]] && ! /usr/bin/security show-keychain-info "$login_keychain" >/dev/null 2>&1; then
  echo "Claude Code needs your macOS login Keychain before it can save the subscription connection."
  echo "Enter your Mac login password at the Keychain prompt below. Relay cannot see it."
  if ! /usr/bin/security unlock-keychain "$login_keychain"; then
    echo ""
    echo "The login Keychain could not be unlocked. Fix it in Keychain Access, then reconnect from Relay."
    print -r -- "1" > ${shellQuote(paths.markerPath)}
    exit 1
  fi
fi
` : "";
  const script = `#!/bin/zsh
set -u
echo "Relay opened ${label}'s official subscription sign-in."
echo "Complete the provider and browser prompts in this window."
${keychainPrelude}
${[runtime, ...loginArgs].map(shellQuote).join(" ")}
result=$?
print -r -- "$result" > ${shellQuote(paths.markerPath)}
echo ""
if [[ "$result" -eq 0 ]]; then
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
  if (platform === "darwin" && commandExists(expectCommand) && commandExists(expectRunner)) {
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
  try { payload = JSON.parse(String(stdout || "").trim()); } catch {}
  const loggedIn = payload?.loggedIn === true;
  const apiProvider = String(payload?.apiProvider || "");
  const authMethod = String(payload?.authMethod || "");
  const subscription = loggedIn && apiProvider === "firstParty" && authMethod !== "api_key";
  return {
    connected: subscription,
    subscription,
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
    method: "",
    detail: runtime ? "Checking connection…" : `${spec.label} is not installed.`,
    busy: activeLogins.has(id),
    busyDetail: activeLogins.get(id)?.busyDetail || "",
    profile: "This Mac's existing local profile",
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
  loginTimeoutMs = LOGIN_TIMEOUT_MS,
} = {}) {
  const id = String(provider || "");
  const spec = PROVIDERS[id];
  if (!spec) throw new Error("Unknown provider connection.");
  const runtime = resolveProviderCommand(id, { command });
  if (!runtime) throw new Error(`${spec.label} is not installed.`);
  await setProviderEnabled(id, true, { prefsFile });
  const current = await providerAuthStatus(id, { command: runtime, prefsFile, execFile });
  if (current.connected) {
    return { ok: true, provider: id, started: false, busy: false, alreadyConnected: true };
  }
  if (activeLogins.has(id)) return { ok: true, provider: id, started: false, busy: true };
  lastAttempts.delete(id);
  let paths = null;
  const opensProviderApp = id === "codex" && platform === "darwin" && commandExists(openCommand);
  let invocation = loginInvocation(runtime, spec.loginArgs, { platform, expectCommand, expectRunner });
  if (opensProviderApp) {
    invocation = { command: openCommand, args: ["-a", "ChatGPT"] };
  } else if (platform === "darwin" && commandExists(openCommand)) {
    paths = writeTerminalLoginScript(id, runtime, spec.loginArgs, terminalAttemptPaths(id, prefsFile));
    invocation = { command: openCommand, args: ["-a", terminalApp, paths.scriptPath] };
  }
  let child;
  try {
    child = spawn(invocation.command, invocation.args, {
      env: { ...process.env },
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
    opensProviderApp,
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
    if ((paths || opensProviderApp) && code === 0) return;
    finishAttempt(id, state, code === 0
      ? "Authorization finished, but the subscription connection was not saved. Try again."
      : "Authorization was cancelled or did not complete. Try again.");
  });
  state.timer = setTimeout(() => {
    try { child.kill?.("SIGTERM"); } catch {}
    finishAttempt(id, state, "Authorization timed out. Check the Terminal window, then try again.");
  }, Math.max(1_000, Number(loginTimeoutMs) || LOGIN_TIMEOUT_MS));
  state.timer.unref?.();
  return { ok: true, provider: id, started: true, busy: true, interaction: paths ? "terminal" : opensProviderApp ? "provider_app" : "inline" };
}

export async function assertProviderReady(provider, options = {}) {
  const status = await providerAuthStatus(provider, options);
  if (!status.enabled) {
    throw new Error(`${status.label} is disabled in Relay. Enable it in Settings before starting this request.`);
  }
  if (!status.installed) {
    throw new Error(`${status.label} is not installed. Install it, then connect your subscription in Relay Settings.`);
  }
  if (!status.connected) {
    throw new Error(`${status.label} is not connected with a subscription. Connect it in Relay Settings before starting this request.`);
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
};
