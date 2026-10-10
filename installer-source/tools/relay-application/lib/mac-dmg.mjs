// The Mac installer disk image: a volume named "Install Relay" whose Finder
// window shows one large Relay icon set into a sentence on the picture,
// "Double-click [Relay] to install." There is no Applications folder and no arrow:
// dragging is a file copy that never opens Relay (founder, 0.1.624, 2026-10-10),
// while double-clicking opens Relay, which moves itself into Applications,
// ejects this volume and carries straight on into setup (app/main.cjs). Finder
// reads the window from two hidden files on the volume:
// .background/background.tiff and a .DS_Store that names the picture, the
// window size, the icon size and where the icon sits.
//
// The bundle inside stays Relay.app, so Finder labels the icon "Relay". Naming
// it "Install Relay.app" would carry that name everywhere the app goes:
// Electron's moveToApplicationsFolder keeps the bundle's file name, so it would
// install as /Applications/Install Relay.app (and so would a drag), where
// nothing that looks for /Applications/Relay.app finds it; the updater archive
// and the install proofs name Relay.app too. A label cannot be set any other
// way (.DS_Store has no display-name record, and a localized bundle name would
// rename the installed app as well), so the picture carries the words, and
// Finder's own "Relay" under the icon finishes the sentence.
//
// Everything here is plain Node with no native modules and no Finder
// scripting, so it runs headless on a hosted runner and gives the same layout
// every time. The .DS_Store and the alias inside it are written directly in
// the formats Finder reads (the buddy-allocated B-tree described by Wim Lewis
// and Mark Mentovai, and the classic version 2 alias record), following the
// same field choices as the widely used dmgbuild/ds_store/mac_alias tools.
// The alias points at the picture on the mounted volume, so the image is
// built read-write, mounted, finished, and only then compressed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DMG_BACKGROUND = path.join(path.dirname(fileURLToPath(import.meta.url)), "mac-dmg-background.tiff");
export const BACKGROUND_DIRECTORY = ".background";
export const BACKGROUND_NAME = "background.tiff";
// The volume a person sees mount, and the Finder window's title. Read-only
// previews keep their own name so they are never mistaken for Relay.
export const DMG_VOLUME_NAME = "Install Relay";
export const PREVIEW_DMG_VOLUME_NAME = "Relay Migration Preview";
export const dmgVolumeName = ({ preview = false } = {}) => preview ? PREVIEW_DMG_VOLUME_NAME : DMG_VOLUME_NAME;
// The words on the picture (render-dmg-background.mjs draws them): a small
// eyebrow, the sentence either side of the icon, and one plain note.
export const DMG_TEXT = Object.freeze({
  eyebrow: "Install Relay",
  lead: "Double-click",
  trail: "to install.",
  note: "It moves itself into Applications and opens. There\u2019s nothing to drag.",
});
// WindowBounds is the whole window, so Finder shows the picture's top 640 x 368
// under its 32 pt title bar and the bottom 32 pt never appear. Icon positions
// are icon centres in the window's content coordinates, as Finder stores them.
export const DMG_LAYOUT = Object.freeze({
  window: Object.freeze({ x: 200, y: 120, width: 640, height: 400 }),
  iconSize: 160,
  textSize: 13,
  // The picture's own paper colour (#faf9f5), behind anything it leaves bare.
  backgroundColor: Object.freeze([0xfa / 255, 0xf9 / 255, 0xf5 / 255]),
  // Finder draws the name this far below the icon centre (macOS 26, 160 pt
  // icon, 13 pt text): black, in light and dark mode alike, because the
  // window has a picture (see the renderer).
  labelOffset: 100,
  // The one icon, centred, standing in the sentence's line.
  app: Object.freeze({ x: 320, y: 168 }),
  filesystem: "HFS+",
});

// Seconds between the classic Mac epoch (1904-01-01Z) and the Unix epoch.
const MAC_EPOCH_OFFSET = 2_082_844_800;

// ---------------------------------------------------------------------------
// Binary property lists (bplist00), the format of the icvp and bwsp blobs.
const REAL = Symbol("real");
export const real = value => ({ [REAL]: Number(value) });

