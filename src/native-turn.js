function timestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Return only the provider's current turn from a newest-first transcript.
 * Request receipts can be hours older than a retried/follow-up native turn,
 * so they are deliberately not accepted as timing inputs here.
 */
export function nativeTurn(records, { terminalAt = null } = {}) {
  const rows = Array.isArray(records) ? records.filter(Boolean) : [];
  // Claude writes Monitor/background-task notifications as synthetic `user`
  // messages. They are events inside the current turn, not a new human turn.
  // Cutting at the newest one hid every preceding tool call and assistant
  // update, leaving the live runner with only “Reading the request.”
  const newestUser = rows.findIndex((row) => {
    if (row.type !== "message" || row.role !== "user") return false;
    return !/^\s*<task-notification\b/i.test(String(row.text || ""));
  });
  const current = newestUser >= 0 ? rows.slice(0, newestUser + 1) : rows;
  const startAt = newestUser >= 0 ? current[newestUser]?.at || null : null;
  const startMs = timestampMs(startAt);
  const nativeTimes = current.map((row) => timestampMs(row.at)).filter((ms) => ms !== null);
  const terminalMs = timestampMs(terminalAt);
  const endMs = terminalMs !== null && (startMs === null || terminalMs >= startMs)
    ? terminalMs
    : nativeTimes.length ? Math.max(...nativeTimes) : null;
  const endAt = endMs === null ? null : new Date(endMs).toISOString();
  const durationMs = startMs !== null && endMs !== null && endMs >= startMs ? endMs - startMs : null;
  return { records: current, startedAt: startAt, completedAt: endAt, durationMs };
}

export function humanDuration(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes} min ${remainder} sec` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder ? `${hours} h ${minuteRemainder} min` : `${hours} h`;
}
