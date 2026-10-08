import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../overlay/inbox.html", import.meta.url), "utf8");
const main = fs.readFileSync(new URL("../overlay/main.cjs", import.meta.url), "utf8");

test("Contacts is one view: a field that finds and adds, Groups, then People", () => {
  assert.match(html, /data-view="contacts">Contacts <span class="tab-badge gone" id="peopleBadge"/);
  const view = html.slice(html.indexOf('<section class="view hidden" id="contactsView">'), html.indexOf('id="cvBlockedPage"'));
  // One field at the top, then the find row it answers into.
  assert.match(view, /<input id="cvSearch" type="search" placeholder="Search, or add by email"/);
  assert.match(view, /class="cv-find" id="cvFind" aria-live="polite"/);
  // Groups come first with their own creation verb, then People.
  assert.match(view, /id="cvgHead"><span class="cv-section-label">Groups<\/span><button class="cv-section-verb" type="button" id="cvgNew">New group<\/button>/);
  assert.match(view, /id="cvgMore" hidden/);
  assert.match(view, /id="cvPeopleHead"><span class="cv-section-label">People<\/span>/);
  assert.ok(view.indexOf('id="cvSearch"') < view.indexOf('id="cvGroups"'));
  assert.ok(view.indexOf('id="cvGroups"') < view.indexOf('id="cvPeopleHead"'));
  assert.ok(view.indexOf('id="cvPeopleHead"') < view.indexOf('id="cvList"'));
  // The segmented switch, the shared New menu and the old add sheet are gone.
  for (const gone of ["cvSegPeople", "cvSegGroups", "cvNew", "cvNewMenu", "cvNewContact", "cvCreateActions", "cvAddSheet", "cvAddInput", "cvAdd", "cvAddHome", "cvLatent", "cvBlockedEntry", "cvBlockedPeople"]) {
    assert.doesNotMatch(html, new RegExp(`id="${gone}"`), `${gone} is part of the old Contacts design`);
  }
  assert.doesNotMatch(html, /\bcontactsPane\b|function openAddSheet|function moveAddButton/);
});