export function binaryPlist(value) {
  const objects = [];
  const flatten = item => {
    const id = objects.length;
    objects.push(null);
    if (item && typeof item === "object" && !Buffer.isBuffer(item) && !(REAL in item)) {
      const keys = Object.keys(item).sort();
      objects[id] = { dict: true, keys: keys.map(flatten), values: keys.map(key => flatten(item[key])) };
    } else objects[id] = { item };
    return id;
  };
  flatten(value);
  const refSize = objects.length < 256 ? 1 : 2;
  const ref = id => refSize === 1 ? Buffer.from([id]) : Buffer.from([id >> 8, id & 255]);
  const int = n => {
    if (n >= 0 && n < 256) return Buffer.from([0x10, n]);
    if (n >= 0 && n < 65536) { const b = Buffer.alloc(3); b[0] = 0x11; b.writeUInt16BE(n, 1); return b; }
    if (n >= 0 && n < 2 ** 32) { const b = Buffer.alloc(5); b[0] = 0x12; b.writeUInt32BE(n, 1); return b; }
    const b = Buffer.alloc(9); b[0] = 0x13; b.writeBigInt64BE(BigInt(n), 1); return b;
  };
  const marker = (type, count) => count < 15 ? Buffer.from([type | count]) : Buffer.concat([Buffer.from([type | 0x0f]), int(count)]);
  const encode = node => {
    if (node.dict) return Buffer.concat([marker(0xd0, node.keys.length), ...node.keys.map(ref), ...node.values.map(ref)]);
    const { item } = node;
    if (item === false) return Buffer.from([0x08]);
    if (item === true) return Buffer.from([0x09]);
    if (Buffer.isBuffer(item)) return Buffer.concat([marker(0x40, item.length), item]);
    if (typeof item === "number") { assert.ok(Number.isSafeInteger(item), "use real() for non-integers"); return int(item); }
    if (item && typeof item === "object" && REAL in item) { const b = Buffer.alloc(9); b[0] = 0x23; b.writeDoubleBE(item[REAL], 1); return b; }
    if (typeof item === "string") {
      if (/^[\x00-\x7f]*$/.test(item)) return Buffer.concat([marker(0x50, item.length), Buffer.from(item, "ascii")]);
      const utf16 = Buffer.from(item, "utf16le").swap16();
      return Buffer.concat([marker(0x60, utf16.length / 2), utf16]);
    }
    throw new Error(`Unsupported plist value: ${typeof item}`);
  };
  const chunks = [Buffer.from("bplist00", "ascii")];
  const offsets = [];
  let length = 8;
  for (const node of objects) { const bytes = encode(node); offsets.push(length); chunks.push(bytes); length += bytes.length; }
  const offsetSize = length < 256 ? 1 : length < 65536 ? 2 : 4;
  const table = Buffer.alloc(offsets.length * offsetSize);
  offsets.forEach((offset, index) => table.writeUIntBE(offset, index * offsetSize, offsetSize));
  const trailer = Buffer.alloc(32);
  trailer[6] = offsetSize; trailer[7] = refSize;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(length), 24);
  return Buffer.concat([...chunks, table, trailer]);
}

export function parseBinaryPlist(buffer) {
  assert.equal(buffer.subarray(0, 8).toString("ascii"), "bplist00", "not a binary plist");
  const trailer = buffer.subarray(buffer.length - 32);
  const offsetSize = trailer[6], refSize = trailer[7];
  const count = Number(trailer.readBigUInt64BE(8)), top = Number(trailer.readBigUInt64BE(16)), tableAt = Number(trailer.readBigUInt64BE(24));
  const offset = id => buffer.readUIntBE(tableAt + id * offsetSize, offsetSize);
  const readObject = (id, depth = 0) => {
    assert.ok(id < count && depth < 32, "malformed plist");
    let at = offset(id);
    const head = buffer[at], type = head & 0xf0;
    let size = head & 0x0f;
    const readLength = () => {
      if (size !== 0x0f) return;
      const intHead = buffer[at + 1], bytes = 1 << (intHead & 0x0f);
      size = Number(buffer.readUIntBE(at + 2, Math.min(bytes, 6)));
      at += 1 + bytes;
    };
    if (head === 0x08) return false;
    if (head === 0x09) return true;
    if (type === 0x10) { const bytes = 1 << size; return bytes === 8 ? Number(buffer.readBigInt64BE(at + 1)) : buffer.readUIntBE(at + 1, bytes); }
    if (type === 0x20) return size === 3 ? buffer.readDoubleBE(at + 1) : buffer.readFloatBE(at + 1);
    readLength();
    if (type === 0x40) return Buffer.from(buffer.subarray(at + 1, at + 1 + size));
    if (type === 0x50) return buffer.subarray(at + 1, at + 1 + size).toString("ascii");
    if (type === 0x60) return Buffer.from(buffer.subarray(at + 1, at + 1 + size * 2)).swap16().toString("utf16le");
    if (type === 0xd0) {
      const refs = index => buffer.readUIntBE(at + 1 + index * refSize, refSize);
      const result = {};
      for (let index = 0; index < size; index++) result[readObject(refs(index), depth + 1)] = readObject(refs(size + index), depth + 1);
      return result;
    }
    throw new Error(`Unsupported plist object 0x${head.toString(16)}`);
  };
  return readObject(top);
}

