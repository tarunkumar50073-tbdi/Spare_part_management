"""Data Quality Center — how complete and consistent the spare part master is.

Every check is a plain reading of the rows as stored: a count of parts, never a
score or an estimate. The completeness figure uses exactly the dashboard's rule
(max, min, reorder, rate and location — five fields per part, SpareDashboardService
._aggregate), so "Master data complete: N%" on the dashboard and the figure here
cannot disagree.

Built in one pass over the store's stock list plus a handful of set queries
(barcodes, label prints, one pass over the gate suppliers) — never a query per part.
"""
import re
from collections import Counter
from datetime import timezone

from sqlalchemy import func

from app.extensions import db
from app.models.base import utcnow
from app.models.gate_entry import GateEntry
from app.models.label_print_audit import LabelPrintAudit
from app.models.part import Part
from app.models.part_barcode import PartBarcode
from app.models.store import Section, Store
from app.services.spare_stock_service import SpareStockService
from app.utils.exceptions import BadRequestError

# key, label, severity, fixable_field, hint. "warning" = the gap changes a stock
# decision (status, value, where to find it); "info" = housekeeping.
CHECKS = (
    ("missing_max", "No maximum", "warning", "max_stock_level",
     "Maximum is blank or 0, so there is nothing to reorder up to and no order quantity."),
    ("missing_min", "No minimum", "warning", "min_stock_level",
     "Minimum is 0, so the part is never flagged Below Minimum."),
    ("missing_reorder", "No reorder level", "warning", "reorder_level",
     "No reorder level, so the part never shows the Reorder status. A reorder level of 0 is "
     "listed under \"Reorder level is 0\"."),
    ("zero_reorder", "Reorder level is 0", "warning", "reorder_level",
     "Reorder level is stored as 0. Stock status ignores a 0, so the part never shows Reorder. "
     "It counts as filled in the completeness figure (the dashboard's rule)."),
    ("missing_rate", "No rate", "warning", "unit_price",
     "No rate, so the part's stock cannot be valued. A rate of 0 is listed under \"Rate is 0\"."),
    ("zero_rate", "Rate is 0", "warning", "unit_price",
     "Rate is stored as 0, so the stock is valued at 0. It counts as filled in the completeness "
     "figure (the dashboard's rule); Part Master's Missing Rate filter counts it as missing."),
    ("missing_location", "No location", "warning", "location",
     "No location, so nobody can be told where the part sits."),
    ("never_counted", "Never counted", "warning", None,
     "No physical count recorded. The quantity is unknown, not zero — count it on Store Stock."),
    ("reorder_outside_min_max", "Reorder outside min–max", "warning", "reorder_level",
     "Reorder level is below the minimum or above the maximum (checked only where a maximum is set)."),
    ("min_greater_than_max", "Minimum above maximum", "warning", "max_stock_level",
     "Minimum is higher than the maximum, so one of the two is wrong (checked only where a maximum is set)."),
    ("missing_barcode", "No barcode", "info", None,
     "No barcode on the part and no mapped barcode. Scanning still works off the Part No."),
    ("no_label_printed", "No label printed", "info", None,
     "No label print recorded in this app. Open the part to print one."),
    ("no_gate_supplier", "No supplier at the gate", "info", None,
     "No ERP gate entry held names a supplier for this part no., so no supplier can be derived "
     "(suppliers come from gate entries only — the same rule Store Stock and the part drawer use)."),
    ("uom_variants", "UOM spelled differently", "info", "uom",
     "The same unit is spelled more than one way (e.g. NO / NOS). Listed parts use a less common "
     "spelling; the most used one is shown beside it."),
    ("duplicate_names", "Same description, different part no.", "info", None,
     "The same description on more than one part number — one item under two numbers, or different "
     "items with a generic description."),
)
CHECK_KEYS = tuple(c[0] for c in CHECKS)

# The five planning fields the completeness figure is built from.
COMPLETENESS_FIELDS = (
    ("max_stock_level", "Maximum", "missing_max"),
    ("min_stock_level", "Minimum", "missing_min"),
    ("reorder_level", "Reorder level", "missing_reorder"),
    ("unit_price", "Rate", "missing_rate"),
    ("location", "Location", "missing_location"),
)
# A stored 0 is "filled" for these two under the dashboard's rule but acts as
# blank everywhere else (status, Part Master), so the tile names it beside the
# missing count and its own check lists the parts.
ZERO_CHECKS = {"reorder_level": "zero_reorder", "unit_price": "zero_rate"}

# Spellings of one unit that are the same word, not a different unit.
_UOM_SYNONYMS = {
    "PIECE": "PC", "PCE": "PC", "NUMBER": "NO", "NOS": "NO", "NUMBERS": "NO",
    "LITRE": "LTR", "LITER": "LTR", "METRE": "MTR", "METER": "MTR", "KILOGRAM": "KG",
    "BOXES": "BOX",
}


