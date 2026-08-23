import net from "node:net";
import tls from "node:tls";

export const E2EE_TUNNEL_FRAME_VERSION = 1;
export const E2EE_TUNNEL_FRAME_HEADER_BYTES = 10;
export const E2EE_TUNNEL_MAX_FRAME_BYTES = 64 * 1024;
export const E2EE_TUNNEL_FRAME = Object.freeze({
  register: 1,
  registered: 2,
  open: 3,
  data: 4,
  close: 5,
  ping: 6,
  pong: 7,
  error: 8,
});

export function encodeE2eeTunnelFrame(type, streamId = 0, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (!Number.isInteger(type) || type < 1 || type > 255) throw new Error("Invalid E2EE tunnel frame type");
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > 0xffffffff) throw new Error("Invalid E2EE tunnel stream id");
  if (body.length > E2EE_TUNNEL_MAX_FRAME_BYTES) throw new Error("E2EE tunnel frame is too large");
  const header = Buffer.allocUnsafe(E2EE_TUNNEL_FRAME_HEADER_BYTES);
  header.writeUInt8(E2EE_TUNNEL_FRAME_VERSION, 0);
  header.writeUInt8(type, 1);
  header.writeUInt32BE(streamId, 2);
  header.writeUInt32BE(body.length, 6);
  return body.length ? Buffer.concat([header, body]) : header;
}

export class E2eeTunnelFrameDecoder {
  constructor() {
    this.buffered = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) throw new Error("E2EE tunnel input must be bytes");
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : Buffer.from(chunk);
    const frames = [];
    while (this.buffered.length >= E2EE_TUNNEL_FRAME_HEADER_BYTES) {
      if (this.buffered.readUInt8(0) !== E2EE_TUNNEL_FRAME_VERSION) throw new Error("Unsupported E2EE tunnel frame version");
      const length = this.buffered.readUInt32BE(6);
      if (length > E2EE_TUNNEL_MAX_FRAME_BYTES) throw new Error("E2EE tunnel frame is too large");
      const total = E2EE_TUNNEL_FRAME_HEADER_BYTES + length;
      if (this.buffered.length < total) break;
      frames.push({
        type: this.buffered.readUInt8(1),
        streamId: this.buffered.readUInt32BE(2),
        payload: this.buffered.subarray(E2EE_TUNNEL_FRAME_HEADER_BYTES, total),
      });
      this.buffered = this.buffered.subarray(total);
    }
    if (this.buffered.length > E2EE_TUNNEL_MAX_FRAME_BYTES + E2EE_TUNNEL_FRAME_HEADER_BYTES) {
      throw new Error("E2EE tunnel frame buffer exceeded its limit");
    }
    return frames;
  }
}

function frameChunks(type, streamId, payload) {
  const frames = [];
  for (let offset = 0; offset < payload.length; offset += E2EE_TUNNEL_MAX_FRAME_BYTES) {
    frames.push(encodeE2eeTunnelFrame(type, streamId, payload.subarray(offset, offset + E2EE_TUNNEL_MAX_FRAME_BYTES)));
  }
  return frames;
}

function defaultGatewayConnect({ host, port, servername }) {
  return tls.connect({ host, port, servername, minVersion: "TLSv1.3", rejectUnauthorized: true });
}

function defaultLocalConnect({ host, port }) {
  return net.connect({ host, port });
}

/**
 * Multiplex opaque public TLS connections from the blind gateway into the
 * device-owned HTTPS origin. DATA frames are never parsed or logged here.
 */
export class E2eeMcpTunnelClient {
  constructor({
    gatewayHost,
    gatewayPort = 8443,
    gatewayServerName = gatewayHost,
    localHost = "127.0.0.1",
    localPort,
    leaseProvider,
    connectGateway = defaultGatewayConnect,
    connectLocal = defaultLocalConnect,
    reconnect = true,
    reconnectMinMs = 1_000,
    reconnectMaxMs = 30_000,
    pingIntervalMs = 25_000,
  } = {}) {
    if (!gatewayHost) throw new Error("E2EE tunnel gateway host is required");
    if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error("E2EE tunnel local port is required");
    if (typeof leaseProvider !== "function") throw new Error("E2EE tunnel lease provider is required");
    this.options = {
      gatewayHost,
      gatewayPort,
      gatewayServerName,
      localHost,
      localPort,
      leaseProvider,
      connectGateway,
      connectLocal,
      reconnect,
      reconnectMinMs,
      reconnectMaxMs,
      pingIntervalMs,
    };
    this.gateway = null;
    this.decoder = null;
    this.streams = new Map();
    this.stopped = true;
    this.connecting = null;
    this.reconnectDelayMs = reconnectMinMs;
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  start() {
    if (!this.stopped) return this.connecting || Promise.resolve();
    this.stopped = false;
    this.connecting = this.#connect();
    return this.connecting;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    this.reconnectTimer = null;
    this.pingTimer = null;
    const gateway = this.gateway;
    this.gateway = null;
    for (const stream of this.streams.values()) stream.destroy();
    this.streams.clear();
    if (gateway && !gateway.destroyed) {
      await new Promise((resolve) => {
        gateway.once("close", resolve);
        gateway.destroy();
      });
    }
  }

  #write(type, streamId, payload = Buffer.alloc(0)) {
    if (!this.gateway || this.gateway.destroyed) return false;
    return this.gateway.write(encodeE2eeTunnelFrame(type, streamId, payload));
  }

