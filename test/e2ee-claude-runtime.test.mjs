import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readE2eeClaudeStatus,
  requestE2eeClaudeConnection,
  waitForE2eeClaudeConnection,
} from "../src/e2ee-claude-control.js";
import {
  createE2eeClaudeRuntimeController,
  startE2eeClaudeRuntime,
} from "../src/e2ee-claude-runtime.js";

const identity = {
  userId: "user_runtime",
  deviceId: "device_runtime",
  fingerprint: "f".repeat(43),
  signaturePublicKey: "p".repeat(43),
  privateKeyJwk: { kty: "OKP" },
};

test("runtime joins device HTTPS, OAuth and blind tunnel without a static bearer", async () => {
  const calls = [];
  const client = {
    async e2eeRemoteTunnelLease() {
      return {
        endpointId: "abc123abc123abc123",
        lease: "short-lived-lease",
        control: { host: "tunnel.mcp.test", port: 443, tls: true },
      };
    },
  };
  const oauth = { openEnrollmentWindow: () => ({ expiresAt: "later" }) };
  const origin = {
    url: "https://127.0.0.1:43210/mcp",
    server: { setSecureContext: (value) => calls.push(["renew", value]) },
    close: async () => calls.push(["origin-stop"]),
  };
  class Tunnel {
    constructor(options) { this.options = options; calls.push(["tunnel", options]); }
    async start() { calls.push(["tunnel-start"]); }
    async stop() { calls.push(["tunnel-stop"]); }
  }
  const runtime = await startE2eeClaudeRuntime({
    client,
    identity,
    certificateProvider: async () => ({
      endpoint: {
        endpointId: "abc123abc123abc123",
        url: "https://abc123abc123abc123.mcp.test/mcp",
      },
      key: "PRIVATE DEVICE TLS KEY",
      cert: "PUBLIC CERTIFICATE",
      renewed: false,
    }),
    oauthFactory: (options) => { calls.push(["oauth", options]); return oauth; },
    originStarter: async (options) => { calls.push(["origin", options]); return origin; },
    TunnelClient: Tunnel,
    renewalIntervalMs: 60_000,
  });
  const originOptions = calls.find(([name]) => name === "origin")[1];
  assert.equal(originOptions.token, undefined);
  assert.deepEqual(originOptions.tls, { key: "PRIVATE DEVICE TLS KEY", cert: "PUBLIC CERTIFICATE" });
  const tunnel = calls.find(([name]) => name === "tunnel")[1];
  assert.equal(tunnel.gatewayHost, "tunnel.mcp.test");
  assert.equal(tunnel.gatewayPort, 443);
  assert.equal(tunnel.localPort, 43210);
  assert.deepEqual(await tunnel.leaseProvider(), {
    endpointId: "abc123abc123abc123",
    lease: "short-lived-lease",
    control: { host: "tunnel.mcp.test", port: 443, tls: true },
  });
  assert.equal(runtime.endpointUrl, "https://abc123abc123abc123.mcp.test/mcp");
  await runtime.stop();
  assert.deepEqual(calls.slice(-2), [["tunnel-stop"], ["origin-stop"]]);
});

test("the pill request opens one daemon enrollment window and returns readiness", async () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-claude-control-"));
  const controlOptions = { homeDir };
  const request = requestE2eeClaudeConnection(identity, controlOptions);
  let starts = 0;
  let windows = 0;
  const controller = createE2eeClaudeRuntimeController({
    client: {},
    identity,
    controlOptions,
    runtimeStarter: async () => {
      starts += 1;
      return {
        endpointUrl: "https://abc123abc123abc123.mcp.test/mcp",
        openEnrollmentWindow: () => { windows += 1; return { expiresAt: "2026-09-01T00:15:00.000Z" }; },
        stop: async () => {},
      };
    },
  });
  const status = await controller.tick();
  assert.equal(status.ready, true);
  assert.equal(status.handledRequestId, request.requestId);
  assert.equal(starts, 1);
  assert.equal(windows, 1);
  await controller.tick();
  assert.equal(starts, 1);
  assert.equal(windows, 1, "one click cannot repeatedly extend enrollment");
  assert.equal(readE2eeClaudeStatus(identity, controlOptions).endpointUrl, status.endpointUrl);
  assert.equal((await waitForE2eeClaudeConnection(identity, request.requestId, {
    ...controlOptions, timeoutMs: 50, pollMs: 1,
  })).ready, true);
  await controller.stop();
});

test("invalid tunnel control data fails closed and cleans up the HTTPS origin", async () => {
  let closed = false;
  await assert.rejects(startE2eeClaudeRuntime({
    client: {
      async e2eeRemoteTunnelLease() {
        return { endpointId: "abc123abc123abc123", lease: "lease", control: { host: "gateway", port: 443, tls: false } };
      },
    },
    identity,
    certificateProvider: async () => ({
      endpoint: { endpointId: "abc123abc123abc123", url: "https://abc123abc123abc123.mcp.test/mcp" },
      key: "key", cert: "cert",
    }),
    oauthFactory: () => ({}),
    originStarter: async () => ({
      url: "https://127.0.0.1:43210/mcp",
      close: async () => { closed = true; },
    }),
  }), /invalid encrypted tunnel lease/i);
  assert.equal(closed, true);
});
