// Claude Desktop / Claude Code native session writer + title-repair loop.
// Ported faithfully from granular/tools/relay-companion/src/claude-session-writer.js.
//
// HOST MECHANICS ARE UNCHANGED: it forges a ~/.claude/projects/<key>/<id>.jsonl
// transcript (custom-title / ai-title / agent-name rows + one visible assistant
// turn), writes the Claude Desktop local_<id>.json session metadata, fires
// `claude://resume?session=...`, and then runs the post-import title-repair loop
// that fixes the "General coding session" rail-title bug by re-writing the saved
// metadata title (titleSource:"user") with retries and repairing duplicates.
//
// Adaptations (input side only):
//   - paths -> ./host-paths.js
//   - title/briefing come from the cloud row via ./relay-briefing.js instead of a
//     granular packet's displayTitle/renderRelayBriefing.

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { relayRowTitle, renderRelayRowSeed } from "./relay-briefing.js";
import { claudeDesktopSessionsDir, claudeProjectsDir } from "./host-paths.js";
import { relayClaudePermissionMode } from "./claude-session-runtime.js";

const DEFAULT_CLAUDE_METADATA_MODEL = "claude-opus-5";
const INVALID_RELAY_CLAUDE_MODEL = "relay-companion";
const CLAUDE_DESKTOP_LIVE_TITLE_LIMITATION = {
  attempted: true,
  supported: "best-effort",
  reason: "claude-desktop-resume-import-uses-in-memory-session-cache",
  detail:
    "Relay writes Claude Code title rows and Claude Desktop metadata before import, then repairs saved metadata after import. Already-open Claude Desktop builds can still cache the imported row before the saved title is observed.",
};

export function writeClaudeNativeSession({ row, cwd = process.cwd(), seed = renderRelayRowSeed(row), model = "", effort = "" }) {
  const sessionId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const title = relayRowTitle(row);
  // The human reads only `visible`. The agent-only `operatorNote` (real ids + the
  // tool call to make) goes on a hidden system-meta row that Claude Desktop's
  // transcript view does not render as a chat bubble (the same way the title rows
  // above are non-rendered), so the human never sees ids or tool-call syntax.
  const visible = String(seed?.visible || "").trim();
  const operatorNote = String(seed?.operatorNote || "").trim();
  const sessionDir = path.join(claudeProjectsDir(), claudeProjectKey(cwd));
  const sessionPath = path.join(sessionDir, `${sessionId}.jsonl`);
  const assistantUuid = crypto.randomUUID();
  const operatorUuid = crypto.randomUUID();
  const rows = [
    { type: "custom-title", customTitle: title, sessionId },
    { type: "ai-title", aiTitle: title, sessionId },
    { type: "agent-name", agentName: title, sessionId },
    { type: "mode", mode: "normal", sessionId },
    { type: "permission-mode", permissionMode: relayClaudePermissionMode(), sessionId },
  ];
  if (operatorNote) {
    // Hidden agent-only channel: a system-meta row. isMeta marks it non-visible to
    // the user; the agent still has it in context. Carries no chat role, so it is
    // not rendered in the human-visible transcript.
    rows.push({
      type: "system",
      subtype: "relay-operator-note",
      isMeta: true,
      isVisibleInTranscriptOnly: false,
      content: operatorNote,
      level: "info",
      uuid: operatorUuid,
      parentUuid: null,
      timestamp: createdAt,
      sessionId,
    });
  }
  rows.push(
    {
      parentUuid: operatorNote ? operatorUuid : null,
      isSidechain: false,
      message: {
        // Claude reads the session model off the last assistant row on resume.
        // This must always be a real Claude model id: an internal Relay label
        // makes current Claude builds reject the session instead of falling back.
        model: resolveClaudeSessionModel(model),
        id: claudeMessageId(),
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: visible }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {},
      },
      requestId: relayRequestId(),
      type: "assistant",
      uuid: assistantUuid,
      timestamp: createdAt,
      userType: "external",
      entrypoint: "relay-companion",
      cwd,
      sessionId,
      version: "relay-companion",
      gitBranch: process.env.GIT_BRANCH || null,
    },
    {
      type: "last-prompt",
      lastPrompt: row?.relayNotificationKind === "sent_relay"
        ? `Relay to ${row?.recipient?.name || row?.recipient?.email || "recipient"}`
        : `Relay from ${row?.senderName || row?.sender?.name || row?.sender?.handle || "sender"}`,
      leafUuid: assistantUuid,
      sessionId,
    },
  );

  fs.mkdirSync(sessionDir, { recursive: true });
  writeJsonlAtomic(sessionPath, rows);
  const transcriptModelValidation = repairClaudeSessionModel({ sessionPath, model });
  if (transcriptModelValidation.valid === false) {
    throw new Error(
      `Relay wrote a Claude session with an invalid model (${transcriptModelValidation.reason || "unknown"}).`,
    );
  }
  const desktopMetadataPath = writeClaudeDesktopSessionMetadata({ sessionId, title, cwd, createdAt, model, effort });
  if (process.env.RELAY_IMPORT_CLAUDE_DESKTOP !== "0") {
    sleepSync(Number(process.env.RELAY_CLAUDE_PREIMPORT_DELAY_MS || 750));
  }
  const deepLink = claudeResumeDeepLink(sessionId);
  const desktopImport = importClaudeDesktopSession({ sessionId });
  const desktopTitleBeforeRefocus = restoreClaudeDesktopSessionTitle({
    sessionId,
    title,
    cwd,
    createdAt,
    model,
    metadataPath: desktopMetadataPath,
    retries: desktopImport.attempted ? 10 : 1,
  });
  const desktopRefocus =
    desktopImport.attempted && desktopImport.status === 0
      ? importClaudeDesktopSession({ sessionId })
      : { attempted: false, reason: desktopImport.reason || "import-not-successful", deepLink };
  const desktopTitle =
    desktopRefocus.attempted && desktopRefocus.status === 0
      ? restoreClaudeDesktopSessionTitle({
          sessionId,
          title,
          cwd,
          createdAt,
          model,
          metadataPath: desktopTitleBeforeRefocus.metadataPath || desktopMetadataPath,
          retries: 10,
        })
      : desktopTitleBeforeRefocus;
  const desktopRepair = repairClaudeDesktopRelaySessions({ sessionIds: [sessionId] });
  // Last word on the mode: the repair pass rewrites whole metadata files from
  // what is on disk, so assert after it, not before.
  const desktopPermissionMode = setClaudeDesktopSessionPermissionMode({ sessionId });

  return {
    sessionId,
    title,
    sessionPath,
    desktopMetadataPath: desktopTitle.metadataPath || desktopMetadataPath,
    deepLink,
    desktopImport,
    desktopTitleBeforeRefocus,
    desktopTitle,
    desktopRefocus,
    desktopRepair,
    desktopPermissionMode,
    transcriptModelRepair: transcriptModelValidation,
    desktopLiveTitle: CLAUDE_DESKTOP_LIVE_TITLE_LIMITATION,
  };
}

