import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startAgentLocalServer } from "../src/agent-local-server.js";
import { localEndpoint } from "../skill/relay/scripts/relay-local.mjs";

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

test("paired staging accounts use the helper without accepting arbitrary API origins", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-staging-agent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "agent-local.json");
  const client = { identity: { userId: "usr_staging" }, accountDrift: () => ({ status: "same" }),
    groups: async () => ({ groups: [{ id: "grp_staging" }] }) };
  const server = await startAgentLocalServer({ client, accountId: "usr_staging", apiUrl: "https://cti37jd7vx.us-east-1.awsapprunner.com", file });
  t.after(() => server.close());
  const env = { RELAY_CONFIG_DIR: root, RELAY_AGENT_CONFIG: path.join(root, "agent-protocol.json"), RELAY_AGENT_LOCAL: file };
  const groups = await runProtocol(["groups"], { env });
  assert.equal(groups.code, 0, groups.stderr);
  assert.equal(JSON.parse(groups.stdout).groups[0].id, "grp_staging");
  const descriptor = JSON.parse(fs.readFileSync(file, "utf8"));
  descriptor.apiUrl = "https://untrusted.example";
  fs.writeFileSync(file, JSON.stringify(descriptor));
  const refused = await runProtocol(["groups"], { env });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /approved staging API host/);
});

test("an existing Companion account works without invite credentials and respects RELAY_CONFIG_DIR", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-existing-agent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "agent-local.json");
  const client = { identity: { userId: "usr_existing" }, accountDrift: () => ({ status: "same" }),
    me: async () => ({ user: { id: "usr_existing" } }), groups: async () => ({ groups: [{ id: "grp_existing" }] }) };
  const server = await startAgentLocalServer({ client, accountId: "usr_existing", apiUrl: "https://dev-api.sendrelays.com", file });
  const env = { RELAY_CONFIG_DIR: root, RELAY_AGENT_CONFIG: "", RELAY_AGENT_LOCAL: "" };
  try {
    const status = await runProtocol(["status"], { env });
    assert.equal(status.code, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout).account.relayUserId, "usr_existing");
    const groups = await runProtocol(["groups"], { env });
    assert.equal(groups.code, 0, groups.stderr);
    assert.equal(JSON.parse(groups.stdout).groups[0].id, "grp_existing");
    assert.equal(fs.existsSync(path.join(root, "agent-protocol.json")), false, "read-only discovery does not invent a browser grant");
    client.identity.userId = "usr_other";
    assert.match((await runProtocol(["groups"], { env })).stderr, /account changed/);
  } finally { await server.close(); }
});

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
  assert.match(protocol, /X-Relay-Skill-Telemetry/);
  assert.match(protocol, /managedSkillTelemetryHeader/);
  assert.doesNotMatch(protocol, /payload\s*=\s*\{[\s\S]{0,800}\bdirectory\b/);
  assert.match(protocol, /TRUSTED_RELAY_HOSTS/);
  assert.match(protocol, /authorization_pending/);
  assert.match(protocol, /authorization_approved/);
  assert.match(protocol, /protectOwnerOnly/);
  assert.doesNotMatch(protocol, /\/mcp|hook/i);
  assert.doesNotMatch(protocol, /command === "configure"/);
});

