import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import { invitationShareCopy } from "../../shared/dist/agent-guide.js";

const main = readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const start = main.indexOf('ipcMain.handle("relay:copyOnboardingInviteLink"');
const handler = main.slice(start, main.indexOf('ipcMain.handle("relay:e2eeDeviceApprovals"', start));
const require = createRequire(new URL("../overlay/main.cjs", import.meta.url));

async function copy(invite, requestedAccount) {
  let callback, clipboard;
  const identity = { userId: "david", key: "account-david", credential: "device-key" };
  vm.runInNewContext(handler, {
    ipcMain: { handle: (_name, fn) => { callback = fn; } },
    networkOnboardingIdentity: () => identity,
    deviceToken: () => identity.credential,
    relayClient: async () => ({ inviteLink: async () => invite }),
    clipboard: { writeText: text => { clipboard = text; } },
    URL, require,
  });
  return { result: await callback({}, requestedAccount), clipboard };
}

test("Copy link puts the complete canonical invitation and short URL on the clipboard", async () => {
  const url = "https://sendrelays.com/i/david";
  const expected = invitationShareCopy(url).shareText;
  for (const invite of [{ url, shareText: expected }, { url }]) {
    const { result, clipboard } = await copy(invite, "david");
    assert.equal(result.ok, true);
    assert.equal(result.url, url);
    assert.equal(clipboard, expected);
    assert.ok(clipboard.includes("Please help me connect on Relay using this invitation:"));
  }
});

test("unsafe links and a changed account never touch the clipboard", async () => {
  for (const [url, account] of [["javascript:alert(1)", "david"], ["https://sendrelays.com/i/david", "someone-else"]]) {
    const { result, clipboard } = await copy({ url }, account);
    assert.equal(result.ok, false);
    assert.equal(clipboard, undefined);
  }
});


test("per-Relay Copy link explains the message and preserves the browser fallback", async () => {
  const html = readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
  const start = html.indexOf('    for (const btn of sentListEl.querySelectorAll("[data-sent-copy-link]"))');
  assert.ok(start >= 0);
  const end = html.indexOf("\n  }\n\n  // ---------- Tasks view", start);
  assert.ok(end > start);
  let onClick, copied, note;
  const url = "https://sendrelays.com/s/test-share";
  vm.runInNewContext(html.slice(start, end), {
    sentListEl: { querySelectorAll: () => [{
      getAttribute: name => name === "data-share-url" ? url : "relay_test",
      addEventListener: (_event, fn) => { onClick = fn; },
    }] },
    navigator: { clipboard: { writeText: async text => { copied = text; } } },
    setRowNote: (_id, text, status) => { note = { text, status }; },
  });
  await onClick();
  assert.equal(copied, `I sent you a Relay. Paste this into Claude Code or Codex to read it, or just click the link:\n${url}`);
  assert.deepEqual(note, { text: "Link copied", status: "ok" });
});
