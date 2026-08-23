// The preview window wears the same sheet as the pill: light unless the pill's
// moon button ever chose dark (shared file-origin localStorage; never the OS).
try { if (localStorage.getItem("relayTheme") === "dark") document.documentElement.dataset.theme = "dark"; } catch {}
(() => {
  "use strict";

  const bridge = window.relayPreview;
  const titleEl = document.getElementById("messageTitle");
  const metaEl = document.getElementById("messageMeta");
  const senderEl = document.getElementById("messageSender");
  const metaDotEl = document.getElementById("messageMetaDot");
  const timeEl = document.getElementById("messageTime");
  const bodyEl = document.getElementById("messageBody");
  const emptyEl = document.getElementById("emptyDetail");
  const errorEl = document.getElementById("renderError");
  const detailScrollEl = document.getElementById("detailScroll");
  const replyInputEl = document.getElementById("replyInput");
  const replyButtonEl = document.getElementById("replyButton");
  const safetyButtonEl = document.getElementById("safetyButton");
  const safetyPanelEl = document.getElementById("safetyPanel");
  const replyAttachButtonEl = document.getElementById("replyAttachButton");
  const replyFilePickerEl = document.getElementById("replyFilePicker");
  const replyFilesEl = document.getElementById("replyFiles");
  const replyNoteEl = document.getElementById("replyNote");
  const minimizeButtonEl = document.getElementById("minimizeButton");
  const closeButtonEl = document.getElementById("closeButton");
  const facesEl = document.getElementById("faces");
  const faceMessageEl = document.getElementById("faceMessage");
  const faceChatEl = document.getElementById("faceChat");
  const headMessageEl = document.getElementById("headMessage");
  const headChatEl = document.getElementById("headChat");
  const chatChipEl = document.getElementById("chatChip");
  const chatChipNameEl = document.getElementById("chatChipName");
  const chatChipCountEl = document.getElementById("chatChipCount");
  const chatBackEl = document.getElementById("chatBack");
  const chatNameEl = document.getElementById("chatName");
  const chatPeopleEl = document.getElementById("chatPeople");
  const chatScrollEl = document.getElementById("chatScroll");
  const chatListEl = document.getElementById("chatList");
  const chatStateEl = document.getElementById("chatState");
  const taskChipEl = document.getElementById("taskChip");
  const taskStateEl = document.getElementById("taskState");
  const taskRuntimeNoteEl = document.getElementById("taskRuntimeNote");
  const runtimeBtnEl = document.getElementById("runtimeBtn");
  const runtimeWordsEl = document.getElementById("runtimeWords");
  const runtimePopEl = document.getElementById("runtimePop");
  const rtCodexItemEl = document.getElementById("rtCodexItem");
  const sessionScrollEl = document.getElementById("sessionScroll");
  const sessionListEl = document.getElementById("sessionList");
  const sessionStateEl = document.getElementById("sessionState");
  const sessionFooterEl = document.querySelector(".reply-composer");

  const COMPOSER_MIN_HEIGHT = 42;
  const COMPOSER_MAX_HEIGHT = 124;
  const RUN_GAP_MS = 5 * 60 * 1000;
  const CLAMP_HEIGHT = 190;
  const DEFAULT_NOTE = "Press Enter to send, Shift + Enter for a new line.";
  const MAX_REPLY_FILES = 20;

  let renderRevision = 0;
  let chatRevision = 0;
  let content = {};
  /** The loaded conversation this message belongs to, or null. */
  let chat = null;
  /** Has the reader already been placed in this conversation once? */
  let landed = false;
  /**
   * This window IS a conversation, opened from a contact card rather than from
   * a message. There is no message behind it to go back to, so the reading face
   * never comes up and the composer writes to the room even when the room is
   * still empty.
   */
  let chatOnly = false;
  let face = "message";
  let sending = false;
  /** Replies shown before the server has confirmed them. */
  let outgoing = [];
  let stagedReplyFiles = [];
  /** Relay ids whose bubble the reader has opened in place. */
  const expanded = new Set();
  /** Relay ids whose per-person group receipt roster is visible. */
  const expandedReceipts = new Set();
  /** The task face's ignition state: composer starts the task, not a reply. */
  let taskMode = false;
  let starting = false;
  let reviewingSafety = false;
  /** A started task shows its live session in the message-face slot. */
  let sessionMode = false;
  let sessionWatching = false;
  let sessionWatchedRelayId = "";
  let sessionWatchEpoch = 0;
  let sessionRevision = 0;
  let sessionCurrentSessionId = "";
  let sessionFingerprint = "";
  let sessionLive = { provider: "", liveState: "", error: "" };
  /** Disclosure rows the reader has opened; keyed by a stable per-record key. */
  const actOpen = new Set();
  const sessionSummaryStabilizer = RelayWorkUI.createSummaryStabilizer({ delayMs:1000 });
  let sessionScrollController = null;
  /** The runtime the Start button will use. Claude Code · Opus 5 · high. */
  const runtime = { host: "claude", model: "claude-opus-5", effort: "high" };
  const MODEL_LABELS = { "claude-opus-5": "Opus 5", "claude-sonnet-5": "Sonnet 5" };
  const EFFORT_LABELS = { high: "High thinking", medium: "Standard thinking" };

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[character]);
  }

  function firstMeaningfulLine(markdown) {
    for (const raw of String(markdown || "").replace(/\r/g, "").split("\n")) {
      const line = raw
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s{0,3}>\s?/, "")
        .replace(/^\s{0,3}(?:[-*+] |\d+\. )/, "")
        .replace(/[*_`]+/g, "")
        .trim();
      if (line) return line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
    }
    return "";
  }

  function titleFor(row, markdown) {
    return text(row.title) || firstMeaningfulLine(markdown) || "Relay preview";
  }

  function senderFor(row) {
    const sender = text(row.senderName);
    if (sender) return `From ${sender}${row.e2ee ? " · End-to-end encrypted" : ""}`;
    return "Relay";
  }

  function parseDate(value) {
    const raw = text(value);
    if (!raw) return null;
    const date = new Date(raw);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function dateFor(row) {
    const raw = text(row.createdAt);
    if (!raw) return { label: "", iso: "" };
    const date = parseDate(raw);
    if (!date) return { label: raw, iso: "" };
    return {
      label: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date),
      iso: date.toISOString(),
    };
  }

  function clockLabel(value) {
    const date = parseDate(value);
    return date ? new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date) : "";
  }

  function receiptTimestamp(value) {
    const date = parseDate(value);
    return date ? new Intl.DateTimeFormat(undefined, { dateStyle:"medium", timeStyle:"short" }).format(date) : "Seen";
  }

  /** "Today" / "Yesterday" / a weekday inside the last week / a full date. */
  function dayLabel(value) {
    const date = parseDate(value);
    if (!date) return "";
    const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((startOf(new Date()) - startOf(date)) / 86400000);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days > 1 && days < 7) return new Intl.DateTimeFormat(undefined, { weekday: "long" }).format(date);
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
  }

  function dayKey(value) {
    const date = parseDate(value);
    return date ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}` : "";
  }

  function markdownFor(row) {
    return String(row.forHuman || "");
  }

  function setError(message) {
    bodyEl.replaceChildren();
    emptyEl.classList.add("gone");
    errorEl.textContent = text(message) || "This relay could not be rendered.";
    errorEl.classList.remove("gone");
  }

  function autosizeComposer() {
    replyInputEl.style.height = `${COMPOSER_MIN_HEIGHT}px`;
    replyInputEl.style.height = `${Math.min(
      COMPOSER_MAX_HEIGHT,
      Math.max(COMPOSER_MIN_HEIGHT, replyInputEl.scrollHeight),
    )}px`;
  }

  function clipboardFiles(event) {
    const clipboard = event && event.clipboardData;
    const files = [...(clipboard?.files || [])].filter(Boolean);
    if (files.length) return files;
    return [...(clipboard?.items || [])]
      .filter((item) => item && item.kind === "file" && typeof item.getAsFile === "function")
      .map((item) => item.getAsFile())
      .filter(Boolean);
  }

  function paintReplyFiles() {
    replyFilesEl.replaceChildren();
    replyFilesEl.classList.toggle("gone", !stagedReplyFiles.length);
    stagedReplyFiles.forEach((file, index) => {
      const chip = document.createElement("span");
      chip.className = "reply-file";
      const name = document.createElement("span");
      name.className = "reply-file-name";
      name.textContent = file.name || `pasted-${index + 1}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "reply-file-remove";
      remove.setAttribute("aria-label", `Remove ${name.textContent}`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        stagedReplyFiles.splice(index, 1);
        paintReplyFiles();
        refreshComposer();
      });
      chip.append(name, remove);
      replyFilesEl.appendChild(chip);
    });
  }

  function stageReplyFiles(list) {
    for (const file of [...(list || [])].filter(Boolean)) {
      if (stagedReplyFiles.length >= MAX_REPLY_FILES) break;
      stagedReplyFiles.push(file);
    }
    paintReplyFiles();
    refreshComposer();
  }

  async function replyFilePayloads(staged) {
    const files = [];
    const attachments = [];
    for (let index = 0; index < staged.length; index += 1) {
      const file = staged[index];
      const name = String(file?.name || `pasted-${index + 1}`);
      const size = Number(file?.size || 0);
      const contentType = String(file?.type || "application/octet-stream");
      const osPath = bridge.pathForFile ? bridge.pathForFile(file) : "";
      if (osPath) {
        files.push({ name, size, contentType, path: osPath });
      } else if (file?.arrayBuffer) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        files.push({ name, size, contentType, contentBase64: btoa(binary) });
      } else {
        throw new Error(`${name} could not be read`);
      }
      attachments.push({ name, contentType, bytes: size });
    }
    return { files, attachments };
  }

  // --- The conversation affordance -------------------------------------------

  /**
   * Who a reply typed right now is answering. On the conversation face that is
   * the newest message in the room (the server decides, so a chat that merges
   * several threads stays one conversation); on the message face it is the
   * message being read.
   */
  function replyTargetId() {
    if (face === "chat" && chat && text(chat.replyToRelayId)) return text(chat.replyToRelayId);
    if (face === "chat" && chat && chat.items && chat.items.length) {
      return text(chat.items[chat.items.length - 1].relayId);
    }
    return text(content.relayId);
  }

  function composerPlaceholder() {
    if (face === "chat") {
      // The name the reader knows this person by comes with the window; the
      // room's own title is the fallback.
      const who = chatOnly
        ? text(content.chatTitle) || text(chat && chat.title)
        : text(chat && chat.title) || chatTitleHint(content);
      return `Message ${who || "this conversation"}…`;
    }
    const who = text(content.senderName).replace(/^You → /, "");
    return who && !content.outbound ? `Reply to ${who.split(" ")[0]}…` : "Write a reply…";
  }

  function sessionSettled() {
    if (Boolean(text(content.taskCompletedAt))) return true;
    return ["review_ready", "blocked", "completed", "failed", "idle", "archived", "stopped", "offline"]
      .includes(text(sessionLive.liveState).toLowerCase());
  }

  function refreshComposer() {
    const humanComposer = !taskMode && !(sessionMode && face !== "chat");
    replyAttachButtonEl.classList.toggle("gone", !humanComposer);
    replyAttachButtonEl.disabled = sending || !humanComposer;
    if (taskMode) {
      // The ignition: the note is optional, so Start is ready whenever a start
      // is not already in flight.
      replyInputEl.placeholder = "Add a note for your agent — sent to the sender when you start…";
      replyInputEl.disabled = starting;
      replyButtonEl.disabled = starting;
      replyButtonEl.setAttribute("aria-disabled", starting ? "true" : "false");
      replyButtonEl.textContent = starting ? "Accepting…" : "Accept";
      safetyButtonEl.classList.remove("gone");
      safetyButtonEl.disabled = starting || reviewingSafety;
      safetyButtonEl.textContent = reviewingSafety ? "Reviewing…" : "Review Safety";
      taskRuntimeNoteEl.classList.remove("gone");
      replyNoteEl.classList.add("gone");
      return;
    }
    safetyButtonEl.classList.add("gone");
    safetyPanelEl.classList.add("gone");
    taskRuntimeNoteEl.classList.add("gone");
    replyNoteEl.classList.remove("gone");
    if (sessionMode && face !== "chat") {
      // On the session face the composer talks to the AGENT: words land in the
      // live turn without interrupting it. Replies to the sender live one
      // slide away, on the conversation face.
      const done = sessionSettled();
      replyInputEl.placeholder = done ? "Ask the agent for a follow-up…" : "Steer the current turn…";
      replyInputEl.disabled = sending;
      const ready = !sending && Boolean(replyInputEl.value.trim());
      replyButtonEl.disabled = !ready;
      replyButtonEl.setAttribute("aria-disabled", ready ? "false" : "true");
      replyButtonEl.textContent = sending ? "Sending…" : done ? "Send" : "Steer";
      return;
    }
    // A room opened from a contact card can always be written to: with nothing
    // to answer, the message is addressed to the person the window is for.
    const hasTarget = Boolean(replyTargetId()) || chatOnly;
    replyInputEl.placeholder = composerPlaceholder();
    replyInputEl.disabled = sending || !hasTarget;
    const ready = hasTarget && !sending && Boolean(replyInputEl.value.trim() || stagedReplyFiles.length);
    replyButtonEl.disabled = !ready;
    replyButtonEl.setAttribute("aria-disabled", ready ? "false" : "true");
    replyButtonEl.textContent = sending ? "Sending…" : "Send";
  }

  // --- The task face's ignition ----------------------------------------------

  function renderRuntimeWords() {
    runtimeWordsEl.textContent =
      runtime.host === "codex"
        ? "Codex"
        : `Claude Code · ${MODEL_LABELS[runtime.model] || runtime.model} · ${EFFORT_LABELS[runtime.effort] || runtime.effort}`;
    // Model and thinking are Claude choices; Codex keeps its own defaults.
    for (const el of runtimePopEl.querySelectorAll("[data-rt-claude]")) {
      el.classList.toggle("gone", runtime.host === "codex");
    }
  }

  function renderTaskMeta() {
    const isTaskFace = text(content.openFace) === "task";
    taskChipEl.classList.toggle("gone", !isTaskFace);
    if (!isTaskFace) {
      taskStateEl.classList.add("gone");
      return;
    }
    if (text(content.taskCompletedAt)) {
      taskStateEl.textContent = "Done";
      taskStateEl.classList.add("done");
      taskStateEl.classList.remove("gone");
    } else if (text(content.taskStartedAt)) {
      const clock = clockLabel(content.taskStartedAt);
      taskStateEl.textContent = clock ? `Started ${clock}` : "Started";
      taskStateEl.classList.remove("done");
      taskStateEl.classList.remove("gone");
    } else {
      taskStateEl.classList.add("gone");
    }
  }

  function renderSafetyReview(review) {
    safetyPanelEl.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = review.concern === "high" ? "Look closely before accepting" : "Safety review";
    const summary = document.createElement("div");
    summary.textContent = text(review.summary);
    safetyPanelEl.append(heading, summary);
    const permissions = Array.isArray(review.permissions) ? review.permissions : [];
    if (permissions.length) {
      const chips = document.createElement("div");
      chips.className = "safety-permissions";
      for (const permission of permissions) {
        const chip = document.createElement("span");
        chip.className = "safety-permission";
        chip.textContent = text(permission.label);
        chip.title = text(permission.effect);
        chips.appendChild(chip);
      }
      safetyPanelEl.appendChild(chips);
      const effects = document.createElement("div");
      for (const permission of permissions) {
        const effect = document.createElement("div");
        effect.textContent = `${text(permission.label)}: ${text(permission.effect)}`;
        effects.appendChild(effect);
      }
      safetyPanelEl.appendChild(effects);
    }
    const plain = document.createElement("div");
    plain.textContent = text(review.plainLanguage);
    safetyPanelEl.appendChild(plain);
    if (text(review.trustContext)) {
      const trust = document.createElement("div");
      trust.textContent = text(review.trustContext);
      safetyPanelEl.appendChild(trust);
    }
    safetyPanelEl.classList.remove("gone");
  }

  async function reviewSafety() {
    if (!taskMode || reviewingSafety) return;
    const id = text(content.relayId);
    if (!id) return;
    reviewingSafety = true;
    refreshComposer();
    let result;
    try {
      result = await bridge.reviewSafety(id);
    } catch (error) {
      result = { ok: false, error: (error && error.message) || String(error) };
    }
    reviewingSafety = false;
    if (result?.ok && result.review) renderSafetyReview(result.review);
    else renderSafetyReview({
      concern: "review",
      summary: text(result?.error) || "The safety review could not be prepared.",
      permissions: [],
      plainLanguage: "Nothing was accepted or started. You can try the review again.",
    });
    refreshComposer();
  }

  async function submitStart() {
    if (starting) return;
    const note = replyInputEl.value.trim();
    const id = text(content.relayId);
    if (!id) return;
    starting = true;
    refreshComposer();
    let result;
    try {
      result = await bridge.startTask(id, note, runtime.host, runtime.model, runtime.effort);
    } catch (error) {
      result = { ok: false, error: (error && error.message) || String(error) };
    }
    starting = false;
    if (!result || !result.ok) {
      refreshComposer();
      taskRuntimeNoteEl.classList.add("gone");
      replyNoteEl.classList.remove("gone");
      setNote(text(result && result.error) || "The task could not be started.", true);
      return;
    }
    // Started: the composer settles into an ordinary reply box, the receipt
    // word appears, and the conversation face shows the "Started" reply the
    // sender just received.
    content.taskStartedAt = text(result.taskStartedAt) || new Date().toISOString();
    taskMode = false;
    replyInputEl.value = "";
    autosizeComposer();
    renderTaskMeta();
    // The window turns into the live session: the note appears as the one
    // bubble, the agent's work streams in beneath it. The conversation (with
    // the sender's "Started" copy) stays one slide away on the chip.
    setSessionMode(true);
    refreshComposer();
    if (result.running === false) {
      setNote("Started, but the run could not be launched automatically — open it in Claude to work on it.", true);
    } else {
      setNote("Started — your agent has it from here.");
    }
    loadChat({ keepScroll: false }).catch(() => {});
  }

  function setNote(message, isError) {
    replyNoteEl.textContent = text(message) || DEFAULT_NOTE;
    replyNoteEl.classList.toggle("error", Boolean(isError));
  }

  function updateChip() {
    if (!chat) {
      chatChipEl.classList.add("gone");
      return;
    }
    const count = (chat.messageCount || (chat.items || []).length || 0) + outgoing.length;
    chatChipNameEl.textContent = text(chat.title) || "Conversation";
    chatChipCountEl.textContent = count > 1 ? String(count) : "";
    chatChipEl.setAttribute(
      "aria-label",
      `Open the conversation with ${text(chat.title) || "these people"}`,
    );
    chatChipEl.classList.remove("gone");
  }

  function showFace(next, { force = false } = {}) {
    // There is no message behind a contact's chat, so there is no reading face
    // to fall back to — every path that would leave the conversation stays.
    if (chatOnly && next !== "chat") return;
    if (face === next && !force) return;
    face = next;
    const onChat = face === "chat";
    facesEl.classList.toggle("at-chat", onChat);
    headMessageEl.classList.toggle("gone", onChat);
    headChatEl.classList.toggle("gone", !onChat);
    faceMessageEl.setAttribute("aria-hidden", onChat ? "true" : "false");
    faceChatEl.setAttribute("aria-hidden", onChat ? "false" : "true");
    if (onChat) paintChat();
    refreshComposer();
  }

  /**
   * Show the conversation, and put the reader where they belong in it: on the
   * message they came in on the first time, at the live end after that.
   */
  function paintChat({ stick = true } = {}) {
    renderChat();
    if (!chat) return; // still loading — the load will place them
    if (landed) {
      if (stick) scrollChatToLatest();
      return;
    }
    landed = true;
    scrollChatToOpened();
  }

  function scrollChatToLatest() {
    requestAnimationFrame(() => {
      chatScrollEl.scrollTop = chatScrollEl.scrollHeight;
    });
  }

  const cssEscape = (value) =>
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");

  /**
   * Land on the message the window was opened from. Opening a text message
   * three days old should not drop the reader at the bottom of a conversation
   * that has moved on since — but the newest message belongs where a
   * conversation always sits, at the end.
   *
   * Centred by moving THIS scroller and nothing else. scrollIntoView is wrong
   * here: it scrolls every scrollable ancestor, and the faces track is one of
   * them (overflow:hidden still scrolls programmatically), so it slid the whole
   * conversation sideways out of the window while every DOM check still passed.
   */
  function scrollChatToOpened() {
    const id = text(content.relayId);
    const target = id ? chatListEl.querySelector(`.bubble-row[data-relay-id="${cssEscape(id)}"]`) : null;
    if (!target || !target.nextElementSibling) {
      scrollChatToLatest();
      return;
    }
    requestAnimationFrame(() => {
      if (!target.isConnected) return;
      const view = chatScrollEl.getBoundingClientRect();
      const row = target.getBoundingClientRect();
      chatScrollEl.scrollTop += row.top + row.height / 2 - (view.top + view.height / 2);
    });
  }

  function nearChatBottom() {
    return chatScrollEl.scrollHeight - chatScrollEl.scrollTop - chatScrollEl.clientHeight < 90;
  }

  /**
   * Load the conversation around the open message. Guarded by a revision so a
   * slow load for a message the reader has already navigated away from is
   * dropped rather than painted over the new one.
   */
  async function loadChat({ keepScroll = false } = {}) {
    if (!bridge.loadChat) return;
    const threadId = text(content.threadId);
    const revision = ++chatRevision;
    // A contact's window knows its room by id, which main holds; it has no
    // thread of its own to ask about, and asking is not how it resolves.
    if (!threadId && !chatOnly) {
      chat = null;
      updateChip();
      // Nothing to open into: never strand the reader on an empty conversation.
      if (face === "chat") showFace("message");
      return;
    }
    let result;
    try {
      result = await bridge.loadChat(threadId);
    } catch (error) {
      result = { ok: false, error: (error && error.message) || String(error) };
    }
    if (revision !== chatRevision) return;
    if (!result || !result.ok) {
      // A refresh that fails must not erase a conversation already on screen —
      // that is what a reload after a SUCCESSFUL send does, and blanking the
      // room the reply just went to reads as though the reply destroyed it.
      if (chat) {
        setNote(text(result && result.error) || "Could not refresh this conversation.", true);
        return;
      }
      chat = null;
      updateChip();
      const failure = text(result && result.error) || "Could not open this conversation.";
      // A contact's window has no message to fall back to, so the reason goes
      // where the conversation would have been. The composer stays live: the
      // history did not load, but this person can still be written to.
      if (chatOnly) {
        // Unless they have already written in it — then their own messages
        // stay on screen and the note carries the reason instead.
        if (outgoing.length) renderChat();
        else renderChatState(failure, true);
        setNote(failure, true);
        refreshComposer();
        return;
      }
      // A message that opened straight into its conversation has nowhere to sit
      // if that conversation will not load. Give the reader back the message
      // they clicked, with the reason on the composer's note line.
      if (face === "chat") {
        showFace("message");
        setNote(failure, true);
      }
      return;
    }
    chat = result.chat || null;
    // Only replies that never landed are still ours to show. Matching on the
    // returned relayId is not enough: a GROUP send answers with one sibling's
    // id, while the transcript collapses the fan-out to a different sibling, so
    // an id match never happened and the bubble showed twice forever. A reply
    // the server accepted is retired here by its own local id instead.
    outgoing = outgoing.filter((o) => o.state !== "sent");
    updateChip();
    if (face === "chat") paintChat({ stick: keepScroll ? nearChatBottom() : true });
    refreshComposer();
  }

  // --- The conversation face --------------------------------------------------

  /** A stable colour per person, hashed from their name so it never shuffles. */
  function authorColorClass(name) {
    const key = text(name).toLowerCase();
    let hash = 0;
    for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    return `p${hash % 8}`;
  }

  /**
   * Who the conversation is with, read off the message alone. Shown while the
   * chat loads so a window that opens straight into a conversation names it
   * from the first frame instead of saying "Conversation" and then changing.
   */
  function chatTitleHint(row) {
    return text(row && row.senderName)
      .replace(/^From\s+/i, "")
      .replace(/^You\s*→\s*/, "");
  }

  function renderChatState(message, isError) {
    chatListEl.replaceChildren();
    chatStateEl.textContent = text(message) || "No messages here yet.";
    chatStateEl.classList.toggle("error", Boolean(isError));
    chatStateEl.classList.remove("gone");
  }

  /**
   * Who is in the room. Only worth saying in a group: in a one-to-one the
   * heading already names the one other person, and repeating it under itself
   * says nothing.
   */
  function peopleLine() {
    if (!chat || chat.kind !== "group") return "";
    const others = ((chat && chat.participants) || [])
      .filter((p) => !p.self)
      .map((p) => text(p.name))
      .filter(Boolean);
    return others.length ? `You, ${others.join(", ")}` : "";
  }

  /**
   * One bubble. The message body is already in hand, so opening a long one
   * costs nothing — no round trip, no second window.
   */
  function buildBubble(entry, { showAuthor, lastOfRun, firstOfRun, receipt }) {
    const row = document.createElement("div");
    row.className = `bubble-row ${entry.mine ? "mine" : "theirs"}`;
    // Named so the conversation can be scrolled to one particular message.
    if (entry.relayId) row.dataset.relayId = entry.relayId;
    if (firstOfRun) row.classList.add("first-of-run");
    if (lastOfRun) row.classList.add("last-of-run");
    if (entry.unread) row.classList.add("unread");
    if (entry.state === "pending") row.classList.add("pending");
    if (entry.state === "failed") row.classList.add("failed");

    if (showAuthor) {
      const author = document.createElement("p");
      author.className = `bubble-author ${authorColorClass(entry.author)}`;
      author.textContent = entry.author;
      row.appendChild(author);
    }

    const bubble = document.createElement("button");
    bubble.className = "bubble";
    bubble.type = "button";

    // Only a two-document Relay carries a visible subject. Human-only rows are
    // text messages; their wire title exists for list/email compatibility and
    // must not repeat or truncate the message inside its bubble.
    const body = String(entry.body || "");
    const subject = text(entry.subject);
    if (subject && entry.hasAgentDocument) {
      const subjectEl = document.createElement("strong");
      subjectEl.className = "bubble-subject";
      subjectEl.style.display = "block";
      subjectEl.style.marginBottom = "5px";
      subjectEl.textContent = subject;
      bubble.appendChild(subjectEl);
    }

    const bodyWrap = document.createElement("div");
    bodyWrap.className = "bubble-body";
    const files = entry.attachments || [];
    try {
      const html = body ? bridge.renderMarkdown(body) : "";
      if (html) {
        // renderMarkdown runs in the isolated preload and returns allowlisted,
        // DOMPurify-sanitized HTML. No other value is assigned through innerHTML.
        const article = document.createElement("div");
        article.className = "markdown";
        article.innerHTML = html;
        bodyWrap.appendChild(article);
      } else {
        bodyWrap.textContent = text(entry.preview) || (files.length ? "" : "(no message body)");
      }
    } catch {
      bodyWrap.textContent = text(entry.preview) || "(this message could not be rendered)";
    }
    if (body || bodyWrap.textContent || !files.length) bubble.appendChild(bodyWrap);

    if (files.length) {
      const list = document.createElement("div");
      list.className = "bubble-files";
      for (const file of files) {
        const chip = document.createElement("button");
        chip.className = "bubble-file";
        chip.type = "button";
        const label = document.createElement("span");
        label.textContent = text(file.name) || "Attachment";
        chip.appendChild(label);
        chip.addEventListener("click", (event) => {
          event.stopPropagation();
          if (text(file.openUrl)) bridge.openExternal(file.openUrl);
        });
        list.appendChild(chip);
      }
      bubble.appendChild(list);
    }

    row.appendChild(bubble);

    const stamp = document.createElement("div");
    stamp.className = "bubble-time";
    if (entry.state === "pending") stamp.textContent = "Sending…";
    else if (entry.state === "failed") stamp.textContent = `Not sent — ${entry.error || "try again"}`;
    else stamp.textContent = clockLabel(entry.at);
    row.appendChild(stamp);

    if (receipt) {
      const receiptLabel = document.createElement(receipt.expandable ? "button" : "div");
      receiptLabel.className = "bubble-receipt";
      receiptLabel.textContent = receipt.label;
      if (receipt.expandable) {
        receiptLabel.type = "button";
        receiptLabel.setAttribute("aria-expanded", expandedReceipts.has(entry.relayId) ? "true" : "false");
        receiptLabel.addEventListener("click", (event) => {
          event.stopPropagation();
          if (expandedReceipts.has(entry.relayId)) expandedReceipts.delete(entry.relayId);
          else expandedReceipts.add(entry.relayId);
          renderChat();
        });
      }
      row.appendChild(receiptLabel);
      if (receipt.expandable && expandedReceipts.has(entry.relayId)) {
        const panel = document.createElement("div");
        panel.className = "receipt-panel";
        for (const member of [...receipt.readers, ...receipt.unread]) {
          const detail = document.createElement("div");
          detail.className = "receipt-row";
          const name = document.createElement("span");
          name.textContent = member.name;
          const when = document.createElement("span");
          when.className = "receipt-when";
          when.textContent = member.seen ? receiptTimestamp(member.readAt) : "Not seen";
          detail.append(name, when);
          panel.appendChild(detail);
        }
        row.appendChild(panel);
      }
    }

    bubble.addEventListener("click", () => {
      if (entry.state === "failed") {
        retryOutgoing(entry.localId);
        return;
      }
      if (!entry.relayId) return;
      if (expanded.has(entry.relayId)) expanded.delete(entry.relayId);
      else expanded.add(entry.relayId);
      renderChat();
    });

    // Clamp only what actually overflows, and only when it is not already open.
    if (!entry.relayId || !expanded.has(entry.relayId)) {
      requestAnimationFrame(() => {
        if (!bodyWrap.isConnected) return;
        if (bodyWrap.scrollHeight <= CLAMP_HEIGHT) return;
        bubble.classList.add("clamped");
        if (bubble.querySelector(".bubble-more")) return;
        const more = document.createElement("span");
        more.className = "bubble-more";
        more.textContent = "Read the whole message";
        bubble.appendChild(more);
      });
    } else {
      const less = document.createElement("span");
      less.className = "bubble-more";
      less.textContent = "Show less";
      bubble.appendChild(less);
    }

    return row;
  }

  /** The chat's messages plus anything still on its way, oldest first. */
  function chatEntries() {
    const items = (chat && chat.items) || [];
    const isGroup = Boolean(chat && chat.kind === "group");
    const entries = items.map((item) => ({
      relayId: text(item.relayId),
      localId: "",
      mine: item.direction === "outbound",
      author: item.direction === "outbound" ? "You" : text(item.sender && item.sender.name) || "Relay",
      subject: text(item.title),
      body: String(item.forHuman || ""),
      hasAgentDocument: Boolean(text(item.forAgent)),
      preview: text(item.preview),
      at: text(item.createdAt),
      unread: item.direction === "inbound" && item.state === "delivered",
      attachments: item.attachments || [],
      state: "sent",
      isGroup,
      readReceipts: Array.isArray(item.readReceipts) ? item.readReceipts : [],
    }));
    for (const out of outgoing) {
      entries.push({
        relayId: "",
        localId: out.localId,
        mine: true,
        author: "You",
        subject: "",
        body: out.body,
        preview: out.body,
        at: out.at,
        unread: false,
        attachments: out.attachments || [],
        state: out.state,
        error: out.error,
        isGroup,
        readReceipts: [],
      });
    }
    return entries;
  }

  function renderChat() {
    // A room whose history has not arrived can still hold what the person has
    // just written into it. Blanking their own message to say "loading" reads
    // as though sending it lost it.
    if (!chat && !(chatOnly && outgoing.length)) {
      renderChatState("Loading the conversation…", false);
      return;
    }
    // A window opened from a contact card is headed by the name that card
    // carries — what THIS person calls them — over the room's own title.
    chatNameEl.textContent =
      (chatOnly && text(content.chatTitle)) || text(chat && chat.title) || "Conversation";
    chatPeopleEl.textContent = peopleLine();

    const entries = chatEntries();
    if (!entries.length) {
      // Empty because nobody has said anything yet, rather than empty because
      // something failed: the composer below is the answer, so point at it.
      renderChatState(
        chatOnly ? "No messages yet. Write the first one below." : "No messages in this conversation yet.",
        false,
      );
      return;
    }
    chatStateEl.classList.add("gone");

    const fragment = document.createDocumentFragment();
    let previousDay = "";
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const previous = entries[i - 1];
      const next = entries[i + 1];

      const day = dayKey(entry.at);
      if (day && day !== previousDay) {
        const divider = document.createElement("div");
        divider.className = "day-divider";
        divider.textContent = dayLabel(entry.at);
        fragment.appendChild(divider);
        previousDay = day;
      }

      // A run is the same person speaking without a long pause: it gets one
      // name, one timestamp, and one tail.
      const sameRun = (a, b) => {
        if (!a || !b) return false;
        if (a.mine !== b.mine || a.author !== b.author) return false;
        const gap = Math.abs((parseDate(b.at) || 0) - (parseDate(a.at) || 0));
        return Number.isFinite(gap) && gap < RUN_GAP_MS;
      };
      const firstOfRun = !sameRun(previous, entry) || dayKey(previous && previous.at) !== day;
      const lastOfRun = !sameRun(entry, next) || dayKey(next && next.at) !== day;

      fragment.appendChild(
        buildBubble(entry, {
          // Names only in a room with more than two people: labelling every
          // line of a one-to-one is noise.
          showAuthor: entry.isGroup && !entry.mine && firstOfRun,
          firstOfRun,
          lastOfRun,
          receipt: RelayReadReceipts.forLatest(entry, entries, clockLabel),
        }),
      );
    }
    chatListEl.replaceChildren(fragment);
    const renderedUnreadIds = entries
      .filter((entry) => entry.unread && entry.relayId)
      .map((entry) => entry.relayId);
    if (renderedUnreadIds.length && bridge.renderedChat) bridge.renderedChat(renderedUnreadIds);
  }

  // --- Sending ---------------------------------------------------------------

  function retryOutgoing(localId) {
    const entry = outgoing.find((o) => o.localId === localId);
    if (!entry || sending) return;
    outgoing = outgoing.filter((o) => o.localId !== localId);
    renderChat();
    // Same key as the first attempt: if that one actually landed, the server
    // returns the original relay instead of sending a second copy.
    deliver(entry.body, entry.inReplyToRelayId, entry.idempotencyKey, entry.files, entry.attachments);
  }

  /** A key identifying this MESSAGE, stable across every attempt to send it. */
  function newIdempotencyKey() {
    const random = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Math.random()}`;
    return `preview-reply-${random}`;
  }

  async function deliver(body, targetId, idempotencyKey, files = [], attachments = []) {
    const localId = `local-${Date.now()}-${outgoing.length}`;
    const entry = {
      localId,
      relayId: "",
      body,
      at: new Date().toISOString(),
      state: "pending",
      inReplyToRelayId: targetId,
      idempotencyKey: idempotencyKey || newIdempotencyKey(),
      files,
      attachments,
      error: "",
    };
    outgoing.push(entry);
    sending = true;
    refreshComposer();
    setNote("");
    if (face === "chat") {
      renderChat();
      scrollChatToLatest();
    }

    let result;
    try {
      result = await bridge.sendReply(targetId, body, entry.idempotencyKey, entry.files);
    } catch (error) {
      result = { ok: false, error: (error && error.message) || String(error) };
    }
    sending = false;

    if (result && result.ok) {
      entry.state = "sent";
      entry.relayId = text(result.relayId);
      setNote("");
      // The bubble is already on screen and the server now has the message, so
      // settle it immediately. Re-reading the conversation is reconciliation —
      // it puts the reply in server order alongside everyone else's — and
      // awaiting it just to show what is already correct spent another round
      // trip (~1s) with the composer still saying "Sending…".
      if (face === "chat") renderChat();
      loadChat({ keepScroll: true }).catch(() => {});
    } else {
      entry.state = "failed";
      entry.error = text(result && result.error) || "the reply did not send";
      setNote(`Not sent: ${entry.error}`, true);
      if (face === "chat") {
        renderChat();
      } else {
        // On the reading face there are no bubbles, so a failed reply would
        // vanish with the text the person wrote. Give it back to them.
        outgoing = outgoing.filter((o) => o.localId !== entry.localId);
        if (!replyInputEl.value.trim()) {
          replyInputEl.value = body;
          autosizeComposer();
        }
      }
    }
    refreshComposer();
  }

  async function submitReply() {
    if (taskMode) {
      await submitStart();
      return;
    }
    // The session face always talks to the agent. Once a turn settles, Send
    // resumes that same native session; human correspondence stays on Chat.
    if (sessionMode && face !== "chat") {
      await submitSteer();
      return;
    }
    if (sending) return;
    const body = replyInputEl.value.trim();
    const targetId = replyTargetId();
    // With no target and no contact's room, there is nothing this could be
    // addressed to; in a contact's room, main addresses it to that person.
    if ((!body && !stagedReplyFiles.length) || (!targetId && !chatOnly)) return;

    let payload;
    try {
      payload = await replyFilePayloads(stagedReplyFiles);
    } catch (error) {
      setNote(`Could not attach that file: ${(error && error.message) || String(error)}`, true);
      return;
    }

    replyInputEl.value = "";
    stagedReplyFiles = [];
    paintReplyFiles();
    autosizeComposer();
    // Sending from the message face slides you into the conversation, so the
    // reply lands somewhere you can see it — and the room it went to is now
    // the thing on screen.
    if (face !== "chat" && chat) showFace("chat");
    await deliver(body, targetId, newIdempotencyKey(), payload.files, payload.attachments);
    // Sending should not cost the person their place in the composer.
    if (!replyInputEl.disabled) replyInputEl.focus();
  }

  // --- The session face -------------------------------------------------------
  // A started task's transcript, rendered as a calm document: the human's
  // words in the one bubble, the agent's prose flat, and every action folded
  // to a dimmed sentence. Evidence appears only when asked for.

  const TOOL_ICONS = {
    command:
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2.5 4.5 6 8l-3.5 3.5M8.5 11.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    file:
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5l-3-3Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M9.5 1.5v3h3" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
    search:
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.4"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    web:
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.3"/><path d="M2.2 8h11.6M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14C6.2 12.3 5.4 10.3 5.4 8S6.2 3.7 8 2Z" stroke="currentColor" stroke-width="1.1"/></svg>',
    agent:
      '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="4.5" cy="4" r="2" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="12" r="2" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 6v2.5a2 2 0 0 0 2 2h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  };
  const ACT_CHEVRON =
    '<svg class="act-chev" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M3 1.5 7 5 3 8.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function sessionEntries(run) {
    // reasoning_summary/reasoningSummary and commentary remain collapsible;
    // only phase === "final_answer" arrives with placement:"final".
    return RelayWorkUI.normalizeConversationView(run?.presentation || run?.workPresentation || { turns:[] });
  }

  function reconcileSessionChildren(parent, items, update, animateFresh = false) {
    const existing = new Map([...parent.children].map((node) => [node.dataset.sessionSegment, node]));
    let cursor = parent.firstElementChild;
    for (const item of items) {
      let node = existing.get(item.key);
      const fresh = !node;
      if (!node) { node = document.createElement("div"); node.dataset.sessionSegment = item.key; }
      else existing.delete(item.key);
      update(node, item);
      if (fresh && animateFresh) node.dataset.sessionAnimate = "1";
      if (node.dataset.sessionAnimate === "1") node.classList.add("session-fade");
      if (node !== cursor) parent.insertBefore(node, cursor);
      cursor = node.nextElementSibling;
    }
    for (const node of existing.values()) {
      node._workDisclosure?.destroy?.();
      node._semanticDisclosure?.destroy?.();
      node._nativeShimmerCleanup?.();
      if (node._workSummaryKey) sessionSummaryStabilizer.clear(node._workSummaryKey);
      node.remove();
    }
  }

  function updateSessionMarkdown(node, unit, className) {
    node.className = className;
    const source = text(unit?.text);
    if (node.dataset.sessionText === source) return;
    let html = "";
    try { html = bridge.renderMarkdown(source); } catch { html = ""; }
    node.innerHTML = html ? `<div class="markdown" data-markdown-animated="true">${html}</div>` : "";
    if (!html) node.textContent = source;
    node.dataset.sessionText = source;
  }
  function safeSessionImageUrl(value) {
    const url = text(value);
    return /^(?:blob:|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(url) ? url : "";
  }
  function hydrateSessionAttachment(file, attachment, context, attachmentIndex) {
    if (!bridge.runFeedAttachment || file.dataset.loading === "1") return;
    file.dataset.loading = "1";
    bridge.runFeedAttachment({ ...context, attachmentId:text(attachment?.id), attachmentIndex }).then((result) => {
      if (!file.isConnected) return;
      const mimeType = /^image\/(?:png|jpeg|gif|webp)$/i.test(text(result?.mimeType)) ? text(result.mimeType) : "";
      const encoded = mimeType && /^[A-Za-z0-9+/=]+$/.test(text(result?.dataBase64)) ? `data:${mimeType};base64,${result.dataBase64}` : "";
      const src = safeSessionImageUrl(result?.dataUrl || encoded);
      if (!result?.ok || !src) { file.dataset.loading = ""; return; }
      file.className = "session-user-image-wrap";
      const img = document.createElement("img"); img.className = "session-user-image"; img.src = src; img.alt = attachment.name || "Image";
      file.replaceChildren(img); file.dataset.src = src;
    }).catch(() => { if (file.isConnected) file.dataset.loading = ""; });
  }

  function canonicalActivityNode(node, unit) {
    const activity = unit?.activity || {};
    const running = activity.status === "inProgress";
    const verb = running ? activity.activeVerb : activity.doneVerb;
    const label = `${verb || (running ? "Working" : "Worked")}${activity.object ? ` ${activity.object}` : ""}`;
    node.className = `act${running ? " live" : ""}`;
    node._sessionActivityUnit = unit;
    if (node.dataset.sessionText === label) return;
    node.innerHTML = `<button type="button" class="act-head" aria-expanded="${node._sessionDetailOpen ? "true" : "false"}"><span class="act-ic">${TOOL_ICONS[activity.kind === "edit" ? "file" : activity.kind === "web" ? "web" : activity.kind === "subagent" ? "agent" : activity.kind === "command" ? "command" : "search"] || TOOL_ICONS.command}</span><span class="act-sum">${escapeHtml(label)}</span></button>`;
    if (!node._sessionDetailBound && bridge.runFeedDetail) {
      node.addEventListener("click", async () => {
        if (node._sessionDetailOpen) {
          node._sessionDetailOpen = false; node.querySelector(".act-head")?.setAttribute("aria-expanded", "false");
          node._sessionDetailHost?.remove(); node._sessionDetailHost = null; return;
        }
        const generation = (node._sessionDetailGeneration || 0) + 1;
        node._sessionDetailGeneration = generation;
        const result = await bridge.runFeedDetail({ relayId:text(content.relayId), sessionId:sessionCurrentSessionId,
          turnId:node.closest(".session-turn")?.dataset.workAnchor || "", itemId:node._sessionActivityUnit?.id || "" }).catch(() => null);
        if (!node.isConnected || node._sessionDetailGeneration !== generation || !result?.ok) return;
        const host = document.createElement("pre"); host.className = "session-unit-detail";
        host.textContent = typeof result.detail === "string" ? result.detail : JSON.stringify(result.detail || {}, null, 2);
        node.append(host); node._sessionDetailHost = host; node._sessionDetailOpen = true;
        node.querySelector(".act-head")?.setAttribute("aria-expanded", "true");
      });
      node._sessionDetailBound = true;
    }
    node.dataset.sessionText = label;
  }

  function nativeSessionShimmerMarkup(label) {
    const value = escapeHtml(label);
    return `<span class="native-cadenced-shimmer" data-native-cadenced-shimmer>${value}<span aria-hidden="true" class="native-cadenced-shimmer-sweep"><span class="native-cadenced-shimmer-highlight">${value}</span></span></span>`;
  }

  function bindSessionNativeShimmer(node, active) {
    node._nativeShimmerCleanup?.();
    node._nativeShimmerCleanup = null;
    const shimmer = node.querySelector?.("[data-native-cadenced-shimmer]");
    if (!active || !shimmer || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timers = new Set();
    const later = (fn, delay) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, delay); timers.add(timer); };
    const sweep = () => { shimmer.classList.remove("active"); void shimmer.offsetWidth; shimmer.classList.add("active"); later(() => shimmer.classList.remove("active"), 1000); };
    let cadenceTimer = 0;
    const cadence = () => { sweep(); cadenceTimer = setTimeout(cadence, 4000); };
    later(cadence, 600);
    node._nativeShimmerCleanup = () => { for (const timer of timers) clearTimeout(timer); clearTimeout(cadenceTimer); shimmer.classList.remove("active"); };
  }

  function updateSessionSemanticGroup(node, unit) {
    const active = unit.active === true || (unit.items || []).some((entry) => entry?.activity?.status === "inProgress");
    const label = unit.activeSummary || unit.summary || (active ? "Working" : "Worked");
    node.className = "session-activity session-semantic-group";
    if (!node._sessionInner) {
      const toggle = document.createElement("button");
      toggle.type = "button"; toggle.className = "session-activity-toggle";
      toggle.setAttribute("data-work-disclosure-toggle", "");
      const body = document.createElement("div"); body.className = "session-activity-body";
      body.setAttribute("data-work-disclosure-body", "");
      const inner = document.createElement("div"); body.append(inner);
      node.append(toggle, body); node._sessionToggle = toggle; node._sessionInner = inner;
      node._semanticDisclosure = RelayWorkUI.createDisclosureController(node, { initiallyExpanded:false });
    }
    if (node.dataset.semanticLabel !== `${active}:${label}`) {
      node._nativeShimmerCleanup?.();
      node._sessionToggle.innerHTML = `<span role="status" aria-live="polite">${active ? nativeSessionShimmerMarkup(label) : escapeHtml(label)}</span>${ACT_CHEVRON}`;
      node.dataset.semanticLabel = `${active}:${label}`;
      bindSessionNativeShimmer(node, active);
    }
    node._sessionToggle.setAttribute("aria-label", `${label}. ${(unit.items || []).length} activities.`);
    reconcileSessionChildren(node._sessionInner, (unit.items || []).map((entry, index) => ({ ...entry, key:String(entry.id || index) })), updateSessionUnit, true);
  }

  function updateSessionUnit(node, unit) {
    if (unit.type === "activity") return canonicalActivityNode(node, unit);
    if (unit.type === "exploration" || unit.type === "activityGroup") {
      return updateSessionSemanticGroup(node, unit);
    }
    if (unit.type === "request") {
      node.className = "session-request"; node.setAttribute("role", "status"); node.setAttribute("aria-live", "polite");
      node.textContent = unit.text || "Input required"; return;
    }
    if (unit.type === "error") {
      node.className = "session-error"; node.setAttribute("role", "alert");
      node.textContent = unit.text || "The run hit an error"; return;
    }
    if (unit.type === "retry") {
      node.className = "turn-marker"; node.setAttribute("role", "status"); node.setAttribute("aria-live", "polite");
      node.textContent = unit.text || "Reconnecting"; return;
    }
    updateSessionMarkdown(node, unit, "agent-prose");
  }

  function updateSessionDisclosure(node, item) {
    node.className = "session-activity";
    const sessionActivityOpenForTurn = `${item.turnId}:${item.segment}`;
    node._workSummaryKey = sessionActivityOpenForTurn;
    if (!node._sessionInner) {
      const toggle = document.createElement("button");
      toggle.type = "button"; toggle.className = "session-activity-toggle";
      toggle.setAttribute("data-work-disclosure-toggle", "");
      toggle.innerHTML = `<span data-work-summary></span>${ACT_CHEVRON}`;
      const body = document.createElement("div"); body.className = "session-activity-body";
      body.setAttribute("data-work-disclosure-body", "");
      const inner = document.createElement("div"); body.append(inner);
      node.append(toggle, body); node._sessionInner = inner;
      node.dataset.workDisclosure = sessionActivityOpenForTurn;
      node._workDisclosure = RelayWorkUI.createDisclosureController(node, {
        initiallyExpanded:actOpen.has(sessionActivityOpenForTurn),
        onStateChange:(state) => {
          if (state === "opening" || state === "expanded") actOpen.add(sessionActivityOpenForTurn);
          else actOpen.delete(sessionActivityOpenForTurn);
        },
      });
    }
    const summary = node.querySelector("[data-work-summary]");
    sessionSummaryStabilizer.offer(sessionActivityOpenForTurn, item.label, (value) => { summary.textContent = value; });
    node.querySelector("[data-work-disclosure-toggle]").setAttribute("aria-label", `${item.label}. ${item.units.length} previous messages.`);
    reconcileSessionChildren(node._sessionInner, item.units.map((unit) => ({ ...unit, key:String(unit.id) })), updateSessionUnit, true);
  }

  function renderSession(records, run = {}) {
    const presentation = sessionEntries(run);
    const snapshot = sessionScrollController?.capture();
    const turnUnits = presentation.turns.map((turn) => {
      return { key:turn.turnId, turnId:turn.turnId, status:turn.status, blocks:RelayWorkUI.partitionTurn(turn) };
    });
    reconcileSessionChildren(sessionListEl, turnUnits, (turnNode, turn) => {
      turnNode.className = "session-turn"; turnNode.dataset.workAnchor = turn.turnId;
      reconcileSessionChildren(turnNode, turn.blocks, (node, block) => {
        if (block.type === "activity") return updateSessionDisclosure(node, block);
        if (block.type === "user") {
          node.className = "session-user-wrap";
          node._sessionUserText = block.unit.text || "";
          if (!node._sessionUser) {
            const files = document.createElement("div"); files.className = "session-user-files";
            const bubble = document.createElement("div"); bubble.className = "user-msg"; bubble.tabIndex = 0;
            bubble.setAttribute("role", "group"); bubble.setAttribute("aria-label", "Your message");
            const actions = document.createElement("div"); actions.className = "session-user-actions";
            actions.innerHTML = `<button type="button" aria-label="Copy message">Copy</button><button type="button" aria-label="Edit message">Edit</button>`;
            actions.addEventListener("click", (event) => {
              const action = event.target.closest("button[aria-label]");
              if (!action) return;
              if (action.getAttribute("aria-label") === "Copy message") navigator.clipboard?.writeText(node._sessionUserText || "");
              if (action.getAttribute("aria-label") === "Edit message") {
                replyInputEl.value = node._sessionUserText || ""; autosizeComposer(); refreshComposer(); replyInputEl.focus();
              }
            });
            bubble.addEventListener("dblclick", () => actions.querySelector('[aria-label="Edit message"]')?.click());
            node.append(files, bubble, actions); node._sessionFiles = files; node._sessionUser = bubble;
          }
          reconcileSessionChildren(node._sessionFiles, (block.unit.attachments || []).map((attachment, index) => ({ ...attachment, attachmentIndex:index, key:String(attachment.id || attachment.name || index) })), (file, attachment) => {
            const image = attachment.image || attachment.kind === "image" || /^image\//i.test(text(attachment.mimeType));
            const previewUrl = safeSessionImageUrl(attachment.previewUrl || attachment.url);
            if (image && previewUrl) {
              file.className = "session-user-image-wrap";
              if (file.dataset.src !== previewUrl) {
                file.innerHTML = `<img class="session-user-image" src="${escapeHtml(previewUrl)}" alt="${escapeHtml(attachment.name || "Image")}">`;
                file.dataset.src = previewUrl;
              }
            } else {
              file.className = "session-user-file"; file.textContent = attachment.name || "Attachment";
              if (image) hydrateSessionAttachment(file, attachment, { relayId:text(content.relayId), sessionId:sessionCurrentSessionId, turnId:turn.turnId || turn.key, itemId:block.unit.id }, attachment.attachmentIndex);
            }
          });
          updateSessionMarkdown(node._sessionUser, block.unit, "user-msg"); return;
        }
        if (block.type === "divider") { node.className = "session-divider"; node.replaceChildren(); return; }
        if (block.type === "final") { updateSessionMarkdown(node, block.unit, "session-final"); return; }
        updateSessionUnit(node, block.unit);
      }, true);
    });
    sessionStateEl.classList.toggle("gone", turnUnits.length > 0);
    if (!turnUnits.length) sessionStateEl.textContent = "No native run output was captured.";
    requestAnimationFrame(() => sessionScrollController?.contentChanged(snapshot));
  }

  function acceptSessionResult(result) {
    if (!sessionMode) return;
    if (!result || (result.ok === false && !result.presentation)) {
      sessionLive = { provider: "", liveState: "", error: text(result && result.error) };
      // A live-stream failure must remain visible even when a previously
      // hydrated transcript is still readable below it.
      sessionStateEl.textContent = sessionLive.error || "The session is not readable yet.";
      sessionStateEl.classList.remove("gone");
      return;
    }
    const revision = Number(result.revision) || 0;
    // Once a native revisioned feed owns this surface, an older compatibility
    // response must never erase it. Legacy session reads have no revision.
    if (!revision && sessionRevision > 0) return;
    if (revision && revision <= sessionRevision) return;
    if (revision) sessionRevision = revision;
    sessionCurrentSessionId = text(result.sessionId || result.presentation?.sessionId);
    const latestTurn = result.presentation?.turns?.at(-1) || null;
    const nativeState = latestTurn?.active ? "active" : latestTurn?.status || result.liveState;
    sessionLive = { provider:result.provider || result.presentation?.provider || "", liveState:text(nativeState), error:"" };
    // Receipts ride the poll — the Done flip lands here, not on a reopen.
    if (text(result.taskStartedAt)) content.taskStartedAt = text(result.taskStartedAt);
    if (text(result.taskCompletedAt) && !text(content.taskCompletedAt)) {
      content.taskCompletedAt = text(result.taskCompletedAt);
      renderTaskMeta();
    }
    const fingerprint = `${text(result.relayId)}|${text(result.sessionId)}|${Number(result.revision) || 0}`;
    if (fingerprint === sessionFingerprint && sessionListEl.childElementCount) return;
    sessionFingerprint = fingerprint;
    renderSession(result.records || [], result);
    refreshComposer();
  }

  async function pollSession() {
    if (!sessionMode) return;
    let result;
    try { result = await bridge.loadSession(text(content.relayId)); }
    catch (error) { result = { ok:false, error:(error && error.message) || String(error) }; }
    acceptSessionResult(result);
  }

  const disposeNativeRunUpdates = bridge.onRunFeedUpdate?.((envelope) => {
    const id = text(envelope?.relayId);
    if (sessionMode && id === text(content.relayId)) acceptSessionResult(envelope);
  });
  const disposeSessionUpdates = bridge.onSessionUpdate?.((id, result) => {
    if (sessionMode && id === text(content.relayId)) acceptSessionResult(result);
  });

  function setSessionMode(next) {
    const watchEpoch = ++sessionWatchEpoch;
    sessionMode = Boolean(next);
    detailScrollEl.classList.toggle("gone", sessionMode);
    sessionScrollEl.classList.toggle("gone", !sessionMode);
    if (sessionWatching && sessionWatchedRelayId) {
      if (bridge.unwatchRunFeed) bridge.unwatchRunFeed(sessionWatchedRelayId);
      else bridge.unwatchSession?.(sessionWatchedRelayId);
    }
    sessionWatching = false;
    sessionWatchedRelayId = "";
    sessionScrollController?.destroy();
    sessionScrollController = sessionMode ? RelayWorkUI.createScrollController(sessionScrollEl, sessionFooterEl, {
      bottomTolerance:24,
      preservePositionForNextLayout:true,
      onFollowChange:(following) => sessionScrollEl.toggleAttribute("data-work-detached", !following),
    }) : null;
    if (sessionMode) {
      const watchedRelayId = text(content.relayId);
      sessionFingerprint = "";
      sessionRevision = 0;
      actOpen.clear();
      sessionStateEl.textContent = "Reading the session…";
      sessionStateEl.classList.remove("gone");
      const subscribeNativeRun = bridge.watchRunFeed || bridge.watchSession;
      // A watch invocation is both hydration and subscription. Running the
      // legacy history read beside it creates two owners and permits a slow,
      // revisionless response to overwrite a newer native snapshot.
      if (!subscribeNativeRun) pollSession().catch(() => {});
      Promise.resolve(subscribeNativeRun?.(watchedRelayId)).then((result) => {
        if (watchEpoch !== sessionWatchEpoch || !sessionMode || watchedRelayId !== text(content.relayId)) {
          if (bridge.unwatchRunFeed) bridge.unwatchRunFeed(watchedRelayId); else bridge.unwatchSession?.(watchedRelayId);
          return;
        }
        if (result?.ok === false || !result?.presentation) {
          if (bridge.unwatchRunFeed) bridge.unwatchRunFeed(watchedRelayId); else bridge.unwatchSession?.(watchedRelayId);
          acceptSessionResult({ ok:false, error:result?.error || "The live event stream is unavailable." });
          return;
        }
        acceptSessionResult(result);
        sessionWatching = Boolean(subscribeNativeRun);
        sessionWatchedRelayId = sessionWatching ? watchedRelayId : "";
      }).catch((error) => {
        if (watchEpoch !== sessionWatchEpoch || !sessionMode || watchedRelayId !== text(content.relayId)) return;
        acceptSessionResult({ ok:false, error:(error && error.message) || String(error) });
      });
    }
  }

  window.addEventListener("beforeunload", () => {
    if (sessionWatching && sessionWatchedRelayId) {
      if (bridge.unwatchRunFeed) bridge.unwatchRunFeed(sessionWatchedRelayId); else bridge.unwatchSession?.(sessionWatchedRelayId);
    }
    sessionScrollController?.destroy();
    if (typeof disposeSessionUpdates === "function") disposeSessionUpdates();
    if (typeof disposeNativeRunUpdates === "function") disposeNativeRunUpdates();
  }, { once:true });

  async function submitSteer() {
    if (sending) return;
    const body = replyInputEl.value.trim();
    const id = text(content.relayId);
    if (!body || !id) return;
    const newTurn = sessionSettled();
    sending = true;
    refreshComposer();
    let result;
    try {
      result = await bridge.steer(id, body, newTurn);
    } catch (error) {
      result = { ok: false, error: (error && error.message) || String(error) };
    }
    sending = false;
    if (result && result.ok) {
      if (newTurn) {
        content.taskCompletedAt = "";
        sessionFingerprint = "";
        actOpen.clear();
      }
      replyInputEl.value = "";
      autosizeComposer();
      setNote("Steered — it lands in the current turn without interrupting it.");
      if (!sessionWatching) pollSession().catch(() => {});
    } else {
      setNote(text(result && result.error) || "The steer did not send.", true);
    }
    refreshComposer();
  }

  // --- The message face -------------------------------------------------------

  async function renderContent(next) {
    const currentRevision = ++renderRevision;
    const row = next && typeof next === "object" ? next : {};
    content = row;
    // A room with no message behind it: opened from a contact card, so it is
    // the conversation itself rather than a message that has one.
    chatOnly = Boolean(text(row.chatId)) && !text(row.relayId);
    const id = text(row.relayId);
    const markdown = markdownFor(row);
    const title = titleFor(row, markdown);
    const when = dateFor(row);

    // Paint the high-level message before doing any Markdown work so it is
    // always the first and most prominent user-facing content in the panel.
    titleEl.textContent = title;
    document.title = `${title} — Relay preview`;
    senderEl.textContent = senderFor(row);
    timeEl.textContent = when.label;
    metaDotEl.classList.toggle("gone", !when.label);
    if (when.iso) timeEl.dateTime = when.iso;
    else timeEl.removeAttribute("datetime");
    metaEl.classList.toggle("gone", !senderEl.textContent && !when.label);
    detailScrollEl.scrollTop = 0;
    bodyEl.replaceChildren();
    errorEl.classList.add("gone");
    errorEl.textContent = "";
    emptyEl.textContent = markdown ? "Rendering details…" : "No additional detail was included with this relay.";
    emptyEl.classList.remove("gone");
    replyInputEl.value = "";
    stagedReplyFiles = [];
    paintReplyFiles();
    autosizeComposer();

    // A different message means a different conversation until proven otherwise.
    chat = null;
    outgoing = [];
    expanded.clear();
    landed = false;
    chatRevision += 1;
    updateChip();

    if (chatOnly) {
      // One room and nothing else: no reading face, no task, no back button.
      // Named from the card that opened it so the window is right on its first
      // frame, then filled in from the server.
      const who = text(row.chatTitle) || "Conversation";
      document.title = `${who} — Relay`;
      chatNameEl.textContent = who;
      chatPeopleEl.textContent = "";
      chatBackEl.classList.add("gone");
      taskMode = false;
      starting = false;
      setSessionMode(false);
      renderTaskMeta();
      showFace("chat", { force: true });
      setNote("");
      refreshComposer();
      await loadChat();
      return;
    }
    chatBackEl.classList.remove("gone");
    // A new message opens on the face its own content earns, whichever face the
    // reader left the last one on: a chat message opens IN its conversation —
    // there is nothing on the reading face the conversation does not already
    // show — and everything else opens on the message itself. main decides;
    // see message-face.cjs.
    const opensInChat = text(row.openFace) === "chat" && Boolean(text(row.threadId));
    if (opensInChat) chatNameEl.textContent = chatTitleHint(row) || "Conversation";
    // The task face: the reading surface wearing the Start composer until the
    // task has been started; after that it is an ordinary conversation whose
    // meta line carries the receipt.
    starting = false;
    taskMode = text(row.openFace) === "task" && !text(row.taskStartedAt);
    if (taskMode && rtCodexItemEl) {
      const codexAvailable = Boolean(row.runtimes && row.runtimes.codex);
      rtCodexItemEl.disabled = !codexAvailable;
      if (!codexAvailable && runtime.host === "codex") runtime.host = "claude";
      renderRuntimeWords();
    }
    renderTaskMeta();
    setSessionMode(text(row.openFace) === "task" && Boolean(text(row.taskStartedAt)));
    showFace(opensInChat ? "chat" : "message", { force: true });
    setNote("");
    refreshComposer();

    if (row.error) {
      setError(row.error);
      return;
    }

    try {
      const safeHtml = markdown ? await Promise.resolve(bridge.renderMarkdown(markdown)) : "";
      if (currentRevision !== renderRevision) return;
      if (safeHtml) {
        // renderMarkdown runs in the isolated preload and returns allowlisted,
        // DOMPurify-sanitized HTML. No other value is assigned through innerHTML.
        bodyEl.innerHTML = safeHtml;
        emptyEl.classList.add("gone");
      } else {
        emptyEl.textContent = "No additional detail was included with this relay.";
        emptyEl.classList.remove("gone");
      }
      if (id) bridge.rendered(id);
    } catch (error) {
      if (currentRevision !== renderRevision) return;
      setError(error && error.message ? error.message : "This relay could not be rendered.");
    }

    // The conversation loads after the message is on screen: reading never
    // waits on the network, and the chip appears when there is one to show.
    loadChat().catch(() => {});
  }

  if (!bridge) {
    setError("The Relay preview bridge did not load.");
    minimizeButtonEl.disabled = true;
    closeButtonEl.disabled = true;
    replyInputEl.disabled = true;
    replyButtonEl.disabled = true;
    setNote("The Relay preview bridge did not load.", true);
    return;
  }

  detailScrollEl.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!target || !detailScrollEl.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    bridge.openExternal(target.getAttribute("href"));
  });

  // Links inside bubbles leave through the same audited path as the reader's.
  chatScrollEl.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
    if (!target || !chatScrollEl.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();
    bridge.openExternal(target.getAttribute("href"));
  });

  minimizeButtonEl.addEventListener("click", () => bridge.minimize());
  closeButtonEl.addEventListener("click", () => bridge.close());
  chatChipEl.addEventListener("click", () => showFace("chat"));
  chatBackEl.addEventListener("click", () => showFace("message"));

  // The runtime tray: quiet words that open a small menu. Selection re-renders
  // the words; nothing is applied until Start.
  if (runtimeBtnEl && runtimePopEl) {
    runtimeBtnEl.addEventListener("click", (event) => {
      event.stopPropagation();
      const open = runtimePopEl.classList.toggle("open");
      runtimeBtnEl.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("click", (event) => {
      if (!runtimePopEl.contains(event.target) && event.target !== runtimeBtnEl) {
        runtimePopEl.classList.remove("open");
        runtimeBtnEl.setAttribute("aria-expanded", "false");
      }
    });
    runtimePopEl.addEventListener("click", (event) => {
      const item = event.target instanceof Element ? event.target.closest(".rt-item") : null;
      if (!item || item.disabled) return;
      event.stopPropagation();
      const key = item.dataset.rtHost ? "host" : item.dataset.rtModel ? "model" : item.dataset.rtEffort ? "effort" : "";
      if (!key) return;
      const dataKey = key === "host" ? "rtHost" : key === "model" ? "rtModel" : "rtEffort";
      for (const sibling of runtimePopEl.querySelectorAll(".rt-item")) {
        if (sibling.dataset[dataKey] !== undefined) sibling.classList.toggle("on", sibling === item);
      }
      runtime[key] = item.dataset[dataKey];
      renderRuntimeWords();
    });
  }
  replyButtonEl.addEventListener("click", () => {
    submitReply().catch(() => {});
  });
  safetyButtonEl.addEventListener("click", () => {
    reviewSafety().catch(() => {});
  });

  replyAttachButtonEl.addEventListener("click", () => replyFilePickerEl.click());
  replyFilePickerEl.addEventListener("change", () => {
    stageReplyFiles(replyFilePickerEl.files);
    replyFilePickerEl.value = "";
  });

  replyInputEl.addEventListener("input", () => {
    autosizeComposer();
    refreshComposer();
  });

  replyInputEl.addEventListener("paste", (event) => {
    const files = clipboardFiles(event);
    if (!files.length) return;
    event.preventDefault();
    stageReplyFiles(files);
  });

  replyInputEl.addEventListener("dragover", (event) => {
    if (event.dataTransfer && [...(event.dataTransfer.types || [])].includes("Files")) event.preventDefault();
  });

  replyInputEl.addEventListener("drop", (event) => {
    const files = [...(event.dataTransfer?.files || [])].filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    stageReplyFiles(files);
  });

  replyInputEl.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    submitReply().catch(() => {});
  });

  window.addEventListener("keydown", (event) => {
    const key = String(event.key || "").toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === "w") {
      event.preventDefault();
      bridge.close();
      return;
    }
    if (key === "escape") {
      event.preventDefault();
      // Escape backs out one level at a time: out of the conversation first,
      // then out of the window. A contact's room has no level under it, so
      // Escape leaves.
      if (face === "chat" && !chatOnly) showFace("message");
      else bridge.close();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && key === "m") {
      event.preventDefault();
      bridge.minimize();
    }
  });

  // New mail while a conversation is open: re-read it so the message appears
  // where the person is already looking. Skipped while a send is in flight —
  // that reload is already queued and would only race it.
  if (bridge.onMail) {
    bridge.onMail(() => {
      if (sending || (!text(content.threadId) && !chatOnly)) return;
      loadChat({ keepScroll: true }).catch(() => {});
    });
  }

  refreshComposer();
  const applyTheme = (value) => {
    if (value === "dark") document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
  };
  if (bridge.onTheme) bridge.onTheme(applyTheme);
  bridge.onContent((payload) => {
    if (payload && payload.uiTheme) applyTheme(payload.uiTheme);
    renderContent(payload);
  });
  // Register content and control listeners before announcing readiness so the
  // main process can never send the first payload into a listener gap.
  bridge.ready();
})();
