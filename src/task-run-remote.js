import { spawn } from "node:child_process";
import { readConfig } from "./config.js";

// A Task someone asked this computer to run from another of their devices
// (Relay Mobile's "Run on computer"). It takes exactly the Execute path the
// pill takes (native-task-execute.js): the same app, the same folder choice,
// the same server reservation and the same prompt. The differences are only
// that nobody is at this computer to answer a question, so:
// - consent is never asked: device execution must already be on here;
// - the folder is the one Execute would suggest first (the Task's own project,
//   then this sender's or Topic's last folder, the last folder, recent work);
// - a Claude folder this computer has not trusted yet cannot start remotely.

export const TASK_RUN_OFF_MESSAGE = "Device execution is off on this computer. Turn it on in Relay there (run Execute on a Task once), then try again.";

/** Opens a deep link in its desktop app without a shell parsing the URL. */
export function openDeepLink(url, { platform = process.platform, spawnProcess = spawn } = {}) {
  const [command, args] = platform === "win32"
    ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
    : platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref?.(); resolve(); });
  });
}

function appLabel(provider) {
  return provider === "codex" ? "Codex" : "Claude Code";
}

/**
 * Run the Task named by a claimed session operation. Returns false for any
 * other operation. Records "completed" with what happened, or "failed" with
 * the reason, so the device that asked can say so.
 */
export async function runTaskOperation(client, operation, claimToken, {
  log = () => {},
  recordEvidence,
  config = readConfig(),
  load = async () => {
    const [execute, launch, workspace] = await Promise.all([
      import("./native-task-execute.js"),
      import("./native-task-launch.js"),
      import("./native-task-workspace.js"),
    ]);
    return { executeNativeTask: execute.executeNativeTask, launch, workspace };
  },
  open = openDeepLink,
} = {}) {
  const taskId = String(operation.input?.taskRelayId || "");
  if (operation.kind !== "start" || !taskId) return false;
  const { executeNativeTask, launch, workspace } = await load();
  if (!launch.executionEnabled(config)) {
    await recordEvidence(client, operation.id, claimToken, "failed", {}, TASK_RUN_OFF_MESSAGE);
    return true;
  }
  const wantedApp = operation.input?.taskAppChosen === true ? operation.input?.provider : "";
  let chosen = null;
  try {
    const result = await executeNativeTask({
      id: taskId,
      config,
      client,
      consent: async () => false,
      confirmDraftRetry: async () => false,
      open,
      choose: async (providers, preferences) => {
        const usable = providers.filter((option) => option.provider === "claude" || option.provider === "codex");
        const apps = wantedApp ? usable.filter((option) => option.provider === wantedApp) : usable;
        if (!apps.length) throw new Error(`${appLabel(wantedApp)} is not installed on this computer.`);
        const fetched = await client.fetchRelay(taskId);
        const packet = fetched?.packet || fetched?.relay || fetched || null;
        const offered = workspace.workspaceChoices({
          providers: apps,
          preferences,
          packet,
          senderName: String(packet?.senderName || packet?.sender?.name || "").trim().split(/\s+/)[0] || "",
        });
        const pick = offered.auto || offered.suggested;
        if (!pick) throw new Error("This computer has no folder for this Task yet. Run Execute on it there once to choose one.");
        chosen = { provider: pick.provider, cwd: pick.cwd };
        launch.setExecutionPreferences(config, workspace.rememberWorkspaceChoice(preferences, { packet, ...chosen }));
        return chosen;
      },
    });
    if (!result?.ok) throw new Error(result?.message || result?.error || "The Task did not start on this computer.");
    const app = appLabel(chosen?.provider || wantedApp);
    const folder = chosen?.cwd ? workspace.workspaceName(chosen.cwd) : "";
    const message = result.awaitingSend
      ? `Waiting in ${app}${folder ? ` in ${folder}` : ""}: press Send there to start it.`
      : `Started in ${app}${folder ? ` in ${folder}` : ""}.`;
    await recordEvidence(client, operation.id, claimToken, "completed", {
      output: { message, app: chosen?.provider || wantedApp || "", folder, waiting: Boolean(result.awaitingSend) },
    });
  } catch (error) {
    log(`remote Task run ${taskId} failed: ${error?.message || error}`);
    await recordEvidence(client, operation.id, claimToken, "failed", {}, error?.message || String(error));
  }
  return true;
}