// ---------------------------------------------------------------------------
// Version 2 alias record, the backgroundImageAlias Finder resolves to find
// the picture. It names the volume, the file and the folder by name, by
// catalog node id and by path, so it still resolves when the image is mounted
// again under a new device.
const TAG = { folderName: 0, cnidPath: 1, carbonPath: 2, unicodeFilename: 14, unicodeVolumeName: 15,
  highResVolumeDate: 16, highResCreationDate: 17, posixPath: 18, posixMountPoint: 19 };
const macSeconds = date => date.getTime() / 1000 + MAC_EPOCH_OFFSET;
const pascal = (text, size) => {
  const bytes = Buffer.from(text.replace(/:/g, "/"), "utf8");
  assert.ok(bytes.length < size, `${text} is too long for an alias`);
  const field = Buffer.alloc(size); field[0] = bytes.length; bytes.copy(field, 1); return field;
};
const tagged = (tag, data) => {
  const head = Buffer.alloc(4); head.writeInt16BE(tag, 0); head.writeUInt16BE(data.length, 2);
  return Buffer.concat([head, data, Buffer.alloc(data.length & 1)]);
};
const unicode = text => {
  const utf16 = Buffer.from(text.replace(/:/g, "/").normalize("NFD"), "utf16le").swap16();
  const count = Buffer.alloc(2); count.writeUInt16BE(utf16.length / 2);
  return Buffer.concat([count, utf16]);
};
const hiRes = date => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(Math.floor(macSeconds(date) * 65536))); return b; };

export function aliasRecord({ volumeName, volumeCreated, mountPoint, relativePath, fileCreated, cnid, parentCnid, cnidPath }) {
  const parts = relativePath.split("/").filter(Boolean);
  assert.ok(parts.length >= 2, "the aliased file must sit in a folder on the volume");
  const filename = parts.at(-1), folderName = parts.at(-2);
  const fixed = Buffer.alloc(142);
  let at = 0;
  fixed.writeInt16BE(0, at); at += 2; // kind: file
  pascal(volumeName, 28).copy(fixed, at); at += 28;
  fixed.writeUInt32BE(Math.floor(macSeconds(volumeCreated)) >>> 0, at); at += 4;
  fixed.write("H+", at, "ascii"); at += 2; // file system type
  fixed.writeInt16BE(0, at); at += 2; // fixed disk
  fixed.writeUInt32BE(parentCnid, at); at += 4;
  pascal(filename, 64).copy(fixed, at); at += 64;
  fixed.writeUInt32BE(cnid, at); at += 4;
  fixed.writeUInt32BE(Math.floor(macSeconds(fileCreated)) >>> 0, at); at += 4;
  at += 8; // creator and type codes: none
  fixed.writeInt16BE(-1, at); at += 2; // levels from
  fixed.writeInt16BE(-1, at); at += 2; // levels to
  at += 4 + 2 + 10; // volume attributes, file system id, reserved
  assert.equal(at, fixed.length);
  const cnids = Buffer.alloc(cnidPath.length * 4);
  cnidPath.forEach((id, index) => cnids.writeUInt32BE(id, index * 4));
  const body = Buffer.concat([
    tagged(TAG.folderName, Buffer.from(folderName.replace(/:/g, "/"), "utf8")),
    tagged(TAG.highResVolumeDate, hiRes(volumeCreated)),
    tagged(TAG.highResCreationDate, hiRes(fileCreated)),
    tagged(TAG.cnidPath, cnids),
    tagged(TAG.carbonPath, Buffer.from(`${volumeName}:${parts.join(":")}`, "utf8")),
    tagged(TAG.unicodeFilename, unicode(filename)),
    tagged(TAG.unicodeVolumeName, unicode(volumeName)),
    tagged(TAG.posixPath, Buffer.from(`/${parts.join("/")}`, "utf8")),
    tagged(TAG.posixMountPoint, Buffer.from(mountPoint, "utf8")),
    tagged(-1, Buffer.alloc(0)),
  ]);
  const header = Buffer.alloc(8);
  header.writeUInt16BE(8 + fixed.length + body.length, 4);
  header.writeInt16BE(2, 6);
  return Buffer.concat([header, fixed, body]);
}

