// Manual Computer Use probe for the ordinary Relay -> local Work transition.
// It runs the real overlay and real provider adapters in an isolated Relay home.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, "..");
const electron = [
  path.join(pkgRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
  path.join(pkgRoot, "..", "..", "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
].find((candidate) => fs.existsSync(candidate));
if (!electron) throw new Error("Electron is not installed");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-work-face-proof-"));
const relayHome = path.join(root, "home");
const userData = path.join(root, "user-data");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const now = new Date().toISOString();
const id = "relay_local_agent_work_proof";
fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
  version: 1,
  account: {},
  profile: { name: "David", handle: "david", email: "david@example.com", inboxDir: "", contactCardRoots: [], transport: { type: "relay_api" } },
  contacts: [],
  packets: {
    [id]: {
      direction: "inbound",
      state: "unread",
      relayNotificationKind: "plain_relay",
      senderName: "Shane Acton",
      senderUserId: "user_shane_probe",
      title: "Prove agent work transition",
      forHuman: "This is an isolated UI proof. The human reply stays addressed to Shane.",
      forAgent: "Reply with exactly RELAY_AGENT_WORK_OK. Do not use tools.",
      createdAt: now,
      updatedAt: now,
    },
  },
  meetingNotes: {},
  setup: {},
  emailThreads: {},
  chats: {},
}, null, 2));
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
  deviceToken: "probe-token",
  deviceId: "probe-device",
  deviceName: "Relay Work Probe",
  user: { id: "user_david_probe", name: "David", email: "david@example.com" },
}, null, 2));

console.log(`RELAY_WORK_PROBE_ROOT=${root}`);
console.log(`RELAY_WORK_PROBE_ID=${id}`);

const child = spawn(electron, [path.join(pkgRoot, "overlay", "main.cjs")], {
  env: {
    ...process.env,
    RELAY_HOME: relayHome,
    RELAY_OVERLAY_USER_DATA: userData,
    RELAY_OVERLAY_TEST: "1",
    RELAY_OVERLAY_TEST_ONSCREEN: "1",
    RELAY_OVERLAY_TEST_FORCE_ACTIVE: "1",
    RELAY_OVERLAY_TEST_IGNORE_POINTER: "1",
    RELAY_CONFIG: path.join(root, "config.json"),
    RELAY_API_URL: "http://127.0.0.1:9",
    RELAY_WEB_URL: "http://127.0.0.1:9",
    RELAY_AUTO_UPDATE: "0",
  },
  stdio: "inherit",
});

const stop = () => { try { child.kill("SIGTERM"); } catch {} };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);
process.exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 0)));