export function writeClaudeDesktopSessionMetadata({
  sessionId,
  title,
  cwd,
  createdAt = new Date().toISOString(),
  model = "",
  effort = "",
}) {
  const groupDir = findClaudeDesktopSessionGroupDir();
  if (!groupDir) return null;
  const nowMs = Date.now();
  const createdAtMs = Number.isFinite(Date.parse(createdAt)) ? Date.parse(createdAt) : nowMs;
  const desktopSessionId = `local_${sessionId}`;
  const metadataPath = path.join(groupDir, `${desktopSessionId}.json`);
  const metadata = {
    sessionId: desktopSessionId,
    cliSessionId: sessionId,
    cwd,
    originCwd: cwd,
    lastFocusedAt: nowMs,
    createdAt: createdAtMs,
    lastActivityAt: nowMs,
    // Explicit choice (the task runtime picker) beats the env override beats
    // the default; effort mirrors model.
    model: resolveClaudeSessionModel(model),
    effort: String(effort || "").trim() || "high",
    isArchived: false,
    title,
    titleSource: "user",
    permissionMode: relayClaudePermissionMode(),
    enabledMcpTools: {},
    remoteMcpServersConfig: [],
    chromePermissionMode: "skip_all_permission_checks",
    completedTurns: 1,
    bridgeSessionIds: [],
    alwaysAllowedReasons: [],
    sessionPermissionUpdates: [],
    classifierSummaryEnabled: true,
  };
  writeJsonAtomic(metadataPath, metadata);
  return metadataPath;
}

export function setClaudeDesktopSessionPermissionMode({
  sessionId,
  permissionMode = relayClaudePermissionMode(),
} = {}) {
  if (!sessionId) return { attempted: false, reason: "missing-session-id", metadataPath: null };
  const metadataPath = claudeDesktopSessionMetadataPath(sessionId);
  if (!metadataPath || !fs.existsSync(metadataPath)) {
    return { attempted: false, reason: "metadata-not-found", metadataPath: metadataPath || null };
  }
  const metadata = readJsonIfExists(metadataPath, null);
  if (!metadata) return { attempted: false, reason: "metadata-unreadable", metadataPath };
  if (metadata.permissionMode === permissionMode) {
    return { attempted: true, updated: false, metadataPath, permissionMode };
  }
  writeJsonAtomic(metadataPath, { ...metadata, permissionMode });
  return { attempted: true, updated: true, metadataPath, permissionMode };
}

