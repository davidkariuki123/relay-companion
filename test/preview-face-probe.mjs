// Face harness for the Relay preview window (companion to test/e2e-overlay.mjs).
//
// Boots the REAL preview window — overlay/preview.html plus the untouched
// overlay/preview-renderer.js — inside its own Electron process with an
// isolated userData dir, and answers its bridge with canned content instead of
// the API. Nothing here reads ~/.relay-companion or disturbs a running pill.
//
// It exists because the rest of the preview's coverage asserts on renderer
// SOURCE, which cannot see layout. The first version of the open-in-conversation
// change passed every one of those and still painted an empty window: placing
// the reader with scrollIntoView scrolled the faces track too (an overflow:hidden
// box is still programmatically scrollable), sliding the conversation out of
// view while the DOM happily reported the message centred. These checks look at
// where things actually ARE.
//
//   1. a chat message opens IN its conversation, named, with the room addressed
//   2. it lands ON the message it was opened from, and moves NOTHING but the
//      chat scroller
//   3. Escape backs out to that message, which is intact behind it
//   4. a relay with a subject of its own still opens on the reading face
//   5. a conversation that will not load hands the message back, with a reason
//
// Run: node test/preview-face-probe.mjs      (needs a GUI session; not part of
//                                             `npm test`)
// Env: PREVIEW_PROBE_SHOT=<path> also writes a PNG of the conversation face.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OVERLAY = path.join(__dirname, "..", "overlay");

app.setPath("userData", path.join(app.getPath("temp"), "relay-preview-face-probe"));
app.disableHardwareAcceleration();

const CHAT = {
  chatId: "chat_probe",
  kind: "direct",
  title: "Robin Hale",
  messageCount: 4,
  participants: [{ name: "You", self: true }, { name: "Robin Hale" }],
  items: [
    {
      relayId: "relay_subject",
      direction: "inbound",
      title: "One public hostname on the existing tunnel",
      forHuman: "Hey — one routing entry and we are done.",
      createdAt: "2026-08-07T16:30:00Z",
      state: "read",
    },
    {
      relayId: "relay_opened",
      direction: "outbound",
      title: "sending!",
      forHuman: "sending!",
      createdAt: "2026-08-07T16:41:00Z",
      state: "read",
    },
    { relayId: "relay_c", direction: "inbound", title: "got it", forHuman: "got it", createdAt: "2026-08-07T16:50:00Z", state: "read" },
    { relayId: "relay_d", direction: "inbound", title: "one more", forHuman: "one more", createdAt: "2026-08-07T16:55:00Z", state: "read" },
  ],
};

// What main.cjs projects for one of your own sent text messages.
const TEXT_MESSAGE = {
  relayId: "relay_opened",
  title: "sending!",
  forHuman: "sending!",
  senderName: "You → Robin Hale",
  createdAt: "2026-08-07T16:41:00Z",
  unread: false,
  outbound: true,
  threadId: "relay_thread",
  openFace: "chat",
};

// ...and for a relay that carries a subject of its own.
const AGENT_RELAY = {
  ...TEXT_MESSAGE,
  relayId: "relay_subject",
  title: "One public hostname on the existing tunnel",
  forHuman: "Hey — one routing entry and we are done.",
  senderName: "Robin Hale",
  outbound: false,
  openFace: "message",
};

// What main.cjs sends for a window opened from a CONTACT CARD: a room and no
// message behind it, named by the card rather than by the server.
const CONTACT_ROOM = {
  chatId: "chat_room",
  chatTitle: "Sven Wellmann",
  openFace: "chat",
};

// The same room, still empty — nobody has written to this person yet.
const EMPTY_ROOM = {
  chatId: "chat_room",
  kind: "direct",
  // The server can only offer the address when no account backs it; the card's
  // name is what the reader should see.
  title: "sven@example.com",
  messageCount: 0,
  participants: [{ name: "You", self: true }, { name: "sven@example.com" }],
  items: [],
};

