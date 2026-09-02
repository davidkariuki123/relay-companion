import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { nativeCredentialAccessAllowed } from "../src/config.js";

// Windows Credential Manager is machine-global, so a CUSTOM config path must
// opt in before touching it. The shared MCP broker is not a custom path: it is
// launched with RELAY_CONFIG_DIR pinned to the default ~/.relay so every host
// shares one state, and refusing that left every Windows MCP tool call without
// a token while the daemon and pill authenticated fine.
const home = path.join("C:", "Users", "shane");

test("the default config directory keeps native credential access on Windows", () => {
  assert.equal(nativeCredentialAccessAllowed({}, "win32", home), true);
  assert.equal(nativeCredentialAccessAllowed({ RELAY_CONFIG_DIR: path.join(home, ".relay") }, "win32", home), true);
  assert.equal(nativeCredentialAccessAllowed({ RELAY_CONFIG_DIR: path.join(home, ".relay", "..", ".relay") }, "win32", home), true);
});

test("a custom config path still needs the explicit opt-in on Windows", () => {
  assert.equal(nativeCredentialAccessAllowed({ RELAY_CONFIG_DIR: path.join(home, "sandbox") }, "win32", home), false);
  assert.equal(nativeCredentialAccessAllowed({ RELAY_CONFIG: path.join(home, ".relay", "other.json") }, "win32", home), false);
  assert.equal(
    nativeCredentialAccessAllowed({ RELAY_CONFIG_DIR: path.join(home, "sandbox"), RELAY_NATIVE_CREDENTIALS_WITH_CUSTOM_CONFIG: "1" }, "win32", home),
    true,
  );
});

test("macOS and Linux use the local store regardless of the config path", () => {
  assert.equal(nativeCredentialAccessAllowed({ RELAY_CONFIG_DIR: "/tmp/sandbox" }, "darwin", "/Users/x"), true);
  assert.equal(nativeCredentialAccessAllowed({ RELAY_CONFIG: "/tmp/c.json" }, "linux", "/home/x"), true);
});
