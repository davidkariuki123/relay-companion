(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RelayAnyoneTip = api;
})(globalThis, function () {
  // One use of Relay per slide. Prompts are what a person would type: never
  // "include everything their agent needs" or "a summary" — the Relay spec
  // already gives the person the gist and their agent every detail.
  const TITLE = "Five ways to use Relay";
  const EXAMPLES = Object.freeze([
    {
      way: "Send to someone not on Relay",
      prompt: "Create a Relay asking Alice what she thinks of this launch plan.",
      result: "You’ll get a link to share. They can read and reply from Claude or Codex, without a Relay account.",
    },
    {
      way: "Pick up where you left off",
      prompt: "Relay this session to me so I can carry on in Codex later.",
      result: "Your next session starts with everything this one knows, on any computer and in any AI.",
    },
    {
      way: "Carry on work someone sent you",
      prompt: "Open the Relay from Alex and carry on the work here.",
      result: "Their agent’s notes become your agent’s starting point, so nobody has to re-explain.",
    },
    {
      way: "Check what needs you",
      prompt: "Check my Relay inbox and tell me what needs me today.",
      result: "Your agent reads your inbox and gives you a short list instead of a pile.",
    },
    {
      way: "Pull your work together",
      prompt: "Relay Sam everything I did on the pricing page this week in Claude Code and Codex.",
      result: "Your agent gathers the work from your other sessions. Sam reads the gist and their agent gets every detail.",
    },
  ].map(Object.freeze));
  const INTERVAL_MS = 10000;

  // `expanded: true` opens the card straight away and keeps it open across
  // reset(): the application installer's setup window shows the five ways
  // while Relay downloads, with nothing to minimise them into.
  function create(root, { expanded: startExpanded = false } = {}) {
    const doc = root.ownerDocument, win = doc.defaultView;
    root.classList.add("relay-anyone-tip");
    root.innerHTML = `
      <button class="rat-summary" type="button" aria-expanded="false" aria-label="Expand tip: ${TITLE}">
        <span class="rat-title">${TITLE}</span><span class="rat-see">See how <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg></span>
      </button>
      <section class="rat-card" aria-label="${TITLE}" hidden>
        <div class="rat-head"><span class="rat-title">${TITLE}</span><button class="rat-minimise" type="button" aria-label="Minimise tip" aria-expanded="true">−</button></div>
        <div class="rat-label">Tell Claude Code or Codex:</div>
        <div class="rat-carousel" role="region" aria-roledescription="carousel" aria-label="Example Relay prompts" aria-live="off">
          <div class="rat-viewport"><div class="rat-track"></div></div>
          <div class="rat-controls"><div class="rat-dots" role="group" aria-label="Choose an example"></div></div>
        </div>
        <div class="rat-footer"><div class="rat-result"></div><button class="sv-choose rat-copy" type="button">Copy example</button></div>
      </section>
      <span class="rat-status" role="status"></span>`;
    const find = (selector) => root.querySelector(selector);
    const card = find(".rat-card"), summary = find(".rat-summary"), minimise = find(".rat-minimise");
    const viewport = find(".rat-viewport"), track = find(".rat-track"), dots = find(".rat-dots");
    const copy = find(".rat-copy"), status = find(".rat-status"), result = find(".rat-result");
    // Collapsed on every open; "See how" expands it until Relay next opens.
    let index = 0, expanded = startExpanded, paused = false, visible = false, active = false;
    function setExpanded(next) {
      expanded = next;
      controls();
    }
    let inViewport = false, timer = null, animations = [], generation = 0;
    const slides = EXAMPLES.map((example, i) => {
      const slide = doc.createElement("div");
      slide.className = "rat-slide";
      slide.setAttribute("role", "group");
      slide.setAttribute("aria-roledescription", "slide");
      slide.setAttribute("aria-label", `${i + 1} of ${EXAMPLES.length}: ${example.way}`);
      const way = doc.createElement("div");
      way.className = "rat-way";
      way.textContent = example.way;
      const prompt = doc.createElement("div");
      prompt.className = "rat-prompt";
      prompt.textContent = `“${example.prompt}”`;
      slide.append(way, prompt);
      track.append(slide);
      // Every result is laid out in the same cell so the footer keeps the
      // height of the longest one and does not jump as slides change.
      const outcome = doc.createElement("div");
      outcome.className = "rat-outcome";
      outcome.textContent = example.result;
      result.append(outcome);
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
      [...result.children].forEach((outcome, i) => {
        outcome.classList.toggle("active", i === index);
        outcome.setAttribute("aria-hidden", String(i !== index));
      });
      copy.textContent = "Copy example";
      status.textContent = manual ? `Example ${index + 1} of ${EXAMPLES.length}` : "";
      controls();
    }
    summary.addEventListener("click", () => { setExpanded(true); minimise.focus({preventScroll:true}); });
    minimise.addEventListener("click", () => { setExpanded(false); summary.focus({preventScroll:true}); });
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
      const text = EXAMPLES[index].prompt, ticket = ++generation;
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
      // Every open starts from the collapsed tip and the first example.
      reset() { paused = false; expanded = startExpanded; select(0); },
      destroy() { visible = false; schedule(); observer.disconnect(); doc.removeEventListener("visibilitychange", schedule); },
    };
  }
  return { create, TITLE, EXAMPLES, INTERVAL_MS };
});
