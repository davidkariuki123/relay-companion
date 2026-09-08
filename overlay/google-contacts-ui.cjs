/* Shared by the People renderer and its state tests. No network or account data. */
(function (root) {
  function view(status, busy, error) {
    if (busy || status?.state === "syncing") return { action: "Syncing…", detail: "Bringing your contacts into Relay…", note: "Names and email addresses. Read-only.", disabled: true };
    if (error) return { action: "Try again", detail: "Google contacts couldn’t be checked.", note: "Your existing contacts are still here.", disabled: false };
    if (status?.state === "permission_required") return { action: status.connected ? "Reconnect" : "Connect", detail: "Google needs your permission to sync.", note: "Your existing contacts are still here.", disabled: false };
    if (status?.state === "error") return { action: "Try again", detail: "Google contacts couldn’t sync.", note: "Your existing contacts are still here.", disabled: false };
    if (status?.state === "healthy") {
      const date = status.lastSyncedAt && new Date(status.lastSyncedAt);
      const when = date && Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
      return { action: "Sync now", detail: `${status.contactCount} ${status.contactCount === 1 ? "contact" : "contacts"} synced${when ? ` · ${when}` : ""}`, note: "Names and email addresses. Read-only.", disabled: false };
    }
    return { action: "Connect", detail: "Bring your Google contacts into Relay.", note: "Names and email addresses. Read-only.", disabled: false };
  }
  const api = { view };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RelayGoogleContacts = api;
})(typeof globalThis === "object" ? globalThis : this);
