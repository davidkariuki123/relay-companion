(function installReadReceipts(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RelayReadReceipts = api;
})(typeof globalThis === "object" ? globalThis : this, function createReadReceipts() {
  function timestamp(value) {
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizedMembers(message) {
    return (Array.isArray(message && message.readReceipts) ? message.readReceipts : [])
      .map((member) => ({
        name: String((member && member.name) || "Someone").trim() || "Someone",
        seen: Boolean(member && member.seen),
        readAt: member && member.readAt ? String(member.readAt) : "",
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function latestOutbound(messages) {
    let latest = null;
    let latestAt = -Infinity;
    for (const candidate of messages || []) {
      if (!candidate || !(candidate.mine || candidate.direction === "out" || candidate.direction === "outbound")) continue;
      const at = timestamp(candidate.at || candidate.createdAt) ?? 0;
      if (!latest || at >= latestAt) {
        latest = candidate;
        latestAt = at;
      }
    }
    return latest;
  }

  /**
   * Build the one compact receipt shown under the newest outbound message.
   * `formatTime` deliberately belongs to the host surface: the pill uses a
   * relative label, while the full conversation window uses clock time.
   */
  function forLatest(message, messages, formatTime) {
    const outbound = message && (message.mine || message.direction === "out" || message.direction === "outbound");
    if (!outbound || latestOutbound(messages) !== message || message.pending || message.state === "pending") return null;

    const members = normalizedMembers(message);
    const readers = members
      .filter((member) => member.seen)
      .sort((a, b) => (timestamp(a.readAt) ?? Infinity) - (timestamp(b.readAt) ?? Infinity) || a.name.localeCompare(b.name));
    if (!readers.length) {
      // THE LADDER, and the rungs before anyone has read it. The queue owns
      // what happens on this device; from the moment the server has the
      // message these two are what is true, and the sender is owed them —
      // "Sent" alone cannot distinguish a message sitting in the API from one
      // already on the recipient's device. `delivered` is the server's own
      // relay state, not a guess: it is set when the relay is routed to the
      // recipient (their device, or the email that stands in for it).
      const label = message.delivered ? "Delivered" : "Sent";
      return { label, readers: [], unread: members, expandable: false };
    }
    const unread = members.filter((member) => !member.seen);
    const showTime = (value) => (value && typeof formatTime === "function" ? formatTime(value) : "");
    const isGroup = Boolean(message.isGroup) && members.length > 1;
    let label;

    if (!isGroup) {
      const time = showTime(readers[0].readAt);
      label = `Seen${time ? ` ${time}` : ""}`;
    } else if (!unread.length) {
      const completion = readers.reduce((latest, reader) => {
        const at = timestamp(reader.readAt);
        return at !== null && (latest === null || at > latest) ? at : latest;
      }, null);
      const time = completion === null ? "" : showTime(new Date(completion).toISOString());
      label = `Seen by everyone${time ? ` · ${time}` : ""}`;
    } else if (readers.length === 1) {
      const time = showTime(readers[0].readAt);
      label = `Seen by ${readers[0].name}${time ? ` · ${time}` : ""}`;
    } else if (readers.length === 2) {
      label = `Seen by ${readers[0].name} and ${readers[1].name}`;
    } else {
      label = `Seen by ${readers[0].name}, ${readers[1].name} and ${readers.length - 2} more`;
    }

    return { label, readers, unread, expandable: isGroup };
  }

  return { forLatest, normalizedMembers };
});