let chatLoadFails = false;
let chatAnswer = CHAT;
ipcMain.handle("probe:chat", async () =>
  chatLoadFails ? { ok: false, error: "This conversation is no longer available." } : { ok: true, chat: chatAnswer },
);
let closeRequests = 0;
ipcMain.on("probe:close", () => { closeRequests += 1; });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        got  ${JSON.stringify(actual)}\n        want ${JSON.stringify(expected)}`);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 620,
    height: 520,
    show: true,
    webPreferences: {
      preload: path.join(__dirname, "preview-face-probe-preload.cjs"),
      contextIsolation: false,
      nodeIntegration: false,
      backgroundThrottling: false, // rAF must keep firing while this runs unattended
      sandbox: false,
    },
  });
  const ready = new Promise((resolve) => ipcMain.once("probe:ready", resolve));
  await win.loadFile(path.join(OVERLAY, "preview.html"));
  await ready;

  const evaluate = (js) => win.webContents.executeJavaScript(js, true);
  const open = async (payload) => {
    win.webContents.send("probe:content", payload);
    await sleep(400); // render + the chat load behind it
  };
  const onChatFace = () => evaluate(`document.getElementById("faces").classList.contains("at-chat")`);

  // 1 — a text message opens in its conversation.
  await open(TEXT_MESSAGE);
  check("a text message lands on the conversation face", await onChatFace(), true);
  check("the conversation's heading is showing", await evaluate(`!document.getElementById("headChat").classList.contains("gone")`), true);
  check("the heading names the person", await evaluate(`document.getElementById("chatName").textContent`), "Robin Hale");
  check("the bubbles are rendered", await evaluate(`document.querySelectorAll("#chatList .bubble-row").length`), CHAT.items.length);
  check("the composer addresses the room", await evaluate(`document.getElementById("replyInput").placeholder`), "Message Robin Hale…");

  // 2 — it lands ON the opened message, and moves nothing else.
  const placement = await evaluate(`(() => {
    const scroll = document.getElementById("chatScroll");
    const row = document.querySelector('#chatList .bubble-row[data-relay-id="relay_opened"]');
    if (!row) return { found: false };
    const view = scroll.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    return {
      found: true,
      scrollable: scroll.scrollHeight > scroll.clientHeight + 2,
      centred: Math.abs(box.top + box.height / 2 - (view.top + view.height / 2)) < 40,
    };
  })()`);
  check("the opened message is centred in view", { found: placement.found, centred: placement.centred }, { found: true, centred: true });
  if (!placement.scrollable) console.log("        (note: this window was tall enough not to scroll — centring proved nothing)");
  check(
    "placing the reader never scrolled the faces track",
    await evaluate(`(() => { const f = document.getElementById("faces"); return { left: f.scrollLeft, top: f.scrollTop }; })()`),
    { left: 0, top: 0 },
  );

  if (process.env.PREVIEW_PROBE_SHOT) {
    fs.writeFileSync(process.env.PREVIEW_PROBE_SHOT, (await win.webContents.capturePage()).toPNG());
    console.log(`        wrote ${process.env.PREVIEW_PROBE_SHOT}`);
  }

  // 3 — the message it was opened from is still there, one Escape away.
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
  await sleep(150);
  check("Escape backs out to the message itself", await onChatFace(), false);
  check("that message is intact behind the conversation", await evaluate(`document.getElementById("messageTitle").textContent`), "sending!");

  // 4 — a relay with a subject of its own is unchanged.
  await open(AGENT_RELAY);
  check("a relay with its own subject opens on the reading face", await onChatFace(), false);
  check("its conversation stays one click away on the chip", await evaluate(`!document.getElementById("chatChip").classList.contains("gone")`), true);

  // 5 — a conversation that will not load must not strand the reader.
  chatLoadFails = true;
  await open(TEXT_MESSAGE);
  check("a failed chat load falls back to the message", await onChatFace(), false);
  check("the message is on screen after the fallback", await evaluate(`document.getElementById("messageTitle").textContent`), "sending!");
  check("the reason is on the note line", await evaluate(`document.getElementById("replyNote").textContent`), "This conversation is no longer available.");

  // 6 — a room opened from a CONTACT CARD: no message behind it, nothing said
  // in it yet, and a composer that is the whole point of the window.
  chatLoadFails = false;
  chatAnswer = EMPTY_ROOM;
  await open(CONTACT_ROOM);
  check("a contact's room opens in the conversation", await onChatFace(), true);
  check("it is headed by the name on the card", await evaluate(`document.getElementById("chatName").textContent`), "Sven Wellmann");
  check(
    "there is no way back to a message that does not exist",
    await evaluate(`document.getElementById("chatBack").classList.contains("gone")`),
    true,
  );
  check(
    "an empty room points at the composer",
    await evaluate(`document.getElementById("chatState").textContent`),
    "No messages yet. Write the first one below.",
  );
  check(
    "the composer is live with nothing to answer",
    await evaluate(`(() => { const el = document.getElementById("replyInput"); return { disabled: el.disabled, placeholder: el.placeholder }; })()`),
    { disabled: false, placeholder: "Message Sven Wellmann…" },
  );
  // Typing arms Send even though no message in this room can be replied to.
  await evaluate(`(() => {
    const el = document.getElementById("replyInput");
    el.value = "hello";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await sleep(60);
  check("Send arms on the first message", await evaluate(`document.getElementById("replyButton").disabled`), false);

  // The task composer's caption must not leak onto a face that is not a task.
  // It did, on EVERY window: its container was a <p>, and the runtime menu
  // inside it is a <div> — which closes an open paragraph wherever it is
  // nested. The caption's last line ended up on the body, outside the element
  // `gone` hides. Only a parsed DOM can see this, which is why the check lives
  // here and not with the source assertions that all passed while it shipped.
  check(
    "no task caption leaks onto a room",
    await evaluate(`(() => {
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) {
        const node = walk.currentNode;
        if (!/sender sees when it starts/.test(node.nodeValue || "")) continue;
        // Visible = laid out. A node inside a hidden container has no box.
        const box = node.parentElement.getBoundingClientRect();
        if (box.width > 0 || box.height > 0) return "visible";
      }
      return "hidden";
    })()`),
    "hidden",
  );

  if (process.env.PREVIEW_PROBE_ROOM_SHOT) {
    fs.writeFileSync(process.env.PREVIEW_PROBE_ROOM_SHOT, (await win.webContents.capturePage()).toPNG());
    console.log(`        wrote ${process.env.PREVIEW_PROBE_ROOM_SHOT}`);
  }

  // 7 — the same room once it holds messages: still one face, still the card's name.
  chatAnswer = { ...CHAT, chatId: "chat_room" };
  await open(CONTACT_ROOM);
  check("a room with history renders its bubbles", await evaluate(`document.querySelectorAll("#chatList .bubble-row").length`), CHAT.items.length);
  check("and stays on the conversation", await onChatFace(), true);
  check("named by the card, not by the room", await evaluate(`document.getElementById("chatName").textContent`), "Sven Wellmann");

  // 8 — Escape has no level to back out to here, so it leaves the window.
  const closesBefore = closeRequests;
  await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
  await sleep(150);
  check("Escape closes a contact's room", closeRequests - closesBefore, 1);
  check("and never strands it on the reading face", await onChatFace(), true);

  // 9 — a room that will not load says so where the conversation would be, and
  // the person can still be written to.
  chatLoadFails = true;
  await open(CONTACT_ROOM);
  check("the reason is painted in the conversation", await evaluate(`document.getElementById("chatState").textContent`), "This conversation is no longer available.");
  check("the composer survives a failed load", await evaluate(`document.getElementById("replyInput").disabled`), false);
  check("and the window stays on the conversation", await onChatFace(), true);

  // ...and a message written into that room stays on screen. Blanking it to say
  // "loading" would read as though sending it lost it. (The probe's bridge
  // refuses to send, so this is the bubble in its failed state.)
  await evaluate(`(() => {
    const el = document.getElementById("replyInput");
    el.value = "are you there?";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    document.getElementById("replyButton").click();
  })()`);
  await sleep(250);
  check("a message written into a room that would not load is still shown", await evaluate(`document.querySelectorAll("#chatList .bubble-row").length`), 1);

  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  app.exit(failed ? 1 : 0);
});
