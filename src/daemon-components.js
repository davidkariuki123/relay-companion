// Optional components run independently. A hung component remains in flight:
// never launch overlapping work or replay its external effects on a timeout.
export function createDaemonComponents({ health, log = () => {}, now = Date.now, stalledMs = 60_000 } = {}) {
  const active = new Map();
  return {
    inspect() {
      for (const [name, pending] of active) if (now() - pending.startedAt >= stalledMs) health?.component(name, "stalled");
    },
    disable(name) { if (!active.has(name)) health?.component(name, "disabled"); },
    run(name, operation) {
      const pending = active.get(name);
      if (pending) {
        if (now() - pending.startedAt >= stalledMs) health?.component(name, "stalled");
        return pending.promise;
      }
      const entry = { startedAt: now() };
      active.set(name, entry);
      entry.promise = Promise.resolve().then(operation).then(
        () => health?.component(name, "ok"),
        error => { health?.component(name, "failed"); log(`${name} failed: ${error?.message || error}`); },
      ).finally(() => active.delete(name));
      return entry.promise;
    },
  };
}