export function parseAlias(buffer) {
  assert.equal(buffer.readInt16BE(6), 2, "only version 2 aliases are written");
  assert.equal(buffer.readUInt16BE(4), buffer.length, "alias length");
  const pascalAt = (at) => buffer.subarray(at + 1, at + 1 + buffer[at]).toString("utf8");
  const result = { volumeName: pascalAt(10), filename: pascalAt(50), fsType: buffer.subarray(42, 44).toString("ascii"), tags: {} };
  let at = 150;
  while (at + 4 <= buffer.length) {
    const tag = buffer.readInt16BE(at), size = buffer.readUInt16BE(at + 2);
    if (tag === -1) break;
    result.tags[tag] = buffer.subarray(at + 4, at + 4 + size);
    at += 4 + size + (size & 1);
  }
  result.posixPath = result.tags[TAG.posixPath]?.toString("utf8");
  result.carbonPath = result.tags[TAG.carbonPath]?.toString("utf8");
  return result;
}

// ---------------------------------------------------------------------------
// .DS_Store: a buddy-allocated file holding one B-tree of (name, code, value)
// records. A handful of records fit one leaf node.
const compareRecords = (a, b) => {
  const left = a.name.toLowerCase(), right = b.name.toLowerCase();
  if (left !== right) return left < right ? -1 : 1;
  return Buffer.compare(Buffer.from(a.code, "ascii"), Buffer.from(b.code, "ascii"));
};

function encodeRecord({ name, code, type, value }) {
  assert.match(code, /^[\x20-\x7e]{4}$/);
  const utf16 = Buffer.from(name, "utf16le").swap16();
  const head = Buffer.alloc(4); head.writeUInt32BE(utf16.length / 2);
  let data;
  if (type === "long" || type === "shor") { data = Buffer.alloc(4); data.writeUInt32BE(value); }
  else if (type === "bool") data = Buffer.from([value ? 1 : 0]);
  else if (type === "type") { assert.match(value, /^[\x20-\x7e]{4}$/); data = Buffer.from(value, "ascii"); }
  else if (type === "blob") { const size = Buffer.alloc(4); size.writeUInt32BE(value.length); data = Buffer.concat([size, value]); }
  else throw new Error(`Unsupported .DS_Store type ${type}`);
  return Buffer.concat([head, utf16, Buffer.from(code + type, "ascii"), data]);
}

export function dsStore(records) {
  const sorted = [...records].sort(compareRecords);
  const leafHead = Buffer.alloc(8); leafHead.writeUInt32BE(sorted.length, 4); // P = 0: a leaf
  const leaf = Buffer.concat([leafHead, ...sorted.map(encodeRecord)]);
  assert.ok(leaf.length <= 4096, "Finder layout records must fit one B-tree node");

  // Buddy allocation over a 2^31-byte space: split the smallest free block
  // that fits, so the free lists always describe every unused byte.
  const free = Array.from({ length: 32 }, () => []);
  free[31].push(0);
  const allocate = bytes => {
    let width = 5;
    while (1 << width < bytes) width++;
    let have = width;
    while (have < 32 && !free[have].length) have++;
    assert.ok(have < 32, "allocator exhausted");
    free[have].sort((a, b) => a - b);
    const offset = free[have].shift();
    while (have > width) { have--; free[have].push(offset + 2 ** have); }
    return { offset, width, address: offset | width };
  };
  allocate(32); // the file header
  const info = allocate(2048);
  const header = allocate(32);
  const node = allocate(4096);
  const blocks = [info, header, node];

  const dsdb = Buffer.alloc(20);
  dsdb.writeUInt32BE(2, 0); // root node: block 2
  dsdb.writeUInt32BE(0, 4); // no internal levels
  dsdb.writeUInt32BE(sorted.length, 8);
  dsdb.writeUInt32BE(1, 12); // one node
  dsdb.writeUInt32BE(0x1000, 16);

  const parts = [];
  const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value >>> 0); parts.push(b); };
  u32(blocks.length); u32(0);
  for (const block of blocks) u32(block.address);
  for (let index = blocks.length; index % 256; index++) u32(0);
  u32(1); parts.push(Buffer.from([4]), Buffer.from("DSDB", "ascii")); u32(1);
  for (const list of free) { list.sort((a, b) => a - b); u32(list.length); for (const offset of list) u32(offset); }
  const infoBytes = Buffer.concat(parts);
  assert.ok(infoBytes.length <= 2048, "allocator information must fit its block");

  const end = Math.max(...blocks.map(block => block.offset + 2 ** block.width));
  const file = Buffer.alloc(4 + end);
  file.writeUInt32BE(1, 0);
  file.write("Bud1", 4, "ascii");
  file.writeUInt32BE(info.offset, 8);
  file.writeUInt32BE(2048, 12);
  file.writeUInt32BE(info.offset, 16);
  infoBytes.copy(file, 4 + info.offset);
  dsdb.copy(file, 4 + header.offset);
  leaf.copy(file, 4 + node.offset);
  return file;
}

