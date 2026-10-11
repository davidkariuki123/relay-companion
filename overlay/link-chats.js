// LINK-RECIPIENT CHATS (David picked "A · Banner card", 2026-10-11).
//
// A link an agent made for a named person ("Shane Acton") is a message to
// that person. The server gathers every such link into one chat per person
// (GET /v1/link-chats); this module files the pill's own rows into that chat
// and draws the card at the top of it:
//
//   no email yet   → "Shane isn't one of your contacts yet." Copy link · Add email
//   adding         → the email field, then "Looking for Shane on Relay…"
//   on Relay       → "Shane is on Relay." for a moment; then an ordinary chat
//   not on Relay   → "Shane isn't on Relay yet." Copy invite link · Change email
//
// Once the email step is done or folded the card is one tappable line, and it
// never covers the newest message (inbox.html folds it when it would).
//
// Pure: no DOM reads, no IPC. inbox.html owns events and state; this file owns
// the rules and the markup, so both can be tested on their own.
(function (root) {
  "use strict";
  const LINK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/></svg>';
  const CHECK = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.4l2.3 2.3 4.7-5"/></svg>';
  const CHEV = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg>';
  const PERSON_PLUS = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6.5" cy="5.5" r="2.6"/><path d="M1.8 13.2c.6-2.4 2.4-3.7 4.7-3.7s4.1 1.3 4.7 3.7M12.6 5v4M10.6 7h4"/></svg>';
  /** How long "Shane is on Relay." stays before the chat is simply his chat. */
  const JOINED_MS = 6000;

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ic = (svg, cls = "lk-ic") => `<span class="${cls}">${svg}</span>`;

  /** The chats the server sent, or null when it cannot say (an API that predates them). */
  function chatsOf(payload) {
    return payload && Array.isArray(payload.linkChats) ? payload.linkChats : null;
  }

  /**
   * The room a link chat is: the contact's ordinary chat once the person has
   * an email (so what is typed there and what the links carried are one
   * conversation), else a room of its own keyed by the chat.
   */
  function roomKeyOf(chat) {
    const email = String((chat && chat.contact && chat.contact.email) || "").trim().toLowerCase();
    return email ? `email:${email}` : `linkchat:${String((chat && chat.key) || "")}`;
  }

  function buildIndex(chats) {
    const index = { byRelay: new Map(), byGuest: new Map(), byLink: new Map(), byRoom: new Map() };
    for (const chat of chats || []) {
      if (!chat || !chat.key) continue;
      index.byRoom.set(roomKeyOf(chat), chat);
      for (const link of chat.links || []) {
        if (link.relayId) index.byRelay.set(String(link.relayId), chat);
        if (link.shareLinkId) index.byLink.set(String(link.shareLinkId), chat);
      }
      for (const address of chat.guestAddresses || []) index.byGuest.set(String(address).trim().toLowerCase(), chat);
    }
    return index;
  }

  /** The link chat a projected message belongs to, or null. */
  function chatForMessage(index, message) {
    if (!index || !message) return null;
    const byId = index.byRelay.get(String(message.id || ""));
    if (byId) return byId;
    const key = String(message.partyKey || "");
    const address = key.startsWith("email:") ? key.slice(6).trim().toLowerCase() : "";
    const byGuest = address ? index.byGuest.get(address) : null;
    if (byGuest) return byGuest;
    // A reply that arrived before the chats refreshed still names its link.
    if (message.direction === "in" && message.source && message.source.host === "share_link") {
      return index.byLink.get(String(message.source.shareLinkId || "")) || null;
    }
    return null;
  }

  /**
   * File every row of a link chat into its room. Outbound rows are the links
   * (and anything said to a link replier before this existed); inbound rows
   * are replies typed on the link page. Once the person has an email,
   * whatever is sent from the room goes to it. Before that, the only address
   * in the room is a reply typed on the link page: answering it goes back
   * through the link, to that replier's own conversation, exactly as it did
   * before link chats (the newest reply is the room's address).
   */
  function rekey(messages, index) {
    if (!index || !index.byRoom.size) return messages;
    for (const message of messages || []) {
      const chat = chatForMessage(index, message);
      if (!chat) continue;
      const before = String(message.partyKey || "");
      const guestAddress = before.startsWith("email:") && before.slice(6).trim().toLowerCase().endsWith("@guests.sendrelays.com")
        ? before.slice(6).trim().toLowerCase() : "";
      message.partyKey = roomKeyOf(chat);
      message.linkChatKey = chat.key;
      message.addressRecipient = chat.contact && chat.contact.email
        ? { email: String(chat.contact.email), name: String(chat.contact.name || chat.name || "") }
        : message.direction !== "out" && guestAddress
          ? { email: guestAddress }
          : null;
      if (message.direction === "out") {
        message.party = chat.name;
      } else {
        // The card already says it came through the link; the stored
        // "(unverified)" marker would say it twice.
        message.linkReply = true;
        message.party = String(message.party || "").replace(/ \(unverified\)$/, "") || chat.name;
      }
    }
    return messages;
  }

  /** "Shared by link" / "Opened from the link" for a link the person has not been delivered yet. */
  function receiptLabel(message) {
    const link = message && message.shareLink;
    if (!link || link.kind === "sent" || link.state === "claimed" || link.state === "revoked") return "";
    return link.state === "opened" || link.firstOpenedAt ? "Opened from the link" : "Shared by link";
  }

  function firstNameOf(chat) {
    return String((chat && (chat.firstName || chat.name)) || "them").trim().split(/\s+/)[0] || "them";
  }

  function emailPlaceholder(chat) {
    const first = firstNameOf(chat).normalize("NFKD").replace(/[^\x00-\x7f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    return `${first || "name"}@company.com`;
  }

  /**
   * Which face the card wears. `ui` is the renderer's per-chat state:
   * { mode: "email" | "checking" | "", folded, expanded, joinedUntil, email, error }.
   */
  function cardKind(chat, ui = {}, now = Date.now()) {
    if (!chat) return "";
    if (ui.joinedUntil && ui.joinedUntil > now) return "joined";
    if (chat.state === "on_relay") return "";
    if (ui.mode === "checking") return "checking";
    if (ui.mode === "email") return "email";
    if (chat.state === "no_email") return ui.folded ? "fold-intro" : "intro";
    return ui.expanded ? "invite" : "fold-invite";
  }

  /** The smallest part of a long newest message the open card must leave in view. */
  const NEWEST_MIN_PX = 96;
  /**
   * Whether the open card covers the newest message: landing at the newest
   * message, the space left between the card and the composer must show all
   * of a short one and a real part of a long one.
   */
  function coversNewest(roomPx, newestPx) {
    return !(roomPx > 0 && roomPx >= Math.min(Math.max(0, newestPx), NEWEST_MIN_PX));
  }

  /**
   * What the room's composer does. "open": the ordinary composer (the person
   * has an email, or this is not a link chat). "link-reply": no email yet, but
   * they replied on the link page, so Send answers through the link, to the
   * newest replier. "blocked": no email and no reply, nothing could reach them.
   */
  function composerMode(chat, messages) {
    if (!chat || chat.state !== "no_email") return "open";
    const replied = (messages || []).some((message) => message && message.direction === "in" && message.linkReply
      && message.addressRecipient && message.addressRecipient.email);
    return replied ? "link-reply" : "blocked";
  }

  /** Send waits for an address: nothing typed in the room could reach the person yet. */
  function composerBlocked(chat, messages) {
    return composerMode(chat, messages) === "blocked";
  }

  function linkReplyHint(chat) {
    return `Replying through your link. Add ${firstNameOf(chat)}’s email to reach them on Relay.`;
  }

  function linkReplyHintHtml(chat) {
    return `${ic(LINK)}<span>${esc(linkReplyHint(chat))}</span>`;
  }

  function composerPlaceholder(chat) {
    return `Add ${firstNameOf(chat)}’s email to message them here.`;
  }

  function cardHtml(chat, ui = {}, now = Date.now()) {
    const kind = cardKind(chat, ui, now);
    if (!kind) return "";
    const first = esc(firstNameOf(chat));
    const mark = (cls = "", svg = LINK) => `<span class="lk-a-mk ${cls}">${svg}</span>`;
    const fold = '<button class="lk-a-min" type="button" data-lk-act="fold" aria-label="Fold">−</button>';
    const error = ui.error ? `<div class="lk-a-s lk-a-err" role="alert">${esc(ui.error)}</div>` : "";
    const note = ui.note ? `<span class="lk-a-note" role="status">${esc(ui.note)}</span>` : "";
    let cls = "";
    let inner = "";
    if (kind === "intro") {
      inner = `<div class="lk-a-card"><div class="lk-a-row">${mark()}<span class="lk-a-t">${first} isn’t one of your contacts yet.</span>${fold}</div>
        <div class="lk-a-s">You made a link for them. Copy it and send it to them yourself. Add their email so their replies come here and you can reach them on Relay.</div>
        <div class="lk-a-acts">${chat.newestUrl ? `<button class="lk-btn sm" type="button" data-lk-act="copy-link">${ic(LINK)}Copy link</button>` : ""}<button class="lk-btn sm soft" type="button" data-lk-act="add-email">Add ${first}’s email</button>${note}</div>${error}</div>`;
    } else if (kind === "fold-intro") {
      cls = " is-fold";
      inner = `<div class="lk-a-card" role="button" tabindex="0" aria-expanded="false" data-lk-act="expand"><div class="lk-a-row">${mark()}<span class="lk-a-t one">${note || "Not a contact yet"}</span><span class="lk-a-links">${chat.newestUrl ? '<button class="lk-a-link" type="button" data-lk-act="copy-link">Copy link</button>' : ""}<button class="rat-see lk-a-link" type="button" data-lk-act="add-email">Add email ${CHEV}</button></span></div></div>`;
    } else if (kind === "email" || kind === "checking") {
      const busy = kind === "checking";
      const label = `${first}’s email`;
      inner = `<form class="lk-a-card" data-lk-form="1" novalidate><div class="lk-a-row">${mark()}<label class="lk-a-t" for="lkEmail">${label}</label>${busy ? "" : '<button class="lk-a-min" type="button" data-lk-act="cancel" aria-label="Fold">−</button>'}</div>
        <div class="lk-field${busy ? " is-busy" : ""}"><input id="lkEmail" class="lk-input" type="email" inputmode="email" autocomplete="off" spellcheck="false" placeholder="${esc(emailPlaceholder(chat))}" value="${esc(ui.email || "")}"${busy ? " disabled" : ""} />${busy ? '<span class="lk-spin" aria-hidden="true"></span>' : `<button class="lk-btn" type="submit" data-lk-act="submit"${String(ui.email || "").includes("@") ? "" : " data-soft=\"1\""}>Add</button>`}</div>
        <div class="lk-a-s"${busy ? ' role="status"' : ""}>${busy ? `Looking for ${first} on Relay…` : `We’ll look for ${first} on Relay.`}</div>${error}</form>`;
    } else if (kind === "joined") {
      cls = " is-ok";
      const plural = Number(ui.delivered || 0) > 1;
      inner = `<div class="lk-a-card" role="status"><div class="lk-a-row top">${mark("ok", CHECK)}<span class="lk-a-t lk-a-sentence"><b>${first} is on Relay.</b> They’re now in your contacts, and ${plural ? "these Relays are" : "this Relay is"} in their inbox.</span></div><div class="lk-a-timer"><i style="animation-duration:${JOINED_MS}ms"></i></div></div>`;
    } else if (kind === "invite") {
      inner = `<div class="lk-a-card"><div class="lk-a-row">${mark("wait", PERSON_PLUS)}<span class="lk-a-t">${first} isn’t on Relay yet.</span>${fold}</div>
        <div class="lk-a-s">They can still read your link in their browser. When they join, this conversation will be waiting for them.</div>
        <div class="lk-a-acts"><button class="lk-btn sm" type="button" data-lk-act="copy-invite">${ic(LINK)}Copy invite link</button><button class="lk-btn sm ghost" type="button" data-lk-act="change-email">Change email</button>${note}</div>${error}</div>`;
    } else if (kind === "fold-invite") {
      cls = " is-fold";
      inner = `<div class="lk-a-card" role="button" tabindex="0" aria-expanded="false" data-lk-act="expand"><div class="lk-a-row">${mark("wait", PERSON_PLUS)}<span class="lk-a-t one">${note || `Invite ${first} to Relay`}</span><button class="rat-see lk-a-link" type="button" data-lk-act="copy-invite">${ic(LINK)}Copy invite link</button></div></div>`;
    }
    return `<div class="lk-a${cls}" data-lk-kind="${kind}" data-lk-key="${esc(chat.key)}"><div class="lk-in">${inner}</div></div>`;
  }

  /** The small link badge a link chat's avatar wears on the Chats list. */
  function badgeHtml(chat) {
    return chat && chat.state !== "on_relay" ? `<span class="lk-badge" aria-label="Shared by link">${LINK}</span>` : "";
  }

  function viaHtml() {
    return `<span class="lk-via">${ic(LINK)}replied from the link</span>`;
  }

  function receiptHtml(label) {
    return `${ic(LINK)}${esc(label)}`;
  }

  const api = {
    JOINED_MS, NEWEST_MIN_PX, coversNewest, chatsOf, roomKeyOf, buildIndex, chatForMessage, rekey, receiptLabel, firstNameOf,
    emailPlaceholder, cardKind, cardHtml, composerMode, composerBlocked, linkReplyHint, linkReplyHintHtml, composerPlaceholder, badgeHtml, viaHtml, receiptHtml,
  };
  root.RelayLinkChats = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
