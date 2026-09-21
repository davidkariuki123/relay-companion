import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

/**
 * A link to a Relay you already sent, from the reader's ⋯ menu (David,
 * 2026-09-17: candidate B without edit and delete). Public opens for anyone
 * holding it; private opens for the people it went to, after they sign in.
 * The menu holds the two kinds and their reasons, then the url once one
 * exists; the kicker carries the state as a receipt word.
 */

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
function section(start, end) {
  const i = html.indexOf(start);
  const j = html.indexOf(end, i);
  assert.ok(i >= 0 && j > i, `section ${start.slice(0, 40)}`);
  return html.slice(i, j);
}

function harness() {
  const builders = section("  function audienceLinkOf(row) {", "  let sentLinkMenuFor = null;");
  return new Function(`
    ${section("  function esc(s)", "  function agentMentionSpans(")}
    const isTaskRow = (row) => row?.kind === "task" || row?.relayNotificationKind === "task";
    ${builders}
    return { shareableLinkOf, sentLinkButtonHtml, audienceLinkOf, sentLinkOf, sentLinkKickerWord, sentLinkEligible, sentLinkMoreHtml, sentLinkMenuHtml, sentLinkUiFor };
  `)();
}

const sent = (overrides = {}) => ({
  id: "relay_1",
  outbound: true,
  kind: "message",
  recipientName: "Sven Wellmann",
  recipientGroupName: "",
  source: { host: "relay-pill" },
  shareLink: null,
  ...overrides,
});

test("only a message this account sent gets the options button", () => {
  const h = harness();
  assert.match(h.sentLinkMoreHtml(sent()), /class="th-message-more" data-sent-link-more="relay_1"/);
  assert.match(h.sentLinkMoreHtml(sent()), /aria-controls="sentLinkMenu"/);
  assert.equal(h.sentLinkMoreHtml(sent({ outbound: false })), "", "an inbound letter is not mine to link");
  assert.equal(h.sentLinkMoreHtml(sent({ kind: "task" })), "", "a Task keeps its own bar controls");
  assert.equal(h.sentLinkMoreHtml(sent({ deletedAt: "2026-09-17T10:00:00Z" })), "", "a deleted message has nothing to link");
  assert.equal(h.sentLinkMoreHtml(sent({ source: { host: "relay-agent-run" } })), "", "owned agent work is not a letter");
});

test("with no link the menu offers the two kinds, each with its reason, and nothing else", () => {
  const h = harness();
  const menu = h.sentLinkMenuHtml(sent());
  assert.match(menu, /data-sent-link-pick="public"[^>]*><span class="sv-open-name">Get a public link<\/span><span class="sv-open-why">Anyone with the link can read it\.<\/span>/);
  assert.match(menu, /data-sent-link-pick="private"[^>]*><span class="sv-open-name">Get a private link<\/span><span class="sv-open-why">Sven Wellmann signs in to open it\. Nobody else can\.<\/span>/);
  // David, 2026-09-17: B without edit and delete.
  assert.doesNotMatch(menu, /data-message-edit|data-message-delete|>edit<|>delete</i);
  assert.doesNotMatch(menu, /sv-invite-field|Turn off link|Make private|Make public/);
  const group = h.sentLinkMenuHtml(sent({ recipientGroupName: "Granular" }));
  assert.match(group, /Members of Granular sign in to open it\. Nobody else can\./);
});

test("with a link the menu shows the url, Copy, the flip, and Turn off, with the whisper for its kind", () => {
  const h = harness();
  const pub = h.sentLinkMenuHtml(sent({ shareLink: { kind: "sent", access: "public", state: "unopened", url: "https://sendrelays.com/s/7fK2mQ9pLx3vN8aB" } }));
  assert.match(pub, /<span class="sv-open-name sv-link-url">sendrelays\.com\/s\/7fK2mQ9pLx3vN8aB<\/span>/);
  assert.match(pub, /<button class="sv-choose" type="button" data-sent-link-copy="1">Copy link<\/button>/);
  assert.match(pub, /<div class="sv-invite-note">Anyone with this link can read this Relay\.<\/div>/);
  assert.match(pub, /data-sent-link-pick="private"[^>]*>Make private<\/button>/);
  assert.match(pub, /class="danger" data-sent-link-off="1"[^>]*>Turn off link<\/button>/);
  assert.doesNotMatch(pub, /Get a public link|Get a private link/);
  const priv = h.sentLinkMenuHtml(sent({ shareLink: { kind: "sent", access: "private", state: "unopened", url: "https://sendrelays.com/s/x" } }));
  assert.match(priv, /Only you and Sven Wellmann can open it, after signing in\./);
  assert.match(priv, /data-sent-link-pick="public"[^>]*>Make public<\/button>/);
  const grp = h.sentLinkMenuHtml(sent({ recipientGroupName: "Granular", shareLink: { kind: "sent", access: "private", state: "opened", url: "https://sendrelays.com/s/y" } }));
  assert.match(grp, /Only you and the members of Granular can open it, after signing in\./);
});

