// Evidence that the ordinary inbox is actually being received, not only that
// the service process is alive. The daemon's heartbeat (recovery-health.js) is
// written by its main thread; messages are received by a worker thread
// (inbox-receiver-worker.js). A worker that silently stopped receiving left the
// heartbeat healthy for 18 hours on a person's Mac (ao1, 2026-10-08), so the pill
// trusted a stale local copy and the history people had already read vanished.
// The worker writes this file; the pill judges it (pill-liveness.cjs
// inboxReceiveDecision) and reads rooms from the server while it is not fresh.
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const { write } = createRequire(import.meta.url)("../bootstrap/recovery-launcher.cjs");

export function inboxHealthPath(homeDir = os.homedir()) {
  return path.join(homeDir, ".relay", "recovery", "inbox.json");
}

export function createInboxHealth({ homeDir = os.homedir(), now = Date.now, writeFile = write, log = () => {},
  pid = process.pid, minWriteMs = 5000 } = {}) {
  const file = inboxHealthPath(homeDir);
  const state = { schema: 1, pid, state: "starting", reason: "", okAt: 0, failingSince: 0 };
  let lastWriteAt = 0;
  const flush = (changed) => {
    const at = now();
    if (!changed && at - lastWriteAt < minWriteMs) return;
    lastWriteAt = at;
    try { writeFile(file, { ...state, at }); } catch {}
  };
  const move = (next, reason = "") => {
    const changed = state.state !== next || state.reason !== reason;
    if (changed && next !== "receiving") log(`inbox receiver ${next}${reason ? `: ${reason}` : ""}`);
    if (changed && next === "receiving" && state.state !== "starting") log("inbox receiver receiving again");
    state.state = next;
    state.reason = reason;
    return changed;
  };
  return {
    file,
    snapshot: () => ({ ...state }),
    received() {
      const changed = move("receiving");
      state.okAt = now();
      state.failingSince = 0;
      flush(changed);
    },
    failed(reason = "refresh-failed") {
      const changed = move("failing", String(reason).slice(0, 200));
      if (!state.failingSince) state.failingSince = now();
      flush(changed);
    },
    unbound(reason) {
      flush(move("unbound", String(reason || "").slice(0, 200)));
    },
  };
}
