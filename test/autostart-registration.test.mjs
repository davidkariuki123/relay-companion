import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import {
  autostartWillReplace,
  parseLaunchAgentProgramArguments,
  readAutostartDaemonRoot,
} from "../src/autostart-registration.js";

const RELEASES = "/Users/test/.relay/runtime/releases";
const STALE = `${RELEASES}/0.1.318-a/node_modules/relay-companion`;
const CANONICAL = `${RELEASES}/0.1.320-b/node_modules/relay-companion`;

function plistFor(bin, { node = "/opt/homebrew/bin/node" } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>work.relay.companion</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>--max-old-space-size=128</string>
    <string>${bin}</string>
    <string>daemon</string>
  </array>
  <key>KeepAlive</key><true/>
</dict>
</plist>
`;
}

const readerFor = (contents) => () => {
  if (contents === null) throw new Error("ENOENT");
  return contents;
};

test("ProgramArguments parsing keeps order and unescapes XML entities", () => {
  const args = parseLaunchAgentProgramArguments(plistFor("/tmp/a &amp; b/bin/relay.js"));
  assert.deepEqual(args, [
    "/opt/homebrew/bin/node",
    "--max-old-space-size=128",
    "/tmp/a & b/bin/relay.js",
    "daemon",
  ]);
});

test("the registration resolves to the package root, skipping node and its flags", () => {
  const registration = readAutostartDaemonRoot({
    homeDir: "/Users/test",
    platform: "darwin",
    readFileImpl: readerFor(plistFor(path.join(STALE, "bin", "relay.js"))),
  });
  assert.equal(registration.root, STALE);
  assert.equal(registration.bin, path.join(STALE, "bin", "relay.js"));
});

test("an unreadable or Relay-less registration is UNKNOWN, never an answer", () => {
  assert.equal(
    readAutostartDaemonRoot({ homeDir: "/Users/test", platform: "darwin", readFileImpl: readerFor(null) }),
    null,
  );
  assert.equal(
    readAutostartDaemonRoot({
      homeDir: "/Users/test",
      platform: "darwin",
      readFileImpl: readerFor("<plist><dict><key>Label</key><string>x</string></dict></plist>"),
    }),
    null,
  );
  assert.equal(readAutostartDaemonRoot({ homeDir: "/Users/test", platform: "linux" }), null);
});

// The regression. On 2026-08-20 the canonical pointer named 0.1.320 while the
// launchd plist still named 0.1.318. The daemon treated "the pointer names another
// tree" as proof a replacement would start, exited, and launchd restarted the same
// stale tree — 369 times, delivering nothing, because each incarnation lived ~2.7s
// against a 4s poll interval. The pointer cannot witness this; only the plist can.
test("a registration that still names THIS tree never reports a replacement", () => {
  const verdict = autostartWillReplace(STALE, {
    homeDir: "/Users/test",
    platform: "darwin",
    readImpl: () => ({ root: STALE, bin: path.join(STALE, "bin", "relay.js"), source: "plist" }),
  });
  assert.equal(verdict.willReplace, false);
  assert.equal(verdict.reason, "registration-still-names-this-tree");
});

test("a registration naming another tree is the only thing that authorises the exit", () => {
  const verdict = autostartWillReplace(STALE, {
    homeDir: "/Users/test",
    platform: "darwin",
    readImpl: () => ({ root: CANONICAL, bin: path.join(CANONICAL, "bin", "relay.js"), source: "plist" }),
  });
  assert.equal(verdict.willReplace, true);
  assert.equal(verdict.reason, "registration-names-another-tree");
});

test("an unknown registration refuses to authorise the exit", () => {
  const verdict = autostartWillReplace(STALE, {
    homeDir: "/Users/test",
    platform: "darwin",
    readImpl: () => null,
  });
  assert.equal(verdict.willReplace, false);
  assert.equal(verdict.reason, "registration-unreadable");
});

test("Windows compares case-insensitively, so a drive-letter difference is not a false replacement", () => {
  const win = "C:\\Users\\test\\.relay\\runtime\\releases\\0.1.318-a\\node_modules\\relay-companion";
  const verdict = autostartWillReplace(win, {
    platform: "win32",
    readImpl: () => ({ root: win.toUpperCase(), bin: `${win}\\bin\\relay.js`, source: "task" }),
  });
  assert.equal(verdict.willReplace, false);
});
