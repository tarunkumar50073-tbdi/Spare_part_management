// Find a part by the words someone knows (the store, 28 Oct 2026: "bearing,
// bolt, nut, spring … kisi ko exact part no ya model ya spec na pta ho"). Each
// typed word must turn up somewhere in the text — in any order — and a plural
// also finds its singular ("bolts" finds BOLT). The server matches the same way
// (backend/app/utils/word_search.py).
const MAX_WORDS = 6;

export function searchWords(query) {
  return String(query || "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, MAX_WORDS);
}

function variants(word) {
  const out = [word];
  if (word.length > 4 && word.endsWith("es")) out.push(word.slice(0, -2));
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) out.push(word.slice(0, -1));
  return out;
}

/** The typed words as matchers, built once per query. */
export function wordMatchers(query) {
  return searchWords(query).map(variants);
}

/** True when every word (or its singular) is in `text` (already lower case). */
export function matchesAll(text, matchers) {
  return matchers.every((vs) => vs.some((v) => text.includes(v)));
}