export function restoreClaudeDesktopSessionTitle({
  sessionId,
  title,
  cwd = process.cwd(),
  createdAt = new Date().toISOString(),
  model = "",
  metadataPath = null,
  retries = 10,
  delayMs = 250,
} = {}) {
  if (!sessionId || !title) {
    return { attempted: false, reason: "missing-session-or-title", metadataPath: metadataPath || null };
  }

  let currentPath = metadataPath;
  let lastError = null;
  let lastSuccess = null;
  const totalAttempts = Math.max(1, retries);
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    if (attempt > 0 || totalAttempts > 1) sleepSync(delayMs);
    currentPath = currentPath || claudeDesktopSessionMetadataPath(sessionId);
    if (!currentPath) {
      lastError = "no-claude-desktop-session-dir";
      continue;
    }

    try {
      const nowMs = Date.now();
      const createdAtMs = Number.isFinite(Date.parse(createdAt)) ? Date.parse(createdAt) : nowMs;
      const existing = fs.existsSync(currentPath) ? readJsonIfExists(currentPath, {}) : {};
      writeJsonAtomic(currentPath, {
        sessionId: `local_${sessionId}`,
        cliSessionId: sessionId,
        cwd,
        originCwd: cwd,
        lastFocusedAt: existing.lastFocusedAt || nowMs,
        createdAt: existing.createdAt || createdAtMs,
        lastActivityAt: existing.lastActivityAt || nowMs,
        effort: existing.effort || "high",
        isArchived: false,
        enabledMcpTools: existing.enabledMcpTools || {},
        remoteMcpServersConfig: existing.remoteMcpServersConfig || [],
        chromePermissionMode: existing.chromePermissionMode || "skip_all_permission_checks",
        completedTurns: existing.completedTurns || 1,
        bridgeSessionIds: existing.bridgeSessionIds || [],
        alwaysAllowedReasons: existing.alwaysAllowedReasons || [],
        sessionPermissionUpdates: existing.sessionPermissionUpdates || [],
        classifierSummaryEnabled: existing.classifierSummaryEnabled ?? true,
        ...existing,
        title,
        titleSource: "user",
        // Re-pin a valid model after the spread too. Desktop can rewrite the
        // metadata during import, and older Relay builds wrote their own name
        // here instead of a Claude model id.
        model: resolveClaudeSessionModel(model, process.env.RELAY_CLAUDE_METADATA_MODEL, existing.model),
        // Re-pinned after the spread, exactly like the title, and for the same
        // reason: Claude Desktop's importCliSession builds the session with
        // permissionMode Default hardcoded and saves it over what we wrote before
        // the deep link. Preserving `existing` here re-adopted that Default, so a
        // Relay-opened session stayed on Manual for the rest of its life.
        permissionMode: relayClaudePermissionMode(),
      });
      lastSuccess = {
        attempted: true,
        restored: true,
        metadataPath: currentPath,
        title,
        titleSource: "user",
        attempts: attempt + 1,
      };
      if (totalAttempts === 1) return lastSuccess;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  if (lastSuccess) return { ...lastSuccess, attempts: totalAttempts };

  return {
    attempted: true,
    restored: false,
    metadataPath: currentPath || null,
    title,
    reason: lastError || "unknown",
    attempts: Math.max(1, retries),
  };
}

export function claudeResumeDeepLink(sessionId) {
  return `claude://resume?session=${encodeURIComponent(sessionId)}`;
}

export function importClaudeDesktopSession({ sessionId, activate = process.env.RELAY_ACTIVATE_CLAUDE === "1" } = {}) {
  const deepLink = claudeResumeDeepLink(sessionId);
  if (process.env.RELAY_IMPORT_CLAUDE_DESKTOP === "0") {
    return { attempted: false, reason: "disabled", deepLink };
  }
  if (process.platform !== "darwin" && process.platform !== "win32") {
    return { attempted: false, reason: "unsupported-platform", deepLink };
  }

  const command = process.platform === "win32" ? "cmd.exe" : "open";
  const args =
    process.platform === "win32"
      ? ["/c", "start", "", deepLink]
      : activate ? [deepLink] : ["-g", deepLink];
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000, windowsHide: true });
  return {
    attempted: true,
    deepLink,
    command,
    args,
    status: result.status,
    signal: result.signal,
    error: result.error ? result.error.message : null,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

// THE APP READS THE TRANSCRIPT TO FIND THE WORKING DIRECTORY, and refuses the
// import when it cannot: "Cannot determine working directory for CLI session
// <id> — the transcript may be incomplete", logged under category
// `transcript_missing`. A forked background run writes its seed rows FIRST —
// custom-title, ai-title, agent-name, mode, permission-mode — and not one of
// them carries a cwd; the first row that does is the `system` row, several
// writes later (measured: row 7 of the fork, row 6 of a forge). So "the file
// exists" is still too early a signal, and firing the deep link on it is what
// silently dropped the run from the reader's session list. Readiness is a row
// with a cwd, not a file on disk.
export function claudeTranscriptCwd(sessionPath) {
  if (!sessionPath || !fs.existsSync(sessionPath)) return "";
  let raw = "";
  try {
    raw = fs.readFileSync(sessionPath, "utf8");
  } catch {
    return "";
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      // The tail of a file being appended to is routinely a half-written line;
      // an unparseable row is "not yet", never a failure.
      const cwd = String(JSON.parse(trimmed)?.cwd || "").trim();
      if (cwd) return cwd;
    } catch {}
  }
  return "";
}

