import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RelayClient } from "../src/client.js";
import { readConfig, writeConfig } from "../src/config.js";
import {
  installDaemonAutostart,
  writeClaudeCodeMcpConfig,
  writeCodexMcpConfig,
} from "../src/install.js";
import { pollOrdinaryRelayOnce } from "../src/task-daemon.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

test("config and registrations remove deprecated local capability switches", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-account-profile-"));
  const previousConfigDir = process.env.RELAY_CONFIG_DIR;
  process.env.RELAY_CONFIG_DIR = path.join(root, "config");
  try {
    writeConfig({
      deviceToken: "dev_test",
      companionMode: "full",
      features: { requests: true, retainedSetting: true },
    });
    const storedConfig = JSON.parse(fs.readFileSync(path.join(process.env.RELAY_CONFIG_DIR, "config.json"), "utf8"));
    assert.deepEqual(storedConfig.features, { retainedSetting: true });
    assert.equal(storedConfig.companionMode, undefined);
    assert.equal(storedConfig.features.requests, undefined);
    if (["darwin", "linux"].includes(process.platform)) {
      assert.equal(storedConfig.deviceToken, undefined);
      assert.equal(storedConfig.credentialStore, "local-v2");
      assert.equal(readConfig().deviceToken, "dev_test");
    } else {
      assert.equal(storedConfig.deviceToken, "dev_test");
    }

    const claudeConfig = path.join(root, "claude.json");
    fs.writeFileSync(claudeConfig, "{}\n");
    assert.equal(
      writeClaudeCodeMcpConfig("/relay/bin/relay.js", "/usr/bin/node", claudeConfig).ok,
      true,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(claudeConfig, "utf8")).mcpServers.relay.args, [
      "--max-old-space-size=96",
      "/relay/bin/relay.js",
      "mcp",
    ]);

    const codexConfig = path.join(root, "codex", "config.toml");
    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    assert.equal(
      writeCodexMcpConfig("/relay/bin/relay.js", "/usr/bin/node", codexConfig).ok,
      true,
    );
    assert.match(
      fs.readFileSync(codexConfig, "utf8"),
      /args = \["--max-old-space-size=96", "\/relay\/bin\/relay\.js", "mcp"\]/,
    );

    const homeDir = path.join(root, "home");
    const daemon = installDaemonAutostart("/relay/bin/relay.js", "/usr/bin/node", {
      platform: "darwin",
      homeDir,
      reload: false,
      runCommand: () => ({ ok: true, out: "" }),
    });
    assert.equal(daemon.ok, true);
    const plist = fs.readFileSync(daemon.plistPath, "utf8");
    assert.match(plist, /<string>daemon<\/string>/);
    assert.doesNotMatch(plist, /--full|--messages-only/);
  } finally {
    if (previousConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = previousConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registration repair strips old capability flags", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-full-profile-"));
  try {
    const claudeConfig = path.join(root, "claude.json");
    fs.writeFileSync(claudeConfig, JSON.stringify({
      mcpServers: { relay: { command: "/old/node", args: ["/old/relay.js", "mcp", "--full"] } },
    }));
    assert.equal(
      writeClaudeCodeMcpConfig("/relay/bin/relay.js", "/usr/bin/node", claudeConfig).ok,
      true,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(claudeConfig, "utf8")).mcpServers.relay.args, [
      "--max-old-space-size=96",
      "/relay/bin/relay.js",
      "mcp",
    ]);

    const codexConfig = path.join(root, "codex", "config.toml");
    fs.mkdirSync(path.dirname(codexConfig), { recursive: true });
    fs.writeFileSync(codexConfig, '[mcp_servers.relay]\ncommand = "/old/node"\nargs = ["/old/relay.js", "mcp", "--messages-only"]\n');
    assert.equal(writeCodexMcpConfig("/relay/bin/relay.js", "/usr/bin/node", codexConfig).ok, true);
    const codex = fs.readFileSync(codexConfig, "utf8");
    assert.match(codex, /args = \["--max-old-space-size=96", "\/relay\/bin\/relay\.js", "mcp"\]/);
    assert.doesNotMatch(codex, /--full|--messages-only/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the pill has no local capability-mode policy", () => {
  const source = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /mode-policy|COMPANION_MODE|RELAY_COMPANION_MODE/);
  assert.match(source, /refreshAccountProductFeatures/);
  assert.match(source, /user: me\?\.user/);
});