def _uom_key(uom):
    """'Nos.' / 'NOS' / 'no' -> 'NO'; 'PCS' / 'pc' -> 'PC'. A trailing plural S
    is dropped only on words longer than two letters, so 'MS' stays 'MS'."""
    t = re.sub(r"[^A-Z0-9]", "", (uom or "").upper())
    t = _UOM_SYNONYMS.get(t, t)
    if len(t) > 2 and t.endswith("S"):
        t = t[:-1]
    return _UOM_SYNONYMS.get(t, t)


def _name_key(name):
    # Case, punctuation and spacing differences are the same description.
    return re.sub(r"[^A-Z0-9]+", " ", (name or "").upper()).strip()


def _pct(count, n):
    return round(count / n * 100, 1) if n else None


class DataQualityService:
    def __init__(self):
        self.stock = SpareStockService()

    # ------------------------------------------------------------------ public

    def summary(self, store_code, section_id=None):
        scan = self._scan(store_code, section_id)
        n = len(scan["rows"])
        hits = scan["hits"]
        fields = []
        filled_total = 0
        for field, label, check in COMPLETENESS_FIELDS:
            filled = n - len(hits[check])
            filled_total += filled
            entry = {"field": field, "label": label, "filled": filled,
                     "pct": _pct(filled, n), "check": check}
            if field in ZERO_CHECKS:
                entry["zero"] = len(hits[ZERO_CHECKS[field]])
                entry["zero_check"] = ZERO_CHECKS[field]
            fields.append(entry)
        return {
            "store_code": store_code,
            "section_id": section_id,
            "generated_at": utcnow().replace(tzinfo=timezone.utc).isoformat(),
            "parts": n,
            "completeness_pct": _pct(filled_total, n * len(COMPLETENESS_FIELDS)),
            "fields": fields,
            "checks": [self._check_meta(key, scan) for key in CHECK_KEYS],
            "uom_variants": scan["uom_groups"],
            "gate_window": scan["gate_window"],
        }

    def parts(self, store_code, check, section_id=None):
        if check not in CHECK_KEYS:
            raise BadRequestError(f"Unknown check '{check}'", errors={"check": list(CHECK_KEYS)})
        scan = self._scan(store_code, section_id)
        extra = scan["extra"]
        ids = scan["hits"][check]
        rows = []
        for r in scan["rows"]:
            pid = r["part_id"]
            if pid not in ids:
                continue
            row = {
                "part_id": pid,
                "part_no": r["part_no"],
                "part_name": r["part_name"],
                "section_id": r["section_id"],
                "section": scan["sections"].get(r["section_id"]),
                "type": (r["sub_category"] or "").strip() or None,
                "uom": r["uom"],
                "min_stock_level": r["min_stock_level"],
                "reorder_level": r["reorder_level"],
                "max_stock_level": r["max_stock_level"],
                "unit_price": r["unit_price"],
                "location": r["location"],
                "barcode": scan["barcodes"].get(pid),
                "qty_on_hand": r["qty_on_hand"],
                "status": r["status"],
            }
            row.update(extra.get(check, {}).get(pid, {}))
            rows.append(row)
        # Group the two "sameness" checks so each group's parts sit together.
        if check == "duplicate_names":
            rows.sort(key=lambda x: (x["name_group"], x["part_no"]))
        elif check == "uom_variants":
            rows.sort(key=lambda x: (x["uom_most_used"], x["uom"], x["part_no"]))
        return {"check": self._check_meta(check, scan), "parts": len(scan["rows"]), "rows": rows}

    # --------------------------------------------------------------- building

    @staticmethod
    def _check_meta(key, scan):
        _, label, severity, fixable, hint = next(c for c in CHECKS if c[0] == key)
        count = len(scan["hits"][key])
        meta = {
            "key": key, "label": label, "severity": severity, "count": count,
            "pct": _pct(count, len(scan["rows"])), "fixable_field": fixable, "hint": hint,
        }
        if key == "no_gate_supplier":
            meta["gate_window"] = scan["gate_window"]
        elif key == "uom_variants":
            meta["groups"] = len(scan["uom_groups"])
        elif key == "duplicate_names":
            meta["groups"] = scan["name_groups"]
        return meta

    def _scan(self, store_code, section_id):
        rows = self.stock.list_stock(store_code, section_id)
        barcodes, mapped = self._barcodes(store_code, section_id)
        labelled = self._labelled(store_code, section_id)
        # Only gate rows that name a vendor count — the app's own supplier rule
        # (Store Stock, part drawer), so "no supplier" here means none shown there.
        gate_codes = self.stock.latest_gate_suppliers().keys()

        hits = {key: set() for key in CHECK_KEYS}
        uoms = {}        # normalised unit -> Counter(stored spelling)
        names = {}       # normalised description -> [part_id, ...]
        for r in rows:
            pid = r["part_id"]
            mx, mn, ro = r["max_stock_level"], r["min_stock_level"], r["reorder_level"]
            # A discontinued part is never ordered, so it needs no min / max /
            # reorder: its 0s are not gaps (the 22 Oct 2026 rule, as on the
            # overview and Part Master — missed here until 27 Oct 2026).
            levels = not r.get("discontinued")
            # Same predicates as the dashboard's completeness (and the inventory
            # gap filters): 0 counts as "not set" for max and min, blank for the
            # rest; a 0 reorder level or rate gets its own check instead.
            if levels and not mx:
                hits["missing_max"].add(pid)
            if levels and not mn:
                hits["missing_min"].add(pid)
            if levels and ro is None:
                hits["missing_reorder"].add(pid)
            elif levels and ro == 0:
                hits["zero_reorder"].add(pid)
            if r["unit_price"] is None:
                hits["missing_rate"].add(pid)
            elif r["unit_price"] == 0:
                hits["zero_rate"].add(pid)
            if not (r["location"] or "").strip():
                hits["missing_location"].add(pid)
            if r["qty_on_hand"] is None:
                hits["never_counted"].add(pid)
            # Only a set maximum makes a band to fall outside of; min 0 is a floor.
            if levels and ro is not None and mx and not (mn <= ro <= mx):
                hits["reorder_outside_min_max"].add(pid)
            if levels and mx and mn > mx:
                hits["min_greater_than_max"].add(pid)
            if pid not in mapped and not barcodes.get(pid):
                hits["missing_barcode"].add(pid)
            if pid not in labelled:
                hits["no_label_printed"].add(pid)
            if (r["part_no"] or "").strip().upper() not in gate_codes:
                hits["no_gate_supplier"].add(pid)
            ukey = _uom_key(r["uom"])
            if ukey:
                uoms.setdefault(ukey, Counter())[r["uom"]] += 1
            nkey = _name_key(r["part_name"])
            if nkey:
                names.setdefault(nkey, []).append(pid)

        extra = {"uom_variants": {}, "duplicate_names": {}}
        uom_groups = []
        most_used = {}
        for ukey, spellings in uoms.items():
            if len(spellings) < 2:
                continue
            # Most used first; a tie falls back to alphabetical so it is stable.
            ranked = sorted(spellings.items(), key=lambda kv: (-kv[1], kv[0]))
            most_used[ukey] = ranked[0][0]
            uom_groups.append({
                "unit": ukey,
                "parts": sum(spellings.values()),
                "most_used": ranked[0][0],
                "spellings": [{"uom": u, "count": c} for u, c in ranked],
            })
        uom_groups.sort(key=lambda g: -g["parts"])
        for r in rows:
            best = most_used.get(_uom_key(r["uom"]))
            if best is not None and r["uom"] != best:
                hits["uom_variants"].add(r["part_id"])
                extra["uom_variants"][r["part_id"]] = {"uom_most_used": best}

        name_groups = 0
        for nkey, pids in names.items():
            if len(pids) < 2:
                continue
            name_groups += 1
            for pid in pids:
                hits["duplicate_names"].add(pid)
                extra["duplicate_names"][pid] = {"name_group": nkey, "name_group_size": len(pids)}

        return {
            "rows": rows,
            "hits": hits,
            "extra": extra,
            "barcodes": barcodes,
            "sections": self._section_names(store_code),
            "uom_groups": uom_groups,
            "name_groups": name_groups,
            "gate_window": self._gate_window(),
        }

    @staticmethod
    def _scoped(query, store_code, section_id):
        query = query.filter(Part.store_code == store_code, Part.is_active.is_(True))
        if section_id:
            query = query.filter(Part.section_id == section_id)
        return query

    def _barcodes(self, store_code, section_id):
        """({part_id: barcode shown}, {part_ids with an active mapped barcode}).
        The shown value is Part.barcode, else the mapped one (primary first)."""
        shown = {
            pid: code.strip() for pid, code in
            self._scoped(db.session.query(Part.id, Part.barcode), store_code, section_id)
            .filter(Part.barcode.isnot(None))
            if (code or "").strip()
        }
        mapped = set()
        q = self._scoped(
            db.session.query(PartBarcode.part_id, PartBarcode.code)
            .join(Part, Part.id == PartBarcode.part_id)
            .filter(PartBarcode.is_active.is_(True)),
            store_code, section_id,
        ).order_by(PartBarcode.is_primary.desc(), PartBarcode.id.asc())
        for pid, code in q:
            mapped.add(pid)
            shown.setdefault(pid, code)
        return shown, mapped

    def _labelled(self, store_code, section_id):
        q = self._scoped(
            db.session.query(LabelPrintAudit.part_id).join(Part, Part.id == LabelPrintAudit.part_id),
            store_code, section_id,
        ).distinct()
        return {pid for (pid,) in q}

    @staticmethod
    def _gate_window():
        """The span of gate data held — "never seen at the gate" only means
        never seen in these dates, and the screen says so."""
        first, last, n = db.session.query(
            func.min(GateEntry.gate_entry_dt), func.max(GateEntry.gate_entry_dt), func.count(GateEntry.id),
        ).one()
        return {
            "from": first.isoformat() if first else None,
            "to": last.isoformat() if last else None,
            "rows": n or 0,
        }

    @staticmethod
    def _section_names(store_code):
        return {
            sid: name for sid, name in
            db.session.query(Section.id, Section.name)
            .join(Store, Store.id == Section.store_id)
            .filter(Store.code == store_code)
        }
