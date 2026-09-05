// The send outbox: a message you have typed is COMMITTED, not attempted.
//
// Before this, the composer awaited the network. `sendReplyFromPill` made one
// HTTP attempt with a 15s abort, and on any failure the renderer deleted the
// optimistic bubble and pushed the words back into the textarea. On a weak or
// absent connection that is exactly what a person sees: the message says
// "Sending…" for fifteen seconds, disappears, and reappears as an unsent draft
// under the cursor (David, Granular group, 2026-08-20). Nothing was lost, but
// the message did not send itself when the connection came back — the human had
// to notice and press Send again.
//
// Every messenger a person has ever used works the other way. Pressing Send
// hands the words to the device, the device owes you the delivery, and the
// ladder of states — waiting on this device, accepted by the server, routed to
// the recipient, read — is reported honestly while that happens. This module is
// the "device owes you the delivery" half.
//
// WHY THIS IS SAFE TO RETRY. Every entry carries the idempotency key minted when
// the human pressed Send, and the API keys sends on it — including group fan-out,
// where each sibling derives `<key>:<targetKey>`. A retry after a lost response
// therefore converges on the relay the first attempt already created instead of
// posting a second copy. Retrying without that guarantee would trade a bounced
// draft for duplicate messages, which is worse.
//
// CommonJS so the CJS Electron main process requires it directly, the same way
// it already shares atomic-json.cjs and state-lock.cjs with the ESM daemon.

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { atomicWriteJsonSync } = require("./atomic-json.cjs");
const { withJsonLock } = require("./state-lock.cjs");

const OUTBOX_VERSION = 1;

// Attempt spacing. The first retry is quick because the commonest failure is a
// two-second wifi hiccup; the tail is slow because the next commonest is a
// closed laptop lid in a tunnel, and a queue that retries a dead network every
// second is a battery bug. There is deliberately NO attempt ceiling: "it sends
// when you are back online" has to hold for an overnight flight too.
const BACKOFF_MS = Object.freeze([1_000, 3_000, 8_000, 20_000, 45_000, 90_000, 180_000]);
const BACKOFF_CAP_MS = 300_000;

// How long a delivered-but-unconfirmed entry is kept before the queue lets it
// go. Generous enough that the Sent listing has had every chance to name it.
const RETIRE_SENT_AFTER_MS = 60 * 60 * 1000;

// The error vocabulary of a connection that is down rather than a request that
// is wrong, measured against undici (which is what both `fetch` and the
// companion's keep-alive client use): no DNS gives TypeError "fetch failed"
// with cause.code ENOTFOUND, a black-holed route gives a TimeoutError from
// AbortSignal.timeout, and a refused port gives TypeError "fetch failed" with
// no cause code at all.
const NETWORK_ERROR_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "EHOSTUNREACH",
  "ENETUNREACH", "ENETDOWN", "EPIPE", "ETIMEDOUT", "EAGAIN",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

// HTTP answers that mean "not now" rather than "not ever".
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 507, 522, 524]);

// How many times a "not now" from the SERVER is taken at its word before the
// message is handed back as failed, with the server's reason. The ladder above
// spans about six minutes; a server still saying no after that is not having a
// moment, and the human is better served by "Not sent" and a Retry button than
// by a bubble that says "Trying again…" for the rest of the day. A dead
// connection has no such ceiling — see the ladder's own note.
const SERVER_DEFERRAL_LIMIT = BACKOFF_MS.length + 1;

/**
 * Is this failure worth waiting out, and on whose clock?
 *
 * Three verdicts:
 *  - "transient": the connection is down. Nobody answered. Wait forever, and
 *    try again the moment anything else proves the network is back.
 *  - "deferred": the server answered and said "not now" (a 5xx, a 429). It is
 *    the server's clock, not the network's: a poll that succeeds a second later
 *    proves nothing about THIS payload, so the backoff stands, and after
 *    SERVER_DEFERRAL_LIMIT attempts the message fails with the server's words.
 *    The case that taught this: a channel send answered 502 because one
 *    member's email fallback could not be sent, was resumed by every Sent poll,
 *    and was retried 908 times in seven hours while the two messages typed
 *    after it never left the device.
 *  - "permanent": the server declined this exact payload. Fail at once.
 *
 * The default is PERMANENT, which looks backwards for a queue whose promise is
 * "keep trying" — but it is the honest default. A connection problem announces
 * itself in the small, closed vocabulary above; anything else carrying an HTTP
 * status is the server declining this exact payload, and retrying a declined
 * payload forever wedges the chat behind a message that can never leave. A
 * permanent verdict does not throw the words away: the entry stays in the
 * outbox as `failed`, still holding its text, and the human is told.
 */
