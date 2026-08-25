"use strict";

const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const CHAT_ID = /^chat_[A-Za-z0-9]{1,199}$/;

function parseRelayDeepLink(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return null;
  }
  if (url.protocol !== "relay:" || url.hostname !== "open") return null;
  const messageId = String(url.searchParams.get("message") || "").trim();
  const chatId = String(url.searchParams.get("chat") || "").trim();
  const rawHost = String(url.searchParams.get("host") || "").trim().toLowerCase();
  if (
    !MESSAGE_ID.test(messageId)
    || (chatId && !CHAT_ID.test(chatId))
    || !["relay", "codex", "claude"].includes(rawHost)
  ) return null;
  return { messageId, host: rawHost, ...(chatId ? { chatId } : {}) };
}

function relayDeepLinkFromArgv(argv) {
  for (const value of Array.isArray(argv) ? argv : []) {
    const parsed = parseRelayDeepLink(value);
    if (parsed) return { url: String(value), ...parsed };
  }
  return null;
}

module.exports = { parseRelayDeepLink, relayDeepLinkFromArgv };
