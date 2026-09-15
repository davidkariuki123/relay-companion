import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { configDir } from "./config.js";
import { acpAvailable, acpMcpServers } from "./acp-client.js";
import { startAcpRun, acpWorker, acpPermissionMode, subscribeAcpWorker } from "./acp-session.js";
import { relayClaudePermissionMode } from "./claude-session-runtime.js";
import { acpSessionOwner } from "./acp-session-owner.js";

export function createAcpHostAdapters({ available = acpAvailable, startRun = startAcpRun, openExternal, renderAgentBriefing, relayMcpLaunchSpec, openUiTarget } = {}) {
  function detectHosts() {
    return Object.fromEntries(["codex", "claude_code"].map(kind => {
      const installed = available(kind);
      return [kind, { kind, installed, authenticated: null, supportsCreate: installed, supportsResume: installed,
        supportsSteer: false, supportsStreaming: installed, supportsMcpServers: installed, supportsOpenUi: true,
        adapter: "acp", degradedReason: installed ? null : "acp_adapter_unavailable" }];
    }));
  }
  function selectHost(preferred) {
    const hosts = detectHosts();
    return hosts[preferred] || (hosts.codex.installed ? hosts.codex : hosts.claude_code);
  }
  function preflightAuth(host) {
    return { ok: Boolean(host?.installed), host: host?.kind, authenticated: null, reason: host?.installed ? null : "acp_adapter_unavailable" };
  }
  function relayToolPlan(hostKind) {
    return { host: hostKind, mcpServers: acpMcpServers({ relay: relayMcpLaunchSpec() }) };
  }
  async function launchTurn({ host, session, messages = [], previousRef, promptOverride, codexOptions = {}, cwdOverride, localImages = [], onPermission }) {
    if (previousRef && previousRef.mode !== "acp") throw new Error("This Task uses a retired runner. Start a new ACP Task.");
    const cwd = cwdOverride || previousRef?.cwd || process.env.RELAY_AGENT_CWD || process.cwd();
    const runId = randomUUID();
    const prompt = promptOverride ?? renderAgentBriefing({ session, messages });
    const runtimeDir = path.join(configDir(), "task-runtime");
    const promptPath = path.join(runtimeDir, `${session.id}-${runId}.md`);
    const logPath = previousRef?.logPath || path.join(runtimeDir, `${session.id}-${runId}.acp.jsonl`);
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(promptPath, prompt, { mode: 0o600 });
    const blocks = [{ type: "text", text: prompt }];
    for (const image of localImages) {
      const file = typeof image === "string" ? image : image.path;
      const mimeType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" })[path.extname(file).toLowerCase()];
      if (!mimeType) throw new Error("Unsupported ACP image type");
      blocks.push({ type: "image", mimeType, data: fs.readFileSync(file).toString("base64") });
    }
    const worker = await startRun({ provider: host.kind, sessionId: previousRef?.hostSessionId, cwd, title: session.title || "Relay Task", prompt: blocks,
      displayPrompt: [{ type: "text", text: prompt }, ...localImages.map(image => ({ type: "localImage", path: typeof image === "string" ? image : image.path }))],
      model: codexOptions.model, effort: codexOptions.effort || codexOptions.reasoningEffort,
      mode: acpPermissionMode(host.kind, host.kind === "claude_code" ? { permissionMode: relayClaudePermissionMode() } : codexOptions),
      mcpServers: relayToolPlan(host.kind).mcpServers, logPath, onPermission });
    return { mode: "acp", host: host.kind, cwd, runId, relaySessionId: session.id, taskId: session.taskId,
      threadId: worker.sessionId, hostSessionId: worker.sessionId, turnId: worker.turnId,
      promptPath, logPath, supportsSteer: false, startedAt: new Date().toISOString() };
  }
  async function steerTurn(input) {
    const worker = acpWorker(input.previousRef?.hostSessionId);
    if (worker && !worker.settled) {
      throw new Error("This ACP turn is still working. Wait for it to finish or stop it before sending a follow-up.");
    }
    return launchTurn(input);
  }
  async function interruptTurn({ sessionRef }) {
    const worker = acpWorker(sessionRef?.hostSessionId);
    if (!worker || worker.settled) return { ok: false, supported: true, reason: "acp_turn_not_running" };
    worker.client.cancel(worker.sessionId);
    await worker.done;
    return { ok: true, supported: true, host: sessionRef.host, method: "session/cancel", threadId: worker.sessionId, turnId: worker.turnId };
  }
  function streamEvents({ sessionRef }) {
    const worker = acpWorker(sessionRef?.hostSessionId);
    let events = worker?.events || [];
    if (!worker && sessionRef?.logPath) {
      try { events = fs.readFileSync(sessionRef.logPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch {}
    }
    return { ok: Boolean(worker), supported: true, host: sessionRef?.host, events, activeTurnId: worker && !worker.settled ? worker.turnId : null, lastCompletedTurnId: worker?.settled ? worker.turnId : null };
  }
  function subscribeEvents({ sessionRef }, listener) { return subscribeAcpWorker(sessionRef?.hostSessionId, listener); }
  function openUi({ sessionRef }) {
    const provider = sessionRef?.host === "claude_code" ? "claude" : sessionRef?.host;
    if (acpSessionOwner(provider, sessionRef?.hostSessionId)) return { ok: false, supported: true, reason: "acp_turn_still_running" };
    const target = openUiTarget(sessionRef);
    return { ...openExternal(target), supported: Boolean(target), host: sessionRef?.host, mode: sessionRef?.mode };
  }
  return { detectHosts, selectHost, preflightAuth, relayToolPlan, launchTurn, steerTurn, interruptTurn, streamEvents, subscribeEvents, openUi };
}
