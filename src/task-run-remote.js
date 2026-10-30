import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readConfig } from "./config.js";

// A Task someone asked this computer to run from another of their devices
// (Relay Mobile's "Run on computer"). It takes the Execute path the pill
// takes (native-task-execute.js): the same app, the same folder choice, the
// same server reservation and the same prompt. The differences are only that
// nobody is at this computer to answer a question or press Send, so:
// - consent is never asked: device execution must already be on here;
// - the folder is used without asking only where Execute would not ask (the
//   Task names exactly one checkout here, with a known app). Otherwise the
//   computer answers with the same short list Execute offers, the person
//   picks one on the phone, and the pick comes back as a second run that is
//   honoured only if it was offered (by an opaque key, never a path);
// - nothing is ever left in Claude's message box for someone to send. Where
//   the app cannot start the Task by itself, it runs in the background
//   instead (task-run-headless.js): at once for Claude with Remote Control on
//   for all sessions, which holds a pushed Task until someone types there,
//   and otherwise when the app did not start it in time. A Task Claude
//   received but did not start is first taken back from the conversation
//   Relay made for it (its Claude process stopped, a notice left), so it
//   cannot also start there; one that cannot be taken back, or that may
//   have reached Codex, is never run twice.
// Execute on this computer never runs a Task in the background (Shane,
// 2026-10-26): only this phone path does.

export const TASK_RUN_OFF_MESSAGE = "Device execution is off on this computer. Turn it on in Relay there (run Execute on a Task once), then try again.";
// How much longer than Execute's own wait an app gets to start a Task the
// phone sent before it runs in the background instead.
export const REMOTE_APP_WAIT_MS = 60_000;
const REMOTE_POLL_MS = 5_000;
export const CLAUDE_UNTRUSTED_MESSAGE = "Claude Code has not trusted this folder on that computer yet. Open the folder in Claude Code there once and accept its trust prompt, then try again.";
// Execution-record phases after which the Task may be in an app conversation.
const SENT_PHASES = new Set(["submitting", "uncertain", "accepted"]);

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

/** An offered app-and-folder pair, named without revealing its path. */
export function workspaceKey(option) {
  return createHash("sha256").update(`${option.provider}\n${String(option.cwd || "").toLowerCase()}`).digest("hex").slice(0, 24);
}

/** Thrown from choose: the phone has to pick a folder from this list. */
export class FolderNeeded extends Error {
  constructor(options) {
    super("Choose a folder for this Task.");
    this.options = options;
  }
}

function appLabel(provider) {
  return provider === "codex" ? "Codex" : "Claude Code";
}

