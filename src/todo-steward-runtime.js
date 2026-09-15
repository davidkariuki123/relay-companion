import { acpAvailable, acpMcpServers } from "./acp-client.js";
import { runAcp, acpPermissionMode } from "./acp-session.js";
import { relayClaudePermissionMode } from "./claude-session-runtime.js";
import { relayMcpLaunchSpec } from "./runtime.js";
import { discoverSessions } from "./session-directory.js";
import { storeDir } from "./host-paths.js";
import { runTodoStewardOnce, stewardWorkDir } from "./todo-steward.js";
export function stewardProviders() { return { codex: acpAvailable("codex"), claude: acpAvailable("claude") }; }
export async function runStewardProvider({ route, prompt, heartbeat = () => {}, baseDir = storeDir() }) {
  const timer = setInterval(() => heartbeat(), 30_000);
  try {
    const finalMessage = await runAcp({ provider: route.provider, cwd: stewardWorkDir(baseDir), prompt,
      model: route.model, effort: route.effort, timeoutMs: 18 * 60 * 1000,
      mode: acpPermissionMode(route.provider, { permissionMode: relayClaudePermissionMode() }),
      mcpServers: acpMcpServers({ relay: relayMcpLaunchSpec() }),
      onUpdate: update => { if (update.sessionUpdate === "tool_call") heartbeat(update.title); } });
    return { finalMessage };
  } finally { clearInterval(timer); }
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

/** The daemon's per-tick entry point. Never throws; the daemon loop must stay up. */
export async function todoStewardTick({ client, features, user, log = () => {} } = {}) {
  if (features?.todo !== true) return { ran: false, reason: "todo_off" };
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
    });
  } catch (error) {
    log(`todo steward tick failed: ${error?.message || error}`);
    return { ran: false, reason: "error", error: String(error?.message || error) };
  }
}
