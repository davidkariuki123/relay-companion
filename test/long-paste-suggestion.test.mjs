import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

function between(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function loadClassifier() {
  const source = between(
    html,
    "  const LONG_PASTE_MIN_CHARACTERS",
    "  function longPasteRecipient",
  );
  return Function(`${source}\nreturn { longPasteSentenceCount, longPasteStats, shouldSuggestRelayForPaste };`)();
}

test("long pasted prose crosses the Relay suggestion threshold", () => {
  const { shouldSuggestRelayForPaste } = loadClassifier();
  const prose = [
    "This is the first complete sentence with enough context to be useful.",
    "This is the second complete sentence with another implementation detail.",
    "This is the third complete sentence explaining the environment involved.",
    "This is the fourth complete sentence describing what was already tried.",
    "This is the fifth complete sentence explaining the remaining problem.",
  ].join(" ");
  const result = shouldSuggestRelayForPaste(prose);
  assert.equal(result.sentences, 5);
  assert.ok(result.characters >= 240);
  assert.equal(result.suggest, true);
});
test("short pastes stay ordinary text while very large structured pastes still qualify", () => {
  const { shouldSuggestRelayForPaste } = loadClassifier();
  const fourSentences = "One short sentence. Two short sentences. Three short sentences. Four short sentences.";
  assert.equal(shouldSuggestRelayForPaste(fourSentences).suggest, false);
  assert.equal(shouldSuggestRelayForPaste("x".repeat(899)).suggest, false);
  assert.equal(shouldSuggestRelayForPaste("x".repeat(900)).suggest, true);
});

test("only human composer paste events can open the anchored suggestion", () => {
  const dress = between(html, "  function dressComposer(field, onSend)", "  let readerSource");
  const paste = between(dress, 'field.addEventListener("paste"', 'field.addEventListener("dragover"');
  assert.match(paste, /field\.matches\("#qrInput, #thQrInput"\)/);
  assert.match(paste, /clipboardData\?\.getData\("text\/plain"\)/);
  assert.match(paste, /showLongPastePrompt\(field, pastedText, stats\)/);
  assert.doesNotMatch(between(dress, 'field.addEventListener("input"', "requestAnimationFrame(grow)"), /showLongPastePrompt/);
});

test("candidate B uses Relay's anchored popover and the approved copy", () => {
  assert.match(html, /\.long-paste-prompt \{ position:absolute; left:0; right:0; bottom:calc\(100% \+ 7px\);/);
  assert.match(html, /box-shadow:0 12px 30px color-mix\(in srgb, #000 18%, transparent\)/);
  assert.match(html, /This belongs in a Relay/);
  assert.match(html, /Ask Claude or Codex to send it to \$\{recipient\} as a Relay, which will be easier for them to go through\./);
  assert.match(html, /Copy for my agent/);
  assert.match(html, /Keep as text/);
  assert.match(html, /Send this to \$\{recipient\} as a Relay:\\n\\n\$\{draft\}/);
  assert.match(html, /input\.relayLongPasteParty = replyChat\.party/);
  assert.match(html, /thQrInput\.relayLongPasteParty = thread\.groupName \|\| thread\.party/);
});
