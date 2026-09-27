import os from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const d = require("../bootstrap/diagnostics.cjs");
const reporter = require("../bootstrap/diagnostics-reporter.cjs");
const attempts = new Map();
// Caller supplies the already authenticated identity. No credential copying.
export function provisionDiagnostics({ url, token, userId, deviceId }, { homeDir = os.homedir(), now = Date.now, fetchImpl = fetch } = {}) {
  try {
    const origin = reporter.origin(url), identity = d.configIdentity(homeDir);
    if (!origin || !token?.startsWith("dev_") || !identity || identity.userId !== userId || identity.deviceId !== deviceId) return;
    const saved = d.read(reporter.files(homeDir).auth);
    if (saved?.scope === identity.scope && saved.origin === origin && Date.parse(saved.expiresAt) > now() + 7 * 86400000) return;
    const key = `${origin}:${identity.scope}`, last = attempts.get(key);
    if (last && now() - last < 3600000) return;
    attempts.clear(); attempts.set(key, now());
    void fetchImpl(`${origin}/v1/devices/diagnostics/authorization`, { method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000),
    }).then(async response => {
      if (!response.ok) { await response.body?.cancel?.(); return; }
      const reader = response.body?.getReader();
      if (!reader) return;
      const chunks = []; let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); return; }
        chunks.push(Buffer.from(value));
      }
      const text = Buffer.concat(chunks).toString("utf8");
      reporter.saveAuthorization(JSON.parse(text), { ...identity, origin }, { homeDir, now });
    }).catch(() => {});
  } catch { /* Telemetry cannot break an ordinary request. */ }
}