test("the kicker carries the link as a receipt word, and a revoked or audience link is no link", () => {
  const h = harness();
  assert.equal(h.sentLinkKickerWord(h.sentLinkOf(sent())), "");
  assert.equal(h.sentLinkKickerWord(h.sentLinkOf(sent({ shareLink: { kind: "sent", access: "public", state: "opened", url: "https://sendrelays.com/s/a" } }))), " · public link");
  assert.equal(h.sentLinkKickerWord(h.sentLinkOf(sent({ shareLink: { kind: "sent", access: "private", state: "unopened", url: "https://sendrelays.com/s/a" } }))), " · private link");
  assert.equal(h.sentLinkOf(sent({ shareLink: { kind: "sent", access: "public", state: "revoked", url: "https://sendrelays.com/s/a" } })), null);
  // A relay minted AS a share link is an audience link: the room's own door,
  // never a sent link, and the Sent row keeps saying "shared by link".
  const audience = sent({ shareLink: { id: "shl_1", state: "unopened", url: "https://sendrelays.com/s/b" } });
  assert.equal(h.sentLinkOf(audience), null);
  assert.equal(h.audienceLinkOf(audience)?.id, "shl_1");
  assert.equal(h.audienceLinkOf(sent({ shareLink: { kind: "sent", access: "public", state: "unopened", url: "https://sendrelays.com/s/a" } })), null);
});

test("the pill knows a link it just minted before the Sent row does, and Copied is a moment", () => {
  const h = harness();
  const row = sent();
  const ui = h.sentLinkUiFor(row.id);
  ui.link = { url: "https://sendrelays.com/s/fresh", access: "private" };
  assert.deepEqual(h.sentLinkOf(row), { url: "https://sendrelays.com/s/fresh", access: "private" });
  ui.copied = true;
  assert.match(h.sentLinkMenuHtml(row), /data-sent-link-copy="1">Copied<\/button>/);
  ui.busy = true;
  assert.match(h.sentLinkMenuHtml(row), /data-sent-link-off="1" disabled>/);
  ui.error = "Could not make a link.";
  assert.match(h.sentLinkMenuHtml(row), /<div class="row-err">Could not make a link\.<\/div>/);
});

