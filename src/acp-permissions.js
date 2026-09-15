import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { configDir } from "./config.js";

const directory = () => path.join(configDir(), "acp-permissions");
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
const safeId = id => typeof id === "string" && /^[a-f0-9-]{36}$/.test(id);

// Daemon and pill are separate processes. Only the pill records a decision;
// absent/stale UI, cancellation and timeout all return ACP's cancelled outcome.
export async function requestAcpPermission(params, { provider, cwd, signal, timeoutMs = 10 * 60_000 } = {}) {
  const id = randomUUID();
  const root = directory();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const requestPath = path.join(root, `${id}.request.json`);
  const answerPath = path.join(root, `${id}.answer.json`);
  const request = { id, provider, cwd, pid: process.pid, expiresAt: Date.now() + timeoutMs,
    sessionId: params.sessionId, toolCall: params.toolCall, options: params.options };
  const temp = `${requestPath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(request), { mode: 0o600, flag: "wx" });
  fs.renameSync(temp, requestPath);
  try {
    while (!signal?.aborted && Date.now() < request.expiresAt) {
      try {
        const answer = JSON.parse(fs.readFileSync(answerPath, "utf8"));
        if (answer.id === id && answer.sessionId === params.sessionId && params.options.some(option => option.optionId === answer.optionId)) return answer.optionId;
        return null;
      } catch (error) { if (error.code !== "ENOENT") return null; }
      await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, 250);
        signal?.addEventListener("abort", finish, { once: true });
      });
    }
    return null;
  } finally {
    fs.rmSync(requestPath, { force: true });
    fs.rmSync(answerPath, { force: true });
  }
}
export function pendingAcpPermissions() {
  try {
    return fs.readdirSync(directory()).filter(name => name.endsWith(".request.json")).flatMap(name => {
      try {
        const request = JSON.parse(fs.readFileSync(path.join(directory(), name), "utf8"));
        return safeId(request.id) && request.expiresAt > Date.now() && alive(request.pid)
          && !fs.existsSync(path.join(directory(), `${request.id}.answer.json`)) ? [request] : [];
      } catch { return []; }
    });
  } catch { return []; }
}
export function answerAcpPermission(id, optionId) {
  if (!safeId(id)) return false;
  const request = pendingAcpPermissions().find(entry => entry.id === id);
  if (!request || (optionId !== null && !request.options.some(option => option.optionId === optionId))) return false;
  fs.writeFileSync(path.join(directory(), `${id}.answer.json`), JSON.stringify({ id, sessionId: request.sessionId, optionId }), { mode: 0o600, flag: "wx" });
  return true;
}
