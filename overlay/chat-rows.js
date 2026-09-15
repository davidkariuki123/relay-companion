/* Keep transcript nodes alive across delivery and attachment hydration. */
(function (root) {
  "use strict";
  const renderedMarkup = new WeakMap();
  const containerMarkup = new WeakMap();
  const sendKeys = new Map();
  function rememberSend(key, row) {
    const identity = `send:${key}`;
    for (const alias of [row.id, row.relayId, row.groupSendId].filter(Boolean)) sendKeys.set(String(alias), identity);
  }
  function messageKey(message) {
    if (message.direction !== "out") return `message:${message.id}`;
    const localId = message.outboxId || (message.source?.host === "relay-preview" && message.source.clientMessageId);
    const key = localId ? `send:${localId}` : sendKeys.get(String(message.id))
      || sendKeys.get(String(message.groupSendId)) || `message:${message.groupSendId || message.id}`;
    sendKeys.set(String(message.id), key);
    if (message.groupSendId) sendKeys.set(String(message.groupSendId), key);
    return key;
  }

  function preserveContents(previous, next) {
    const oldText = previous.querySelector(".th-text-content");
    const newText = next.querySelector(".th-text-content");
    if (oldText && newText && oldText.outerHTML === newText.outerHTML) newText.replaceWith(oldText);

    // Cargo clicks are delegated: update the address but keep the actual
    // figure, decoded image, pending load listener and portrait dimensions.
    // Slot matching is allowed only for the same local send becoming history.
    const oldPhotos = [...previous.querySelectorAll('.ca-att[data-att-kind="image"]')];
    const newPhotos = [...next.querySelectorAll('.ca-att[data-att-kind="image"]')];
    newPhotos.forEach((photo, index) => {
      const old = oldPhotos[index];
      if (!old) return;
      const sameFile = old.dataset.attKey === photo.dataset.attKey;
      const committedLocalFile = old.dataset.attRelay?.startsWith("outbox:")
        && !photo.dataset.attRelay?.startsWith("outbox:")
        && old.dataset.attName === photo.dataset.attName && oldPhotos.length === newPhotos.length;
      if (!sameFile && !committedLocalFile) return;
      const ready = old.classList.contains("ready");
      const portrait = old.classList.contains("portrait");
      for (const attribute of [...old.attributes]) {
        if (attribute.name === "style" || attribute.name === "data-loading") continue;
        if (!photo.hasAttribute(attribute.name)) old.removeAttribute(attribute.name);
      }
      for (const attribute of photo.attributes) old.setAttribute(attribute.name, attribute.value);
      if (ready) { old.classList.add("ready"); old.classList.remove("pending"); }
      if (portrait) old.classList.add("portrait");
      photo.replaceWith(old);
    });
  }

  function reconcile(container, html) {
    if (containerMarkup.get(container) === html) return false;
    const template = container.ownerDocument.createElement("template");
    template.innerHTML = html;
    const key = (node, index) => node.dataset.chatKey || `other:${index}`;
    const previous = new Map([...container.children].map((node, index) => [key(node, index), node]));
    let cursor = container.firstElementChild;
    let changed = false;
    for (const [index, desired] of [...template.content.children].entries()) {
      const identity = key(desired, index);
      const old = previous.get(identity);
      const arrivals = [desired, ...desired.querySelectorAll(".live-arrival")].filter(node => node.classList.contains("live-arrival"));
      for (const arrival of arrivals) arrival.classList.remove("live-arrival");
      const markup = desired.outerHTML;
      let node = old;
      if (!old || renderedMarkup.get(old) !== markup) {
        node = desired;
        // An echo of a local bubble is a receipt, not a second entrance.
        if (!old) for (const arrival of arrivals) arrival.classList.add("live-arrival");
        // Insert before moving live children, so a photo never waits in a
        // detached fragment while another asynchronous preview is requested.
        container.insertBefore(node, cursor);
        if (old) {
          preserveContents(old, node);
          if (cursor === old) cursor = old.nextElementSibling;
          old.remove();
        }
        renderedMarkup.set(node, markup);
        changed = true;
      } else if (node !== cursor) {
        container.insertBefore(node, cursor);
        changed = true;
      }
      cursor = node.nextElementSibling;
      previous.delete(identity);
    }
    for (const node of previous.values()) { node.remove(); changed = true; }
    containerMarkup.set(container, html);
    return changed;
  }

  // Preserved controls already have handlers. Newly created controls get the
  // current render's closures exactly once, including after an id changes.
  function newControlsScope(container) {
    const existing = new WeakSet(container.querySelectorAll("*"));
    const querySelectorAll = selector => [...container.querySelectorAll(selector)].filter(node => !existing.has(node));
    return { querySelectorAll, querySelector:selector => querySelectorAll(selector)[0] || null };
  }

  root.RelayChatRows = { reconcile, newControlsScope, rememberSend, messageKey, reset:() => sendKeys.clear() };
})(globalThis);
