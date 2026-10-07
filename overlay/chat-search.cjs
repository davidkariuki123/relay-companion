// Chat search: how a query finds chats, people and messages, and how a hit is
// shown. Pure, so the inbox and its tests share one definition of a match.
//
// The rules (2026-10-07):
// - Every word of the query must be found; order does not matter.
// - A word matches where a word starts ("sh" finds Shane, not "Marsh"), so a
//   short query never lights up the middle of unrelated words.
// - Case, accents and curly quotes never stop a match ("rene" finds René).
(function installChatSearch(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RelayChatSearch = api;
})(typeof globalThis === "object" ? globalThis : this, function createChatSearch() {
  "use strict";

  // Fold text for comparison while remembering where every folded character
  // came from, so a hit can be highlighted in the original words.
  // Typing re-runs every search, so a message is folded once, not per key.
  const folds = new Map();
  function fold(text) {
    const source = String(text || "");
    const cached = folds.get(source);
    if (cached) return cached;
    const result = foldNow(source);
    if (folds.size > 20000) folds.clear();
    folds.set(source, result);
    return result;
  }
  function foldNow(source) {
    let folded = "";
    const from = [];
    for (let index = 0; index < source.length;) {
      const char = String.fromCodePoint(source.codePointAt(index));
      const plain = char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
        .replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');
      for (const piece of plain) { folded += piece; for (let i = 0; i < piece.length; i++) from.push(index); }
      index += char.length;
    }
    from.push(source.length);
    return Object.freeze({ source, folded, from });
  }

  function terms(query) {
    const words = fold(query).folded.split(/\s+/).filter(Boolean);
    return [...new Set(words)];
  }

  const WORDISH = /[\p{L}\p{N}]/u;
  // The first place `term` begins a word in `text`, as a range of the original.
  function findWordStart(text, term) {
    const { source, folded, from } = typeof text === "string" ? fold(text) : text;
    let at = folded.indexOf(term);
    while (at !== -1) {
      const before = at > 0 ? folded[at - 1] : "";
      // A term that itself starts with punctuation ("@sven", "#3") may begin anywhere.
      if (!before || !WORDISH.test(before) || !WORDISH.test(term[0])) {
        const end = at + term.length;
        return { start: from[at], end: end < from.length ? from[end] : source.length };
      }
      at = folded.indexOf(term, at + 1);
    }
    return null;
  }

  // Every place each term begins a word, for lighting words in a transcript.
  function findAll(text, queryTerms) {
    const folded = fold(text);
    const ranges = [];
    for (const term of queryTerms) {
      let from = 0;
      while (from <= folded.folded.length) {
        const at = folded.folded.indexOf(term, from);
        if (at === -1) break;
        const before = at > 0 ? folded.folded[at - 1] : "";
        if (!before || !WORDISH.test(before) || !WORDISH.test(term[0])) {
          const end = at + term.length;
          ranges.push({ start: folded.from[at], end: end < folded.from.length ? folded.from[end] : folded.source.length });
        }
        from = at + 1;
      }
    }
    return mergeRanges(ranges);
  }

  // Every term found in the text, or null when one is missing.
  function matchText(text, queryTerms) {
    if (!queryTerms.length) return null;
    const folded = fold(text);
    const ranges = [];
    for (const term of queryTerms) {
      const range = findWordStart(folded, term);
      if (!range) return null;
      ranges.push(range);
    }
    return mergeRanges(ranges);
  }

  // A chat matches by its own name, or by the people in it: "shane" finds the
  // groups Shane is in, and "shane granular" finds the one called Granular.
  // score: 0 the name begins with the whole query, 1 the name holds every
  // word, 2 a member is needed to make the match.
  function matchRoom(name, people, queryTerms) {
    if (!queryTerms.length) return null;
    const nameFolded = fold(name);
    const members = (people || []).filter((person) => person && person !== name).map((person) => ({ person, folded: fold(person) }));
    const nameRanges = [];
    const memberRanges = new Map();
    for (const term of queryTerms) {
      const inName = findWordStart(nameFolded, term);
      if (inName) { nameRanges.push(inName); continue; }
      let found = false;
      for (const member of members) {
        const range = findWordStart(member.folded, term);
        if (!range) continue;
        const list = memberRanges.get(member.person) || [];
        list.push(range);
        memberRanges.set(member.person, list);
        found = true;
        break;
      }
      if (!found) return null;
    }
    const whole = queryTerms.join(" ");
    const score = !memberRanges.size && nameFolded.folded.startsWith(whole) ? 0 : !memberRanges.size ? 1 : 2;
    return {
      score,
      nameRanges: mergeRanges(nameRanges),
      members: [...memberRanges].map(([person, ranges]) => ({ person, ranges: mergeRanges(ranges) })),
    };
  }

  function mergeRanges(ranges) {
    const sorted = ranges.filter(Boolean).map((range) => ({ ...range })).sort((a, b) => a.start - b.start);
    const merged = [];
    for (const range of sorted) {
      const last = merged[merged.length - 1];
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else merged.push(range);
    }
    return merged;
  }

  // The part of a long message worth showing: the hit, with enough words
  // before it to read as a sentence, cut on word boundaries.
  function snippet(text, ranges, max = 96) {
    const source = String(text || "");
    if (!ranges.length || source.length <= max) return { text: source, ranges };
    const first = ranges[0];
    let start = 0;
    if (first.end > max - 12) {
      start = Math.max(0, first.start - 28);
      const space = source.lastIndexOf(" ", first.start - 1);
      if (space >= start) start = space + 1;
      else if (start > 0) { const next = source.indexOf(" ", start); start = next !== -1 && next < first.start ? next + 1 : first.start; }
    }
    let end = Math.min(source.length, start + max);
    if (end < source.length) {
      const space = source.lastIndexOf(" ", end);
      if (space > first.end) end = space;
    }
    const lead = start > 0 ? "…" : "";
    const tail = end < source.length ? "…" : "";
    const body = source.slice(start, end).replace(/[\s,;:]+$/u, "");
    return {
      text: lead + body + tail,
      ranges: ranges.filter((range) => range.start >= start && range.end <= start + body.length)
        .map((range) => ({ start: range.start - start + lead.length, end: range.end - start + lead.length })),
    };
  }

  function highlight(text, ranges, esc) {
    const source = String(text || "");
    let html = "";
    let at = 0;
    for (const range of ranges || []) {
      if (range.start < at) continue;
      html += esc(source.slice(at, range.start)) + `<mark class="hit">${esc(source.slice(range.start, range.end))}</mark>`;
      at = range.end;
    }
    return html + esc(source.slice(at));
  }

  return { fold, terms, findWordStart, findAll, matchText, matchRoom, snippet, highlight };
});
