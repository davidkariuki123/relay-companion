import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { DMG_LAYOUT, DMG_BACKGROUND, DMG_VOLUME_NAME, PREVIEW_DMG_VOLUME_NAME, DMG_TEXT, dmgVolumeName, BACKGROUND_DIRECTORY, BACKGROUND_NAME,
  binaryPlist, parseBinaryPlist, real, aliasRecord, parseAlias, dsStore, readDsStore, finderRecords, buildMacDmg, assertVolumeLayout } from "../lib/mac-dmg.mjs";

const alias = () => aliasRecord({ volumeName: DMG_VOLUME_NAME, volumeCreated: new Date("2026-10-08T10:00:00Z"), mountPoint: "/Volumes/Install Relay",
  relativePath: `${BACKGROUND_DIRECTORY}/${BACKGROUND_NAME}`, fileCreated: new Date("2026-10-08T10:00:01Z"), cnid: 634, parentCnid: 633, cnidPath: [633] });

// Founder, 0.1.624 on a real Mac (2026-10-10): the window said "Drag Relay to
// Applications", the drag copied the app, and then nothing opened.
// Founder's pick, 2026-10-10: the icon is a word in "Double-click [Relay] to
// install." Finder shows the picture's top 368 pt under a 32 pt title bar.
test("the install window is one large Relay icon in the middle of a 640 x 400 window, with nothing to drag it onto", () => {
  const { window, app, iconSize } = DMG_LAYOUT;
  assert.deepEqual([window.width, window.height], [640, 400]);
  assert.ok(iconSize >= 160, "one large icon");
  assert.equal(app.x, window.width / 2, "centred");
  assert.equal(DMG_LAYOUT.applications, undefined, "no Applications folder");
  assert.ok(app.x - iconSize / 2 >= 0 && app.x + iconSize / 2 <= window.width, "icon inside the window");
  assert.ok(app.y - iconSize / 2 >= 64, "icon below the eyebrow");
  assert.ok(app.y + DMG_LAYOUT.labelOffset + 12 <= app.y + 140, "name above the note");
  assert.ok(app.y + 140 + 18 <= window.height - 32, "note inside the content below a title bar");
  const records = finderRecords({ backgroundAlias: alias() });
  assert.deepEqual(records.filter(record => record.code === "Iloc").map(record => record.name), ["Relay.app"]);
});

test("the volume is called Install Relay, previews keep their own name, and the picture says double-click", () => {
  assert.equal(DMG_VOLUME_NAME, "Install Relay");
  assert.equal(dmgVolumeName(), "Install Relay");
  assert.equal(dmgVolumeName({ preview: true }), PREVIEW_DMG_VOLUME_NAME);
  assert.equal(PREVIEW_DMG_VOLUME_NAME, "Relay Migration Preview");
  assert.deepEqual({ ...DMG_TEXT }, { eyebrow: "Install Relay", lead: "Double-click", trail: "to install.",
    note: "It moves itself into Applications and opens. There\u2019s nothing to drag." });
});

// Read every image directory in a (big-endian or little-endian) TIFF.
function tiffSizes(buffer) {
  const little = buffer.toString("ascii", 0, 2) === "II";
  const u16 = at => little ? buffer.readUInt16LE(at) : buffer.readUInt16BE(at);
  const u32 = at => little ? buffer.readUInt32LE(at) : buffer.readUInt32BE(at);
  assert.equal(u16(2), 42, "a TIFF");
  const sizes = [];
  for (let ifd = u32(4); ifd; ) {
    const count = u16(ifd), size = {};
    for (let index = 0; index < count; index++) {
      const entry = ifd + 2 + index * 12, tag = u16(entry), type = u16(entry + 2);
      const value = type === 3 ? u16(entry + 8) : u32(entry + 8);
      if (tag === 256) size.width = value;
      if (tag === 257) size.height = value;
    }
    sizes.push(size);
    ifd = u32(ifd + 2 + count * 12);
  }
  return sizes;
}

test("the committed background holds the 1x and Retina pictures at the window's size", () => {
  const sizes = tiffSizes(fs.readFileSync(DMG_BACKGROUND));
  assert.deepEqual(sizes, [{ width: 640, height: 400 }, { width: 1280, height: 800 }]);
  assert.ok(fs.statSync(DMG_BACKGROUND).size < 512 * 1024, "compressed");
});

