"""A spare's bins and the bin-scan check (Part Requisition issue, Put-away).

A part has a FRESH location (Part.location — where new material is kept) and,
for some parts, a REWORK location (Part.rework_location — where material that
came back from rework goes). Stock stays ONE number per part; the two bins only
say where the material may sit, so a scanned bin is RIGHT when it is either.
"""
import re

_SLOT = re.compile(r"\s*\(\d+\)\s*$")


def _norm(s):
    return (s or "").strip().upper().replace(" ", "")


def loc_base(s):
    """Bin base of a location: drop a slot "(n)" suffix, upper-case, strip
    spaces — so a bare bin QR or an exact-slot QR both match at bin level."""
    return _norm(_SLOT.sub("", s or ""))


def part_bins(location, rework_location=None):
    """The part's bins as [(kind, location)]: ("fresh", location) and, when a
    rework location different from it is set, ("rework", rework_location) —
    the same rule the bin sheets print a part in two bins by. Empty when the part
    has no location at all."""
    fresh = (location or "").strip()
    rework = (rework_location or "").strip()
    bins = [("fresh", fresh)] if loc_base(fresh) else []
    if loc_base(rework) and _norm(rework) != _norm(fresh):
        bins.append(("rework", rework))
    return bins


def match_bin(scanned, bins):
    """The (kind, location) of `bins` that `scanned` is, or None (wrong bin).
    The screens' rule (frontend utils/binLocation.matchBinScan): a slot "(n)"
    scanned must be that EXACT slot, so a part can't go into the wrong slot of
    the right bin; a bare bin QR matches at bin level. Case and spaces ignored."""
    if not loc_base(scanned):
        return None
    if _SLOT.search(scanned):
        return next((b for b in bins if _norm(b[1]) == _norm(scanned)), None)
    return next((b for b in bins if loc_base(b[1]) == loc_base(scanned)), None)


# What the store calls each bin: the fresh one is "new" (its word, 14 Oct 2026).
BIN_WORDS = {"fresh": "new", "rework": "rework"}


def bins_text(bins):
    """The correct bin(s) for a message: "R3-S6-B31(1)", or with a rework bin
    "R3-S6-B31(1) (new) or R2-S6-B35(1) (rework)"."""
    if len(bins) == 1 and bins[0][0] == "fresh":
        return bins[0][1]
    return " or ".join(f"{loc} ({BIN_WORDS[kind]})" for kind, loc in bins)
