import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const read = (relativePath) => fs.readFileSync(new URL(relativePath, import.meta.url), "utf8");

const inbox = read("../overlay/inbox.html");
const main = read("../overlay/main.cjs");
const preload = read("../overlay/preload.cjs");
const viewerHtml = read("../overlay/viewer.html");
const viewerPreload = read("../overlay/viewer-preload.cjs");
const viewerRenderer = read("../overlay/viewer-renderer.js");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

// ---- the chat cargo builder ------------------------------------------------
// Evaluated straight out of inbox.html with only the helpers it is allowed to
// take, so the collage arithmetic is tested rather than described.
const cargoSource = between(
  inbox,
  "  // ---- chat attachment cargo (Option A)",
  "  // ---- end chat attachment cargo",
);
const esc = (value) => String(value).replace(/[&<>"']/g, "");
const cargo = new Function(
  "esc", "fmtBytes", "fileIconSvg", "fileFamilyOf", "attachmentIsImage",
  `"use strict"; ${cargoSource}; return { chatAttachmentCargo, fileKindLabel, attachmentMetaText, attachmentKey };`,
)(
  esc,
  (bytes) => {
    const n = Number(bytes || 0);
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return n > 0 ? `${n} B` : "";
  },
  (family) => `<svg data-family="${family}"></svg>`,
  (name, type) => {
    const n = String(name || "").toLowerCase();
    if (/^image\//.test(String(type || "")) || /\.(png|jpe?g|gif|webp)$/.test(n)) return "image";
    if (/\.pdf$/.test(n)) return "pdf";
    if (/\.(log|json|[jt]s)$/.test(n)) return "code";
    return "file";
  },
  (attachment) => {
    const type = String(attachment?.contentType || "").toLowerCase();
    const name = String(attachment?.filename || attachment?.name || "").toLowerCase();
    return attachment?.image === true || /^image\/(png|jpeg|gif|webp)$/.test(type) || /\.(png|jpe?g|gif|webp)$/.test(name);
  },
);

const photo = (n) => ({ id: `img_${n}`, name: `photo-${n}.jpg`, contentType: "image/jpeg", bytes: 2048 });
const RELAY = { relayId: "relay_1" };

test("one photo becomes a tail-less photo bubble that hugs the picture", () => {
  const html = cargo.chatAttachmentCargo([photo(1)], RELAY);
  assert.match(html, /class="ca-att ca-photo pending"/);
  assert.match(html, /data-att-relay="relay_1"/);
  assert.match(html, /data-att-id="img_1"/);
  assert.match(html, /data-att-kind="image"/);
  assert.match(html, /data-att-preview="1"/, "the existing lazy plate hydration still drives it");
  assert.doesNotMatch(html, /ca-collage/);
  assert.doesNotMatch(html, /ca-file/, "a photo is never also drawn as a file row");
});

test("two, three and four photos in one message become one collage of the right shape", () => {
  const two = cargo.chatAttachmentCargo([photo(1), photo(2)], RELAY);
  assert.match(two, /class="ca-collage ca-two"/);
  assert.equal(two.match(/class="ca-att ca-tile pending"/g).length, 2);

  const three = cargo.chatAttachmentCargo([photo(1), photo(2), photo(3)], RELAY);
  assert.match(three, /class="ca-collage ca-three"/);
  assert.equal(three.match(/class="ca-att ca-tile pending"/g).length, 3);

  const four = cargo.chatAttachmentCargo([photo(1), photo(2), photo(3), photo(4)], RELAY);
  assert.match(four, /class="ca-collage ca-four"/);
  assert.equal(four.match(/class="ca-att ca-tile pending"/g).length, 4);
  assert.doesNotMatch(four, /ca-more/, "exactly four photos all fit, so nothing is folded away");
});

test("beyond four photos the last tile carries +N and still opens on its own photo", () => {
  const seven = cargo.chatAttachmentCargo([1, 2, 3, 4, 5, 6, 7].map(photo), RELAY);
  assert.match(seven, /class="ca-collage ca-four"/);
  assert.equal(seven.match(/class="ca-att ca-tile pending"/g).length, 4, "only four tiles are ever drawn");
  assert.match(seven, /<span class="ca-more" aria-hidden="true">\+3<\/span>/);
  // The "+3" tile is the fourth photo, not a dead overlay.
  assert.match(seven, /data-att-id="img_4"[^>]*>[\s\S]*ca-more/);
});

test("images and files split: photos collage, everything else gets its own file bubble", () => {
  const html = cargo.chatAttachmentCargo([
    photo(1),
    photo(2),
    { id: "f1", name: "mcp-server-relay.log", bytes: 11 * 1024 },
    { id: "f2", name: "vineyard-deck.pdf", contentType: "application/pdf", bytes: 2.4 * 1024 * 1024 },
  ], RELAY);
  assert.match(html, /class="ca-collage ca-two"/);
  assert.equal(html.match(/class="ca-att ca-file"/g).length, 2);
  assert.match(html, />11 KB · Log</, "a log says what it is, in the meta, after its size");
  assert.match(html, />2\.4 MB · PDF</);
  assert.match(html, /data-family="code"/, "the log wears the code glyph");
  assert.match(html, /data-family="pdf"/);
});

test("an outbound message's cargo wears the accent side, and an optimistic one is inert", () => {
  const mine = cargo.chatAttachmentCargo([photo(1), { id: "f1", name: "a.pdf" }], { ...RELAY, mine: true });
  assert.match(mine, /class="ca-att ca-photo mine pending"/);
  assert.match(mine, /class="ca-att ca-file mine"/);
  assert.match(mine, /class="ca-row mine"/);

  // Just picked, no canonical id yet: the same plate, with nothing to open.
  const optimistic = cargo.chatAttachmentCargo([
    { name: "photo.jpeg", contentType: "image/jpeg", image: true, previewUrl: "blob:relay-preview" },
    { name: "notes.txt" },
  ]);
  assert.match(optimistic, /<div class="ca-att ca-photo ready"/);
  assert.match(optimistic, /<img src="blob:relay-preview"/);
  assert.match(optimistic, /<div class="ca-att ca-file">/);
  assert.doesNotMatch(optimistic, /<button/, "nothing without an id pretends to be clickable");
});

test("every selectable attachment carries a check circle in the gutter", () => {
  const html = cargo.chatAttachmentCargo([photo(1), { id: "f1", name: "a.pdf" }], RELAY);
  assert.equal(html.match(/data-att-check="/g).length, 2);
  assert.match(html, /data-att-row="relay_1::img_1"/);
  assert.match(html, /data-att-row="relay_1::f1"/);
  assert.match(html, /aria-pressed="false"/);
});

test("a collage is one check that stands for every photo inside it", () => {
  const html = cargo.chatAttachmentCargo([1, 2, 3, 4, 5].map(photo), RELAY);
  assert.equal(html.match(/data-att-check="/g).length, 1, "one object, one check");
  const group = /data-att-keys="([^"]+)"/.exec(html)[1].split("|");
  assert.deepEqual(group, [1, 2, 3, 4, 5].map((n) => `relay_1::img_${n}`),
    "including the photos folded behind +N — Download must not drop them");
});

test("the meta word after the size names the file the way a person would", () => {
  assert.equal(cargo.fileKindLabel("server.log"), "Log");
  assert.equal(cargo.fileKindLabel("notes.docx"), "Word");
  assert.equal(cargo.fileKindLabel("readme.md"), "Text");
  assert.equal(cargo.fileKindLabel("rows.csv"), "CSV");
  assert.equal(cargo.fileKindLabel("deck.pdf"), "PDF");
  assert.equal(cargo.fileKindLabel("export.zip"), "Zip");
  assert.equal(cargo.attachmentMetaText({ name: "x.log", bytes: 11 * 1024 }), "11 KB · Log");
  assert.equal(cargo.attachmentMetaText({ name: "x.log" }), "Log", "no size is not a leading separator");
});

// ---- the selection reducer -------------------------------------------------
const reducerSource = between(
  inbox,
  "  function attachmentSelectionReducer(state, action, order = []) {",
  "\n  function attachmentOrderKeys()",
);
const attachmentSelectionReducer = new Function(
  `"use strict"; ${reducerSource}; return attachmentSelectionReducer;`,
)();

const ORDER = ["a", "b", "c", "d", "e"];
test("selection: Select… enters the mode with that one attachment checked", () => {
  const state = attachmentSelectionReducer(null, { type: "enter", id: "c", key: "room" }, ORDER);
  assert.deepEqual([...state.ids], ["c"]);
  assert.equal(state.key, "room");
  assert.equal(state.anchor, "c");
});

test("selection: toggling adds and removes, and emptying it never leaves the mode", () => {
  let state = attachmentSelectionReducer(null, { type: "enter", id: "b", key: "room" }, ORDER);
  state = attachmentSelectionReducer(state, { type: "toggle", id: "d", key: "room" }, ORDER);
  assert.deepEqual([...state.ids].sort(), ["b", "d"]);
  state = attachmentSelectionReducer(state, { type: "toggle", id: "d", key: "room" }, ORDER);
  state = attachmentSelectionReducer(state, { type: "toggle", id: "b", key: "room" }, ORDER);
  assert.deepEqual([...state.ids], []);
  assert.notEqual(state, null, "unchecking the last item is not a request to leave");
});

test("selection: Shift ranges from the anchor, Select all takes the room, Esc leaves", () => {
  let state = attachmentSelectionReducer(null, { type: "enter", id: "b", key: "room" }, ORDER);
  state = attachmentSelectionReducer(state, { type: "range", id: "d", key: "room" }, ORDER);
  assert.deepEqual([...state.ids].sort(), ["b", "c", "d"]);
  // A backwards range covers the same span.
  let back = attachmentSelectionReducer(null, { type: "enter", id: "d", key: "room" }, ORDER);
  back = attachmentSelectionReducer(back, { type: "range", id: "b", key: "room" }, ORDER);
  assert.deepEqual([...back.ids].sort(), ["b", "c", "d"]);

  const all = attachmentSelectionReducer(state, { type: "all", key: "room" }, ORDER);
  assert.deepEqual([...all.ids].sort(), [...ORDER].sort());
  assert.equal(attachmentSelectionReducer(all, { type: "exit", key: "room" }, ORDER), null);
});

test("selection: a collage's check goes all on or all off, never half", () => {
  const collage = ["b", "c", "d"];
  let state = attachmentSelectionReducer(null, { type: "enter", ids: collage, key: "room" }, ORDER);
  assert.deepEqual([...state.ids].sort(), collage);
  // One photo of it unchecked, then the group toggled: not every member is on,
  // so the group turns fully on rather than off.
  state = attachmentSelectionReducer(state, { type: "toggle", id: "c", key: "room" }, ORDER);
  state = attachmentSelectionReducer(state, { type: "toggle", ids: collage, key: "room" }, ORDER);
  assert.deepEqual([...state.ids].sort(), collage);
  state = attachmentSelectionReducer(state, { type: "toggle", ids: collage, key: "room" }, ORDER);
  assert.deepEqual([...state.ids], []);
});

test("selection: a range against an unknown id degrades to a plain toggle", () => {
  const state = attachmentSelectionReducer(null, { type: "enter", id: "b", key: "room" }, ORDER);
  const ranged = attachmentSelectionReducer(state, { type: "range", id: "zzz", key: "room" }, ORDER);
  assert.deepEqual([...ranged.ids].sort(), ["b", "zzz"]);
});

// ---- the context menu ------------------------------------------------------
const menuSource = between(
  inbox,
  "  function attachmentMenuItems(",
  "\n  function closeAttachmentMenu()",
);
const attachmentMenuItems = new Function(`"use strict"; ${menuSource}; return attachmentMenuItems;`)();
const ids = (options) => attachmentMenuItems(options).map((item) => item.id).filter((id) => id !== "sep");

test("the context menu offers Copy image only for photos and Reply only where replying works", () => {
  assert.deepEqual(ids({ image: false, canReply: false }), ["open", "download", "reveal", "select"]);
  assert.deepEqual(ids({ image: true, canReply: false }), ["open", "download", "reveal", "select", "copy"]);
  assert.deepEqual(ids({ image: true, canReply: true }), ["open", "download", "reveal", "select", "copy", "reply"]);
  assert.deepEqual(ids({ image: false, canReply: true }), ["open", "download", "reveal", "select", "reply"]);
  const hints = Object.fromEntries(attachmentMenuItems({ image: true, canReply: true })
    .filter((item) => item.id !== "sep").map((item) => [item.id, item.hint]));
  assert.equal(hints.download, "⌘S");
  assert.equal(hints.copy, "⌘C");
  assert.equal(hints.open, "↩");
});

// ---- where a download lands and what it is called --------------------------
const downloads = require("../overlay/attachment-downloads.cjs");

test("the download folder is the chat's name, made safe, never an empty segment", () => {
  assert.equal(downloads.sanitizeChatFolderName("Jordan Nel"), "Jordan Nel");
  assert.equal(downloads.sanitizeChatFolderName("Ops / Q4: plans?"), "Ops Q4 plans");
  assert.equal(downloads.sanitizeChatFolderName("../../etc/passwd").includes("/"), false);
  assert.equal(downloads.sanitizeChatFolderName(""), "Relay");
  assert.equal(downloads.sanitizeChatFolderName("   "), "Relay");
  assert.equal(downloads.sanitizeChatFolderName("."), "Relay");
  assert.equal(downloads.sanitizeChatFolderName("x".repeat(200)).length, 60);
});

test("downloads keep the sender's filename, and a clash gets (2), (3), …", () => {
  const taken = new Set();
  const claim = (name) => { const out = downloads.uniqueDownloadName(name, taken); taken.add(out); return out; };
  assert.equal(claim("IMG_0412.jpg"), "IMG_0412.jpg");
  assert.equal(claim("IMG_0412.jpg"), "IMG_0412 (2).jpg");
  assert.equal(claim("IMG_0412.jpg"), "IMG_0412 (3).jpg");
  assert.equal(claim("notes"), "notes");
  assert.equal(claim("notes"), "notes (2)");
  // A leading dot is a hidden file's name, not an extension.
  assert.equal(claim(".env"), ".env");
  assert.equal(claim(".env"), ".env (2)");
  assert.equal(downloads.sanitizeDownloadFileName("a/b/c.png"), "a b c.png");
  assert.equal(downloads.sanitizeDownloadFileName(".."), "attachment");
});

// ---- the viewer's text preview --------------------------------------------
const textPreview = require("../overlay/attachment-text-preview.cjs");

test("the file viewer renders numbered lines and tints only the bad news", () => {
  const source = [
    "2026-09-01T21:41:53.651Z [relay] [info] Initializing server...",
    "Failed to spawn process: No such file or directory",
    "2026-09-01T21:41:54.030Z [relay] [error] Server disconnected.",
    "all good here",
  ].join("\n");
  const { lines, truncated, total } = textPreview.textPreviewLines(source);
  assert.equal(truncated, false);
  assert.equal(total, 4);
  assert.deepEqual(lines.map((line) => line.n), [1, 2, 3, 4]);
  assert.deepEqual(lines.map((line) => line.trouble), [false, true, true, false]);
  assert.equal(lines[1].text, "Failed to spawn process: No such file or directory");
});

test("the text preview normalises line endings, drops the terminator, and caps long files", () => {
  assert.equal(textPreview.textPreviewLines("a\r\nb\r\n").lines.length, 2);
  assert.equal(textPreview.textPreviewLines("").lines.length, 0);
  const many = textPreview.textPreviewLines("x\n".repeat(50), { maxLines: 10 });
  assert.equal(many.lines.length, 10);
  assert.equal(many.total, 50);
  assert.equal(many.truncated, true);
});

test("only text-shaped attachments render inline, and never past 2 MB", () => {
  assert.equal(textPreview.TEXT_PREVIEW_MAX_BYTES, 2 * 1024 * 1024);
  assert.ok(textPreview.isTextPreviewable({ name: "server.log", size: 1000 }));
  assert.ok(textPreview.isTextPreviewable({ name: "a.json", contentType: "application/json", size: 10 }));
  assert.ok(textPreview.isTextPreviewable({ name: "notes", contentType: "text/plain", size: 10 }));
  assert.equal(textPreview.isTextPreviewable({ name: "deck.pdf", contentType: "application/pdf", size: 10 }), false);
  assert.equal(textPreview.isTextPreviewable({ name: "photo.png", size: 10 }), false);
  assert.equal(
    textPreview.isTextPreviewable({ name: "huge.log", size: 3 * 1024 * 1024 }),
    false,
    "past the cap the card takes over and offers the default app",
  );
});

// ---- the wiring ------------------------------------------------------------
test("clicking an attachment opens a Relay viewer, and shell.openPath is only the viewer's hand-off", () => {
  assert.match(inbox, /function openAttachmentTarget\(target\) \{[\s\S]*window\.relay\.openAttachmentViewer/);
  const wiring = between(inbox, "function wireRoomAttachments()", "// Esc, an outside click");
  assert.match(wiring, /openAttachmentTarget\(target\)/);
  assert.match(wiring, /event\.metaKey \|\| event\.ctrlKey/, "⌘-click selects without opening the menu");
  assert.match(wiring, /event\.shiftKey \? "range" : "toggle", ids:/);
  assert.match(inbox, /function attachmentGroupOf\(node\)/,
    "a click speaks for the whole row, so a collage selects as all of its photos");
  assert.match(wiring, /addEventListener\("contextmenu"/);
  // The old OS hand-off must not also claim the new bubbles.
  assert.match(inbox, /root\.querySelectorAll\("\[data-att-relay\]:not\(\.ca-att\)"\)/);
  // Main keeps shell.openPath for exactly one caller: the viewer's action.
  assert.match(main, /ipcMain\.handle\("relay:viewer:openDefault"[\s\S]*openRelayAttachment\(relayId, attachmentId\)/);
  assert.match(viewerRenderer, /Open in default app/);
});

test("the renderer's attachment IPC surface is exactly the five named calls", () => {
  for (const name of [
    "openAttachmentViewer", "downloadAttachments", "onAttachmentDownloadProgress",
    "revealAttachment", "copyAttachmentImage",
  ]) {
    assert.match(preload, new RegExp(`${name}:`), `preload exposes ${name}`);
  }
  assert.match(preload, /"relay:openAttachmentViewer"/);
  assert.match(preload, /"relay:downloadAttachments"/);
  assert.match(preload, /"relay:revealAttachment"/);
  assert.match(preload, /"relay:copyAttachmentImage"/);
  assert.match(preload, /ipcRenderer\.on\("relay:attachmentDownload"/);
  for (const channel of [
    "relay:openAttachmentViewer", "relay:downloadAttachments",
    "relay:revealAttachment", "relay:copyAttachmentImage",
  ]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\("${channel}"`), `main handles ${channel}`);
  }
});

test("main validates every id and answers viewer channels only for a live viewer window", () => {
  assert.match(main, /function safeAttachmentId\(value\) \{[\s\S]*clean\.length <= 200/);
  assert.match(main, /function safeViewerContext\(input\)/);
  assert.match(main, /const relayId = safeAttachmentId\(row\?\.relayId\)/);
  for (const channel of [
    "relay:viewer:item", "relay:viewer:download", "relay:viewer:reveal",
    "relay:viewer:openDefault", "relay:viewer:copyImage",
  ]) {
    const handler = between(main, `ipcMain.handle("${channel}"`, "});");
    assert.match(handler, /if \(!viewerEntryForEvent\(event\)\) return \{ ok: false/, `${channel} is viewer-only`);
  }
  // The pill's own open is answered only for the pill.
  assert.match(
    between(main, 'ipcMain.handle("relay:openAttachmentViewer"', "});"),
    /event\.sender !== win\.webContents/,
  );
});

test("downloads land in ~/Downloads/Relay/<chat>/, report per item, and reveal exactly once", () => {
  const download = between(main, "async function downloadRelayAttachments(", "function reportAttachmentDownload(");
  assert.match(main, /path\.join\(downloads \|\| path\.join\(os\.homedir\(\), "Downloads"\), "Relay"\)/);
  assert.match(download, /sanitizeChatFolderName\(options\?\.chatTitle\)/);
  assert.match(download, /uniqueDownloadName\(/);
  assert.match(download, /fs\.mkdirSync\(folder, \{ recursive: true \}\)/);
  assert.match(download, /tell\("downloading", \{ loaded, total \}\)/);
  assert.match(download, /tell\("done"/);
  assert.match(download, /tell\("error"/);
  assert.match(download, /if \(saved\.length\) \{[\s\S]*shell\.showItemInFolder\(saved\[0\]\)/);
  assert.equal((download.match(/showItemInFolder/g) || []).length, 1, "the folder opens once, not once per file");
  assert.match(download, /RELAY_OVERLAY_TEST_NO_HOST_OPEN/, "a sandbox run never opens Finder");
});

test("the viewer window is sandboxed, isolated, frameless and loads nothing from the network", () => {
  const create = between(main, "function createAttachmentViewerWindow(key)", "function sendAttachmentViewerPayload");
  assert.match(create, /preload: path\.join\(__dirname, "viewer-preload\.cjs"\)/);
  assert.match(create, /contextIsolation: true/);
  assert.match(create, /nodeIntegration: false/);
  assert.match(create, /sandbox: true/);
  assert.match(create, /plugins: true/, "Chromium's own PDF viewer renders the local file inside the stage");
  assert.match(create, /frame: false/);
  assert.match(create, /backgroundColor: VIEWER_BACKGROUND/);
  assert.match(create, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(create, /on\("will-navigate"/);
  assert.match(main, /const VIEWER_WIN = \{ width: 760, height: 560, minWidth: 480, minHeight: 360 \}/);
  assert.match(main, /const VIEWER_BACKGROUND = "#221E1B"/);

  const csp = viewerHtml.match(/content="(default-src[^"]+)"/)?.[1] || "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /img-src 'self' file: data:/);
  assert.match(csp, /frame-src 'self' file:/);
  assert.doesNotMatch(csp, /https?:/, "no origin on the network is reachable from the viewer");

  // The renderer only ever receives local file: URLs main resolved.
  assert.match(main, /const fileUrl = pathToFileURL\(resolved\.target\)\.href/);
  assert.doesNotMatch(viewerPreload, /require\("(?!electron)/, "the viewer preload takes only electron");
});

test("the image viewer is one window per chat and retargets, a file gets its own", () => {
  const open = between(main, "async function openRelayAttachmentViewer(", "/** The bytes behind one item");
  assert.match(open, /const key = image \? `image:\$\{safe\.chatKey \|\| id\}` : `file:\$\{id\}:\$\{attId\}`/);
  assert.match(open, /if \(!entry\) entry = createAttachmentViewerWindow\(key\)/);
  assert.match(open, /entry\.payload = \{ kind: image \? "image" : "file"/);
  assert.match(open, /safe\.items\.filter\(\(item\) => item\.image\)/, "the filmstrip is images only");
});

test("the viewer's keys are ←/→, Esc, ⌘S and double-click to toggle fit", () => {
  assert.match(viewerRenderer, /event\.key === "ArrowLeft"/);
  assert.match(viewerRenderer, /event\.key === "ArrowRight"/);
  assert.match(viewerRenderer, /if \(event\.key === "Escape"\) \{ bridge\.close\(\)/);
  assert.match(viewerRenderer, /event\.key\.toLowerCase\(\) === "s"[\s\S]*download\(\)/);
  assert.match(viewerRenderer, /el\.stage\.addEventListener\("dblclick"/);
  assert.match(viewerRenderer, /el\.stage\.classList\.toggle\("actual", actual\)/);
  // Names arrive with the attachment: they are printed, never parsed as markup.
  assert.doesNotMatch(viewerRenderer, /\.innerHTML\s*=/);
});

test("selection takes the header over and stands the composer down", () => {
  assert.match(inbox, /<div class="th-select-bar th-bar-sticky hidden" id="thSelectBar">/);
  assert.match(inbox, /id="thSelectCount"/);
  assert.match(inbox, /id="thSelectAll"/);
  assert.match(inbox, /id="thSelectDownload"/);
  assert.match(inbox, /#thHistory\.selecting \.th-composer-dock/);
  assert.match(inbox, /#thHistory\.selecting \.ca-check \{ display:grid; \}/);
  assert.match(inbox, /thSelectAllEl\?\.addEventListener\("click", \(\) => setAttachmentSelection\(\{ type:"all" \}\)\)/);
  assert.match(inbox, /document\.querySelector\("#thDetail > \.th-detail-head"\)\?\.classList\.toggle\("hidden", active\)/);
  // 20px circle in the 16px gutter, 10px gap: the content shifts right by 30.
  assert.match(inbox, /\.ca-check \{ display:none; flex:none; width:20px; height:20px; margin-right:10px;/);
});

test("the menu is Relay-styled, stays inside the pill, and closes on Esc, outside click and scroll", () => {
  assert.match(inbox, /\.att-menu \{ position:fixed; z-index:60; width:196px; padding:6px; border-radius:var\(--r-3\)/);
  assert.match(inbox, /box-shadow:var\(--shadow-pop\)/);
  assert.match(inbox, /\.att-menu button \{[^}]*height:32px[^}]*font-size:13px/);
  assert.match(inbox, /\.att-menu \.k \{ margin-left:auto; font-family:var\(--mono\)/);
  const open = between(inbox, "function openAttachmentMenu(target, point)", "function runAttachmentMenuAction");
  assert.match(open, /const bounds = \(cardEl \|\| document\.body\)\.getBoundingClientRect\(\)/);
  assert.match(open, /Math\.max\(bounds\.left \+ 6, Math\.min\(point\.x, bounds\.right - size\.width - 6\)\)/);
  assert.match(open, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(inbox, /window\.addEventListener\("scroll", \(\) => \{[\s\S]{0,200}closeAttachmentMenu\(\);[\s\S]{0,40}\}, true\)/);
  assert.match(inbox, /if \(attachmentMenuEl && !event\.target\.closest\?\.\("\.att-menu"\)\) closeAttachmentMenu\(\)/);
});

test("the composer's own chips and the other attachment surfaces are untouched", () => {
  // Regression fence: the surfaces that did NOT change still render their own
  // way, through the helpers this work deliberately left alone.
  assert.match(inbox, /class="cmp-chip/);
  assert.match(inbox, /function attachmentChips\(attachments, \{ relayId = "" \} = \{\}\)/);
  assert.match(inbox, /function attachmentPlates\(attachments, \{ relayId = "" \} = \{\}\)/);
  assert.match(inbox, /attachmentPlates\(r\.attachments, \{ relayId: r\.id \}\)/, "the relay list still uses plates");
  assert.match(inbox, /\$\{attachmentChips\(m\.attachments\)\}/, "task messages still use chips");
  assert.match(inbox, /class="rd-shelf-card td-att-open"/, "the reader shelf is unchanged");
  assert.match(inbox, /\.th-msg\.attachment-only \{ display:contents; \}/);
});
