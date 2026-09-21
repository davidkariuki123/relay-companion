// Dev experiment: create a conversation, then hand the first turn to the native
// desktop owner. These version-sensitive transports never fall back to ACP or
// replay a prompt after submission. No inspector, UI automation or permission edits.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { claudeDesktopPresent } from "./desktop-hosts.js";
import { claudeHome, codexHome } from "./host-paths.js";
import { configDir } from "./config.js";
import atomicJson from "./atomic-json.cjs";

const { atomicWriteJsonSync } = atomicJson;
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };
const names = (p) => { try { return fs.readdirSync(p); } catch { return []; } };
const alive = (pid) => { try { if (!(Number(pid) > 0)) return false; process.kill(Number(pid), 0); return true; } catch { return false; } };

export function executionAccountKey(config) {
  if (!config?.user?.id || !config?.apiUrl) throw new Error("Reconnect your Relay account before enabling execution.");
  return createHash("sha256").update(`${config.apiUrl}\n${config.user.id}`).digest("hex");
}
export function executionPreferences(config) {
  const file = path.join(configDir(), "native-execution", `${executionAccountKey(config)}.json`);
  return { file, ...(readJson(file) || {}) };
}
export function setExecutionPreferences(config, patch) {
  const { file, ...current } = executionPreferences(config);
  atomicWriteJsonSync(file, { ...current, ...patch }, { mode: 0o600 });
}
export function executionEnabled(config) {
  try { return executionPreferences(config).enabled === true; } catch { return false; }
}

