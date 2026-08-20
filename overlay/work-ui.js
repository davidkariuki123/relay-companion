/* Relay Work presentation controllers.
 *
 * Native provider events are reduced and redacted in the main process.  This
 * file consumes only that bounded canonical presentation.  It never infers a
 * final answer, user side, or disclosure membership from prose.
 */
(function installRelayWorkUI(global) {
  "use strict";

  const FOLLOW_THRESHOLD_PX = 24;
  const USER_SCROLL_STABLE_MS = 1000;
  const DISCLOSURE_TRANSITION_MS = 300;
  // Installed ChatGPT.app 1.2026.217 bundle audit (2026-08-15):
  // app-DuLjgNkx.css defines --text-base:14px and
  // --text-base--line-height:calc(1.5 / 1). The Electron body maps
  // --vscode-font-size to --text-base, --vscode-chat-font-size to that value,
  // and --codex-chat-font-size to --vscode-chat-font-size. `text-size-chat`
  // therefore computes to 14px with inherited 1.5 leading = exactly 21px.
  // This is the audited formula; 14/22 is not present in this installed build.
  const NATIVE_TYPOGRAPHY = Object.freeze({ fontSizePx: 14, lineHeightPx: 21, lineHeightRatio: 1.5 });

  function nextDisclosureState(state, event) {
    if (event === "toggle") {
      if (state === "collapsed" || state === "closing") return "opening";
      return "closing";
    }
    if (event === "transitionend") {
      if (state === "opening") return "expanded";
      if (state === "closing") return "collapsed";
    }
    return state;
  }

  function normalizeConversationView(view) {
    const source = Array.isArray(view) ? view : Array.isArray(view && view.turns) ? view.turns : [];
    const turns = source.map((turn, turnIndex) => {
      const units = (Array.isArray(turn && turn.units) ? turn.units : []).filter(Boolean).map((unit, unitIndex) => ({
        ...unit,
        id: String(unit.id || `unit-${turnIndex}-${unitIndex}`),
        key: String(unit.id || `unit-${turnIndex}-${unitIndex}`),
        placement: String(unit.placement || "post"),
      }));
      const status = String(turn && turn.status || "settled");
      const settled = turn?.settled === true || ["settled", "completed", "failed", "cancelled", "stopped", "interrupted"].includes(status);
      return {
        key: String(turn && (turn.key || turn.id) || `turn-${turnIndex}`),
        turnId: String(turn && (turn.key || turn.id) || `turn-${turnIndex}`),
        units,
        users: units.filter((unit) => unit.placement === "user"),
        final: turn?.final || units.find((unit) => unit.placement === "final") || null,
        settled,
        active: turn?.active === true || !settled,
        cancelled: turn?.cancelled === true || status === "cancelled" || status === "interrupted",
        status,
        providerState: String(turn?.providerState || ""),
        providerLabel: String(turn?.providerLabel || ""),
        composerAvailable: turn?.composerAvailable !== false,
        requiresAction: turn?.requiresAction === true,
        canCollapse: turn?.canCollapse === true,
        timing: turn?.timing || { durationMs:null },
        summary: String(turn && turn.summary || ""),
        retryText: Array.isArray(turn?.retryText) ? turn.retryText.slice() : [],
        error: turn?.error || null,
        empty: turn?.empty === true || units.length === 0,
      };
    });
    return { done: turns.length > 0 && turns.every((turn) => turn.settled), turns };
  }

  /**
   * Partition one canonical turn without changing order. Consecutive
   * collapsible units form a disclosure; a same-turn Steer splits those runs
   * and remains a direct right-side sibling. A divider exists only at the
   * literal disclosure/final boundary it joins.
   */
  function partitionTurn(turn) {
    const blocks = [];
    let pending = [];
    let segment = 0;
    const flush = () => {
      if (!pending.length) return;
      if (turn?.canCollapse) {
        blocks.push({
          key:`activity:${segment}`,
          type:"activity",
          turnId:String(turn.turnId || turn.key || ""),
          segment:segment++,
          units:pending,
          label:String(turn.summary || "Previous messages"),
        });
      } else {
        blocks.push(...pending.map((unit) => ({ key:`unit:${unit.id}`, type:"unit", unit })));
      }
      pending = [];
    };
    for (const unit of turn?.units || []) {
      if (unit.placement === "collapsible") { pending.push(unit); continue; }
      flush();
      if (unit.placement === "user") blocks.push({ key:`user:${unit.id}`, type:"user", unit });
      else if (unit.placement === "final") blocks.push({ key:`final:${unit.id}`, type:"final", unit });
      else blocks.push({ key:`${unit.placement || "post"}:${unit.id}`, type:"unit", unit });
    }
    flush();
    if (turn?.final?.text && !blocks.some((block) => block.type === "final")) {
      blocks.push({ key:`final:${turn.final.id || "receipt"}`, type:"final", unit:turn.final });
    }
    const finalAt = blocks.findIndex((block) => block.type === "final");
    if (finalAt > 0 && blocks[finalAt - 1].type === "activity") {
      blocks.splice(finalAt, 0, { key:"worked-for-divider", type:"divider" });
    }
    return blocks;
  }

  function createSummaryStabilizer(options) {
    const opts = options || {};
    const delay = Number.isFinite(opts.delayMs) ? opts.delayMs : USER_SCROLL_STABLE_MS;
    const setTimer = opts.setTimer || global.setTimeout.bind(global);
    const clearTimer = opts.clearTimer || global.clearTimeout.bind(global);
    const entries = new Map();
    return {
      offer(key, value, commit, immediate) {
        const id = String(key);
        const next = String(value || "");
        const prev = entries.get(id);
        if (!prev || immediate) {
          if (prev && prev.timer) clearTimer(prev.timer);
          entries.set(id, { value: next, pending: next, timer: null, commit });
          commit(next);
          return;
        }
        // The same logical disclosure can be painted into a fresh DOM node
        // after the reader changes face or rebuilds its Work surface. The
        // stabilizer owns values, not nodes, so always hydrate the caller with
        // the currently committed value. Also leave an identical pending
        // value's original timer alone: repaint cadence must never postpone a
        // label forever.
        if (next === prev.value) {
          if (prev.timer) clearTimer(prev.timer);
          prev.pending = next;
          prev.timer = null;
          prev.commit = commit;
          commit(prev.value);
          return;
        }
        if (next === prev.pending) {
          prev.commit = commit;
          commit(prev.value);
          return;
        }
        if (prev.timer) clearTimer(prev.timer);
        prev.pending = next;
        prev.commit = commit;
        prev.timer = setTimer(() => {
          prev.value = prev.pending;
          prev.timer = null;
          prev.commit(prev.value);
        }, delay);
      },
      clear(key) {
        const id = String(key);
        const prev = entries.get(id);
        if (prev && prev.timer) clearTimer(prev.timer);
        entries.delete(id);
      },
      value(key) {
        return entries.get(String(key))?.value || "";
      },
    };
  }

  function setInert(element, inert) {
    if (!element) return;
    element.inert = Boolean(inert);
    if (inert) element.setAttribute("inert", "");
    else element.removeAttribute("inert");
    element.setAttribute("aria-hidden", inert ? "true" : "false");
  }

  function createDisclosureController(root, options) {
    const opts = options || {};
    const button = root.querySelector("[data-work-disclosure-toggle]");
    const body = root.querySelector("[data-work-disclosure-body]");
    if (!button || !body) return { destroy() {} };
    let state = opts.initiallyExpanded ? "expanded" : root.getAttribute("data-disclosure-state") || "collapsed";
    let frame = null;
    let observer = null;
    // Installed Codex's disclosure Motion context is explicitly `never` for
    // reduced motion. Entrance/Markdown motion is reduced elsewhere; this
    // measured height transition remains literal native behavior.
    const reducedMotion = opts.reducedMotion === true;

    const expandedForAria = () => state === "opening" || state === "expanded";
    const measure = () => Math.max(0, body.scrollHeight || body.getBoundingClientRect().height || 0);
    const paint = () => {
      root.setAttribute("data-disclosure-state", state);
      button.setAttribute("aria-expanded", String(expandedForAria()));
      body.setAttribute("aria-hidden", String(state === "collapsed" || state === "closing"));
      setInert(body, state === "collapsed" || state === "closing");
      if (state === "expanded") body.style.height = "auto";
      else if (state === "collapsed") body.style.height = "0px";
      opts.onStateChange?.(state);
    };
    const finish = () => {
      state = nextDisclosureState(state, "transitionend");
      paint();
    };
    const toggle = () => {
      const previous = state;
      state = nextDisclosureState(state, "toggle");
      if (frame != null) global.cancelAnimationFrame(frame);
      if (state === "opening") {
        setInert(body, false);
        body.style.height = previous === "closing" ? `${measure()}px` : "0px";
        frame = global.requestAnimationFrame(() => { body.style.height = `${measure()}px`; });
      } else {
        body.style.height = `${measure()}px`;
        setInert(body, true);
        frame = global.requestAnimationFrame(() => { body.style.height = "0px"; });
      }
      paint();
      if (reducedMotion) finish();
    };
    const transitionEnd = (event) => {
      if (event && event.target !== body) return;
      if (event?.propertyName && event.propertyName !== "height") return;
      if (state === "opening" || state === "closing") finish();
    };
    button.addEventListener("click", toggle);
    body.addEventListener("transitionend", transitionEnd);
    body.addEventListener("transitioncancel", transitionEnd);
    if (typeof global.ResizeObserver === "function") {
      observer = new global.ResizeObserver(() => {
        if (state === "opening") body.style.height = `${measure()}px`;
      });
      observer.observe(body.firstElementChild || body);
    }
    paint();
    return {
      get state() { return state; },
      toggle,
      destroy() {
        if (frame != null) global.cancelAnimationFrame(frame);
        observer?.disconnect();
        button.removeEventListener("click", toggle);
        body.removeEventListener("transitionend", transitionEnd);
        body.removeEventListener("transitioncancel", transitionEnd);
      },
    };
  }

  function distanceFromBottom(scroller) {
    if (!scroller) return 0;
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop);
  }

  function captureAnchor(scroller) {
    if (!scroller) return null;
    const viewportTop = scroller.getBoundingClientRect().top;
    const nodes = Array.from(scroller.querySelectorAll("[data-work-anchor]"));
    const anchor = nodes.find((node) => node.getBoundingClientRect().bottom > viewportTop) || null;
    return {
      following: distanceFromBottom(scroller) <= FOLLOW_THRESHOLD_PX,
      top: scroller.scrollTop,
      id: anchor?.getAttribute("data-work-anchor") || null,
      offset: anchor ? anchor.getBoundingClientRect().top - viewportTop : 0,
    };
  }

  function restoreAnchor(scroller, snapshot) {
    if (!scroller || !snapshot) return;
    if (snapshot.following) {
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      return;
    }
    scroller.scrollTop = Number(snapshot.top) || 0;
    if (!snapshot.id) return;
    const nodes = Array.from(scroller.querySelectorAll("[data-work-anchor]"));
    const anchor = nodes.find((node) => node.getAttribute("data-work-anchor") === snapshot.id);
    if (!anchor) return;
    const viewportTop = scroller.getBoundingClientRect().top;
    scroller.scrollTop += anchor.getBoundingClientRect().top - viewportTop - snapshot.offset;
  }

  function createScrollController(scroller, footer, options) {
    const opts = options || {};
    let following = distanceFromBottom(scroller) <= FOLLOW_THRESHOLD_PX;
    let userDirection = null;
    let userDirectionAt = 0;
    let footerHeight = 0;
    let footerObserver = null;
    let contentObserver = null;
    let followFrame = 0;
    let previousScrollTop = Number(scroller?.scrollTop) || 0;
    let pointerScrolling = false;
    let touchStartY = null;
    let smoothFrame = 0;
    let programmaticLayouts = 0;
    const now = opts.now || (() => global.performance.now());

    const update = (event) => {
      const distance = distanceFromBottom(scroller);
      const currentTop = Number(scroller.scrollTop) || 0;
      const movedUp = currentTop < previousScrollTop - 0.5;
      if (!programmaticLayouts && distance > FOLLOW_THRESHOLD_PX && (pointerScrolling || event?.isTrusted && movedUp)) {
        userDirection = "away";
        userDirectionAt = now();
      }
      previousScrollTop = currentTop;
      if (userDirection && now() - userDirectionAt > USER_SCROLL_STABLE_MS) userDirection = null;
      if (distance <= FOLLOW_THRESHOLD_PX) following = true;
      else if (userDirection === "away") following = false;
      opts.onFollowChange?.(following, distance);
    };
    const beginProgrammaticLayout = (callback) => {
      programmaticLayouts += 1;
      try { callback(); }
      finally {
        global.requestAnimationFrame(() => {
          programmaticLayouts = Math.max(0, programmaticLayouts - 1);
          previousScrollTop = Number(scroller.scrollTop) || 0;
        });
      }
    };
    const markDirection = (direction) => {
      userDirection = direction;
      userDirectionAt = now();
      if (direction === "away") following = false;
    };
    const markAway = (event) => {
      if (event.type === "wheel") {
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
        markDirection(event.deltaY * unit < 0 ? "away" : "toward");
      } else if (event.type === "keydown") {
        if (["ArrowUp", "PageUp", "Home"].includes(event.key) || event.key === " " && event.shiftKey) markDirection("away");
        else if (["ArrowDown", "PageDown", "End"].includes(event.key) || event.key === " " && !event.shiftKey) markDirection("toward");
      }
    };
    const pointerStart = () => { pointerScrolling = true; };
    const pointerEnd = () => { pointerScrolling = false; touchStartY = null; };
    const touchStart = (event) => { pointerScrolling = true; touchStartY = event.touches?.[0]?.clientY ?? null; };
    const touchMove = (event) => {
      const y = event.touches?.[0]?.clientY;
      if (!Number.isFinite(y) || !Number.isFinite(touchStartY)) return;
      const delta = y - touchStartY;
      if (Math.abs(delta) < 8) return;
      markDirection(delta > 0 ? "away" : "toward");
      touchStartY = y;
    };
    const resizeFooter = () => {
      const next = Math.ceil(footer?.getBoundingClientRect().height || 0);
      if (next === footerHeight) return;
      const snapshot = captureAnchor(scroller);
      footerHeight = next;
      scroller.style.setProperty("--work-footer-height", `${footerHeight}px`);
      global.requestAnimationFrame(() => beginProgrammaticLayout(() => restoreAnchor(scroller, snapshot)));
    };
    const followGrowingContent = () => {
      if (!following || userDirection === "away") return;
      global.cancelAnimationFrame?.(followFrame);
      followFrame = global.requestAnimationFrame(() => beginProgrammaticLayout(() => {
        scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      }));
    };
    const smoothToBottom = () => {
      global.cancelAnimationFrame?.(smoothFrame);
      const start = Number(scroller.scrollTop) || 0;
      const target = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      if (target - start <= FOLLOW_THRESHOLD_PX) { beginProgrammaticLayout(() => { scroller.scrollTop = target; }); return; }
      const startedAt = now();
      const tick = () => {
        const progress = Math.min(1, Math.max(0, (now() - startedAt) / 260));
        const eased = 1 - Math.pow(1 - progress, 3);
        beginProgrammaticLayout(() => { scroller.scrollTop = start + (target - start) * eased; });
        if (progress < 1) smoothFrame = global.requestAnimationFrame(tick);
      };
      smoothFrame = global.requestAnimationFrame(tick);
    };
    scroller.addEventListener("scroll", update, { passive: true });
    scroller.addEventListener("wheel", markAway, { passive: true });
    scroller.addEventListener("keydown", markAway, { passive: true });
    scroller.addEventListener("pointerdown", pointerStart, { passive:true });
    scroller.addEventListener("pointerup", pointerEnd, { passive:true });
    scroller.addEventListener("pointercancel", pointerEnd, { passive:true });
    scroller.addEventListener("touchstart", touchStart, { passive:true });
    scroller.addEventListener("touchmove", touchMove, { passive:true });
    scroller.addEventListener("touchend", pointerEnd, { passive:true });
    if (footer && typeof global.ResizeObserver === "function") {
      footerObserver = new global.ResizeObserver(resizeFooter);
      footerObserver.observe(footer);
    }
    if (typeof global.ResizeObserver === "function") {
      contentObserver = new global.ResizeObserver(followGrowingContent);
      contentObserver.observe(scroller.querySelector?.(".work-scroll-inner") || scroller.firstElementChild || scroller);
    }
    resizeFooter();
    return {
      isFollowing() { return following; },
      capture() { return captureAnchor(scroller); },
      restore(snapshot) { beginProgrammaticLayout(() => restoreAnchor(scroller, snapshot)); update(); },
      contentChanged(snapshot) {
        beginProgrammaticLayout(() => restoreAnchor(scroller, snapshot || { following, top: scroller.scrollTop }));
        update();
        followGrowingContent();
      },
      scrollToBottom(behavior) {
        following = true;
        markDirection("toward");
        if ((behavior || "smooth") === "smooth") smoothToBottom();
        else beginProgrammaticLayout(() => { scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight); });
      },
      destroy() {
        footerObserver?.disconnect();
        contentObserver?.disconnect();
        global.cancelAnimationFrame?.(followFrame);
        global.cancelAnimationFrame?.(smoothFrame);
        scroller.removeEventListener("scroll", update);
        scroller.removeEventListener("wheel", markAway);
        scroller.removeEventListener("keydown", markAway);
        scroller.removeEventListener("pointerdown", pointerStart);
        scroller.removeEventListener("pointerup", pointerEnd);
        scroller.removeEventListener("pointercancel", pointerEnd);
        scroller.removeEventListener("touchstart", touchStart);
        scroller.removeEventListener("touchmove", touchMove);
        scroller.removeEventListener("touchend", pointerEnd);
      },
    };
  }

  global.RelayWorkUI = Object.freeze({
    FOLLOW_THRESHOLD_PX,
    USER_SCROLL_STABLE_MS,
    DISCLOSURE_TRANSITION_MS,
    NATIVE_TYPOGRAPHY,
    nextDisclosureState,
    normalizeConversationView,
    partitionTurn,
    createSummaryStabilizer,
    createDisclosureController,
    distanceFromBottom,
    captureAnchor,
    restoreAnchor,
    createScrollController,
  });
})(globalThis);
