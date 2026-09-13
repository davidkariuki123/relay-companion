(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RelayAnyoneTip = api;
})(globalThis, function () {
  const EXAMPLES = Object.freeze([
    "Create a Relay asking Alex to compare these venues and recommend one. Include all the context his agent needs to do it.",
    "Create a Relay asking Maya what she thinks of this launch plan. Include the plan, our goals and the trade-offs we discussed.",
    "Create a Relay handing this project to Sam. Include our progress, key decisions and files, and what his agent should do next.",
    "Create a Relay asking Shane to fix images not opening in the app. Include what we tried and everything his agent needs to reproduce it.",
    "Create a Relay asking the team to try the new app before we release it. Include what changed, how to try it and what to check.",
  ]);
  const INTERVAL_MS = 10000;

  function create(root) {
    const doc = root.ownerDocument, win = doc.defaultView;
    root.classList.add("relay-anyone-tip");
    root.innerHTML = `
      <button class="rat-summary" type="button" aria-expanded="false" aria-label="Expand tip: Relay anyone" hidden>
        <span class="rat-title">Relay anyone even if they aren’t on Relay</span><span class="rat-see">See how <span aria-hidden="true">›</span></span>
      </button>
      <section class="rat-card" aria-label="Relay anyone">
        <div class="rat-head"><span class="rat-title">Relay anyone even if they aren’t on Relay</span><button class="rat-minimise" type="button" aria-label="Minimise tip" aria-expanded="true">−</button></div>
        <div class="rat-label">Tell Claude Code or Codex:</div>
        <div class="rat-carousel" role="region" aria-roledescription="carousel" aria-label="Example Relay prompts" aria-live="off">
          <div class="rat-viewport"><div class="rat-track"></div></div>
          <div class="rat-controls"><div class="rat-dots" role="group" aria-label="Choose an example"></div><button class="rat-rotate" type="button" aria-label="Pause example rotation">Pause</button></div>
        </div>
        <div class="rat-footer"><div class="rat-result">You’ll get a link to share. They can read and reply from Claude or Codex, without a Relay account.</div><button class="sv-choose rat-copy" type="button">Copy example</button></div>
      </section>
      <span class="rat-status" role="status"></span>`;
    const find = (selector) => root.querySelector(selector);
    const card = find(".rat-card"), summary = find(".rat-summary"), minimise = find(".rat-minimise");
    const viewport = find(".rat-viewport"), track = find(".rat-track"), dots = find(".rat-dots");
    const rotate = find(".rat-rotate"), copy = find(".rat-copy"), status = find(".rat-status");
    let index = 0, expanded = true, paused = false, visible = false, active = false;
    let inViewport = false, timer = null, animations = [], generation = 0;
    const slides = EXAMPLES.map((text, i) => {
      const slide = doc.createElement("div");
      slide.className = "rat-slide";
      slide.setAttribute("role", "group");
      slide.setAttribute("aria-roledescription", "slide");
      slide.setAttribute("aria-label", `${i + 1} of ${EXAMPLES.length}`);
      slide.textContent = `“${text}”`;
      track.append(slide);
      const dot = doc.createElement("button");
      dot.type = "button";
      dot.className = "rat-dot";
      dot.setAttribute("aria-label", `Example ${i + 1} of ${EXAMPLES.length}`);
      dot.append(doc.createElement("span"));
      dot.addEventListener("click", () => select(i, i >= index ? 1 : -1, true));
      dots.append(dot);
      return slide;
    });
    function stopMotion() {
      animations.forEach((animation) => animation.cancel());
      animations = [];
      slides.forEach((slide) => slide.classList.remove("leaving"));
    }
    function schedule() {
      win.clearTimeout(timer); timer = null;
      if (visible && active && expanded && !paused && inViewport && !doc.hidden) {
        timer = win.setTimeout(() => select((index + 1) % EXAMPLES.length, 1), INTERVAL_MS);
      } else if (!visible || !active || !expanded || !inViewport || doc.hidden) stopMotion();
    }
    function controls() {
      card.hidden = !expanded; summary.hidden = expanded;
      rotate.textContent = paused ? "Resume" : "Pause";
      rotate.setAttribute("aria-label", `${paused ? "Resume" : "Pause"} example rotation`);
      [...dots.children].forEach((dot, i) => dot.setAttribute("aria-current", String(i === index)));
      schedule();
    }
    function select(next, direction = 1, manual = false) {
      stopMotion(); generation++;
      const previous = index; index = next;
      slides.forEach((slide, i) => {
        slide.classList.toggle("active", i === index);
        slide.setAttribute("aria-hidden", String(i !== index));
      });
      if (previous !== index && visible && active && !win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        const outgoing = slides[previous], incoming = slides[index];
        outgoing.classList.add("leaving");
        const options = { duration:360, easing:"cubic-bezier(.22,1,.28,1)", fill:"both" };
        const out = outgoing.animate([{transform:"translateX(0)"},{transform:`translateX(${-100 * direction}%)`}], options);
        const enter = incoming.animate([{transform:`translateX(${100 * direction}%)`},{transform:"translateX(0)"}], options);
        animations = [out, enter];
        out.finished.then(() => { outgoing.classList.remove("leaving"); out.cancel(); enter.cancel(); }).catch(() => {});
      }
      copy.textContent = "Copy example";
      status.textContent = manual ? `Example ${index + 1} of ${EXAMPLES.length}` : "";
      controls();
    }
    summary.addEventListener("click", () => { expanded = true; controls(); minimise.focus({preventScroll:true}); });
    minimise.addEventListener("click", () => { expanded = false; controls(); summary.focus({preventScroll:true}); });
    rotate.addEventListener("click", () => { paused = !paused; controls(); });
    find(".rat-carousel").addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      select((index + direction + EXAMPLES.length) % EXAMPLES.length, direction, true);
    });
    let pointer = null;
    viewport.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      pointer = {id:event.pointerId, x:event.clientX, y:event.clientY};
      viewport.setPointerCapture(event.pointerId);
    });
    viewport.addEventListener("pointercancel", () => { pointer = null; });
    viewport.addEventListener("pointerup", (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y; pointer = null;
      if (Math.abs(dx) <= 35 || Math.abs(dx) <= Math.abs(dy) * 1.4) return;
      const direction = dx < 0 ? 1 : -1;
      select((index + direction + EXAMPLES.length) % EXAMPLES.length, direction, true);
    });
    copy.addEventListener("click", async () => {
      const text = EXAMPLES[index], ticket = ++generation;
      paused = true; controls();
      try {
        await win.navigator.clipboard.writeText(text);
        if (ticket !== generation) return;
        copy.textContent = "Copied"; status.textContent = "Example copied";
      } catch {
        if (ticket !== generation) return;
        copy.textContent = "Try copying again"; status.textContent = "Could not copy the example. Try again.";
      }
    });
    const observer = new win.IntersectionObserver(([entry]) => {
      const next = entry.isIntersecting && entry.intersectionRatio >= 0.5;
      if (next !== inViewport) { inViewport = next; schedule(); }
    }, {threshold:0.5});
    observer.observe(viewport);
    doc.addEventListener("visibilitychange", schedule);
    select(0);
    root.hidden = true;
    return {
      setVisible(next) {
        next = Boolean(next);
        if (visible === next) return;
        visible = next; root.hidden = !visible; schedule();
      },
      setActive(next) {
        next = Boolean(next);
        if (active === next) return;
        active = next; schedule();
      },
      reset() { expanded = true; paused = false; select(0); },
      destroy() { visible = false; schedule(); observer.disconnect(); doc.removeEventListener("visibilitychange", schedule); },
    };
  }
  return { create, EXAMPLES, INTERVAL_MS };
});