/**
 * Hand Claude Code a session it can actually open, and keep the title on it.
 *
 * This is the FORK's adoption path, and it is deliberately async: it runs in
 * the Electron main process, where the writeClaudeNativeSession forge's
 * sleepSync retry loop would freeze the pill for seconds. Every wait here
 * yields.
 *
 * Order is the whole point:
 *   1. wait for the transcript to carry a cwd (see claudeTranscriptCwd) —
 *      without it the app rejects the deep link outright;
 *   2. write our metadata, then fire the import;
 *   3. restore the title AFTER the import, because the app's import REWRITES
 *      local_<id>.json wholesale and drops the title we wrote in step 2 —
 *      measured live: the run showed up in the session list untitled.
 */
export async function adoptClaudeSessionIntoDesktop({
  sessionId,
  title,
  cwd = "",
  createdAt = new Date().toISOString(),
  model = "",
  effort = "",
  sessionPath = "",
  timeoutMs = 30_000,
  pollMs = 250,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // A Relay-owned native worker must remain the transcript's only owner until
  // it has completely settled. Materializing makes the finished transcript
  // openable in Desktop; importing fires claude://resume and starts Desktop's
  // own worker, so the Relay runner deliberately defers that second step until
  // the human presses Open.
  importIntoDesktop = true,
} = {}) {
  if (!sessionId) return { attempted: false, reason: "missing-session" };

  let transcriptCwd = "";
  let waitedMs = 0;
  if (sessionPath) {
    for (;;) {
      transcriptCwd = claudeTranscriptCwd(sessionPath);
      if (transcriptCwd || waitedMs >= timeoutMs) break;
      await sleep(pollMs);
      waitedMs += pollMs;
    }
    if (!transcriptCwd) {
      // Say so instead of firing a deep link we know the app will reject: a
      // recorded miss is debuggable, a silent one is what produced "i dont see
      // it in my claude code at all".
      return { attempted: false, reason: "transcript-has-no-cwd", sessionPath, waitedMs };
    }
  }

  const resolvedCwd = cwd || transcriptCwd || "";
  // A stream-json worker writes a real Claude transcript but does not emit the
  // CLI's --name title rows. Put the user-visible title in the transcript
  // before Desktop reads it; metadata alone is too late and leaves the open
  // session header as "Untitled" even when the rail row is later repaired.
  if (title) appendClaudeSessionTitleRows({ sessionId, title, cwd: resolvedCwd });
  const metadataPath = writeClaudeDesktopSessionMetadata({
    sessionId,
    title,
    cwd: resolvedCwd,
    createdAt,
    model,
    effort,
  });
  if (!importIntoDesktop) {
    return {
      attempted: true,
      materialized: true,
      sessionId,
      cwd: resolvedCwd,
      sessionPath,
      waitedMs,
      metadataPath,
      deepLink: claudeResumeDeepLink(sessionId),
      desktopImport: { attempted: false, reason: "deferred-until-user-open" },
      desktopRefocus: { attempted: false, reason: "deferred-until-user-open" },
      desktopTitle: { attempted: true, restored: true, metadataPath, title, titleSource: "user" },
      desktopLiveTitle: CLAUDE_DESKTOP_LIVE_TITLE_LIMITATION,
    };
  }
  const desktopImport = importClaudeDesktopSession({ sessionId, activate: false });

  // The title survives only if we win the last write. Re-assert it until the
  // app stops clobbering, with retries:1 so the writer never sleeps
  // synchronously on this thread.
  let desktopTitle = { attempted: false, reason: "import-not-successful", metadataPath };
  if (title && desktopImport.attempted && desktopImport.status === 0) {
    const deadline = Date.now() + Math.max(pollMs, Math.min(timeoutMs, 2_000));
    for (;;) {
      await sleep(pollMs);
      desktopTitle = restoreClaudeDesktopSessionTitle({
        sessionId,
        title,
        cwd: resolvedCwd,
        createdAt,
        model,
        metadataPath,
        retries: 1,
      });
      const saved = readJsonIfExists(desktopTitle.metadataPath || metadataPath, null);
      if (saved?.title === title && saved?.titleSource === "user" && Date.now() >= deadline) break;
      if (Date.now() >= deadline) break;
    }
  }

  // The first import constructs an in-memory rail row before the post-import
  // title repair wins its final disk write. Re-open once from the repaired
  // metadata so the live rail/header sees the same title immediately instead
  // of showing "General coding session" until Claude restarts.
  const desktopRefocus =
    title && desktopImport.attempted && desktopImport.status === 0
      ? importClaudeDesktopSession({ sessionId, activate: false })
      : { attempted: false, reason: "import-not-successful" };
  if (desktopRefocus.attempted && desktopRefocus.status === 0) {
    const deadline = Date.now() + Math.max(pollMs, Math.min(timeoutMs, 5_000));
    for (;;) {
      await sleep(pollMs);
      desktopTitle = restoreClaudeDesktopSessionTitle({
        sessionId,
        title,
        cwd: resolvedCwd,
        createdAt,
        model,
        metadataPath,
        retries: 1,
      });
      if (Date.now() >= deadline) break;
    }
  }

  return {
    attempted: true,
    sessionId,
    cwd: resolvedCwd,
    sessionPath,
    waitedMs,
    metadataPath: desktopTitle.metadataPath || metadataPath,
    deepLink: claudeResumeDeepLink(sessionId),
    desktopImport,
    desktopRefocus,
    desktopTitle,
    desktopLiveTitle: CLAUDE_DESKTOP_LIVE_TITLE_LIMITATION,
  };
}