  #closeStream(streamId, { notify = true } = {}) {
    const stream = this.streams.get(streamId);
    if (!stream) return;
    this.streams.delete(streamId);
    if (notify) this.#write(E2EE_TUNNEL_FRAME.close, streamId);
    if (!stream.destroyed) stream.destroy();
  }

  #openLocal(streamId) {
    if (!streamId || this.streams.has(streamId)) throw new Error("Invalid duplicate E2EE tunnel stream");
    const stream = this.options.connectLocal({ host: this.options.localHost, port: this.options.localPort });
    this.streams.set(streamId, stream);
    stream.setNoDelay?.(true);
    stream.on("data", (chunk) => {
      if (!this.gateway || this.gateway.destroyed) return stream.destroy();
      let writable = true;
      for (const frame of frameChunks(E2EE_TUNNEL_FRAME.data, streamId, chunk)) {
        writable = this.gateway.write(frame) && writable;
      }
      if (!writable) stream.pause();
    });
    stream.on("drain", () => this.gateway?.resume());
    stream.on("close", () => {
      if (this.streams.get(streamId) !== stream) return;
      this.streams.delete(streamId);
      this.#write(E2EE_TUNNEL_FRAME.close, streamId);
    });
    stream.on("error", () => this.#closeStream(streamId));
  }

  #handleFrame(frame, registered) {
    if (!registered.done) {
      if (frame.type === E2EE_TUNNEL_FRAME.error) throw new Error(frame.payload.toString("utf8") || "E2EE tunnel registration failed");
      if (frame.type !== E2EE_TUNNEL_FRAME.registered || frame.streamId !== 0) throw new Error("E2EE tunnel gateway did not accept registration");
      registered.done = true;
      this.reconnectDelayMs = this.options.reconnectMinMs;
      registered.resolve();
      return;
    }
    if (frame.type === E2EE_TUNNEL_FRAME.pong && frame.streamId === 0) return;
    if (frame.type === E2EE_TUNNEL_FRAME.open) return this.#openLocal(frame.streamId);
    const stream = this.streams.get(frame.streamId);
    if (!stream) throw new Error("E2EE tunnel gateway referenced an unknown stream");
    if (frame.type === E2EE_TUNNEL_FRAME.data) {
      if (!stream.write(frame.payload)) this.gateway?.pause();
      return;
    }
    if (frame.type === E2EE_TUNNEL_FRAME.close) return this.#closeStream(frame.streamId, { notify: false });
    if (frame.type === E2EE_TUNNEL_FRAME.error) throw new Error(frame.payload.toString("utf8") || "E2EE tunnel gateway error");
    throw new Error("Invalid E2EE tunnel gateway frame");
  }

  async #connect() {
    const registration = await this.options.leaseProvider();
    if (this.stopped) return;
    const endpointId = String(registration?.endpointId || "").toLowerCase();
    const lease = String(registration?.lease || "");
    if (!endpointId || !lease) throw new Error("E2EE tunnel lease provider returned no endpoint or lease");
    this.decoder = new E2eeTunnelFrameDecoder();
    const gateway = this.options.connectGateway({
      host: this.options.gatewayHost,
      port: this.options.gatewayPort,
      servername: this.options.gatewayServerName,
    });
    this.gateway = gateway;
    gateway.setNoDelay?.(true);
    gateway.setKeepAlive?.(true, 30_000);

    let settled = false;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const registered = {
      done: false,
      resolve: () => { if (!settled) { settled = true; resolveReady(); } },
    };
    const fail = (error) => {
      if (!settled) {
        settled = true;
        rejectReady(error instanceof Error ? error : new Error(String(error)));
      }
      gateway.destroy();
    };
    gateway.once(gateway.encrypted ? "secureConnect" : "connect", () => {
      gateway.write(encodeE2eeTunnelFrame(
        E2EE_TUNNEL_FRAME.register,
        0,
        JSON.stringify({ endpointId, lease }),
      ));
    });
    gateway.on("data", (chunk) => {
      try {
        for (const frame of this.decoder.push(chunk)) this.#handleFrame(frame, registered);
      } catch (error) {
        fail(error);
      }
    });
    gateway.on("drain", () => {
      for (const stream of this.streams.values()) stream.resume();
    });
    gateway.once("error", fail);
    gateway.once("close", () => {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.gateway === gateway) this.gateway = null;
      for (const stream of this.streams.values()) stream.destroy();
      this.streams.clear();
      if (!settled) {
        settled = true;
        rejectReady(new Error("E2EE tunnel closed before registration completed"));
      }
      if (!this.stopped && this.options.reconnect) {
        const delay = this.reconnectDelayMs;
        this.reconnectDelayMs = Math.min(this.options.reconnectMaxMs, Math.max(delay + 1, delay * 2));
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connecting = this.#connect().catch(() => {});
        }, delay);
        this.reconnectTimer.unref?.();
      }
    });

    await ready;
    if (!this.stopped) {
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        this.#write(E2EE_TUNNEL_FRAME.ping, 0, Buffer.from(String(Date.now())));
      }, this.options.pingIntervalMs);
      this.pingTimer.unref?.();
    }
  }
}