export function readDsStore(file) {
  assert.ok(file.length >= 36 && file.readUInt32BE(0) === 1 && file.toString("ascii", 4, 8) === "Bud1", "not a .DS_Store");
  const infoAt = 4 + file.readUInt32BE(8);
  const count = file.readUInt32BE(infoAt);
  const addresses = Array.from({ length: count }, (_, index) => file.readUInt32BE(infoAt + 8 + index * 4));
  let at = infoAt + 8 + Math.ceil(count / 256) * 256 * 4;
  const toc = {};
  for (let entries = file.readUInt32BE(at), index = 0, cursor = at + 4; index < entries; index++) {
    const length = file[cursor];
    toc[file.toString("ascii", cursor + 1, cursor + 1 + length)] = file.readUInt32BE(cursor + 1 + length);
    cursor += 5 + length;
    at = cursor;
  }
  const block = id => 4 + (addresses[id] & ~31);
  const dsdb = block(toc.DSDB);
  const records = [];
  const readNode = (id, depth) => {
    assert.ok(depth < 8, "malformed .DS_Store tree");
    let cursor = block(id);
    const pointer = file.readUInt32BE(cursor), entries = file.readUInt32BE(cursor + 4);
    cursor += 8;
    for (let index = 0; index < entries; index++) {
      if (pointer) { readNode(file.readUInt32BE(cursor), depth + 1); cursor += 4; }
      const length = file.readUInt32BE(cursor);
      const name = Buffer.from(file.subarray(cursor + 4, cursor + 4 + length * 2)).swap16().toString("utf16le");
      cursor += 4 + length * 2;
      const code = file.toString("ascii", cursor, cursor + 4), type = file.toString("ascii", cursor + 4, cursor + 8);
      cursor += 8;
      let value;
      if (type === "long" || type === "shor") { value = file.readUInt32BE(cursor); cursor += 4; }
      else if (type === "bool") { value = file[cursor] === 1; cursor += 1; }
      else if (type === "type") { value = file.toString("ascii", cursor, cursor + 4); cursor += 4; }
      else if (type === "blob" || type === "ustr") {
        const size = file.readUInt32BE(cursor);
        const bytes = type === "blob" ? size : size * 2;
        value = Buffer.from(file.subarray(cursor + 4, cursor + 4 + bytes));
        if (type === "ustr") value = value.swap16().toString("utf16le");
        cursor += 4 + bytes;
      } else if (type === "comp" || type === "dutc") { value = file.readBigUInt64BE(cursor); cursor += 8; }
      else throw new Error(`Unsupported .DS_Store type ${type}`);
      records.push({ name, code, type, value });
    }
    if (pointer) readNode(pointer, depth + 1);
  };
  readNode(file.readUInt32BE(dsdb), 0);
  return records;
}

// ---------------------------------------------------------------------------
// The records that make Finder open the volume as the install window.
const iconLocation = ({ x, y }) => {
  const value = Buffer.alloc(16);
  value.writeUInt32BE(x, 0); value.writeUInt32BE(y, 4);
  value.writeUInt32BE(0xffffffff, 8); value.writeUInt32BE(0xffff0000, 12);
  return value;
};

