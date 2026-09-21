import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { atomicWrite } from "../skill/relay/scripts/relay-protocol.mjs";

/** Called only after both the helper and app have verified the same live account.
 * Preserve independent authorization and any already-attempted tutorial payload. */
export function saveDesktopTeachingContext({ directory, run, apiUrl }) {
  if (!["teaching", "sent", "link", "complete"].includes(run.stage) || !run.accountId) throw new Error("Finish account verification first");
  const file = path.join(directory, "agent-protocol.json");
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("Relay’s existing agent connection could not be read"); }
  if (previous.account?.relayUserId && (previous.account.relayUserId !== run.accountId || previous.apiUrl !== apiUrl)) {
    throw new Error("The existing agent connection uses another account or environment. Resolve that connection before continuing.");
  }
  const sameRun = previous.desktopRunId === run.id;
  if (!sameRun && previous.tutorial?.state === "attempting") throw new Error("An earlier tutorial send is unresolved. Check its result before starting another.");
  const context = run.context || {};
  const self = context.inviter?.relayUserId === run.accountId;
  atomicWrite(file, { ...previous, version:1, local:true, consentVersion:2, apiUrl,
    account:{...previous.account,relayUserId:run.accountId}, desktopRunId:run.id,
    inviter:context.inviter,org:context.org,
    tutorial:sameRun && previous.tutorial ? previous.tutorial : {state:self?"skipped_self":"pending",idempotencyKey:self?"":randomUUID(),relayId:"",responseState:"",updatedAt:new Date().toISOString()},
  });
}
