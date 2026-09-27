import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fetchAttachments } from "../src/fetch-attachments.js";
import { toolsForAccount } from "../src/mcp.js";

const body = Buffer.from("original attachment bytes");
const digest = createHash("sha256").update(body).digest("hex");
const metadata = id => ({ file: { id, filename: "../../same.docx", sizeBytes: body.length, sha256: digest }, downloadUrl: `https://files.example/${id}` });
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "relay-fetch-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("downloads concurrently, verifies originals, sanitizes paths and never overwrites", async t => {
  const root = await directory(t);
  let active = 0, peak = 0;
  const client = { fileDownload: async id => metadata(id) };
  const options = { root, fetchImpl: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 15));
    active--; return new Response(body);
  } };
  const result = await fetchAttachments(client, ["a", "b", "c", "d", "e", "a"], options);
  assert.equal(result.downloaded, 5);
  assert.equal(result.failed, 0);
  assert.equal(peak, 4);
  for (const file of result.files) {
    assert.equal(path.dirname(file.localPath), result.directory);
    assert.equal(file.verification, "size_and_sha256");
    assert.deepEqual(await fs.readFile(file.localPath), body);
  }
  const again = await fetchAttachments(client, ["a"], options);
  assert.notEqual(again.directory, result.directory);
});

test("expired URLs are refreshed once; other files survive a checksum or size failure", async t => {
  const root = await directory(t);
  const calls = new Map();
  const client = { fileDownload: async id => {
    const count = (calls.get(id) || 0) + 1; calls.set(id, count);
    return { ...metadata(id), downloadUrl: `https://files.example/${id}/${count}` };
  } };
  const result = await fetchAttachments(client, ["expired", "corrupt", "too-long", "denied"], { root, fetchImpl: async url => {
    if (url.pathname === "/expired/1") return new Response("expired", { status: 403 });
    if (url.pathname.startsWith("/corrupt/")) return new Response(Buffer.alloc(body.length));
    if (url.pathname.startsWith("/too-long/")) return new Response(Buffer.alloc(body.length + 1));
    if (url.pathname.startsWith("/denied/")) return new Response("missing", { status: 404 });
    return new Response(body);
  } });
  assert.equal(calls.get("expired"), 2);
  assert.equal(calls.get("denied"), 1);
  assert.equal(result.downloaded, 1);
  assert.deepEqual(result.files.slice(1).map(f => f.code), ["checksum_mismatch", "size_mismatch", "download_http_404"]);
  assert.equal((await fs.readdir(result.directory)).length, 1, "no partial or corrupt files retained");
});

test("access failures, oversize files and absent checksums are reported honestly", async t => {
  const root = await directory(t);
  const result = await fetchAttachments({ fileDownload: async id => {
    if (id === "forbidden") throw new Error("secret URL should not escape");
    const data = metadata(id);
    if (id === "huge") data.file.sizeBytes = 201 * 1024 * 1024;
    if (id === "legacy") data.file.sha256 = null;
    return data;
  } }, ["forbidden", "huge", "legacy"], { root, fetchImpl: async () => new Response(body) });
  assert.equal(result.failed, 2);
  assert.equal(result.files[1].code, "download_limit_exceeded");
  assert.equal(result.files[2].verification, "size_only_no_source_checksum");
  assert.doesNotMatch(JSON.stringify(result), /secret URL/);
});

test("ordinary accounts discover both local save and URL-only tools", () => {
  const tools = toolsForAccount({ requests: false }, "codex");
  assert.ok(tools.some(tool => tool.name === "relay_files_fetch"));
  assert.ok(tools.some(tool => tool.name === "relay_file_download"));
});