test("People rows are names A–Z with colored identity, no email, no recency, no chevrons", () => {
  const render = html.slice(html.indexOf("function renderContacts()"), html.indexOf("function openContactRoom(key)"));
  assert.match(render, /style="--cv-h:\$\{cvHue\(c\.name \|\| primary\)\}"/);
  // Filtered by the field, then sorted by name.
  assert.match(render, /\.filter\(\(c\) => cvMatches\(cvQuery, c\.name, \.\.\.contactEmails\(c\)\)\)/);
  assert.match(render, /\.sort\(\(a, b\) => String\(a\.name \|\| contactEmails\(a\)\[0\] \|\| ""\)\.localeCompare\(String\(b\.name/);
  assert.match(render, /<span class="cv-name">\$\{cvMarkHtml\(c\.name \|\| primary, cvQuery\)\}<\/span>/);
  // A row at rest is a name: the address only shows when it is what matched.
  assert.match(render, /\$\{cvQuery && !cvMatches\(cvQuery, c\.name\) \? `<span class="cv-sub">\$\{esc\(primary\)\}<\/span>` : ""\}/);
  assert.doesNotMatch(render, /class="cv-subrow"|class="cv-more"|no email/);
  assert.doesNotMatch(render, /timeAgo\(c\.updatedAt\)|const recent/);
  // Someone not on Relay yet says so, with a dashed avatar.
  assert.match(render, /cv-avatar\$\{c\.onRelay === false \? " pending" : ""\}/);
  assert.match(render, /c\.onRelay === false \? `<span class="cv-meta">Not on Relay yet<\/span>` : ""/);
  assert.match(html, /\.cv-avatar\.pending \{[^}]*inset 0 0 0 1\.5px/);
  // No "· by email": there is no email door any more (Sven, 2026-09-08).
  assert.doesNotMatch(render, /cv-via|by email/);
  assert.doesNotMatch(render, /· on Relay|On Relay/);
  assert.doesNotMatch(render, /cv-chev|CHEVRON_SVG/);
  // The person menu is kept, one hover or focus away.
  assert.match(render, /class="cv-person-more"[^>]*data-message-more>⋯</);
  assert.match(html, /\.cv-person-more \{ opacity:0;/);
  assert.match(html, /\.cv-person:hover \.cv-person-more, \.cv-person:focus-within \.cv-person-more, \.cv-person-more\[aria-expanded="true"\] \{ opacity:1; \}/);
});

// Lifts named top-level functions out of the page so they can run here.
function pageFunction(name) {
  const at = html.indexOf(`  function ${name}(`);
  assert.ok(at > 0, `${name} is defined`);
  const end = html.indexOf("\n  }\n", at);
  return html.slice(at, end + 4);
}
function deckKit(account = { email: "me@example.com" }) {
  // esc is a one-line function, so it is lifted by its line.
  const escAt = html.indexOf("  function esc(s) {");
  const escLine = html.slice(escAt, html.indexOf("\n", escAt));
  const source = ["cvHue", "cvMatches", "groupOthers", "groupAvatarStack"].map(pageFunction).join("\n");
  return new Function("payload", `${escLine}\n${source}\nreturn { esc, cvHue, cvMatches, groupOthers, groupAvatarStack };`)({ account });
}

test("Group rows are a deck (the group's square, then its people as cards), a name and a member summary, most recently active first", () => {
  const render = html.slice(html.indexOf("function groupMemberSummary("), html.indexOf("function openGroupRoom(groupId)"));
  const rows = render.slice(render.indexOf("function renderGroups()"));
  assert.match(html, /const CVG_SHOWN = 4;/);
  assert.match(render, /function groupActivityAt\(group\)/);
  assert.match(rows, /\.sort\(\(a, b\) => b\.at - a\.at\)/);
  assert.match(rows, /const cap = cvQuery \|\| cvgShowAll \? ordered\.length : CVG_SHOWN;/);
  assert.match(rows, /cvgMoreEl\.textContent = hidden > 0 \? `Show \$\{hidden\} more` : ""/);
  // The row's tile is the deck, the same one the group's own page shows.
  assert.match(rows, /const tile = groupAvatarStack\(g, roster\);/);
  assert.match(rows, /class="cvg-stack">\$\{tile\}/);
  assert.match(html, /<div class="gd-identity"><span class="cvg-stack">\$\{groupAvatarStack\(g, roster\)\}<\/span>/);
  assert.doesNotMatch(rows, /class="cv-avatar sq"/, "the single square tile is now the deck's front card");
  assert.match(rows, /const others = groupOthers\(roster\);/);
  assert.match(rows, /const sub = slack \? \(g\.lastPreview \|\| "Slack channel"\) : [^;\n]*groupMemberSummary\(/);
  assert.match(rows, /class="cvg-sub">\$\{esc\(archived \? `Archived · \$\{sub\}` : sub\)\}/);
  assert.match(rows, /class="cvg-name">\$\{cvMarkHtml\(g\.name, cvQuery\)\}/);
  // No counts or "Added you" badge on a row.
  assert.doesNotMatch(rows, /Added you|cvg-count|cvg-badge|"person" : "people"|"message" : "messages"/);
  assert.doesNotMatch(render, /cv-chev|CHEVRON_SVG/);

  // The deck itself: the group's own letter in its own hue in front, then up
  // to two blank cards for the other people, each in that person's hue.
  const kit = deckKit();
  const hue = (value) => kit.cvHue(value);
  const me = { name: "Me Myself", email: "ME@example.com " };
  const sven = { name: "Sven", email: "sven@example.com" };
  const shane = { name: "", email: "shane@example.com" };
  const josh = { name: "Josh", email: "josh@example.com" };
  const deck = kit.groupAvatarStack({ name: "design crew" }, [me, sven, shane, josh]);
  const cards = [...deck.matchAll(/<span class="cv-avatar" style="--cv-h:(\d+)" aria-hidden="true">([^<]*)<\/span>/g)];
  assert.equal(cards.length, 3, "the group's square and two people, never more");
  assert.equal(deck, cards.map((card) => card[0]).join(""), "nothing but cards in the deck");
  assert.deepEqual(cards.map((card) => [Number(card[1]), card[2]]), [
    [hue("design crew"), "D"],
    [hue("Sven"), ""],
    [hue("shane@example.com"), ""],
  ], "the viewer is never a card, and people's cards carry no initials");
  // A group of just you is its square alone.
  assert.equal(kit.groupAvatarStack({ name: "notes" }, [me]), `<span class="cv-avatar" style="--cv-h:${hue("notes")}" aria-hidden="true">N</span>`);
  assert.equal(kit.groupAvatarStack({ name: "  " }, []), `<span class="cv-avatar" style="--cv-h:${hue("  ")}" aria-hidden="true">?</span>`);
  // Slack wears its own mark.
  assert.equal(kit.groupAvatarStack({ name: "eng", provider: "slack" }, [sven]), '<img class="cvg-slack-logo" src="slackMark.png" alt="Slack" />');
  assert.deepEqual(kit.groupOthers([me, sven]), [sven]);
  // Signed out (no address), nobody is filtered.
  assert.deepEqual(deckKit({}).groupOthers([me, sven]), [me, sven]);
});

test("Group search finds a group by its name or by anyone else in it", () => {
  const rows = html.slice(html.indexOf("function renderGroups()"), html.indexOf("function openGroupRoom(groupId)"));
  assert.match(rows, /const matching = groupsList\.filter\(\(g\) => cvMatches\(cvQuery, g\.name\)\s*\|\| \(cvQuery && groupOthers\(groupInfoRoster\(g\)\)\.some\(\(member\) => cvMatches\(cvQuery, member\.name, member\.email\)\)\)\);/);
  // The same predicate, run: a member's first name or address finds the
  // group; the viewer's own name does not find every group.
  const kit = deckKit();
  const groups = [
    { name: "Design crew", roster: [{ name: "Me", email: "me@example.com" }, { name: "Sven Larsen", email: "sven@example.com" }] },
    { name: "Family", roster: [{ name: "Me", email: "me@example.com" }, { name: "Kiara", email: "kiara@home.example" }] },
  ];
  const find = (cvQuery) => groups.filter((g) => kit.cvMatches(cvQuery, g.name)
    || (cvQuery && kit.groupOthers(g.roster).some((member) => kit.cvMatches(cvQuery, member.name, member.email)))).map((g) => g.name);
  assert.deepEqual(find(""), ["Design crew", "Family"]);
  assert.deepEqual(find("design"), ["Design crew"]);
  assert.deepEqual(find("larsen"), ["Design crew"]);
  assert.deepEqual(find("kiara"), ["Family"]);
  assert.deepEqual(find("me"), [], "you are in every group: your own name finds none of them");
});

test("Group rows reserve exactly one tile's footprint before text", () => {
  // The base rule still sizes the old three-avatar strip; the deck
  // (2026-10-08) overrides it later in the sheet, and the last rule wins.
  // Rules that start a line are the list's; .gd-identity scopes the page's.
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const found = [...html.matchAll(new RegExp(`^ {2}${escaped} \\{([^}]*)\\}`, "gm"))].at(-1);
    assert.ok(found, `${selector} has a rule`);
    return Object.fromEntries(found[1].split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
      const at = part.indexOf(":");
      return [part.slice(0, at).trim(), part.slice(at + 1).trim()];
    }));
  };
  const px = (value) => { assert.match(value, /^\d+px$/); return Number.parseInt(value, 10); };
  const deck = (scope, { stack, card, step }) => {
    const box = rule(`${scope}.cvg-stack`);
    const cards = rule(`${scope}.cvg-stack .cv-avatar`);
    const second = rule(`${scope}.cvg-stack .cv-avatar:nth-child(2)`);
    const third = rule(`${scope}.cvg-stack .cv-avatar:nth-child(3)`);
    const alone = rule(`${scope}.cvg-stack .cv-avatar:only-child`);
    const logo = rule(`${scope}.cvg-stack .cvg-slack-logo`);
    // One square footprint: width, height and flex basis agree.
    assert.equal(px(box.width), stack);
    assert.equal(px(box.height), stack);
    assert.equal(box.flex, `0 0 ${stack}px`);
    // Cards are squares; each one behind steps up and to the right.
    assert.equal(px(cards.width), card);
    assert.equal(px(cards.height), card);
    assert.deepEqual([px(second.left), px(second.bottom)], [step, step]);
    assert.deepEqual([px(third.left), px(third.bottom)], [2 * step, 2 * step]);
    // The last card ends exactly at the footprint's edge: nothing spills
    // into the name beside it.
    assert.equal(card + 2 * step, stack);
    // A lone square, and Slack's mark, fill the footprint.
    assert.deepEqual([px(alone.width), px(alone.height)], [stack, stack]);
    assert.deepEqual([px(logo.width), px(logo.height)], [stack, stack]);
  };
  // The list's deck.
  const box = rule(".cvg-stack");
  assert.equal(box.position, "relative");
  assert.equal(box.display, "block");
  assert.equal(box.isolation, "isolate");
  const cards = rule(".cvg-stack .cv-avatar");
  assert.equal(cards.position, "absolute");
  assert.deepEqual([cards.left, cards.bottom, cards.margin], ["0", "0", "0"]);
  // The old strip's negative overlap never reaches a card behind.
  assert.equal(rule(".cvg-stack .cv-avatar:nth-child(2)").margin, "0");
  assert.equal(rule(".cvg-stack .cv-avatar:nth-child(3)").margin, "0");
  assert.ok(html.indexOf(".cvg-stack .cv-avatar:nth-child(2)") > html.indexOf(".cvg-stack .cv-avatar + .cv-avatar"));
  // The front card is the group's own and sits on top.
  assert.ok(Number(rule(".cvg-stack .cv-avatar:nth-child(1)")["z-index"]) > Number(rule(".cvg-stack .cv-avatar:nth-child(2)")["z-index"]));
  assert.ok(Number(rule(".cvg-stack .cv-avatar:nth-child(2)")["z-index"]) > Number(rule(".cvg-stack .cv-avatar:nth-child(3)")["z-index"]));
  deck("", { stack: 30, card: 24, step: 3 });
  // The same deck, larger, introduces a group on its own page.
  deck(".gd-identity ", { stack: 40, card: 32, step: 4 });
});

test("managed Granular runtimes stay out of People without leaving the recipient system", () => {
  const refresh = main.slice(main.indexOf("async function refreshContacts()"), main.indexOf("function ensureContactsLoaded()"));
  assert.match(refresh, /contactFixtures\.filter\(\(c\) => c\.source !== "granular"\)/);
  assert.match(refresh, /source: c\.source \|\| ""/);
  assert.match(refresh, /\.filter\(\(c\) => c\.source !== "granular"\)/);
});
