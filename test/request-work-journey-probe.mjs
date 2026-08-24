// Manual Computer Use probe for the complete Task -> Work journey.
// It runs the real overlay and provider runtime in an isolated Relay home.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(here, "..");
const electron = [
  process.env.RELAY_PARITY_ELECTRON,
  path.join(packageRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
  path.join(packageRoot, "..", "..", "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
].filter(Boolean).find((candidate) => fs.existsSync(candidate));
if (!electron) throw new Error("Electron is not installed");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-request-journey-proof-"));
const relayHome = path.join(root, "home");
const userData = path.join(root, "user-data");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const now = new Date().toISOString();
const relayId = "relay_local_request_journey_proof";
fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
  version: 1,
  account: {},
  profile: {
    name: "David",
    handle: "david",
    email: "david@example.com",
    inboxDir: "",
    contactCardRoots: [],
    transport: { type: "relay_api" },
  },
  contacts: [],
  packets: {
    [relayId]: {
      id: relayId,
      direction: "inbound",
      state: "read",
      relayNotificationKind: "task",
      senderName: "Journey Fixture",
      senderUserId: "user_request_journey_fixture",
      title: "Verify Task journey",
      forHuman: "This is an isolated UI proof. Human replies stay addressed to Journey Fixture.",
      forAgent: "Reply with exactly REQUEST_JOURNEY_OK. Do not use tools.",
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
  deviceToken: "request-journey-probe-token",
  deviceId: "request-journey-probe-device",
  deviceName: "Task Journey Probe",
  user: { id: "user_david_probe", name: "David", email: "david@example.com" },
}, null, 2));

console.log(`RELAY_REQUEST_JOURNEY_ROOT=${root}`);
console.log(`RELAY_REQUEST_JOURNEY_ID=${relayId}`);
console.log(`RELAY_REQUEST_JOURNEY_ELECTRON=${electron}`);

const child = spawn(electron, [path.join(packageRoot, "overlay", "main.cjs")], {
  env: {
    ...process.env,
    RELAY_HOME: relayHome,
    RELAY_OVERLAY_USER_DATA: userData,
    RELAY_OVERLAY_TEST: "1",
    RELAY_OVERLAY_TEST_ONSCREEN: "1",
    RELAY_OVERLAY_TEST_RECORDING: "1",
    RELAY_OVERLAY_TEST_TOPMOST: "1",
    RELAY_OVERLAY_TEST_FORCE_ACTIVE: "1",
    RELAY_OVERLAY_TEST_IGNORE_POINTER: "1",
    RELAY_OVERLAY_TEST_NO_HOST_OPEN: "1",
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
