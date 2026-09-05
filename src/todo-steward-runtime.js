// The steward's provider lane: how one run actually reaches Codex or Claude
// Code on this machine. Kept apart from todo-steward.js so the decision
// logic stays importable without the CLI-facing modules behind it.

import fs from "node:fs";
import path from "node:path";
import { defaultCodexCommand } from "./codex-app-server.js";
import { runCodexOneShot } from "./codex-one-shot.js";
import { relayClaudePermissionMode } from "./claude-session-runtime.js";
import { claudeCommand, commandAvailable } from "./session-controller.js";
import { relayMcpLaunchSpec } from "./runtime.js";
import { discoverSessions } from "./session-directory.js";
import { buildRepoIndex } from "./repo-index.js";
import { execFile } from "node:child_process";
import { storeDir } from "./host-paths.js";
import {
  claudeStewardArgs,
  ensureStewardOutputSchema,
  runClaudeSteward,
  runTodoStewardOnce,
  stewardWorkDir,
} from "./todo-steward.js";

let cachedProviders = null;
let cachedProvidersAt = 0;

/** Which agents are installed; refreshed every minute so a new install is noticed without a restart. */
export function stewardProviders({ nowMs = Date.now() } = {}) {
  if (!cachedProviders || nowMs - cachedProvidersAt > 60_000) {
    cachedProviders = {
      codex: commandAvailable(defaultCodexCommand()),
      claude: commandAvailable(claudeCommand()),
    };
    cachedProvidersAt = nowMs;
  }
  return cachedProviders;
}

/** Codex config layers pinning the Relay MCP server, the same way Task runs do in runtime.js. */
export function codexStewardConfigOverrides(launch = relayMcpLaunchSpec()) {
  const overrides = {
    "mcp_servers.relay.command": JSON.stringify(launch.command),
    "mcp_servers.relay.args": JSON.stringify(launch.args),
    "mcp_servers.relay.startup_timeout_sec": "30",
    "mcp_servers.relay.tool_timeout_sec": "300",
  };
  for (const [key, value] of Object.entries(launch.env || {})) {
    overrides[`mcp_servers.relay.env.${key}`] = JSON.stringify(value);
  }
  return overrides;
}

/** A Claude MCP config naming only Relay, so the run has the tools it needs whatever the user's own config says. */
function stewardMcpConfigPath(baseDir) {
  const launch = relayMcpLaunchSpec();
  const filePath = path.join(stewardWorkDir(baseDir), "claude-mcp.json");
  fs.writeFileSync(filePath, JSON.stringify({ mcpServers: { relay: { command: launch.command, args: launch.args, env: launch.env } } }, null, 2), { mode: 0o600 });
  return filePath;
}

/** Run the brief on the chosen provider and return its final text. */
export async function runStewardProvider({ route, prompt, heartbeat = () => {}, baseDir = storeDir() }) {
  const cwd = stewardWorkDir(baseDir);
  if (route.provider === "codex") {
    return runCodexOneShot({
      command: defaultCodexCommand(),
      cwd,
      prompt,
      model: route.model,
      effort: route.effort,
      schemaPath: ensureStewardOutputSchema(baseDir),
      configOverrides: codexStewardConfigOverrides(),
      runTimeoutMs: 18 * 60 * 1000,
      stallTimeoutMs: 8 * 60 * 1000,
      // Structured-output drafts arrive as agent messages; a JSON blob is not a phase.
      onEvent: (_event, status) => { if (status && !/^\s*\{/.test(status)) heartbeat(status); },
    });
  }
  const permissionMode = relayClaudePermissionMode();
  return runClaudeSteward({
    command: claudeCommand(),
    cwd,
    prompt,
    args: claudeStewardArgs({
      model: route.model,
      effort: route.effort,
      permissionMode,
      mcpConfigPath: stewardMcpConfigPath(baseDir),
    }),
    onHeartbeat: () => heartbeat(),
  });
}

/**
 * Map a recorded (provider, native id) to what this machine knows about the
 * session: its title, cwd, transcript path and live state. Built once per
 * run so the brief can point the agent straight at the right transcripts.
 */
export function stewardSessionResolver(sessions = discoverSessions()) {
  const byKey = new Map();
  for (const session of sessions || []) {
    const nativeId = String(session.nativeId || session.nativeRef?.threadId || session.nativeRef?.sessionId || "");
    if (!nativeId) continue;
    byKey.set(`${session.provider}:${nativeId}`, {
      title: session.title || "",
      cwd: session.cwd || "",
      transcriptPath: session.nativeRef?.transcriptPath || session.nativeRef?.sessionPath || "",
      state: session.state || "",
    });
  }
  return (touch) => byKey.get(`${touch.provider}:${touch.nativeSessionId}`) || null;
}

function gitLine(dir, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile("git", ["-C", dir, ...args], { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? "" : String(stdout || "").trim());
    });
  });
}

