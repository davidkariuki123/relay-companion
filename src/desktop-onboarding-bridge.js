import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import onboarding from "./desktop-onboarding.cjs";
import { atomicWrite } from "../skill/relay/scripts/relay-protocol.mjs";
const { initialRun, reduce, createRunStore, GUIDE_VERSION } = onboarding;
const MAX_BYTES = 8192;
function equal(a, b) {
  const left = Buffer.from(String(a || "")), right = Buffer.from(String(b || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}
export async function startDesktopOnboardingBridge({ directory, authorization, verifyAccount, isPaired = () => false, onChange = async () => {} }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const store = createRunStore(directory);
  let state = store.read() || store.write(initialRun());
  const capability = randomBytes(32).toString("base64url");
  const suffix = createHash("sha256").update(directory).digest("hex").slice(0, 16);
  const endpoint = process.platform === "win32" ? `\\\\.\\pipe\\relay-onboarding-${suffix}-${randomBytes(8).toString("hex")}` : path.join(directory, "onboarding.sock");
  const descriptor = path.join(directory, "onboarding-bridge.json");
  let queue = Promise.resolve();
  const emit = async (type, fields = {}) => {
    state = store.write(reduce(state, { ...fields, type, runId: state.id, revision: state.revision }));
    await onChange(state); return state;
  };
  async function handle(input) {
    if (!equal(input.capability, capability) || input.run !== state.id) throw new Error("Setup changed; reopen the local prompt");
    if (!["start", "status", "ready"].includes(input.operation)) throw new Error("Unsupported setup operation");
    if (input.operation === "start") {
      if (["cancelled", "complete"].includes(state.stage)) return state;
      if (state.stage === "prompt") await emit("AGENT_STARTED", { guideVersion: input.guideVersion, host: input.host });
      if (state.stage === "connecting") {
        if (await isPaired()) {
          const account = await verifyAccount();
          await emit("ACCOUNT_SAVED", { accountId: account?.id });
        } else {
          await authorization.signIn({setupIntent:state.context?.setupIntent});
          await emit("AUTH_OPENED");
        }
      }
    }
    if (input.operation === "ready") {
      if (state.stage === "verifying") {
        const account = await verifyAccount();
        if (input.accountId !== account?.id || account?.id !== state.accountId) throw new Error("Your agent and Relay use different accounts");
        await emit("HOST_VERIFIED", { accountId: account.id });
      } else if (!["teaching", "sent", "link", "complete"].includes(state.stage)) throw new Error("Finish browser connection first");
    }
    return state;
  }
  async function reconcileAuthorization() {
    if (["browser", "finishing"].includes(state.stage)) {
      const auth = await authorization.state();
      if (["approved", "consumed"].includes(auth.status)) {
        if (state.stage === "browser") await emit("AUTH_APPROVED");
        await authorization.resume();
        const account = await verifyAccount();
        if (!account?.id) throw new Error("Account verification is incomplete");
        await emit("ACCOUNT_SAVED", { accountId: account.id, context: auth.onboardingContext });
      }
      if (auth.status === "expired") throw new Error("Connection expired. Restart setup in Relay.");
    }
  }
  // Never remove a socket belonging to a live process. Only reclaim refused stale sockets.
  if (process.platform !== "win32" && fs.existsSync(endpoint)) {
    await new Promise((resolve, reject) => {
      const probe = net.connect(endpoint);
      probe.once("connect", () => { probe.destroy(); reject(new Error("Onboarding bridge is already running")); });
      probe.once("error", error => { if (error.code === "ECONNREFUSED" || error.code === "ENOENT") { fs.rmSync(endpoint, { force: true }); resolve(); } else reject(error); });
    });
  }
  const server = net.createServer(socket => {
    let input = "", handled = false;
    socket.setTimeout(10000, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", bytes => {
      if (handled) return;
      input += bytes.toString("utf8");
      if (Buffer.byteLength(input) > MAX_BYTES) { socket.destroy(); return; }
      if (!input.includes("\n")) return;
      handled = true;
      queue = queue.catch(() => {}).then(async () => {
        let request;
        try { request = JSON.parse(input); const result = await handle(request); socket.end(JSON.stringify({ ok: true, state: result }) + "\n"); }
        catch (error) {
          if (equal(request?.capability, capability) && request?.run === state.id && ["connecting", "browser", "finishing", "verifying"].includes(state.stage)) await emit("FAILED", { message: error.message });
          socket.end(JSON.stringify({ ok: false, error: error.message }) + "\n");
        }
      });
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(endpoint, resolve); });
  if (process.platform !== "win32") fs.chmodSync(endpoint, 0o600);
  atomicWrite(descriptor, { endpoint, capability, run: state.id, guideVersion: GUIDE_VERSION });
  const serialize = operation => { const next = queue.catch(() => {}).then(operation); queue = next; return next; };
  let reconciling = false;
  const poll = setInterval(() => {
    if (reconciling || !["browser", "finishing"].includes(state.stage)) return;
    reconciling = true;
    void serialize(async () => {
      try { await reconcileAuthorization(); }
      catch (error) { if (!state.error) await emit("FAILED", { message: error.message }); }
    }).finally(() => { reconciling = false; });
  }, 750);
  poll.unref();
  return { state: () => state,
    adoptIntent: (intent) => serialize(async () => {
      if(state.stage !== "prompt")throw new Error("Finish or cancel the current setup before opening another invitation");
      if(!/^dsi_[A-Za-z0-9_-]{16,100}$/.test(intent?.id||""))throw new Error("Invalid setup entry");
      state=store.write({...state,revision:state.revision+1,entry:intent.invite?"invite":intent.share?"share":"home",context:{setupIntent:intent.id}});
      await onChange(state);return state;
    }),
    observeHistory: ({accountId,relayId,link}) => serialize(async () => {
      if (state.accountId !== accountId || !["teaching", "sent"].includes(state.stage)) return state;
      if (link?.relayId && link?.url) return emit("LINK_CREATED", {accountId,relayId:link.relayId,url:link.url});
      if (state.stage === "teaching" && relayId) return emit("SEND_CONFIRMED", {accountId,relayId});
      return state;
    }),
    complete: (accountId) => serialize(async () => {
      if (state.stage === "complete") return state;
      const account = await verifyAccount();
      if (account?.id !== accountId) throw new Error("Relay account changed");
      return emit("COMPLETED", { accountId });
    }),
    cancel: () => serialize(async () => { await authorization.cancel(); return emit("CANCELLED"); }),
    restart: () => serialize(async () => {
      await authorization.cancel(); state = store.write(initialRun({ entry: state.entry, context: state.context }));
      atomicWrite(descriptor, { endpoint, capability, run: state.id, guideVersion: GUIDE_VERSION });
      await onChange(state); return state;
    }),
    close: async () => { clearInterval(poll); await queue; await new Promise(resolve => server.close(resolve)); fs.rmSync(descriptor, { force: true }); } };
}
export async function callDesktopOnboarding({ directory, operation, run, host, guideVersion, accountId }) {
  const descriptor = JSON.parse(fs.readFileSync(path.join(directory, "onboarding-bridge.json"), "utf8"));
  if (descriptor.run !== run) throw new Error("This prompt belongs to an older setup. Copy the current prompt from Relay.");
  return new Promise((resolve, reject) => {
    const socket = net.connect(descriptor.endpoint); let body = "";
    socket.setTimeout(30000, () => socket.destroy(new Error("Relay setup did not respond")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ capability: descriptor.capability, operation, run, host, guideVersion, accountId }) + "\n"));
    socket.on("data", bytes => { body += bytes.toString("utf8"); if (Buffer.byteLength(body) > MAX_BYTES) socket.destroy(new Error("Invalid setup response")); });
    socket.on("end", () => { try { const value = JSON.parse(body); if (!value.ok) throw new Error(value.error); resolve(value.state); } catch (error) { reject(error); } });
  });
}
