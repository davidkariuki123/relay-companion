(function installReaderStatusMotion(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RelayReaderStatusMotion = api;
})(typeof globalThis !== "undefined" ? globalThis : window, function readerStatusMotionFactory() {
  "use strict";

  // The approved quiet spring. Retargeting preserves velocity, including when
  // the reader changes direction before the previous movement has settled.
  function createSpring() {
    let value = 1, velocity = 0, target = 1;
    return {
      get value() { return value; },
      get target() { return target; },
      get settled() { return value === target && velocity === 0; },
      aim(next) { target = next; },
      snap(next = target) { value = target = next; velocity = 0; },
      advance(seconds) {
        const duration = Math.max(0, Math.min(.05, seconds));
        const steps = Math.max(1, Math.ceil(duration * 240));
        const dt = duration / steps;
        for (let i = 0; i < steps; i += 1) {
          velocity += (440 * (target - value) - 42 * velocity) * dt;
          value += velocity * dt;
        }
        if (Math.abs(value - target) < .00005 && Math.abs(velocity) < .0005) this.snap();
        return value;
      },
    };
  }

  function createController({ scroller, document, window }) {
    const spring = createSpring();
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let key = null, slot = null, panel = null, spacer = null;
    let fullHeight = 0, active = false, scrollable = false;
    let frame = null, lastTime = null, lastTop = 0, direction = 0, distance = 0;
    const originalAnchor = scroller.style.overflowAnchor;

    function stop() {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = lastTime = null;
    }
    function baseline() {
      lastTop = Math.max(0, Math.min(scroller.scrollTop, scroller.scrollHeight - scroller.clientHeight));
      direction = distance = 0;
    }
    function pinned() {
      return panel && (panel.contains(document.activeElement) || panel.querySelector(".tk-ask"));
    }
    function paint() {
      if (!panel) return;
      const amount = Math.max(0, Math.min(1, spring.value));
      slot.style.height = `${fullHeight * amount}px`;
      // Keep scrollHeight invariant: reclaim viewport space, never the scroll
      // range. Otherwise a near-bottom scroll clamps and looks like an upscroll.
      spacer.style.height = `${fullHeight * (1 - amount)}px`;
      panel.style.transform = `translate3d(0,${(1 - spring.value) * 22}px,0)`;
      panel.style.opacity = String(Math.pow(amount, .85));
      panel.inert = amount < .05;
      panel.style.pointerEvents = amount < .7 ? "none" : "";
    }
    function tick(time) {
      frame = null;
      if (!active || !panel?.isConnected) { lastTime = null; return; }
      if (lastTime !== null) spring.advance((time - lastTime) / 1000);
      lastTime = time;
      paint();
      if (!spring.settled) frame = window.requestAnimationFrame(tick);
      else lastTime = null;
    }
    function aim(next, immediate = false) {
      spring.aim(next);
      if (immediate || reduced.matches) {
        stop(); spring.snap(); paint();
      } else if (active && !spring.settled && frame === null) {
        frame = window.requestAnimationFrame(tick);
      }
    }
    function measure() {
      if (!panel?.isConnected) return;
      const style = window.getComputedStyle(panel);
      // Layout height, not the transformed rectangle: the reader's entrance
      // scales its ancestors, which must not shrink the remembered slot.
      const height = parseFloat(style.height);
      if (!height) return; // Destination can be built while still hidden.
      fullHeight = height + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
      paint();
      baseline();
    }
    const resize = new window.ResizeObserver(measure);
    function clear() {
      stop(); resize.disconnect();
      if (slot) slot.style.height = "";
      if (spacer) spacer.style.height = "";
      if (panel) {
        panel.style.transform = panel.style.opacity = panel.style.pointerEvents = "";
        panel.inert = false;
      }
      key = slot = panel = spacer = null;
      fullHeight = 0; scrollable = false; spring.snap(1);
      scroller.style.overflowAnchor = originalAnchor;
      baseline();
    }
    function onScroll() {
      if (!active || !scrollable || !panel?.isConnected) { baseline(); return; }
      const top = Math.max(0, Math.min(scroller.scrollTop, scroller.scrollHeight - scroller.clientHeight));
      const delta = top - lastTop;
      lastTop = top;
      if (top <= 1 || pinned()) { aim(1); direction = distance = 0; return; }
      if (Math.abs(delta) < .1) return;
      if (Math.sign(delta) !== direction) { direction = Math.sign(delta); distance = 0; }
      distance += Math.abs(delta);
      if (direction > 0 && distance >= 14) aim(0);
      if (direction < 0 && distance >= 8) aim(1);
    }
    function onFocus(event) {
      if (panel?.contains(event.target)) aim(1, true);
    }
    function onReducedMotion() {
      if (reduced.matches) aim(spring.target, true);
    }
    scroller.addEventListener("scroll", onScroll, { passive:true });
    scroller.addEventListener("focusin", onFocus);
    reduced.addEventListener("change", onReducedMotion);
    return {
      bind(next) {
        if (!next.panel || !next.slot || !next.spacer) { clear(); return; }
        if (key !== next.key) clear();
        key = next.key; slot = next.slot; panel = next.panel; spacer = next.spacer;
        scroller.style.overflowAnchor = "none";
        resize.disconnect(); resize.observe(panel);
        measure();
        if (pinned()) aim(1, true);
      },
      setScrollable(value) {
        scrollable = Boolean(value);
        measure();
        if (!scrollable) aim(1, true);
      },
      setActive(value) {
        const changed = active !== Boolean(value);
        active = Boolean(value);
        if (!active) stop();
        else if (changed) { measure(); aim(spring.target); }
      },
      clear,
      destroy() {
        clear();
        scroller.removeEventListener("scroll", onScroll);
        scroller.removeEventListener("focusin", onFocus);
        reduced.removeEventListener("change", onReducedMotion);
      },
    };
  }
  return { createSpring, createController };
});
