// Manual Computer Use probe for room-level group information and unread badges.
// It runs the real overlay against an isolated Relay home and a tiny local API
// that serves the exact Shane-owned Bugs and Features roster which exposed the
// missing-creator bug. No production account is touched.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, "..");
const electron = process.env.RELAY_ELECTRON_BIN || [
  path.join(pkgRoot, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
  path.join(pkgRoot, "..", "..", "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
].find((candidate) => fs.existsSync(candidate));
if (!electron) throw new Error("Electron is not installed");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-group-info-proof-"));
const relayHome = path.join(root, "home");
const userData = path.join(root, "user-data");
fs.mkdirSync(relayHome, { recursive: true });
fs.mkdirSync(userData, { recursive: true });

const now = new Date().toISOString();
const groupId = "grp_bugs_features_proof";
const relayId = "relay_group_info_proof";
let group = {
  id: groupId,
  name: "Bugs and Features",
  memberCount: 2,
  owned: false,
  owner: { userId: "user_shane_probe", name: "Shane Acton", email: "shane@example.com" },
  members: [
    { contactId: "contact_david", name: "David", email: "david@example.com" },
    { contactId: "contact_sven", name: "Sven Wellmann", email: "sven@example.com" },
  ],
  createdAt: now,
  updatedAt: now,
};
const contacts = [
  ...group.members,
  { contactId: "contact_blair", name: "Blair Peer", email: "blair@example.com" },
];

const json = (response, status, body) => {
  const data = Buffer.from(JSON.stringify(body));
  response.writeHead(status, { "content-type": "application/json", "content-length": String(data.length) });
  response.end(data);
};
const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (request.method === "GET" && url.pathname === "/v1/contact-groups") return json(response, 200, { groups: [group] });
  if (request.method === "GET" && url.pathname === "/v1/contacts/search") {
    const q = (url.searchParams.get("q") || "").toLowerCase();
    return json(response, 200, { query: q, matches: contacts.filter((contact) => `${contact.name} ${contact.email}`.toLowerCase().includes(q)), ambiguous: false });
  }
  const member = url.pathname.match(/^\/v1\/contact-groups\/([^/]+)\/members\/([^/]+)$/);
  if (member && decodeURIComponent(member[1]) === groupId) {
    const contactId = decodeURIComponent(member[2]);
    if (request.method === "POST") {
      const contact = contacts.find((item) => item.contactId === contactId);
      if (contact && !group.members.some((item) => item.contactId === contactId)) group.members.push(contact);
    } else if (request.method === "DELETE") {
      group.members = group.members.filter((item) => item.contactId !== contactId);
    } else return json(response, 405, { error: "method_not_allowed" });
    group = { ...group, memberCount: group.members.length, updatedAt: new Date().toISOString() };
    return json(response, 200, { group });
  }
  return json(response, 404, { error: "not_found" });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const apiUrl = `http://127.0.0.1:${address.port}`;

fs.writeFileSync(path.join(relayHome, "state.json"), JSON.stringify({
  version: 1,
  account: {},
  profile: { name: "David", handle: "david", email: "david@example.com", inboxDir: "", contactCardRoots: [], transport: { type: "relay_api" } },
  contacts: [],
  packets: {
    [relayId]: {
      direction: "inbound",
      state: "unread",
      relayNotificationKind: "plain_relay",
      senderName: "Shane Acton",
      senderUserId: "user_shane_probe",
      recipientGroupId: groupId,
      recipientGroupName: group.name,
      groupSendId: "send_group_info_proof",
      title: "Group information proof",
      forHuman: "The open room should expose the group roster and creator controls.",
      forAgent: "",
      createdAt: now,
      updatedAt: now,
    },
  },
  meetingNotes: {}, setup: {}, emailThreads: {}, chats: {},
}, null, 2));
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
  deviceToken: "probe-token",
  deviceId: "probe-device",
  deviceName: "Relay Group Info Probe",
  user: { id: "user_david_probe", name: "David", email: "david@example.com" },
}, null, 2));

console.log(`RELAY_GROUP_INFO_PROBE_ROOT=${root}`);
console.log(`RELAY_GROUP_INFO_PROBE_API=${apiUrl}`);

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
    RELAY_API_URL: apiUrl,
    RELAY_WEB_URL: apiUrl,
    RELAY_AUTO_UPDATE: "0",
  },
  stdio: "inherit",
});

const stop = () => {
  try { child.kill("SIGTERM"); } catch {}
  try { server.close(); } catch {}
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("exit", stop);
process.exitCode = await new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 0)));
