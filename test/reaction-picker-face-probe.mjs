// Manual face probe for the message reaction-picker lifecycle.
//
// Boots the real overlay against an isolated Relay home containing two messages
// from the same person. It is intentionally driven with Computer Use: open the
// Chat room, open either message picker, then verify outside click, Escape,
// scroll, room/tab changes, and opening the other picker all retire it.
// Nothing reads or writes the installed pill's state.
//
// Run: node test/reaction-picker-face-probe.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, "..");
const electron = [
  process.env.RELAY_ELECTRON_BIN,
  path.join(pkgRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
  path.join(pkgRoot, "..", "..", "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
].find((candidate) => candidate && fs.existsSync(candidate));
if (!electron) throw new Error("Electron is not installed");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reaction-picker-proof-"));
const relayHome = path.join(root, "home");
const userData = path.join(root, "user-data");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const makePacket = (title, forHuman, createdAt) => ({
  direction: "inbound",
  state: "read",
  relayNotificationKind: "plain_relay",
  senderName: "Robin Hale",
  senderUserId: "user_robin_reaction_probe",
  senderEmail: "robin@example.com",
  title,
  forHuman,
  forAgent: "",
  createdAt,
  updatedAt: createdAt,
});

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
    relay_reaction_probe_one: makePacket(
      "First reaction proof",
      "Hover this message and open its reaction picker.",
      "2026-08-14T08:00:00.000Z",
    ),
    relay_reaction_probe_two: makePacket(
      "Second reaction proof",
      "Opening this picker must close the picker above it.",
      "2026-08-14T08:01:00.000Z",
    ),
  },
  meetingNotes: {},
  setup: {},
  emailThreads: {},
  chats: {},
}, null, 2));

fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
  deviceToken: "reaction-picker-probe-token",
  deviceId: "reaction-picker-probe-device",
  deviceName: "Relay Reaction Picker Probe",
  user: { id: "user_david_probe", name: "David", email: "david@example.com" },
}, null, 2));

console.log(`RELAY_REACTION_PICKER_PROBE_ROOT=${root}`);

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

const stop = () => {
  try { child.kill("SIGTERM"); } catch {}
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);
process.exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 0)));
