import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { EXAMPLES, WAYS, TITLE, pickWays, titleFor, firstName } = require("../overlay/relay-anyone-tip.cjs");
const ids = (ways) => ways.map((way) => way.id);
const FIRST_FOUR_DONE = { createdShareLink: true, sentToSelf: true, openedReceivedRelay: true, agentListedInbox: true };
// The fixed five gone: the first four used, and Pull your work together read.
const FIRST_FIVE_GONE = { ...FIRST_FOUR_DONE, readPullTogether: true };
const prompts = (ways) => Object.fromEntries(ways.map((way) => [way.id, way.prompt]));

test("a new account, or a server that reports nothing, gets the fixed five", () => {
  for (const usage of [undefined, null, {}, { sentWithAttachments: false, receivedWithAttachments: false, openedReceivedAttachments: false }]) {
    assert.deepEqual(ids(pickWays(usage)), ids(EXAMPLES));
    assert.equal(titleFor(pickWays(usage)), TITLE);
  }
  assert.equal(titleFor(EXAMPLES), TITLE, "the fixed card keeps its title");
});

test("pull your work together is shown once: read on this card, or read for the account", () => {
  assert.equal(WAYS.find((way) => way.id === "pull_together").once, true);
  assert.ok(ids(pickWays(FIRST_FOUR_DONE)).includes("pull_together"));
  assert.ok(!ids(pickWays(FIRST_FOUR_DONE, {}, new Set(["pull_together"]))).includes("pull_together"), "read on this card");
  assert.ok(!ids(pickWays({ ...FIRST_FOUR_DONE, readPullTogether: true })).includes("pull_together"), "read on any of the account's computers");
  assert.ok(ids(pickWays(FIRST_FOUR_DONE, {}, new Set(["send_files"]))).includes("send_files"), "only a once way is retired by reading it");
});

test("a way retires once used and the next most useful takes its place", () => {
  assert.deepEqual(ids(pickWays({ createdShareLink: true })), ["pick_up", "carry_on", "check_inbox", "pull_together", "send_files"]);
  assert.equal(titleFor(pickWays({ createdShareLink: true })), "Five more ways to use Relay");
  assert.deepEqual(ids(pickWays(FIRST_FOUR_DONE)), ["pull_together", "send_files", "ask_question", "ask_feedback", "hand_over"]);
  assert.deepEqual(ids(pickWays(FIRST_FIVE_GONE)), ["send_files", "ask_question", "ask_feedback", "hand_over", "relay_group"]);
});

test("working with received files is offered only to someone who has received files", () => {
  assert.ok(!ids(pickWays(FIRST_FOUR_DONE)).includes("use_files"));
  assert.deepEqual(ids(pickWays({ ...FIRST_FIVE_GONE, receivedWithAttachments: true })).slice(0, 2), ["send_files", "use_files"]);
  assert.ok(!ids(pickWays({ ...FIRST_FOUR_DONE, receivedWithAttachments: true, openedReceivedAttachments: true })).includes("use_files"));
});

test("asking labels retire their ways", () => {
  const asked = pickWays({ ...FIRST_FIVE_GONE, sentAsks: { answer: true, feedback: true, handover: true, action: false } });
  assert.deepEqual(ids(asked), ["send_files", "relay_group", "forward", "send_task"]);
  assert.equal(titleFor(asked), "Four more ways to use Relay");
  assert.ok(!ids(pickWays({ ...FIRST_FOUR_DONE, askedQuestion: true })).includes("ask_question"));
});

test("the title counts what is left, and nothing left means nothing to show", () => {
  const everything = {
    ...FIRST_FIVE_GONE, sentWithAttachments: true, askedQuestion: true,
    sentAsks: { answer: true, feedback: true, handover: true, action: true }, sentToGroup: true, forwarded: true,
  };
  assert.deepEqual(ids(pickWays(everything)), ["send_task"]);
  assert.equal(titleFor(pickWays(everything)), "One more way to use Relay");
  assert.equal(titleFor(pickWays({ ...everything, sentTask: true, forwarded: false, sentToGroup: false })), "Two more ways to use Relay");
  assert.deepEqual(pickWays({ ...everything, sentTask: true }), []);
});