test("binary property lists round-trip, and macOS reads them the same way", () => {
  const value = { WindowBounds: "{{200, 120}, {640, 400}}", ShowToolbar: false, labelOnBottom: true, iconSize: real(128),
    backgroundType: 2, big: 70000, alias: Buffer.alloc(300, 7), long: "x".repeat(40), name: "Relayé" };
  const bytes = binaryPlist(value);
  const parsed = parseBinaryPlist(bytes);
  assert.deepEqual({ ...parsed, alias: parsed.alias.toString("hex") }, { ...value, iconSize: 128, alias: value.alias.toString("hex") });
  if (process.platform === "darwin") {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-plist-")), "value.plist");
    fs.writeFileSync(file, bytes);
    const plutil = (...args) => {
      const result = spawnSync("/usr/bin/plutil", [...args, file], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      return result.stdout.trim();
    };
    plutil("-lint");
    const raw = key => plutil("-extract", key, "raw", "-o", "-");
    assert.equal(raw("WindowBounds"), value.WindowBounds);
    assert.equal(Number(raw("iconSize")), 128);
    assert.equal(raw("big"), "70000");
    assert.equal(raw("ShowToolbar"), "false");
    assert.equal(raw("name"), value.name);
    assert.equal(Buffer.from(raw("alias"), "base64").length, 300);
  }
});

test("the background alias names the volume, the folder and the picture by name, id and path", () => {
  const bytes = alias();
  const parsed = parseAlias(bytes);
  assert.equal(parsed.volumeName, "Install Relay");
  assert.equal(parsed.filename, BACKGROUND_NAME);
  assert.equal(parsed.fsType, "H+");
  assert.equal(parsed.posixPath, "/.background/background.tiff");
  assert.equal(parsed.carbonPath, "Install Relay:.background:background.tiff");
  assert.equal(parsed.tags[0].toString(), ".background");
  assert.equal(parsed.tags[1].readUInt32BE(0), 633);
  assert.equal(parsed.tags[19].toString(), "/Volumes/Install Relay");
  assert.equal(bytes.readUInt32BE(46), 633, "parent folder id");
  assert.equal(bytes.readUInt32BE(114), 634, "file id");
  assert.equal(bytes.readUInt32BE(38), Math.floor(Date.parse("2026-10-08T10:00:00Z") / 1000) + 2_082_844_800, "volume date in Mac time");
  assert.throws(() => aliasRecord({ volumeName: "x".repeat(28), volumeCreated: new Date(), mountPoint: "/", relativePath: "a/b",
    fileCreated: new Date(), cnid: 1, parentCnid: 1, cnidPath: [] }), /too long/);
});

test(".DS_Store is a valid buddy-allocated tree Finder can read, and the same input gives the same bytes", () => {
  const records = finderRecords({ backgroundAlias: alias() });
  const file = dsStore(records);
  assert.ok(file.equals(dsStore([...records].reverse())), "deterministic and order independent");
  assert.equal(file.readUInt32BE(0), 1);
  assert.equal(file.toString("ascii", 4, 8), "Bud1");
  const read = readDsStore(file);
  assert.deepEqual(read.map(record => `${record.name}/${record.code}`), [".:bwsp", ".:icvp", ".:vSrn", ".:vstl", "Relay.app:Iloc"].map(name => name.replace(":", "/")));
  // Every byte of the 2 GiB address space is either one allocated block or on
  // exactly one free list, as the allocator requires.
  const infoAt = 4 + file.readUInt32BE(8);
  const count = file.readUInt32BE(infoAt);
  const blocks = Array.from({ length: count }, (_, index) => file.readUInt32BE(infoAt + 8 + index * 4))
    .map(address => [address & ~31, 2 ** (address & 31)]);
  let at = infoAt + 8 + 256 * 4;
  const tocEntries = file.readUInt32BE(at); at += 4;
  for (let index = 0; index < tocEntries; index++) at += 1 + file[at] + 4;
  const spans = [[0, 32], ...blocks];
  for (let width = 0; width < 32; width++) {
    const entries = file.readUInt32BE(at); at += 4;
    for (let index = 0; index < entries; index++, at += 4) spans.push([file.readUInt32BE(at), 2 ** width]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  for (const [offset, size] of spans) { assert.equal(offset, cursor, "no gap or overlap"); assert.equal(offset % size, 0, "aligned"); cursor += size; }
  assert.equal(cursor, 2 ** 31);
  for (const [offset, size] of blocks) assert.ok(4 + offset + size <= file.length);
});

test("built image opens to the one-icon install window", { skip: process.platform !== "darwin" && "needs macOS hdiutil" }, (t) => {
  const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "relay-dmg-test-"));
  const mount = path.join(work, "mount");
  t.after(() => {
    if (fs.existsSync(path.join(mount, ".DS_Store"))) spawnSync("/usr/bin/hdiutil", ["detach", mount, "-force"]);
    fs.rmSync(work, { recursive: true, force: true });
  });
  const app = path.join(work, "Relay.app");
  fs.mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  fs.writeFileSync(path.join(app, "Contents/Info.plist"), "<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>CFBundleName</key><string>Relay</string></dict></plist>");
  const dmg = path.join(work, "Relay.dmg");
  buildMacDmg({ app, output: dmg, temporary: work });
  const info = spawnSync("/usr/bin/hdiutil", ["imageinfo", dmg], { encoding: "utf8" });
  assert.match(info.stdout, /UDZO|read-only compressed/);
  fs.mkdirSync(mount);
  const attach = spawnSync("/usr/bin/hdiutil", ["attach", dmg, "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount], { encoding: "utf8" });
  assert.equal(attach.status, 0, attach.stderr);
  try {
    const found = assertVolumeLayout(mount);
    assert.equal(found.alias.volumeName, "Install Relay");
    assert.equal(found.icvp.textSize, DMG_LAYOUT.textSize);
    assert.deepEqual(fs.readdirSync(mount).filter(name => !name.startsWith(".")).sort(), ["Relay.app"]);
    // The gate holds the image to the new volume name, not the old one.
    assert.throws(() => assertVolumeLayout(mount, { volumeName: "Relay" }));
  } finally { spawnSync("/usr/bin/hdiutil", ["detach", mount]); }
});
