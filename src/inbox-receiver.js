// One coalesced receive lane, independent of task/session and attachment work.
// The live cursor wakes it immediately; the bounded poll also covers old APIs,
// missed events, and recovery after sleep. Only one refresh may own the ledger.
export function startInboxReceiver({
  client, refresh, isCurrent = () => true, intervalMs = 4000, log = () => {},
  retryMs = 1000, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
} = {}) {
  let stopped = false;
  let inFlight = null;
  let pending = false;
  let cursor;
  const controller = new AbortController();
  const active = () => !stopped && isCurrent();
  const sleep = (ms) => new Promise((resolve) => {
    if (!active()) return resolve();
    const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    controller.signal.addEventListener("abort", done, { once: true });
  });
  function requestRefresh() {
    if (!active()) return Promise.resolve(false);
    pending = true;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let ok = false;
      while (pending && active()) {
        pending = false;
        try { ok = (await refresh({ isCurrent: active }))?.inboxOk !== false; }
        catch (error) { ok = false; if (active()) log(`inbox refresh failed: ${error.message}`); }
      }
      return ok;
    })().finally(() => { inFlight = null; });
    return inFlight;
  }
  void requestRefresh();
  // Do not accumulate fallback ticks behind a slow refresh. A server event
  // still requests one follow-up pass to catch arrivals during that refresh.
  const timer = setIntervalImpl(() => { if (!inFlight) void requestRefresh(); }, intervalMs);
  const events = (async () => {
    let delay = retryMs;
    while (active() && typeof client.waitForAccountChange === "function") {
      try {
        const event = await client.waitForAccountChange(cursor, controller.signal);
        if (!active()) return;
        if (!event || !/^\d+$/.test(event.version) || typeof event.changed !== "boolean") {
          throw new Error("Invalid account change response");
        }
        // Refresh after initialization too: a message may have landed between
        // the initial inbox read and acquiring the first durable cursor.
        if (cursor === undefined || event.changed) {
          if (!await requestRefresh()) { await sleep(delay); delay = Math.min(delay * 2, 30_000); continue; }
        }
        cursor = event.version;
        delay = retryMs;
      } catch (error) {
        if (!active() || controller.signal.aborted) return;
        log(`inbox live connection unavailable: ${error.message}; polling continues`);
        await sleep([404, 405].includes(error.status) ? 60_000 : delay);
        delay = Math.min(delay * 2, 30_000);
      }
    }
  })();
  return {
    requestRefresh,
    events,
    stop() { stopped = true; pending = false; clearIntervalImpl(timer); controller.abort(); },
  };
}