test("an installed direct helper reports bounded managed-skill identity and integrity", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-skill-telemetry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillRoot = path.join(root, "custom", "relay");
  fs.cpSync(fileURLToPath(new URL("../skill/relay", import.meta.url)), skillRoot, { recursive: true });
  const ownedFiles = ["SKILL.md", "agents/openai.yaml", "scripts/relay-protocol.mjs", "scripts/relay-local.mjs", "scripts/relay-attachments.mjs"];
  fs.writeFileSync(path.join(skillRoot, ".relay-managed.json"), JSON.stringify({
    schemaVersion: 1,
    name: "relay",
    version: "1.1.15",
    consentVersion: 2,
    host: "claude",
    target: "primary",
    installationId: "ski_0123456789abcdefghijklmn",
    installedAt: "2026-09-08T08:00:00.000Z",
    files: ownedFiles.map((relative) => ({
      path: relative,
      sha256: createHash("sha256").update(fs.readFileSync(path.join(skillRoot, ...relative.split("/")))).digest("hex"),
    })),
  }));
  const headers = [];
  const server = http.createServer((request, response) => {
    headers.push(request.headers);
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/me") return response.end(JSON.stringify({ user: { id: "usr_test" } }));
    if (request.url === "/v1/e2ee/status") return response.end(JSON.stringify({ mode: "off" }));
    response.end(JSON.stringify({ groups: [] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, JSON.stringify({
    consentVersion: 2,
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    accessToken: "web_test_only_01234567890123456789",
    account: { relayUserId: "usr_test" },
  }));
  const result = await runNodeScript(path.join(skillRoot, "scripts", "relay-protocol.mjs"), ["groups"], {
    env: { RELAY_AGENT_CONFIG: config, RELAY_AGENT_LOCAL: path.join(root, "missing-local.json"), RELAY_AGENT_ALLOW_LOOPBACK: "1" },
  });
  assert.equal(result.code, 0, result.stderr);
  const encoded = headers.at(-1)["x-relay-skill-telemetry"];
  const telemetry = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.deepEqual(telemetry, {
    name: "relay",
    host: "claude",
    target: "primary",
    installationId: "ski_0123456789abcdefghijklmn",
    version: "1.1.15",
    consentVersion: 2,
    status: "managed",
    installedAt: "2026-09-08T08:00:00.000Z",
  });
  assert.equal(JSON.stringify(telemetry).includes(root), false);
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
  const env = { RELAY_AGENT_AUTHORIZATION: pendingFile, RELAY_AGENT_CONFIG: configFile, RELAY_AGENT_LOCAL: path.join(root, "no-daemon.json"), RELAY_AGENT_ALLOW_LOOPBACK: "1" };
  const api = `http://127.0.0.1:${server.address().port}`;

  const started = await runProtocol(["connect-start", api, "invite_token_01234567890123456789", "codex"], { env });
  assert.equal(started.code, 0, started.stderr);
  assert.equal(JSON.parse(started.stdout).approvalUrl.includes("approvalToken="), true);
  assert.doesNotMatch(started.stdout, /ivcs_|codeVerifier|codeChallenge/);
  assert.match(requests[0].body.codeChallenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(requests[0].body.codeChallengeMethod, "S256");
  assert.equal(requests[0].body.consentVersion, 2);

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

  const attachment = path.join(root, "report.txt");
  fs.writeFileSync(attachment, "Report contents");
  for (const recipient of [{ groupId: "grp_example" }, { chatId: "chat_example" }]) {
    const body = { ...ordinaryBody, recipient, files: [attachment], idempotencyKey: `file-send-${Object.keys(recipient)[0]}` };
    const result = await runProtocol(["send"], { env, input: JSON.stringify(body) });
    assert.equal(result.code, 0, result.stderr);
    const sent = requests.findLast((item) => item.url === "/v1/relays").body;
    assert.deepEqual(sent.recipient, recipient);
    assert.equal(sent.attachments[0].bytes, 15);
    assert.match(sent.attachments[0].sha256, /^[0-9a-f]{64}$/);
    assert.equal(Buffer.from(sent.attachments[0].contentBase64, "base64").toString(), "Report contents");
    assert.equal(sent.files, undefined);
    assert.equal(sent.attachments[0].path, undefined);
  }

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

test("setup converges on MCP and skill without retiring integrations or adding hooks", () => {
  const start = installer.indexOf("export async function runSetupInstall");
  const end = installer.indexOf("export async function installAgentSkills", start);
  const setup = installer.slice(start, end);
  assert.match(setup, /installAgentSkills\(\)/);
  assert.match(setup, /installClaudeCode\(/);
  assert.match(setup, /installCodex\(/);
  assert.match(setup, /installClaudeDesktop\(/);
  assert.match(setup, /repairExistingAgentHooks\(/);
  assert.doesNotMatch(setup, /removeClaudeCodeMcpConfig|removeCodexMcpConfig|uninstallClaudeHooks|uninstallCodexHooks|installClaudeHooksWithStableLauncher|installCodexHooksWithStableLauncher/);
});

test("the helper retains direct auth and falls back after Companion stops without bypassing account or encryption checks", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-handoff-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "config.json");
  const descriptor = path.join(root, "local.json");
  const requests = [];
  let mode = "off";
  let directUser = "usr_test";
  let directStatus = 200;
  const api = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    response.statusCode = directStatus;
    if (directStatus !== 200) return response.end(JSON.stringify({ error: "invalid_token" }));
    if (request.url === "/v1/me") return response.end(JSON.stringify({ user: { id: directUser } }));
    if (request.url === "/v1/e2ee/status") return response.end(JSON.stringify({ mode }));
    return response.end(JSON.stringify({ groups: [{ id: "grp_direct" }] }));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => api.close(resolve)));
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  fs.writeFileSync(config, JSON.stringify({ consentVersion: 2, apiUrl, accessToken: "web_test_only_01234567890123456789", account: { relayUserId: "usr_test" } }));
  const client = {
    identity: { userId: "usr_test" }, accountDrift: () => ({ status: "same" }),
    me: async () => ({ user: { id: "usr_test" } }),
    sendRelay: async () => ({ relayId: "rel_sent" }),
    groups: async () => ({ groups: [{ id: "grp_test", name: "Project" }] }),
  };
  const env = { RELAY_AGENT_CONFIG: config, RELAY_AGENT_LOCAL: descriptor, RELAY_AGENT_ALLOW_LOOPBACK: "1" };
  const server = await startAgentLocalServer({ client, accountId: "usr_test", apiUrl, file: descriptor });
  let staleDescriptor;
  try {
    const result = await runProtocol(["groups"], { env });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).groups[0].id, "grp_test");
    assert.doesNotMatch(result.stdout, /web_test|capability|deviceToken/);
    const after = JSON.parse(fs.readFileSync(config, "utf8"));
    assert.equal(after.local, true);
    assert.equal(after.accessToken, "web_test_only_01234567890123456789");
    assert.equal(requests.length, 0, "healthy Companion remains preferred");
    staleDescriptor = fs.readFileSync(descriptor, "utf8");
    fs.writeFileSync(config, JSON.stringify({ ...after, expiresAt: "2000-01-01T00:00:00Z" }));
    assert.equal((await runProtocol(["groups"], { env })).code, 0, "expired fallback does not break healthy Companion");
    const legacy = { ...after };
    delete legacy.accessToken;
    fs.writeFileSync(config, JSON.stringify(legacy));
    assert.equal((await runProtocol(["groups"], { env })).code, 0, "legacy tokenless connections keep using Companion");
    const wrongAccount = { ...after, account: { relayUserId: "usr_other" } };
    fs.writeFileSync(config, JSON.stringify(wrongAccount));
    const refused = await runProtocol(["groups"], { env });
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /different Relay account/);
    fs.writeFileSync(config, JSON.stringify({ ...after, apiUrl: "https://api.sendrelays.com" }));
    assert.match((await runProtocol(["groups"], { env })).stderr, /different Relay account or environment/);
    fs.writeFileSync(config, JSON.stringify(after));
    client.groups = async () => { throw Object.assign(new Error("Permission refused"), { status: 403, code: "forbidden" }); };
    assert.match((await runProtocol(["groups"], { env })).stderr, /Permission refused/);
    client.groups = async () => { throw new Error("Relay's account changed"); };
    assert.match((await runProtocol(["groups"], { env })).stderr, /account changed/);
    assert.equal(requests.length, 0, "refusals never fall back");
    client.groups = async () => { throw Object.assign(new Error("Device token expired"), { status: 401 }); };
    const authFallback = await runProtocol(["groups"], { env });
    assert.equal(authFallback.code, 0, authFallback.stderr);
    assert.equal(JSON.parse(authFallback.stdout).groups[0].id, "grp_direct");
  } finally { await server.close(); }
  const stopped = await runProtocol(["groups"], { env });
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).groups[0].id, "grp_direct");
  // An abrupt exit leaves a stale descriptor rather than deleting it.
  fs.writeFileSync(descriptor, staleDescriptor, { mode: 0o600 });
  const crashed = await runProtocol(["groups"], { env });
  assert.equal(crashed.code, 0, crashed.stderr);
  assert.equal(JSON.parse(crashed.stdout).groups[0].id, "grp_direct");
  for (mode of ["optional", "required", "unknown"]) {
    const before = requests.filter((url) => url === "/v1/contact-groups").length;
    assert.match((await runProtocol(["groups"], { env })).stderr, /encryption/);
    assert.equal(requests.filter((url) => url === "/v1/contact-groups").length, before);
  }
  mode = "off";
  directUser = "usr_other";
  assert.match((await runProtocol(["groups"], { env })).stderr, /different account/);
  directUser = "usr_test";
  directStatus = 401;
  assert.match((await runProtocol(["groups"], { env })).stderr, /invalid_token/);
  directStatus = 200;
  const retained = JSON.parse(fs.readFileSync(config, "utf8"));
  fs.writeFileSync(config, JSON.stringify({ ...retained, expiresAt: "2000-01-01T00:00:00Z" }));
  assert.match((await runProtocol(["groups"], { env })).stderr, /direct authorization expired/);
  delete retained.accessToken;
  fs.writeFileSync(config, JSON.stringify(retained));
  assert.match((await runProtocol(["groups"], { env })).stderr, /renew browser approval/);
});

test("a lost local send response uses the identical direct request and key, while unkeyed mutations never retry", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-fallback-send-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const descriptor = path.join(root, "local.json");
  const config = path.join(root, "config.json");
  const deliveries = new Map();
  const sends = [];
  const accept = (body) => {
    const prior = deliveries.get(body.idempotencyKey);
    if (prior) assert.deepEqual(body, prior.body);
    else deliveries.set(body.idempotencyKey, { body, relayId: "rel_once" });
    sends.push(body);
    return { relayId: deliveries.get(body.idempotencyKey).relayId, state: "sent" };
  };
  const api = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/me") return response.end(JSON.stringify({ user: { id: "usr_test" } }));
    if (request.url === "/v1/e2ee/status") return response.end(JSON.stringify({ mode: "off" }));
    assert.equal(request.url, "/v1/relays");
    assert.equal(request.headers.authorization, "Bearer web_test_only_01234567890123456789");
    response.end(JSON.stringify(accept(JSON.parse(text))));
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => api.close(resolve)));
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  const endpoint = localEndpoint(descriptor);
  fs.writeFileSync(descriptor, JSON.stringify({ version: 1, endpoint, capability: "a".repeat(64), accountId: "usr_test", apiUrl }), { mode: 0o600 });
  fs.writeFileSync(config, JSON.stringify({ consentVersion: 2, apiUrl, accessToken: "web_test_only_01234567890123456789", account: { relayUserId: "usr_test" } }));
  const local = net.createServer((socket) => {
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
      if (!text.includes("\n")) return;
      const request = JSON.parse(text.trim());
      if (request.path === "/v1/relays") accept(request.body);
      socket.end(); // Request accepted; response lost before the helper sees it.
    });
  });
  await new Promise((resolve) => local.listen(endpoint, resolve));
  t.after(() => new Promise((resolve) => local.close(resolve)));
  const env = { RELAY_AGENT_CONFIG: config, RELAY_AGENT_LOCAL: descriptor, RELAY_AGENT_ALLOW_LOOPBACK: "1" };
  const body = { recipient: { relayUserId: "usr_friend" }, kind: "message", forHuman: "Hello", forAgent: "Approved context", idempotencyKey: "lost-response-send-1" };
  const sent = await runProtocol(["send"], { env, input: JSON.stringify(body) });
  assert.equal(sent.code, 0, sent.stderr);
  assert.equal(JSON.parse(sent.stdout).relayId, "rel_once");
  assert.equal(sends.length, 2);
  assert.equal(deliveries.size, 1);
  assert.deepEqual(sends[0], sends[1]);
  const repeated = await runProtocol(["send"], { env, input: JSON.stringify(body) });
  assert.equal(JSON.parse(repeated.stdout).status, "already_accepted");
  assert.equal(sends.length, 2);
  const unkeyed = await runProtocol(["invite-link"], { env });
  assert.equal(unkeyed.code, 1);
  assert.match(unkeyed.stderr, /same idempotency key/);
});

