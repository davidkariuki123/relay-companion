import test from "node:test";
import assert from "node:assert/strict";
import { fragileLinkWarning, scanFragileLinks } from "../src/links.js";

test("account-scoped provider links are flagged", () => {
  const body = [
    "Board: https://claude.ai/code/artifact/abc123",
    "Chat: https://chatgpt.com/c/6789",
    "Notes: https://www.notion.so/team/Design-Doc-42",
  ].join("\n");
  const findings = scanFragileLinks(body);
  assert.deepEqual(findings.map((f) => f.kind), ["claude", "chatgpt", "notion"]);
  const warning = fragileLinkWarning(body);
  assert.match(warning, /WARNING/);
  assert.match(warning, /attach/i);
});

test("published/public shapes of the same providers are NOT flagged", () => {
  const body = [
    "Public artifact: https://claude.ai/public/artifacts/abc123",
    "Shared chat: https://chatgpt.com/share/xyz",
    "Published page: https://acme.notion.site/roadmap",
    "Repo: https://github.com/owner/repo/pull/1",
  ].join("\n");
  assert.deepEqual(scanFragileLinks(body), []);
  assert.equal(fragileLinkWarning(body), "");
});

test("Relay's own signed storage URLs are flagged as expiring", () => {
  const body =
    "grab it here https://api.sendrelays.com/storage/relays/relay_1/board.html?op=get&expires=123&sig=abc";
  const findings = scanFragileLinks(body);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "signed-storage");
  assert.match(fragileLinkWarning(body), /expires in minutes/);
});

test("duplicate URLs are reported once; trailing punctuation is trimmed", () => {
  const body = "see https://claude.ai/chat/1, then again https://claude.ai/chat/1.";
  const findings = scanFragileLinks(body);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].url, "https://claude.ai/chat/1");
});

test("a clean body yields no warning at all", () => {
  assert.equal(fragileLinkWarning("Just prose, and https://example.com/docs."), "");
  assert.equal(fragileLinkWarning(""), "");
});