export function isClaudeNativeSessionImported(nativeSession) {
  if (!nativeSession?.sessionId) return false;
  const deepLink = nativeSession.deepLink || nativeSession.desktopImport?.deepLink || "";
  if (!deepLink.startsWith("claude://resume?session=")) return false;
  const desktopImport = nativeSession.desktopImport;
  if (!desktopImport) return false;
  if (desktopImport.attempted) return desktopImport.status === 0 && isClaudeDesktopTitleRestored(nativeSession);
  return desktopImport.reason === "disabled" || desktopImport.reason === "unsupported-platform";
}

export function ensureClaudeDesktopImported(nativeSession, { title, cwd, createdAt, model = "" } = {}) {
  if (!nativeSession?.sessionId) return nativeSession;
  const transcriptModelRepair = repairClaudeSessionModel({
    sessionPath: nativeSession.sessionPath,
    model,
  });
  if (transcriptModelRepair.valid === false) {
    throw new Error(
      `Relay could not safely repair the Claude session model (${transcriptModelRepair.reason || "unknown"}). Try opening the Relay again.`,
    );
  }
  nativeSession = { ...nativeSession, transcriptModelRepair };
  const nextTitle = title || nativeSession.title;
  if (isClaudeNativeSessionImported(nativeSession)) return nativeSession;
  const desktopImport =
    nativeSession.desktopImport?.attempted && nativeSession.desktopImport.status === 0
      ? nativeSession.desktopImport
      : importClaudeDesktopSession({ sessionId: nativeSession.sessionId });
  const desktopTitleBeforeRefocus = restoreClaudeDesktopSessionTitle({
    sessionId: nativeSession.sessionId,
    title: nextTitle,
    cwd: cwd || nativeSession.cwd || process.cwd(),
    createdAt: createdAt || nativeSession.createdAt || new Date().toISOString(),
    model,
    metadataPath: nativeSession.desktopMetadataPath || nativeSession.desktopTitle?.metadataPath || null,
    retries: desktopImport.attempted ? 10 : 1,
  });
  const desktopRefocus =
    desktopImport.attempted && desktopImport.status === 0
      ? importClaudeDesktopSession({ sessionId: nativeSession.sessionId })
      : {
          attempted: false,
          reason: desktopImport.reason || "import-not-successful",
          deepLink: claudeResumeDeepLink(nativeSession.sessionId),
        };
  const desktopTitle =
    desktopRefocus.attempted && desktopRefocus.status === 0
      ? restoreClaudeDesktopSessionTitle({
          sessionId: nativeSession.sessionId,
          title: nextTitle,
          cwd: cwd || nativeSession.cwd || process.cwd(),
          createdAt: createdAt || nativeSession.createdAt || new Date().toISOString(),
          model,
          metadataPath: desktopTitleBeforeRefocus.metadataPath || nativeSession.desktopMetadataPath || null,
          retries: 10,
        })
      : desktopTitleBeforeRefocus;
  const desktopRepair = repairClaudeDesktopRelaySessions({ sessionIds: [nativeSession.sessionId] });
  const desktopPermissionMode = setClaudeDesktopSessionPermissionMode({ sessionId: nativeSession.sessionId });
  return {
    ...nativeSession,
    title: nextTitle,
    deepLink: claudeResumeDeepLink(nativeSession.sessionId),
    desktopMetadataPath: desktopTitle.metadataPath || nativeSession.desktopMetadataPath || null,
    desktopImport,
    desktopTitleBeforeRefocus,
    desktopTitle,
    desktopRefocus,
    desktopRepair,
    desktopPermissionMode,
    desktopLiveTitle: CLAUDE_DESKTOP_LIVE_TITLE_LIMITATION,
  };
}

