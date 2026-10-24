"""Rejection Mail service — the one mail the store sends RQC to punch an SRV /
line rejection in ERP (models/rejection_request.py; the store, 22 Oct 2026:
"jab koi material reject hota h to hum us invoice ki grn srv finished me
bnwakar rqc wale ko mail karte h ki isko system me punch kar do"). Only that
mail — "rejection request only 1 mail k liye h baaki kuch nhi": no status to
follow afterwards.

The mail's details come from the GRN line in the ERP GRN register
(receiving_register, the read-only mirror) — vendor, challan, PO, GRN and item —
or, while ERP is not reachable, are typed in; either way the part must be one of
the store's. The kind is suggested from the line — a GRN already accepted (a
store entry) is a LINE rejection, one still awaiting quality an SRV rejection —
and the store may change it.

The mail is a DRAFT the app hands over as an .eml (X-Unsent): Outlook opens it
ready to send, in the store's own format (the table of their mail to RQC), and
the store sends it — the app's mail engine is not used and nothing leaves on its
own. Each mail made is kept, so it can be opened again from the list.
"""
import html
import json
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from email.message import EmailMessage
from email.utils import formatdate

from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.part import Part
from app.models.receiving_register import ReceivingRegister
from app.models.rejection_request import KIND_LABELS, REJECTION_KINDS, RejectionHistory, RejectionRequest
from app.utils.db_tx import atomic
from app.utils.exceptions import BadRequestError, NotFoundError

SETTING_KEY = "rejection_mail"
# Who the mail goes to and how it greets them — set once on the screen.
MAIL_DEFAULTS = {"to": "", "cc": "", "rqc_name": "", "transport_name": ""}
PAGE_SIZE, MAX_PAGE_SIZE = 25, 100
MAX_QTY = Decimal("1000000")
EMAIL_RE = re.compile(r"^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$")
COLUMNS = ("Ven Name", "Challan NO", "Challan Dt", "GRN No", "Po No", "Po Dt", "Item Code", "Item Desc",
           "Qty", "UOM", "HSN", "Remark's")


# ---- small helpers -------------------------------------------------------------

def _today():
    from app.services.spare_report_service import plant_today
    return plant_today()


def _clean(value, limit=None, label="Value"):
    text = str(value).strip() if value is not None else ""
    if not text:
        return None
    if limit and len(text) > limit:
        raise BadRequestError(f"{label} is too long (at most {limit} characters)")
    return text


def _need(data, key, limit, label):
    value = _clean(data.get(key), limit, label)
    if value is None:
        raise BadRequestError(f"{label} is required")
    return value


def _key(text):
    return re.sub(r"\s+", "", text or "").upper()


def _date(value, label):
    if value in (None, ""):
        return None
    if isinstance(value, date):
        return value
    try:
        return datetime.strptime(str(value).strip()[:10], "%Y-%m-%d").date()
    except ValueError:
        raise BadRequestError(f"{label} must be a date (YYYY-MM-DD)") from None


def _qty(value, label):
    try:
        qty = Decimal(str(value).strip())
    except (InvalidOperation, ValueError, AttributeError):
        raise BadRequestError(f"{label} must be a number") from None
    if not qty.is_finite() or qty <= 0:
        raise BadRequestError(f"{label} must be more than 0")
    if qty > MAX_QTY:
        raise BadRequestError(f"{label} is too large")
    if qty != qty.quantize(Decimal("0.01")):
        raise BadRequestError(f"{label} can have at most 2 decimals")
    return qty


def _num(value):
    if value is None:
        return None
    value = float(value)
    return int(value) if value.is_integer() else round(value, 2)


def _iso(value):
    return value.isoformat() if value is not None else None


def _dmy(value):
    return value.strftime("%d-%b-%Y") if value else ""


def _who(user):
    return (getattr(user, "username", None) or str(user or "") or "SYSTEM")[:60]


