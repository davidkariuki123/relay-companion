import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installDaemonAutostart, installPillAutostart } from "../src/install.js";

const STALE = "/Users/test/.relay/runtime/releases/0.1.318-a/node_modules/relay-companion";
const CANONICAL = "/Users/test/.relay/runtime/releases/0.1.320-b/node_modules/relay-companion";
const STALE_BIN = path.join(STALE, "bin", "relay.js");

const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "relay-claim-"));

const refusing = () => ({
  mayClaim: false,
  canonical: true,
  current: { packageRoot: CANONICAL, version: "0.1.320" },
  reason: "canonical-release-not-current",
});
const allowing = () => ({ mayClaim: true, canonical: true, current: null, reason: "canonical-no-pointer" });

// Registering autostart is a machine-global act: whoever writes the plist decides
// what launchd restarts from then on. On 2026-08-20 an agent ran `relay install`
// out of the previous release tree 22s after the pointer moved, and every surface
// on the machine was re-pinned to it. Guarding the WRITERS covers every caller —
// setup, install, repair-desktop, the startup migration, and whatever comes next.
test("the daemon writer refuses to register a tree the canonical runtime does not own", () => {
  const home = tempHome();
  const result = installDaemonAutostart(STALE_BIN, "/opt/homebrew/bin/node", {
    platform: "darwin",
    homeDir: home,
    reload: false,
    runCommand: () => assert.fail("a refused registration must not touch launchctl"),
    ownershipGuard: refusing,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-canonical-runtime");
  assert.equal(result.wouldRegister, STALE);
  assert.equal(result.current, CANONICAL);
  assert.match(result.message, /--claim/);
  assert.equal(
    fs.existsSync(path.join(home, "Library", "LaunchAgents", "work.relay.companion.plist")),
    false,
    "the refusal must happen before the write, not after it",
  );
});

test("the pill writer refuses on the same terms", () => {
  const result = installPillAutostart(STALE_BIN, {
    platform: "darwin",
    homeDir: tempHome(),
    reload: false,
    runCommand: () => assert.fail("a refused registration must not touch launchctl"),
    ownershipGuard: refusing,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "not-canonical-runtime");
});

test("--claim is the documented override and really does write", () => {
  const home = tempHome();
  const result = installDaemonAutostart(STALE_BIN, "/opt/homebrew/bin/node", {
    platform: "darwin",
    homeDir: home,
    reload: false,
    claim: true,
    ownershipGuard: () => assert.fail("an explicit claim must not consult the guard"),
  });
  assert.equal(result.ok, true);
  const plist = fs.readFileSync(path.join(home, "Library", "LaunchAgents", "work.relay.companion.plist"), "utf8");
  assert.ok(plist.includes(STALE_BIN));
});

test("a machine with no pointer yet — a first install — is never blocked", () => {
  const home = tempHome();
  const result = installDaemonAutostart(STALE_BIN, "/opt/homebrew/bin/node", {
    platform: "darwin",
    homeDir: home,
    reload: false,
    ownershipGuard: allowing,
  });
  assert.equal(result.ok, true);
});

// During activation the updater writes state:"activating", which readCanonicalRuntime
// deliberately reports as no pointer at all. If an unreadable guard blocked the write,
// the updater could never register the tree it is in the middle of activating.
test("an unreadable pointer proceeds rather than bricking the updater mid-activation", () => {
  const home = tempHome();
  const result = installDaemonAutostart(STALE_BIN, "/opt/homebrew/bin/node", {
    platform: "darwin",
    homeDir: home,
    reload: false,
    ownershipGuard: () => {
      throw new Error("pointer unreadable");
    },
  });
  assert.equal(result.ok, true);
});