/**
 * Resolve one model id for both the forged transcript and Desktop metadata.
 * Callers may provide candidates in priority order; the environment override
 * and product default are the final fallbacks. The historical Relay sentinel
 * is never a valid candidate, even if it leaks in through persisted state.
 */
export function resolveClaudeSessionModel(...values) {
  const candidates = [...values, process.env.RELAY_CLAUDE_METADATA_MODEL, DEFAULT_CLAUDE_METADATA_MODEL];
  for (const value of candidates) {
    const candidate = String(value || "").trim();
    if (candidate && candidate.toLowerCase() !== INVALID_RELAY_CLAUDE_MODEL) return candidate;
  }
  return DEFAULT_CLAUDE_METADATA_MODEL;
}

/**
 * Heal transcripts forged by older Relay builds before Claude resumes them.
 * Only the exact Relay-owned seed row is eligible. Untouched lines remain
 * byte-for-byte identical, and a concurrent append or malformed tail aborts
 * the atomic replacement rather than risking a user's Claude transcript.
 */
export function repairClaudeSessionModel({ sessionPath = "", model = "" } = {}) {
  const resolvedModel = resolveClaudeSessionModel(model);
  if (!sessionPath) return { attempted: false, repaired: false, valid: true, reason: "missing-session-path", model: resolvedModel };
  if (!fs.existsSync(sessionPath)) {
    return { attempted: false, repaired: false, valid: true, reason: "session-transcript-not-found", sessionPath, model: resolvedModel };
  }

  let before;
  let raw;
  try {
    before = fs.statSync(sessionPath);
    raw = fs.readFileSync(sessionPath, "utf8");
  } catch (error) {
    return {
      attempted: true,
      repaired: false,
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
      sessionPath,
      model: resolvedModel,
    };
  }

  const newline = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);
  let invalidRows = 0;
  const nextLines = [];
  for (const line of lines) {
    if (!line.trim()) {
      nextLines.push(line);
      continue;
    }
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return {
        attempted: true,
        repaired: false,
        valid: false,
        reason: "transcript-is-changing-or-malformed",
        sessionPath,
        model: resolvedModel,
        invalidRows,
      };
    }
    if (isRelayForgedAssistantRow(row)) {
      const currentModel = String(row.message?.model || "").trim().toLowerCase();
      if (!currentModel || currentModel === INVALID_RELAY_CLAUDE_MODEL) {
        invalidRows += 1;
        row = { ...row, message: { ...row.message, model: resolvedModel } };
        nextLines.push(JSON.stringify(row));
        continue;
      }
    }
    nextLines.push(line);
  }

  if (!invalidRows) {
    return { attempted: true, repaired: false, valid: true, reason: "already-valid", sessionPath, model: resolvedModel, invalidRows: 0 };
  }

  const nextRaw = nextLines.join(newline);
  const temporaryPath = `${sessionPath}.${process.pid}.${Date.now()}.model-repair.tmp`;
  try {
    fs.writeFileSync(temporaryPath, nextRaw, { mode: before.mode & 0o777 });
    const current = fs.statSync(sessionPath);
    if (current.size !== before.size || current.mtimeMs !== before.mtimeMs) {
      fs.rmSync(temporaryPath, { force: true });
      return {
        attempted: true,
        repaired: false,
        valid: false,
        reason: "transcript-changed-during-repair",
        sessionPath,
        model: resolvedModel,
        invalidRows,
      };
    }
    fs.renameSync(temporaryPath, sessionPath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch {}
    return {
      attempted: true,
      repaired: false,
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
      sessionPath,
      model: resolvedModel,
      invalidRows,
    };
  }

  return {
    attempted: true,
    repaired: true,
    valid: true,
    reason: "legacy-relay-model-repaired",
    sessionPath,
    model: resolvedModel,
    invalidRows,
  };
}

