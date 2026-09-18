"use strict";

// The Sent side's live wake. Seen / Started / Done on what YOU sent are
// receipts on the Sent list, which the pill otherwise re-fetches on a timer
// (5 s while you are clicking it, 30 s idle — visibility.cjs). The daemon's
// inbox receiver already holds the server's account-change cursor open, and
// the server bumps that cursor for the SENDER too: a recipient's read and
// their agent's Task start/finish update the relays row, whose trigger
// touches both accounts (apps/api/drizzle/0055). Holding the same cursor
// here turns those receipts into a fetch within a second instead of
// whenever the timer next falls (David, 2026-09-17: "seen / started only
// update when I minimise the pill and reopen").
//
// Pure loop: no Electron, no network of its own, so the backoff and cursor
// rules are unit-testable. `wait(since, signal)` is RelayClient's
// waitForAccountChange; `onChange()` is whatever refreshes the Sent list.
function startSentLiveWake({
  wait,
  onChange,
  isCurrent = () => true,
  log = () => {},
  retryMs = 1000,
  maxRetryMs = 30_000,
  unsupportedRetryMs = 60_000,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof wait !== "function" || typeof onChange !== "function") {
    throw new Error("startSentLiveWake needs wait() and onChange()");
  }
  let stopped = false;
  let cursor;
  const controller = new AbortController();
  const active = () => !stopped && isCurrent();
  const sleep = (ms) => new Promise((resolve) => {
    if (!active()) return resolve();
    const done = () => { clearTimeoutImpl(timer); controller.signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeoutImpl(done, ms);
    controller.signal.addEventListener("abort", done, { once: true });
  });
  const loop = (async () => {
    let delay = retryMs;
    while (active()) {
      try {
        const event = await wait(cursor, controller.signal);
        if (!active()) return;
        if (!event || !/^\d+$/.test(String(event.version)) || typeof event.changed !== "boolean") {
          throw new Error("Invalid account change response");
        }
        // The first answer only seeds the cursor: the Sent list was fetched at
        // boot, and a change between that fetch and this seed is caught by the
        // timer pass rather than by a redundant fetch now.
        if (cursor !== undefined && event.changed) {
          try { await onChange(event); }
          catch (error) {
            // A failed fetch must not swallow the change: keep the old cursor
            // so the server answers `changed` again once the network is back.
            if (!active()) return;
            log(`sent live refresh failed: ${error.message}`);
            await sleep(delay);
            delay = Math.min(delay * 2, maxRetryMs);
            continue;
          }
        }
        cursor = event.version;
        delay = retryMs;
      } catch (error) {
        if (!active() || controller.signal.aborted) return;
        log(`sent live connection unavailable: ${error.message}; timer refresh continues`);
        await sleep([404, 405].includes(error.status) ? unsupportedRetryMs : delay);
        delay = Math.min(delay * 2, maxRetryMs);
      }
    }
  })();
  return {
    loop,
    get cursor() { return cursor; },
    stop() { stopped = true; controller.abort(); },
  };
}

module.exports = { startSentLiveWake };
