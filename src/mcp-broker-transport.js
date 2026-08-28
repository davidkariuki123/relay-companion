import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_BROKER_FRAME_MAX_BYTES,
  MCP_BROKER_IN_FLIGHT_MAX_BYTES,
} from "./mcp-broker-state.js";

export class BrokerFrameBudget {
  constructor(maxBytes = MCP_BROKER_IN_FLIGHT_MAX_BYTES) {
    this.maxBytes = maxBytes;
    this.usedBytes = 0;
  }

  reserve(bytes) {
    const amount = Math.max(0, Number(bytes) || 0);
    if (this.usedBytes + amount > this.maxBytes) return false;
    this.usedBytes += amount;
    return true;
  }

  release(bytes) {
    this.usedBytes = Math.max(0, this.usedBytes - Math.max(0, Number(bytes) || 0));
  }
}

export class BrokerStdioTransport {
  constructor(input, output, {
    maxBufferSize = MCP_BROKER_FRAME_MAX_BYTES,
    budget = new BrokerFrameBudget(),
  } = {}) {
    this.input = input;
    this.output = output;
    this.maxBufferSize = maxBufferSize;
    this.budget = budget;
    this.buffer = Buffer.alloc(0);
    this.inFlight = new Map();
    this.started = false;
    this.closed = false;
    this._onData = (chunk) => this.#onData(chunk);
    this._onError = (error) => this.#fail(error);
    this._onClose = () => this.close().catch(() => {});
  }

  async start() {
    if (this.started) throw new Error("BrokerStdioTransport already started");
    this.started = true;
    this.input.on("data", this._onData);
    this.input.on("error", this._onError);
    this.input.on("close", this._onClose);
    this.input.resume?.();
  }

  #onData(chunk) {
    if (this.closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!this.budget.reserve(bytes.length)) {
      this.#fail(new Error(`Relay MCP broker aggregate frame budget exceeded ${this.budget.maxBytes} bytes`));
      return;
    }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, bytes]) : bytes;
    if (this.buffer.length > this.maxBufferSize && this.buffer.indexOf(0x0a) === -1) {
      this.#fail(new Error(`Relay MCP frame exceeded ${this.maxBufferSize} bytes`));
      return;
    }
    while (!this.closed) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) break;
      const rawBytes = newline + 1;
      if (rawBytes > this.maxBufferSize) {
        this.#fail(new Error(`Relay MCP frame exceeded ${this.maxBufferSize} bytes`));
        return;
      }
      const line = this.buffer.subarray(0, newline).toString("utf8").replace(/\r$/, "");
      this.buffer = this.buffer.subarray(rawBytes);
      let message;
      try {
        message = JSONRPCMessageSchema.parse(JSON.parse(line));
      } catch (error) {
        this.budget.release(rawBytes);
        this.onerror?.(error);
        continue;
      }
      const requestId = message && Object.hasOwn(message, "id") && typeof message.method === "string"
        ? String(message.id)
        : null;
      if (requestId !== null) {
        if (this.inFlight.has(requestId)) {
          this.budget.release(rawBytes);
          this.#fail(new Error(`Relay MCP client reused in-flight request id ${requestId}`));
          return;
        }
        this.inFlight.set(requestId, rawBytes);
      } else {
        this.budget.release(rawBytes);
      }
      try {
        this.onmessage?.(message);
      } catch (error) {
        if (requestId !== null) this.releaseRequest(requestId);
        this.onerror?.(error);
      }
    }
  }

  releaseRequest(id) {
    const key = String(id);
    const bytes = this.inFlight.get(key);
    if (bytes === undefined) return;
    this.inFlight.delete(key);
    this.budget.release(bytes);
  }

  send(message) {
    if (this.closed) return Promise.reject(new Error("Relay MCP broker transport is closed"));
    const responseId = message && Object.hasOwn(message, "id") && typeof message.method !== "string"
      ? message.id
      : undefined;
    const body = `${JSON.stringify(message)}\n`;
    return new Promise((resolve, reject) => {
      const done = (error) => {
        if (responseId !== undefined) this.releaseRequest(responseId);
        if (error) reject(error);
        else resolve();
      };
      try {
        if (this.output.write(body)) done();
        else this.output.once("drain", () => done());
      } catch (error) {
        done(error);
      }
    });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.input.off("data", this._onData);
    this.input.off("error", this._onError);
    this.input.off("close", this._onClose);
    this.budget.release(this.buffer.length);
    this.buffer = Buffer.alloc(0);
    for (const bytes of this.inFlight.values()) this.budget.release(bytes);
    this.inFlight.clear();
    this.input.pause?.();
    this.onclose?.();
  }

  #fail(error) {
    if (this.closed) return;
    this.onerror?.(error);
    this.close().catch(() => {});
    this.input.destroy?.();
  }
}
