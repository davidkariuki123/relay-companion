// Account history, not installation or a locally queued send, drives this
// chapter. Keep an unknown result distinct from a confirmed empty history.
//
// A minted link counts as a first Relay (2026-09-13): the letter exists and
// pasting the url is what sends it, so the person who was set up from
// sendrelays.com with nobody to hello can begin with a link. Its relay row
// stays pending until the first open, so the link is checked before the state.
function mintedLink(item) {
  return Boolean(item?.relayId && item.shareLink && typeof item.shareLink === "object");
}
function confirmedSend(item) {
  return Boolean(item?.relayId
    && (mintedLink(item) || ["delivered", "read", "acknowledged"].includes(item.state)));
}
// The person's first link, for the tutorial's second half: the earliest one
// still live, else the earliest at all. Sent items carry the ready message; an
// older server without it gets the message composed locally by the caller.
function firstMintedLink(response) {
  const items = Array.isArray(response?.items) ? response.items : [];
  const minted = items.filter(mintedLink)
    .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0));
  const item = minted.find((candidate) => candidate.shareLink.state !== "revoked") || minted[0];
  if (!item) return null;
  return {
    relayId: item.relayId,
    url: String(item.shareLink.url || ""),
    shareText: String(item.shareLink.shareText || ""),
    forHuman: String(item.forHuman || item.preview || ""),
    state: String(item.shareLink.state || ""),
  };
}
function hasSentRelay(response, limit = 200) {
  if (response?.hasSentRelay === true) return true;
  const items = response?.items;
  if (!Array.isArray(items)) return null;
  const sent = items.some(confirmedSend);
  if (sent) return true;
  if (response?.hasSentRelay === false) return false;
  // Older servers have no account-wide flag. A full page of unclaimed links
  // cannot prove there was no real send further back in the account history.
  return items.length < limit ? false : null;
}

function createFirstRelayOnboarding() {
  const accounts = new Map();
  function state(key) {
    if (!accounts.has(key)) accounts.set(key, { status: "checking", sawEmpty: false, relayId: "" });
    return accounts.get(key);
  }
  return {
    status(key) { return state(key).status; },
    relayId(key) { return state(key).relayId; },
    observe(key, response, tutorial = null) {
      const current = state(key);
      if (tutorial?.state === "skipped" || tutorial?.state === "skipped_self") {
        current.status = "complete";
        return current.status;
      }
      if (tutorial?.relayId && tutorial.state === "accepted") {
        // The helper's exact accepted send is authoritative even when another
        // send races it or it falls outside the recent sent page.
        current.relayId = tutorial.relayId;
      }
      if (["sent", "complete"].includes(current.status)) return current.status;
      const sent = hasSentRelay(response);
      if (sent === true) {
        current.status = current.sawEmpty ? "sent" : "complete";
        if (current.sawEmpty && !current.relayId) {
          current.relayId = [...(response.items || [])].filter(confirmedSend)
            .sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0))[0]?.relayId || "";
        }
      }
      else if (sent === false) { current.status = "waiting"; current.sawEmpty = true; }
      else current.status = "unavailable";
      return current.status;
    },
    failed(key) {
      const current = state(key);
      if (!["sent", "complete"].includes(current.status)) current.status = "unavailable";
    },
  };
}

module.exports = { createFirstRelayOnboarding, hasSentRelay, firstMintedLink, mintedLink };
