// Send-time scan for links that will not survive the trip to the recipient.
//
// Two families, one symptom (the recipient clicks and gets a login wall, a 404,
// or an expired signature — and tells the sender Relay is broken):
//
//   1. Provider-scoped links: claude.ai artifacts/chats, ChatGPT canvases,
//      private Notion pages. Scoped to the SENDER's account; the recipient's
//      browser has no session that can see them.
//   2. Relay's own signed /storage URLs: valid for anyone, but only for ~15
//      minutes — long dead by the time a person reads the message.
//
// Advisory by design, sibling to attachments.js's refuse-and-warn model but
// softer: the send is never blocked (agents attach public links in legitimate
// shapes we cannot enumerate), the warning rides back on the send result's
// agentInstruction so the agent can repair the message it just sent — attach
// the file, or paste the content — while the moment is still live.

const FRAGILE_LINK_RULES = [
  {
    kind: "claude",
    // claude.ai/public/* artifacts are the one shareable shape; everything
    // else under claude.ai is account-scoped.
    test: (url) => /^https?:\/\/(?:www\.)?claude\.ai\//i.test(url) && !/claude\.ai\/public\//i.test(url),
    describe: (url) => `${url} is a Claude link scoped to YOUR account — the recipient will hit a login wall or a 404.`,
  },
  {
    kind: "chatgpt",
    // chatgpt.com/share/* links are published; canvases and chats are not.
    test: (url) =>
      /^https?:\/\/(?:www\.)?(?:chatgpt\.com|chat\.openai\.com)\//i.test(url) &&
      !/(?:chatgpt\.com|chat\.openai\.com)\/share\//i.test(url),
    describe: (url) => `${url} is a ChatGPT link scoped to YOUR account — the recipient will hit a login wall.`,
  },
  {
    kind: "notion",
    // notion.site is Notion's publish-to-web domain and is genuinely public;
    // notion.so pages are workspace-scoped unless shared, which we can't see.
    test: (url) => /^https?:\/\/(?:www\.)?notion\.so\//i.test(url),
    describe: (url) => `${url} is a Notion workspace link — it only opens for the recipient if that page is explicitly shared with them.`,
  },
  {
    kind: "signed-storage",
    test: (url) => /\/storage\/[^\s]*[?&](?:sig|expires)=/i.test(url),
    describe: (url) => `${url} is a signed Relay storage URL that expires in minutes — it will be dead when the recipient reads this.`,
  },
];

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

/** Every fragile link in a markdown body, with why it is fragile. */
export function scanFragileLinks(forHuman) {
  const body = String(forHuman || "");
  const findings = [];
  const seen = new Set();
  for (const match of body.matchAll(URL_RE)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    for (const rule of FRAGILE_LINK_RULES) {
      if (rule.test(url)) {
        findings.push({ kind: rule.kind, url, message: rule.describe(url) });
        break;
      }
    }
  }
  return findings;
}

/**
 * The agentInstruction paragraph for a body's fragile links, or "" when clean.
 * Attaching the file is the remedy we point at: attachments download locally
 * on the recipient's machine and carry durable links everywhere else.
 */
export function fragileLinkWarning(forHuman) {
  const findings = scanFragileLinks(forHuman);
  if (!findings.length) return "";
  const details = findings.map((f) => f.message).join(" ");
  return (
    `WARNING — this message contains ${findings.length === 1 ? "a link" : "links"} the recipient likely cannot open: ${details} ` +
    "The message was still sent. Repair it now: send a follow-up that attaches the actual file (relay_send's attachments) " +
    "or pastes the relevant content, instead of the link."
  );
}