test("carry on names whoever is waiting for the person's agent", () => {
  const usage = { createdShareLink: true, examples: { unopenedFrom: "Dylan Maltman" } };
  const carryOn = pickWays(usage).find((way) => way.id === "carry_on");
  assert.equal(carryOn.prompt, "Open the Relay from Dylan and carry on the work here.");
  assert.equal(carryOn.result, "Dylan’s notes become your agent’s starting point, so nobody has to re-explain.");
  assert.equal(pickWays({}).find((way) => way.id === "carry_on").prompt, EXAMPLES[2].prompt, "nobody waiting keeps the made-up example");
  const files = pickWays({ ...FIRST_FIVE_GONE, receivedWithAttachments: true, examples: { unopenedFilesFrom: "priya@example.com" } });
  assert.equal(files.find((way) => way.id === "use_files").prompt, "Open the files Priya sent me and tell me what matters in them.");
});

test("ways that address someone take the person's own people in turn", () => {
  const people = { recent: ["Jonty Quenet", "Girish Budhrani", "Jonty Q"], lastSender: "Aron van Ammers" };
  const own = prompts(pickWays(FIRST_FIVE_GONE, people));
  assert.deepEqual(own, {
    send_files: "Relay Jonty the files in this folder.",
    ask_question: "Ask Girish whether this can wait until next week.",
    ask_feedback: "Relay Jonty this draft and ask what they would change.",
    hand_over: "Relay this to Girish so they can finish it tomorrow.",
    relay_group: "Relay the launch team where the pricing page stands.",
  }, "names repeat only once everyone has had a turn; a group stays made up");
  const later = prompts(pickWays({ ...FIRST_FIVE_GONE, sentAsks: { answer: true, feedback: true, handover: true, action: false } }, people));
  assert.equal(later.forward, "Forward Aron’s last Relay to Girish and ask them to take a look.");
  assert.equal(later.send_task, "Send Jonty a Task to review this by Friday.");
  const alone = prompts(pickWays({ ...FIRST_FIVE_GONE, sentAsks: { answer: true, feedback: true, handover: true, action: false } }, { recent: ["Aron"], lastSender: "Aron" }));
  assert.equal(alone.forward, WAYS.find((way) => way.id === "forward").prompt, "nobody to forward to but the sender keeps the made-up example");
  assert.equal(prompts(pickWays(FIRST_FIVE_GONE, { recent: [] })).send_files, WAYS.find((way) => way.id === "send_files").prompt);
});

test("a prompt names people by first name, never by address", () => {
  assert.equal(firstName("Dylan Maltman"), "Dylan");
  assert.equal(firstName("shara.miran@example.com"), "Shara");
  assert.equal(firstName("Someone"), "");
  assert.equal(firstName("Relay Agent"), "");
  assert.equal(firstName(""), "");
});

test("every way is a prompt a person would type, with its own id the API accepts", () => {
  assert.equal(new Set(ids(WAYS)).size, WAYS.length);
  const route = fs.readFileSync(new URL("../../../apps/api/src/routes/v1.ts", import.meta.url), "utf8");
  const people = { recent: ["Ann", "Ben"], lastSender: "Cal" };
  const usage = { receivedWithAttachments: true, examples: { unopenedFrom: "Dee", unopenedFilesFrom: "Eve" } };
  for (const way of [...WAYS, ...WAYS.map((way) => (way.personal ? { ...way, ...way.personal({ ...usage, waiting: "Dee", waitingFiles: "Eve", lastSender: "Cal", next: () => "Ann" }) } : way))]) {
    assert.doesNotMatch(way.prompt, /include (all|everything)|summary/i, way.id);
    assert.ok(way.way && way.prompt && way.result, way.id);
    assert.match(route, new RegExp(`"${way.id}"`), `the onboarding events route accepts ${way.id}`);
  }
  assert.ok(pickWays(usage, people).length > 0);
});