export function finderRecords({ appName = "Relay.app", backgroundAlias, layout = DMG_LAYOUT }) {
  const { x, y, width, height } = layout.window;
  return [
    { name: ".", code: "bwsp", type: "blob", value: binaryPlist({
      ContainerShowSidebar: false, PreviewPaneVisibility: false, ShowPathbar: false, ShowSidebar: false,
      ShowStatusBar: false, ShowTabView: false, ShowToolbar: false, SidebarWidth: 0,
      WindowBounds: `{{${x}, ${y}}, {${width}, ${height}}}` }) },
    { name: ".", code: "icvp", type: "blob", value: binaryPlist({
      arrangeBy: "none", backgroundColorBlue: real(layout.backgroundColor[2]), backgroundColorGreen: real(layout.backgroundColor[1]),
      backgroundColorRed: real(layout.backgroundColor[0]),
      backgroundImageAlias: backgroundAlias, backgroundType: 2, gridOffsetX: real(0), gridOffsetY: real(0),
      gridSpacing: real(100), iconSize: real(layout.iconSize), labelOnBottom: true, scrollPositionX: real(0),
      scrollPositionY: real(0), showIconPreview: true, showItemInfo: false, textSize: real(layout.textSize),
      viewOptionsVersion: 1 }) },
    { name: ".", code: "vSrn", type: "long", value: 1 },
    { name: ".", code: "vstl", type: "type", value: "icnv" },
    { name: appName, code: "Iloc", type: "blob", value: iconLocation(layout.app) },
  ];
}

// Writes the background and .DS_Store into a mounted, writable volume.
export function dressVolume({ mount, volumeName, appName = "Relay.app", background = DMG_BACKGROUND, layout = DMG_LAYOUT,
  mountPoint = `/Volumes/${volumeName}` }) {
  const folder = path.join(mount, BACKGROUND_DIRECTORY);
  fs.mkdirSync(folder, { recursive: true });
  const picture = path.join(folder, BACKGROUND_NAME);
  fs.copyFileSync(background, picture);
  const stat = file => fs.statSync(file, { bigint: true });
  const cnid = file => { const ino = stat(file).ino; assert.ok(ino < 2n ** 32n, "catalog id out of range"); return Number(ino); };
  const date = file => new Date(Number(stat(file).birthtimeMs));
  // Finder may resolve by any of these; the mount point recorded is where a
  // person's Mac mounts the volume, not this build's private mount.
  const backgroundAlias = aliasRecord({ volumeName, volumeCreated: date(mount), mountPoint,
    relativePath: `${BACKGROUND_DIRECTORY}/${BACKGROUND_NAME}`, fileCreated: date(picture),
    cnid: cnid(picture), parentCnid: cnid(folder), cnidPath: [cnid(folder)] });
  fs.writeFileSync(path.join(mount, ".DS_Store"), dsStore(finderRecords({ appName, backgroundAlias, layout })));
}

// What a built volume tells Finder, for gates and tests.
export function inspectVolumeLayout(mount, { appName = "Relay.app" } = {}) {
  const records = readDsStore(fs.readFileSync(path.join(mount, ".DS_Store")));
  const find = (name, code) => records.find(record => record.name === name && record.code === code)?.value;
  const position = name => { const value = find(name, "Iloc"); return value && { x: value.readUInt32BE(0), y: value.readUInt32BE(4) }; };
  const icvp = parseBinaryPlist(find(".", "icvp"));
  const bwsp = parseBinaryPlist(find(".", "bwsp"));
  const alias = parseAlias(icvp.backgroundImageAlias);
  const placed = records.filter(record => record.code === "Iloc").map(record => record.name);
  return { records, icvp, bwsp, alias, placed, app: position(appName) };
}

