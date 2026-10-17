"""QR labels for material that arrived on an ERP gate entry — the primary way
of Scan Part's Receive & Label (manual single-part labels stay the secondary).

A gate entry is a material arrival at the plant gate, mirrored read-only from
ERP one row per item line (models/gate_entry.py) and refreshed by the ERP sync.
The mirror holds the whole plant's items and carries no usable store, so a line
belongs to a store when its item code (= ERP item code = Part No., trimmed and
case-blind) is the part_no of an ACTIVE part of that store. Other lines are left
out, and an entry with none of the store's items is not listed. Every list
carries the mirror's freshness (last refresh, newest gate date), because the
sync can fall behind and old data must never read as current.

The label is the store's one internal label (QR = Part No. only, Part No.,
description, location); one per piece that came in, so the default copies are
the gate qty — rounded up, at least 1, at most MAX_COPIES_PER_PART.

A print is recorded only after the operator confirms the labels came out: one
LabelPrintAudit row per part, source GATE_ENTRY and reference = the gate entry
no., with the part's INTERNAL barcode ensured through BarcodeService exactly as
any other print. A part already labelled for the same gate entry is a reprint
and needs a reason. Printing adds no stock and completes no GRN or quality
(spec 9).
"""
import math
from datetime import datetime, timedelta

from sqlalchemy import func

from app.extensions import db
from app.models.gate_entry import GateEntry
from app.models.label_print_audit import LabelPrintAudit
from app.models.part import Part
from app.repositories.barcode_repository import LabelPrintAuditRepository
from app.services.barcode_service import BarcodeService
from app.utils.db_tx import atomic
from app.utils.exceptions import BadRequestError, NotFoundError

DEFAULT_DAYS = 30
MAX_DAYS = 365
DEFAULT_LIMIT = 100
MAX_LIMIT = 500

# One label per piece, bounded the same as a single-part print (1..100); one
# print job holds at most MAX_LABELS_PER_PRINT labels — a bigger entry is
# printed in parts.
MAX_COPIES_PER_PART = 100
MAX_LABELS_PER_PRINT = 500

PRINT_SOURCE = "GATE_ENTRY"


def _key(code):
    return (code or "").strip().upper()


def _clean(value):
    return (value or "").strip() or None


def default_copies(qty):
    """(copies, copies_capped) for a gate qty: the qty rounded up, at least 1,
    at most MAX_COPIES_PER_PART. copies_capped says the copies are not the gate
    qty — over the cap, not a whole number, or no positive qty at all — so the
    operator checks them before printing."""
    if qty is None or qty <= 0:
        return 1, True
    copies = min(max(math.ceil(qty), 1), MAX_COPIES_PER_PART)
    return copies, copies != qty