function classifySendError(error) {
  if (!error) return "permanent";
  const status = Number(error.status || error.statusCode || 0);
  if (status) return TRANSIENT_STATUS.has(status) ? "deferred" : "permanent";
  const name = String(error.name || "");
  if (name === "TimeoutError" || name === "AbortError") return "transient";
  if (NETWORK_ERROR_CODES.has(String(error.code || ""))) return "transient";
  const cause = error.cause;
  if (cause && NETWORK_ERROR_CODES.has(String(cause.code || ""))) return "transient";
  // Every undici connect failure surfaces as this exact TypeError, with the
  // real reason demoted to `cause`. Some of those causes carry no code.
  if (name === "TypeError" && /fetch failed|network|socket/i.test(String(error.message || ""))) return "transient";
  return "permanent";
}

/** The delay before attempt number `attempts + 1`. */
function backoffMs(attempts) {
  const index = Math.max(0, Math.trunc(attempts) - 1);
  return index < BACKOFF_MS.length ? BACKOFF_MS[index] : BACKOFF_CAP_MS;
}

/**
 * A wall-clock ISO stamp that keeps its local offset.
 *
 * Same rule as every other *At field the companion writes: a bare Z timestamp
 * read back on a machine in another zone silently retimes the message.
 */
function localIso(ms) {
  const date = new Date(ms);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${String(date.getMilliseconds()).padStart(3, "0")}`
    + `${sign}${pad(offset / 60)}:${pad(offset % 60)}`;
}

/** Age of a stamp the queue wrote, or Infinity if it never wrote one. */
function staleSince(stamp, nowMs = Date.now()) {
  const at = Date.parse(stamp || "");
  return Number.isFinite(at) ? nowMs - at : Infinity;
}

function safeName(name) {
  return String(name || "file").replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "file";
}

/**
 * The conversation an entry belongs to, used only for ORDER. Two messages typed
 * into the same room must land in the order they were typed, so a queued one
 * holds back the ones behind it; a stall in one room must not hold up another.
 */
function chatKeyOf(entry) {
  const r = (entry && entry.recipient) || {};
  return String(
    r.groupId || r.chatId || r.contactId || r.relayUserId || r.email
    || (entry && entry.chat && entry.chat.threadId) || "unaddressed",
  ).trim().toLowerCase();
}

function readStore(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const entries = Array.isArray(raw && raw.entries) ? raw.entries : [];
    return { version: OUTBOX_VERSION, entries: entries.filter((e) => e && e.id) };
  } catch {
    return { version: OUTBOX_VERSION, entries: [] };
  }
}

/**
 * A durable, ordered, idempotent send queue.
 *
 * `send` is injected rather than imported so this file never reaches for a
 * network client, a config file or an Electron API: the pill passes the real
 * transport, and tests pass a fake one.
 */
function createOutbox({
  file,
  send,
  now = () => Date.now(),
  spoolDir,
  onChange = () => {},
  writeStore = atomicWriteJsonSync,
  log = () => {},
  scheduleTimer = setTimeout,
  cancelTimer = clearTimeout,
} = {}) {
  if (!file) throw new Error("createOutbox requires a file path");
  if (typeof send !== "function") throw new Error("createOutbox requires a send function");
  const spool = spoolDir || path.join(path.dirname(file), "outbox-files");

  let store = readStore(file);
  let flushing = null;
  let timer = null;
  let stopped = false;

  function persist() {
    withJsonLock(file, () => {
      writeStore(file, { version: OUTBOX_VERSION, entries: store.entries });
    });
  }

  function changed() {
    persist();
    try { onChange(list()); } catch (error) { log("outbox onChange failed", error); }
  }

  function list() {
    return store.entries.map((entry) => ({ ...entry }));
  }

  function entryDir(id) {
    return path.join(spool, String(id).replace(/[^A-Za-z0-9_.-]/g, "_"));
  }

  /**
   * Copy the attachment bytes somewhere the queue owns.
   *
   * A queued send may outlive the temp file a paste wrote, the Downloads item a
   * drag pointed at, or the app itself. The queue cannot promise to deliver a
   * message whose payload it does not hold, so it takes its own copy and
   * deletes it when the entry retires.
   */
  function spoolFiles(id, files) {
    const staged = [];
    const dir = entryDir(id);
    try {
      files.forEach((f, index) => {
        if (!f) throw new Error(`attachment ${index + 1} is missing`);
        const name = safeName(f.name);
        const target = path.join(dir, `${index}-${name}`);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (f.path) fs.copyFileSync(String(f.path), target);
        else if (f.contentBase64) fs.writeFileSync(target, Buffer.from(String(f.contentBase64), "base64"), { mode: 0o600 });
        else throw new Error(`${name} has no readable bytes`);
        staged.push({
          name: f.name || name,
          size: Number(f.size || 0) || fs.statSync(target).size,
          ...(f.contentType ? { contentType: String(f.contentType) } : {}),
          spoolPath: target,
        });
      });
      return staged;
    } catch (error) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
      const failed = files[staged.length];
      const name = safeName(failed && failed.name);
      log(`outbox could not spool ${name}`, error);
      throw new Error(`Could not attach ${name}: ${(error && error.message) || String(error)}`);
    }
  }

  function releaseFiles(entry) {
    if (!entry || !Array.isArray(entry.files) || !entry.files.length) return;
    try { fs.rmSync(entryDir(entry.id), { recursive: true, force: true }); } catch {}
  }

  /**
   * Commit a message to the device. Returns the entry AFTER it is on disk, so a
   * caller that paints from the return value is painting something that already
   * survives a crash.
   */
  function enqueue(input = {}) {
    const idempotencyKey = String(input.idempotencyKey || "").trim();
    if (!idempotencyKey) throw new Error("enqueue requires an idempotencyKey");
    const existing = store.entries.find((e) => e.idempotencyKey === idempotencyKey);
    if (existing) return { ...existing };
    const at = now();
    const entry = {
      id: idempotencyKey,
      idempotencyKey,
      state: "queued",
      createdAt: localIso(at),
      attempts: 0,
      nextAttemptAt: at,
      lastError: "",
      text: String(input.text || ""),
      ...(input.protocolBody ? { protocolBody: input.protocolBody, protocolHash: input.protocolHash } : {}),
      agentMentions: Array.isArray(input.agentMentions)
        ? input.agentMentions.slice(0, 4).map((mention) => ({
            provider: mention && mention.provider === "claude" ? "claude" : "codex",
            start: Number(mention && mention.start),
            end: Number(mention && mention.end),
            token: String((mention && mention.token) || ""),
          }))
        : undefined,
      recipient: input.recipient && typeof input.recipient === "object" ? input.recipient : {},
      inReplyToRelayId: String(input.inReplyToRelayId || ""),
      title: String(input.title || ""),
      files: spoolFiles(idempotencyKey, Array.isArray(input.files) ? input.files : []),
      chat: input.chat && typeof input.chat === "object" ? input.chat : {},
      relayId: "",
      groupSendId: "",
      threadId: String((input.chat && input.chat.threadId) || ""),
    };
    store.entries.push(entry);
    changed();
    return { ...entry };
  }

  function update(id, patch) {
    const entry = store.entries.find((e) => e.id === id);
    if (!entry) return null;
    Object.assign(entry, patch);
    return entry;
  }

  /** Forget an entry (and its spooled bytes) once its canonical relay exists. */
  function retire(id) {
    const index = store.entries.findIndex((e) => e.id === id);
    if (index < 0) return false;
    releaseFiles(store.entries[index]);
    store.entries.splice(index, 1);
    changed();
    return true;
  }

  /**
   * Retire every entry whose canonical relay is now in the Sent projection.
   *
   * Retirement is deliberately driven by the SERVER's view rather than by our
   * own success return: that is the same evidence the renderer uses to retire
   * an optimistic bubble, so the queued row and the real row can never both be
   * on screen, and a success we recorded but the server did not keep cannot
   * quietly vanish from the queue.
   */
  function retireConfirmed({ relayIds = [], groupSendIds = [] } = {}) {
    const ids = new Set([...relayIds].map(String).filter(Boolean));
    const sends = new Set([...groupSendIds].map(String).filter(Boolean));
    const survivors = [];
    let dropped = 0;
    for (const entry of store.entries) {
      const confirmed = entry.state === "sent"
        && ((entry.relayId && ids.has(String(entry.relayId)))
          || (entry.groupSendId && sends.has(String(entry.groupSendId))))
        // A `sent` entry the Sent projection never names has still been
        // ACCEPTED by the server — that is what earned it the state. Holding it
        // forever on the chance the listing catches up is how a queue file
        // grows without bound; the room already stops painting it the moment
        // the canonical row lands.
        || (entry.state === "sent" && staleSince(entry.sentAt, now()) > RETIRE_SENT_AFTER_MS);
      if (!confirmed) { survivors.push(entry); continue; }
      releaseFiles(entry);
      dropped += 1;
    }
    if (!dropped) return 0;
    store.entries = survivors;
    changed();
    return dropped;
  }

  /** Put a failed entry back in line — the human pressed Retry. */
  function retry(id) {
    const entry = store.entries.find((e) => e.id === id);
    if (!entry || entry.state === "sent") return false;
    entry.state = "queued";
    entry.attempts = 0;
    entry.nextAttemptAt = now();
    entry.lastError = "";
    entry.waitingOn = "";
    changed();
    kick(0);
    return true;
  }

  async function attempt(entry) {
    entry.attempts += 1;
    try {
      const result = await send({ ...entry });
      update(entry.id, {
        state: "sent",
        sentAt: localIso(now()),
        lastError: "",
        relayId: String((result && (result.relayId || result.id)) || ""),
        groupSendId: String((result && result.groupSendId) || ""),
        threadId: String((result && result.threadId) || entry.threadId || ""),
      });
      changed();
      return "sent";
    } catch (error) {
      const kind = classifySendError(error);
      const message = (error && error.message) || String(error);
      const exhausted = kind === "deferred" && entry.attempts >= SERVER_DEFERRAL_LIMIT;
      if (kind === "permanent" || exhausted) {
        update(entry.id, { state: "failed", lastError: message, waitingOn: "", failedAt: localIso(now()) });
        changed();
        log(exhausted
          ? `outbox send deferred ${entry.attempts} times, giving up (${message})`
          : `outbox send rejected (${message})`);
        return "failed";
      }
      update(entry.id, {
        state: "queued",
        lastError: message,
        // Whose clock the wait is on. resume() may cut a network wait short;
        // a server deferral runs its full course.
        waitingOn: kind === "deferred" ? "server" : "network",
        nextAttemptAt: now() + backoffMs(entry.attempts),
      });
      changed();
      return "waiting";
    }
  }

  /**
   * One pass over everything due. Serialized: a burst of five messages typed
   * offline must reach the server in the order they were typed, not in whatever
   * order five parallel sockets happen to finish.
   */
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      const blocked = new Set();
      // Snapshot the ids, not the objects: an attempt writes the store.
      for (const id of store.entries.map((e) => e.id)) {
        if (stopped) break;
        const entry = store.entries.find((e) => e.id === id);
        if (!entry || entry.state !== "queued") continue;
        const key = chatKeyOf(entry);
        // A message still waiting on the network holds back only the messages
        // behind it IN ITS OWN ROOM. A permanently failed one blocks nothing:
        // one rejected message must never wedge a conversation forever.
        if (blocked.has(key)) continue;
        if (entry.nextAttemptAt > now()) { blocked.add(key); continue; }
        const outcome = await attempt(entry);
        if (outcome === "waiting") blocked.add(key);
      }
    })().finally(() => {
      flushing = null;
      if (!stopped) arm();
    });
    return flushing;
  }

  /** Wake exactly when the earliest waiting entry comes due — no idle polling. */
  function arm() {
    if (timer) { cancelTimer(timer); timer = null; }
    if (stopped) return;
    const due = store.entries
      .filter((e) => e.state === "queued")
      .map((e) => Number(e.nextAttemptAt) || 0);
    if (!due.length) return;
    const wait = Math.max(0, Math.min(...due) - now());
    timer = scheduleTimer(() => { timer = null; flush().catch(() => {}); }, wait);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function kick(delay = 0) {
    if (stopped) return;
    if (delay > 0) { arm(); return; }
    flush().catch(() => {});
  }

  /**
   * Fresh evidence that the network is back — drop the backoff and try now.
   *
   * Backoff is a guess about a connection nobody can see. Once something else
   * has just succeeded against the API, the guess is superseded: a message must
   * not sit for another five minutes because its last attempt happened to fail
   * during the outage.
   *
   * Only a NETWORK wait is a guess. A message the server itself deferred is
   * waiting on the server's clock, and the Sent poll that calls this every few
   * seconds is no evidence about that: waking it here is what turned one 502
   * into an attempt every twenty seconds for seven hours.
   */
  function resume() {
    if (stopped) return 0;
    let woken = 0;
    for (const entry of store.entries) {
      if (entry.state !== "queued") continue;
      if (entry.waitingOn === "server") continue;
      entry.nextAttemptAt = now();
      woken += 1;
    }
    if (woken) kick(0);
    return woken;
  }

  function start() {
    stopped = false;
    // Anything left queued by a previous run is due immediately: the commonest
    // reason the app restarted is that the machine woke up somewhere else.
    resume();
    kick(0);
  }

  function stop() {
    stopped = true;
    if (timer) { cancelTimer(timer); timer = null; }
  }

  /** Reload from disk (another process, or a test, wrote the file). */
  function reload() {
    store = readStore(file);
    return list();
  }

  function pendingCount() {
    return store.entries.filter((e) => e.state === "queued").length;
  }

  return {
    enqueue, list, flush, retire, retireConfirmed, retry, start, stop, reload,
    resume, pendingCount, kick,
  };
}

module.exports = {
  createOutbox,
  classifySendError,
  backoffMs,
  chatKeyOf,
  localIso,
  BACKOFF_MS,
  BACKOFF_CAP_MS,
  SERVER_DEFERRAL_LIMIT,
  OUTBOX_VERSION,
};
