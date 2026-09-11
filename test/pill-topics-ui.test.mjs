// The pill's Topics tab: invite-only boards kept in sync by members' agents
// under a versioned mandate. These pin the three layers the pill carries
// (RelayClient → preload bridge → main proxy → renderer) the way the channel
// pane's test does, plus the rules that make Topics safe: the developer gate,
// server-truth re-rendering, the human read watermark, the two lanes, and the
// re-approval banner after a mandate edit.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { RelayClient } from "../src/client.js";

const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");
const preload = fs.readFileSync(new URL("../overlay/preload.cjs", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");

test("RelayClient carries the complete topic surface", () => {
  const c = new RelayClient({ url: "https://example.test", token: "t" });
  for (const m of [
    "topics", "topic", "createTopic", "updateTopic", "archiveTopic", "inviteToTopic", "approveTopicMandate",
    "declineTopicInvite", "leaveTopic", "updateTopicMembership", "markTopicSeen", "setTopicMemberRole",
    "removeTopicMember", "topicPosts", "createTopicPost", "updateTopicPost", "deleteTopicPost", "replyToTopicPost",
  ]) {
    assert.equal(typeof c[m], "function", `RelayClient.${m}`);
  }
});

test("preload bridges every topic operation", () => {
  for (const bridge of [
    'topicsList: () => ipcRenderer.invoke("relay:topicsList")',
    'topicGet: (id) => ipcRenderer.invoke("relay:topicGet", String(id || ""))',
    'topicCreate: (input = {}) => ipcRenderer.invoke("relay:topicCreate", input || {})',
    'topicUpdate: (id, input = {}) => ipcRenderer.invoke("relay:topicUpdate", String(id || ""), input || {})',
    'topicInvite: (id, recipient = {}) => ipcRenderer.invoke("relay:topicInvite", String(id || ""), recipient || {})',
    'topicApprove: (id, mandateVersion) => ipcRenderer.invoke("relay:topicApprove", String(id || ""), Number(mandateVersion))',
    'topicDecline: (id) => ipcRenderer.invoke("relay:topicDecline", String(id || ""))',
    'topicLeave: (id) => ipcRenderer.invoke("relay:topicLeave", String(id || ""))',
    'topicSeen: (id) => ipcRenderer.invoke("relay:topicSeen", String(id || ""))',
    'topicMemberRemove: (id, userId) => ipcRenderer.invoke("relay:topicMemberRemove", String(id || ""), String(userId || ""))',
    'topicPosts: (id, input = {}) => ipcRenderer.invoke("relay:topicPosts", String(id || ""), input || {})',
    'topicPostCreate: (id, input = {}) => ipcRenderer.invoke("relay:topicPostCreate", String(id || ""), input || {})',
    'topicPostReply: (id, postId, input = {}) => ipcRenderer.invoke("relay:topicPostReply", String(id || ""), String(postId || ""), input || {})',
    'topicPostDelete: (id, postId) => ipcRenderer.invoke("relay:topicPostDelete", String(id || ""), String(postId || ""))',
  ]) {
    assert.ok(preload.includes(bridge), bridge);
  }
});

test("main proxies topic calls through the API client behind the developer gate", () => {
  assert.match(main, /const topicCall = async \(fn\) => \{[\s\S]*?PRODUCT_FEATURES\.topics !== true[\s\S]*?return groupCall\(fn\);/);
  for (const h of [
    "relay:topicsList", "relay:topicGet", "relay:topicCreate", "relay:topicUpdate", "relay:topicArchive", "relay:topicInvite",
    "relay:topicApprove", "relay:topicDecline", "relay:topicLeave", "relay:topicMembership", "relay:topicSeen",
    "relay:topicMemberRole", "relay:topicMemberRemove", "relay:topicPosts", "relay:topicPostCreate", "relay:topicPostDelete",
    "relay:topicPostReply",
  ]) {
    assert.ok(main.includes(`ipcMain.handle("${h}"`), h);
  }
  // A person's own post serves both lanes: the typed text is the agent context too.
  assert.match(main, /forAgent: String\(input\?\.forAgent \|\| input\?\.forHuman \|\| ""\)/);
});

test("the renderer keeps Topics on the developer row and out of Relay unread", () => {
  assert.match(html, /<button class="tab" type="button" data-view="topics">Topics <span class="tab-badge amber gone" id="topicsBadge">0<\/span><\/button>/);
  assert.match(html, /view === "topics" && payload\.features\?\.topics !== true/);
  assert.match(html, /if \(payload\.features\?\.topics !== true && activeView === "topics"\) \{\s*activeView = "relays";/);
  assert.match(html, /if \(activeView === "topics" && payload\.features\?\.topics === true && viewChanged\) loadTopics\(\);/);
  // The badge is attention (invites, re-approvals, others' posts since the last
  // open), never Relay unread.
  assert.match(html, /setBadge\(topicsBadgeEl, payload\.features\?\.topics === true \? topicsAttentionCount\(\) : 0\);/);
  assert.match(html, /function topicsAttentionCount\(\)[\s\S]*?m\.state === "invited"[\s\S]*?m\.mandateCurrent === false[\s\S]*?newPostCount/);
  assert.doesNotMatch(html.slice(html.indexOf("const relayUnreadIds = new Set("), html.indexOf("setCount(unread);")), /topic/);
});

test("opening a topic is the one human read; agents never move it", () => {
  const open = html.slice(html.indexOf("async function openTopic(id)"), html.indexOf("async function loadTopicPosts("));
  assert.match(open, /window\.relay\.topicGet, id/);
  assert.match(open, /if \(m\.state !== "active" \|\| m\.mandateCurrent !== true\) return;/);
  assert.match(open, /window\.relay\.topicSeen, id/);
  // Lanes: people by default, agents one tap away, agent-only posts hidden from the people lane.
  assert.match(html, /lane:"human"/);
  assert.match(html, /data-topic-lane="human">People<\/button>[\s\S]*?data-topic-lane="agent">Agents<\/button>/);
  assert.match(html, /topicsState\.lane === "agent" \? topicsState\.posts : topicsState\.posts\.filter\(\(p\) => String\(p\.forHuman \|\| ""\)\.trim\(\)\)/);
  assert.match(html, /<div class="tp-post-body agent">\$\{esc\(p\.forAgent \|\| ""\)\}<\/div>/);
});

test("invitation and re-approval are one act on the exact mandate version, and mutations re-render from server truth", () => {
  assert.match(html, /invited you to “\$\{esc\(d\.name\)\}”\.<\/strong>Joining lets your agent read this board and post to it under this mandate/);
  assert.match(html, /data-topic-approve="\$\{Number\(d\.mandateVersion\)\}">Join under this mandate<\/button>/);
  assert.match(html, /The mandate changed[\s\S]*?Your agent is paused on this topic until you approve version \$\{Number\(d\.mandateVersion\)\}/);
  assert.match(html, /data-topic-approve="\$\{Number\(d\.mandateVersion\)\}">Approve and continue<\/button>/);
  assert.match(html, /Saving a changed mandate pauses every other member's agent until they approve it\./);
  assert.match(html, /const applyDetail = \(result\) => \{ topicsState\.detail = result;[\s\S]*?mergeTopicSummary\(result\); renderTopics\(\); \};/);
  // Admin tools: invite picker on the server contact book minus current members; remove; role.
  assert.match(html, /topicCall\(window\.relay\.contactsSearch, q\)/);
  assert.match(html, /filter\(\(match\) => match\.contactId && !\(match\.relayUserId && existing\.has\(match\.relayUserId\)\)\)/);
  assert.match(html, /window\.relay\.topicInvite, id, \{ contactId: button\.getAttribute\("data-topic-invite-pick"\) \}/);
  assert.match(html, /data-topic-remove="\$\{esc\(m\.relayUserId\)\}">Remove<\/button>/);
  // Leaving and archiving are two-tap armed; posts are only ever soft-deleted.
  assert.match(html, /Really archive\? Posts stay/);
  assert.match(html, /data-topic-leave-confirm>Leave topic<\/button>/);
  assert.match(html, /Really delete\?/);
  // Nature is chosen per post; the composer says what a bare fact is.
  assert.match(html, /Only an event is a bare fact; everything else is your take, your plan, or your question\./);
  assert.match(html, /const TOPIC_NATURES = \["event", "decision", "plan", "finding", "opinion", "question"\];/);
});

test("the four standing rules are a feature of every topic, rendered from the shared list, never mandate text", () => {
  const rules = fs.readFileSync(new URL("../src/topic-standing-rules.cjs", import.meta.url), "utf8");
  for (const phrase of ["act differently knowing it", "actually happened is an event", "edit an earlier post rather than repeating it", "Respect members' privacy", "post it, then report to the person", "say nothing about topics"]) {
    assert.ok(rules.includes(phrase), phrase);
  }
  assert.match(main, /topicStandingRules: require\("\.\.\/src\/topic-standing-rules\.cjs"\)/);
  assert.match(html, /function topicStandingRulesHtml\(\)[\s\S]*?payload\.ui\?\.topicStandingRules/);
  assert.match(html, /placeholder="The mandate: what this topic is about, in a sentence or two\. The rules every topic has are below; no need to repeat them\."/);
  // Joined: the rules sit on the Mandate face under the mandate itself, headed
  // "Default behavior". Invited: they sit under the invitation, no faces yet.
  assert.match(html, /<strong>Default behavior<\/strong>/);
  assert.doesNotMatch(html, /<strong>Every topic<\/strong>/);
  assert.match(html, /topicsState\.pane === "mandate" \? `\$\{mandateBlock\}\$\{topicStandingRulesHtml\(\)\}\$\{settings\}`/);
  assert.match(html, /: `\$\{topicStandingRulesHtml\(\)\}\$\{topicMembersHtml\(d\)\}`;/);
});

test("an open topic has three faces — Messages, Members, Mandate — and the lanes live only on Messages", () => {
  assert.match(html, /const tabs = \[\["messages", "Messages"\], \["members", "Members"\], \["mandate", "Mandate"\]\];/);
  assert.match(html, /pane:"messages",/);
  assert.match(html, /on\("\[data-topic-pane\]", \(el\) => \{ topicsState\.pane = el\.getAttribute\("data-topic-pane"\) \|\| "messages"; renderTopics\(\); \}\);/);
  // Every face is chosen by pane; members (with leave/archive) and mandate (with
  // the agent-posting setting) never render on the Messages face.
  assert.match(html, /topicsState\.pane === "members" \? `\$\{topicMembersHtml\(d\)\}\$\{leave\}`/);
  assert.match(html, /: `\$\{current \? topicComposeHtml\(\) : ""\}\$\{notice\}\$\{lanes\}\$\{posts\}\$\{more\}`\)/);
  // Opening another topic lands on Messages again.
  assert.match(html, /Object\.assign\(topicsState, \{ openId:id,[^\n]*pane:"messages", replying:null, notice:"" \}\);/);
});

test("a post offers Reply in topic and Reply privately; either way the author gets a Relay quoting the post", () => {
  // The two verbs sit next to Delete, only on someone else's post, never on an archived board.
  assert.match(html, /const canReply = Boolean\(p\.author\?\.relayUserId\) && !mine && !detail\?\.archivedAt;/);
  assert.match(html, /data-topic-reply="\$\{esc\(p\.id\)\}" data-mode="topic">Reply in topic<\/button>/);
  assert.match(html, /data-topic-reply="\$\{esc\(p\.id\)\}" data-mode="private">Reply privately<\/button>/);
  assert.match(html, /data-topic-post-delete="\$\{esc\(p\.id\)\}">Delete<\/button>/);
  // One inline box, keyed once when it opens so a retry replays rather than duplicates.
  assert.match(html, /idempotencyKey: same \? topicsState\.replying\.idempotencyKey : `pill-topic-reply:\$\{postId\}/);
  assert.match(html, /topicCall\(window\.relay\.topicPostReply, id, postId, \{\s*mode, forHuman: body, forAgent: body,/);
  // The server does both halves; main passes the mode through and refreshes the
  // sent cache so the Relay shows in the room with the author.
  assert.match(main, /ipcMain\.handle\("relay:topicPostReply", async \(_e, id, postId, input\) => \{[\s\S]*?c\.replyToTopicPost\(id, postId, \{\s*mode: input\?\.mode === "topic" \? "topic" : "private",/);
  assert.match(main, /if \(result && result\.ok && result\.result && result\.result\.relay\) refreshSent\(\)\.catch\(\(\) => \{\}\);/);
  // A board post answering another quotes it; the quote survives a takedown.
  assert.match(html, /Replying to \$\{esc\(p\.inReplyTo\.author\?\.name \|\| "a post"\)\}\$\{p\.inReplyTo\.deleted \? " · post deleted" : ""\}/);
});

test("a room quotes the Topic post a Relay answers, from the server's snapshot, and the quote opens the board", () => {
  assert.match(html, /const topicPost = message && message\.inReplyToTopicPost;/);
  assert.match(html, /Replying to \$\{esc\(whose\)\} in \$\{esc\(topicPost\.topicName \|\| "a topic"\)\}/);
  assert.match(html, /data-topic-jump="\$\{esc\(topicPost\.topicId \|\| ""\)\}"/);
  assert.match(html, /function openTopicFromRoom\(topicId\) \{[\s\S]*?document\.querySelector\('\.tab\[data-view="topics"\]'\)\?\.click\(\);\s*openTopic\(topicId\);/);
  // The snapshot rides every row shape the room is built from, and repaints when it changes.
  for (const carrier of [
    'inReplyToTopicPost: r.inReplyToTopicPost || null,',
    'inReplyToTopicPost: s.inReplyToTopicPost || null,',
    'inReplyToTopicPost: item.inReplyToTopicPost || null,',
    'inReplyToTopicPost:item?.inReplyToTopicPost || null,',
    'item.inReplyToTopicPost ? item.inReplyToTopicPost.postId : "", item.state,',
  ]) assert.ok(html.includes(carrier), carrier);
  for (const carrier of [
    'inReplyToTopicPost: packet.inReplyToTopicPost || null,',
    'inReplyToTopicPost: p.inReplyToTopicPost && typeof p.inReplyToTopicPost === "object" ? p.inReplyToTopicPost : null,',
    'inReplyToTopicPost: packet.inReplyToTopicPost || local.inReplyToTopicPost || null,',
    'r.inReplyToTopicPost ? r.inReplyToTopicPost.postId : "",',
  ]) assert.ok(main.includes(carrier), carrier);
});