/** Thrown from choose: Claude here holds a pushed Task, so it runs in the background. */
class RunInBackground extends Error {}

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
    const [execute, launch, workspace, headless] = await Promise.all([
      import("./native-task-execute.js"),
      import("./native-task-launch.js"),
      import("./native-task-workspace.js"),
      import("./task-run-headless.js"),
    ]);
    return {
      executeNativeTask: execute.executeNativeTask,
      executionRecord: execute.executionRecord,
      stopWaitingForNativeApp: execute.stopWaitingForNativeApp,
      remoteExecutionPrompt: execute.remoteExecutionPrompt,
      markMovedToBackground: execute.markMovedToBackground,
      startHeadlessTaskRun: headless.startHeadlessTaskRun,
      launch,
      workspace,
    };
  },
  open = openDeepLink,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
} = {}) {
  const taskId = String(operation.input?.taskRelayId || "");
  if (operation.kind !== "start" || !taskId) return false;
  const loaded = await load();
  const { executeNativeTask, launch, workspace } = loaded;
  if (!launch.executionEnabled(config)) {
    await recordEvidence(client, operation.id, claimToken, "failed", {}, TASK_RUN_OFF_MESSAGE);
    return true;
  }
  const wantedApp = operation.input?.taskAppChosen === true ? operation.input?.provider : "";
  let chosen = null;
  let packet = null;
  const app = () => appLabel(chosen?.provider || wantedApp);
  const folder = () => (chosen?.cwd ? workspace.workspaceName(chosen.cwd) : "");
  const inFolder = () => (folder() ? ` in ${folder()}` : "");
  const finish = (message, extra = {}) => recordEvidence(client, operation.id, claimToken, "completed", {
    output: { message, app: chosen?.provider || wantedApp || "", folder: folder(), waiting: false, ...extra },
  });
  const sentToApp = () => SENT_PHASES.has(loaded.executionRecord?.(config, taskId)?.phase);
  const remoteControlOn = async () => {
    try { return (await launch.claudeLaunchPreflight?.())?.remoteControlDefault === true; } catch { return false; }
  };
  const background = async (why, { reserve = true } = {}) => {
    if (!launch.executionEnabled(config)) throw new Error(TASK_RUN_OFF_MESSAGE);
    // A background run never steps around Claude's own folder trust.
    if (chosen.provider === "claude" && launch.claudeWorkspaceTrusted && !launch.claudeWorkspaceTrusted(chosen.cwd)) throw new Error(CLAUDE_UNTRUSTED_MESSAGE);
    if (!packet) {
      const fetched = await client.fetchRelay(taskId);
      packet = fetched?.packet || fetched?.relay || fetched || {};
    }
    await loaded.startHeadlessTaskRun({
      client, taskId, operationId: operation.id, provider: chosen.provider, cwd: chosen.cwd, packet,
      prompt: loaded.remoteExecutionPrompt(packet, taskId, { cwd: chosen.cwd }),
      allowed: () => launch.executionEnabled(config), log, reserve,
    });
    if (!reserve) loaded.markMovedToBackground?.(config, taskId);
    await finish(`${why}, so it is running in the background${inFolder()}. ${app()} will have the conversation when it finishes.`, { background: true });
  };
  // The app path never leaves a draft or a Task-in-the-box link: nobody is
  // here to press Send. Where Execute would fall back to one, it fails
  // instead, before anything is reserved or sent.
  const args = {
    id: taskId,
    config,
    client,
    consent: async () => false,
    confirmDraftRetry: async () => false,
    open,
    nativeApi: { ...launch, prepareClaudeDraft: undefined, prepareClaudeTaskLink: undefined },
    choose: async (providers, preferences) => {
      const usable = providers.filter((option) => option.provider === "claude" || option.provider === "codex");
      const apps = wantedApp ? usable.filter((option) => option.provider === wantedApp) : usable;
      if (!apps.length) throw new Error(`${appLabel(wantedApp)} is not installed on this computer.`);
      const fetched = await client.fetchRelay(taskId);
      packet = fetched?.packet || fetched?.relay || fetched || null;
      const offered = workspace.workspaceChoices({
        providers: apps,
        preferences,
        packet,
        senderName: String(packet?.senderName || packet?.sender?.name || "").trim().split(/\s+/)[0] || "",
      });
      const pickedKey = String(operation.input?.taskWorkspaceKey || "");
      const pick = pickedKey
        ? offered.options.find((option) => workspaceKey(option) === pickedKey) || null
        : offered.auto;
      if (!pick) {
        // As Execute asks on this computer, ask on the phone: the offered
        // pairs only. A pick that is no longer offered is asked again.
        throw new FolderNeeded(offered.options.map((option) => ({
          key: workspaceKey(option),
          provider: option.provider,
          app: appLabel(option.provider),
          name: option.name,
          why: option.why || "",
        })));
      }
      chosen = { provider: pick.provider, cwd: pick.cwd };
      launch.setExecutionPreferences(config, workspace.rememberWorkspaceChoice(preferences, { packet, ...chosen }));
      // With Remote Control on for all sessions, Claude holds a pushed Task
      // until someone types there. Decided before anything is prepared.
      if (chosen.provider === "claude" && await remoteControlOn()) throw new RunInBackground();
      return chosen;
    },
  };
  // Claude received the Task (or may have) and has not started it. Take it
  // back from that conversation, which Relay made for this Task and reserved
  // it for, and run it in the background. "started" if the model answered
  // after all; "stuck" if it cannot be taken back safely.
  const takeBackFromClaude = async () => {
    const record = loaded.executionRecord?.(config, taskId);
    if (chosen?.provider !== "claude" || record?.session?.provider !== "claude" || typeof launch.retireUnstartedClaudeConversation !== "function") return "stuck";
    if (record.taskRunOwner?.nativeSessionId !== record.session.nativeId) return "stuck";
    const outcome = await launch.retireUnstartedClaudeConversation(record.session, { messageId: record.messageId });
    if (outcome?.started) return "started";
    if (!outcome?.retired) return "stuck";
    await background(`${app()} received it but did not start it`, { reserve: false });
    return "background";
  };
  // Codex is still opening the conversation: keep making the late launch
  // Execute's watch makes, then stop waiting. Null means nothing was sent.
  const waitForApp = async () => {
    const deadline = now() + REMOTE_APP_WAIT_MS;
    while (now() < deadline) {
      await sleep(REMOTE_POLL_MS);
      const record = loaded.executionRecord?.(config, taskId);
      if (SENT_PHASES.has(record?.phase)) return { ok: true };
      if (record && (record.phase !== "awaiting_app" || record.draftError)) break;
      try {
        const late = await executeNativeTask({ ...args, observeOnly: true });
        if (late?.ok && !late.waiting && !late.stopped) return late;
      } catch { /* the record says why; the loop decides */ }
    }
    loaded.stopWaitingForNativeApp?.(config, taskId);
    return sentToApp() ? { ok: true } : null;
  };
  try {
    let result;
    try {
      result = await executeNativeTask(args);
    } catch (error) {
      if (error instanceof RunInBackground) {
        await background(`${app()} there holds Tasks until someone types while Remote Control is on for all sessions`);
        return true;
      }
      // Run it in the background only when the app was chosen and nothing
      // reached it, or Claude's conversation gave it back. A Task started
      // elsewhere stays there.
      if (error instanceof FolderNeeded || !chosen || error?.status === 409) throw error;
      if (sentToApp()) {
        const taken = await takeBackFromClaude();
        if (taken === "background") return true;
        if (taken === "started") { await finish(`Started in ${app()}${inFolder()}.`); return true; }
        throw error;
      }
      log(`remote Task run ${taskId}: ${app()} did not start it (${error?.message || error}); running it in the background`);
      await background(`${app()} did not start it in time`);
      return true;
    }
    if (result?.waiting) {
      result = await waitForApp();
      if (!result) {
        await background(`${app()} did not start it in time`);
        return true;
      }
    }
    if (result?.awaitingSend && !sentToApp()) {
      await background(`${app()} did not start it by itself`);
      return true;
    }
    if (!result?.ok) throw new Error(result?.message || result?.error || "The Task did not start on this computer.");
    if (result.deliveredIdle) {
      // Claude holds the Task without starting it: give it a little longer,
      // then take it back and run it in the background.
      const record = loaded.executionRecord?.(config, taskId);
      let started = false;
      try { started = Boolean(record?.session && await launch.nativeTurnStarted?.(record.session, record.messageId, { timeoutMs: REMOTE_APP_WAIT_MS })); } catch { /* not started */ }
      if (!started) {
        const taken = await takeBackFromClaude();
        if (taken === "background") return true;
        if (taken === "stuck") {
          await finish(`Sent to ${app()}${inFolder()}, but it has not started, and Relay could not take it back. It starts when someone opens ${app()} there.`, { waiting: true });
          return true;
        }
      }
    }
    await finish(`Started in ${app()}${inFolder()}.`);
  } catch (error) {
    if (error instanceof FolderNeeded) {
      if (!error.options.length) {
        await recordEvidence(client, operation.id, claimToken, "failed", {}, "This computer has no folder to offer for this Task. Run it from Relay on that computer once to choose one.");
        return true;
      }
      // Nothing ran and nothing was reserved: the phone shows these and sends a pick.
      await recordEvidence(client, operation.id, claimToken, "completed", {
        output: { needsFolder: true, message: "Choose a folder for this Task.", options: error.options },
      });
      return true;
    }
    log(`remote Task run ${taskId} failed: ${error?.message || error}`);
    await recordEvidence(client, operation.id, claimToken, "failed", {}, error?.message || String(error));
  }
  return true;
}
