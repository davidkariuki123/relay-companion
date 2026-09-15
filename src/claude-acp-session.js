import path from "node:path";
import os from "node:os";
import { adoptClaudeSessionIntoDesktop } from "./claude-session-writer.js";
import { acpMcpServers } from "./acp-client.js";
import { startAcpRun, acpWorker, subscribeAcpWorker } from "./acp-session.js";
import { relayMcpLaunchSpec } from "./runtime.js";
import { claudeHome } from "./host-paths.js";

async function launch({ sessionId, cwd = os.homedir(), title = "Relay Task", content, model = "claude-opus-5", effort = "high", permissionMode = "auto", adopt = adoptClaudeSessionIntoDesktop, startRun = startAcpRun, onPermission } = {}) {
  const worker = await startRun({ provider: "claude", sessionId, cwd, prompt: String(content || ""), model, effort,
    mode: permissionMode, mcpServers: acpMcpServers({ relay: relayMcpLaunchSpec() }), onPermission });
  worker.sessionPath = path.join(claudeHome(), "projects", path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-"), `${worker.sessionId}.jsonl`);
  worker.materializedPromise = worker.done.then(async () => {
    worker.materializing = true;
    try {
      worker.materialization = await adopt({ sessionId: worker.sessionId, cwd, title, model, effort, sessionPath: worker.sessionPath, importIntoDesktop: false });
      worker.materialized = true;
      return worker.materialization;
    } finally { worker.materializing = false; }
  });
  worker.materializedPromise.catch(() => {});
  worker.closedPromise = worker.done;
  return { mode: "acp", sessionId: worker.sessionId, desktopSessionId: `local_${worker.sessionId}`, sessionPath: worker.sessionPath, cwd: path.resolve(cwd), title, model, effort, permissionMode };
}
export const createClaudeAcpSession = launch;
export async function continueClaudeAcpSession(options) {
  if (!options.sessionId) throw new Error("Claude session id is required");
  const worker = acpWorker(options.sessionId);
  if (worker && !worker.settled) {
    throw new Error("This ACP turn is still working. Wait for it to finish or stop it before sending a follow-up.");
  }
  if (worker?.materializedPromise) await worker.materializedPromise;
  return launch(options);
}
export const claudeAcpWorker = acpWorker;
export const subscribeClaudeAcpWorker = subscribeAcpWorker;
export function claudeAcpWorkerSnapshot(sessionId) {
  const worker = acpWorker(sessionId);
  if (!worker || worker.closed) return null;
  return { sessionId, startedAt: worker.startedAt, userText: worker.userText, assistantText: worker.text, updatedAt: worker.updatedAt, settled: worker.settled };
}
export function claudeAcpWorkSnapshot(sessionId) {
  const worker = acpWorker(sessionId);
  if (!worker) return null;
  return { sessionId, transcriptPath: worker.sessionPath, ownerAlive: !worker.closed, expectedActive: !worker.settled, settled: worker.settled, events: structuredClone(worker.events) };
}
export async function waitForClaudeAcpMaterialization(sessionId) {
  const worker = acpWorker(sessionId);
  if (!worker) return null;
  if (!worker.closed) throw new Error("Claude Code is still working. Open becomes available after this run settles.");
  return worker.materializedPromise;
}
