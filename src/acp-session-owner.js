import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { configDir } from "./config.js";
import { withJsonLockStrict } from "./state-lock.cjs";
import { atomicWriteJsonSync } from "./atomic-json.cjs";

function ownerPath(provider, sessionId) {
  return path.join(configDir(), "acp-sessions", createHash("sha256").update(`${provider}:${sessionId}`).digest("hex") + ".json");
}
function read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
export function acpSessionOwner(provider, sessionId) {
  const row = read(ownerPath(provider, sessionId));
  return row?.provider === provider && row.sessionId === sessionId && (alive(row.pid) || alive(row.adapterPid)) ? row : null;
}

// The daemon and the pill are separate processes. A process-local map cannot
// prevent them from resuming the same provider transcript at the same time.
export function claimAcpSession(provider, sessionId, cwd) {
  const file = ownerPath(provider, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const row = { provider, sessionId, cwd, pid: process.pid, token: randomUUID(), state: "active", startedAt: Date.now() };
  const mutate = fn => {
    const locked = withJsonLockStrict(file, fn);
    if (!locked.ok) throw new Error(`Could not lock the ACP session owner: ${locked.reason}`);
    return locked.value;
  };
  mutate(() => {
    if (acpSessionOwner(provider, sessionId)) throw new Error("This native session already has a Relay ACP owner");
    atomicWriteJsonSync(file, row);
  });
  let released = false;
  return {
    setAdapterPid(pid) {
      if (released || !Number.isInteger(pid) || pid <= 0) return;
      mutate(() => {
        if (read(file)?.token !== row.token) throw new Error("The ACP session owner changed");
        row.adapterPid = pid;
        atomicWriteJsonSync(file, row);
      });
    },
    setState(state) {
      if (released) return;
      mutate(() => {
        if (read(file)?.token !== row.token) throw new Error("The ACP session owner changed");
        row.state = state;
        atomicWriteJsonSync(file, row);
      });
    },
    release() {
      if (released) return;
      mutate(() => { if (read(file)?.token === row.token) fs.rmSync(file, { force: true }); });
      released = true;
    },
  };
}
