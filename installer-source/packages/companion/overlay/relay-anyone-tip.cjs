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
      id: "share_link",
      way: "Send to someone not on Relay",
      prompt: "Create a Relay asking Alice what she thinks of this launch plan.",
      result: "You’ll get a link to share. They can read and reply from Claude or Codex, without a Relay account.",
    },
    {
      id: "pick_up",
      way: "Pick up where you left off",
      prompt: "Relay this session to me so I can carry on in Codex later.",
      result: "Your next session starts with everything this one knows, on any computer and in any AI.",
    },
    {
      id: "carry_on",
      way: "Carry on work someone sent you",
      prompt: "Open the Relay from Alex and carry on the work here.",
      result: "Their agent’s notes become your agent’s starting point, so nobody has to re-explain.",
    },
    {
      id: "check_inbox",
      way: "Check what needs you",
      prompt: "Check my Relay inbox and tell me what needs me today.",
      result: "Your agent reads your inbox and gives you a short list instead of a pile.",
    },
    {
      id: "pull_together",
      way: "Pull your work together",
      prompt: "Relay Sam everything I did on the pricing page this week in Claude Code and Codex.",
      result: "Your agent gathers the work from your other sessions. Sam reads the gist and their agent gets every detail.",
    },
  ].map(Object.freeze));
  const INTERVAL_MS = 10000;
  const SHOWN = 5;

  // The smart card's ways, most useful first. It shows the first five the
  // person has not used yet, so a new account sees exactly the fixed five.
  // `done` reads the server's usage signals
  // (GET /v1/sent `usage`); a signal the server does not report counts as not
  // done, so the way stays. `when` offers a way only once it applies.
  //
  // `personal(p)` rewrites the example with the person's own people when
  // there are some: p.waiting / p.waitingFiles sent a Relay (with files) no
  // agent of theirs has opened, p.lastSender is whoever last sent them
  // anything, and p.next() hands out the people they relay with most
  // recently, in turn. "this" in a prompt is the work in front of the agent.
  //
  // A `once` way is read, not done: nothing shows whether someone has pulled
  // their work together, so it retires the next time the card refreshes after
  // it has been on screen in the open card, by rotation or by scrolling past
  // (Shane, 2026-10-07). The server remembers that for the account
  // (`readPullTogether`); the card also remembers it until it restarts.
  const [shareLink, pickUp, carryOn, checkInbox, pullTogether] = EXAMPLES;
  const WAYS = Object.freeze([
    { ...shareLink, done: (u) => u.createdShareLink },
    { ...pickUp, done: (u) => u.sentToSelf },
    {
      ...carryOn,
      done: (u) => u.openedReceivedRelay,
      personal: (p) => p.waiting && {
        prompt: `Open the Relay from ${p.waiting} and carry on the work here.`,
        result: `${p.waiting}’s notes become your agent’s starting point, so nobody has to re-explain.`,
      },
    },
    { ...checkInbox, done: (u) => u.agentListedInbox },
    { ...pullTogether, once: true, done: (u) => u.readPullTogether },
    {
      id: "send_files",
      way: "Send files",
      prompt: "Relay Priya the spreadsheet and the slides in this folder.",
      result: "The files travel with the Relay, so Priya’s agent can open them straight away.",
      done: (u) => u.sentWithAttachments,
      personal: (p) => { const who = p.next(); return who && {
        prompt: `Relay ${who} the files in this folder.`,
        result: `The files travel with the Relay, so ${who}’s agent can open them straight away.`,
      }; },
    },
    {
      id: "use_files",
      way: "Work with files someone sent you",
      prompt: "Open the files Maya sent me and check the numbers.",
      result: "Your agent fetches the files from the Relay and works on them here.",
      when: (u) => u.receivedWithAttachments,
      done: (u) => u.openedReceivedAttachments,
      personal: (p) => p.waitingFiles && {
        prompt: `Open the files ${p.waitingFiles} sent me and tell me what matters in them.`,
      },
    },
    {
      id: "ask_question",
      way: "Ask someone a question",
      prompt: "Ask Alex whether the API change can wait until Friday.",
      result: "Alex’s agent has the background to help answer, and the reply comes back to you.",
      done: (u) => u.askedQuestion || u.sentAsks?.answer,
      personal: (p) => { const who = p.next(); return who && {
        prompt: `Ask ${who} whether this can wait until next week.`,
        result: `${who}’s agent has the background to help answer, and the reply comes back to you.`,
      }; },
    },
    {
      id: "ask_feedback",
      way: "Ask for feedback",
      prompt: "Relay Alice this draft and ask what she would change.",
      result: "Alice reads the draft with the thinking behind it, and her answer comes back to you.",
      done: (u) => u.sentAsks?.feedback,
      personal: (p) => { const who = p.next(); return who && {
        prompt: `Relay ${who} this draft and ask what they would change.`,
        result: `${who} reads the draft with the thinking behind it, and the answer comes back to you.`,
      }; },
    },
    {
      id: "hand_over",
      way: "Hand over unfinished work",
      prompt: "Relay this to Sam so they can finish the migration tomorrow.",
      result: "Sam’s agent starts where yours stopped: what is done, what is left and why.",
      done: (u) => u.sentAsks?.handover,
      personal: (p) => { const who = p.next(); return who && {
        prompt: `Relay this to ${who} so they can finish it tomorrow.`,
        result: `${who}’s agent starts where yours stopped: what is done, what is left and why.`,
      }; },
    },
    {
      id: "relay_group",
      way: "Relay a group",
      prompt: "Relay the launch team where the pricing page stands.",
      result: "Everyone in the group gets the same Relay at once.",
      done: (u) => u.sentToGroup,
    },
    {
      id: "forward",
      way: "Pass a Relay on",
      prompt: "Forward Alex’s Relay to Sam and ask them to check the numbers.",
      result: "Sam gets Alex’s work as it was sent, with your note on top.",
      done: (u) => u.forwarded,
      personal: (p) => {
        if (!p.lastSender) return null;
        const who = p.next(p.lastSender);
        return who && {
          prompt: `Forward ${p.lastSender}’s last Relay to ${who} and ask them to take a look.`,
          result: `${who} gets ${p.lastSender}’s work as it was sent, with your note on top.`,
        };
      },
    },
    {
      id: "send_task",
      way: "Send a Task",
      prompt: "Send Sam a Task to review the pricing page copy by Friday.",
      result: "Sam can take it on, and you see when it starts and when it is done.",
      done: (u) => u.sentTask,
      personal: (p) => { const who = p.next(); return who && {
        prompt: `Send ${who} a Task to review this by Friday.`,
        result: `${who} can take it on, and you see when it starts and when it is done.`,
      }; },
    },
  ].map(Object.freeze));
  const COUNT_WORDS = ["", "One", "Two", "Three", "Four", "Five"];

  /** How a prompt names someone: their first name, never an address. */
  function firstName(name) {
    let text = String(name || "").trim();
    if (text.includes("@")) text = text.split("@")[0].replace(/[._-]+/g, " ").trim();
    const first = text.split(/\s+/)[0] || "";
    if (!first || first === "Someone" || first === "Relay") return "";
    return first.charAt(0).toUpperCase() + first.slice(1);
  }

  /**
   * The ways the smart card offers, in order, written with the person's own
   * people when there are some. `people.recent` lists the names they relay
   * with, newest first; `people.lastSender` last sent them something.
   * `read` holds the ids of `once` ways this card has already shown.
   */
  function pickWays(usage, people = {}, read = new Set()) {
    const u = usage && typeof usage === "object" ? usage : {};
    const chosen = WAYS.filter((way) => (!way.when || way.when(u) === true) && way.done(u) !== true
      && !(way.once && read.has(way.id))).slice(0, SHOWN);
    const recent = [...new Set((Array.isArray(people.recent) ? people.recent : []).map(firstName).filter(Boolean))];
    let turn = 0;
    const p = {
      waiting: firstName(u.examples?.unopenedFrom),
      waitingFiles: firstName(u.examples?.unopenedFilesFrom),
      lastSender: firstName(people.lastSender),
      // The next person in turn, skipping `not` when there is anyone else.
      next(not) {
        const pool = recent.filter((name) => name !== not);
        return pool.length ? pool[turn++ % pool.length] : "";
      },
    };
    return chosen.map((way) => {
      const own = way.personal ? way.personal(p) : null;
      return own ? Object.freeze({ ...way, ...own }) : way;
    });
  }
  /** The card's title: "more" once the person has used a way the card taught. */
  function titleFor(ways) {
    const same = (list) => ways.length === list.length && ways.every((way, i) => way.id === list[i].id);
    if (!ways.length || same(EXAMPLES) || same(pickWays(null))) return TITLE;
    return `${COUNT_WORDS[ways.length]} more ${ways.length === 1 ? "way" : "ways"} to use Relay`;
  }
  // `expanded: true` opens the card straight away and keeps it open across
  // reset(): the application installer's setup window shows the five ways
  // while Relay downloads, with nothing to minimise them into.
  //
  // `onEvent(name, way)` hears what the person does with the card, for
  // engagement telemetry: "shown" as it comes on screen, "expanded", "minimised", and
  // "example_chosen" / "example_copied" with the example's id, and
  // "example_read" when a `once` way has been on screen. Automatic
  // rotation is not a choice and reports nothing.
  //
  // setTeaching({ smart, usage, people }) switches to the smart card, which
  // retires a way once the person has used it and writes its examples with
  // the person's own people (see pickWays). The fixed five stay otherwise.
  function create(root, { expanded: startExpanded = false, onEvent = null } = {}) {
    const doc = root.ownerDocument, win = doc.defaultView;
    root.classList.add("relay-anyone-tip");
    root.innerHTML = `
      <button class="rat-summary" type="button" aria-expanded="false">
        <span class="rat-title"></span><span class="rat-see">See how <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg></span>
      </button>
      <section class="rat-card" hidden>
        <div class="rat-head"><span class="rat-title"></span><button class="rat-minimise" type="button" aria-label="Minimise tip" aria-expanded="true">−</button></div>
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
    const controlsRow = find(".rat-controls");
    // Collapsed on every open; "See how" expands it until Relay next opens.
    let index = 0, expanded = startExpanded, paused = false, visible = false, active = false, onScreen = false;
    let ways = EXAMPLES, slides = [], pending = null;
    // What the smart card was last told, and the `once` ways it has shown.
    let teaching = { smart: false, usage: null, people: {} };
    const read = new Set();
    function report(name, way) {
      if (typeof onEvent !== "function") return;
      try { onEvent(name, way); } catch {}
    }
    // The app decides how often "shown" is worth recording.
    function noteOnScreen() {
      const next = visible && active && ways.length > 0;
      if (next && !onScreen) report("shown");
      onScreen = next;
    }
    function setExpanded(next) {
      expanded = next;
      controls();
    }
    let inViewport = false, timer = null, animations = [], generation = 0;
    function build(next) {
      stopMotion();
      const current = ways[index]?.id;
      ways = next;
      const title = titleFor(ways);
      root.querySelectorAll(".rat-title").forEach((el) => { el.textContent = title; });
      summary.setAttribute("aria-label", `Expand tip: ${title}`);
      card.setAttribute("aria-label", title);
      track.replaceChildren(); result.replaceChildren(); dots.replaceChildren();
      slides = ways.map((example, i) => {
        const slide = doc.createElement("div");
        slide.className = "rat-slide";
        slide.setAttribute("role", "group");
        slide.setAttribute("aria-roledescription", "slide");
        slide.setAttribute("aria-label", `${i + 1} of ${ways.length}: ${example.way}`);
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
        dot.setAttribute("aria-label", `Example ${i + 1} of ${ways.length}`);
        dot.append(doc.createElement("span"));
        dot.addEventListener("click", () => select(i, i >= index ? 1 : -1, true));
        dots.append(dot);
        return slide;
      });
      controlsRow.hidden = ways.length < 2;
      root.hidden = !visible || !ways.length;
      // Keep the example the person was looking at when it is still offered.
      index = Math.max(0, ways.findIndex((way) => way.id === current));
      select(index);
      noteOnScreen();
    }
    function stopMotion() {
      animations.forEach((animation) => animation.cancel());
      animations = [];
      slides.forEach((slide) => slide.classList.remove("leaving"));
    }
    function schedule() {
      win.clearTimeout(timer); timer = null;
      if (visible && active && expanded && !paused && inViewport && !doc.hidden && ways.length > 1) {
        timer = win.setTimeout(() => select((index + 1) % ways.length, 1), INTERVAL_MS);
      } else if (!visible || !active || !expanded || !inViewport || doc.hidden) stopMotion();
      noteRead();
    }
    // A `once` way counts as read as soon as it is the slide on screen in the
    // open card, however it got there. It goes at the next refresh.
    function noteRead() {
      const way = ways[index];
      if (!way?.once || read.has(way.id)) return;
      if (!(visible && active && expanded && inViewport && !doc.hidden)) return;
      read.add(way.id);
      report("example_read", way.id);
      refresh();
    }
    function refresh() {
      offer(teaching.smart ? pickWays(teaching.usage, teaching.people, read) : EXAMPLES);
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
      if (previous !== index && visible && active && slides[previous] && !win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
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
      status.textContent = manual ? `Example ${index + 1} of ${ways.length}` : "";
      if (manual && previous !== index) report("example_chosen", ways[index].id);
      controls();
    }
    // A way the person has just used or read leaves the card, but never from
    // under them: while the card is open on screen the change waits for it to
    // close.
    function offer(next) {
      if (next.length === ways.length && next.every((way, i) => way.id === ways[i].id && way.prompt === ways[i].prompt)) { pending = null; return; }
      if (visible && active && expanded) { pending = next; return; }
      pending = null; build(next);
    }
    function applyPending() {
      if (pending) { const next = pending; pending = null; build(next); }
    }
    const step = (direction) => {
      if (ways.length < 2) return;
      select((index + direction + ways.length) % ways.length, direction, true);
    };
    summary.addEventListener("click", () => { setExpanded(true); report("expanded"); minimise.focus({preventScroll:true}); });
    minimise.addEventListener("click", () => { setExpanded(false); report("minimised"); applyPending(); summary.focus({preventScroll:true}); });
    find(".rat-carousel").addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      step(event.key === "ArrowRight" ? 1 : -1);
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
      step(dx < 0 ? 1 : -1);
    });
    copy.addEventListener("click", async () => {
      const { prompt: text, id } = ways[index], ticket = ++generation;
      paused = true; controls();
      try {
        await win.navigator.clipboard.writeText(text);
        report("example_copied", id);
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
    build(EXAMPLES);
    root.hidden = true;
    return {
      setVisible(next) {
        next = Boolean(next);
        if (visible === next) return;
        visible = next; root.hidden = !visible || !ways.length; schedule(); noteOnScreen();
        if (!visible) applyPending();
      },
      setActive(next) {
        next = Boolean(next);
        if (active === next) return;
        active = next; schedule(); noteOnScreen();
        if (!active) applyPending();
      },
      setTeaching({ smart = false, usage = null, people = {} } = {}) {
        teaching = { smart, usage, people };
        refresh();
      },
      // Every open starts from the collapsed tip and the first example.
      reset() { paused = false; expanded = startExpanded; applyPending(); select(0); },
      destroy() { visible = false; schedule(); observer.disconnect(); doc.removeEventListener("visibilitychange", schedule); },
    };
  }
  return { create, TITLE, EXAMPLES, WAYS, INTERVAL_MS, pickWays, titleFor, firstName };
});