async function fetchJson(url, timeoutMs = 8000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/**
 * What is actually deployed, measured by the daemon so the agent never has
 * to guess (or read a stale checkout) to tell built from merged from
 * shipped. Every line is best-effort: a fact that cannot be measured is
 * simply absent from the brief.
 */
export async function stewardShippingFacts({
  productionApiUrl = "https://api.sendrelays.com",
  repoIndex = null,
} = {}) {
  const lines = [];
  try {
    const packument = await fetchJson("https://registry.npmjs.org/relay-companion");
    const tags = packument?.["dist-tags"] || {};
    lines.push(`- Relay Companion npm dist-tags: dev=${tags.dev || "?"}, staging=${tags.staging || "?"}, latest=${tags.latest || "?"}, build=${tags.build || "?"}. A person on the dev channel has dev; a stable/production person has what the stable manifest says, NOT latest.`);
  } catch {}
  try {
    const manifest = await fetchJson(`${productionApiUrl}/v1/companion-releases/stable/manifest.json`);
    const payload = manifest?.payload ? JSON.parse(Buffer.from(String(manifest.payload), "base64").toString("utf8")) : manifest;
    if (payload?.version) lines.push(`- Production (stable) Companion right now: ${payload.version}${payload.sourceSha ? ` (public source ${String(payload.sourceSha).slice(0, 8)})` : ""}. Anything newer than this has NOT reached stable users.`);
  } catch {}
  const checkouts = Array.isArray(repoIndex) ? repoIndex : (() => { try { return buildRepoIndex(); } catch { return []; } })();
  const byOrigin = new Map();
  for (const checkout of checkouts) {
    if (!checkout?.originKey || !checkout.dir) continue;
    const current = byOrigin.get(checkout.originKey);
    if (!current || (checkout.isPrimary && !current.isPrimary) || (!current.isPrimary && Number(checkout.uses || 0) > Number(current.uses || 0))) {
      byOrigin.set(checkout.originKey, checkout);
    }
  }
  for (const [originKey, checkout] of byOrigin) {
    const head = await gitLine(checkout.dir, ["ls-remote", "origin", "refs/heads/main"]);
    const remoteMain = head.split(/\s+/)[0] || "";
    const localHead = await gitLine(checkout.dir, ["rev-parse", "HEAD"]);
    const behind = remoteMain ? await gitLine(checkout.dir, ["rev-list", "--count", `HEAD..${remoteMain}`]) : "";
    lines.push(`- Repo ${originKey}: checkout ${checkout.dir} (branch ${checkout.branch || "?"}${behind ? `, ${behind} commits behind origin/main` : ""}); origin/main is ${remoteMain ? remoteMain.slice(0, 12) : "unknown"} right now${localHead ? `, local HEAD ${localHead.slice(0, 12)}` : ""}. Judge merged against origin/main (git fetch first), never against this checkout's HEAD.`);
  }
  return lines;
}

/** The daemon's per-tick entry point. Never throws; the daemon loop must stay up. */
export async function todoStewardTick({ client, features, user, log = () => {} } = {}) {
  try {
    return await runTodoStewardOnce({
      client,
      features,
      user,
      log,
      providers: stewardProviders(),
      runProvider: runStewardProvider,
      resolveSession: () => {
        try { return stewardSessionResolver(); } catch { return () => null; }
      },
      shippingFacts: () => stewardShippingFacts(),
    });
  } catch (error) {
    log(`todo steward tick failed: ${error?.message || error}`);
    return { ran: false, reason: "error", error: String(error?.message || error) };
  }
}
