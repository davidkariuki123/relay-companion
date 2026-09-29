// The setup window shows one thing at a time. Everything below the header is
// driven by `show(state)`; nothing appears before the person needs it.
//
// A fresh computer starts downloading the moment the window opens: accepting
// the installer and launching Relay was the request. While the download runs
// the Companion's "Five ways to use Relay" card turns over on its own. The
// moment Relay is ready its pill opens in this window's place, in the middle
// of the screen with Continue with Google, and this window leaves.
const $ = selector => document.querySelector(selector);
const megabytes = bytes => `${(bytes / 1024 ** 2).toFixed(1)} MB`;

// --- Five ways to use Relay (the pill's own card module, five-ways.js) ---
const fiveWays = window.RelayAnyoneTip.create($("#relayAnyoneTip"), { expanded: true });

// --- Step state ---
// checking → working → handoff, or checking → setup → working → handoff.
// stopped keeps a retry; ready is the fallback when Relay could not be seen
// opening, and the finished state of a computer this application already
// set up. Previews only show the card.
let application = false;
let online = false;
const VISIBLE = {
  checking: [],
  preview: ["#discover"],
  setup: ["#setup", "#discover", "#trouble"],
  working: ["#download-progress", "#discover"],
  handoff: ["#download-progress"],
  ready: ["#done", "#trouble"],
  stopped: ["#setup-result", "#setup", "#discover", "#trouble"],
  removed: ["#setup-result", "#setup"],
};
function heading(title, intro) { $("#title").textContent = title; $("#intro").textContent = intro; }
function show(state) {
  document.body.dataset.state = state;
  for (const id of ["#setup", "#download-progress", "#setup-result", "#done", "#discover", "#trouble"]) $(id).hidden = !VISIBLE[state].includes(id);
  const discover = VISIBLE[state].includes("#discover");
  fiveWays.setVisible(discover);
  fiveWays.setActive(discover);
}
function message(text) { $("#setup-result").textContent = text; $("#setup-result").hidden = !text; }
function installLabel() { return online ? "Download and set up Relay" : "Set up Relay"; }

// --- Progress (inline card, only while setup is working) ---
function showProgress(progress) {
  const labels = { verifying: "Checking this computer…", downloading: "Preparing your files…", extracting: "Unpacking Relay…",
    installing: "Connecting Relay to this computer…", ready: "Relay is ready", stopped: "Setup stopped" };
  $("#progress-label").textContent = labels[progress.phase] || "Preparing setup…";
  const bar = $("#progress-bar");
  const downloading = progress.phase === "downloading" && progress.totalBytes > 0;
  if (downloading) bar.value = Math.min(100, progress.receivedBytes * 100 / progress.totalBytes);
  else if (progress.phase === "ready") bar.value = 100;
  else if (progress.phase === "stopped") bar.value = 0;
  else bar.removeAttribute("value");
  $("#progress-size").textContent = downloading ? `${megabytes(progress.receivedBytes)} / ${megabytes(progress.totalBytes)}` : "";
  $("#cancel-download").hidden = !progress.canCancel;
}
window.migration.onProgress(showProgress);
$("#cancel-download").addEventListener("click", () => window.migration.cancelDownload());