export function assertVolumeLayout(mount, { volumeName = DMG_VOLUME_NAME, layout = DMG_LAYOUT, background = DMG_BACKGROUND, appName = "Relay.app" } = {}) {
  const found = inspectVolumeLayout(mount, { appName });
  const { x, y, width, height } = layout.window;
  assert.deepEqual(found.placed, [appName], "Relay is the only icon in the window");
  assert.deepEqual(found.app, { x: layout.app.x, y: layout.app.y }, "Relay sits in the middle");
  assert.equal(found.app.x, width / 2);
  assert.equal(found.bwsp.WindowBounds, `{{${x}, ${y}}, {${width}, ${height}}}`);
  for (const key of ["ShowToolbar", "ShowStatusBar", "ShowSidebar", "ShowPathbar", "ShowTabView"]) assert.equal(found.bwsp[key], false, key);
  assert.equal(found.icvp.iconSize, layout.iconSize);
  assert.equal(found.icvp.backgroundType, 2, "a background picture");
  assert.equal(found.icvp.arrangeBy, "none");
  assert.equal(found.alias.volumeName, volumeName);
  assert.equal(found.alias.posixPath, `/${BACKGROUND_DIRECTORY}/${BACKGROUND_NAME}`);
  assert.equal(found.alias.carbonPath, `${volumeName}:${BACKGROUND_DIRECTORY}:${BACKGROUND_NAME}`);
  assert.ok(fs.readFileSync(path.join(mount, BACKGROUND_DIRECTORY, BACKGROUND_NAME)).equals(fs.readFileSync(background)), "the committed background");
  // Nothing to drag onto: an Applications link would invite the copy that
  // never opens Relay.
  assert.deepEqual(fs.readdirSync(mount).filter(name => !name.startsWith(".")), [appName], "only Relay is on the volume");
  assert.ok(fs.statSync(path.join(mount, appName)).isDirectory());
  return found;
}

// ---------------------------------------------------------------------------
// Build the compressed installer image from a finished (signed) app.
function hdiutil(args, { run, sleep, produces, attempts = 4 }) {
  // hdiutil intermittently fails with "Resource busy" on hosted macOS runners;
  // the same command succeeds moments later. Any other failure is real.
  for (let attempt = 1; ; attempt++) {
    try { return run("/usr/bin/hdiutil", args); }
    catch (error) {
      if (attempt >= attempts || !/Resource busy|resource temporarily unavailable/i.test(error.message)) throw error;
      if (produces) fs.rmSync(produces, { force: true });
      sleep(10 * attempt);
    }
  }
}

function defaultRun(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 20 * 60_000 });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr || `${command} failed`);
  return result.stdout;
}
const defaultSleep = seconds => spawnSync("sleep", [String(seconds)]);

export function buildMacDmg({ app, output, volumeName = DMG_VOLUME_NAME, layout = DMG_LAYOUT, background = DMG_BACKGROUND,
  run = defaultRun, sleep = defaultSleep, temporary = os.tmpdir() }) {
  if (process.platform !== "darwin") throw new Error("Building a Mac disk image requires macOS");
  assert.ok(path.isAbsolute(app) && app.endsWith(".app"), "app must be an absolute .app path");
  assert.ok(path.isAbsolute(output) && output.endsWith(".dmg") && !fs.existsSync(output), "output must be a new absolute .dmg path");
  const work = fs.mkdtempSync(path.join(fs.realpathSync(temporary), "relay-dmg-"));
  const image = path.join(work, "image"), writable = path.join(work, "writable.dmg"), mount = path.join(work, "mount");
  let attached = false;
  try {
    fs.mkdirSync(image);
    fs.cpSync(app, path.join(image, path.basename(app)), { recursive: true, verbatimSymlinks: true });
    // Room for the picture and .DS_Store beyond what hdiutil sizes for the app.
    const extra = Math.ceil(fs.statSync(background).size / 1_048_576) + 16;
    const megabytes = Math.ceil(Number(run("/usr/bin/du", ["-sk", image]).trim().split(/\s+/)[0]) / 1024 * 1.2) + extra;
    hdiutil(["create", "-volname", volumeName, "-srcfolder", image, "-fs", layout.filesystem, "-format", "UDRW",
      "-size", `${megabytes}m`, writable], { run, sleep, produces: writable });
    fs.mkdirSync(mount);
    hdiutil(["attach", writable, "-readwrite", "-noverify", "-noautoopen", "-nobrowse", "-mountpoint", mount], { run, sleep });
    attached = true;
    dressVolume({ mount, volumeName, appName: path.basename(app), background, layout });
    assertVolumeLayout(mount, { volumeName, layout, background, appName: path.basename(app) });
    fs.rmSync(path.join(mount, ".fseventsd"), { recursive: true, force: true });
    run("/bin/sync", []);
    hdiutil(["detach", mount], { run, sleep });
    attached = false;
    hdiutil(["convert", writable, "-format", "UDZO", "-o", output], { run, sleep, produces: output });
    return output;
  } finally {
    if (attached) spawnSync("/usr/bin/hdiutil", ["detach", mount, "-force"], { timeout: 60_000 });
    fs.rmSync(work, { recursive: true, force: true });
  }
}
