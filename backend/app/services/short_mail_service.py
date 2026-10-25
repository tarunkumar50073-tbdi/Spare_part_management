"""Short Mail — the mail the store sends Purchase when material came short
against an invoice (the store, 25 Oct 2026: "jis din, jis invoice me jitna part
short receive hua uski material short receive ki mail"; "short mail and
rejection mail alag alag ho"). One mail per invoice and day, every short part of
it in one table, in the store's own words:

    Dear Sir,
    This is to inform you that today we have short material received against
    invoice no. ----- on dated -----. Detail is given below:-
    Part No. | Part Description | Invoice Qty | Received Qty | Short Qty

The parts come from the ERP GRN lines on the Short tab (or are typed in while ERP
is not reachable). The mail is a DRAFT the app hands over as an .eml (X-Unsent):
Outlook opens it ready to send and the store sends it — the app's mail engine is
not used and nothing leaves on its own. Apart from the To / CC, nothing is kept.
It is separate from the Rejection Mail to RQC: its own right (short_mail), its
own To / CC.
"""
import html
import re
from decimal import Decimal, InvalidOperation
from email.message import EmailMessage
from email.utils import formatdate

from app.extensions import db
from app.models.app_setting import AppSetting
from app.services.rejection_request_service import (
    MAX_QTY, _clean, _date, _dmy, _emails, _need, _num, _qty, _today, _who,
)
from app.utils.exceptions import BadRequestError

SETTING_KEY = "short_mail"
# Purchase's addresses — set once on the screen, empty until then.
MAIL_DEFAULTS = {"to": "", "cc": ""}
COLUMNS = ("Part No.", "Part Description", "Invoice Qty", "Received Qty", "Short Qty")
MAX_LINES = 60


def _received(value, label):
    """Received qty: 0 (nothing came) or more, two decimals at most."""
    if value in (None, ""):
        raise BadRequestError(f"{label} is required")
    try:
        qty = Decimal(str(value).strip())
    except (InvalidOperation, ValueError, AttributeError):
        raise BadRequestError(f"{label} must be a number") from None
    if not qty.is_finite() or qty < 0:
        raise BadRequestError(f"{label} cannot be less than 0")
    if qty > MAX_QTY:
        raise BadRequestError(f"{label} is too large")
    if qty != qty.quantize(Decimal("0.01")):
        raise BadRequestError(f"{label} can have at most 2 decimals")
    return qty


class ShortMailService:

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
        AppSetting.set_value(SETTING_KEY, out, _who(user))
        db.session.commit()
        return out

    # ---- the mail -------------------------------------------------------------------

    def read(self, data):
        """The mail's details, checked: supplier, invoice no. / date, the day it
        was received and 1 to MAX_LINES short parts (received below invoiced)."""
        data = data or {}
        supplier = _need(data, "supplier", 160, "Supplier")
        invoice_no = _need(data, "invoice_no", 60, "Invoice no.")
        invoice_date = _date(data.get("invoice_date"), "Invoice date")
        received_on = _date(data.get("received_on"), "Received on") or _today()
        raw = data.get("lines")
        if not isinstance(raw, list) or not raw:
            raise BadRequestError("Add at least one short part")
        if len(raw) > MAX_LINES:
            raise BadRequestError(f"At most {MAX_LINES} parts in one mail")
        lines = []
        for n, ln in enumerate(raw, start=1):
            if not isinstance(ln, dict):
                raise BadRequestError(f"Part {n}: not a part line")
            part_no = _need(ln, "part_no", 60, f"Part {n}: Part No.")
            invoiced = _qty(ln.get("invoice_qty"), f"{part_no}: Invoice qty")
            received = _received(ln.get("received_qty"), f"{part_no}: Received qty")
            if received >= invoiced:
                raise BadRequestError(f"{part_no}: received {_num(received)} of {_num(invoiced)} is not short")
            lines.append({"part_no": part_no, "description": _clean(ln.get("description"), 255, f"{part_no}: Description") or "",
                          "invoice_qty": invoiced, "received_qty": received, "short_qty": invoiced - received})
        return {"supplier": supplier, "invoice_no": invoice_no, "invoice_date": invoice_date,
                "received_on": received_on, "lines": lines}

    def draft(self, data, user=None):
        """(bytes, file name) of the short mail to Purchase as an unsent .eml:
        Outlook opens it as a new message, addressed, ready to send."""
        m = self.read(data)
        s = self.settings()
        sender = getattr(user, "full_name", None) or getattr(user, "username", None) or "Store"
        # "today" is the store's word for the day the mail goes out; a mail made
        # for an earlier day names that day instead.
        when = "today" if m["received_on"] == _today() else f"on {_dmy(m['received_on'])}"
        dated = f" on dated {_dmy(m['invoice_date'])}" if m["invoice_date"] else ""
        intro = (f"This is to inform you that {when} we have short material received against "
                 f"invoice no. {m['invoice_no']}{dated}. Detail is given below:-")
        rows = [(ln["part_no"], ln["description"], _num(ln["invoice_qty"]), _num(ln["received_qty"]),
                 _num(ln["short_qty"])) for ln in m["lines"]]
        th = 'style="border:1px solid #c9a227;background:#f5deb3;padding:4px 8px;text-align:left;font-size:12px"'
        td = 'style="border:1px solid #c9a227;padding:4px 8px;font-size:12px"'
        short_td = 'style="border:1px solid #c9a227;padding:4px 8px;font-size:12px;color:#c00000;font-weight:bold"'
        table = ("<table style=\"border-collapse:collapse;font-family:Calibri,Arial,sans-serif\"><tr>"
                 + "".join(f"<th {th}>{html.escape(c)}</th>" for c in COLUMNS) + "</tr>"
                 + "".join("<tr>" + "".join(f"<td {short_td if i == 4 else td}>{html.escape(str(v))}</td>"
                                            for i, v in enumerate(r)) + "</tr>" for r in rows)
                 + "</table>")
        body = (f"<div style=\"font-family:Calibri,Arial,sans-serif;font-size:14px\">"
                f"<p>Dear Sir,<br>{html.escape(intro)}</p>{table}"
                f"<p>Regards<br>{html.escape(sender)}</p></div>")
        msg = EmailMessage()
        # One line: a supplier name carrying a line break (it can come from ERP)
        # would make the mail library refuse the header.
        msg["Subject"] = " ".join(f"{m['supplier']} SHORT MATERIAL RECEIVED - INVOICE NO. {m['invoice_no']}".split())
        if s["to"]:
            msg["To"] = s["to"]
        if s["cc"]:
            msg["Cc"] = s["cc"]
        msg["Date"] = formatdate(localtime=True)
        msg["X-Unsent"] = "1"                 # Outlook: open as a new message to send
        msg.set_content("Dear Sir,\n" + intro + "\n\n" + " | ".join(COLUMNS) + "\n"
                        + "\n".join(" | ".join(str(v) for v in r) for r in rows)
                        + f"\n\nRegards\n{sender}\n")
        msg.add_alternative(body, subtype="html")
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", f"{m['supplier']} short {m['invoice_no']}")[:80]
        return msg.as_bytes(), f"{safe}.eml"
