// Minimal atomic JSON writer used by the lazy-open engine's host-state writers
// (codex-state, pinning). The original relay-companion imported writeJsonAtomic
// from its large json-store.js; here we only need the atomic write primitive, so
// this is the adapter the port note calls for — same temp+rename behavior.

import fs from "node:fs";
import path from "node:path";

export function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}
