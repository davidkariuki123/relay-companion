(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RelayFirstRelayTutorial = api;
})(globalThis, function () {
  // THE FIRST RELAY TUTORIAL (David, 2026-10-10: board candidate D, "Drawn
  // line"). Once, right after onboarding, the pill teaches what a Relay is on
  // the welcome Relay itself: open the Relay Agent chat, open the Relay, meet
  // the part for you, open the part for your AI, and see that your AI reads
  // both. A short note sits at the bottom of the card and an ink line runs from
  // it to the real element it means. The person does every click; a click
  // anywhere else nudges.
  //
  // Motion laws (David's review of the board):
  //  · The ink is drawn every frame from LIVE element rects, so it never trails
  //    the page (scrolling, re-rendering, the reader growing).
  //  · On a screen change the ink retracts at the click (about 140 ms) and
  //    nothing is drawn while the screen moves. The next line draws in only
  //    once the new screen has settled: the pill's view transition has ended
  //    and the layout holds still for a few frames.
  //  · Within one screen the ink slides from the old target to the new one.
  //  · Reduced motion: the outline and the note appear in place, no travel.
  const WELCOME_TITLE = "Welcome to Relay";
  const WELCOME_SENDER = "Relay Agent";
  const WELCOME_EMAIL = "agent@sendrelays.com";
  // The first five beats teach the two parts; the rest open it in the person's AI.
  const BASE = Object.freeze([
    { id: "row", step: 1, kind: "click", screen: "inbox", route: "below", pad: 4, rad: 15,
      say: "Start here. Open your chat with <b>Relay Agent</b>." },
    { id: "card", step: 2, kind: "click", screen: "room", route: "right", pad: 6, rad: 21,
      say: "This card is <b>a Relay</b>. Open it." },
    { id: "you1", step: 3, kind: "explain", screen: "reader", route: "left", pad: 16, rad: 18,
      say: "This part is <b>for you</b>. Just the short version: what’s going on and what’s needed from you." },
    { id: "you2", step: 3, kind: "explain", screen: "reader", route: "left", pad: 16, rad: 18,
      say: "You never have to wade through AI slop." },
    { id: "agent", step: 4, kind: "click", screen: "reader", route: "right", pad: 8, rad: 19,
      say: "Now open the part <b>for your AI</b>." },
    { id: "ai", step: 4, kind: "explain", screen: "reader", route: "left", pad: 8, rad: 19,
      say: "This part is <b>for your AI</b>: all the detail and context, so it can answer your questions or do the work." },
    { id: "both", step: 5, kind: "explain", screen: "reader", route: "left", pad: 16, rad: 22,
      say: "Your AI reads <b>both parts</b>. You only need the top one." },
  ].map(Object.freeze));
  // The AI they chose at "Which AI do you use most?" (agent-onboarding.cjs keeps
  // it per account), as the reader's Open in row names it. Claude Code and
  // Codex open a session menu first; the chat apps and Conductor open at once.
  const HOSTS = Object.freeze({
    claude: Object.freeze({ key: "claude", tile: "claude-app", name: "Claude", menu: "" }),
    chatgpt: Object.freeze({ key: "chatgpt", tile: "chatgpt", name: "ChatGPT", menu: "" }),
    "claude-code": Object.freeze({ key: "claude-code", tile: "claude", name: "Claude Code", menu: "New Claude Code session" }),
    codex: Object.freeze({ key: "codex", tile: "codex", name: "Codex", menu: "New Codex task" }),
    conductor: Object.freeze({ key: "conductor", tile: "conductor", name: "Conductor", menu: "" }),
  });
  const TILE_HOST = Object.freeze(Object.fromEntries(Object.values(HOSTS).map((host) => [host.tile, host.key])));
  // The chosen AI when the reader offers it; otherwise the first app the row offers.
  function hostFor(choice, tiles) {
    const offered = (Array.isArray(tiles) ? tiles : []).map(String);
    const chosen = HOSTS[String(choice || "")];
    if (chosen && offered.includes(chosen.tile)) return chosen;
    const first = offered.find((tile) => TILE_HOST[tile]);
    return first ? HOSTS[TILE_HOST[first]] : null;
  }
  // Every beat, for one AI. Without one to open in, the tutorial ends at both parts.
  function plan(host) {
    if (!host) return Object.freeze(BASE.map((beat) => beat.id === "both" ? Object.freeze({ ...beat, kind: "finish" }) : beat));
    const name = host.name;
    return Object.freeze([
      ...BASE,
      { id: "open", step: 6, kind: "click", advance: "click", screen: "reader", note: "top", route: "down", pad: 5, rad: 13,
        say: `Open it in <b>${name}</b>. Your AI gets both parts, ready to go.` },
      ...(host.menu ? [{ id: "menu", step: 6, kind: "click", advance: "click", optional: true, screen: "menu", note: "top", route: "down", pad: 3, rad: 11,
        say: `Pick <b>${host.menu}</b> to start fresh.` }] : []),
      { id: "opening", step: 7, kind: "pause", screen: "reader", note: "top", target: false,
        say: `Well done. It’s opening in your <b>${name}</b> now.` },
      { id: "end", step: 7, kind: "finish", screen: "reader", note: "top", target: false,
        say: "That’s the tutorial. You’re all set." },
    ].map(Object.freeze));
  }
  const BEATS = plan(HOSTS.codex);
  const totalOf = (beats) => Math.max(...beats.map((beat) => beat.step));
  const TOTAL = totalOf(BEATS);
  const RESULTS = Object.freeze(["done", "skipped"]);

  // The welcome Relay: Relay Agent's automated first message. Without it there
  // is nothing to teach on, and the tutorial does not start.
  function findWelcomeRelay(relays) {
    const rows = (Array.isArray(relays) ? relays : []).filter((row) => row && row.direction === "inbound" && !row.deletedAt
      && String(row.title || "").trim() === WELCOME_TITLE && String(row.forAgent || "").trim()
      && (String(row.senderEmail || "").trim().toLowerCase() === WELCOME_EMAIL || String(row.senderName || "").trim() === WELCOME_SENDER));
    rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return rows[0] || null;
  }
  // Once per account: a saved result (done or skipped) means never again.
  function shouldStart({ welcome, saved, wide } = {}) {
    return Boolean(welcome && welcome.id) && !RESULTS.includes(saved) && !wide;
  }

  // ---- the state machine (pure) --------------------------------------------
  function initial() { return { status: "idle", index: -1 }; }
  function reduce(state, event, beats = BEATS) {
    const s = state || initial();
    const beat = beats[s.index];
    const forward = { status: "running", index: s.index + 1 };
    switch (event && event.type) {
      case "start": return s.status === "idle" ? { status: "running", index: 0 } : s;
      case "reached": // the app arrived where a click beat sends the person
        return s.status === "running" && beat && beat.kind === "click" && !beat.advance && event.id === beat.id ? forward : s;
      case "clicked": // a click beat whose click is the arrival (an app opening outside the pill, a menu)
        return s.status === "running" && beat && beat.advance === "click" && event.id === beat.id ? forward : s;
      case "missing": // an optional beat whose target never appeared: move on without it
        return s.status === "running" && beat && beat.optional && event.id === beat.id ? forward : s;
      case "next":
        return s.status === "running" && beat && (beat.kind === "explain" || beat.kind === "pause") ? forward : s;
      case "done":
        return s.status === "running" && beat && beat.kind === "finish" ? { status: "done", index: s.index } : s;
      case "skip":
        return s.status === "running" ? { status: "skipped", index: s.index } : s;
      case "lost": // what the tutorial points at is gone (a deleted Relay, another account)
        return s.status === "running" ? { status: "lost", index: s.index } : s;
      default: return s;
    }
  }
  // What the person saves when the tutorial ends: lost counts as done, so a
  // Relay that disappeared mid-way never brings the tutorial back.
  function resultFor(state) {
    if (!state) return null;
    if (state.status === "skipped") return "skipped";
    if (state.status === "done" || state.status === "lost") return "done";
    return null;
  }
  // Has the app arrived where this click beat leads?
  function reached(beat, app, welcomeId) {
    if (!beat || !app) return false;
    const id = String(welcomeId || "");
    if (beat.id === "row") return app.view === "threads" && Boolean(app.roomHasWelcome);
    if (beat.id === "card") return app.view === "reader" && String(app.readerId || "") === id;
    if (beat.id === "agent") return app.view === "reader" && String(app.readerId || "") === id && Boolean(app.detailsOpen);
    return false;
  }

  // ---- the live tutorial ----------------------------------------------------
  function create({ doc = document, card, welcomeId, getApp, onEnd, reducedMotion } = {}) {
    const win = doc.defaultView;
    const id = String(welcomeId || "");
    const css = (value) => (win.CSS && win.CSS.escape ? win.CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&"));
    const reduced = () => (typeof reducedMotion === "function" ? reducedMotion() : Boolean(win.matchMedia && win.matchMedia("(prefers-reduced-motion: reduce)").matches));
    const SVGNS = "http://www.w3.org/2000/svg";
    let state = initial();
    let layer = null, svg = null, line = null, head = null, loop = null, note = null;
    let raf = 0, ink = null, settling = false, lostSince = 0, ended = false, scrollAnim = null;
    // The chosen AI's plan until the reader shows which apps it can really open in.
    let beats = plan(HOSTS[String((getApp && getApp() || {}).chosenHost || "")] || HOSTS.claude);
    let host = null, pauseTimer = 0;

    // ---- the real elements -------------------------------------------------
    const q = (selector) => card.querySelector(selector);
    const E = {
      row: () => q(`#relaysList .relay-row[data-opening-id="${css(id)}"]`)
        || [...card.querySelectorAll("#relaysList .relay-row")].find((row) => row.dataset.party === WELCOME_SENDER) || null,
      message: () => q(`#thHistory .th-msg[data-msg="${css(id)}"]`),
      human: () => ["#readerBody .rd-kicker", "#readerBody .rd-headline", "#readerBody .rd-body"].map(q).filter(Boolean),
      details: () => q("#readerBody .rd-details"),
      head: () => q("#readerBody .rd-details-head"),
      actions: () => q("#readerBody .rd-foot .rd-host-actions"),
      bar: () => q("#readerBody .reader-bar"),
      scroller: () => q("#scroll"),
      tiles: () => [...card.querySelectorAll("#readerBody .rd-host-actions .th-host-tile[data-host]")],
      tile: (key) => q(`#readerBody .rd-host-actions .th-host-tile[data-host="${css(key)}"]`),
      // the session menu's first row, once the menu has opened
      fresh: () => { const row = q("#readerBody .sp-list.open [data-sp-new]"); return row && !row.disabled ? row : null; },
    };
    const R = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    const union = (rects) => {
      const rs = rects.filter(Boolean);
      if (!rs.length) return null;
      const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y));
      return { x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, h: Math.max(...rs.map((r) => r.y + r.h)) - y };
    };
    const pad = (r, p) => ({ x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p });
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    function agentVisible() {
      const det = E.details();
      if (!det) return null;
      const r = R(det);
      const actions = E.actions();
      const limit = actions ? R(actions).y - 18 : R(card).y + R(card).h - 30;
      return { x: r.x, y: r.y, w: r.w, h: Math.max(48, Math.min(r.y + r.h, limit) - r.y) };
    }
    // the rect a beat points at, in viewport coordinates; null while it is not on screen
    function rectFor(beat) {
      if (beat.id === "row") { const el = E.row(); if (!el) return null; const r = R(el); return { x: r.x + 8, y: r.y + 2, w: r.w - 16, h: r.h - 4 }; }
      if (beat.id === "card") { const el = E.message(); return el ? R(el) : null; }
      if (beat.id === "you1" || beat.id === "you2") return union(E.human().map(R));
      if (beat.id === "agent") { const el = E.details(); return el ? R(el) : null; }
      if (beat.id === "ai") return agentVisible();
      if (beat.id === "both") { const h = union(E.human().map(R)); const a = agentVisible(); return h && a ? union([h, a]) : null; }
      if (beat.id === "open") { const el = host && E.tile(host.tile); return el ? R(el) : null; }
      if (beat.id === "menu") { const el = E.fresh(); return el ? R(el) : null; }
      return null;
    }
    // the element a click beat's click must land in
    function hitFor(beat) {
      if (beat.id === "row") return E.row();
      if (beat.id === "card") return E.message();
      if (beat.id === "agent") return E.head();
      if (beat.id === "open") return host ? E.tile(host.tile) : null;
      if (beat.id === "menu") return E.fresh();
      return null;
    }
    const current = () => beats[state.index] || null;
    const step = (event) => { state = reduce(state, event, beats); };
    // Which AI the Relay opens in: the one chosen at onboarding, if the reader offers it.
    function resolveHost() {
      const app = getApp() || {};
      host = hostFor(app.chosenHost, E.tiles().map((tile) => tile.getAttribute("data-host")));
      beats = plan(host);
    }

    // ---- drawing -------------------------------------------------------------
    function el(tag, cls, parent, html) { const e = doc.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; parent.appendChild(e); return e; }
    function sv(tag, cls, parent) { const e = doc.createElementNS(SVGNS, tag); if (cls) e.setAttribute("class", cls); parent.appendChild(e); return e; }
    function mount() {
      layer = el("div", "frt-layer", card);
      layer.setAttribute("aria-hidden", "false");
      svg = sv("svg", "frt-ink", layer);
      loop = sv("path", "frt-loop", svg); line = sv("path", "frt-line", svg); head = sv("path", "frt-head", svg);
      [line, head, loop].forEach((p) => { p.style.opacity = "0"; });
      note = el("div", "frt-note", layer, `<div class="frt-top"><span class="frt-k"></span><button type="button" class="frt-skip" data-frt="skip">Skip</button></div><div class="frt-text" aria-live="polite"></div>`);
      note.setAttribute("role", "dialog");
      note.setAttribute("aria-label", "Your first Relay");
      note.style.opacity = "0";
    }
    const local = (r) => { const c = R(card); return { x: r.x - c.x, y: r.y - c.y, w: r.w, h: r.h }; };
    // The note sits at the bottom of the card, over the reply box; once the
    // lesson moves to the Open in row (which lives down there), it sits at the top.
    function noteBox(beat) {
      const c = R(card);
      const w = Math.min(c.w - 24, 476);
      note.style.width = `${w}px`;
      const h = note.offsetHeight;
      const top = beat && beat.note === "top";
      const below = top ? (E.bar() ? R(E.bar()).y + R(E.bar()).h - c.y : 56) + 8 : 0;
      return { x: (c.w - w) / 2, y: top ? below : c.h - 12 - h, w, h };
    }
    function placeNote(beat, glide = false) {
      const from = parseFloat(note.style.top);
      const n = noteBox(beat);
      note.style.left = `${n.x}px`; note.style.top = `${n.y}px`;
      if (glide && !reduced() && Number.isFinite(from) && Math.abs(from - n.y) > 2) {
        note.animate([{ top: `${from}px` }, { top: `${n.y}px` }], { duration: 640, easing: "cubic-bezier(.22,1,.28,1)" });
      }
      return n;
    }
    function fillNote(beat) {
      note.querySelector(".frt-k").textContent = `Step ${beat.step} of ${totalOf(beats)}`;
      const action = beat.kind === "explain" ? `<button type="button" class="frt-go" data-frt="next">Next<span aria-hidden="true">›</span></button>`
        : beat.kind === "finish" ? `<button type="button" class="frt-go" data-frt="done">Done</button>` : "";
      const hint = beat.kind === "click" ? `<span class="frt-hint">Click it</span>` : "<span></span>";
      const text = note.querySelector(".frt-text");
      // Everything still on the page leaves, including words that are mid-way in.
      const leaving = [...text.children].filter((child) => !child.classList.contains("frt-out"));
      const next = el("div", "frt-in", text, `<div class="frt-say">${beat.say}</div><div class="frt-sub">${hint}${action}</div>`);
      for (const old of leaving) {
        if (reduced()) { old.remove(); continue; }
        old.classList.remove("frt-enter");
        old.classList.add("frt-out");
        win.setTimeout(() => old.remove(), 300);
      }
      if (leaving.length && !reduced()) next.classList.add("frt-enter");
    }
    // geometry: a cubic from the note to the target, an arrowhead, a pen loop around it
    function geometry(beat, r, n, c) {
      let S, E2, C1, C2;
      if (beat.route === "down") {
        // from the note at the top, down to a control near the bottom
        S = { x: n.x + n.w * 0.62, y: n.y + n.h + 7 };
        E2 = { x: clamp(r.x + r.w / 2, r.x + 12, r.x + r.w - 12), y: r.y - 9 };
        const fall = E2.y - S.y;
        C1 = { x: S.x - 26, y: S.y + fall * 0.5 };
        C2 = { x: E2.x - 34, y: E2.y - fall * 0.42 };
      } else if (beat.route === "below") {
        S = { x: n.x + n.w * 0.64, y: n.y - 7 };
        E2 = { x: clamp(S.x - 34, r.x + 30, r.x + r.w - 30), y: r.y + r.h + 9 };
        const gap = S.y - E2.y;
        C1 = { x: S.x + 22, y: S.y - gap * 0.5 };
        C2 = { x: E2.x + 30, y: E2.y + gap * 0.42 };
      } else {
        const left = beat.route === "left";
        S = { x: left ? n.x + 38 : n.x + n.w - 38, y: n.y - 7 };
        E2 = { x: left ? r.x - 8 : r.x + r.w + 8, y: r.y + Math.min(r.h * 0.42, 54) };
        const edge = left ? 8 : c.w - 8;
        let gx = left ? (edge + E2.x) / 2 - 6 : (edge + E2.x) / 2 + 6;
        gx = left ? Math.min(gx, E2.x - 14) : Math.max(gx, E2.x + 14);
        gx = left ? Math.max(gx, 6) : Math.min(gx, c.w - 6);
        const rise = S.y - E2.y;
        C1 = { x: gx, y: S.y - rise * 0.18 };
        C2 = { x: gx, y: E2.y + Math.min(40, rise * 0.22) };
      }
      return { S, E: E2, C1, C2 };
    }
    function loopNums(r, rr) {
      const { x, y, w, h } = r, k = 0.6;
      return [x + rr + 10, y - 0.6, x + w * 0.4, y - 1.4, x + w * 0.7, y - 0.4, x + w - rr, y, x + w, y, x + w, y + rr,
        x + w + k, y + h * 0.4, x + w + k, y + h * 0.6, x + w, y + h - rr, x + w, y + h, x + w - rr, y + h,
        x + w * 0.6, y + h + 0.9, x + w * 0.3, y + h + 0.6, x + rr, y + h, x, y + h, x, y + h - rr,
        x - k, y + h * 0.6, x - k, y + h * 0.4, x, y + rr, x, y, x + rr, y - 0.4, x + rr + 24, y - 2.2];
    }
    const LOOP = "M # # C # # # # # # Q # # # # C # # # # # # Q # # # # C # # # # # # Q # # # # C # # # # # # Q # # # # L # #";
    const fmt = (template, nums) => { let i = 0; return template.replace(/#/g, () => nums[i++].toFixed(2)); };
    function nums(beat) {
      const target = rectFor(beat);
      if (!target) return null;
      const c = R(card), n = { ...R(note), x: R(note).x - c.x, y: R(note).y - c.y };
      const r = pad(local(target), beat.pad);
      const g = geometry(beat, r, n, c);
      const ang = Math.atan2(g.E.y - g.C2.y, g.E.x - g.C2.x), a1 = ang + Math.PI * 0.8, a2 = ang - Math.PI * 0.8, L = 9.5;
      return {
        line: [g.S.x, g.S.y, g.C1.x, g.C1.y, g.C2.x, g.C2.y, g.E.x, g.E.y],
        head: [g.E.x + Math.cos(a1) * L, g.E.y + Math.sin(a1) * L, g.E.x, g.E.y, g.E.x + Math.cos(a2) * L, g.E.y + Math.sin(a2) * L],
        loop: loopNums(r, beat.rad),
      };
    }
    const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
    const ease = (p) => 1 - Math.pow(1 - p, 3);
    function dash(path, p) {
      if (p >= 1) { path.style.strokeDasharray = ""; path.style.strokeDashoffset = ""; return; }
      const len = path.getTotalLength();
      path.style.strokeDasharray = `${len} ${len + 2}`;
      path.style.strokeDashoffset = String(len * (1 - p));
    }
    // ---- one frame: hide while the card is folded, track the ink, notice arrivals
    function frame(now) {
      raf = 0;
      if (ended) return;
      const app = getApp() || {};
      layer.hidden = Boolean(app.hidden);
      const beat = current();
      if (beat && !app.hidden && !settling) {
        if (beat.kind === "click" && !beat.advance && reached(beat, app, id)) arrive(beat);
        else if (beat.target === false || beat.advance) lostSince = 0;
        else if (!rectFor(beat) && !app.transitioning) {
          if (!lostSince) lostSince = now;
          else if (now - lostSince > 2500) { finish({ type: "lost" }); return; }
        } else lostSince = 0;
      }
      if (ink && !app.hidden) drawInk(now);
      raf = win.requestAnimationFrame(frame);
    }
    function drawInk(now) {
      let g = nums(ink.beat);
      if (!g) return;
      if (ink.from) {
        const t = reduced() ? 1 : Math.min(1, (now - ink.t0) / ink.dur);
        const f = t < 1 ? nums(ink.from) : null;
        if (f) { const e = ease(t); g = { line: lerp(f.line, g.line, e), head: lerp(f.head, g.head, e), loop: lerp(f.loop, g.loop, e) }; }
        else ink.from = null;
      }
      line.setAttribute("d", fmt("M # # C # # # # # #", g.line));
      head.setAttribute("d", fmt("M # # L # # L # #", g.head));
      loop.setAttribute("d", fmt(LOOP, g.loop));
      if (ink.draw0 != null) {
        const t = reduced() ? 1e9 : now - ink.draw0;
        const pl = Math.min(1, t / 700), pc = Math.min(1, Math.max(0, (t - 560) / 860));
        dash(line, ease(pl)); dash(loop, 1 - Math.pow(1 - pc, 2));
        head.style.opacity = String(t > 660 ? Math.min(1, (t - 660) / 140) : 0);
        if (pl >= 1 && pc >= 1) ink.draw0 = null;
      }
    }
    function run() { if (!raf && !ended) raf = win.requestAnimationFrame(frame); }
    function drawIn(beat) {
      [line, head, loop].forEach((p) => { p.getAnimations().forEach((a) => a.cancel()); p.style.opacity = "1"; });
      head.style.opacity = "0";
      ink = { beat, from: null, draw0: win.performance.now() };
    }
    function slideTo(beat, dur = 820) {
      if (!ink) { drawIn(beat); return; }
      if (ink.beat === beat) return;
      ink = { beat, from: ink.beat, t0: win.performance.now(), dur, draw0: null };
    }
    // Pull the ink back into the note, fast. Nothing is drawn while a screen moves.
    function retract() {
      if (!ink) return;
      ink = null;
      if (reduced()) { [line, head, loop].forEach((p) => { p.style.opacity = "0"; }); return; }
      for (const p of [line, loop]) {
        const len = p.getTotalLength();
        p.style.strokeDasharray = `${len} ${len + 2}`;
        const a = p.animate([{ strokeDashoffset: 0, opacity: 1 }, { strokeDashoffset: len, opacity: 0.2 }], { duration: 140, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
        a.finished.then(() => { if (!ink) { p.style.opacity = "0"; a.cancel(); } }).catch(() => {});
      }
      head.style.opacity = "0";
    }
    function noteOut() {
      if (reduced()) { note.style.opacity = "0"; return; }
      note.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(6px)" }], { duration: 140, easing: "ease-in", fill: "forwards" })
        .finished.then((a) => { note.style.opacity = "0"; try { a.cancel(); } catch {} }).catch(() => {});
    }
    function noteIn(beat) {
      placeNote(beat);
      note.getAnimations().forEach((a) => a.cancel());
      note.style.opacity = "1";
      if (!reduced()) note.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 420, easing: "cubic-bezier(.22,1,.28,1)" });
    }
    // Resolves once the screen has stopped moving: no view transition running,
    // the card's size held by a ResizeObserver, and the target's rect identical
    // for three frames in a row.
    function settled(beat, max = 6000) {
      settling = true;
      return new Promise((resolve) => {
        const start = win.performance.now();
        let last = "", stable = 0;
        const ro = new win.ResizeObserver(() => { stable = 0; });
        ro.observe(card);
        const tick = () => {
          if (ended) { ro.disconnect(); settling = false; resolve(false); return; }
          const app = getApp() || {};
          const r = !app.hidden && !app.transitioning ? rectFor(beat) : null;
          const c = R(card);
          const key = r ? [r.x, r.y, r.w, r.h, c.w, c.h].map(Math.round).join(",") : "";
          if (key && key === last) stable += 1; else { stable = 0; last = key; }
          if (stable >= 3) { ro.disconnect(); settling = false; resolve(true); return; }
          if (win.performance.now() - start > max) { ro.disconnect(); settling = false; resolve(false); return; }
          win.requestAnimationFrame(tick);
        };
        win.requestAnimationFrame(tick);
      });
    }
    function animateScroll(to, dur = 820) {
      const sc = E.scroller();
      if (!sc) return;
      to = clamp(to, 0, sc.scrollHeight - sc.clientHeight);
      if (scrollAnim) scrollAnim.cancelled = true;
      if (reduced() || Math.abs(to - sc.scrollTop) < 1) { sc.scrollTop = to; return; }
      const job = { cancelled: false };
      scrollAnim = job;
      const from = sc.scrollTop, t0 = win.performance.now();
      const step = (now) => {
        if (job.cancelled || ended) return;
        const p = Math.min(1, (now - t0) / dur);
        const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
        sc.scrollTop = from + (to - from) * e;
        if (p < 1) win.requestAnimationFrame(step);
      };
      win.requestAnimationFrame(step);
    }
    const contentTop = () => { const bar = E.bar(); if (bar) { const r = R(bar); return r.y + r.h; } const sc = E.scroller(); return sc ? R(sc).y : R(card).y; };
    function scrollFor(beat) {
      const sc = E.scroller();
      if (!sc) return;
      if (beat.id === "ai") { const det = E.details(); if (det) animateScroll(sc.scrollTop + R(det).y - contentTop() - 22); }
      if (beat.id === "both") { const h = union(E.human().map(R)); if (h) animateScroll(sc.scrollTop + h.y - contentTop() - 26, 780); }
    }

    // ---- the sequence ----------------------------------------------------------
    let fresh = true;
    const nextFrame = () => new Promise((resolve) => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
    async function show(beat, { sameScreen = false } = {}) {
      if (beat.target === false) {
        // nothing on screen to point at: the AI is opening outside the pill
        await nextFrame();
        if (ended) return;
      } else if (!sameScreen) {
        const ok = await settled(beat, beat.optional ? 4500 : 6000);
        if (ended) return;
        if (!ok && beat.optional) {
          // the menu never showed its entry: carry on without this step
          step({ type: "missing", id: beat.id });
          void show(current(), { sameScreen: true });
          return;
        }
        if (!ok) { finish({ type: "lost" }); return; }
      }
      if (beat.id === "both") {
        // The reader is on screen: which AI will it open in? (none: it ends here)
        resolveHost();
        beat = current();
      }
      fillNote(beat);
      if (fresh || !sameScreen || note.style.opacity !== "1") noteIn(beat); else placeNote(beat, true);
      fresh = false;
      if (beat.target === false) retract();
      else if (sameScreen && ink) {
        // the same thing, new words: the pen goes over the circle once more
        if (ink.beat.id === "you1" && beat.id === "you2") { ink.beat = beat; if (!reduced()) loop.animate([{ strokeWidth: 1.6 }, { strokeWidth: 2.4 }, { strokeWidth: 1.6 }], { duration: 700, easing: "ease-in-out" }); }
        else slideTo(beat);
      } else drawIn(beat);
      scrollFor(beat);
      if (beat.kind === "pause") {
        win.clearTimeout(pauseTimer);
        pauseTimer = win.setTimeout(() => {
          if (ended || current() !== beat) return;
          step({ type: "next" });
          void show(current(), { sameScreen: true });
        }, reduced() ? 2200 : 2600);
      }
      run();
    }
    function arrive(beat) {
      const next = beats[state.index + 1];
      step({ type: "reached", id: beat.id });
      if (!next) return;
      void show(next, { sameScreen: beat.screen === next.screen });
    }
    // A click on the right thing: let it through to the pill, and get out of
    // the way of what it causes.
    function onTargetClick(beat) {
      const next = beats[state.index + 1];
      if (!next) return;
      if (beat.advance === "click") {
        // The click itself is the arrival: an AI opening outside the pill, or a
        // menu opening inside it (a transition too: the ink pulls back and waits).
        retract();
        step({ type: "clicked", id: beat.id });
        void show(next, { sameScreen: next.target === false });
        return;
      }
      if (beat.screen === next.screen) { slideTo(next, 900); return; } // the reader stays: slide while it scrolls
      retract();
      if (beat.id === "card") noteOut(); // the card grows into the reader; the note returns at the new bottom
    }
    function advanceExplain() {
      const beat = current();
      if (!beat || beat.kind !== "explain") return;
      step({ type: "next" });
      void show(current(), { sameScreen: true });
    }
    function nudge() {
      if (reduced()) return;
      loop.animate([{ strokeWidth: 1.6 }, { strokeWidth: 2.8 }, { strokeWidth: 1.6 }], { duration: 520, easing: "ease-out" });
      note.animate([{ transform: "translateX(0)" }, { transform: "translateX(-5px)" }, { transform: "translateX(4px)" }, { transform: "translateX(-2px)" }, { transform: "translateX(0)" }], { duration: 420, easing: "ease-out" });
    }
    function finish(event) {
      if (ended) return;
      step(event);
      if (state.status === "running") return;
      ended = true;
      if (raf) win.cancelAnimationFrame(raf);
      raf = 0;
      if (scrollAnim) scrollAnim.cancelled = true;
      win.clearTimeout(pauseTimer);
      for (const [type, handler] of listeners) doc.removeEventListener(type, handler, true);
      const gone = () => { if (layer) layer.remove(); };
      if (reduced() || state.status === "lost") gone();
      else {
        retract();
        note.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(10px)" }], { duration: 320, easing: "ease-in", fill: "forwards" });
        win.setTimeout(gone, 340);
      }
      if (typeof onEnd === "function") onEnd(resultFor(state), state);
    }

    // ---- input: the person does the clicking ----------------------------------
    const allowed = (t) => Boolean(t && t.closest && (t.closest(".frt-note") || t.closest("#lockup") || t.closest(".card-resize")));
    const inHit = (t, beat) => {
      const hit = beat && beat.kind === "click" ? hitFor(beat) : null;
      if (!hit || !t || !hit.contains(t)) return false;
      // inside the card, its own controls (Open in, menus, reactions) are not "open the Relay"
      const inner = t.closest('[data-stop="1"], button, a');
      return !inner || inner === hit || !hit.contains(inner) || inner.contains(hit);
    };
    const onPointer = (event) => {
      if (ended || !layer || layer.hidden) return;
      if (allowed(event.target) || inHit(event.target, current())) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onClick = (event) => {
      if (ended || !layer || layer.hidden) return;
      const t = event.target;
      const act = t && t.closest && t.closest("[data-frt]");
      if (act) {
        event.preventDefault(); event.stopPropagation();
        const what = act.getAttribute("data-frt");
        if (what === "skip") finish({ type: "skip" });
        else if (what === "next") advanceExplain();
        else if (what === "done") finish({ type: "done" });
        return;
      }
      if (allowed(t)) return;
      const beat = current();
      if (beat && inHit(t, beat) && !settling) { onTargetClick(beat); return; } // through to the pill
      event.preventDefault();
      event.stopPropagation();
      if (beat && beat.kind === "explain") {
        const r = rectFor(beat);
        if (r && event.clientX >= r.x && event.clientX <= r.x + r.w && event.clientY >= r.y && event.clientY <= r.y + r.h) { advanceExplain(); return; }
      }
      nudge();
    };
    const onKey = (event) => {
      if (ended || !layer || layer.hidden) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); finish({ type: "skip" }); }
    };
    const listeners = [["pointerdown", onPointer], ["mousedown", onPointer], ["dblclick", onPointer], ["contextmenu", onPointer], ["click", onClick], ["keydown", onKey]];

    return {
      start() {
        if (state.status !== "idle" || !card) return false;
        state = reduce(state, { type: "start" });
        mount();
        for (const [type, handler] of listeners) doc.addEventListener(type, handler, true);
        void show(current());
        run();
        return true;
      },
      skip() { finish({ type: "skip" }); },
      destroy() { finish({ type: "skip" }); },
      get state() { return { ...state }; },
      get beat() { return current() ? current().id : null; },
    };
  }

  return { TOTAL, BEATS, BASE, HOSTS, RESULTS, hostFor, plan, totalOf, WELCOME_TITLE, WELCOME_SENDER, WELCOME_EMAIL, findWelcomeRelay, shouldStart, initial, reduce, resultFor, reached, create };
});
