// `relay channel` — EXPERIMENTAL Claude Code channel server.
//
// This is the real fix for "Open in Current Chat must wake an idle chat".
// Hook-file injection (claude-inject.cjs) can only deliver when the session
// takes a turn on its own; a channel event is the platform's supported way to
// PUSH into a running session — an idle session takes a turn on it (docs:
// channels-reference, notifications/claude/channel). Sessions opt in at start:
//   claude --channels server:relay            (registered in .mcp.json), or
//   claude --dangerously-load-development-channels server:relay   (dev)
// Whether Claude Code Desktop threads can enable channels is still an open
// platform question; terminal sessions work today.
//
// Protocol with the pill/daemon (filesystem, same discipline as claude-inject):
//   RELAY_HOME/channel-queue/<name>.json — one event per file:
//     { content: string, meta?: object, createdAt: ISO }
//   Consume-once via rename-first, so N live channel instances deliver an
//   event exactly once fleet-wide (first rename wins; losers stay silent).
//   RELAY_HOME/channel-instances/<pid>.json — presence heartbeat so the pill
//   knows a wake-capable session exists before preferring this path.
//
// The event content is an INSTRUCTION built by the same sanitized builders as
// hook injection (relay body is never inlined; the model fetches via MCP tools).

import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { storeDir } from "./host-paths.js";

const QUEUE_DIR = "channel-queue";
const PRESENCE_DIR = "channel-instances";
const POLL_MS = 700; // fs.watch is unreliable across atomic renames; poll cheaply
const PRESENCE_MS = 15_000;

export function channelQueueDir(homeDir = storeDir()) {
  return path.join(homeDir, QUEUE_DIR);
}

export function channelPresenceDir(homeDir = storeDir()) {
  return path.join(homeDir, PRESENCE_DIR);
}

// Drop one event for whichever live channel session claims it first.
export function enqueueChannelEvent(homeDir, { content, meta = {}, targetCliPid = null } = {}) {
  const text = String(content || "").trim();
  if (!text) throw new Error("enqueueChannelEvent requires content");
  const dir = channelQueueDir(homeDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `evt-${Date.now()}-${process.pid}-${Math.floor(Math.random() * 1e6)}.json`);
  const tmp = `${file}.tmp`;
  // targetCliPid addresses ONE chat: only the pump running inside that CLI
  // process claims it. Null means "any live session" (the broadcast case).
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ content: text, meta, targetCliPid: Number(targetCliPid) || null, createdAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  fs.renameSync(tmp, file);
  return file;
}

// How many channel instances heartbeated recently. The pill prefers the wake
// path only when EXACTLY ONE live instance exists: queue events are claimed by
// whichever instance renames first, so with several live sessions the event
// could wake a different chat than the one the user is looking at — hook
// staging (session-targeted) stays the correct route until per-session
// channel targeting exists.
export function countLiveChannelInstances(homeDir = storeDir(), { maxAgeMs = PRESENCE_MS * 3, nowMs = Date.now() } = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(channelPresenceDir(homeDir));
  } catch {
    return 0;
  }
  let live = 0;
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const row = JSON.parse(fs.readFileSync(path.join(channelPresenceDir(homeDir), name), "utf8"));
      if (nowMs - (Number(row.heartbeatAt) || 0) <= maxAgeMs) live += 1;
    } catch {}
  }
  return live;
}

// True when at least one channel instance heartbeated recently — the pill uses
// this to decide whether a wake-capable session exists at all.
export function channelInstanceAlive(homeDir = storeDir(), opts = {}) {
  return countLiveChannelInstances(homeDir, opts) > 0;
}

// The single live channel instance matching a session's working directory, or
// null. "Current chat" means the chat the user is looking at: the wake tier
// must fire only when the channel session IS the resolved target, and the only
// join available today is cwd (channel presence records its process cwd; hook
// rendezvous records the session's). One instance per cwd; ambiguity -> null.
export function liveChannelInstanceForCwd(homeDir = storeDir(), cwd, { maxAgeMs = PRESENCE_MS * 3, nowMs = Date.now() } = {}) {
  const wanted = String(cwd || "").replace(/\/+$/, "");
  if (!wanted) return null;
  let entries = [];
  try {
    entries = fs.readdirSync(channelPresenceDir(homeDir));
  } catch {
    return null;
  }
  const matches = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const row = JSON.parse(fs.readFileSync(path.join(channelPresenceDir(homeDir), name), "utf8"));
      if (nowMs - (Number(row.heartbeatAt) || 0) > maxAgeMs) continue;
      if (String(row.cwd || "").replace(/\/+$/, "") === wanted) matches.push(row);
    } catch {}
  }
  return matches.length === 1 ? matches[0] : null;
}

