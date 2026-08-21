const { contextBridge, ipcRenderer, webUtils } = require("electron");
const MarkdownItModule = require("markdown-it");
const createDOMPurifyModule = require("dompurify");

const MarkdownIt = MarkdownItModule.default || MarkdownItModule;
const createDOMPurify = createDOMPurifyModule.default || createDOMPurifyModule;
const DOMPurify = createDOMPurify.sanitize ? createDOMPurify : createDOMPurify(window);
const MAX_PREVIEW_MARKDOWN_CHARS = 500_000;
const MAX_REPLY_FILES = 20;

function normalizedReplyFiles(files) {
  return (Array.isArray(files) ? files : []).slice(0, MAX_REPLY_FILES).flatMap((file) => {
    const localPath = String((file && file.path) || "");
    const inline = Boolean(file && Object.prototype.hasOwnProperty.call(file, "contentBase64"));
    if (!localPath && !inline) return [];
    return [{
      name: String((file && file.name) || "file"),
      size: Math.max(0, Number((file && file.size) || 0) || 0),
      contentType: String((file && file.contentType) || "application/octet-stream"),
      path: localPath,
      contentBase64: inline ? String(file.contentBase64 || "") : "",
    }];
  });
}

// Relay bodies are authored outside this renderer. Treat every URL as untrusted,
// even after Markdown parsing, and expose only schemes that Electron may safely
// hand to the operating system. Main must repeat this check before openExternal.
function safeExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (!new Set(["https:", "http:", "mailto:"]).has(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
});

markdown.validateLink = (url) => Boolean(safeExternalUrl(url));

// Remote images are intentionally never emitted. Besides keeping the panel
// text-first, this prevents a relay from making a tracking request merely by
// being previewed. Preserve useful alt text as inert prose.
markdown.renderer.rules.image = (tokens, index) => {
  const alt = markdown.utils.escapeHtml(tokens[index].content || "").trim();
  return alt ? `<em>[Image omitted: ${alt}]</em>` : "<em>[Image omitted]</em>";
};

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (!node || node.nodeType !== 1) return;
  if (String(node.nodeName || "").toLowerCase() !== "a") return;
  const safe = safeExternalUrl(node.getAttribute("href"));
  if (!safe) {
    node.removeAttribute("href");
    node.removeAttribute("target");
    node.removeAttribute("rel");
    return;
  }
  node.setAttribute("href", safe);
  node.setAttribute("rel", "noreferrer noopener");
});

