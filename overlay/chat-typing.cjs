(function install(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RelayChatTyping = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  const POLL_MS = 1500, HEARTBEAT_MS = 2000, IDLE_MS = 3000, LEASE_MS = 6000;

  function labelFor(people) {
    const names = people.map((person) => String(person.name || "Someone").trim() || "Someone");
    const firsts = names.map((name) => name.split(/\s+/)[0]);
    const labels = names.map((name, i) => firsts.filter((first) => first === firsts[i]).length > 1 ? name : firsts[i]);
    if (!labels.length) return "";
    if (labels.length === 1) return `${labels[0]} is typing`;
    if (labels.length === 2) return `${labels[0]} and ${labels[1]} are typing`;
    return `${labels[0]}, ${labels[1]} + ${labels.length - 2} are typing`;
  }

  /** Independent presence lifecycle: never repaints a chat or touches focus.
   * The transport serializes writes; generations fence late reads and timers. */
  function createController({ read, write, onChange, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    let context = null, generation = 0, pollTimer, expiryTimer, idleTimer;
    let localTyping = false, lastWrite = -Infinity, remote = [], failures = 0;
    let writeQueue = Promise.resolve();
    const send = (target, typing) => {
      if (!target) return;
      writeQueue = writeQueue.catch(() => {}).then(() => write(target, typing)).catch(() => {});
    };
    function paint() {
      clearTimer(expiryTimer);
      remote = remote.filter((person) => person.until > now());
      onChange(remote);
      if (remote.length) expiryTimer = setTimer(paint, Math.max(1, Math.min(...remote.map((p) => p.until)) - now()));
    }
    function stop() {
      clearTimer(idleTimer);
      if (localTyping) send(context, false);
      localTyping = false;
      lastWrite = -Infinity;
    }
    async function poll(epoch) {
      const target = context, started = now();
      try {
        const result = await read(target);
        if (epoch !== generation) return;
        if (!result?.ok || result.chatId !== target.chatId) throw new Error("Presence unavailable");
        failures = 0;
        const people = new Map();
        for (const person of result.participants || []) {
          const lease = Math.max(0, Math.min(LEASE_MS, Number(person.expiresInMs) || 0));
          if (person.id) people.set(person.id, { ...person, until:started + lease });
        }
        remote = [...people.values()];
        paint();
      } catch {
        if (epoch !== generation) return;
        failures += 1;
        remote = [];
        paint();
      }
      if (epoch === generation) pollTimer = setTimer(() => poll(epoch), Math.min(30_000, POLL_MS * 2 ** Math.min(failures, 5)));
    }
    return {
      setContext(next) {
        const key = (value) => value ? JSON.stringify([value.account, value.chatId, value.peerEmail || ""]) : "";
        if (key(next) === key(context)) return;
        stop();
        generation += 1;
        clearTimer(pollTimer);
        clearTimer(expiryTimer);
        context = next;
        remote = [];
        failures = 0;
        paint();
        if (context) void poll(generation);
      },
      input(hasText) {
        if (!context || !hasText) { stop(); return; }
        if (!localTyping || now() - lastWrite >= HEARTBEAT_MS) {
          localTyping = true;
          lastWrite = now();
          send(context, true);
        }
        clearTimer(idleTimer);
        idleTimer = setTimer(stop, IDLE_MS);
      },
      stop,
      destroy() { this.setContext(null); },
    };
  }
  return { createController, labelFor, POLL_MS, HEARTBEAT_MS, IDLE_MS, LEASE_MS };
});
