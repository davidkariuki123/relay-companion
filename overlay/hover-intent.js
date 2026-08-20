(function installHoverIntentModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  root.RelayHoverIntent = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function hoverIntentFactory() {
  "use strict";

  const DEFAULTS = Object.freeze({
    scrollQuietMs: 220,
    postScrollMovePx: 4,
    seamHeightPx: 38,
    seamDwellMs: 180,
    bodyDwellMs: 420,
    maxDwellDriftPx: 7,
    fastPointerPxMs: 0.45,
    fastSettleMs: 80,
    stablePointerPxMs: 0.12,
    stableForMs: 90,
    exitGraceMs: 240,
  });

  function distance(a, b) {
    if (!a || !b) return Infinity;
    return Math.hypot(Number(a.x) - Number(b.x), Number(a.y) - Number(b.y));
  }

  function createHoverIntentMachine(options = {}) {
    const config = { ...DEFAULTS, ...(options.config || {}) };
    const clock = options.clock || {
      now: () => performance.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (timer) => clearTimeout(timer),
    };
    const onOpen = typeof options.onOpen === "function" ? options.onOpen : () => {};
    const onClose = typeof options.onClose === "function" ? options.onClose : () => {};
    let pointer = null;
    let lastMoveAt = null;
    let lastSpeed = 0;
    let suppressedUntil = -Infinity;
    let needsPostScrollMove = false;
    let postScrollOrigin = null;
    let candidate = null;
    let armTimer = null;
    let quietTimer = null;
    let closeTimer = null;
    let openId = null;

    function clearTimer(name) {
      const timer = name === "arm" ? armTimer : name === "quiet" ? quietTimer : closeTimer;
      if (timer != null) clock.clearTimeout(timer);
      if (name === "arm") armTimer = null;
      else if (name === "quiet") quietTimer = null;
      else closeTimer = null;
    }

    function cancelCandidate() {
      clearTimer("arm");
      candidate = null;
    }

    function closeOpen(reason) {
      clearTimer("close");
      if (!openId) return;
      const id = openId;
      openId = null;
      onClose(id, reason);
    }

    function scheduleArm(input, speed) {
      cancelCandidate();
      const delay = input.zone === "seam" ? config.seamDwellMs : config.bodyDwellMs;
      const settle = speed > config.fastPointerPxMs ? config.fastSettleMs : 0;
      candidate = {
        id: String(input.id),
        zone: input.zone === "seam" ? "seam" : "body",
        anchor: { x: input.x, y: input.y },
        lastPoint: { x: input.x, y: input.y },
      };
      const expected = candidate;
      armTimer = clock.setTimeout(() => {
        armTimer = null;
        if (candidate !== expected || clock.now() < suppressedUntil) return;
        const stableFor = Math.max(0, clock.now() - (lastMoveAt == null ? clock.now() : lastMoveAt));
        if (distance(expected.anchor, expected.lastPoint) > config.maxDwellDriftPx) return;
        if (lastSpeed > config.stablePointerPxMs && stableFor < config.stableForMs) return;
        candidate = null;
        clearTimer("close");
        if (openId === expected.id) return;
        if (openId) closeOpen("replaced");
        openId = expected.id;
        onOpen(openId, expected.zone);
      }, delay + settle);
    }

    function pointerMove(input = {}) {
      const now = clock.now();
      const next = { x: Number(input.x) || 0, y: Number(input.y) || 0 };
      const elapsed = lastMoveAt == null ? Infinity : Math.max(1, now - lastMoveAt);
      const moved = pointer ? distance(pointer, next) : 0;
      const speed = Number.isFinite(elapsed) ? moved / elapsed : 0;
      pointer = next;
      lastMoveAt = now;
      lastSpeed = speed;

      if (now < suppressedUntil) {
        postScrollOrigin = next;
        cancelCandidate();
        return false;
      }
      if (needsPostScrollMove) {
        if (!postScrollOrigin) {
          postScrollOrigin = next;
          return false;
        }
        if (distance(postScrollOrigin, next) < config.postScrollMovePx) return false;
        needsPostScrollMove = false;
      }

      const id = input.id == null ? "" : String(input.id);
      if (id && openId === id) {
        clearTimer("close");
        cancelCandidate();
        return true;
      }
      if (!id || input.blocked) {
        cancelCandidate();
        if (openId) scheduleClose("pointer-exit");
        return false;
      }
      clearTimer("close");

      const zone = input.zone === "seam" ? "seam" : "body";
      if (!candidate || candidate.id !== id || candidate.zone !== zone) {
        scheduleArm({ ...input, id, zone }, speed);
        return false;
      }
      candidate.lastPoint = next;
      if (distance(candidate.anchor, next) > config.maxDwellDriftPx || speed > config.fastPointerPxMs) {
        scheduleArm({ ...input, id, zone }, speed);
      }
      return false;
    }

    function scheduleClose(reason = "pointer-exit") {
      cancelCandidate();
      if (!openId || closeTimer != null) return;
      closeTimer = clock.setTimeout(() => {
        closeTimer = null;
        closeOpen(reason);
      }, config.exitGraceMs);
    }

    function pointerLeave() {
      scheduleClose("pointer-exit");
    }

    function scroll(input = {}) {
      const now = clock.now();
      if (Number.isFinite(input.x) && Number.isFinite(input.y)) pointer = { x: input.x, y: input.y };
      postScrollOrigin = pointer ? { ...pointer } : null;
      needsPostScrollMove = true;
      suppressedUntil = now + config.scrollQuietMs;
      cancelCandidate();
      clearTimer("quiet");
      closeOpen("scroll");
      quietTimer = clock.setTimeout(() => { quietTimer = null; }, config.scrollQuietMs);
    }

    function reset(reason = "reset") {
      cancelCandidate();
      clearTimer("quiet");
      closeOpen(reason);
      needsPostScrollMove = false;
      suppressedUntil = -Infinity;
    }

    return {
      pointerMove,
      pointerLeave,
      scroll,
      reset,
      getState: () => ({
        openId,
        candidateId: candidate && candidate.id,
        candidateZone: candidate && candidate.zone,
        suppressed: clock.now() < suppressedUntil,
        needsPostScrollMove,
      }),
      config,
    };
  }

  function installRelayHoverIntent(options = {}) {
    const doc = options.document || document;
    const win = options.window || doc.defaultView || window;
    const rowSelector = ".th-msg.has-host-actions";
    const persistentSelector = ".th-host-actions.persistent";
    const coarseQuery = win.matchMedia("(hover: none), (pointer: coarse)");
    let coarse = coarseQuery.matches;
    let focusId = null;
    let touchId = null;
    let suppressFocusId = null;

    function rowForId(id) {
      return [...doc.querySelectorAll(rowSelector)].find((row) => String(row.dataset.msg || "") === String(id || "")) || null;
    }

    function isPersistent(row) {
      return Boolean(row && row.querySelector(persistentSelector));
    }

    function syncRow(row) {
      const actions = row && row.querySelector(".th-host-actions");
      if (!actions) return;
      const open = isPersistent(row)
        || row.classList.contains("host-intent-open")
        || row.classList.contains("host-focus-open")
        || row.classList.contains("host-touch-open");
      row.setAttribute("aria-expanded", open ? "true" : "false");
      actions.setAttribute("aria-hidden", open ? "false" : "true");
      actions.inert = !open;
      const disclosure = row.querySelector("[data-host-disclosure]");
      if (disclosure) disclosure.setAttribute("aria-expanded", open ? "true" : "false");
    }

    function closeRowsExcept(id) {
      for (const row of doc.querySelectorAll(`${rowSelector}.host-intent-open, ${rowSelector}.host-focus-open, ${rowSelector}.host-touch-open`)) {
        if (String(row.dataset.msg || "") === String(id || "")) continue;
        row.classList.remove("host-intent-open", "host-focus-open", "host-touch-open");
        syncRow(row);
      }
      if (focusId && focusId !== id) focusId = null;
      if (touchId && touchId !== id) touchId = null;
    }

    const machine = createHoverIntentMachine({
      config: options.config,
      clock: options.clock,
      onOpen(id) {
        const row = rowForId(id);
        if (!row || isPersistent(row)) return;
        closeRowsExcept(id);
        row.classList.add("host-intent-open");
        syncRow(row);
      },
      onClose(id) {
        const row = rowForId(id);
        if (!row) return;
        row.classList.remove("host-intent-open");
        syncRow(row);
      },
    });

    function blockedTarget(target) {
      return Boolean(target && target.closest && target.closest(
        "button, a, input, textarea, select, [data-stop=\"1\"], [data-rx-colo]",
      ));
    }

    function pointerMove(event) {
      if (coarse || event.isPrimary === false || (event.pointerType && event.pointerType !== "mouse" && event.pointerType !== "pen")) return;
      if (focusId || touchId) return;
      const target = doc.elementFromPoint(event.clientX, event.clientY);
      const row = target && target.closest ? target.closest(rowSelector) : null;
      if (!row || isPersistent(row)) {
        machine.pointerMove({ x:event.clientX, y:event.clientY });
        return;
      }
      const rect = row.getBoundingClientRect();
      machine.pointerMove({
        id: row.dataset.msg,
        zone: event.clientY >= rect.bottom - machine.config.seamHeightPx ? "seam" : "body",
        x: event.clientX,
        y: event.clientY,
        blocked: blockedTarget(target),
      });
    }

    function suppressForScroll() {
      machine.scroll();
    }

    function pinFocus(row) {
      const id = String(row.dataset.msg || "");
      if (!id || isPersistent(row)) return;
      if (suppressFocusId === id) { suppressFocusId = null; return; }
      closeRowsExcept(id);
      machine.reset("keyboard");
      focusId = id;
      row.classList.add("host-focus-open");
      syncRow(row);
    }

    function onFocusIn(event) {
      const row = event.target && event.target.closest ? event.target.closest(rowSelector) : null;
      if (!row || isPersistent(row)) return;
      if (coarse && event.target.closest("[data-host-disclosure]")) return;
      pinFocus(row);
    }

    function onFocusOut(event) {
      const row = event.target && event.target.closest ? event.target.closest(rowSelector) : null;
      if (!row || !row.classList.contains("host-focus-open")) return;
      win.setTimeout(() => {
        if (row.contains(doc.activeElement)) return;
        row.classList.remove("host-focus-open");
        if (focusId === row.dataset.msg) focusId = null;
        syncRow(row);
      }, 0);
    }

    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      const row = event.target && event.target.closest ? event.target.closest(rowSelector) : null;
      if (!row || isPersistent(row)) return;
      if (!row.classList.contains("host-focus-open") && !row.classList.contains("host-touch-open")) return;
      event.preventDefault();
      event.stopPropagation();
      const id = String(row.dataset.msg || "");
      suppressFocusId = id;
      row.classList.remove("host-focus-open", "host-touch-open");
      focusId = null;
      touchId = null;
      syncRow(row);
      row.focus({ preventScroll:true });
    }

    function onDisclosureClick(event) {
      const disclosure = event.target && event.target.closest ? event.target.closest("[data-host-disclosure]") : null;
      if (!disclosure) return;
      const row = disclosure.closest(rowSelector);
      if (!row || isPersistent(row)) return;
      event.preventDefault();
      event.stopPropagation();
      const id = String(row.dataset.msg || "");
      const opening = !row.classList.contains("host-touch-open");
      closeRowsExcept(opening ? id : null);
      machine.reset("touch-disclosure");
      row.classList.toggle("host-touch-open", opening);
      touchId = opening ? id : null;
      syncRow(row);
    }

    function refresh() {
      const ids = new Set();
      for (const row of doc.querySelectorAll(rowSelector)) {
        const id = String(row.dataset.msg || "");
        ids.add(id);
        if (isPersistent(row)) row.classList.remove("host-intent-open", "host-focus-open", "host-touch-open");
        else {
          row.classList.toggle("host-focus-open", focusId === id);
          row.classList.toggle("host-touch-open", touchId === id);
          row.classList.toggle("host-intent-open", machine.getState().openId === id);
        }
        syncRow(row);
      }
      if (machine.getState().openId && !ids.has(machine.getState().openId)) machine.reset("row-removed");
      if (focusId && !ids.has(focusId)) focusId = null;
      if (touchId && !ids.has(touchId)) touchId = null;
    }

    function onCoarseChange(event) {
      coarse = event.matches;
      machine.reset("pointer-capability-change");
      refresh();
    }

    doc.addEventListener("pointermove", pointerMove, true);
    doc.addEventListener("pointerleave", () => machine.pointerLeave(), true);
    doc.addEventListener("wheel", suppressForScroll, { capture:true, passive:true });
    doc.addEventListener("scroll", suppressForScroll, true);
    doc.addEventListener("focusin", onFocusIn, true);
    doc.addEventListener("focusout", onFocusOut, true);
    doc.addEventListener("keydown", onKeyDown, true);
    doc.addEventListener("click", onDisclosureClick, true);
    if (coarseQuery.addEventListener) coarseQuery.addEventListener("change", onCoarseChange);
    else if (coarseQuery.addListener) coarseQuery.addListener(onCoarseChange);

    refresh();
    return { machine, refresh, isCoarse:() => coarse };
  }

  return { DEFAULTS, createHoverIntentMachine, installRelayHoverIntent };
});
