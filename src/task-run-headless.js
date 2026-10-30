import path from "node:path";
import { createHash } from "node:crypto";
import { configDir } from "./config.js";
import { acpMcpServers } from "./acp-client.js";
import { startAcpRun, acpPermissionMode } from "./acp-session.js";
import { relayMcpLaunchSpec } from "./runtime.js";
import { relayClaudePermissionMode } from "./claude-session-runtime.js";
import { notifyCodexDesktopThreads } from "./codex-desktop.js";
import relaySettings from "./relay-settings.cjs";

// A Task the person started from their phone, run in the background on this
// computer when the desktop app cannot start it with nobody here (Claude with
// Remote Control on for all sessions, or an app that did not start it in
// time). Only the phone's "Run on computer" reaches this; Execute on this
// computer always uses the app.

// The permission the person chose for Tasks in Your AIs, as ACP modes.
export const CODEX_ACP_PERMISSION = {
  full: { fullAccess: true },
  guardian: {},
  ask: { approvalPolicy: "on-request", approvalsReviewer: "user" },
};
export function taskClaudePermission(env = process.env) {
  const overridden = env.RELAY_CLAUDE_PERMISSION_MODE || env.RELAY_SESSION_PLACEMENT === "cloud" || env.RELAY_SESSION_FULL_ACCESS === "1";
  return overridden ? relayClaudePermissionMode(env) : relaySettings.taskPermission("claude");
}
export function taskRunAcpMode(provider) {
  if (provider === "claude") return acpPermissionMode("claude", { permissionMode: taskClaudePermission() });
  return acpPermissionMode("codex", CODEX_ACP_PERMISSION[relaySettings.taskPermission("codex")] || {});
}

/**
 * Start the Task in a background run in the chosen app and folder. The Task
 * is reserved for that run on the server, refusing if anything else started
 * it, before the prompt is sent; a refusal sends nothing. Without reserve,
 * the caller has taken the Task back from the conversation it was reserved
 * for on this computer. Resolves once the
 * prompt is on its way. A finished Claude run is handed to Claude's app by
 * the runner; a finished Codex run is announced to Codex's app.
 */
export async function startHeadlessTaskRun({ client, taskId, operationId, provider, cwd, packet, prompt, allowed, log = () => {},
  reserve = true, start = startAcpRun, notifyCodex = notifyCodexDesktopThreads }) {
  const title = String(packet?.title || "Relay Task").slice(0, 200);
  const worker = await start({
    provider, cwd, title, prompt,
    logPath: path.join(configDir(), "acp-operations", `${createHash("sha256").update(String(operationId)).digest("hex")}.jsonl`),
    mode: taskRunAcpMode(provider),
    mcpServers: acpMcpServers({ relay: relayMcpLaunchSpec() }),
    onSession: async (nativeId) => {
      if (!allowed()) throw new Error("Device execution was turned off on this computer. Nothing was sent.");
      // Taken back from this computer's own Claude conversation: the Task is
      // already reserved for it, and the server keeps one owner per Task.
      if (!reserve) return;
      let reserved;
      try {
        reserved = await client.taskExecute(taskId, { sourceProvider: provider, sourceNativeId: nativeId, idempotencyKey: `remote-background:${nativeId}`, requireUnstarted: true });
      } catch (error) {
        if (error?.status === 409) throw new Error("This Task was started somewhere else, so it was not run again.");
        throw error;
      }
      if (reserved?.taskRunOwner?.nativeSessionId !== nativeId || reserved?.taskRunOwner?.provider !== provider) {
        throw new Error("This Task already belongs to another conversation, so it was not run again.");
      }
    },
  });
  const nativeId = worker.sessionId;
  worker.done.then(async () => {
    if (provider !== "codex") return;
    await notifyCodex({ threadIds: [nativeId], workspaceRootsByThreadId: { [nativeId]: [cwd] }, primeOpen: false });
  }).catch((error) => log(`background Task run ${taskId} ended: ${error?.message || error}`));
  return { nativeId };
}
