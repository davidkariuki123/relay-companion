import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const overlaySource = fs.readFileSync(path.resolve(here, "../overlay/main.cjs"), "utf8");
const materializerSource = fs.readFileSync(path.resolve(here, "../src/materializer.js"), "utf8");

test("standalone overlay migrates durable content before its first window payload", () => {
  const ready = overlaySource.indexOf("app.whenReady().then(async () =>");
  const migrate = overlaySource.indexOf("migration.migratePersistedContentFields", ready);
  const window = overlaySource.indexOf("createWindow();", ready);
  assert.ok(ready >= 0 && migrate > ready && window > migrate, "migration must complete before createWindow");
});

test("direct materialization migrates historical snapshots before row resolution", () => {
  const open = materializerSource.indexOf("export async function openRelay");
  const migrate = materializerSource.indexOf("migratePersistedContentFields({ log });", open);
  const resolve = materializerSource.indexOf("await resolveRow(id", open);
  assert.ok(open >= 0 && migrate > open && resolve > migrate, "migration must precede resolveRow");
});
