import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillText = fs.readFileSync(new URL("../skill/relay/SKILL.md", import.meta.url), "utf8");
const protocol = fs.readFileSync(new URL("../skill/relay/scripts/relay-protocol.mjs", import.meta.url), "utf8");
const installer = fs.readFileSync(new URL("../src/install.js", import.meta.url), "utf8");
const protocolPath = fileURLToPath(new URL("../skill/relay/scripts/relay-protocol.mjs", import.meta.url));
const bootstrapPath = fileURLToPath(new URL("../bootstrap/relay-setup.cjs", import.meta.url));
const bootstrapText = fs.readFileSync(bootstrapPath, "utf8");
const fullCliText = fs.readFileSync(new URL("../bin/relay.js", import.meta.url), "utf8");

function runNodeScript(script, args, { env, input = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function runProtocol(args, options) {
  return runNodeScript(protocolPath, args, options);
}

test("Relay skill teaches one direct HTTPS product and an approved inviter hello", () => {
  assert.match(skillText, /authenticated HTTPS protocol/);
  assert.match(skillText, /POST \/v1\/agent\/authorizations/);
  assert.match(skillText, /POST \/v1\/agent\/authorizations\/:id\/consume/);
  assert.match(skillText, /Hi — I’ve just joined you on Relay\./);
  assert.match(skillText, /Never send the tutorial message automatically/);
  assert.match(skillText, /Human payload/);
  assert.match(skillText, /Agent payload/);
  assert.match(skillText, /accepted or queued/);
  assert.match(skillText, /absolute directory containing this loaded/);
  assert.match(skillText, /only if the `relay`\s+executable is already available/);
  assert.match(skillText, /run `inbox`[\s\S]*run `read`[\s\S]*run `mark-read`/);
  assert.match(skillText, /retry with that\s+same body and key/);
  assert.doesNotMatch(skillText, /lightweight|full version|upgrade|upsell/i);
});

test("standalone protocol uses neutral authorization routes and a bounded request surface", () => {
  assert.match(protocol, /"\/v1\/agent\/authorizations"/);
  assert.match(protocol, /`\/v1\/agent\/authorizations\/\$\{encodeURIComponent\(pending\.authorizationId\)\}\/consume`/);
  assert.match(protocol, /SAFE_GET/);
  assert.match(protocol, /SAFE_POST/);
  assert.match(protocol, /X-Relay-Send-Contract/);
  assert.match(protocol, /TRUSTED_RELAY_HOSTS/);
  assert.match(protocol, /authorization_pending/);
  assert.match(protocol, /authorization_approved/);
  assert.match(protocol, /protectOwnerOnly/);
  assert.doesNotMatch(protocol, /\/mcp|hook/i);
  assert.doesNotMatch(protocol, /command === "configure"/);
});

test("thin and full package CLIs expose the bundled protocol helper without handling credentials", async () => {
  assert.match(bootstrapText, /command === "protocol"[\s\S]*spawnSync\(process\.execPath, \[protocol, \.\.\.process\.argv\.slice\(3\)\]/);
  assert.match(fullCliText, /case "protocol"[\s\S]*spawnSync\(process\.execPath, \[protocol, \.\.\.rest\]/);
  const help = await runNodeScript(bootstrapPath, ["protocol", "help"]);
  assert.equal(help.code, 0, help.stderr);
  assert.match(help.stdout, /connect-start/);
  assert.match(help.stdout, /tutorial-send --approved/);
  assert.doesNotMatch(help.stdout, /accessToken|clientSecret|codeVerifier/);
});

test("browser-approved PKCE connection keeps secrets out of output and powers direct sends", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-agent-protocol-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pendingFile = path.join(root, "pending.json");
  const configFile = path.join(root, "config.json");
  const requests = [];
  let selfInvite = false;
  let invalidInviter = false;
  let invalidApproval = false;
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = body ? JSON.parse(body) : {};
    requests.push({ method: request.method, url: request.url, headers: request.headers, body: parsed });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/agent/authorizations") {
      selfInvite = String(parsed.inviteToken || "").startsWith("self_");
      invalidInviter = String(parsed.inviteToken || "").startsWith("invalid_");
      invalidApproval = String(parsed.inviteToken || "").startsWith("wrong_host_");
      response.end(JSON.stringify({
        authorizationId: "authorization_test",
        clientSecret: "ivcs_0123456789012345678901234567890123456789",
        approvalUrl: invalidApproval
          ? "https://evil.example/connect-agent/authorization_test#approvalToken=browser-only"
          : `http://127.0.0.1:${server.address().port}/connect-agent/authorization_test#approvalToken=browser-only`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }));
      return;
    }
    if (request.url === "/v1/agent/authorizations/authorization_test/consume") {
      response.end(JSON.stringify({
        status: "connected",
        accessToken: "web_0123456789012345678901234567890123456789",
        apiUrl: `http://127.0.0.1:${server.address().port}`,
        expiresAt: "2099-01-01T00:00:00.000Z",
        account: { name: "Receiver", email: "receiver@example.com" },
        inviter: invalidInviter
          ? { name: "", relayUserId: "" }
          : selfInvite
            ? { name: "Receiver", relayUserId: "usr_receiver" }
            : { name: "Inviter", relayUserId: "usr_inviter" },
        invite: { url: "https://sendrelays.com/i/receiver" },
      }));
      return;
    }
    if (request.url === "/v1/me") {
      response.end(JSON.stringify({ user: { id: "usr_receiver", name: "Receiver", email: "receiver@example.com" } }));
      return;
    }
    if (request.url === "/v1/relays") {
      response.end(JSON.stringify({ relayId: "rel_first", state: "sent" }));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const env = { RELAY_AGENT_AUTHORIZATION: pendingFile, RELAY_AGENT_CONFIG: configFile, RELAY_AGENT_ALLOW_LOOPBACK: "1" };
  const api = `http://127.0.0.1:${server.address().port}`;

  const started = await runProtocol(["connect-start", api, "invite_token_01234567890123456789", "codex"], { env });
  assert.equal(started.code, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).approvalUrl.includes("approvalToken="), true);
  assert.doesNotMatch(started.stdout, /ivcs_|codeVerifier|codeChallenge/);
  assert.match(requests[0].body.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(requests[0].body.codeChallengeMethod, "S256");

  const finished = await runProtocol(["connect-finish"], { env });
  assert.equal(finished.code, 0, finished.stderr);
  assert.doesNotMatch(finished.stdout, /web_|ivcs_|codeVerifier/);
  assert.equal(JSON.parse(finished.stdout).inviter.relayUserId, "usr_inviter");
  assert.equal(JSON.parse(finished.stdout).account.relayUserId, "usr_receiver");
  assert.equal(JSON.parse(finished.stdout).tutorial.state, "pending");
  assert.equal(fs.existsSync(pendingFile), false);
  assert.match(fs.readFileSync(configFile, "utf8"), /web_012345/);

  const send = await runProtocol(["tutorial-send", "--approved"], { env });
  assert.equal(send.code, 0, send.stderr);
  assert.equal(JSON.parse(send.stdout).relayId, "rel_first");
  const sentRequest = requests.findLast((item) => item.url === "/v1/relays");
  assert.equal(sentRequest.headers.authorization, "Bearer web_0123456789012345678901234567890123456789");
  assert.match(sentRequest.body.idempotencyKey, /^[0-9a-f-]{36}$/);
  assert.equal(sentRequest.body.recipient.relayUserId, "usr_inviter");
  assert.equal(sentRequest.body.forHuman, "Hi — I’ve just joined you on Relay.");
  assert.equal(sentRequest.body.forAgent, "This is my first Relay after joining from your invite. Help the person reply if they want to welcome me.");
  const relayRequestsAfterTutorial = requests.filter((item) => item.url === "/v1/relays").length;
  const repeatedTutorial = await runProtocol(["tutorial-send", "--approved"], { env });
  assert.equal(JSON.parse(repeatedTutorial.stdout).status, "already_accepted");
  assert.equal(requests.filter((item) => item.url === "/v1/relays").length, relayRequestsAfterTutorial);

  const ordinaryBody = {
    recipient: { relayUserId: "usr_inviter" },
    kind: "message",
    forHuman: "An ordinary approved message.",
    forAgent: "Keep this exact request stable on retry.",
    idempotencyKey: "ordinary_send_key_0001",
  };
  const ordinary = await runProtocol(["send"], { env, input: JSON.stringify(ordinaryBody) });
  assert.equal(ordinary.code, 0, ordinary.stderr);
  const relayRequestsAfterOrdinary = requests.filter((item) => item.url === "/v1/relays").length;
  const repeatedOrdinary = await runProtocol(["send"], { env, input: JSON.stringify(ordinaryBody) });
  assert.equal(JSON.parse(repeatedOrdinary.stdout).status, "already_accepted");
  assert.equal(requests.filter((item) => item.url === "/v1/relays").length, relayRequestsAfterOrdinary);

  const selfPending = path.join(root, "self-pending.json");
  const selfConfig = path.join(root, "self-config.json");
  const selfEnv = { ...env, RELAY_AGENT_AUTHORIZATION: selfPending, RELAY_AGENT_CONFIG: selfConfig };
  assert.equal((await runProtocol(["connect-start", api, "self_invite_token_0123456789012345", "codex"], { env: selfEnv })).code, 0);
  const selfFinished = await runProtocol(["connect-finish"], { env: selfEnv });
  assert.equal(selfFinished.code, 0, selfFinished.stderr);
  assert.equal(JSON.parse(selfFinished.stdout).tutorial.state, "skipped_self");
  const relayRequestsBeforeSelfTutorial = requests.filter((item) => item.url === "/v1/relays").length;
  const selfTutorial = await runProtocol(["tutorial-send", "--approved"], { env: selfEnv });
  assert.equal(JSON.parse(selfTutorial.stdout).status, "skipped_self");
  assert.equal(requests.filter((item) => item.url === "/v1/relays").length, relayRequestsBeforeSelfTutorial);

  const invalidPending = path.join(root, "invalid-pending.json");
  const invalidConfig = path.join(root, "invalid-config.json");
  const invalidEnv = { ...env, RELAY_AGENT_AUTHORIZATION: invalidPending, RELAY_AGENT_CONFIG: invalidConfig };
  assert.equal((await runProtocol(["connect-start", api, "invalid_invite_token_0123456789012", "codex"], { env: invalidEnv })).code, 0);
  const invalidFinished = await runProtocol(["connect-finish"], { env: invalidEnv });
  assert.equal(invalidFinished.code, 1);
  assert.match(invalidFinished.stderr, /valid inviter identity/);
  assert.equal(fs.existsSync(invalidPending), true);
  assert.equal(fs.existsSync(invalidConfig), false);

  const wrongHostPending = path.join(root, "wrong-host-pending.json");
  const wrongHost = await runProtocol(["connect-start", api, "wrong_host_invite_token_01234567890", "codex"], {
    env: { ...env, RELAY_AGENT_AUTHORIZATION: wrongHostPending },
  });
  assert.equal(wrongHost.code, 1);
  assert.match(wrongHost.stderr, /wrong host/);
  assert.equal(fs.existsSync(wrongHostPending), false);
  const untrustedApi = await runProtocol(["connect-start", "https://evil.example", "invite_token_01234567890123456789", "codex"], { env });
  assert.equal(untrustedApi.code, 1);
  assert.match(untrustedApi.stderr, /production or development Relay API host/);
});

test("new Companion install mode retires MCP and hooks before installing the skill", () => {
  const start = installer.indexOf("if (agentProtocol)");
  const end = installer.indexOf("const mcpBin = ensureStableMcpLauncher", start);
  assert.ok(start >= 0 && end > start);
  const directPath = installer.slice(start, end);
  assert.match(directPath, /installBundled\(\{ consent: true \}\)/);
  assert.match(directPath, /removeClaudeCodeMcpConfig/);
  assert.match(directPath, /removeCodexMcpConfig/);
  assert.match(directPath, /removeClaudeDesktopMcpConfig/);
  assert.match(directPath, /uninstallClaudeHooks/);
  assert.match(directPath, /uninstallCodexHooks/);
  assert.doesNotMatch(directPath, /installClaudeCode\(|installCodex\(|installClaudeHooksWithStableLauncher|installCodexHooksWithStableLauncher/);
});
