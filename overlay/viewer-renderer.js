"use strict";

// The attachment viewer window. It knows ids and display strings; main knows
// files. Everything drawn here is set with textContent or an attribute, never
// with innerHTML, because the names come off the wire with the attachment.

(() => {
  const bridge = window.relayViewer;
  if (!bridge) return;

  const $ = (id) => document.getElementById(id);
  const el = {
    name: $("vName"), meta: $("vMeta"), acts: $("vActs"),
    download: $("vDownload"), reveal: $("vReveal"), more: $("vMore"),
    full: $("vFull"), min: $("vMin"), close: $("vClose"), message: $("vMessage"),
    stage: $("vStage"), image: $("vImage"), prev: $("vPrev"), next: $("vNext"), strip: $("vStrip"),
    zoomOut: $("vZoomOut"), zoomPct: $("vZoomPct"), zoomIn: $("vZoomIn"),
    fileHead: $("vFileHead"), fileTile: $("vFileTile"), fileName: $("vFileName"), fileMeta: $("vFileMeta"),
    text: $("vText"), pdf: $("vPdf"), html: $("vHtml"), htmlNote: $("vHtmlNote"),
    none: $("vNone"), noneTile: $("vNoneTile"), noneName: $("vNoneName"),
    noneWhat: $("vNoneWhat"), noneDownload: $("vNoneDownload"),
  };

  // ---- the pill's 16-grid icon set ----------------------------------------
  const ICON = {
    download: "M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13h10",
    reveal: "M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z",
    more: "M4 8h.01M8 8h.01M12 8h.01",
    close: "M4 4l8 8M12 4l-8 8",
    minimise: "M3.5 8h9",
    left: "M10 3L5 8l5 5",
    right: "M6 3l5 5-5 5",
    plus: "M8 3.5v9M3.5 8h9",
    fullscreen: "M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10",
    exitFullscreen: "M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5",
    file: "M4 2.2h5.3l3 3.4v8.2H4zM9.3 2.2v3.4h3",
  };
  function icon(name, size = 16) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICON[name] || ICON.file);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }
  function label(button, iconName, text) {
    button.replaceChildren(icon(iconName));
    if (text) button.append(document.createTextNode(` ${text}`));
  }

  function fmtBytes(bytes) {
    const n = Number(bytes || 0);
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return n > 0 ? `${n} B` : "";
  }
  function timeAgo(at) {
    const then = Date.parse(at || "");
    if (!Number.isFinite(then)) return "";
    const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }
  function extensionTag(name) {
    const match = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ""));
    return match ? match[1].toUpperCase().slice(0, 4) : "FILE";
  }

  // ---- state ---------------------------------------------------------------
  let view = { kind: "image", chatTitle: "", items: [], index: 0 };
  let fullScreen = false;
  const contentCache = new Map();

  const current = () => view.items[view.index] || null;
  const itemKey = (item) => `${item.relayId}::${item.attachmentId}`;

  function contentFor(item) {
    const key = itemKey(item);
    if (!contentCache.has(key)) {
      contentCache.set(key, Promise.resolve(bridge.item(item.relayId, item.attachmentId)).then((result) => {
        if (!result || result.ok === false) contentCache.delete(key);
        return result;
      }, (error) => { contentCache.delete(key); throw error; }));
    }
    return contentCache.get(key);
  }

  function showOnly(...visible) {
    const all = [el.message, el.stage, el.strip, el.fileHead, el.text, el.pdf, el.html, el.htmlNote, el.none];
    for (const node of all) node.hidden = !visible.includes(node);
    if (!visible.includes(el.html)) el.html.removeAttribute("srcdoc");
  }

  function paintHeader(item, extra = "") {
    document.title = item ? item.name : "Relay";
    el.name.textContent = item ? item.name : "Relay";
    const bits = [];
    if (view.kind === "image" && view.items.length > 1) bits.push(`${view.index + 1} of ${view.items.length}`);
    if (item?.sender) bits.push(item.sender);
    const ago = timeAgo(item?.at);
    if (ago) bits.push(ago);
    if (extra) bits.push(extra);
    el.meta.textContent = bits.join(" · ");
  }

  // ---- the image stage -----------------------------------------------------
  function paintStrip() {
    el.strip.replaceChildren();
    if (view.kind !== "image" || view.items.length < 2) { el.strip.hidden = true; return; }
    view.items.forEach((item, i) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `th${i === view.index ? " on" : ""}`;
      button.title = item.name;
      button.setAttribute("aria-label", item.name);
      const img = document.createElement("img");
      img.alt = "";
      contentFor(item).then((result) => { if (result?.fileUrl) img.src = result.fileUrl; }).catch(() => {});
      button.append(img);
      button.addEventListener("click", () => goTo(i));
      el.strip.append(button);
    });
    el.strip.hidden = false;
    el.strip.children[view.index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function paintImage() {
    const item = current();
    showOnly(el.message, el.strip);
    el.message.textContent = "Opening…";
    el.image.removeAttribute("src");
    paintHeader(item);
    el.prev.disabled = view.index <= 0;
    el.next.disabled = view.index >= view.items.length - 1;
    if (!item) return;
    contentFor(item).then((result) => {
      if (current() !== item) return;
      if (!result || result.ok === false) { fail(result?.error); return; }
      showOnly(el.stage, ...(view.items.length > 1 ? [el.strip] : []));
      el.image.src = result.fileUrl || "";
      el.image.alt = item.name;
    }).catch(() => { if (current() === item) fail(); });
    paintStrip();
  }

  function goTo(index) {
    if (view.kind !== "image") return;
    const next = Math.max(0, Math.min(index, view.items.length - 1));
    if (next === view.index) return;
    view.index = next;
    resetZoom(false);
    paintImage();
  }

  // ---- the file stages -----------------------------------------------------
  function paintFile() {
    const item = current();
    paintHeader(item);
    showOnly(el.message);
    el.message.textContent = "Opening…";
    if (!item) return;
    contentFor(item).then((result) => {
      if (current() !== item || !result) return;
      if (result.ok === false) { fail(result.error); return; }
      el.fileTile.textContent = extensionTag(result.name || item.name);
      el.fileTile.className = `tile${result.kind === "pdf" ? " k-pdf" : result.kind === "text" ? " k-text" : ""}`;
      el.fileName.textContent = result.name || item.name;
      const facts = [fmtBytes(result.size)];
      if (result.kind === "text") facts.push(`${result.total} ${result.total === 1 ? "line" : "lines"}`);
      if (item.sender) facts.push(item.sender);
      el.fileMeta.textContent = facts.filter(Boolean).join(" · ");

      if (result.kind === "html") {
        // Main returns digest-verified markup with a restrictive CSP prepended.
        // The frame has no sandbox permissions: no scripts, same-origin, forms,
        // pop-ups, downloads, or access to the privileged viewer bridge.
        el.html.srcdoc = result.html;
        showOnly(el.htmlNote, el.html);
        return;
      }
      if (result.kind === "text") {
        paintText(result);
        showOnly(el.fileHead, el.text);
        return;
      }
      if (result.kind === "pdf") {
        // Chromium's PDF plugin brings its own toolbar and thumbnail rail; the
        // Relay header already carries the name, download and reveal actions,
        // so ask the plugin to render only the pages.
        el.pdf.src = result.fileUrl ? `${result.fileUrl}#toolbar=0&navpanes=0` : "";
        showOnly(el.fileHead, el.pdf);
        return;
      }
      // Nothing this window can render: say so plainly and make Download the
      // one filled button on the screen.
      el.noneTile.replaceChildren(icon("file", 22));
      el.noneName.textContent = result.name || item.name;
      el.noneWhat.textContent = `${extensionTag(result.name || item.name)} · ${fmtBytes(result.size) || "unknown size"} · ${result.previewReason || "no preview for this type"}`;
      label(el.noneDownload, "download", "Download");
      showOnly(el.none);
    }).catch(() => fail());
  }

  function paintText(result) {
    const frag = document.createDocumentFragment();
    for (const line of result.lines || []) {
      const row = document.createElement("span");
      row.className = `ln${line.trouble ? " bad" : ""}`;
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = String(line.n).padStart(2, "0");
      row.append(n, document.createTextNode(`${line.text}\n`));
      frag.append(row);
    }
    if (result.truncated) {
      const more = document.createElement("span");
      more.className = "more";
      more.textContent = `… ${result.total - (result.lines || []).length} more lines. Open in the default app to read the rest.`;
      frag.append(more);
    }
    el.text.replaceChildren(frag);
  }

  function fail(message) {
    showOnly(el.message);
    el.message.textContent = message || "Relay could not open this attachment.";
  }

  // ---- actions -------------------------------------------------------------
  function act(fn) {
    const item = current();
    if (item) fn(item);
  }
  label(el.download, "download", "Download");
  label(el.reveal, "reveal", "Reveal");
  el.more.replaceChildren(icon("more"));
  el.full.replaceChildren(icon("fullscreen"));
  el.min.replaceChildren(icon("minimise"));
  el.zoomOut.replaceChildren(icon("minimise", 14));
  el.zoomIn.replaceChildren(icon("plus", 14));
  el.close.replaceChildren(icon("close"));
  el.prev.replaceChildren(icon("left"));
  el.next.replaceChildren(icon("right"));

  const download = () => act((item) => bridge.download(
    [{ relayId: item.relayId, attachmentId: item.attachmentId }],
    { chatTitle: view.chatTitle },
  ));
  el.download.addEventListener("click", download);
  el.noneDownload.addEventListener("click", download);
  el.reveal.addEventListener("click", () => act((item) => bridge.reveal(item.relayId, item.attachmentId)));
  el.full.addEventListener("click", () => bridge.toggleFullScreen());
  el.min.addEventListener("click", () => bridge.minimize());
  el.close.addEventListener("click", () => bridge.close());
  el.prev.addEventListener("click", () => goTo(view.index - 1));
  el.next.addEventListener("click", () => goTo(view.index + 1));

  // ⋯ is a two-item menu, so it toggles the two items in place rather than
  // opening a popover this window would then have to manage.
  let moreOpen = null;
  el.more.addEventListener("click", (event) => {
    event.stopPropagation();
    if (moreOpen) { moreOpen.remove(); moreOpen = null; return; }
    const menu = document.createElement("div");
    menu.style.cssText = "position:fixed;z-index:9;min-width:180px;padding:6px;border-radius:12px;"
      + "background:var(--bg);border:1px solid var(--hair);box-shadow:0 12px 30px -18px rgba(0,0,0,.6);"
      + "display:flex;flex-direction:column;gap:1px";
    const add = (text, run) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.style.cssText = "display:flex;align-items:center;height:32px;padding:0 10px;border-radius:9px;font-size:13px;text-align:left";
      button.addEventListener("mouseenter", () => { button.style.background = "var(--wash-2)"; });
      button.addEventListener("mouseleave", () => { button.style.background = "transparent"; });
      button.addEventListener("click", () => { menu.remove(); moreOpen = null; run(); });
      menu.append(button);
    };
    add("Open in default app", () => act((item) => bridge.openDefault(item.relayId, item.attachmentId)));
    if (view.kind === "image") add("Copy image", () => act((item) => bridge.copyImage(item.relayId, item.attachmentId)));
    document.body.append(menu);
    const anchor = el.more.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    menu.style.top = `${Math.round(anchor.bottom + 6)}px`;
    menu.style.left = `${Math.round(Math.max(6, Math.min(anchor.right - size.width, window.innerWidth - size.width - 6)))}px`;
    moreOpen = menu;
  });
  document.addEventListener("click", () => { moreOpen?.remove(); moreOpen = null; });

  // ---- zoom and pan ---------------------------------------------------------
  // The picture is laid out fitted, then scaled and moved by one transform.
  // `scale` is relative to that fitted size (1 = fit); the offset moves the
  // picture's centre away from where layout put it, in stage pixels.
  const ZOOM_MAX = 16;
  const ZOOM_STEP = 1.5;
  const zoom = { scale: 1, x: 0, y: 0 };
  let pan = null;
  let fittedWidth = 0; // the picture's laid-out width when zoom last painted

  // How many fitted pixels make one pixel of the original picture: zooming to
  // this scale shows it at 100%. A picture smaller than the stage is never
  // upscaled to fit, so for it this is 1.
  function actualScale() {
    const shown = el.image.offsetWidth;
    return shown > 0 && el.image.naturalWidth > 0 ? Math.max(1, el.image.naturalWidth / shown) : 1;
  }

  // Keep the picture over the stage: a side larger than the stage cannot be
  // dragged past its edge, a side that fits stays centred. Layout centres the
  // picture inside symmetric padding, so its resting centre is the stage's.
  function clampZoom() {
    const stage = el.stage.getBoundingClientRect();
    const slackX = Math.max(0, (el.image.offsetWidth * zoom.scale - stage.width) / 2);
    const slackY = Math.max(0, (el.image.offsetHeight * zoom.scale - stage.height) / 2);
    zoom.x = Math.max(-slackX, Math.min(slackX, zoom.x));
    zoom.y = Math.max(-slackY, Math.min(slackY, zoom.y));
  }

  function paintZoom({ glide = false } = {}) {
    fittedWidth = el.image.offsetWidth;
    clampZoom();
    el.image.classList.toggle("glide", glide);
    el.image.style.transform = zoom.scale === 1 && !zoom.x && !zoom.y
      ? ""
      : `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`;
    el.stage.classList.toggle("zoomed", zoom.scale > 1);
    const natural = el.image.naturalWidth;
    el.zoomPct.textContent = zoom.scale === 1 || !natural
      ? "Fit"
      : `${Math.round((el.image.offsetWidth * zoom.scale / natural) * 100)}%`;
    el.zoomOut.disabled = zoom.scale <= 1;
    el.zoomIn.disabled = zoom.scale >= ZOOM_MAX;
  }

  function resetZoom(glide = true) {
    zoom.scale = 1;
    zoom.x = 0;
    zoom.y = 0;
    pan = null;
    el.stage.classList.remove("panning");
    paintZoom({ glide });
  }

  // Zoom to `scale`, keeping the picture point under (clientX, clientY) where
  // it is. Without a point, zoom about the middle of the stage.
  function zoomTo(scale, clientX, clientY, { glide = false } = {}) {
    if (view.kind !== "image" || !el.image.naturalWidth) return;
    const next = Math.max(1, Math.min(ZOOM_MAX, scale));
    const stage = el.stage.getBoundingClientRect();
    const cx = stage.left + stage.width / 2;
    const cy = stage.top + stage.height / 2;
    const px = (Number.isFinite(clientX) ? clientX : cx) - cx;
    const py = (Number.isFinite(clientY) ? clientY : cy) - cy;
    const ratio = next / zoom.scale;
    zoom.x = px - (px - zoom.x) * ratio;
    zoom.y = py - (py - zoom.y) * ratio;
    zoom.scale = next;
    if (next === 1) { zoom.x = 0; zoom.y = 0; }
    paintZoom({ glide });
  }

  // Double-click toggles fit / 100%: the two sizes a photo is ever looked at.
  // A picture already shown at its own size goes to double instead.
  function toggleActualSize(clientX, clientY) {
    if (zoom.scale > 1) { resetZoom(); return; }
    const actual = actualScale();
    zoomTo(actual > 1.05 ? actual : 2, clientX, clientY, { glide: true });
  }

  const onStageControl = (target) => target instanceof Element && target.closest("button");

  el.stage.addEventListener("wheel", (event) => {
    if (view.kind !== "image" || el.stage.hidden) return;
    event.preventDefault();
    // A mouse notch is ~100 pixels (or 3 lines); a trackpad pinch arrives as
    // many small ctrl+wheel steps, so it gets a steeper curve.
    const delta = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY;
    zoomTo(zoom.scale * Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0025)), event.clientX, event.clientY);
  }, { passive: false });

  el.stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || zoom.scale <= 1 || onStageControl(event.target)) return;
    event.preventDefault();
    pan = { id: event.pointerId, x: event.clientX - zoom.x, y: event.clientY - zoom.y };
    el.stage.setPointerCapture(event.pointerId);
    el.stage.classList.add("panning");
  });
  el.stage.addEventListener("pointermove", (event) => {
    if (!pan || event.pointerId !== pan.id) return;
    zoom.x = event.clientX - pan.x;
    zoom.y = event.clientY - pan.y;
    paintZoom();
  });
  const endPan = (event) => {
    if (!pan || event.pointerId !== pan.id) return;
    pan = null;
    el.stage.classList.remove("panning");
  };
  el.stage.addEventListener("pointerup", endPan);
  el.stage.addEventListener("pointercancel", endPan);

  el.stage.addEventListener("dblclick", (event) => {
    if (onStageControl(event.target)) return;
    toggleActualSize(event.clientX, event.clientY);
  });
  el.zoomIn.addEventListener("click", () => zoomTo(zoom.scale * ZOOM_STEP, NaN, NaN, { glide: true }));
  el.zoomOut.addEventListener("click", () => zoomTo(zoom.scale / ZOOM_STEP, NaN, NaN, { glide: true }));
  el.zoomPct.addEventListener("click", () => toggleActualSize());
  el.image.addEventListener("load", () => paintZoom());
  // Resizing (full screen included) refits the picture. Keep what the person
  // was looking at the same size on screen, so 100% stays 100%, and pull the
  // picture back over the stage.
  window.addEventListener("resize", () => {
    const width = el.image.offsetWidth;
    if (fittedWidth && width && zoom.scale > 1) {
      zoom.scale = Math.max(1, Math.min(ZOOM_MAX, zoom.scale * (fittedWidth / width)));
      if (zoom.scale === 1) { zoom.x = 0; zoom.y = 0; }
    }
    paintZoom();
  });

  document.addEventListener("keydown", (event) => {
    // Esc steps back one level: out of full screen first, then the window.
    if (event.key === "Escape") { if (fullScreen) bridge.leaveFullScreen(); else bridge.close(); return; }
    if (event.key === "F11" || (event.key.toLowerCase() === "f" && !event.metaKey && !event.ctrlKey && !event.altKey)) {
      event.preventDefault();
      bridge.toggleFullScreen();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); download(); return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && view.kind === "image") {
      event.preventDefault();
      act((item) => bridge.copyImage(item.relayId, item.attachmentId));
      return;
    }
    if (view.kind !== "image") return;
    if (event.key === "ArrowLeft") { event.preventDefault(); goTo(view.index - 1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); goTo(view.index + 1); }
    else if (event.metaKey || event.ctrlKey || event.altKey) return;
    else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomTo(zoom.scale * ZOOM_STEP, NaN, NaN, { glide: true }); }
    else if (event.key === "-" || event.key === "_") { event.preventDefault(); zoomTo(zoom.scale / ZOOM_STEP, NaN, NaN, { glide: true }); }
    else if (event.key === "0") { event.preventDefault(); resetZoom(); }
  });

  // ---- main's word ---------------------------------------------------------
  bridge.onFullScreen((on) => {
    fullScreen = on;
    document.documentElement.classList.toggle("fs", on);
    el.full.replaceChildren(icon(on ? "exitFullscreen" : "fullscreen"));
    el.full.setAttribute("aria-label", on ? "Exit full screen" : "Full screen");
    el.full.title = on ? "Exit full screen (Esc)" : "Full screen (F)";
  });
  bridge.onTheme((theme) => document.documentElement.setAttribute("data-theme", theme === "dark" ? "dark" : "light"));
  bridge.onContent((payload) => {
    document.documentElement.setAttribute("data-theme", payload.theme === "dark" ? "dark" : "light");
    view = {
      kind: payload.kind === "file" ? "file" : "image",
      chatTitle: String(payload.chatTitle || ""),
      items: Array.isArray(payload.items) ? payload.items : [],
      index: Number.isInteger(payload.index) ? payload.index : 0,
    };
    resetZoom(false);
    if (!view.items.length) { fail("This attachment is no longer in the conversation."); return; }
    if (view.kind === "image") paintImage(); else paintFile();
  });
  // The bubble meta in the pill is the primary progress readout; here it only
  // tells the header that the save it started has finished.
  bridge.onDownloadProgress((event) => {
    const item = current();
    if (!item || event.relayId !== item.relayId || event.attachmentId !== item.attachmentId) return;
    if (event.state === "downloading") label(el.download, "download", "Saving…");
    else if (event.state === "done") label(el.download, "download", "Saved");
    else if (event.state === "error") label(el.download, "download", "Failed");
    if (event.state === "done" || event.state === "error") {
      setTimeout(() => label(el.download, "download", "Download"), 1600);
    }
  });

  bridge.ready();
})();
