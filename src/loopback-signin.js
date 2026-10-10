// Same-device sign-in handoff (RFC 8252 §7.3 loopback redirect).
//
// While a browser sign-in is open, the main process listens on 127.0.0.1 on an
// ephemeral port. After Google sign-in the website navigates the browser
// (top-level navigation, never fetch, so no Private Network Access prompt) to
// http://127.0.0.1:<port>/relay/signin-complete?code=…&state=…. Only a process
// on this machine can receive that request, which is what proves the browser
// that signed in is on the same computer as this app. The code is useless
// without this app's client secret and PKCE verifier, so the listener hands it
// straight to the authorization controller and answers the browser with a
// small page.
//
// The listener binds loopback only, accepts exactly one valid callback, checks
// the Host header (DNS rebinding) and the state (timing-safe), never serves
// anything else, and closes itself after the callback or its timeout.

import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const LOOPBACK_HOST = "127.0.0.1";
export const LOOPBACK_CALLBACK_PATH = "/relay/signin-complete";
export const LOOPBACK_DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const CODE_PATTERN = /^ilc_[A-Za-z0-9_-]{32,128}$/;
const MAX_REJECTED_REQUESTS = 50;
const CALLBACK_RESPONSE_TIMEOUT_MS = 20_000;

function sameText(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}

function deviceWord(platform) {
  return platform === "win32" ? "PC" : platform === "linux" ? "computer" : "Mac";
}

/** The page the browser shows once Relay has the sign-in. Light and dark, no external resources. */
export function loopbackPage({ title, lines = [] }) {
  const body = lines.filter(Boolean).map((line) => `<p>${escapeHtml(line)}</p>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Relay</title><style>
:root{--bg:#f7f6f3;--card:#fff;--ink:#1d1d1f;--muted:#6e6e73;--line:rgba(0,0,0,.08);--mark:#1d1d1f;--mark-ink:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1f;--ink:#f5f5f7;--muted:#a1a1a6;--line:rgba(255,255,255,.1);--mark:#f5f5f7;--mark-ink:#141414}}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;display:flex;align-items:center;justify-content:center;padding:16px}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:18px;padding:32px 28px;text-align:center}
.mark{width:44px;height:44px;border-radius:50%;background:var(--mark);color:var(--mark-ink);display:inline-flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:18px}
h1{font-size:22px;line-height:1.25;margin:0 0 10px;font-weight:650;letter-spacing:-.01em}p{margin:6px 0 0;color:var(--muted)}
</style></head><body><main><div class="mark" aria-hidden="true">✓</div><h1>${escapeHtml(title)}</h1>${body}</main></body></html>`;
}

export function signedInPage({ platform = process.platform, inviterName = "", orgName = "" } = {}) {
  return loopbackPage({
    title: "You’re signed in.",
    lines: [
      `Relay is open on your ${deviceWord(platform)}.`,
      inviterName ? `${inviterName} is now in your contacts. No message was sent.` : "",
      orgName ? `You joined ${orgName}. No message was sent.` : "",
      "You can close this tab.",
    ],
  });
}

/**
 * Start a one-shot loopback listener.
 * @param {object} options
 * @param {(code: string) => Promise<{ html?: string, redirect?: string }>} options.onCode
 *   Redeem the code. Resolve with the page to show, or a trusted URL to send
 *   the browser to (the website's fallback) when approval did not happen here.
 * @param {string} [options.fallbackUrl] Where to send the browser if onCode throws.
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ redirectUri: string, state: string, port: number, closed: Promise<void>, close: () => Promise<void>, isOpen: () => boolean }>}
 */
export async function startLoopbackSignInListener({
  onCode,
  fallbackUrl = "",
  timeoutMs = LOOPBACK_DEFAULT_TIMEOUT_MS,
  callbackTimeoutMs = CALLBACK_RESPONSE_TIMEOUT_MS,
  createServer = http.createServer,
} = {}) {
  if (typeof onCode !== "function") throw new Error("Loopback sign-in needs a code handler.");
  const state = randomBytes(32).toString("base64url");
  let handled = false;
  let open = true;
  let rejected = 0;
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  let port = 0;
  let lifetime = null;

  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    connection: "close",
  };
  const send = (res, status, html, extra = {}) => {
    res.writeHead(status, { ...headers, "content-type": "text/html; charset=utf-8", ...extra });
    res.end(html);
  };
  const reject = (res, status) => {
    rejected += 1;
    send(res, status, loopbackPage({ title: "Nothing to see here.", lines: ["Return to Relay."] }));
    if (rejected >= MAX_REJECTED_REQUESTS) void close();
  };

  const server = createServer((req, res) => {
    req.on("error", () => {});
    res.on("error", () => {});
    let url;
    try { url = new URL(req.url || "/", `http://${LOOPBACK_HOST}`); } catch { return reject(res, 400); }
    if (req.method !== "GET") return reject(res, 405);
    if (url.pathname !== LOOPBACK_CALLBACK_PATH) return reject(res, 404);
    // A page on another origin that rebinds its DNS name to 127.0.0.1 still
    // sends its own Host header; only the literal loopback address is ours.
    if (String(req.headers.host || "") !== `${LOOPBACK_HOST}:${port}`) return reject(res, 400);
    if (handled) return send(res, 410, loopbackPage({ title: "This sign-in was already used.", lines: ["Return to Relay."] }));
    const code = url.searchParams.get("code") || "";
    if (!sameText(url.searchParams.get("state"), state) || !CODE_PATTERN.test(code)) return reject(res, 400);
    handled = true;
    let timer;
    const timeout = new Promise((_, fail) => { timer = setTimeout(() => fail(new Error("timeout")), callbackTimeoutMs); });
    Promise.race([Promise.resolve().then(() => onCode(code)), timeout])
      .then((result) => {
        if (result?.redirect) send(res, 303, "", { location: result.redirect });
        else send(res, 200, result?.html || signedInPage());
      })
      .catch(() => {
        if (fallbackUrl) send(res, 303, "", { location: fallbackUrl });
        else send(res, 200, loopbackPage({ title: "Finish in Relay.", lines: ["Relay couldn’t confirm this sign-in here. Return to Relay to try again."] }));
      })
      .finally(() => { clearTimeout(timer); res.once("finish", () => void close()); if (res.writableFinished) void close(); });
  });
  server.on("clientError", (_error, socket) => { try { socket.destroy(); } catch {} });

  function close() {
    if (!open) return closed;
    open = false;
    clearTimeout(lifetime);
    // An in-flight callback finishes its response; idle sockets go now.
    server.close(() => resolveClosed());
    server.closeIdleConnections?.();
    return closed;
  }

  await new Promise((resolve, fail) => {
    server.once("error", fail);
    server.listen({ host: LOOPBACK_HOST, port: 0, exclusive: true }, () => { server.off("error", fail); resolve(); });
  });
  port = server.address().port;
  lifetime = setTimeout(() => void close(), Math.max(1000, Number(timeoutMs) || LOOPBACK_DEFAULT_TIMEOUT_MS));
  lifetime.unref?.();
  return {
    redirectUri: `http://${LOOPBACK_HOST}:${port}${LOOPBACK_CALLBACK_PATH}`,
    state,
    port,
    closed,
    close,
    isOpen: () => open,
  };
}