export function setClaudeNativeSessionAttention(
  nativeSession,
  { packetId, title = nativeSession?.title || null, state = "unread", nowMs = Date.now() } = {},
) {
  const sessionId = nativeSession?.sessionId;
  if (!sessionId) return { attempted: false, reason: "missing-session-id" };
  const metadataPath = nativeSession.desktopMetadataPath || claudeDesktopSessionMetadataPath(sessionId);
  if (!metadataPath || !fs.existsSync(metadataPath)) {
    return { attempted: false, reason: "metadata-not-found", metadataPath: metadataPath || null };
  }

  const metadata = readJsonIfExists(metadataPath, null);
  if (!metadata) return { attempted: false, reason: "metadata-unreadable", metadataPath };

  const previousAttention = metadata.relayAttention || {};
  const originalLastActivityAt =
    previousAttention.originalLastActivityAt ?? (Number.isFinite(metadata.lastActivityAt) ? metadata.lastActivityAt : nowMs);
  const originalLastFocusedAt =
    previousAttention.originalLastFocusedAt ?? (Number.isFinite(metadata.lastFocusedAt) ? metadata.lastFocusedAt : null);
  const timestamp = new Date(nowMs).toISOString();
  const nextAttention = {
    ...previousAttention,
    packetId: packetId || previousAttention.packetId || null,
    title: title || previousAttention.title || metadata.title || null,
    state,
    originalLastActivityAt,
    originalLastFocusedAt,
    updatedAt: timestamp,
  };

  const nextMetadata = {
    ...metadata,
    isArchived: false,
    relayAttention: nextAttention,
  };
  if (isRelayTitle(title)) {
    nextMetadata.title = title;
    nextMetadata.titleSource = "user";
  }

  if (state === "unread") {
    nextAttention.lastAppliedAt = nowMs;
    nextMetadata.lastActivityAt = Math.max(nowMs, Number(metadata.lastActivityAt) || 0);
  } else {
    nextAttention.acknowledgedAt = timestamp;
    nextMetadata.lastActivityAt = originalLastActivityAt;
  }

  writeJsonAtomic(metadataPath, nextMetadata);
  return {
    attempted: true,
    metadataPath,
    sessionId,
    state,
    lastActivityAt: nextMetadata.lastActivityAt,
    originalLastActivityAt,
  };
}

export function repairClaudeDesktopRelaySessions({ sessionIds = null } = {}) {
  const groupDir = findClaudeDesktopSessionGroupDir();
  if (!groupDir) return { attempted: false, reason: "no-claude-desktop-session-dir", repaired: [], archived: [] };
  const requested = sessionIds ? new Set(sessionIds) : null;
  const metadataFiles = childJsonFiles(groupDir)
    .map((filePath) => ({ filePath, metadata: readJsonIfExists(filePath, null) }))
    .filter((entry) => entry.metadata?.cliSessionId)
    .filter((entry) => !requested || requested.has(entry.metadata.cliSessionId));
  const byCliSession = new Map();
  for (const entry of metadataFiles) {
    const list = byCliSession.get(entry.metadata.cliSessionId) || [];
    list.push(entry);
    byCliSession.set(entry.metadata.cliSessionId, list);
  }

  const repaired = [];
  const archived = [];
  for (const [sessionId, entries] of byCliSession) {
    const title = inferRelayTitleForClaudeSession(sessionId, entries);
    if (!title) continue;

    const canonicalSessionId = `local_${sessionId}`;
    let canonical = entries.find((entry) => entry.metadata.sessionId === canonicalSessionId);
    if (!canonical) {
      const seed = entries[0];
      const canonicalPath = path.join(groupDir, `${canonicalSessionId}.json`);
      const metadata = {
        ...seed.metadata,
        sessionId: canonicalSessionId,
        cliSessionId: sessionId,
        title,
        titleSource: "user",
        isArchived: false,
        lastActivityAt: seed.metadata.lastActivityAt || Date.now(),
      };
      writeJsonAtomic(canonicalPath, metadata);
      canonical = { filePath: canonicalPath, metadata };
      entries.push(canonical);
      repaired.push({ sessionId, metadataPath: canonicalPath, title });
    }
    const targets = canonical ? [canonical] : entries;
    for (const entry of targets) {
      if (entry.metadata.title === title && entry.metadata.titleSource === "user") continue;
      writeJsonAtomic(entry.filePath, {
        ...entry.metadata,
        sessionId: entry.metadata.sessionId || canonicalSessionId,
        cliSessionId: sessionId,
        title,
        titleSource: "user",
        isArchived: false,
        lastActivityAt: entry.metadata.lastActivityAt || Date.now(),
      });
      appendClaudeSessionTitleRows({ sessionId, title, cwd: entry.metadata.cwd || entry.metadata.originCwd });
      repaired.push({ sessionId, metadataPath: entry.filePath, title });
    }

    for (const entry of entries) {
      if (entry === canonical) continue;
      const duplicateTitle = isRelayTitle(entry.metadata.title) ? entry.metadata.title : title;
      if (entry.metadata.isArchived === true) continue;
      writeJsonAtomic(entry.filePath, {
        ...entry.metadata,
        title: duplicateTitle,
        titleSource: entry.metadata.titleSource || "user",
        isArchived: true,
      });
      archived.push({ sessionId, metadataPath: entry.filePath, title: duplicateTitle });
    }
  }

  return { attempted: true, groupDir, repaired, archived };
}