def _emails(text, label):
    """A To / CC line: addresses split on , ; or spaces, each checked."""
    out = []
    for piece in re.split(r"[,;\s]+", text or ""):
        piece = piece.strip()
        if not piece:
            continue
        if not EMAIL_RE.match(piece):
            raise BadRequestError(f"{label}: '{piece}' is not an e-mail address")
        out.append(piece)
    return out


def suggested_kind(row):
    """LINE when the GRN line was already accepted into the store (a store
    entry); SRV while it still waits for quality — the usual case."""
    accepted = row.get("accept_qty") if isinstance(row, dict) else getattr(row, "accept_qty", None)
    return "LINE" if accepted is not None and float(accepted) > 0 else "SRV"


class RejectionRequestService:

    # ---- settings -----------------------------------------------------------------

    def settings(self):
        saved = AppSetting.get_value(SETTING_KEY)
        out = dict(MAIL_DEFAULTS)
        if isinstance(saved, dict):
            out.update({k: saved[k] for k in MAIL_DEFAULTS if isinstance(saved.get(k), str)})
        return out

    def set_settings(self, data, user=None):
        data = data or {}
        out = self.settings()
        for key, label in (("to", "To"), ("cc", "CC")):
            if key in data:
                out[key] = ", ".join(_emails(_clean(data.get(key), 500, label) or "", label))
        for key, label in (("rqc_name", "RQC name"), ("transport_name", "Vehicle / e-Way bill person")):
            if key in data:
                out[key] = _clean(data.get(key), 60, label) or ""
        AppSetting.set_value(SETTING_KEY, out, _who(user))
        db.session.commit()
        return out

    # ---- the GRN lines to pick from ------------------------------------------------

    def grn_lines(self, store_code, q=None, limit=30):
        """ERP GRN register lines of the store's parts, newest first, matched on
        GRN no. / challan no. / Part No. / description / supplier / PO, each
        with the suggested kind."""
        text = (q or "").strip()
        if len(text) < 2:
            return []
        parts = {_key(p.part_no): p for p in Part.query.filter(Part.store_code == store_code).all()}
        like = f"%{text}%"
        RR = ReceivingRegister
        rows = (RR.query.filter(RR.item_cd.isnot(None),
                                or_(RR.grn_no.ilike(like), RR.challan_no.ilike(like), RR.item_cd.ilike(like),
                                    RR.item_desc.ilike(like), RR.ven_name.ilike(like), RR.po_no.ilike(like)))
                .order_by(RR.grn_date.desc(), RR.id.desc()).limit(400).all())
        out = []
        for rr in rows:
            part = parts.get(_key(rr.item_cd))
            if part is None:
                continue                        # not a part of this store
            out.append({
                "id": rr.id, "grn_no": rr.grn_no, "grn_date": _iso(rr.grn_date), "ven_cd": rr.ven_cd,
                "ven_name": rr.ven_name, "challan_no": rr.challan_no, "challan_date": _iso(rr.challan_dt),
                "po_no": rr.po_no, "gate_entry_no": rr.gate_entry_no, "item_cd": rr.item_cd,
                "item_desc": rr.item_desc or part.part_name, "part_id": part.id, "part_no": part.part_no,
                "uom": part.uom, "receipt_qty": _num(rr.receipt_qty), "accept_qty": _num(rr.accept_qty),
                "reject_qty": _num(rr.reject_qty), "suggested_kind": suggested_kind(rr),
            })
            if len(out) >= limit:
                break
        return out

    # ---- the mail -------------------------------------------------------------------

    def create(self, store_code, data, user=None):
        """Keep one rejection mail's details. From a picked GRN line
        (receiving_register_id) its vendor, challan, PO, GRN and item are taken
        (what the form sends wins where it says something); without one, they
        are typed in."""
        data = data or {}
        request_id = _clean(data.get("request_id"), 64, "request_id")
        if request_id:
            first = RejectionRequest.query.filter_by(request_id=request_id).first()
            if first is not None:
                return dict(self.detail(first.id), replayed=True)
        rr = None
        if data.get("receiving_register_id") not in (None, ""):
            try:
                rr = db.session.get(ReceivingRegister, int(data["receiving_register_id"]))
            except (TypeError, ValueError):
                rr = None
            if rr is None:
                raise NotFoundError("That GRN line is no longer in the ERP GRN register — search it again")
        part = self._part(store_code, data.get("part_id") if data.get("part_id") not in (None, "")
                          else self._part_id_for(store_code, rr))
        if rr is not None and _key(rr.item_cd) != _key(part.part_no):
            raise BadRequestError(f"GRN {rr.grn_no} is for item {rr.item_cd}, not {part.part_no}")

        def pick(key, fallback, limit, label):
            return _clean(data.get(key), limit, label) or (_clean(fallback, limit, label) if fallback else None)

        kind = _clean(data.get("kind")) or (suggested_kind(rr) if rr is not None else "SRV")
        if kind not in REJECTION_KINDS:
            raise BadRequestError("Kind must be SRV (SRV rejection) or LINE (line rejection)")
        ven_name = pick("ven_name", rr.ven_name if rr else None, 160, "Supplier")
        if not ven_name:
            raise BadRequestError("Supplier is required")
        grn_no = pick("grn_no", rr.grn_no if rr else None, 60, "GRN No.")
        challan_no = pick("challan_no", rr.challan_no if rr else None, 60, "Challan No.")
        if not (grn_no or challan_no):
            raise BadRequestError("Give the GRN No. or the challan No. the material came on")
        qty = _qty(data.get("qty"), "Rejected qty")
        received = rr.receipt_qty if rr is not None else None
        if received is not None and qty > Decimal(str(received)):
            raise BadRequestError(f"Rejected qty {_num(qty)} is more than the {_num(received)} received on GRN {rr.grn_no}")
        remark = _need(data, "remark", 255, "Reason / remark")
        row = RejectionRequest(
            store_code=store_code, kind=kind, part_id=part.id, item_cd=part.part_no,
            item_desc=pick("item_desc", (rr.item_desc if rr else None) or part.part_name, 255, "Description"),
            uom=_clean(data.get("uom"), 20, "UOM") or part.uom, hsn=_clean(data.get("hsn"), 20, "HSN"),
            ven_cd=pick("ven_cd", rr.ven_cd if rr else None, 60, "Vendor code"), ven_name=ven_name,
            challan_no=challan_no,
            challan_date=_date(data.get("challan_date"), "Challan date") or (rr.challan_dt if rr else None),
            po_no=pick("po_no", rr.po_no if rr else None, 60, "PO No."), po_date=_date(data.get("po_date"), "PO date"),
            grn_no=grn_no, grn_date=_date(data.get("grn_date"), "GRN date") or (rr.grn_date if rr else None),
            gate_entry_no=pick("gate_entry_no", rr.gate_entry_no if rr else None, 60, "Gate entry No."),
            grn_key=_key(grn_no) or None, receiving_register_id=rr.id if rr else None,
            received_qty=received, qty=qty, remark=remark, created_by=_who(user), request_id=request_id)
        for attempt in range(2):
            try:
                with atomic():
                    row.request_no = self._next_no()
                    db.session.add(row)
                    db.session.flush()
                    self._log(row, "CREATED", {"kind": KIND_LABELS[kind], "grn_no": grn_no, "qty": _num(qty),
                                               "remark": remark, "from_erp_register": rr is not None}, user)
                break
            except IntegrityError:
                db.session.rollback()
                if request_id:
                    first = RejectionRequest.query.filter_by(request_id=request_id).first()
                    if first is not None:
                        return dict(self.detail(first.id), replayed=True)
                if attempt:
                    raise
                row = RejectionRequest(**{c.name: getattr(row, c.name) for c in RejectionRequest.__table__.columns
                                          if c.name not in ("id", "created_at", "updated_at", "request_no")})
        return self.detail(row.id)

    def mail_draft(self, pk, user=None):
        """(bytes, file name) of the mail to RQC as an unsent .eml: Outlook opens
        it as a new message, addressed, ready to send. The store's format: the
        greeting, one line asking to punch the rejection, the table, the line
        asking for a vehicle no. for the e-Way bill, and the sender's name."""
        row = self._get(pk)
        s = self.settings()
        sender = getattr(user, "full_name", None) or getattr(user, "username", None) or "Store"
        kind_word = "line rejection" if row.kind == "LINE" else "SRV rejection"
        why = "This material rejected by user." if row.kind == "LINE" else "This material is rejected."
        values = (row.ven_name, row.challan_no or "", _dmy(row.challan_date), row.grn_no or "", row.po_no or "",
                  _dmy(row.po_date), row.item_cd, row.item_desc or "", _num(row.qty), row.uom or "",
                  row.hsn or "", row.remark)
        th = 'style="border:1px solid #c9a227;background:#f5deb3;padding:4px 8px;text-align:left;font-size:12px"'
        td = 'style="border:1px solid #c9a227;padding:4px 8px;color:#c00000;font-size:12px"'
        table = ("<table style=\"border-collapse:collapse;font-family:Calibri,Arial,sans-serif\"><tr>"
                 + "".join(f"<th {th}>{html.escape(c)}</th>" for c in COLUMNS) + "</tr><tr>"
                 + "".join(f"<td {td}>{html.escape(str(v))}</td>" for v in values) + "</tr></table>")
        greet = f"Dear {s['rqc_name']} San" if s["rqc_name"] else "Dear Sir"
        vehicle = (f"<p>@{html.escape(s['transport_name'])} San<br>Please provide vehicle no. for e-Way Bill</p>"
                   if s["transport_name"] else "<p>Please provide vehicle no. for e-Way Bill</p>")
        body = (f"<div style=\"font-family:Calibri,Arial,sans-serif;font-size:14px\">"
                f"<p>{html.escape(greet)}<br>Please punch {kind_word} as per below details. {why}</p>{table}{vehicle}"
                f"<p>Regards<br>{html.escape(sender)}</p></div>")
        msg = EmailMessage()
        # One line: a vendor name carrying a line break (it can come from ERP)
        # made the mail library refuse the header, and the draft failed every time.
        msg["Subject"] = " ".join(f"{row.ven_name} REJECTION".split())
        if s["to"]:
            msg["To"] = s["to"]
        if s["cc"]:
            msg["Cc"] = s["cc"]
        msg["Date"] = formatdate(localtime=True)
        msg["X-Unsent"] = "1"                 # Outlook: open as a new message to send
        msg.set_content(f"{greet}\nPlease punch {kind_word} as per below details. {why}\n\n"
                        + "\n".join(f"{c}: {v}" for c, v in zip(COLUMNS, values))
                        + f"\n\nRegards\n{sender}\n")
        msg.add_alternative(body, subtype="html")
        with atomic():
            self._log(row, "MAIL_OPENED", {"to": s["to"], "cc": s["cc"]}, user)
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", f"{row.request_no} {row.ven_name} rejection")[:80]
        return msg.as_bytes(), f"{safe}.eml"

    # ---- reading ----------------------------------------------------------------------

    def detail(self, pk):
        return self.to_dict(self._get(pk))

    def list(self, store_code, filters=None, page=1, page_size=PAGE_SIZE):
        """The mails made, newest first — to open one again."""
        f = filters or {}
        q = RejectionRequest.query.filter(RejectionRequest.store_code == store_code)
        text = _clean(f.get("q"), 100)
        if text:
            like = f"%{text}%"
            q = q.filter(or_(RejectionRequest.request_no.ilike(like), RejectionRequest.ven_name.ilike(like),
                             RejectionRequest.item_cd.ilike(like), RejectionRequest.item_desc.ilike(like),
                             RejectionRequest.grn_no.ilike(like), RejectionRequest.challan_no.ilike(like),
                             RejectionRequest.po_no.ilike(like)))
        total = q.count()
        page_size = max(1, min(int(page_size or PAGE_SIZE), MAX_PAGE_SIZE))
        pages = max(1, -(-total // page_size))
        page = max(1, min(int(page or 1), pages))
        rows = (q.order_by(RejectionRequest.created_at.desc(), RejectionRequest.id.desc())
                .offset((page - 1) * page_size).limit(page_size).all())
        return {"rows": [self.to_dict(r) for r in rows], "total": total, "page": page, "pages": pages,
                "page_size": page_size}

    def search_parts(self, store_code, q, limit=20):
        text = (q or "").strip()
        if len(text) < 2:
            return []
        like = f"%{text}%"
        rows = (Part.query.filter(Part.store_code == store_code,
                                  or_(Part.part_no.ilike(like), Part.part_name.ilike(like),
                                      Part.old_part_no.ilike(like), Part.specification.ilike(like)))
                .order_by(func.length(Part.part_no), Part.part_no).limit(max(1, min(int(limit), 50))).all())
        return [{"id": p.id, "part_no": p.part_no, "part_name": p.part_name, "uom": p.uom} for p in rows]

    @staticmethod
    def to_dict(r):
        return {
            "id": r.id, "request_no": r.request_no, "store_code": r.store_code, "kind": r.kind,
            "kind_label": KIND_LABELS.get(r.kind, r.kind), "part_id": r.part_id, "item_cd": r.item_cd,
            "item_desc": r.item_desc, "uom": r.uom, "hsn": r.hsn, "ven_cd": r.ven_cd, "ven_name": r.ven_name,
            "challan_no": r.challan_no, "challan_date": _iso(r.challan_date), "po_no": r.po_no,
            "po_date": _iso(r.po_date), "grn_no": r.grn_no, "grn_date": _iso(r.grn_date),
            "gate_entry_no": r.gate_entry_no, "from_erp_register": r.receiving_register_id is not None,
            "received_qty": _num(r.received_qty), "qty": _num(r.qty), "remark": r.remark,
            "created_by": r.created_by, "created_at": _iso(r.created_at),
        }

    # ---- internals --------------------------------------------------------------------

    @staticmethod
    def _get(pk):
        row = db.session.get(RejectionRequest, pk)
        if row is None:
            raise NotFoundError(f"Rejection mail {pk} not found")
        return row

    @staticmethod
    def _part(store_code, part_id):
        try:
            pid = int(part_id)
        except (TypeError, ValueError):
            raise BadRequestError("Pick the part") from None
        part = Part.query.filter(Part.id == pid, Part.store_code == store_code).first()
        if part is None:
            raise BadRequestError("That part is not in this store")
        return part

    @staticmethod
    def _part_id_for(store_code, rr):
        if rr is None:
            return None
        part = Part.query.filter(Part.store_code == store_code,
                                 func.upper(func.trim(Part.part_no)) == _key(rr.item_cd)).first()
        return part.id if part else None

    @staticmethod
    def _next_no():
        stamp = f"REJ-{_today():%Y%m%d}-"
        last = (db.session.query(func.max(RejectionRequest.request_no))
                .filter(RejectionRequest.request_no.like(f"{stamp}%")).scalar())
        n = int(last.rsplit("-", 1)[1]) + 1 if last else 1
        return f"{stamp}{n:03d}"

    @staticmethod
    def _log(row, action, details, user):
        db.session.add(RejectionHistory(request_ref=row.id, action=action, from_status=None, to_status=None,
                                        details=json.dumps(details) if details else None, by=_who(user)))
