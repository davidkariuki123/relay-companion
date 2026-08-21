// Native macOS release probe. Run with Electron, not Node:
//   electron test/tray-position-native-probe.cjs first-run
//   electron test/tray-position-native-probe.cjs write-position
//   electron test/tray-position-native-probe.cjs write-position-exit
//   electron test/tray-position-native-probe.cjs read-position
//   electron test/tray-position-native-probe.cjs destroy-preserve
//
// It deliberately uses test-only UUIDs. Never create, destroy, or clean a Tray
// carrying Relay's shipped UUID from a test process.

const assert = require("node:assert/strict");
const { app, nativeImage, systemPreferences, Tray } = require("electron");
const {
  RELAY_TRAY_DEFAULT_POSITION,
  destroyMacTrayPreservingPosition,
  prepareMacTrayPosition,
} = require("../overlay/tray-position.cjs");

const SEEDED_GUID = "99e50a52-2c3d-40f2-80be-cc0c36ae0c35";
const CONTROL_GUID = "ee156dcf-9510-4c4b-9b32-2e781c86cd92";
const SEEDED_KEY = `NSStatusItem Preferred Position ${SEEDED_GUID}`;
const CONTROL_KEY = `NSStatusItem Preferred Position ${CONTROL_GUID}`;
const SAVED_POSITION = 347;
const mode = process.argv[2] || "first-run";
let seededTray;
let controlTray;

function icon() {
  const image = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAEklEQVR42mNk+M+ABzDhkxyqAACvhAHxGOcYAAAAAElFTkSuQmCC",
  );
  image.setTemplateImage(true);
  return image;
}

function cleanProbePreferences() {
  for (const key of [SEEDED_KEY, CONTROL_KEY]) {
    try { systemPreferences.removeUserDefault(key); } catch {}
  }
}

function registerProbeDefault() {
  return prepareMacTrayPosition({
    platform: "darwin",
    systemPreferences,
    positionKey: SEEDED_KEY,
    defaultPosition: RELAY_TRAY_DEFAULT_POSITION,
    readDomainValue: () => ({ status: "error" }),
  });
}

app.whenReady().then(() => {
  if (mode === "destroy-preserve") {
    cleanProbePreferences();
    systemPreferences.setUserDefault(SEEDED_KEY, "double", SAVED_POSITION);
    seededTray = new Tray(icon(), SEEDED_GUID);
    setTimeout(() => {
      const result = destroyMacTrayPreservingPosition({
        platform: "darwin",
        tray: seededTray,
        systemPreferences,
        positionKey: SEEDED_KEY,
      });
      assert.deepEqual(result, { preserved: true, value: SAVED_POSITION });
      assert.equal(systemPreferences.getUserDefault(SEEDED_KEY, "double"), SAVED_POSITION);
      seededTray = new Tray(icon(), SEEDED_GUID);
      setTimeout(() => {
        try {
          assert.equal(systemPreferences.getUserDefault(SEEDED_KEY, "double"), SAVED_POSITION);
          console.log(JSON.stringify({ mode, restoredPosition: SAVED_POSITION, bounds: seededTray.getBounds() }));
        } finally {
          try { seededTray.destroy(); } catch {}
          cleanProbePreferences();
          app.quit();
        }
      }, 400);
    }, 400);
    return;
  }

  if (mode === "write-position" || mode === "write-position-exit") {
    cleanProbePreferences();
    systemPreferences.setUserDefault(SEEDED_KEY, "double", SAVED_POSITION);
    seededTray = new Tray(icon(), SEEDED_GUID);
    setTimeout(() => {
      assert.equal(systemPreferences.getUserDefault(SEEDED_KEY, "double"), SAVED_POSITION);
      console.log(JSON.stringify({ mode, savedPosition: SAVED_POSITION }));
      // Both graceful quit and Relay's account-change app.exit path must
      // preserve the value for the second launch.
      // Do not destroy the Tray or remove the preference in this phase.
      if (mode === "write-position-exit") app.exit(0);
      else app.quit();
    }, 600);
    return;
  }

  if (mode === "read-position") {
    registerProbeDefault();
    assert.equal(
      systemPreferences.getUserDefault(SEEDED_KEY, "double"),
      SAVED_POSITION,
      "the persisted user position must outrank the registered default after relaunch",
    );
    seededTray = new Tray(icon(), SEEDED_GUID);
    setTimeout(() => {
      try {
        assert.equal(systemPreferences.getUserDefault(SEEDED_KEY, "double"), SAVED_POSITION);
        console.log(JSON.stringify({ mode, restoredPosition: SAVED_POSITION, bounds: seededTray.getBounds() }));
      } finally {
        try { seededTray.destroy(); } catch {}
        cleanProbePreferences();
        app.quit();
      }
    }, 600);
    return;
  }

  assert.equal(mode, "first-run", `unknown probe mode: ${mode}`);
  cleanProbePreferences();
  registerProbeDefault();
  controlTray = new Tray(icon(), CONTROL_GUID);
  seededTray = new Tray(icon(), SEEDED_GUID);
  setTimeout(() => {
    try {
      const seeded = seededTray.getBounds();
      const control = controlTray.getBounds();
      assert.ok(seeded.width > 0 && seeded.height > 0, "seeded status item has no native bounds");
      assert.ok(control.width > 0 && control.height > 0, "control status item has no native bounds");
      assert.ok(
        seeded.x >= control.x + control.width,
        `registered position did not move the seeded item right of the control: seeded=${JSON.stringify(seeded)} control=${JSON.stringify(control)}`,
      );
      assert.equal(systemPreferences.getUserDefault(SEEDED_KEY, "double"), RELAY_TRAY_DEFAULT_POSITION);
      console.log(JSON.stringify({ mode, seeded, control, preferredPosition: RELAY_TRAY_DEFAULT_POSITION }));
    } finally {
      try { seededTray.destroy(); } catch {}
      try { controlTray.destroy(); } catch {}
      cleanProbePreferences();
      app.quit();
    }
  }, 1200);
});