test("the pill gates every live Task entry point by the account capability", () => {
  const source = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  assert.match(source, /async function refreshTasks\(\) \{\s+if \(!TASK_FEATURES_ALLOWED\)/);
  assert.match(source, /async function runMutation\(label, fn\) \{\s+if \(!TASK_FEATURES_ALLOWED\)/);
  assert.match(source, /function openTaskDetail\(taskId\) \{\s+if \(!TASK_FEATURES_ALLOWED\) return;/);
  assert.match(source, /ipcMain\.handle\("relay:taskStatus"[\s\S]*?if \(!TASK_FEATURES_ALLOWED\)/);
  // Ordinary accounts hide every Task row while retaining it durably in the
  // staged store. Developer accounts can render and open them.
  assert.match(
    source,
    /filter\(\(p\) => PRODUCT_FEATURES\.requests \|\| p\.relayNotificationKind !== "task"\)/,
  );
  assert.match(source, /if \(!TASK_FEATURES_ALLOWED && \(row\?\.taskId \|\| isRelayTaskWebTarget\(row\?\.actionUrl\)\)\)/);
  assert.match(source, /function openUrlTarget\(url\) \{\s+if \(!TASK_FEATURES_ALLOWED && isRelayTaskWebTarget\(url\)\)/);
  assert.doesNotMatch(source, /COMPANION_MODE_CLI_ARG|--full|--messages-only/);
});

test("human-facing CLI commands reject removed capability flags", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../bin/relay.js", import.meta.url)), "tasks", "--full"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--full and --messages-only were removed/);
});

test("a stored deprecated full mode cannot grant Task access to a non-developer", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-default-cli-profile-"));
  fs.writeFileSync(
    path.join(root, "config.json"),
    `${JSON.stringify({ companionMode: "full", deviceToken: "dev_legacy_full" })}\n`,
  );
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/relay.js", import.meta.url)), "tasks"],
      {
        encoding: "utf8",
        env: { ...process.env, RELAY_CONFIG_DIR: root, RELAY_API_URL: "http://127.0.0.1:9" },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only to Relay developer accounts/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a non-developer open rejects a stale Task row before it can call a task endpoint", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-default-open-profile-"));
  fs.writeFileSync(
    path.join(root, "config.json"),
    `${JSON.stringify({ companionMode: "full", deviceToken: "dev_legacy_full" })}\n`,
  );
  fs.writeFileSync(
    path.join(root, "state.json"),
    `${JSON.stringify({
      packets: {
        stale_task_row: {
          id: "stale_task_row",
          relayNotificationKind: "task_completed",
          taskId: "task_stale_1",
          title: "Stale Task",
        },
      },
    })}\n`,
  );
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../bin/relay.js", import.meta.url)), "open", "stale_task_row", "--host", "claude"],
      {
        encoding: "utf8",
        env: { ...process.env, RELAY_CONFIG_DIR: root, RELAY_HOME: root, RELAY_API_URL: "http://127.0.0.1:9" },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only to Relay developer accounts/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary receiver calls only messaging endpoints and still stages the pill item", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ordinary-poll-"));
  const previousConfigDir = process.env.RELAY_CONFIG_DIR;
  process.env.RELAY_CONFIG_DIR = root;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/v1/inbox?view=summary") {
      res.end(JSON.stringify({
        items: [{
          relayId: "relay_ordinary_1",
          title: "Ordinary message",
          state: "delivered",
          createdAt: "2026-07-14T03:00:00.000Z",
          updatedAt: "2026-07-14T03:00:00.000Z",
        }],
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/relays/packets") {
      res.end(JSON.stringify({
        packets: {
          relay_ordinary_1: {
            packet: { title: "Ordinary message", forHuman: "Hello from Relay." },
            attachmentUrls: {},
          },
        },
      }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "unexpected_endpoint", path: req.url }));
  });
  try {
    const address = await listen(server);
    const staged = [];
    const result = await pollOrdinaryRelayOnce({
      client: new RelayClient({ url: `http://127.0.0.1:${address.port}`, token: "dev_messages_only" }),
      stagePlainRelay: (item) => staged.push(item),
      log: () => {},
    });
    assert.equal(result.ordinaryRelays.length, 1);
    assert.equal(staged.length, 1);
    // One list call plus ONE batch call — never one request per relay. This is
    // the shape that keeps catching up on a backlog to a couple of round trips.
    assert.deepEqual(requests, [
      { method: "GET", url: "/v1/inbox?view=summary" },
      { method: "POST", url: "/v1/relays/packets" },
    ]);
    assert.ok(requests.every(({ url }) => !url.startsWith("/v1/tasks")));
  } finally {
    await close(server);
    if (previousConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = previousConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("staging commits to the ledger as it goes, so an interrupted pass is not redone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ledger-incremental-"));
  const previousConfigDir = process.env.RELAY_CONFIG_DIR;
  process.env.RELAY_CONFIG_DIR = root;
  const items = Array.from({ length: 5 }, (_, i) => ({
    relayId: `relay_incremental_${i}`,
    title: `Relay ${i}`,
    state: "delivered",
    kind: "message",
    createdAt: "2026-08-07T00:00:00.000Z",
    updatedAt: "2026-08-07T00:00:00.000Z",
  }));
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/v1/inbox?view=summary") {
      res.end(JSON.stringify({ items }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/relays/packets") {
      const packets = {};
      for (const item of items) {
        packets[item.relayId] = { packet: { title: item.title, forHuman: "Body." }, attachmentUrls: {} };
      }
      res.end(JSON.stringify({ packets }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "unexpected_endpoint", path: req.url }));
  });
  try {
    const address = await listen(server);
    const client = new RelayClient({ url: `http://127.0.0.1:${address.port}`, token: "dev_messages_only" });
    const ledgerFile = path.join(root, "task-ledger.json");
    const readCommitted = () => {
      if (!fs.existsSync(ledgerFile)) return [];
      return Object.keys(JSON.parse(fs.readFileSync(ledgerFile, "utf8")).plainRelays || {});
    };

    // Observe the ledger from INSIDE the pass. This is what distinguishes an
    // incremental commit from the old write-once-at-the-end behaviour: mid-pass,
    // the relays already staged must be durable on disk. Before the fix nothing
    // was written until the loop finished, so a restart part-way through — an
    // auto-update restart, routine on this fleet — discarded every one of them
    // and the next pass re-staged the entire inbox from zero.
    const committedWhenThirdStaged = [];
    let stagedCount = 0;
    await pollOrdinaryRelayOnce({
      client,
      log: () => {},
      stagePlainRelay: () => {
        stagedCount += 1;
        if (stagedCount === 3) committedWhenThirdStaged.push(...readCommitted());
      },
    });

    assert.deepEqual(
      committedWhenThirdStaged,
      ["relay_incremental_0", "relay_incremental_1"],
      "the first two relays are durable before the third is even staged",
    );
    assert.equal(readCommitted().length, 5, "the finished pass has committed all five");
  } finally {
    await close(server);
    if (previousConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = previousConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a server without the batch route still receives, one relay at a time", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-batch-fallback-"));
  const previousConfigDir = process.env.RELAY_CONFIG_DIR;
  process.env.RELAY_CONFIG_DIR = root;
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/v1/inbox?view=summary") {
      res.end(JSON.stringify({
        items: [{
          relayId: "relay_old_server_1",
          title: "Ordinary message",
          state: "delivered",
          createdAt: "2026-08-07T00:00:00.000Z",
          updatedAt: "2026-08-07T00:00:00.000Z",
        }],
      }));
      return;
    }
    // An API deployed before the batch route exists.
    if (req.method === "POST" && req.url === "/v1/relays/packets") {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/relays/relay_old_server_1") {
      res.end(JSON.stringify({
        packet: { title: "Ordinary message", forHuman: "Hello." },
        attachmentUrls: {},
      }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "unexpected_endpoint", path: req.url }));
  });
  try {
    const address = await listen(server);
    const staged = [];
    const result = await pollOrdinaryRelayOnce({
      client: new RelayClient({ url: `http://127.0.0.1:${address.port}`, token: "dev_messages_only" }),
      stagePlainRelay: (item) => staged.push(item),
      log: () => {},
    });
    assert.equal(staged.length, 1, "the relay still lands when the batch route is missing");
    assert.equal(result.ordinaryRelays.length, 1);
    assert.deepEqual(requests.map((r) => r.url), [
      "/v1/inbox?view=summary",
      "/v1/relays/packets",
      "/v1/relays/relay_old_server_1",
    ]);
  } finally {
    await close(server);
    if (previousConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = previousConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a failed inbox poll is reported so the receiver can notice it is wedged", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-inbox-health-"));
  const previousConfigDir = process.env.RELAY_CONFIG_DIR;
  process.env.RELAY_CONFIG_DIR = root;
  const server = http.createServer((req, res) => {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "server_error" }));
  });
  try {
    const address = await listen(server);
    const client = new RelayClient({ url: `http://127.0.0.1:${address.port}`, token: "dev_messages_only" });
    const failed = await pollOrdinaryRelayOnce({ client, log: () => {}, stagePlainRelay: () => {} });
    assert.equal(failed.inboxOk, false, "a failing poll is visible to the caller");
  } finally {
    await close(server);
    if (previousConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = previousConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a Relay delivered while the laptop is offline is staged unread on the first successful wake poll", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-offline-replay-"));
  const previousConfigDir = process.env.RELAY_CONFIG_DIR;
  process.env.RELAY_CONFIG_DIR = root;
  let online = false;
  const item = {
    relayId: "relay_arrived_while_asleep",
    title: "Read versus needs action",
    state: "delivered",
    kind: "message",
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
  const client = {
    token: "dev_offline_replay",
    async inbox() {
      if (!online) throw new Error("network unavailable while laptop is closed");
      return { items: [item], inboxState: {} };
    },
    async fetchRelay() {
      return { packet: { title: item.title, forHuman: "Please read this." }, attachmentUrls: {} };
    },
  };
  const staged = [];
  try {
    const offline = await pollOrdinaryRelayOnce({
      client,
      log: () => {},
      stagePlainRelay: (value) => staged.push(value),
      agentContextHome: root,
    });
    assert.equal(offline.inboxOk, false);
    assert.equal(staged.length, 0);

    online = true;
    const awake = await pollOrdinaryRelayOnce({
      client,
      log: () => {},
      stagePlainRelay: (value) => staged.push(value),
      agentContextHome: root,
    });
    assert.equal(awake.inboxOk, true);
    assert.equal(staged.length, 1);
    assert.equal(staged[0].item.relayId, item.relayId);
    assert.equal(staged[0].item.state, "delivered", "offline delivery remains unread until a human marks it read");
  } finally {
    if (previousConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = previousConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary poll reconciles cross-surface deletes and read-all from inboxState", async () => {
  const { companionStatePath } = await import("../src/notifications.js");
  const previousConfigDir = process.env.RELAY_CONFIG_DIR;
  const previousHome = process.env.RELAY_COMPANION_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ordinary-reconcile-"));
  process.env.RELAY_CONFIG_DIR = root;
  // The companion state store resolves from RELAY_COMPANION_HOME, not RELAY_CONFIG_DIR;
  // without this the test would stage into (and reconcile against) the REAL pill state.
  process.env.RELAY_COMPANION_HOME = path.join(root, "companion-home");
  // The strict staging lock refuses to create the state directory itself
  // (production guarantees it at setup time), so the test pre-creates it.
  fs.mkdirSync(process.env.RELAY_COMPANION_HOME, { recursive: true, mode: 0o700 });
  let suppressed = [];
  let readAllAt = null;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/v1/inbox?view=summary") {
      res.end(JSON.stringify({
        items: suppressed.length ? [] : [{
          relayId: "relay_reconcile_1",
          title: "Doomed message",
          state: "delivered",
          kind: "message",
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z",
        }],
        inboxState: { suppressedItemIds: suppressed, restoredAtByItemId: {}, readAllAt },
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/v1/relays/packets") {
      res.end(JSON.stringify({
        packets: {
          relay_reconcile_1: {
            packet: { title: "Doomed message", forHuman: "Delete me elsewhere." },
            attachmentUrls: {},
          },
        },
      }));
      return;
    }
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "unexpected_endpoint", path: req.url }));
  });
  try {
    const address = await listen(server);
    const client = new RelayClient({ url: `http://127.0.0.1:${address.port}`, token: "dev_messages_only" });
    // First poll stages the relay into local companion state via the REAL stager.
    await pollOrdinaryRelayOnce({ client, log: () => {} });
    const statePath = companionStatePath();
    const stagedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const stagedIds = Object.keys(stagedState.packets || {});
    assert.equal(stagedIds.length, 1, "first poll stages the inbound relay locally");

    // The relay is then deleted on another surface: the server reports it suppressed.
    suppressed = [stagedIds[0]];
    await pollOrdinaryRelayOnce({ client, log: () => {} });
    const reconciled = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(Object.keys(reconciled.packets || {}), [], "suppressed relay leaves local state");
  } finally {
    await close(server);
    if (previousConfigDir === undefined) delete process.env.RELAY_CONFIG_DIR;
    else process.env.RELAY_CONFIG_DIR = previousConfigDir;
    if (previousHome === undefined) delete process.env.RELAY_COMPANION_HOME;
    else process.env.RELAY_COMPANION_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