test("the reader's bar carries the button and the kicker the word, and Sent rows keep audience links apart", () => {
  const bar = section('      <div class="reader-bar">', '      ${documentList}');
  assert.match(bar, /\$\{sentLinkMoreHtml\(r\)\}/);
  const kicker = section('        <div class="rd-kicker">${request ? (r.outbound', "</div>");
  assert.match(kicker, /sentLinkKickerWord\(sentLinkOf\(r\)\)/);
  const detail = section("  function sentDetail(r) {", "  function sentClass(r) {");
  assert.match(detail, /const link = audienceLinkOf\(r\);/);
  assert.match(detail, /sentLink\.access === "private" \? "private link" : "public link"/);
  const room = section("        // A link to a relay that was already sent (kind \"sent\") is a door to", "        isGroup:");
  assert.equal((room.match(/s\.shareLink && s\.shareLink\.kind !== "sent" && s\.shareLink\.state !== "claimed"/g) || []).length, 2);
  assert.doesNotMatch(room, /\(s\.shareLink && s\.shareLink\.state !== "claimed"\)/);
  // The menu lives outside the header on purpose: the header is rebuilt on every poll.
  assert.match(html, /<div class="th-message-menu sent-link-menu" id="sentLinkMenu" popover="auto" role="group" aria-label="Relay options" data-stop="1"><\/div>/);
  assert.match(section("  function sentLinkMenuEl() {", "  function positionSentLinkMenu() {"), /menu\.dataset\.wired === "1"/);
  assert.match(section("  function wireSentLinkMore(row) {", "  async function sentLinkBind("), /refreshSentLinkMenu\(\)/);
  // The bar button is the bubble's ⋯ made permanent; the menu is the bubble's menu.
  assert.match(html, /\.reader-bar \.th-message-more \{ position:static; opacity:1;/);
  assert.match(html, /\.sent-link-menu \{ width:372px; \}/);
});

test("main answers the two IPCs, preload exposes them, and the client posts to the bind route", () => {
  const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
  const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
  const client = fs.readFileSync(new URL("../src/client.js", import.meta.url), "utf8");
  assert.match(main, /ipcMain\.handle\("relay:bindShareLink"/);
  assert.match(main, /ipcMain\.handle\("relay:revokeShareLink"/);
  assert.match(main, /bindShareLink\(relayId, access\)/);
  assert.match(main, /ipcMain\.handle\("relay:copyShareLink"/);
  assert.match(main, /clipboard\.writeText\(parsed\.toString\(\)\);/);
  assert.match(preload, /bindShareLink: \(relayId, access\) => ipcRenderer\.invoke\("relay:bindShareLink", \{ relayId, access \}\)/);
  assert.match(preload, /revokeShareLink: \(relayId\) => ipcRenderer\.invoke\("relay:revokeShareLink", \{ relayId \}\)/);
  assert.match(client, /bindShareLink\(relayId, access\) \{\n\s*return this\.#req\("POST", `\/v1\/share-links\/\$\{encodeURIComponent\(relayId\)\}`, \{ access \}\);/);
});


test("the hover link uses the last rounded-square position, with a divider only beside app icons", () => {
  const h = harness();
  const button = h.sentLinkButtonHtml(sent(), true);
  assert.match(button, /relay-link-divider[\s\S]*data-relay-link="relay_1"/);
  assert.match(button, /aria-label="Get link"/);
  assert.match(button, /aria-describedby="relayLinkTooltip"/);
  assert.doesNotMatch(h.sentLinkButtonHtml(sent(), false), /relay-link-divider/);
  assert.equal(h.sentLinkButtonHtml(sent({outbound:false}), true), "");
  assert.equal(h.sentLinkButtonHtml(sent({kind:"task"}), true), "");
  const row = sent({shareLink:{kind:"sent",access:"private",state:"opened",url:"https://sendrelays.com/s/private"}});
  assert.match(h.sentLinkButtonHtml(row, true), /aria-label="Copy link"/);
  h.sentLinkUiFor(row.id).copied = true;
  assert.match(h.sentLinkButtonHtml(row, true), /aria-label="Link copied"/);
});

test("audience links remain copyable in the reader without offering an unsupported privacy conversion", () => {
  const h = harness();
  const row = sent({shareLink:{kind:"audience",state:"unopened",url:"https://sendrelays.com/s/audience"}});
  assert.equal(h.shareableLinkOf(row).url, row.shareLink.url);
  const menu = h.sentLinkMenuHtml(row);
  assert.match(menu, /Copy link/);
  assert.match(menu, /Turn off link/);
  assert.doesNotMatch(menu, /data-sent-link-pick/);
  assert.equal(h.shareableLinkOf(sent({shareLink:{kind:"audience",state:"revoked",url:row.shareLink.url}})), null);
});

test("a privacy change or revocation overrides a stale Sent snapshot", () => {
  const h = harness();
  const row = sent({shareLink:{kind:"sent",access:"public",state:"opened",url:"https://sendrelays.com/s/a"}});
  const ui = h.sentLinkUiFor(row.id);
  ui.linkResolved = true;
  ui.link = {url:row.shareLink.url,access:"private"};
  assert.equal(h.shareableLinkOf(row).access, "private");
  assert.match(h.sentLinkMenuHtml(row), /Make public/);
  ui.link = null;
  assert.equal(h.shareableLinkOf(row), null);
  assert.match(h.sentLinkMenuHtml(row), /Get a private link/);
});
