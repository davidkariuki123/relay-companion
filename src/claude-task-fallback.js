// Native Desktop only. Preflight is an estimate, never an admission API.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { claudeDesktopConfigDirs } from "./desktop-hosts.js";
import { claudeHome } from "./host-paths.js";

const run = promisify(execFile);
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
const names = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
const alive = (pid) => { try { if (!Number.isInteger(pid) || pid < 1) return false; process.kill(pid, 0); return true; } catch { return false; } };
// Inspected stock Windows versions. New versions fall back to a draft until
// their governor is verified; do not assume a provider-internal limit forever.
const inspected = new Set(["2.2553.1", "2.2553.13", "2.7032.0"]);
export async function claudeDesktopVersion() {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "(Get-AppxPackage -Name Claude | Select-Object -First 1 -ExpandProperty Version)"], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    return stdout.trim().replace(/\.0$/, "");
  } catch { return null; }
}

export async function claudeLaunchPreflight({
  version = claudeDesktopVersion, registry = path.join(claudeHome(), "sessions"),
  configDirs = claudeDesktopConfigDirs(), totalMemory = os.totalmem(), isAlive = alive,
} = {}) {
  const appVersion = typeof version === "function" ? await version() : version;
  const registrations = names(registry).filter((n) => n.endsWith(".json")).map((n) => read(path.join(registry, n)));
  const count = new Set(registrations.filter((r) => r?.entrypoint === "claude-desktop" && isAlive(r.pid)).map((r) => r.pid)).size;
  const preference = configDirs.map((dir) => read(path.join(dir, "claude_desktop_config.json"))?.preferences?.ccRemoteControlDefaultEnabled).find((v) => typeof v === "boolean");
  const estimatedCap = inspected.has(appVersion) ? Math.max(6, Math.floor(totalMemory / (3 * 1024 ** 3))) : null;
  const reason = estimatedCap === null ? "unknown_version" : count >= estimatedCap ? "capacity" : "headroom";
  return { manual: reason !== "headroom", reason, appVersion, liveProcesses: count, estimatedCap, remoteControlDefault: preference ?? null };
}

export function prepareClaudeDraft({ cwd, title, persist, preflight, previousSession }) {
  if (!path.isAbsolute(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("Choose an existing workspace folder.");
  const draftId = randomUUID();
  // This is a harmless handshake, NOT the Task. The real prompt follows only
  // after exact transcript binding and canonical server ownership. Thus a stale
  // draft, a duplicate Send, or another device cannot start the work twice.
  const caption = String(title || "Relay Task").replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 80);
  const draftPrompt = `Start my Relay task. Reply only "Ready" and wait for Relay to send the task instructions in this conversation. Do not use tools or begin work from the title.\n\nTask title (context only): ${JSON.stringify(caption)}\nRelay launch reference: ${draftId}`;
  const url = `claude://code/new?${new URLSearchParams({ q: draftPrompt, folder: cwd })}`;
  // Keep well below native protocol-handler limits; never truncate context.
  if (url.length > 2000) throw new Error("This workspace path is too long for Claude's draft link. Choose a shorter local path.");
  const session = { provider: "claude", cwd, url, draftId, draftPrompt, draftCreatedAt: new Date().toISOString(), preflight,
    ...(previousSession?.nativeId ? { unusedPreparedNativeId: previousSession.nativeId } : {}) };
  persist(session);
  return session;
}

export function findClaudeDraftSession(draft, { home = claudeHome() } = {}) {
  if (!draft?.draftId || !draft.draftPrompt || !draft.cwd) return null;
  const dir = path.join(home, "projects", draft.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const matches = [];
  for (const name of names(dir)) {
    if (!/^[0-9a-f-]{36}\.jsonl$/i.test(name)) continue;
    const transcript = path.join(dir, name), nativeId = name.slice(0, -6);
    let fd;
    try {
      if (fs.statSync(transcript).mtimeMs < Date.parse(draft.draftCreatedAt) - 2000) continue;
      fd = fs.openSync(transcript, "r");
      const bytes = Buffer.alloc(Math.min(fs.fstatSync(fd).size, 512 * 1024));
      fs.readSync(fd, bytes, 0, bytes.length, 0);
      const found = bytes.toString("utf8").split("\n").some((line) => {
        let row; try { row = JSON.parse(line); } catch { return false; }
        if (row.type !== "user" || row.isSidechain || row.sessionId !== nativeId || !row.cwd || path.resolve(row.cwd) !== path.resolve(draft.cwd)) return false;
        const content = row.message?.content;
        const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "";
        return text.trim() === draft.draftPrompt;
      });
      if (found) matches.push({ ...draft, nativeId, transcript, url: `claude://resume?session=${nativeId}`, fromDraft: true });
    } catch { /* provider file being written */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  if (matches.length > 1) throw new Error("This Relay draft was sent in more than one Claude conversation. No Task instructions were sent. Use Copy for your agent to continue in one conversation.");
  return matches[0] || null;
}
