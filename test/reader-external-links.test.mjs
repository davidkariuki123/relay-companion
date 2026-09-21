import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const main = readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

// Execute the actual inbox navigation wiring and URL validator with an OS-shell
// spy. This covers ordinary markdown anchors as well as target=_blank links.
function navigation() {
  const opened = [];
  const handlers = {};
  const context = vm.createContext({
    URL, console,
    inboxUrl: "file:///relay/overlay/inbox.html",
    shell: { openExternal(url) { opened.push(url); return Promise.resolve(); } },
    win: { webContents: {
      setWindowOpenHandler(handler) { handlers.popup = handler; },
      on(name, handler) { handlers[name] = handler; },
    } },
  });
  const externalStart = main.indexOf("function openPreviewExternal(url)");
  vm.runInContext(main.slice(externalStart, main.indexOf("\n//", externalStart)), context);
  const start = main.indexOf("  win.webContents.setWindowOpenHandler");
  vm.runInContext(main.slice(start, main.indexOf("  win.loadFile(inboxPath);", start)), context);
  return { opened, handlers, inboxUrl: context.inboxUrl };
}

for (const url of [
  "https://sendrelays.com/s/xr3B9YYlD_eZdmuw",
  "https://x.com/davidkariuki24/status/2102001003608396181",
  "http://example.com/",
  "mailto:hello@example.com",
]) {
  test(`reader link opens once through the OS: ${url}`, () => {
    const { opened, handlers } = navigation();
    let prevented = 0;
    handlers["will-navigate"]({ preventDefault() { prevented++; } }, url);
    assert.equal(prevented, 1, "keep the privileged reader in its bundled document");
    assert.deepEqual(opened, [url]);
  });
  test(`new-window link opens externally without a child window: ${url}`, () => {
    const { opened, handlers } = navigation();
    assert.equal(handlers.popup({ url }).action, "deny");
    assert.deepEqual(opened, [url]);
  });
}

for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,test", "relay://run", "not a URL"]) {
  test(`reader rejects unsafe destination: ${url}`, () => {
    const { opened, handlers } = navigation();
    let prevented = false;
    handlers["will-navigate"]({ preventDefault() { prevented = true; } }, url);
    assert.equal(prevented, true);
    assert.equal(handlers.popup({ url }).action, "deny");
    assert.deepEqual(opened, []);
  });
}

test("the bundled reader can reload without opening a browser", () => {
  const { opened, handlers, inboxUrl } = navigation();
  handlers["will-navigate"]({ preventDefault() { assert.fail("blocked bundled reader"); } }, inboxUrl);
  assert.deepEqual(opened, []);
});
