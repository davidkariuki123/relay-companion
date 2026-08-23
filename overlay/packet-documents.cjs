const fs = require("node:fs");

function packetDocumentGeneration(packet) {
  return JSON.stringify([
    String((packet && packet.updatedAt) || ""),
    String((packet && packet.forHuman) || ""),
    String((packet && packet.forAgent) || ""),
  ]);
}

/**
 * Read the complete two-document payload for a staged packet.
 *
 * Most packet files are immutable, but an owned @my_claude/@my_codex response
 * deliberately keeps one Relay id and one content path while its progress and
 * final answer replace the file contents. Cache by the staged row generation,
 * not just the path, so an open pill sees every replacement without turning
 * ordinary idle payload builds into disk polling.
 */
function createPacketDocumentReader(readFileSync = fs.readFileSync) {
  const cache = new Map();
  return function documentsForPacket(packet) {
    const staged = {
      forHuman: String((packet && packet.forHuman) || ""),
      forAgent: String((packet && packet.forAgent) || ""),
    };
    const contentPath = String((packet && packet.contentPath) || "");
    if (!contentPath) return staged;

    const generation = packetDocumentGeneration(packet);
    const cached = cache.get(contentPath);
    if (cached && cached.generation === generation) return cached.documents;

    let recovered = staged;
    try {
      const content = JSON.parse(readFileSync(contentPath, "utf8")) || {};
      recovered = {
        // The durable packet is the complete document. A mixed-version staged
        // row may contain only the inbox preview, so the file wins when set.
        forHuman: String(content.forHuman || staged.forHuman),
        forAgent: String(content.forAgent || staged.forAgent),
      };
    } catch {}
    cache.set(contentPath, { generation, documents: recovered });
    return recovered;
  };
}

module.exports = { createPacketDocumentReader, packetDocumentGeneration };
