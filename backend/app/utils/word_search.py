"""Find a part by the words someone knows (the store, 28 Oct 2026: "bearing,
bolt, nut, spring … kisi ko exact part no ya model ya spec na pta ho"). Each
typed word must turn up somewhere — in any order, any of the given fields — and
a plural also finds its singular ("bolts" finds BOLT). The front end matches
the same way (frontend/src/lib/wordSearch.js)."""
from sqlalchemy import or_

MAX_WORDS = 6


def search_words(text):
    """The typed words, lower case, at most MAX_WORDS."""
    return (text or "").lower().split()[:MAX_WORDS]


def word_variants(word):
    """The word and, for a plural, its singular: bolts -> bolt, bushes -> bush."""
    out = [word]
    if len(word) > 4 and word.endswith("es"):
        out.append(word[:-2])
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        out.append(word[:-1])
    return out


def word_filters(fields, text):
    """One condition per typed word: the word (or its singular) in any field."""
    return [or_(*(f.ilike(f"%{v}%") for f in fields for v in word_variants(w))) for w in search_words(text)]