function consumeEventFile(file) {
  const claimed = `${file}.${process.pid}.claimed`;
  try {
    fs.renameSync(file, claimed); // exactly-once across instances
  } catch {
    return null;
  }
  let payload = null;
  try {
    payload = JSON.parse(fs.readFileSync(claimed, "utf8"));
  } catch {
    payload = null;
  }
  try {
    fs.rmSync(claimed, { force: true });
  } catch {}
  return payload && typeof payload === "object" ? payload : null;
}

// Claim every queued event for this process, oldest first. Consume-once via
// rename, so with several live sessions each event wakes exactly one of them
// instead of every one — the same discipline the hook injections use.
// A pump announces itself by cliPid so the pill can tell, before staging
// anything, whether THIS chat can actually be woken. Without a live beacon the
// pill must fall back to hook injection (which only lands on the chat's next
// turn) rather than promising a wake that will never come.
export function writeChannelBeacon(homeDir = storeDir(), cliPid, { nowMs = Date.now() } = {}) {
  const pid = Number(cliPid) || 0;
  if (!pid) return null;
  const dir = channelPresenceDir(homeDir);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `cli-${pid}.json`);
    fs.writeFileSync(file, `${JSON.stringify({ cliPid: pid, pid: process.pid, heartbeatAt: nowMs })}\n`, { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

/** Can a channel wake reach the chat owned by `cliPid` right now? */
export function channelWakeAvailable(homeDir = storeDir(), cliPid, { maxAgeMs = 45_000, nowMs = Date.now() } = {}) {
  const pid = Number(cliPid) || 0;
  if (!pid) return false;
  try {
    const row = JSON.parse(fs.readFileSync(path.join(channelPresenceDir(homeDir), `cli-${pid}.json`), "utf8"));
    return nowMs - (Number(row.heartbeatAt) || 0) <= maxAgeMs;
  } catch {
    return false;
  }
}

export function drainChannelEvents(homeDir = storeDir(), { cliPid = null } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(channelQueueDir(homeDir)).filter((n) => n.startsWith("evt-") && n.endsWith(".json"));
  } catch {
    return [];
  }
  names.sort();
  const claimed = [];
  for (const name of names) {
    const file = path.join(channelQueueDir(homeDir), name);
    // Peek before claiming: an event addressed to a DIFFERENT chat must be left
    // for that chat's pump. Claiming-then-requeueing would race.
    let addressed = null;
    try {
      addressed = Number(JSON.parse(fs.readFileSync(file, "utf8")).targetCliPid) || null;
    } catch {
      addressed = null;
    }
    if (addressed && cliPid && addressed !== cliPid) continue;
    const payload = consumeEventFile(file);
    if (payload) claimed.push(payload);
  }
  return claimed;
}

export async function runChannelServer({ homeDir = storeDir(), log = (m) => console.error(`[relay-channel] ${m}`) } = {}) {
  const server = new Server(
    { name: "relay-channel", version: "0.1.0" },
    // The experimental channel capability is what lets notifications push into
    // the session; no tools are exposed (the relay MCP server already serves
    // tools — this process exists ONLY to wake the session with events).
    { capabilities: { experimental: { "claude/channel": {} } } },
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`connected; watching ${channelQueueDir(homeDir)}`);

  const presencePath = path.join(channelPresenceDir(homeDir), `${process.pid}.json`);
  const heartbeat = () => {
    try {
      fs.mkdirSync(channelPresenceDir(homeDir), { recursive: true, mode: 0o700 });
      fs.writeFileSync(presencePath, `${JSON.stringify({ pid: process.pid, cwd: process.cwd(), heartbeatAt: Date.now() })}\n`);
    } catch {}
  };
  heartbeat();
  const presenceTimer = setInterval(heartbeat, PRESENCE_MS);
  if (presenceTimer.unref) presenceTimer.unref();

  const pump = async () => {
    let names = [];
    try {
      names = fs.readdirSync(channelQueueDir(homeDir)).filter((n) => n.startsWith("evt-") && n.endsWith(".json"));
    } catch {
      return;
    }
    names.sort(); // oldest first (timestamp-prefixed names)
    for (const name of names) {
      const payload = consumeEventFile(path.join(channelQueueDir(homeDir), name));
      if (!payload) continue;
      try {
        await server.notification({
          method: "notifications/claude/channel",
          params: { content: String(payload.content || ""), meta: payload.meta || {} },
        });
        log(`pushed event ${name}`);
      } catch (error) {
        log(`push failed for ${name}: ${error && error.message}`);
      }
    }
  };
  const pumpTimer = setInterval(() => void pump(), POLL_MS);
  if (pumpTimer.unref) pumpTimer.unref();
  void pump();

  const cleanup = () => {
    try {
      fs.rmSync(presencePath, { force: true });
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  return { server, pump };
}