test("bounded reply checks use the sent conversation and never mark a message read", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reply-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const requests = [];
  let replyArrived = false;
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    const sent = { id: "rel_hello", threadId: "thread_hello", createdAt: "2026-09-05T10:00:00Z" };
    if (request.url === "/v1/sent") return response.end(JSON.stringify({ items: [sent] }));
    if (request.url === "/v1/threads/thread_hello") return response.end(JSON.stringify({ chatId: "chat_one", items: [] }));
    if (request.url === "/v1/chats/chat_one") return response.end(JSON.stringify({ items: replyArrived ? [{ id: "rel_reply", direction: "inbound", createdAt: "2026-09-05T10:01:00Z", forHuman: "Welcome" }] : [] }));
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = path.join(root, "config.json");
  fs.writeFileSync(config, JSON.stringify({ consentVersion: 2, apiUrl: `http://127.0.0.1:${server.address().port}`, accessToken: "web_test_only_01234567890123456789" }));
  const env = { RELAY_AGENT_CONFIG: config, RELAY_AGENT_LOCAL: path.join(root, "missing.json"), RELAY_AGENT_ALLOW_LOOPBACK: "1" };
  assert.equal(JSON.parse((await runProtocol(["wait-reply", "rel_hello", "0"], { env })).stdout).status, "no_reply_yet");
  replyArrived = true;
  const reply = await runProtocol(["wait-reply", "rel_hello", "0"], { env });
  assert.equal(reply.code, 0, reply.stderr);
  assert.equal(JSON.parse(reply.stdout).items[0].id, "rel_reply");
  assert.ok(requests.every((url) => !url.includes("/read")));
});
