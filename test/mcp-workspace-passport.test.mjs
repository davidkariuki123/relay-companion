// The workspace passport names the repo a relay is ABOUT, and it comes from the
// agent — never from the sending process's working directory.
//
// These tests run from inside a git checkout of relay, so the old cwd-capture
// behaviour would stamp `github.com/davidkariuki123/relay` on every send here.
// "No repo argument means no passport" is therefore a real assertion, not a
// tautology: it is what proves the cwd is no longer consulted.
import test from "node:test";
import assert from "node:assert/strict";
import { handleCall } from "../src/mcp.js";

function clientCapturingSend() {
  const captured = {};
  return {
    captured,
    async sendRelay(input) {
      captured.payload = input;
      return { relayId: "relay_workspace_1", deliveredVia: "email" };
    },
    async chatForThread() {
      return {
        chatId: "chat_1",
        replyToRelayId: "relay_root",
        messages: [
          { relayId: "relay_root", direction: "inbound", sender: { name: "Sven" }, title: "Root", forHuman: "Root body" },
        ],
      };
    },
  };
}

async function sendWith(repo) {
  const client = clientCapturingSend();
  await handleCall(client, "relay_send", {
    recipient: { email: "sven@example.com" },
    kind: "message",
    title: "Workspace passport proof",
    forHuman: "Please check this.",
    idempotencyKey: `idem_${Math.abs(Math.random() * 1e9) | 0}`,
    ...(repo === undefined ? {} : { repo }),
  });
  return client.captured.payload;
}

test("a send with no repo argument carries NO passport, even from inside a git repo", async () => {
  const payload = await sendWith(undefined);
  assert.equal(payload.source.host, "relay-mcp");
  assert.equal(payload.source.workspace, undefined, "the sender's cwd is never stamped as the subject");
  assert.equal(payload.source.repo, undefined, "the legacy cwd-derived repo identity is gone too");
});

test("an agent-declared origin becomes a git passport", async () => {
  const payload = await sendWith("git@github.com:acme/relay.git");
  assert.deepEqual(payload.source.workspace, { kind: "git", key: "github.com/acme/relay", label: "relay" });
});

test("an agent-declared bare project name becomes a name passport", async () => {
  const payload = await sendWith("relay");
  assert.deepEqual(payload.source.workspace, { kind: "name", key: "relay", label: "relay" });
});

test("the declared repo is the SUBJECT, independent of where the sender is working", async () => {
  // The case that motivated the change: Shane is in his own checkout and relays
  // us about relay. What he names is what travels.
  const payload = await sendWith("github.com/davidkariuki123/relay");
  assert.equal(payload.source.workspace.key, "github.com/davidkariuki123/relay");
  assert.notEqual(payload.source.workspace.key, process.cwd());
});

test("a passport never leaks a path, a home directory, or credentials", async () => {
  for (const declared of ["https://x-access-token:ghp_SECRET@github.com/acme/relay.git", "acme/relay", "relay"]) {
    const payload = await sendWith(declared);
    const serialized = JSON.stringify(payload.source.workspace);
    assert.ok(!serialized.includes("ghp_SECRET"), declared);
    assert.ok(!serialized.includes("@"), declared);
    assert.ok(!payload.source.workspace.key.startsWith("/"), declared);
    assert.equal(serialized.includes(process.env.HOME || "__no_home__"), false, declared);
  }
});

test("a filesystem path is refused rather than shipped", async () => {
  for (const bad of ["/Users/shane/dev/relay", "C:\\Users\\shane\\relay", "~/src/relay"]) {
    const payload = await sendWith(bad);
    assert.equal(payload.source.workspace, undefined, bad);
  }
});

test("relay_chat_reply carries a declared passport the same way", async () => {
  const client = clientCapturingSend();
  await handleCall(client, "relay_chat_reply", {
    threadId: "relay_root",
    replyToRelayId: "relay_root",
    forHuman: "Reply about the relay repo.",
    repo: "github.com/acme/relay",
    idempotencyKey: "idem_workspace_reply_1",
  });
  const payload = client.captured.payload;
  assert.equal(payload.inReplyToRelayId, "relay_root");
  assert.equal(payload.source.host, "relay-mcp");
  assert.deepEqual(payload.source.workspace, { kind: "git", key: "github.com/acme/relay", label: "relay" });
});

test("relay_chat_reply without a repo argument stays unanchored", async () => {
  const client = clientCapturingSend();
  await handleCall(client, "relay_chat_reply", {
    threadId: "relay_root",
    forHuman: "Just a chat reply.",
    idempotencyKey: "idem_workspace_reply_2",
  });
  assert.equal(client.captured.payload.source.workspace, undefined);
});

test("both send tools expose the repo argument to agents", async () => {
  const { toolsForAccount } = await import("../src/mcp.js");
  const tools = toolsForAccount({ requests: true, aiSessions: true, connectors: true });
  for (const name of ["relay_send", "relay_chat_send"]) {
    const tool = tools.find((t) => t.name === name);
    assert.ok(tool, `${name} exists`);
    const repo = tool.inputSchema.properties.repo;
    assert.ok(repo, `${name} takes a repo argument`);
    // The description has to make the subject-vs-cwd distinction, because getting
    // that wrong is the entire bug this replaced.
    assert.match(repo.description, /ABOUT/, `${name} says the argument is the subject`);
    assert.ok(!tool.inputSchema.required.includes("repo"), `${name} keeps repo optional`);
  }
});
