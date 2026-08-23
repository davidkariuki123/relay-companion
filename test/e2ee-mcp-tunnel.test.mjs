import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  E2EE_TUNNEL_FRAME,
  E2EE_TUNNEL_MAX_FRAME_BYTES,
  E2eeMcpTunnelClient,
  E2eeTunnelFrameDecoder,
  encodeE2eeTunnelFrame,
} from "../src/e2ee-mcp-tunnel.js";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("Companion tunnel frames survive fragmented and coalesced transport", () => {
  const decoder = new E2eeTunnelFrameDecoder();
  const first = encodeE2eeTunnelFrame(E2EE_TUNNEL_FRAME.open, 7);
  const second = encodeE2eeTunnelFrame(E2EE_TUNNEL_FRAME.data, 7, Buffer.alloc(E2EE_TUNNEL_MAX_FRAME_BYTES, 9));
  const wire = Buffer.concat([first, second]);
  assert.deepEqual(decoder.push(wire.subarray(0, 3)), []);
  const frames = decoder.push(wire.subarray(3));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].type, E2EE_TUNNEL_FRAME.open);
  assert.equal(frames[1].payload.length, E2EE_TUNNEL_MAX_FRAME_BYTES);
});

test("Companion multiplexes opaque gateway bytes into its local origin", { timeout: 5_000 }, async (t) => {
  const events = [];
  let tunnelClient = null;
  let gatewayServer = null;
  const local = net.createServer((socket) => {
    events.push("local-connected");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      events.push(`local-data:${chunk.length}`);
      socket.write(Buffer.from(chunk).reverse());
    });
  });
  const localPort = await listen(local);
  t.after(async () => {
    await tunnelClient?.stop();
    if (gatewayServer?.listening) await close(gatewayServer);
    if (local.listening) await close(local);
  });

  let registerPayload = null;
  const returned = new Promise((resolve, reject) => {
    const gateway = net.createServer((socket) => {
      socket.on("error", () => {});
      const decoder = new E2eeTunnelFrameDecoder();
      socket.on("data", (chunk) => {
        try {
          for (const frame of decoder.push(chunk)) {
            if (frame.type === E2EE_TUNNEL_FRAME.register) {
              events.push("registered-request");
              registerPayload = JSON.parse(frame.payload.toString("utf8"));
              socket.write(Buffer.concat([
                encodeE2eeTunnelFrame(E2EE_TUNNEL_FRAME.registered, 0, JSON.stringify({ expiresAt: 9999999999 })),
                encodeE2eeTunnelFrame(E2EE_TUNNEL_FRAME.open, 41),
                encodeE2eeTunnelFrame(E2EE_TUNNEL_FRAME.data, 41, Buffer.from("opaque-inner-tls-bytes")),
              ]));
            } else if (frame.type === E2EE_TUNNEL_FRAME.data && frame.streamId === 41) {
              events.push(`gateway-data:${frame.payload.length}`);
              resolve(frame.payload.toString("utf8"));
              socket.write(encodeE2eeTunnelFrame(E2EE_TUNNEL_FRAME.close, 41));
            }
          }
        } catch (error) {
          reject(error);
        }
      });
    });
    gatewayServer = gateway;
    listen(gateway).then((gatewayPort) => {
      const client = new E2eeMcpTunnelClient({
        gatewayHost: "127.0.0.1",
        gatewayPort,
        localPort,
        leaseProvider: async () => ({ endpointId: "abc123abc123abc1", lease: "signed-lease" }),
        connectGateway: ({ host, port }) => net.connect({ host, port }),
        reconnect: false,
      });
      tunnelClient = client;
      return client.start();
    }).catch(reject);
  });

  const value = await returned;
  assert.equal(value, "setyb-slt-renni-euqapo");
  assert.deepEqual(registerPayload, { endpointId: "abc123abc123abc1", lease: "signed-lease" });
});

test("Companion refuses oversized or version-confused tunnel frames", () => {
  const tooLarge = Buffer.alloc(10);
  tooLarge.writeUInt8(1, 0);
  tooLarge.writeUInt8(E2EE_TUNNEL_FRAME.data, 1);
  tooLarge.writeUInt32BE(1, 2);
  tooLarge.writeUInt32BE(E2EE_TUNNEL_MAX_FRAME_BYTES + 1, 6);
  assert.throws(() => new E2eeTunnelFrameDecoder().push(tooLarge), /too large/i);

  const wrongVersion = Buffer.from(encodeE2eeTunnelFrame(E2EE_TUNNEL_FRAME.ping));
  wrongVersion.writeUInt8(2, 0);
  assert.throws(() => new E2eeTunnelFrameDecoder().push(wrongVersion), /Unsupported.*version/i);
});
