// A local rehearsal, not another account or installation. All messages are
// synthetic and stay in this process. The real renderer and protocol helper
// are used; OAuth, installation and delivery are explicitly simulated.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const overlayRoot = path.join(packageRoot, "overlay");
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export async function startOnboardingReview() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-onboarding-review-"));
  fs.chmodSync(root, 0o700);
  const access = `web_review_${randomBytes(24).toString("hex")}`;
  const csrf = randomBytes(24).toString("hex");
  const account = { id: "usr_review_you", userId: "usr_review_you", relayUserId: "usr_review_you", name: "Sam Walker (practice)", email: "you@example.test", paired: true };
  const inviter = { relayUserId: "usr_review_taylor", name: "Taylor Demo", email: "taylor@example.test" };
  let approved = false;
  let completed = false;
  let authorization = null;
  const sent = [];
  const requests = new Map();
  const contacts = [{ id: "review_contact", name: inviter.name, emails: [inviter.email], email: inviter.email, onRelay: true }];
  let base;
  function payload() {
    let protocol = {};
    try { protocol = JSON.parse(fs.readFileSync(path.join(root, "agent-protocol.json"), "utf8")); } catch {}
    const skipped = protocol.tutorial?.state === "skipped";
    return { account, relays: [], sent, contacts, chats: [], outbox: [], features: {},
      ui: { canDismiss: true, onboardingRequired: !completed && !skipped, onboardingVersion: 2,
        completedOnboardingVersion: completed || skipped ? 2 : 0,
        firstRelayStatus: sent.length ? "sent" : "waiting", firstRelayId: sent[0]?.relayId || "",
        openingPreference: protocol.openingPreference || null } };
  }
  const json = (res, data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== new URL(base).host || (req.headers.origin && req.headers.origin !== base)) return json(res, { error: "wrong_origin" }, 403);
      const url = new URL(req.url, base);
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > 150_000) return json(res, { error: "too_large" }, 413); }
      const body = raw && req.headers["content-type"]?.includes("application/json") ? JSON.parse(raw) : {};
      if (url.pathname === "/") {
        const command = `node ${JSON.stringify(path.join(root, "practice-relay.mjs"))}`;
        const prompt = `Help me rehearse Relay onboarding using only the local practice server at ${base}. This is a simulation: do not install anything, change my real Relay connection, or use Relay MCP. Use ${command} as the practice protocol helper. Run connect-start ${base} invite_practice_01234567890123456789 codex (or claude_code in Claude). Let me approve the local practice account in my browser, then run connect-finish. Use your permitted native question interface to let me write my own first message, use the suggested hello, or skip. Show both exact payloads and Taylor Demo as the practice recipient; wait for approval before tutorial-send --approved (add --draft-stdin and the approved JSON for custom wording). Never send automatically. Ask whether I prefer desktop, terminal, or another session, and save with opening-preference. All messages must stay on this local server.`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(`<!doctype html><title>Relay onboarding rehearsal</title><style>body{font:16px system-ui;background:#f6f3ed;color:#241d18;margin:32px}main{display:grid;grid-template-columns:minmax(300px,560px) 540px;gap:32px}textarea{width:100%;height:310px;box-sizing:border-box;padding:16px;font:14px/1.5 monospace}iframe{width:540px;height:780px;border:0;background:white;border-radius:24px}button{padding:10px 18px}p{line-height:1.6}</style><h1>Relay onboarding rehearsal</h1><p><strong>Practice only.</strong> The real pill UI and question flow; simulated account approval and delivery. Nothing reaches your contacts or changes your installation.</p><main><section><h2>Try it yourself</h2><p>Copy this prompt into a new Claude Code or Codex conversation. The agent will guide you through the questions. This page shows the pill as you go.</p><textarea readonly>${escapeHtml(prompt)}</textarea><p>Approve the practice account when the agent opens the local approval page. To start again, stop this rehearsal and run <code>relay review-onboarding</code> again. Each run has its own temporary profile.</p><p>For a real sign-in/install test, use a separate OS account and a fresh Relay account. This rehearsal does not claim to test OAuth or the installer.</p></section><iframe src="/pill" title="Practice Relay pill"></iframe></main>`);
      }
      if (url.pathname === "/approve" || url.pathname === "/connect-agent/review_authorization") {
        if (req.method === "POST" && url.searchParams.get("key") !== csrf) return json(res, { error: "invalid_approval" }, 403);
        if (req.method === "POST") approved = true;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(`<title>Approve practice Relay</title><main style="font:18px system-ui;max-width:520px;margin:80px auto"><h1>Practice account approval</h1><p>This is ${escapeHtml(account.name)}, ${account.email}. No real account is involved.</p>${approved ? "<p>Approved. Return to your agent to continue.</p>" : `<form method="post" action="/approve?key=${csrf}"><button>Approve practice account</button></form>`}</main>`);
      }
      if (url.pathname === "/pill") {
        const bridge = `window.practiceBase=${JSON.stringify(base)};window.practiceAccess=${JSON.stringify(access)};` + fs.readFileSync(path.join(packageRoot, "src/onboarding-review-bridge.js"), "utf8");
        const html = fs.readFileSync(path.join(overlayRoot, "inbox.html"), "utf8").replace("<head>", `<head><base href="/overlay/"><script>${bridge}</script>`);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); return res.end(html);
      }
      if (url.pathname.startsWith("/overlay/")) {
        const file = path.resolve(overlayRoot, decodeURIComponent(url.pathname.slice(9)));
        if (!file.startsWith(overlayRoot + path.sep) || !/\.(js|cjs|css|svg|png|woff2)$/.test(file)) return json(res, {}, 404);
        const type = { ".js": "text/javascript", ".cjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" }[path.extname(file)];
        res.writeHead(200, { "Content-Type": type }); return res.end(fs.readFileSync(file));
      }
      if (url.pathname === "/v1/agent/authorizations" && req.method === "POST") {
        authorization = { clientSecret: randomUUID(), codeChallenge: body.codeChallenge };
        return json(res, { authorizationId: "review_authorization", clientSecret: authorization.clientSecret, approvalUrl: `${base}/connect-agent/review_authorization#approvalToken=${csrf}` });
      }
      if (url.pathname === "/v1/agent/authorizations/review_authorization/consume") {
        if (!authorization || body.clientSecret !== authorization.clientSecret) return json(res, { error: "invalid_authorization" }, 403);
        if (!approved) return json(res, { error: "authorization_pending" }, 409);
        return json(res, { status: "connected", accessToken: access, apiUrl: base, account, inviter, invite: { url: `${base}/`, shareText: "This is a local practice invitation, not a shareable Relay invitation." } });
      }
      if (req.headers.authorization !== `Bearer ${access}`) return json(res, { error: "practice_token_required" }, 401);
      if (url.pathname === "/practice/state") return json(res, payload());
      if (url.pathname === "/practice/complete") { completed = true; return json(res, { ok: true, version: 2 }); }
      if (url.pathname === "/v1/me") return json(res, { user: account });
      if (url.pathname === "/v1/e2ee/status") return json(res, { mode: "off" });
      if (url.pathname === "/v1/sent") return json(res, { items: sent, hasSentRelay: sent.length > 0 });
      if (url.pathname === "/v1/inbox") return json(res, { items: [] });
      if (url.pathname === "/v1/contacts") return json(res, { contacts });
      if (url.pathname === "/v1/contact-groups") return json(res, { groups: [] });
      if (url.pathname === "/v1/chats") return json(res, { chats: [] });
      if (url.pathname === "/v1/invite-link" || url.pathname === "/v1/invites-v2/link") return json(res, { url: `${base}/`, shareText: "Local practice only." });
      if (url.pathname === "/v1/contacts/on-relay") {
        const contact = contacts.find((c) => c.email === String(body.email || "").toLowerCase());
        return json(res, contact ? { found: true, contact } : { found: false });
      }
      if (url.pathname === "/v1/relays" && req.method === "POST") {
        if (!approved) return json(res, { error: "practice_approval_required" }, 403);
        if (body.recipient?.relayUserId !== inviter.relayUserId) return json(res, { error: "practice_recipient_only" }, 400);
        if (!body.idempotencyKey || !body.forHuman || !body.forAgent) return json(res, { error: "invalid_message" }, 400);
        const existing = requests.get(body.idempotencyKey);
        if (existing) return json(res, existing.body === raw ? existing.result : { error: "idempotency_conflict" }, existing.body === raw ? 200 : 409);
        const relayId = `review_${randomUUID()}`;
        const row = { ...body, relayId, id: relayId, threadId: relayId, recipient: inviter, state: "delivered", createdAt: new Date().toISOString() };
        sent.push(row);
        const result = { relayId, state: "delivered", recipient: inviter };
        requests.set(body.idempotencyKey, { body: raw, result });
        return json(res, result);
      }
      return json(res, { error: "unavailable_in_local_rehearsal" }, 404);
    } catch { if (!res.headersSent) json(res, { error: "practice_request_failed" }, 400); else res.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // A narrowly scoped wrapper prevents an agent from accidentally using the
  // person's real credential files or their installed MCP during practice.
  const wrapper = `import {spawn} from 'node:child_process';\nimport fs from 'node:fs';\nconst args=process.argv.slice(2);const base=${JSON.stringify(base)};\nif(!['connect-start','connect-finish','status','tutorial-send','tutorial-skip','opening-preference','invite-link','inbox','sent','read'].includes(args[0])||(args[0]==='connect-start'&&args[1]!==base))throw new Error('Only the local onboarding rehearsal is allowed.');\nfor(const file of ${JSON.stringify([path.join(root,"agent-protocol.json"),path.join(root,"agent-authorization.json")])}){if(fs.existsSync(file)&&JSON.parse(fs.readFileSync(file)).apiUrl!==base)throw new Error('Practice profile origin changed. Start a fresh rehearsal.');}\nconst child=spawn(process.execPath,[${JSON.stringify(path.join(packageRoot, "skill/relay/scripts/relay-protocol.mjs"))},...args],{stdio:'inherit',env:{...process.env,RELAY_CONFIG_DIR:${JSON.stringify(root)},RELAY_AGENT_CONFIG:${JSON.stringify(path.join(root,"agent-protocol.json"))},RELAY_AGENT_AUTHORIZATION:${JSON.stringify(path.join(root,"agent-authorization.json"))},RELAY_AGENT_LOCAL:${JSON.stringify(path.join(root,"no-local-daemon.json"))},RELAY_AGENT_ALLOW_LOOPBACK:'1'}});child.on('exit',code=>process.exit(code||0));\n`;
  fs.writeFileSync(path.join(root, "practice-relay.mjs"), wrapper, { mode: 0o600 });
  return { url: base, root, close: () => new Promise((resolve) => server.close(resolve)) };
}

export async function runOnboardingReview() {
  const review = await startOnboardingReview();
  console.log(`Relay local onboarding rehearsal: ${review.url}\nPractice only. No real sends or installation changes.\nTemporary profile: ${review.root}\nPress Ctrl-C to stop. Run again for a fresh profile.`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { review.close().then(() => process.exit(0)); });
}
