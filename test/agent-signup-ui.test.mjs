import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const overlay = readFileSync(path.join(ROOT, "overlay/inbox.html"), "utf8");
const preload = readFileSync(path.join(ROOT, "overlay/preload.cjs"), "utf8");
const main = readFileSync(path.join(ROOT, "overlay/main.cjs"), "utf8");

test("first run is one in-pill flow with a skippable chat setup page", () => {
  for (const copy of [
    "Relay is ready for you.",
    "How would you like to continue?",
    "What’s your email?",
    "Enter your code.",
    "Finish with Google.",
    "Connect this computer?",
    "Finishing setup…",
    "Continue your setup.",
    "Restart this setup.",
    "Use Relay in your chats.",
  ]) assert.match(overlay, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.match(overlay, /cardEl\.classList\.toggle\("signup", needsSignup\)/);
  assert.match(overlay, /\.card\.collapsed \.signup-view \{ display:none; \}/);
  assert.match(overlay, /const needsSignup = credentialRecovery \|\| payload\.account\?\.paired === false \|\| tutorialPending/);
  assert.match(overlay, /Claude Code and Codex do not need this\./);
  assert.match(overlay, /id="suChatSkip"[\s\S]*Skip for now/);
});

test("signup errors are human recovery copy, never raw Electron IPC failures", () => {
  assert.match(overlay, /invalid_email_code[\s\S]*That code isn’t right or has expired\. Try again\./);
  assert.match(overlay, /network_unavailable[\s\S]*Relay couldn’t connect\. Check your internet and try again\./);
  assert.match(overlay, /authorization is unavailable[\s\S]*Relay couldn’t secure setup on this computer\./);
  assert.match(overlay, /signupError = signupFailureMessage\(reason, fallback\)/);
  assert.doesNotMatch(overlay, /signupError = reason && reason\.message/);
  assert.match(main, /INSTALLATION_AUTH_IPC_ERROR_CODES/);
  assert.match(main, /new Error\(`Relay setup failed \(\$\{code\}\)\.`\)/);
  assert.doesNotMatch(
    main.slice(main.indexOf("async function installationAuthorizationIpc"), main.indexOf("let sentStagerPromise")),
    /error\?\.message|String\(error\)/,
  );
});

test("authorization polling backs off, surfaces only recovery copy, and stops without resetting state", () => {
  assert.match(overlay, /SIGNUP_POLL_BASE_MS \* \(2 \*\* Math\.min\(signupPollFailures, 3\)\)/);
  assert.match(overlay, /SIGNUP_POLL_MAX_MS/);
  assert.match(overlay, /signupPollFailures >= SIGNUP_POLL_SURFACE_FAILURE/);
  assert.match(overlay, /signupPollFailures >= SIGNUP_POLL_STOP_FAILURE/);
  assert.match(overlay, /Relay couldn’t check setup safely\. Resume setup to try again\./);
  const poll = overlay.slice(overlay.indexOf("function pollInstallationState"), overlay.indexOf("async function resumeInstallationSetup"));
  assert.doesNotMatch(poll, /installationAuthCancel|installationAuthRestart|signOut/);
});

test("interrupted local authorization residue can only take the explicit restart path", () => {
  assert.match(overlay, /setup_restart_required[\s\S]*Restart setup to replace it safely/);
  assert.match(overlay, /signupStage = "restart-required"/);
  const restartRequired = overlay.slice(
    overlay.indexOf('if (signupStage === "restart-required")'),
    overlay.indexOf('if (signupStage === "resume")'),
  );
  assert.match(restartRequired, /restartInstallationSetup\(\)/);
  assert.match(restartRequired, /cannot safely finish the current one-time approval/);
  assert.doesNotMatch(restartRequired, /resumeInstallationSetup|signOut/);
  assert.doesNotMatch(restartRequired, /\$\{error\}/, "terminal copy stays within the fixed-height pill");
});

test("a paired credential problem opens recovery and never falls through to first-run authorization", () => {
  assert.match(overlay, /\["unavailable", "missing", "corrupt"\]\.includes\(payload\.account\?\.credentialStatus\)/);
  assert.match(overlay, /signupStage = "credential-recovery"/);
  assert.match(overlay, /Recover Relay’s account\./);
  assert.match(overlay, /Repair Relay’s storage\./);
  assert.match(overlay, /Reconnect this computer\./);
  assert.match(overlay, /Relay preserved the corrupt file for inspection/);
  assert.match(overlay, /Check the file permissions, then try again\./);
  assert.match(overlay, /window\.relay\.credentialRetry\(\)/);
  assert.match(overlay, /!credentialRecovery && payload\.account\?\.paired === false[\s\S]*installationAuthState/);
  assert.match(preload, /credentialRetry: \(\) => ipcRenderer\.invoke\("relay:credentialRetry"\)/);
  assert.match(main, /ipcMain\.handle\("relay:credentialRetry"/);
  assert.match(main, /isRemoteCredentialRejection/);
  assert.match(main, /remoteCredentialRejected \? "missing" : credential\.status/);
  assert.match(overlay, /Relay’s service no longer accepts this computer’s saved sign-in/);
});

test("email signup keeps a user recoverable when delivery is delayed or filtered", () => {
  assert.match(overlay, /Check spam if you don’t see it\./);
  assert.match(overlay, /Send another code/);
  assert.match(overlay, /suCodeResend[\s\S]*installationAuthEmailStart\(signupEmail\)/);
  assert.match(overlay, /email_code_cooldown[\s\S]*A code was just sent\. Check your inbox or wait a moment\./);
});

test("renderer installation IPC is capability-shaped and never exposes credentials", () => {
  for (const method of [
    "installationAuthState",
    "installationAuthBegin",
    "installationAuthResume",
    "installationAuthRestart",
    "installationAuthGoogle",
    "installationAuthEmailStart",
    "installationAuthEmailVerify",
    "installationAuthApprove",
    "installationAuthCancel",
    "completeSetupTutorial",
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
  assert.match(overlay, /restartInstallationSetup\(\{ forceGoogleSelection:true \}\)/);
  assert.match(overlay, /window\.relay\.installationAuthRestart\(\)/);
  assert.match(overlay, /installationAuthGoogle\(\{ forceAccountSelection:signupForceGoogleSelection \}\)/);
  assert.match(overlay, /installationAuthApprove\(\)/);
  assert.ok(overlay.indexOf("Change account") < overlay.indexOf("installationAuthApprove()"));
  assert.match(overlay, /Connect Relay/);
  assert.match(overlay, /Claude Code · Cowork · Codex/);
  assert.match(overlay, /Account verified/);
  assert.match(overlay, /Cancel setup/);
});