export function nativeProviders({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (!["win32", "darwin"].includes(platform)) return [];
  const root = path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "OpenAI", "Codex", "bin");
  const candidates = platform === "win32"
    ? names(root).map((n) => path.join(root, n, "codex.exe"))
      .filter((p) => fs.existsSync(p)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    : ["/Applications/Codex.app/Contents/Resources/codex", "/Applications/ChatGPT.app/Contents/Resources/codex",
      path.join(home, "Applications/Codex.app/Contents/Resources/codex"), path.join(home, "Applications/ChatGPT.app/Contents/Resources/codex")];
  const binary = candidates.find((p) => fs.existsSync(p));
  return [
    ...(binary ? [{ provider: "codex", label: "Codex", binary }] : []),
    ...(claudeDesktopPresent({ platform, env }) ? [{ provider: "claude", label: "Claude Code" }] : []),
  ];
}

export function claudeWorkspaceTrusted(cwd, configFile = path.join(os.homedir(), ".claude.json")) {
  const projects = readJson(configFile)?.projects || {};
  // Exact workspace only: an import must never manufacture the app's trust.
  return Object.entries(projects).some(([folder, value]) =>
    path.resolve(folder) === path.resolve(cwd) && value?.hasTrustDialogAccepted === true);
}

function appServer(binary) {
  const env = { ...process.env };
  // A Companion launched by an agent must not masquerade as its parent session.
  for (const key of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID"]) delete env[key];
  const child = spawn(binary, ["app-server"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env });
  const pending = new Map();
  let buffer = "", serial = 0;
  const fail = () => { for (const item of pending.values()) item.reject(new Error("Codex preparation closed.")); pending.clear(); };
  child.on("error", fail); child.on("exit", fail); child.stdin.on("error", fail);
  child.stderr.on("data", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
      let row; try { row = JSON.parse(line); } catch { continue; }
      const item = pending.get(row.id);
      if (item) { pending.delete(row.id); row.error ? item.reject(new Error("Codex could not prepare the conversation.")) : item.resolve(row.result); }
    }
  });
  return {
    notify(method) { child.stdin.write(JSON.stringify({ method, params: {} }) + "\n"); },
    request(method, params) {
      const id = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Codex preparation timed out.")); }, 20000);
        pending.set(id, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    },
    close() { child.stdin.end(); const timer = setTimeout(() => child.kill(), 2000); timer.unref(); },
  };
}

export function selectCodexModel(models, configured) {
  const available = models.filter((entry) => typeof entry.model === "string" && entry.model.trim());
  const preferred = typeof configured === "string" ? configured.trim() : "";
  const selected = available.find((entry) => preferred && entry.model === preferred)
    || available.find((entry) => entry.isDefault === true && !entry.hidden);
  if (!selected) throw new Error("Codex did not report an available default model. Choose a model in Codex before trying Execute again.");
  return selected.model;
}

export async function prepareNativeSession({ provider, binary, cwd, title, persist }) {
  if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("Choose an existing workspace folder.");
  if (provider === "claude") {
    if (!claudeWorkspaceTrusted(cwd)) throw new Error("Open this folder in Claude Code and accept its workspace trust prompt once, then try Execute again. Relay will not change Claude’s trust settings.");
    const nativeId = randomUUID();
    const transcript = path.join(claudeHome(), "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${nativeId}.jsonl`);
    const session = { provider, nativeId, cwd, transcript, url: `claude://resume?session=${nativeId}` };
    // Save identity before creating any provider files.
    persist(session);
    const rows = [
      { type: "custom-title", customTitle: title, sessionId: nativeId },
      { type: "assistant", parentUuid: null, isSidechain: false, uuid: randomUUID(), timestamp: new Date().toISOString(), sessionId: nativeId, cwd,
        userType: "external", entrypoint: "relay-execute", message: { id: `relay-seed-${randomUUID()}`, type: "message", role: "assistant",
          content: [{ type: "text", text: "[Relay created this empty conversation. This notice is from Relay, not a model response. No task has run yet.]" }], stop_reason: "end_turn", usage: {} } },
    ];
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
    return session;
  }
  if (provider !== "codex" || !binary) throw new Error("This native provider is unavailable.");
  const server = appServer(binary);
  try {
    await server.request("initialize", { clientInfo: { name: "relay_execute", version: "1.0.0" } });
    server.notify("initialized");
    // Resolve a real model explicitly: the native follower transport does not
    // reliably inherit the bootstrap server's model. Never submit an empty id.
    const configured = await server.request("config/read", { cwd });
    const models = [];
    let cursor;
    do {
      const page = await server.request("model/list", cursor ? { cursor } : {});
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    const model = selectCodexModel(models, configured.config?.model);
    // Permissions remain the provider's configured defaults; no inference here.
    const result = await server.request("thread/start", { cwd, ephemeral: false, model });
    const nativeId = result.thread.id;
    const session = { provider, nativeId, cwd, model, transcript: result.thread.path || "", url: `codex://threads/${nativeId}` };
    persist(session);
    await server.request("thread/name/set", { threadId: nativeId, name: title });
    // Reading turns forces the empty thread's lazy rollout to materialize.
    // Metadata-only reads return a path even while that file does not exist.
    const read = await server.request("thread/read", { threadId: nativeId, includeTurns: true });
    session.transcript = read.thread?.path || session.transcript;
    if (!session.transcript || !fs.existsSync(session.transcript)) throw new Error("Codex did not persist the conversation. No app link was opened and no prompt was sent.");
    persist(session);
    return session;
  } finally { server.close(); }
}

function codexConnection(socketPath) {
  const socket = net.createConnection(socketPath);
  const pending = new Map();
  let buffer = Buffer.alloc(0), clientId = "initializing-client";
  const send = (row) => {
    const bytes = Buffer.from(JSON.stringify(row)), head = Buffer.alloc(4);
    head.writeUInt32LE(bytes.length); socket.write(Buffer.concat([head, bytes]));
  };
  const fail = () => { for (const item of pending.values()) item.reject(new Error("Codex native connection closed.")); pending.clear(); };
  socket.on("error", fail); socket.on("close", fail);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const n = buffer.readUInt32LE(0);
      if (n > 16 * 1024 * 1024) { socket.destroy(); return; }
      if (buffer.length < n + 4) break;
      let row; try { row = JSON.parse(buffer.subarray(4, n + 4)); } catch { socket.destroy(); return; }
      buffer = buffer.subarray(n + 4);
      if (row.type === "response" && pending.has(row.requestId)) {
        const item = pending.get(row.requestId); pending.delete(row.requestId); item.resolve(row);
      } else if (row.type === "client-discovery-request") send({ type: "client-discovery-response", requestId: row.requestId, response: { canHandle: false } });
    }
  });
  const request = (method, params, version) => new Promise((resolve, reject) => {
    if (socket.destroyed) { reject(new Error("Codex is not ready.")); return; }
    const requestId = randomUUID();
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Codex did not acknowledge the request.")); }, 10000);
    pending.set(requestId, { resolve: (r) => { clearTimeout(timer); resolve(r); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    send({ type: "request", requestId, sourceClientId: clientId, version, method, params });
  });
  return { request, close: () => socket.destroy(), initialize: async () => {
    const result = await request("initialize", { clientType: "relay-execute" }, 0);
    if (!result.result?.clientId) throw new Error("This Codex version does not support native Execute.");
    clientId = result.result.clientId;
  } };
}

export async function nativeSessionReady(session, { timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (session.provider === "claude") {
      const registry = path.join(claudeHome(), "sessions");
      const matches = names(registry).filter((n) => n.endsWith(".json")).map((n) => readJson(path.join(registry, n)))
        .filter((r) => r?.sessionId === session.nativeId && r.entrypoint === "claude-desktop" && r.kind === "interactive" && r.peerProtocol === 1 && r.messagingSocketPath && alive(r.pid));
      if (matches.length === 1) {
        const registration = matches[0];
        const keys = names(registry).filter((n) => n.startsWith(`${registration.pid}.`) && n.endsWith(".key"));
        if (keys.length === 1) {
          const token = readJson(path.join(registry, keys[0]))?.peerToken;
          if (/^[0-9a-f]{32}$/.test(token || "")) return { registration, token };
        }
      }
    } else {
      const socketPath = process.platform === "win32" ? "\\\\.\\pipe\\codex-ipc" : path.join(codexHome(), "ipc", "ipc.sock");
      const connection = codexConnection(socketPath);
      try {
        await connection.initialize();
        const owner = await connection.request("thread-owner-discovery", { hostId: "local", conversationId: session.nativeId }, 1);
        if (owner.resultType === "success" && owner.handledByClientId && owner.result?.supportsUntrustedAppInput === true) return { connection };
      } catch { /* Cold app or an unowned thread: no prompt has been sent. */ }
      connection.close();
    }
    await sleep(500);
  } while (Date.now() < deadline);
  throw new Error("The native app is not ready. Open it, finish any sign-in or trust prompts, then retry. No task prompt was sent.");
}

export async function submitNativeTurn(session, ready, prompt, messageId) {
  if (session.provider === "codex") {
    try {
      if (typeof session.model !== "string" || !session.model.trim()) throw new Error("This conversation has no selected Codex model. Continue in Codex; Relay has not sent the prompt.");
      const result = await ready.connection.request("thread-follower-start-turn", {
        conversationId: session.nativeId,
        turnStart: { request: { threadId: session.nativeId, model: session.model,
          // An empty imported conversation can carry a blank model inside its
          // native work mode; that nested value overrides the top-level model.
          collaborationMode: { mode: "default", settings: { model: session.model, reasoning_effort: null, developer_instructions: null } },
          clientUserMessageId: messageId, input: [{ type: "text", text: prompt, text_elements: [] }] },
          context: { attachments: [], commentAttachments: [], useAppServerPermissionDefault: true } },
      }, 2);
      if (result.resultType !== "success" || !result.result?.result?.turn?.id) throw new Error("Codex did not confirm the launch. Check the native conversation before doing anything else.");
      return;
    } finally { ready.connection.close(); }
  }
  await new Promise((resolve, reject) => {
    const socket = net.createConnection(ready.registration.messagingSocketPath);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Claude did not acknowledge the launch. Check the native conversation.")); }, 10000);
    socket.on("error", reject);
    socket.on("connect", () => socket.end(JSON.stringify({ type: "auth", token: ready.token }) + "\n" +
      JSON.stringify({ type: "user", uuid: messageId, from: "Relay Execute", message: { role: "user", content: prompt } }) + "\n"));
    socket.on("data", () => {});
    socket.on("close", () => { clearTimeout(timer); resolve(); });
  });
  // Socket closure alone is not delivery evidence. Observe the exact UUID.
  const deadline = Date.now() + 15000;
  do {
    if (nativeTranscriptRows(session).some((row) => row.type === "user" && row.uuid === messageId)) return;
    await sleep(300);
  } while (Date.now() < deadline);
  throw new Error("Claude has not confirmed receipt. Open the existing conversation to check; Relay will not send the task twice.");
}

export function nativeTranscriptRows(session) {
  if (!session.transcript) return [];
  try {
    // Bounded tail: progress must not read an entire long-running conversation.
    const fd = fs.openSync(session.transcript, "r");
    try {
      const size = fs.fstatSync(fd).size, start = Math.max(0, size - 2 * 1024 * 1024);
      const bytes = Buffer.alloc(size - start); fs.readSync(fd, bytes, 0, bytes.length, start);
      const lines = bytes.toString("utf8").split("\n"); if (start) lines.shift();
      return lines.flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}

export function nativeProgress(session) {
  const rows = nativeTranscriptRows(session);
  const last = rows.filter((r) => session.provider === "claude" ? ["user", "assistant"].includes(r.type) && r.entrypoint !== "relay-execute" : r.type === "event_msg").at(-1);
  if (!last) return "Waiting for the native app";
  if (session.provider === "claude") {
    if (last.type === "assistant" && last.message?.stop_reason === "end_turn") return "Claude finished a turn · continue in Claude Code";
    return "Working in Claude Code · approvals and follow-ups happen there";
  }
  if (last.payload?.type === "task_complete" && last.payload.error) return "Codex could not finish the turn · check the error in Codex";
  if (last.payload?.type === "task_complete") return "Codex finished a turn · continue in Codex";
  if (last.payload?.type === "turn_aborted") return "Turn stopped in Codex";
  return "Working in Codex · approvals and follow-ups happen there";
}
