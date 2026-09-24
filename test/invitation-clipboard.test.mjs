import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";

const main = readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const start = main.indexOf('ipcMain.handle("relay:copyOnboardingInviteLink"');
const handler = main.slice(start, main.indexOf('ipcMain.handle("relay:installationAuthState"', start));
const require = createRequire(new URL("../overlay/main.cjs", import.meta.url));
const invitationShareCopy = require("./invitation-share-copy.cjs");

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
    assert.ok(clipboard.includes("Open this invitation to download the Relay app:"));
  }
});

test("unsafe links and a changed account never touch the clipboard", async () => {
  for (const [url, account] of [["javascript:alert(1)", "david"], ["https://sendrelays.com/i/david", "someone-else"]]) {
    const { result, clipboard } = await copy({ url }, account);
    assert.equal(result.ok, false);
    assert.equal(clipboard, undefined);
  }
});


test("per-Relay Copy link explains audience links and preserves the browser fallback", async () => {
  const html = readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
  const start = html.indexOf("  async function copyRelayLink(row) {");
  const end = html.indexOf("  function sentLinkKickerWord(", start);
  assert.ok(start >= 0 && end > start);
  let copied;
  const url = "https://sendrelays.com/s/test-share";
  const context = {
    shareableLinkOf: () => ({url}), audienceLinkOf: () => ({}),
    navigator: { clipboard: { writeText: async text => { copied = text; } } },
  };
  vm.createContext(context);
  vm.runInContext(html.slice(start, end), context);
  await context.copyRelayLink({id:"relay_test"});
  assert.equal(copied, `I sent you a Relay. Paste this into Claude Code or Codex to read it, or just click the link:\n${url}`);
  context.navigator.clipboard.writeText = async () => { throw new Error("Clipboard denied"); };
  await assert.rejects(context.copyRelayLink({id:"relay_test"}), /Clipboard denied/);
  context.audienceLinkOf = () => null;
  context.window = { relay: { copyShareLink: async value => { copied = value; return {ok:true}; } } };
  await context.copyRelayLink({id:"relay_test"});
  assert.equal(copied, url, "sent links use the native clipboard bridge");
  context.window.relay.copyShareLink = async () => ({ok:false,error:"Not copied"});
  await assert.rejects(context.copyRelayLink({id:"relay_test"}), /Not copied/);
});