class GateLabelService:
    def __init__(self):
        self.barcodes = BarcodeService()
        self.print_repo = LabelPrintAuditRepository()

    # ---- reading ----

    def entries(self, store_code, days=DEFAULT_DAYS, q=None, limit=DEFAULT_LIMIT):
        """The window's gate entries that brought this store's parts, newest
        first (date, then time text, then no.), each with its store items.

        `days` counts back from today's plant date (ERP gate dates are plant
        dates). `q` keeps the entries whose gate entry no., vendor name or code,
        or one of whose parts' Part No. contains it (case-blind); a matched
        entry still lists all its store items. qty sums the entry's lines per
        part. printed_copies are the copies already recorded for that entry and
        part; an entry is PRINTED when every item has some, PARTLY when a few
        have. The same few queries whatever the size — parts, gate rows,
        printed sums and the mirror's freshness; nothing per row.
        """
        days = DEFAULT_DAYS if days is None else days
        if not 1 <= days <= MAX_DAYS:
            raise BadRequestError(f"days must be between 1 and {MAX_DAYS}")
        limit = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))
        needle = (q or "").strip().lower()
        today = datetime.now().date()
        since = today - timedelta(days=days)

        parts = self._store_parts(store_code)
        grouped = self._group(self._gate_rows(since), parts)
        matched = [e for e in grouped if self._matches(e, needle)]
        matched.sort(key=lambda e: (e["gate_entry_dt"], e["gate_entry_time"] or "", e["gate_entry_no"]),
                     reverse=True)
        page = matched[:limit]
        printed = self._printed_copies([e["gate_entry_no"] for e in page])

        return {
            "erp": self.freshness(),
            "window": {"days": days, "from": since.isoformat(), "to": today.isoformat()},
            "entries": [self._entry_dict(e, printed) for e in page],
            "has_more": len(matched) > limit,
        }

    @staticmethod
    def freshness():
        """When the gate mirror was last refreshed (the sync replaces it whole,
        so its newest created_at is the last successful sync) and its newest
        gate date — shown with every list."""
        last_write, newest = db.session.query(
            func.max(GateEntry.created_at), func.max(GateEntry.gate_entry_dt)).one()
        return {"synced_at": last_write.isoformat() if last_write else None,
                "newest_gate_date": newest.isoformat() if newest else None}

    @staticmethod
    def _store_parts(store_code):
        """{PART_NO_UPPER: part fields} for the store's active parts."""
        rows = (db.session.query(Part.id, Part.part_no, Part.part_name, Part.location,
                                 Part.uom, Part.specification)
                .filter(Part.store_code == store_code, Part.is_active.is_(True)))
        return {
            _key(pno): {"part_id": pid, "part_no": pno, "part_name": name,
                        "location": _clean(location), "uom": uom, "specification": _clean(spec)}
            for pid, pno, name, location, uom, spec in rows if _key(pno)
        }

    @staticmethod
    def _gate_rows(since):
        G = GateEntry
        return (db.session.query(G.gate_entry_no, G.gate_entry_dt, G.gate_entry_time, G.ven_cd,
                                 G.ven_name, G.bill_no, G.po_no, G.item_code, G.qty)
                .filter(G.gate_entry_dt >= since, G.gate_entry_no.isnot(None), G.item_code.isnot(None))
                .order_by(G.gate_entry_dt.desc(), G.gate_entry_time.desc(), G.id.desc()))

    @staticmethod
    def _group(rows, parts):
        """Gate lines -> one record per gate entry no. with its store items (qty
        summed per part). The header's date / time are the newest line's; the
        vendor, bill and PO list every distinct value of the entry's store
        lines, in case one entry carries more than one."""
        entries = {}
        for no, dt, tm, ven_cd, ven_name, bill_no, po_no, item_code, qty in rows:
            part = parts.get(_key(item_code))
            no = _clean(no)
            if part is None or no is None:
                continue
            e = entries.get(no)
            if e is None:
                e = entries[no] = {"gate_entry_no": no, "gate_entry_dt": dt, "gate_entry_time": _clean(tm),
                                   "ven_cd": [], "ven_name": [], "bill_no": [], "po_no": [], "items": {}}
            for field, value in (("ven_cd", ven_cd), ("ven_name", ven_name),
                                 ("bill_no", bill_no), ("po_no", po_no)):
                value = _clean(value)
                if value and value not in e[field]:
                    e[field].append(value)
            item = e["items"].setdefault(part["part_id"], {**part, "qty": None})
            if qty is not None:
                item["qty"] = (item["qty"] or 0) + qty
        return list(entries.values())

    @staticmethod
    def _matches(entry, needle):
        if not needle:
            return True
        hay = [entry["gate_entry_no"], *entry["ven_cd"], *entry["ven_name"],
               *(i["part_no"] for i in entry["items"].values())]
        return any(needle in h.lower() for h in hay)

    @staticmethod
    def _printed_copies(gate_entry_nos):
        """{(gate entry no., part_id): copies recorded} in one query."""
        if not gate_entry_nos:
            return {}
        L = LabelPrintAudit
        rows = (db.session.query(L.reference, L.part_id, func.sum(L.copies))
                .filter(L.source == PRINT_SOURCE, L.reference.in_(gate_entry_nos))
                .group_by(L.reference, L.part_id))
        return {(ref, pid): int(copies or 0) for ref, pid, copies in rows}

    @staticmethod
    def _entry_dict(e, printed):
        no = e["gate_entry_no"]
        items = []
        for it in sorted(e["items"].values(), key=lambda i: i["part_no"]):
            copies, capped = default_copies(it["qty"])
            items.append({
                "part_id": it["part_id"], "part_no": it["part_no"], "part_name": it["part_name"],
                "location": it["location"], "uom": it["uom"], "specification": it.get("specification"),
                "qty": float(it["qty"]) if it["qty"] is not None else None,
                "default_copies": copies, "copies_capped": capped,
                "printed_copies": printed.get((no, it["part_id"]), 0),
                "is_active": True,
            })
        done = sum(1 for i in items if i["printed_copies"] > 0)
        state = "NOT_PRINTED" if done == 0 else ("PRINTED" if done == len(items) else "PARTLY")
        return {
            "gate_entry_no": no,
            "gate_entry_dt": e["gate_entry_dt"].isoformat(),
            "gate_entry_time": e["gate_entry_time"],
            "ven_cd": ", ".join(e["ven_cd"]) or None,
            "ven_name": ", ".join(e["ven_name"]) or None,
            "bill_no": ", ".join(e["bill_no"]) or None,
            "po_no": ", ".join(e["po_no"]) or None,
            "items": items,
            "spare_items": len(items),
            "labels_total": sum(i["default_copies"] for i in items),
            "printed_state": state,
        }

    # ---- recording a print ----

    def record_print(self, store_code, gate_entry_no, items, user=None, printer_name=None, reason=None):
        """Record the labels the operator confirmed came out for a gate entry.

        `items` is [{part_id, copies}]: each part once, 1..MAX_COPIES_PER_PART
        copies, at most MAX_LABELS_PER_PRINT in all. Every part must be one of
        this store's items on the gate entry and active (400 otherwise). A part
        with labels already recorded for this gate entry is a reprint, and a
        reprint needs a reason (kept on the reprinted rows only). Everything is
        written in one transaction: one LabelPrintAudit row per part, and the
        part's INTERNAL barcode ensured in the label template's symbology.
        """
        no = _clean(gate_entry_no)
        if no is None:
            raise BadRequestError("Gate entry no. is required")
        wanted = self._requested(items)
        total = sum(wanted.values())
        if total > MAX_LABELS_PER_PRINT:
            raise BadRequestError(
                f"{total} labels in one print — at most {MAX_LABELS_PER_PRINT}; print this gate entry in parts")

        item_keys = {_key(code) for (code,) in
                     db.session.query(GateEntry.item_code).filter(func.trim(GateEntry.gate_entry_no) == no)}
        if not item_keys:
            raise NotFoundError(f"Gate entry {no} is not in the ERP gate data")

        parts = {p.id: p for p in Part.query.filter(Part.id.in_(list(wanted))).all()}
        for pid in wanted:
            part = parts.get(pid)
            ours = part is not None and part.store_code == store_code
            if not ours or _key(part.part_no) not in item_keys:
                # Another store's part is not named, only its id.
                name = part.part_no if ours else f"#{pid}"
                raise BadRequestError(f"Part {name} is not an item of this store on gate entry {no}")
            if not part.is_active:
                raise BadRequestError(f"Part {part.part_no} is inactive — reactivate it before printing its label")

        L = LabelPrintAudit
        before = {pid for (pid,) in
                  db.session.query(L.part_id).filter(L.source == PRINT_SOURCE, L.reference == no,
                                                     L.part_id.in_(list(wanted))).distinct()}
        reason = _clean(reason)
        if before and not reason:
            names = ", ".join(parts[pid].part_no for pid in wanted if pid in before)
            raise BadRequestError(
                f"Labels were already printed for {names} on gate entry {no} — a reprint needs a reason")
        if reason and len(reason) > 255:
            raise BadRequestError("The reprint reason is at most 255 characters")

        # Unknown stays None: a caller that doesn't say which printer it used
        # is not credited with the configured one (as BarcodeService.record_print).
        printer_name = (printer_name or "").strip()[:80] or None
        symbology = self.barcodes.label_config()["symbology"]
        printed = []
        with atomic():
            for pid, copies in wanted.items():
                part = parts[pid]
                is_reprint = pid in before
                barcode = self.barcodes.ensure_internal_barcode(part, user=user, symbology=symbology)
                audit = self.print_repo.create(
                    part_id=part.id, barcode_value=barcode.code, copies=copies,
                    printed_by=user, is_reprint=is_reprint, reason=reason if is_reprint else None,
                    source=PRINT_SOURCE, reference=no, printer_name=printer_name,
                    symbology=barcode.symbology, location_printed=_clean(part.location),
                )
                printed.append({"print_id": audit.id, "part_id": part.id, "part_no": part.part_no,
                                "copies": copies, "is_reprint": is_reprint})
        return {"gate_entry_no": no, "printed": printed, "labels_total": total}

    @staticmethod
    def _requested(items):
        """{part_id: copies} in the order given — each part once, whole copies
        between 1 and MAX_COPIES_PER_PART."""
        if not items:
            raise BadRequestError("Choose at least one part to print labels for")
        wanted = {}
        for it in items:
            try:
                pid, copies = int(it.get("part_id")), int(it.get("copies"))
            except (AttributeError, TypeError, ValueError):
                raise BadRequestError("Each item needs a part_id and a whole number of copies") from None
            if pid in wanted:
                raise BadRequestError(f"Part #{pid} is listed twice")
            if not 1 <= copies <= MAX_COPIES_PER_PART:
                raise BadRequestError(f"Copies must be between 1 and {MAX_COPIES_PER_PART} per part")
            wanted[pid] = copies
        return wanted
