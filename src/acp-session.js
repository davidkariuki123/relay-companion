import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AcpClient, acpProvider } from "./acp-client.js";
import { AcpWorkEvents } from "./acp-work-events.js";
import { configDir } from "./config.js";
import updateActivity from "../bootstrap/update-activity.cjs";
import { requestAcpPermission } from "./acp-permissions.js";
import { claimAcpSession } from "./acp-session-owner.js";
import { adoptClaudeSessionIntoDesktop } from "./claude-session-writer.js";
import { claudeHome } from "./host-paths.js";

const workers = new Map();
const opening = new Set();
let permissionHandler = requestAcpPermission;
export function setAcpPermissionHandler(handler) { permissionHandler = handler; }
export function acpWorker(sessionId) { return workers.get(String(sessionId || "")) || null; }
export function acpHasActiveTurns() { return opening.size > 0 || [...workers.values()].some(worker => !worker.settled); }
export function acpPermissionMode(provider, { permissionMode, approvalPolicy, approvalsReviewer, fullAccess } = {}) {
  if (acpProvider(provider) === "claude") return permissionMode || "auto";
  if (fullAccess || approvalPolicy === "never" || permissionMode === "bypassPermissions") return "agent-full-access";
  if (permissionMode === "default" || (approvalPolicy === "on-request" && approvalsReviewer === "user")) return "read-only";
  return "agent";
}
export function subscribeAcpWorker(sessionId, listener) {
  const worker = acpWorker(sessionId);
  if (!worker) { const detached = () => {}; detached.detached = true; return detached; }
  worker.listeners.add(listener);
  return () => worker.listeners.delete(listener);
}

// One managed writer per native session. A completed prompt is closed before
// its promise resolves, so Desktop can safely take ownership of its transcript.
export async function startAcpRun({ provider, sessionId, cwd = process.cwd(), title = "", prompt, displayPrompt = prompt, model, effort, mode,
  materializeSession = adoptClaudeSessionIntoDesktop,
  mcpServers = [], logPath, onUpdate, onPermission, onSession, timeoutMs, clientFactory = options => new AcpClient(options), ...transport } = {}) {
  provider = acpProvider(provider);
  const key = sessionId ? `${provider}:${sessionId}` : randomUUID();
  if (opening.has(key) || (sessionId && !acpWorker(sessionId)?.closed && acpWorker(sessionId))) throw new Error("This native session already has a Relay ACP owner");
  const release = updateActivity.beginCall({ configDir: configDir(), kind: "work" });
  opening.add(key);
  const prior = sessionId && acpWorker(sessionId);
  let ownership;
  const worker = { provider, sessionId: null, cwd: path.resolve(cwd), turnId: randomUUID(), events: [...(prior?.events || [])], listeners: new Set(), settled: false, closed: false, userText: typeof prompt === "string" ? prompt : "", startedAt: new Date().toISOString(), text: "", error: null };
  const emit = event => {
    worker.events.push(event);
    if (worker.events.length > 4096) worker.events.shift();
    if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    for (const listener of worker.listeners) { try { listener(event); } catch {} }
  };
  const client = clientFactory({ provider, cwd: worker.cwd, ...transport,
    onSpawn: pid => ownership?.setAdapterPid(pid),
    onUpdate: params => {
      // session/load replays old turns. Native history is hydrated separately;
      // it must not be counted as this prompt's result or streamed a second time.
      if (!worker.projection || params.sessionId !== worker.sessionId) return;
      worker.projection.update(params.update);
      worker.text = worker.projection.text;
      worker.updatedAt = new Date().toISOString();
      onUpdate?.(params.update);
    },
    onPermission: async (params, context) => {
      const handler = onPermission || permissionHandler;
      if (!handler) {
        worker.error = new Error("This run needs permission. Open Relay on this computer to review the request, then continue the session.");
        return null;
      }
      ownership?.setState("needs_input");
      try { return await handler(params, { ...context, provider, cwd: worker.cwd }); }
      finally { ownership?.setState("active"); }
    },
  });
  worker.client = client;
  try {
    if (sessionId) ownership = claimAcpSession(provider, sessionId, worker.cwd);
    if (logPath) fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    const session = await client.session({ sessionId, mcpServers, model, effort, mode });
    worker.sessionId = session.sessionId;
    if (!ownership) ownership = claimAcpSession(provider, worker.sessionId, worker.cwd);
    ownership.setAdapterPid(client.child?.pid);
    workers.set(worker.sessionId, worker);
    await onSession?.(worker.sessionId);
    worker.projection = new AcpWorkEvents({ sessionId: worker.sessionId, turnId: worker.turnId, emit });
    worker.projection.start(displayPrompt);
    worker.done = (async () => {
      let result;
      try {
        result = await client.prompt(worker.sessionId, prompt, { timeoutMs });
        if (worker.error) throw worker.error;
        if (result.stopReason !== "end_turn" && result.stopReason !== "cancelled") throw new Error(`ACP run stopped: ${result.stopReason}`);
        if (provider === "claude" && title && result.stopReason === "end_turn") {
          await client.stop();
          worker.closed = true;
          worker.materialization = await materializeSession({
            sessionId: worker.sessionId, title, cwd: worker.cwd, model, effort,
            sessionPath: path.join(claudeHome(), "projects", worker.cwd.replace(/[^a-zA-Z0-9]/g, "-"), worker.sessionId + ".jsonl"),
            importIntoDesktop: false,
          });
          if (!worker.materialization?.materialized) throw new Error("The Claude turn finished, but Relay could not make its native session available in the app");
        }
        return { sessionId: worker.sessionId, text: worker.projection.finalText, stopReason: result.stopReason };
      } catch (error) { worker.error = error; throw error; }
      finally {
        worker.settled = true;
        try { worker.projection.finish(result, worker.error); }
        finally {
          try { await client.stop(); worker.closed = true; }
          finally { try { ownership?.release(); ownership = null; } finally { release(); } }
          for (const [id, priorWorker] of workers) {
            if (workers.size <= 100) break;
            if (priorWorker.closed && priorWorker !== worker) workers.delete(id);
          }
        }
      }
    })();
    // Background callers observe errors through worker.error / the Work log.
    // Awaiting done still rejects; this handler prevents an unhandled rejection.
    worker.done.catch(() => {});
    return worker;
  } catch (error) {
    try { await client.stop(); }
    finally {
      worker.settled = true; worker.closed = true; worker.error = error;
      try { ownership?.release(); ownership = null; } finally { release(); }
    }
    throw error;
  }
  finally { opening.delete(key); }
}

export async function runAcp(options) {
  const worker = await startAcpRun(options);
  const result = await worker.done;
  if (result.stopReason === "cancelled") throw new Error("ACP run was cancelled");
  return result.text;
}
