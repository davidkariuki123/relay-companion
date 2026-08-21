import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const overlay = readFileSync(path.join(ROOT, "overlay/inbox.html"), "utf8");
const preload = readFileSync(path.join(ROOT, "overlay/preload.cjs"), "utf8");
const main = readFileSync(path.join(ROOT, "overlay/main.cjs"), "utf8");

test("unpaired first run is one in-pill account flow ending at the normal inbox", () => {
  for (const copy of [
    "Relay is ready for you.",
    "How would you like to continue?",
    "What’s your email?",
    "Enter your code.",
    "Finish with Google.",
    "Connect this computer?",
    "Finishing setup…",
  ]) assert.match(overlay, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.match(overlay, /cardEl\.classList\.toggle\("signup", needsSignup\)/);
  assert.match(overlay, /\.card\.collapsed \.signup-view \{ display:none; \}/);
  assert.match(overlay, /const needsSignup = payload\.account\?\.paired === false/);
  assert.doesNotMatch(overlay, /Welcome to Relay|welcome tutorial|first-launch tutorial/i);
});

test("renderer installation IPC is capability-shaped and never exposes credentials", () => {
  for (const method of [
    "installationAuthState",
    "installationAuthBegin",
    "installationAuthGoogle",
    "installationAuthEmailStart",
    "installationAuthEmailVerify",
    "installationAuthApprove",
    "installationAuthCancel",
  ]) assert.match(preload, new RegExp(`${method}:`));

  const seam = preload.slice(preload.indexOf("installationAuthState:"), preload.indexOf("pairWithCode:"));
  assert.doesNotMatch(seam, /clientSecret|activationToken|codeVerifier/);
  assert.match(seam, /forceAccountSelection/);
});

test("the privileged pill renderer cannot navigate or create a web child", () => {
  const createWindow = main.slice(main.indexOf("function createWindow()"), main.indexOf("function createPreviewWindow"));
  assert.match(createWindow, /const inboxUrl = pathToFileURL\(inboxPath\)\.href/);
  assert.match(createWindow, /setWindowOpenHandler\(\(\{ url \}\) => \{[\s\S]*openPreviewExternal\(url\);[\s\S]*action: "deny"/);
  assert.match(createWindow, /webContents\.on\("will-navigate", \(event, url\) => \{[\s\S]*url !== inboxUrl[\s\S]*event\.preventDefault\(\)/);

  const external = main.slice(main.indexOf("function openPreviewExternal"), main.indexOf("function isPreviewEvent"));
  assert.match(external, /new Set\(\["http:", "https:", "mailto:"\]\)/);
  assert.doesNotMatch(external, /file:|javascript:|data:/);
});

test("a wrong identity stays human-confirmed and returns to the method chooser before approval", () => {
  assert.match(overlay, /Check the account and agent apps before you approve\./);
  assert.match(overlay, /Change account/);
  assert.match(overlay, /await window\.relay\.installationAuthCancel\(\);\s+const state = await window\.relay\.installationAuthBegin\(\);/);
  assert.match(overlay, /installationAuthGoogle\(\{ forceAccountSelection:signupForceGoogleSelection \}\)/);
  assert.match(overlay, /installationAuthApprove\(\)/);
  assert.ok(overlay.indexOf("Change account") < overlay.indexOf("installationAuthApprove()"));
  assert.match(overlay, /Connect Relay/);
  assert.match(overlay, /Claude Code · Cowork · Codex/);
  assert.match(overlay, /Account verified/);
  assert.match(overlay, /Cancel setup/);
});