// --- Actions ---
function working() {
  show("working");
  heading("Preparing your files…", "Relay is downloading. Have a look at what you can do while it finishes.");
}
async function runSetup() {
  message("");
  working();
  showProgress({ phase: "verifying", canCancel: false });
  $("#install").textContent = installLabel();
  $("#agent-results").hidden = true;
  fiveWays.reset();
  let result;
  try {
    result = await window.migration.install();
  } catch (error) {
    const cancelled = /cancel/i.test(error.message);
    heading(cancelled ? "Setup stopped." : "Setup needs attention.", cancelled ? "Nothing was changed. Retry whenever you’re ready." : "Nothing else was changed on this computer.");
    message(error.message);
    $("#install").textContent = "Retry setup";
    show("stopped");
    return;
  }
  showCompletion(result.integrations);
  await openRelayInPlace();
}
// Relay's pill opens in this window's place; this window leaves once the pill
// reports itself up. If that cannot be confirmed in time the person is not
// stranded: Open Relay and the tutorial prompt take over.
async function openRelayInPlace() {
  heading("Relay is ready.", "Opening Relay…");
  show("handoff");
  showProgress({ phase: "ready", canCancel: false });
  let handoff = null;
  try { handoff = await window.migration.handoff(); } catch { handoff = null; }
  if (handoff?.opened === true) return;
  finished("Relay is ready.", "Open Relay to sign in.");
}
// Agent setup results, known only right after this window ran setup. Shown
// with the fallback steps; the pill repeats the restart note on its sign-in.
function showCompletion(integrations) {
  const claude = integrations?.claude?.connected === true;
  const codex = integrations?.codex?.connected === true;
  $("#claude-status").textContent = `Claude Code: ${claude ? "Connected" : "Not connected"}`;
  $("#codex-status").textContent = `Codex: ${codex ? "Connected" : "Not connected"}`;
  const connected = [["Claude Code", claude], ["Codex", codex]].filter(([, ok]) => ok).map(([name]) => name);
  $("#restart-status").textContent = connected.length
    ? `Restart required: fully quit and reopen ${connected.join(" and ")} to load Relay’s tools.`
    : "No supported agent was connected. Install or open Claude Code or Codex, then run setup again.";
  $("#agent-results").hidden = false;
}
function finished(title, intro) {
  heading(title, intro);
  $("#next-open").classList.remove("done");
  show("ready");
}
$("#install").addEventListener("click", runSetup);
$("#install-again").addEventListener("click", () => { $("#trouble").open = false; runSetup(); });
$("#open").addEventListener("click", async () => {
  try {
    await window.migration.open();
    $("#next-open").classList.add("done");
    heading("Relay is open.", "Sign in there, then continue in your agent.");
  } catch (error) { message(error.message); }
});
$("#tutorial").addEventListener("click", async () => {
  await window.migration.tutorial();
  $("#copied").textContent = "Copied";
});
$("#uninstall").addEventListener("click", async () => {
  try {
    const result = await window.migration.uninstall();
    if (result.cancelled) return;
    heading("Relay integrations were removed.", "Your account data is kept. You can now remove the application using your operating system.");
    $("#install").textContent = installLabel();
    message("");
    show("removed");
  } catch (error) { message(error.message); }
});
$("#reconcile").addEventListener("click", async () => {
  const button = $("#reconcile");
  button.disabled = true;
  try {
    await window.migration.reconcile();
    message("The interrupted setup has been checked. You can retry setup or open Relay.");
  } catch (error) { message(error.message); }
  finally { button.disabled = false; }
});

// --- Initial state ---
window.migration.inspect().then(({ candidate, installation, plan, progress, launch }) => {
  application = candidate.distribution === "application" && candidate.activationEnabled === true;
  online = candidate.runtimeDelivery === "download";
  if (!application) {
    heading("Welcome to Relay.", "This preview checks preparation for the application installer. It does not install services, connect your account, or change your agent.");
    show("preview");
    return;
  }
  $("#label").textContent = "RELAY";
  $("#install").textContent = installLabel();
  $("#download-detail").textContent = online
    ? `Setup downloads ${megabytes(candidate.runtimeDownloadBytes)} from api.sendrelays.com and needs an internet connection.`
    : "Everything setup needs is included in this installer.";
  const active = ["verifying", "downloading", "extracting", "installing"].includes(progress?.phase);
  const owned = installation?.pointer === "active" && installation.applicationOwner !== "absent";
  if (active) { working(); showProgress(progress); }
  else if (owned) {
    // Launching Relay here normally opens the Companion and never shows this
    // window; it is on screen because that could not be confirmed.
    finished("Relay is set up on this computer.", launch?.quietLaunchFailed
      ? "Relay didn’t open on its own. Open it here, or look under Trouble with setup."
      : "Open Relay to sign in, or continue in your agent.");
  }
  else if (plan.route === "fresh-install") {
    // Nothing of Relay is on this computer yet: the download starts now.
    runSetup();
  } else {
    // An existing Relay stays as it is until the person asks to move it.
    heading("Welcome to Relay.", "Relay is already installed on this computer. Set it up again to bring it into this application; your account and messages are kept.");
    $("#setup-copy").textContent = "Setup checks the existing installation first. One that needs repair is left alone.";
    show("setup");
  }
}).catch(() => {
  heading("Welcome to Relay.", "This window could not check the installation. No Relay settings have changed.");
  show("preview");
});
