const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("relay", {
  // Sandboxed harness overlays share the user's screen and speakers. The
  // renderer needs to know it is one so it can stay silent.
  isTestOverlay: process.env.RELAY_OVERLAY_TEST === "1" || process.env.RELAY_OVERLAY_PERF === "1",
  // streams from main -> renderer
  onInbox: (cb) => ipcRenderer.on("inbox", (_e, payload) => cb(payload)),
  onNewRelay: (cb) => ipcRenderer.on("newRelay", (_e, relay, opts) => cb(relay, opts || {})),
  onOpenDone: (cb) => ipcRenderer.on("openDone", (_e, id) => cb(id)),
  // "Open in current chat" staged an injection: the UI confirms it so the
  // click has visible feedback (delivery is checkpoint-based, not instant).
  onInjected: (cb) => ipcRenderer.on("injected", (_e, id, info) => cb(id, info || {})),
  // The staged injection was actually CONSUMED by the target session — flip the
  // waiting note to a delivered one (main watches the consume-once file).
  onInjectionDelivered: (cb) => ipcRenderer.on("injectionDelivered", (_e, id) => cb(id)),
  // The current chat stayed idle through the grace window; the injection was
  // reclaimed and the relay is opening in a fresh chat instead.
  onInjectionAutoFresh: (cb) => ipcRenderer.on("injectionAutoFresh", (_e, id) => cb(id)),
  // The open failed (CLI error / helper wouldn't spawn). The row stays unread, so
  // say why inline instead of letting the spinner just stop.
  onOpenError: (cb) => ipcRenderer.on("openError", (_e, id, message) => cb(id, message || "")),
  onOpenFull: (cb) => ipcRenderer.on("openFull", () => cb()), // status-area icon clicked
  onOpenRelay: (cb) => ipcRenderer.on("relay:openReader", (_e, input) => cb(input || {})),
  onShown: (cb) => ipcRenderer.on("shown", () => cb()),

  // pull the full payload on demand
  refresh: () => ipcRenderer.invoke("relay:get"),

  // Relay rows
  open: (id, host) => ipcRenderer.send("relay:open", id, host),
  openSent: (id, host) => ipcRenderer.send("relay:openSent", id, host),
  sessionPicker: (id, provider, source, surface) => ipcRenderer.invoke("relay:sessionPicker", id, provider, source, surface),
  deliverToSession: (id, selection) => ipcRenderer.invoke("relay:deliverToSession", id, selection),
  continueSession: (id, source) => ipcRenderer.invoke("relay:continueSession", id, source),
  // Sent rows get the same open-actions menu as received relays.
  openSentInCurrent: (id, host) => ipcRenderer.send("relay:openSentInCurrent", id, host),
  openSentFresh: (id, host) => ipcRenderer.send("relay:openSentFresh", id, host),
  // expand-card actions: inject into the live Claude session / force a fresh one
  preview: (id) => ipcRenderer.send("relay:preview", id),
  openInCurrent: (id, host) => ipcRenderer.send("relay:openInCurrent", id, host),
  openFresh: (id, host, note) => ipcRenderer.send("relay:openFresh", id, host, note),
  openRunSession: (id) => ipcRenderer.invoke("relay:openRunSession", String(id || "")),
  // The pill tray's Start task: the full start flow with the default runtime.
  taskStart: (id, route) => ipcRenderer.invoke("relay:taskStart", String(id || ""), route || null),
  taskClaim: (id, expectedVersion) => ipcRenderer.invoke("relay:taskClaim", String(id || ""), expectedVersion),
  taskUnclaim: (id, expectedVersion) => ipcRenderer.invoke("relay:taskUnclaim", String(id || ""), expectedVersion),
  taskStop: (id) => ipcRenderer.invoke("relay:taskStop", String(id || "")),
  todoList: (input = {}) => ipcRenderer.invoke("relay:todoList", input || {}),
  todoStatusUpdate: (id, input = {}) => ipcRenderer.invoke(
    "relay:todoStatusUpdate",
    String(id || ""),
    input || {},
  ),
  todoItem: (id) => ipcRenderer.invoke("relay:todoItem", String(id || "")),
  // The Todo steward runs in the daemon; the pill only records the person's
  // preference. Its results arrive as ordinary Todo data on the next push.
  todoStewardPrefs: (input = {}) => ipcRenderer.invoke("relay:todoStewardPrefs", input || {}),
  requestReviewSafety: (id) => ipcRenderer.invoke("relay:requestReviewSafety", String(id || "")),
  requestCompletionSend: (id) => ipcRenderer.invoke("relay:requestCompletionSend", String(id || "")),
  relayWorkStart: (id, route) => ipcRenderer.invoke("relay:relayWorkStart", String(id || ""), route || null),
  chatAgentWorkStop: (id) => ipcRenderer.invoke("relay:chatAgentWorkStop", String(id || "")),
  chatAgentWorkRetry: (id) => ipcRenderer.invoke("relay:chatAgentWorkRetry", String(id || "")),
  runFeed: (id) => ipcRenderer.invoke("relay:runFeed", String(id || "")),
  watchRunFeed: (id) => ipcRenderer.invoke("relay:runFeed:watch", String(id || "")),
  unwatchRunFeed: (id) => ipcRenderer.send("relay:runFeed:unwatch", String(id || "")),
  onRunFeedUpdate: (cb) => {
    const listener = (_event, envelope) => cb(envelope);
    ipcRenderer.on("relay:runFeed:update", listener);
    return () => ipcRenderer.removeListener("relay:runFeed:update", listener);
  },
  runFeedDetail: (input) => ipcRenderer.invoke("relay:runFeed:detail", {
    relayId:String(input?.relayId || ""), sessionId:String(input?.sessionId || ""),
    turnId:String(input?.turnId || ""), itemId:String(input?.itemId || ""), attachmentId:String(input?.attachmentId || ""),
  }),
  runFeedAttachment: (input) => ipcRenderer.invoke("relay:runFeed:attachment", {
    relayId:String(input?.relayId || ""), sessionId:String(input?.sessionId || ""),
    turnId:String(input?.turnId || ""), itemId:String(input?.itemId || ""),
    attachmentId:String(input?.attachmentId || ""),
    attachmentIndex:Number.isInteger(input?.attachmentIndex) ? input.attachmentIndex : -1,
  }),
  runSteer: (relayId, body, options = {}) => ipcRenderer.invoke("relay:runSteer", {
    relayId: String(relayId || ""),
    body: String(body || ""),
    newTurn: options && options.newTurn === true,
    model: String(options && options.model || ""),
    effort: String(options && options.effort || ""),
    clientMessageId: String(options && options.clientMessageId || ""),
    files: Array.isArray(options && options.files) ? options.files : [],
  }),
  schedules: () => ipcRenderer.invoke("relay:schedules"),
  scheduleSave: (input) => ipcRenderer.invoke("relay:scheduleSave", input || {}),
  ack: (id) => ipcRenderer.send("relay:ack", id),
  ackMany: (ids) => ipcRenderer.invoke("relay:ackMany", Array.isArray(ids) ? ids : []),
  chatReadActivity: () => ipcRenderer.send("relay:chatReadActivity"),
  // A REAL send: {text, inReplyToRelayId?, recipient?, files:[{path}|{name,contentBase64,contentType}]}
  // Answers as soon as the message is committed to this device's outbox, not
  // when the server has it — the composer never waits on the network.
  sendReply: (payload) => ipcRenderer.invoke("relay:sendReply", payload),
  // Deliberate acts on a message the server refused: send it again, or bin it.
  outboxRetry: (id) => ipcRenderer.invoke("relay:outboxRetry", id),
  outboxDiscard: (id) => ipcRenderer.invoke("relay:outboxDiscard", id),
  // `window.online` is the only connectivity signal either process actually
  // has; the renderer forwards it so a regained network flushes the queue at
  // once instead of waiting out the last failure's backoff.
  networkOnline: () => ipcRenderer.invoke("relay:networkOnline"),
  react: (id, emoji, action) => ipcRenderer.invoke("relay:react", { id, emoji, action }),
  editMessage: (id, forHuman, expectedUpdatedAt) => ipcRenderer.invoke("relay:messageEdit", {
    id: String(id || ""),
    forHuman: String(forHuman || ""),
    expectedUpdatedAt: String(expectedUpdatedAt || ""),
  }),
  deleteMessage: (id, expectedUpdatedAt) => ipcRenderer.invoke("relay:messageDelete", {
    id: String(id || ""),
    expectedUpdatedAt: String(expectedUpdatedAt || ""),
  }),
  // Electron>=32 removed File.path — the preload's webUtils is the only way
  // a renderer file picker/drop can yield a real path for the send pipeline.
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ""; } catch { return ""; } },
  deleteRelay: (id) => ipcRenderer.invoke("relay:delete", id),
  markAllRead: () => ipcRenderer.invoke("relay:markAllRead"),
  openUrl: (url) => ipcRenderer.send("relay:openUrl", url),
  // Attachment chip click: main resolves the local copy (or downloads it) and
  // opens it; the renderer never sees paths or URLs. Returns { ok, error? }.
  openAttachment: (relayId, attachmentId) => ipcRenderer.invoke("relay:openAttachment", relayId, attachmentId),
  // Image plates use the same canonical attachment lookup, but receive only
  // bounded, signature-checked image bytes. Paths and signed URLs stay in main.
  previewAttachment: (relayId, attachmentId) => ipcRenderer.invoke(
    "relay:previewAttachment",
    String(relayId || ""),
    String(attachmentId || ""),
  ),
  // A click no longer hands the file to the OS: it opens a Relay viewer window.
  // The third argument is the room's own manifest (ids + display strings only)
  // so the viewer's filmstrip can be "every image in this chat"; main validates
  // every field and resolves the bytes itself.
  openAttachmentViewer: (relayId, attachmentId, context = {}) => ipcRenderer.invoke(
    "relay:openAttachmentViewer",
    String(relayId || ""),
    String(attachmentId || ""),
    {
      chatKey: String(context?.chatKey || ""),
      chatTitle: String(context?.chatTitle || ""),
      items: Array.isArray(context?.items) ? context.items : [],
    },
  ),
  // Save one item or a whole selection into ~/Downloads/Relay/<chat>/.
  downloadAttachments: (items, options = {}) => ipcRenderer.invoke(
    "relay:downloadAttachments",
    Array.isArray(items) ? items.map((item) => ({
      relayId: String(item?.relayId || ""),
      attachmentId: String(item?.attachmentId || ""),
    })) : [],
    { chatTitle: String(options?.chatTitle || "") },
  ),
  // Per-item progress for the bubble meta — never a modal.
  onAttachmentDownloadProgress: (cb) => {
    const listener = (_event, payload) => cb(payload || {});
    ipcRenderer.on("relay:attachmentDownload", listener);
    return () => ipcRenderer.removeListener("relay:attachmentDownload", listener);
  },
  revealAttachment: (relayId, attachmentId) => ipcRenderer.invoke(
    "relay:revealAttachment",
    String(relayId || ""),
    String(attachmentId || ""),
  ),
  copyAttachmentImage: (relayId, attachmentId) => ipcRenderer.invoke(
    "relay:copyAttachmentImage",
    String(relayId || ""),
    String(attachmentId || ""),
  ),
  refreshSent: () => ipcRenderer.invoke("relay:refreshSent"),

  // task mutations (return { ok, error?, conflict? })
  accept: (taskId, participantId) => ipcRenderer.invoke("relay:accept", taskId, participantId),
  reject: (taskId, participantId) => ipcRenderer.invoke("relay:reject", taskId, participantId),
  approve: (taskId, approvalId) => ipcRenderer.invoke("relay:approve", taskId, approvalId),
  decline: (taskId, approvalId) => ipcRenderer.invoke("relay:decline", taskId, approvalId),

  // tasks view
  refreshTasks: () => ipcRenderer.invoke("relay:refreshTasks"),
  openTask: (taskId) => ipcRenderer.send("relay:openTask", taskId),
  taskStatus: (taskId) => ipcRenderer.invoke("relay:taskStatus", taskId),

  // contacts
  capabilities: () => ipcRenderer.invoke("relay:capabilities"),
  contacts: () => ipcRenderer.invoke("relay:contacts"),
  contactsSearch: (q) => ipcRenderer.invoke("relay:contactsSearch", q),
  // Resolve a contact's canonical conversation for the pill's chat surface.
  openChatWith: (email, name) =>
    ipcRenderer.invoke("relay:openChatWith", { email: String(email || ""), name: String(name || "") }),
  canonicalChat: (chatId, options = {}) => ipcRenderer.invoke("relay:canonicalChat", {
    chatId: String(chatId || ""),
    surface: options && options.surface === "slack" ? "slack" : "relay",
    includeSlack: Boolean(options && options.includeSlack),
  }),
  canonicalChatRead: (chatId, options = {}) => ipcRenderer.invoke("relay:canonicalChatRead", {
    chatId: String(chatId || ""),
    surface: options && options.surface === "slack" ? "slack" : "relay",
    includeSlack: Boolean(options && options.includeSlack),
  }),
  // contact groups (saved rosters; a group relays to every member as one thread)
  groups: () => ipcRenderer.invoke("relay:groups"),
  groupCreate: (name) => ipcRenderer.invoke("relay:groupCreate", name),
  groupRename: (id, name) => ipcRenderer.invoke("relay:groupRename", id, name),
  groupDelete: (id) => ipcRenderer.invoke("relay:groupDelete", id),
  groupAddMember: (id, contactId) => ipcRenderer.invoke("relay:groupAddMember", id, contactId),
  groupRemoveMember: (id, contactId) => ipcRenderer.invoke("relay:groupRemoveMember", id, contactId),
  groupLeave: (id) => ipcRenderer.invoke("relay:groupLeave", id),
  contactSave: (input) => ipcRenderer.invoke("relay:contactSave", input),
  contactDelete: (input) => ipcRenderer.invoke("relay:contactDelete", input),

  // settings / account (switch + sign-out relaunch the pill on success)
  accountInfo: () => ipcRenderer.invoke("relay:accountInfo"),
  slackConnection: () => ipcRenderer.invoke("relay:slackConnection"),
  slackConnect: (input = {}) => ipcRenderer.invoke("relay:slackConnect", input || {}),
  slackDisconnect: () => ipcRenderer.invoke("relay:slackDisconnect"),
  credentialRetry: () => ipcRenderer.invoke("relay:credentialRetry"),
  chatAgentPreferences: () => ipcRenderer.invoke("relay:chatAgentPreferences"),
  saveChatAgentPreferences: (input) => ipcRenderer.invoke("relay:chatAgentPreferencesSave", input || {}),
  connectChatGPT: () => ipcRenderer.invoke("relay:connectChatGPT"),
  connectClaude: () => ipcRenderer.invoke("relay:connectClaude"),
  completeSetupTutorial: () => ipcRenderer.invoke("relay:completeSetupTutorial"),
  e2eeDeviceApprovals: () => ipcRenderer.invoke("relay:e2eeDeviceApprovals"),
  approveE2eeDevice: (deviceId) => ipcRenderer.invoke("relay:approveE2eeDevice", String(deviceId || "")),
  // Agent-installed first run. Main/core owns the installation authorization,
  // its client secret, activation token and PKCE verifier. The renderer sees
  // only status + verified account summary and can request the next human act.
  installationAuthState: () => ipcRenderer.invoke("relay:installationAuthState"),
  installationAuthBegin: () => ipcRenderer.invoke("relay:installationAuthBegin"),
  installationAuthResume: () => ipcRenderer.invoke("relay:installationAuthResume"),
  // Restart is an explicit human act. Main deletes only the one-time
  // installation-authorization namespace, and does so before minting again.
  installationAuthRestart: () => ipcRenderer.invoke("relay:installationAuthRestart"),
  installationAuthGoogle: (options = {}) => ipcRenderer.invoke("relay:installationAuthGoogle", {
    forceAccountSelection: options?.forceAccountSelection === true,
  }),
  installationAuthEmailStart: (email) => ipcRenderer.invoke("relay:installationAuthEmailStart", { email: String(email || "") }),
  installationAuthEmailVerify: (code) => ipcRenderer.invoke("relay:installationAuthEmailVerify", { code: String(code || "") }),
  installationAuthApprove: () => ipcRenderer.invoke("relay:installationAuthApprove"),
  // Cancelling abandons the local capability immediately; the unapproved
  // server record carries no identity and expires on its own.
  installationAuthCancel: () => ipcRenderer.invoke("relay:installationAuthCancel"),
  pairWithCode: (input) => ipcRenderer.invoke("relay:pairWithCode", input),
  signOut: () => ipcRenderer.invoke("relay:signOut"),
  providerAuthStatus: () => ipcRenderer.invoke("relay:providerAuthStatus"),
  providerInventory: (input = {}) => ipcRenderer.invoke("relay:providerInventory", {
    refresh: input?.refresh === true,
    force: input?.force === true,
  }),
  providerAuthConnect: (provider) => ipcRenderer.invoke("relay:providerAuthConnect", String(provider || "")),
  providerAuthSetEnabled: (provider, enabled) => ipcRenderer.invoke("relay:providerAuthSetEnabled", {
    provider: String(provider || ""),
    enabled: Boolean(enabled),
  }),
  // Manual update backstop, when the auto-updater has not refreshed this machine.
  updateNow: () => ipcRenderer.invoke("relay:updateNow"),
  // Quiet mode (Settings). Durable per-device preferences, not snoozes: current
  // values ride back on accountInfo() so an open Settings tab paints the truth.
  setPillHidden: (v) => ipcRenderer.invoke("relay:setPillHidden", Boolean(v)),
  setSoundsMuted: (v) => ipcRenderer.invoke("relay:setSoundsMuted", Boolean(v)),


  // window plumbing
  engage: () => ipcRenderer.send("relay:engage"),
  // The native window tracks the visible card's dimensions. `prepare` reserves
  // growth before paint; `settled` commits shrink after the spring completes.
  cardSize: (w, h, motion = {}) => {
    const safeMotion = {
      phase: motion.phase === "settled" ? "settled" : "prepare",
      motionId: Number.isSafeInteger(motion.motionId) ? motion.motionId : 0,
      motionSessionId: typeof motion.motionSessionId === "string"
        ? motion.motionSessionId.slice(0, 64)
        : "",
    };
    // Final visual state waits for this acknowledgement. It resolves only
    // after main has synchronously committed the new AppKit bounds, preventing
    // a folded face from painting once in the previous expanded surface.
    if (safeMotion.phase === "settled") {
      return ipcRenderer.invoke("relay:cardSizeSettled", w, h, safeMotion);
    }
    ipcRenderer.send("relay:cardSize", w, h, safeMotion);
    return undefined;
  },
  // Grow before revealing a larger reader so content is never clipped.
  prepareCardSize: (w, h) => ipcRenderer.invoke("relay:prepareCardSize", w, h),
  setTheme: (t) => ipcRenderer.send("relay:theme", t), // preview window wears the same sheet
  setPos: (x, y) => ipcRenderer.send("relay:setPos", x, y),
  soundBytes: (name) => ipcRenderer.invoke("relay:soundBytes", name),

  // dismissal (the card's ✕ / the status-area mark / ghost notifications)
  dismiss: () => ipcRenderer.send("relay:dismiss"),
  undismiss: () => ipcRenderer.send("relay:undismiss"),
  notifDone: () => ipcRenderer.send("relay:notifDone"),
  // Legacy array form = bare id list; object form carries dwell/interaction
  // evidence for the attention queue's confirmed-seen protocol.
  attentionDone: (payload) =>
    ipcRenderer.send(
      "relay:attentionDone",
      Array.isArray(payload) ? payload : payload && typeof payload === "object" ? payload : { ids: [] },
    ),
  // Fired as the renderer script's last statement: every listener above is
  // registered, so main may deliver arrivals without dropping them.
  rendererReady: () => ipcRenderer.send("relay:rendererReady"),
  // Self-diagnosis: the renderer reports its own hitches so a real freeze on a
  // real machine writes evidence instead of needing a live reproduction.
  reportStall: (info) => ipcRenderer.send("relay:stall", info || {}),
});
