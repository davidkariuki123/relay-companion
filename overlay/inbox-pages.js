// INBOX PAGES (David, 2026-10-09) — the Inbox is two pages: Chats, and to its
// right Relays and Tasks (what waits on you first, then what waits on others,
// then everything earlier). Two fingers move between them; page dots show
// where you are and click there; ⌘1 / ⌘2 go straight there. Now and then the
// list leans in a quarter of the way, showing the faces waiting on you along
// its edge, and settles back: the swipe teaches itself.
//
// The physics is page-physics.js. This file owns the DOM: the two panes, the
// list, the dots, the peek, and the hand-over from wheel events to frames.
// Gated by payload.features.inboxPages (on for everyone since 2026-10-10). With it off nothing here touches
// the page; the old Chats · Tasks · Relays rows stay.
(function (root) {
  "use strict";
  const Phys = root.RelayPagePhysics;
  const { PHYS } = Phys;
  const SPRING_CSS = "cubic-bezier(.22,1,.28,1)";
  const CHECK = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.4l2.3 2.3 4.7-5"/></svg>';
  const MARK = '<svg class="mark" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="0" y="6" width="4" height="4"/><rect x="6" y="6" width="4" height="4"/><rect x="12" y="6" width="4" height="4"/></svg>';
  // When the peek plays — rarely (David, 2026-10-09: "happens too often"):
  // something new arriving while Chats is showing, at most once every ten
  // minutes, and once an hour after the swipe has been used three times.
  // Opening the Inbox only ever peeks for someone who has never swiped, and
  // only the first three times.
  const PEEK = { AMOUNT: .24, HOLD: 700, OPEN_DELAY: 1200, OPEN_LIMIT: 3, GAP: 10 * 60 * 1000, LEARNED_AFTER: 3, LEARNED_GAP: 60 * 60 * 1000 };
  const TASK_UNDO_MS = 5000;

  function create(env) {
    const REDUCED = root.matchMedia ? root.matchMedia("(prefers-reduced-motion: reduce)").matches : false;
    const { cardEl, scrollEl } = env;
    const S = {
      on: false, view: "chats", html: "", earlierLimit: 15, scroll: { chats: 0, list: 0 },
      resume: null, cheer: false, lastWaiting: null, wasShowing: false, account: null,
      opened: new Set(), cleared: new Set(), pendingDone: new Map(), baseline: 0, swipes: 0, openPeeks: 0,
    };
    let chatsPane = null, listPane = null, pager = null, nameEl = null, toastEl = null, toastTimer = 0;

    // ---------- what this device remembers, per account ----------
    const key = (k) => `relayInboxPages:${S.account}:${k}`;
    function loadMemory() {
      S.account = env.accountKey() || "anon";
      const read = (k) => { try { return JSON.parse(env.pref(key(k), "") || "null"); } catch { return null; } };
      S.opened = new Set(read("opened") || []);
      S.cleared = new Set(read("cleared") || []);
      S.swipes = Number(read("swipes") || 0);
      S.openPeeks = Number(read("openPeeks") || 0);
      // Relays from before the pages existed on this device do not flood For
      // you: only those still unread when the pages first appeared, and
      // everything after.
      S.baseline = Number(read("baseline") || 0);
      if (!S.baseline) { S.baseline = Date.now(); env.setPref(key("baseline"), JSON.stringify(S.baseline)); }
      S.view = read("view") === "list" ? "list" : "chats";
    }
    function remember() {
      const cap = (set) => [...set].slice(-800);
      env.setPref(key("opened"), JSON.stringify(cap(S.opened)));
      env.setPref(key("cleared"), JSON.stringify(cap(S.cleared)));
      env.setPref(key("swipes"), JSON.stringify(S.swipes));
      env.setPref(key("view"), JSON.stringify(S.view));
    }

    // ---------- the list: what waits on you first ----------
    const payload = () => env.payload();
    const isTask = (r) => env.isTaskRow(r) || r.kind === "task" || r.request === true;
    const isResult = (r) => r.type === "completion";
    const t = (s) => new Date(s || 0).getTime();
    const activity = (r) => t(r.taskCompletedAt || r.taskRejectedAt || r.taskCancelledAt || r.taskStartedAt || r.createdAt);
    const inboundRow = (id) => (payload().relays || []).find((r) => r.id === id);
    const seen = (id) => S.opened.has(id) || S.cleared.has(id);
    // A Relay waits on you until YOU deal with it — opened in the reader,
    // handed to an agent, or ticked. Opening its chat is not dealing with it.
    function relayWaits(r) {
      if (seen(r.id)) return false;
      if (t(r.createdAt) > S.baseline) return true;
      return Boolean(r.unread);
    }
    function taskWaits(r) { return !S.pendingDone.has(r.id) && !env.taskIsOver(r) && !r.taskStartedAt; }
    function resultWaiting(s) { const res = s.taskResultRelayId && inboundRow(s.taskResultRelayId); return Boolean(res && relayWaits(res)); }
    function model() {
      const p = payload();
      const viewer = String(p.account?.email || "").trim().toLowerCase();
      const inbound = (p.relays || []).filter((r) => !r.deletedAt && !isResult(r) && !r.request
        && String(r.senderEmail || "").trim().toLowerCase() !== viewer
        && (isTask(r) || String(r.forAgent || "").trim()) && r.source?.host !== "relay-agent-run");
      const sent = (p.sent || []).filter((r) => !isResult(r) && (r.kind === "task" || String(r.forAgent || "").trim()));
      const you = [
        ...inbound.filter((r) => (isTask(r) ? taskWaits(r) : relayWaits(r))).map((r) => ({ r, dir: "in" })),
        ...sent.filter((r) => r.kind === "task" && env.taskIsOver(r) && resultWaiting(r)).map((r) => ({ r, dir: "out", result: r.taskResultRelayId })),
      ].sort((a, b) => activity(b.r) - activity(a.r));
      const youIds = new Set(you.map((x) => x.r.id || x.r.relayId));
      const others = sent.filter((r) => r.kind === "task" && !env.taskIsOver(r)).map((r) => ({ r, dir: "out" })).sort((a, b) => activity(b.r) - activity(a.r));
      const otherIds = new Set(others.map((x) => x.r.relayId || x.r.id));
      const earlier = [
        ...inbound.filter((r) => !youIds.has(r.id)).map((r) => ({ r, dir: "in" })),
        ...sent.filter((r) => !youIds.has(r.relayId || r.id) && !otherIds.has(r.relayId || r.id)).map((r) => ({ r, dir: "out" })),
      ].sort((a, b) => activity(b.r) - activity(a.r));
      return { you, others, earlier };
    }
    function rowHtml(x, waits) {
      let html = x.dir === "in"
        ? env.relayRowHtml(x.r, new Set(), { received: true })
        : env.sentRowsHtml([x.r]).replace('<span class="rk-sender">', '<span class="rk-sender"><span class="ip-to">To</span> ').replace(/<div class="rk-preview">[\s\S]*?<\/div>/, "");
      html = html.replace(/<button class="row-delete"[\s\S]*?<\/button>/, "");
      if (!waits) return html;
      const id = x.r.id || x.r.relayId;
      html = html.replace('class="row ', `data-ip="${env.esc(id)}"${x.result ? ` data-ip-result="${env.esc(x.result)}"` : ""} class="row waits `).replace(/ settled(?=[" ])/, "");
      return html.replace(/<span class="rk-time">([^<]*)<\/span>/, `<span class="ip-when"><span class="rk-time">$1</span><button class="ip-tick" type="button" data-ip-tick title="Done with this" aria-label="Done with this">${CHECK}</button></span>`);
    }
    function paintList() {
      if (!listPane) return;
      const m = model();
      const n = m.you.length;
      const sec = (label, count, cls = "") => `<div class="ip-sec ${cls}">${label}${count ? `<span class="n">${count}</span>` : ""}</div>`;
      let html = "";
      if (n) html += sec("For you", n, "you") + m.you.map((x) => rowHtml(x, true)).join("");
      else html += `<div class="ip-calm${S.cheer ? " cheer" : ""}">${MARK}<span>Nothing waiting on you</span></div>`;
      if (m.others.length) html += sec("With others", m.others.length) + m.others.map((x) => rowHtml(x, false)).join("");
      if (m.earlier.length) {
        html += sec("Earlier") + m.earlier.slice(0, S.earlierLimit).map((x) => rowHtml(x, false)).join("");
        if (m.earlier.length > S.earlierLimit) html += `<button class="ip-more" type="button" data-ip-more>Show all ${m.earlier.length}</button>`;
      }
      S.cheer = false;
      if (html === S.html) return;
      const before = new Map([...listPane.querySelectorAll(".row:not(.ip-gone)")].map((el) => [el.dataset.id || el.dataset.sentId, el.getBoundingClientRect().top]));
      const gone = new Set([...listPane.querySelectorAll(".row.ip-gone")].map((el) => el.dataset.id || el.dataset.sentId));
      env.foldHoverRow();
      listPane.innerHTML = html;
      S.html = html;
      env.wireTaskCards(listPane, () => env.renderRelays());
      if (REDUCED || !before.size || listPane.hidden) return;
      for (const el of listPane.querySelectorAll(".row")) {
        const k = el.dataset.id || el.dataset.sentId;
        if (gone.has(k)) { el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 120, easing: SPRING_CSS, fill: "backwards" }); continue; }
        const was = before.get(k);
        if (was === undefined) { if (el.classList.contains("waits")) el.animate([{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "none" }], { duration: 460, easing: SPRING_CSS }); continue; }
        const dy = was - el.getBoundingClientRect().top;
        if (Math.abs(dy) > .5) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 380, easing: SPRING_CSS });
      }
    }

    // ---------- the pages, built once the gate is on ----------
    function build() {
      const view = document.getElementById("relaysView");
      chatsPane = document.createElement("div");
      chatsPane.className = "ip-pane ip-chats";
      for (const id of ["relaysIntro", "serviceStoppedNote", "relaysList", "relaysEmpty"]) { const el = document.getElementById(id); if (el) chatsPane.appendChild(el); }
      listPane = document.createElement("div");
      listPane.className = "ip-pane ip-list";
      listPane.setAttribute("aria-label", "Relays and Tasks");
      listPane.hidden = true;
      view.append(chatsPane, listPane);
      pager = document.createElement("div");
      pager.className = "ip-pager";
      pager.innerHTML = `<div class="ip-dots" role="tablist" aria-label="Inbox pages"><button type="button" role="tab" data-ip-to="chats" aria-label="Chats" title="Chats  ⌘1"></button><button type="button" role="tab" data-ip-to="list" aria-label="Relays and Tasks" title="Relays and Tasks  ⌘2"><i class="ip-due"></i></button></div>`;
      nameEl = document.createElement("div");
      nameEl.className = "ip-name"; nameEl.setAttribute("aria-live", "polite");
      // The name is said once, as you arrive. A finished animation left on the
      // element replays whenever the card is shown again (folded → open), on
      // whatever page — so it is taken off the moment it ends.
      nameEl.addEventListener("animationend", () => nameEl.classList.remove("show"));
      cardEl.append(pager, nameEl);
      pager.addEventListener("click", (e) => { const b = e.target.closest("[data-ip-to]"); if (b) goTo(b.dataset.ipTo); });
      scrollEl.addEventListener("wheel", onWheel, { passive: false });
      listPane.addEventListener("click", onListClick);
      listPane.addEventListener("click", onHandOff, true);
      listPane.addEventListener("mouseover", onRowOver);
      listPane.addEventListener("mouseout", onRowOut);
      document.addEventListener("keydown", onKey);
      cardEl.classList.add("inbox-pages");
    }
    function inboxShowing() {
      if (env.peeking() || cardEl.classList.contains("collapsed") || cardEl.classList.contains("searching") || cardEl.classList.contains("signup")) return false;
      if (env.wideLayoutActive()) return env.wideSideTab() === "relays";
      return env.activeView() === "relays" && !env.requestInboxOpen();
    }

    // ---------- the physics, drawn ----------
    const P = { x: 0, v: 0, W: 344, live: false, raf: 0, mode: "idle", folded: false };
    const gesture = new Phys.WheelGesture();
    let samples = [], fx = 0, frame = 0, silenceTimer = 0, peekTimer = 0, lastPeek = -Infinity;
    function width() { P.W = Math.max(200, document.getElementById("relaysView").getBoundingClientRect().width || 344); }
    function goLive() {
      if (P.live) return;
      width();
      const base = S.view === "chats" ? chatsPane : listPane;
      const other = S.view === "chats" ? listPane : chatsPane;
      S.scroll[S.view] = scrollEl.scrollTop;
      const top = base.offsetTop + scrollEl.scrollTop - S.scroll[S.view === "chats" ? "list" : "chats"];
      if (other === listPane) paintList();
      Object.assign(other.style, { position: "absolute", left: "0", right: "0", top: `${top}px` });
      other.hidden = false;
      cardEl.classList.add("ip-moving");
      env.foldHoverRow();
      P.live = true;
    }
    function draw() {
      const W = P.W;
      const eff = Phys.clamp(P.x, W);
      const p = eff / W;
      listPane.style.transform = `translate3d(${(W - eff).toFixed(2)}px,0,0)`;
      chatsPane.style.transform = `translate3d(${(-PHYS.PARALLAX * eff).toFixed(2)}px,0,0)`;
      listPane.style.setProperty("--ip-shadow", String(p > .001 && p < .999 ? Math.sin(Math.PI * Math.min(1, p * 1.6 + .15)) * .9 + .1 : 0));
      chatsPane.style.setProperty("--ip-dim", String(p * PHYS.DIM));
      syncAt(p);
    }
    const drawSoon = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); }); };
    function rest(at) {
      cancelAnimationFrame(P.raf); P.raf = 0;
      P.mode = "idle"; P.folded = false;
      const toList = at === "list";
      const was = S.view;
      S.view = at;
      P.x = toList ? P.W : 0; P.v = 0;
      for (const el of [chatsPane, listPane]) { el.style.transform = ""; el.style.position = ""; el.style.left = el.style.right = el.style.top = ""; el.style.removeProperty("--ip-shadow"); el.style.removeProperty("--ip-dim"); }
      chatsPane.hidden = toList; listPane.hidden = !toList;
      cardEl.classList.remove("ip-moving");
      P.live = false;
      scrollEl.scrollTop = S.scroll[S.view];
      syncAt(toList ? 1 : 0);
      if (was !== S.view) {
        if (toList) S.swipes += 1;
        remember();
        if (nameEl) { nameEl.textContent = toList ? "Relays and Tasks" : "Chats"; nameEl.classList.remove("show"); void nameEl.offsetWidth; nameEl.classList.add("show"); }
      }
      if (toList) paintList();
    }
    function springTo(target, spring, onDone) {
      cancelAnimationFrame(P.raf);
      P.mode = "spring"; P.folded = true;
      if (REDUCED) { P.x = target; P.v = 0; draw(); onDone?.(); return; }
      let last = performance.now();
      const step = (now) => {
        const next = Phys.springStep(P, target, spring, (now - last) / 1000); last = now;
        P.x = next.x; P.v = next.v; draw();
        if (next.done) { P.raf = 0; onDone?.(); return; }
        P.raf = requestAnimationFrame(step);
      };
      P.raf = requestAnimationFrame(step);
    }
    function release(v) {
      const d = Phys.decide({ x: P.x, v, W: P.W, from: S.view });
      P.x = d.x; P.v = d.v; P.folded = true;
      springTo(d.target, d.spring, () => rest(d.to));
    }
    function grab() {
      cancelAnimationFrame(P.raf); P.raf = 0;
      clearTimeout(peekTimer);
      goLive();
      P.x = Phys.clamp(P.x, P.W);
      P.folded = false;
      P.mode = "drag"; P.v = 0;
    }
    function onWheel(e) {
      if (!S.on || !inboxShowing()) return;
      const now = performance.now();
      const act = gesture.feed(now, e.deltaX, e.deltaY, { pageMoving: P.mode === "spring" });
      if (act.block) e.preventDefault();
      if (act.grab) { grab(); samples = []; fx = P.x; }
      if (act.move !== undefined && (act.grab || gesture.phase === "x" || act.release)) {
        fx = Phys.clamp(fx + act.move, P.W); P.x = fx; samples.push([now, fx]);
        while (samples.length && now - samples[0][0] > PHYS.VEL_WINDOW) samples.shift();
        drawSoon();
      }
      clearTimeout(silenceTimer);
      if (act.release) { release(Phys.velocity(samples, now)); return; }
      if (gesture.phase === "x") silenceTimer = setTimeout(() => { if (gesture.silence()) release(Phys.velocity(samples, performance.now())); }, PHYS.SILENCE);
    }
    function goTo(to) {
      if (!S.on) return;
      if (!inboxShowing()) env.showInbox();
      if (to === S.view && !P.live) return;
      goLive();
      springTo(to === "list" ? P.W : 0, PHYS.TAP, () => rest(to));
    }
    function onKey(e) {
      if (!S.on || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key !== "1" && e.key !== "2") return;
      if (env.peeking() || cardEl.classList.contains("collapsed")) return;
      e.preventDefault();
      goTo(e.key === "1" ? "chats" : "list");
    }

    // ---------- the peek: the gesture's own motion, played by the page ----------
    function peek() {
      if (P.mode !== "idle" || S.view !== "chats" || !inboxShowing() || gesture.phase === "x") return;
      lastPeek = performance.now();
      goLive();
      springTo(P.W * PEEK.AMOUNT, PHYS.PEEK_OUT, () => {
        peekTimer = setTimeout(() => { if (P.mode !== "spring") return; springTo(0, PHYS.PEEK_HOME, () => rest("chats")); }, PEEK.HOLD);
      });
    }
    function peekAllowed() {
      const learned = S.swipes >= PEEK.LEARNED_AFTER;
      return performance.now() - lastPeek > (learned ? PEEK.LEARNED_GAP : PEEK.GAP);
    }

    // ---------- the dots ----------
    function syncAt(p) {
      if (!pager) return;
      pager.style.setProperty("--ip-at", String(p));
      for (const b of pager.querySelectorAll("[data-ip-to]")) { const on = (b.dataset.ipTo === "list") === (p > .5); b.classList.toggle("on", on); b.setAttribute("aria-selected", String(on)); }
    }
    function placePager() {
      if (!pager) return;
      const side = env.wideLayoutActive() ? document.getElementById("wideSide")?.getBoundingClientRect() : null;
      const c = cardEl.getBoundingClientRect();
      pager.style.left = side ? `${side.left - c.left + side.width / 2}px` : "";
      nameEl.style.left = pager.style.left;
    }

    // ---------- acts in the list ----------
    function rowEl(id) { return listPane.querySelector(`[data-ip="${CSS.escape(id)}"]`); }
    function leave(id, how, apply) {
      const el = rowEl(id);
      const finish = () => { apply(); paintList(); syncDue(); };
      if (!el || REDUCED) return finish();
      el.classList.add("ip-gone");
      const h = el.offsetHeight;
      const out = how === "opened" ? [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(18px)" }] : [{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${el.offsetWidth + 30}px)` }];
      el.animate(out, { duration: 240, easing: "cubic-bezier(.4,0,.8,.2)", fill: "forwards" }).onfinish = () => {
        el.style.overflow = "hidden";
        el.animate([{ height: `${h}px`, paddingTop: getComputedStyle(el).paddingTop }, { height: "0px", paddingTop: "0px" }], { duration: 260, easing: SPRING_CSS, fill: "forwards" }).onfinish = finish;
      };
    }
    const afterFiling = () => { if (!model().you.length) S.cheer = true; };
    function toast(text, undo) {
      if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "ip-toast"; toastEl.setAttribute("role", "status"); cardEl.appendChild(toastEl); }
      toastEl.innerHTML = `<span>${env.esc(text)}</span>${undo ? '<button type="button">Undo</button>' : ""}`;
      toastEl.classList.toggle("solo", !undo);
      toastEl.querySelector("button")?.addEventListener("click", () => { toastEl.classList.remove("on"); undo(); });
      toastEl.classList.add("on"); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove("on"), TASK_UNDO_MS);
    }
    function tick(id) {
      const el = rowEl(id), resultId = el?.dataset.ipResult, row = inboundRow(id);
      if (row && isTask(row)) {
        // A Task's tick is the Task's Done, sent after a moment to undo it.
        const timer = setTimeout(() => { S.pendingDone.delete(id); env.taskDone(id); }, TASK_UNDO_MS);
        leave(id, "tick", () => { S.pendingDone.set(id, timer); afterFiling(); });
        toast("Marked done", () => { clearTimeout(S.pendingDone.get(id) || timer); S.pendingDone.delete(id); paintList(); syncDue(); });
        return;
      }
      const k = resultId || id;
      leave(id, "tick", () => { S.cleared.add(k); remember(); afterFiling(); });
      toast("Moved to Earlier", () => { S.cleared.delete(k); remember(); paintList(); syncDue(); });
    }
    function onListClick(e) {
      if (e.target.closest("[data-ip-more]")) { S.earlierLimit = 1e9; paintList(); return; }
      const row = e.target.closest(".row");
      if (!row) return;
      if (e.target.closest("[data-ip-tick]")) { e.stopPropagation(); tick(row.dataset.ip); return; }
      if (e.target.closest("button, a, [data-stop]")) return;
      const ip = row.dataset.ip;
      const target = row.dataset.ipResult || row.dataset.id || row.dataset.sentId;
      S.scroll.list = scrollEl.scrollTop;
      S.resume = ip ? { id: ip, key: row.dataset.ipResult || ip, task: Boolean(inboundRow(ip) && isTask(inboundRow(ip))) } : null;
      env.openReader(target, row.dataset.ipResult ? "relays" : row.dataset.sentId ? "sent" : "relays");
    }
    // Handing a waiting Relay to an agent from its row is dealing with it.
    function onHandOff(e) {
      const b = e.target.closest("[data-host-open], [data-tk-copy]");
      const row = b && e.target.closest(".row.waits");
      if (!row) return;
      const ip = row.dataset.ip;
      const r = inboundRow(ip);
      if (r && !isTask(r)) setTimeout(() => leave(ip, "opened", () => { S.opened.add(row.dataset.ipResult || ip); remember(); afterFiling(); }), 600);
    }
    let restTimer = 0, leaveTimer = 0, hoverRow = null;
    function onRowOver(e) {
      const row = e.target.closest(".row"); if (!row || row === hoverRow) return;
      hoverRow = row; clearTimeout(restTimer); clearTimeout(leaveTimer);
      restTimer = setTimeout(() => { if (hoverRow === row && row.dataset.task && row.isConnected && !P.live) env.revealHoverRow(row); }, 1200);
    }
    function onRowOut(e) {
      const row = e.target.closest(".row"); if (!row || (e.relatedTarget && row.contains(e.relatedTarget))) return;
      hoverRow = null; clearTimeout(restTimer); leaveTimer = setTimeout(() => env.foldHoverRow(), 350);
    }
    function syncDue() {
      if (!pager) return;
      const n = model().you.length;
      pager.querySelector(".ip-due")?.classList.toggle("on", n > 0);
      const list = pager.querySelector('[data-ip-to="list"]');
      list?.setAttribute("aria-label", n ? `Relays and Tasks, ${n} waiting on you` : "Relays and Tasks");
      return n;
    }

    // ---------- the one call from renderAll ----------
    function sync() {
      const want = env.payload().features?.inboxPages === true;
      if (!want && !S.on) return;
      if (want && !S.on) { if (!chatsPane) build(); S.on = true; loadMemory(); cardEl.classList.add("inbox-pages"); if (S.view === "list") { chatsPane.hidden = true; listPane.hidden = false; } }
      if (!want && S.on) { S.on = false; cardEl.classList.remove("inbox-pages"); chatsPane.hidden = false; listPane.hidden = true; return; }
      if (S.account !== (env.accountKey() || "anon")) loadMemory();
      // Whatever the reader has open no longer waits on you.
      const reading = env.readerId && env.readerId();
      if (reading) noteOpened(reading);
      const showing = inboxShowing();
      pager.classList.toggle("ip-off", !showing);
      if (!showing) nameEl.classList.remove("show");
      placePager();
      if (!P.live) { chatsPane.hidden = S.view !== "chats"; listPane.hidden = S.view !== "list"; syncAt(S.view === "list" ? 1 : 0); }
      // Back from a reader opened from the list: the row you read leaves.
      if (S.resume && showing) {
        const r = S.resume; S.resume = null;
        requestAnimationFrame(() => { scrollEl.scrollTop = S.scroll.list; });
        if (r.id && !r.task) setTimeout(() => leave(r.id, "opened", () => { S.opened.add(r.key); remember(); afterFiling(); }), 300);
      }
      if (S.view === "list" || P.live) paintList();
      const m = model();
      syncDue();
      // When to peek: the Inbox coming into view with something waiting (for
      // someone still learning), or something new arriving while Chats shows.
      const ids = m.you.map((x) => x.r.id || x.r.relayId);
      if (showing && S.view === "chats" && P.mode === "idle") {
        const fresh = S.lastWaiting ? ids.filter((id) => !S.lastWaiting.includes(id)) : [];
        if (fresh.length && peekAllowed()) setTimeout(peek, 500);
        else if (!S.wasShowing && ids.length && S.swipes === 0 && S.openPeeks < PEEK.OPEN_LIMIT && peekAllowed()) {
          S.openPeeks += 1; env.setPref(key("openPeeks"), JSON.stringify(S.openPeeks));
          setTimeout(peek, PEEK.OPEN_DELAY);
        }
      }
      S.lastWaiting = ids;
      S.wasShowing = showing;
    }
    // The reader opened something: if it waited on you, it no longer does.
    function noteOpened(id) {
      if (!S.on || !id) return;
      const r = inboundRow(id);
      // Opened from the list itself: the row's own exit records it on return.
      if (S.resume && S.resume.key === id) return;
      if (r && !isTask(r) && !S.opened.has(id)) { S.opened.add(id); remember(); }
    }

    return { sync, noteOpened, goTo, state: () => ({ on: S.on, view: S.view, x: P.x, v: P.v, mode: P.mode, phase: gesture.phase, live: P.live }), peek };
  }

  root.RelayInboxPages = { create };
})(typeof window !== "undefined" ? window : globalThis);