function renderMarkdown(value) {
  const source = String(value || "");
  if (source.length > MAX_PREVIEW_MARKDOWN_CHARS) throw new Error("Relay detail is too large to preview safely.");
  if (DOMPurify.isSupported === false) throw new Error("Safe Markdown rendering is unavailable.");
  const rendered = markdown.render(source);
  return DOMPurify.sanitize(rendered, {
    ALLOWED_TAGS: [
      "a",
      "blockquote",
      "br",
      "code",
      "del",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "li",
      "ol",
      "p",
      "pre",
      "s",
      "strong",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr",
      "ul",
    ],
    ALLOWED_ATTR: ["href", "rel", "title"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ["audio", "canvas", "embed", "form", "iframe", "img", "input", "math", "object", "script", "style", "svg", "video"],
    FORBID_ATTR: ["style", "src", "srcset", "target"],
    RETURN_TRUSTED_TYPE: false,
    SANITIZE_NAMED_PROPS: true,
  });
}

contextBridge.exposeInMainWorld("relayPreview", {
  onTheme: (callback) => {
    const listener = (_event, value) => callback(value === "dark" ? "dark" : "light");
    ipcRenderer.on("relay:preview:theme", listener);
    return () => ipcRenderer.removeListener("relay:preview:theme", listener);
  },
  onContent: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, content) => callback(content && typeof content === "object" ? content : {});
    ipcRenderer.on("relay:preview:content", listener);
    return () => ipcRenderer.removeListener("relay:preview:content", listener);
  },
  /**
   * Fires when the inbox changed. Carries no data — it is a nudge to re-read
   * the conversation, so nothing about other people's mail crosses the bridge.
   */
  onMail: (callback) => {
    if (typeof callback !== "function") return () => {};
    const listener = () => callback();
    ipcRenderer.on("relay:preview:mail", listener);
    return () => ipcRenderer.removeListener("relay:preview:mail", listener);
  },
  ready: () => ipcRenderer.send("relay:preview:ready"),
  rendered: (id) => ipcRenderer.send("relay:preview:rendered", String(id || "")),
  renderedChat: (ids) => ipcRenderer.send(
    "relay:preview:chat-rendered",
    Array.from(new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || "")).filter(Boolean))).slice(0, 500),
  ),
  minimize: () => ipcRenderer.send("relay:preview:minimize"),
  close: () => ipcRenderer.send("relay:preview:close"),
  openExternal: (url) => {
    const safe = safeExternalUrl(url);
    if (!safe) return false;
    ipcRenderer.send("relay:preview:openExternal", safe);
    return true;
  },
  // The conversation this message sits in, and the composer that adds to it.
  // Every argument is coerced to a primitive here so the renderer can never
  // hand the main process a structure to walk.
  loadChat: (threadId) => ipcRenderer.invoke("relay:preview:chat", String(threadId || "")),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || ""; } catch { return ""; }
  },
  sendReply: (inReplyToRelayId, body, idempotencyKey, files = []) =>
    ipcRenderer.invoke("relay:preview:reply", {
      inReplyToRelayId: String(inReplyToRelayId || ""),
      body: String(body || ""),
      // Minted once per composed message so a retry converges on the same relay
      // rather than sending it twice.
      idempotencyKey: String(idempotencyKey || ""),
      files: normalizedReplyFiles(files),
    }),
  // The task face's ignition. Same coercion discipline as sendReply.
  startTask: (relayId, note, host, model, effort) =>
    ipcRenderer.invoke("relay:preview:startTask", {
      relayId: String(relayId || ""),
      note: String(note || ""),
      host: String(host || "claude"),
      model: String(model || ""),
      effort: String(effort || ""),
    }),
  // The session face: the live transcript feed and the Steer verb.
  loadSession: (relayId) => ipcRenderer.invoke("relay:preview:session", String(relayId || "")),
  watchRunFeed: (relayId) => ipcRenderer.invoke("relay:runFeed:watch", String(relayId || "")),
  unwatchRunFeed: (relayId) => ipcRenderer.send("relay:runFeed:unwatch", String(relayId || "")),
  onRunFeedUpdate: (cb) => {
    const listener = (_event, envelope) => cb(envelope);
    ipcRenderer.on("relay:runFeed:update", listener);
    return () => ipcRenderer.removeListener("relay:runFeed:update", listener);
  },
  runFeedDetail: (input) => ipcRenderer.invoke("relay:runFeed:detail", {
    relayId:String(input?.relayId || ""), sessionId:String(input?.sessionId || ""),
    turnId:String(input?.turnId || ""), itemId:String(input?.itemId || ""),
  }),
  runFeedAttachment: (input) => ipcRenderer.invoke("relay:runFeed:attachment", {
    relayId: String(input?.relayId || ""),
    sessionId: String(input?.sessionId || ""),
    turnId: String(input?.turnId || ""),
    itemId: String(input?.itemId || ""),
    attachmentId: String(input?.attachmentId || ""),
    attachmentIndex: Number.isInteger(input?.attachmentIndex) ? input.attachmentIndex : -1
  }),
  steer: (relayId, body, newTurn = false) =>
    ipcRenderer.invoke("relay:preview:steer", {
      relayId: String(relayId || ""),
      body: String(body || ""),
      newTurn: newTurn === true,
    }),
  renderMarkdown,
});