export function appendClaudeSessionTitleRows({ sessionId, title, cwd = null }) {
  if (!sessionId || !title) return { appended: false, reason: "missing-session-or-title" };
  const sessionPath = findClaudeSessionPath({ sessionId, cwd });
  if (!sessionPath) return { appended: false, reason: "session-transcript-not-found" };
  const timestamp = new Date().toISOString();
  appendJsonlAtomic(sessionPath, [
    { type: "custom-title", customTitle: title, sessionId, uuid: crypto.randomUUID(), timestamp },
    { type: "ai-title", aiTitle: title, sessionId, uuid: crypto.randomUUID(), timestamp },
    { type: "agent-name", agentName: title, sessionId, uuid: crypto.randomUUID(), timestamp },
  ]);
  return { appended: true, sessionPath, title };
}

export function claudeProjectKey(cwd) {
  return path.resolve(String(cwd || process.cwd())).replace(/[^0-9A-Za-z]/g, "-");
}

function findClaudeDesktopSessionGroupDir() {
  const root = claudeDesktopSessionsDir();
  if (!fs.existsSync(root)) return null;
  const accountDirs = childDirectories(root);
  for (const accountDir of accountDirs) {
    const groupDirs = childDirectories(accountDir);
    if (groupDirs.length) return groupDirs[0];
  }
  return null;
}

function claudeDesktopSessionMetadataPath(sessionId) {
  const groupDir = findClaudeDesktopSessionGroupDir();
  if (!groupDir) return null;
  return path.join(groupDir, `local_${sessionId}.json`);
}

function inferRelayTitleForClaudeSession(sessionId, entries) {
  for (const entry of entries) {
    if (isRelayTitle(entry.metadata.title)) return entry.metadata.title;
  }
  const transcriptTitle = readRelayTitleFromClaudeTranscript(sessionId, entries[0]?.metadata?.cwd || entries[0]?.metadata?.originCwd);
  if (transcriptTitle) return transcriptTitle;
  return null;
}

function readRelayTitleFromClaudeTranscript(sessionId, cwd = null) {
  const sessionPath = findClaudeSessionPath({ sessionId, cwd });
  if (!sessionPath) return null;
  let latestTitle = null;
  for (const line of fs.readFileSync(sessionPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row = null;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRelayTitle(row.customTitle)) latestTitle = row.customTitle;
    if (isRelayTitle(row.aiTitle)) latestTitle = row.aiTitle;
    if (isRelayTitle(row.agentName)) latestTitle = row.agentName;
    const text = row.message?.content?.find?.((item) => item?.type === "text")?.text || "";
    const heading = text.match(/^#\s*(🔁\s+(?:From|To|Task:)[^\n]+)/m)?.[1];
    if (isRelayTitle(heading)) latestTitle = heading;
  }
  return latestTitle;
}

function findClaudeSessionPath({ sessionId, cwd = null }) {
  if (cwd) {
    const direct = path.join(claudeProjectsDir(), claudeProjectKey(cwd), `${sessionId}.jsonl`);
    if (fs.existsSync(direct)) return direct;
  }
  const root = claudeProjectsDir();
  if (!fs.existsSync(root)) return null;
  for (const dir of childDirectories(root)) {
    const candidate = path.join(dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function isRelayTitle(value) {
  return /^🔁\s+((?:From|To)\s+.+:|Task:)/u.test(String(value || "").trim());
}

function isRelayForgedAssistantRow(row) {
  return (
    row?.type === "assistant" &&
    row?.entrypoint === "relay-companion" &&
    row?.version === "relay-companion" &&
    row?.message?.role === "assistant" &&
    /^msg_01relay[0-9a-f]+$/i.test(String(row?.message?.id || ""))
  );
}

function childDirectories(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function childJsonFiles(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function claudeMessageId() {
  return `msg_01relay${crypto.randomBytes(18).toString("hex")}`;
}

function relayRequestId() {
  return `req_relay_${crypto.randomBytes(12).toString("hex")}`;
}

function writeJsonlAtomic(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function appendJsonlAtomic(filePath, rows) {
  fs.appendFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
}

function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function isClaudeDesktopTitleRestored(nativeSession) {
  const desktopImport = nativeSession.desktopImport;
  if (!desktopImport?.attempted) return true;
  const expectedTitle = nativeSession.title || nativeSession.desktopTitle?.title;
  const metadataPath = nativeSession.desktopTitle?.metadataPath || nativeSession.desktopMetadataPath;
  if (expectedTitle && metadataPath && fs.existsSync(metadataPath)) {
    const metadata = readJsonIfExists(metadataPath, null);
    return metadata?.title === expectedTitle && metadata?.titleSource === "user";
  }
  return nativeSession.desktopTitle?.restored === true;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
