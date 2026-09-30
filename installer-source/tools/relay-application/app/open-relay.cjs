"use strict";
// One launch owns the CLI result. A ready status left by an older launch is not
// completion, and duplicate OS open events share the same in-flight command.
function createRelayOpener({ launch, isVisible, now = Date.now, timeoutMs = 20_000 }) {
  let pending;
  return function open() {
    if (pending) return pending;
    const since = now();
    pending = Promise.resolve().then(() => new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let timer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve({ opened: true });
      };
      try { child = launch(); } catch (error) { finish(error); return; }
      child.once("error", finish);
      child.once("exit", (code) => {
        if (code !== 0) return finish(new Error(`Relay could not open its pill (exit ${code}).`));
        try {
          if (!isVisible(since)) return finish(new Error("Relay did not confirm a visible pill for this launch."));
          finish();
        } catch (error) { finish(error); }
      });
      timer = setTimeout(() => {
        finish(new Error("Relay timed out opening its pill."));
        // Only the short-lived CLI, never the daemon or the existing pill.
        try { child.kill(); } catch {}
      }, timeoutMs);
    })).finally(() => { pending = null; });
    return pending;
  };
}
module.exports = { createRelayOpener };
