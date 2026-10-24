"""Notification Engine — what is mailed, when, to whom and in which words.

`email_engine` only moves mails. This module decides them:

- RULES: a fixed catalogue of scheduled mails. An admin sets when a rule runs,
  whether it is on and — for the two with a free audience — who gets it. Two
  rules hand over to the senders that existed before the engine (the reorder
  list, the window-time sheet); the other four build their mail here, three
  of them with the full list attached as Excel. The excess list is
  routed like the reorder list: one mail per department ticked for the
  reorder mail, to that department's people, with that department's parts.
- TEMPLATES: the subject, the opening and the closing lines of each mail type.
  The built-in text of the two old mails is word for word what they always
  said. One signature is shared by the mails built here.
- REMINDERS: chase the open Action Tracker lines as their target date comes up
  and escalate the ones left overdue.
- The manual alert an admin types and sends to chosen people.

Every mail goes through `EmailEngine.submit`, so it is on record, retried and
shown in Email Logs. Everything ships switched off.

A rule runs once per plant-local day. The day and the clock are the server's
own zone through the measured offset, and every function that asks "what time
is it" takes `now` (naive UTC, like every stored timestamp) so the clock can be
set from outside.
"""
import logging
import re
from datetime import date, datetime, time, timedelta, timezone
from html import escape

from flask import current_app
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models.app_setting import AppSetting
from app.models.department_recipient import ROLES
from app.models.email_engine import (
    STATUS_QUEUED, STATUS_SENDING, STATUS_SKIPPED, TRIGGER_MANUAL, TRIGGER_RULE, TRIGGER_SCHEDULED,
    EmailMessage, NotificationState,
)
from app.models.store import Store
from app.repositories.department_repository import DepartmentRepository
from app.repositories.report_recipient_repository import ReportRecipientRepository
from app.services.consumption_analytics_service import _local_offset, _utc_naive
from app.services.email_engine import ENGINE_OFF, EmailEngine, _valid_address, normalise_recipients
from app.services.reorder_mail_service import (
    BUILD_FAILED, STORE_CODE, ReorderMailService, _n, mark_cell, part_cells, sheet_name,
    supplier_names, xlsx_attachment,
)
from app.services.spare_dashboard_service import SpareDashboardService, _as_date
from app.services.spare_stock_service import SpareStockService
from app.services.stock_mis_report import LEVEL_BANDS, WHITE, _grouped, daily_stock_report
from app.services.window_time_mail_service import REPORT_KEY, WindowTimeMailService
from app.utils import mailer
from app.utils.exceptions import AppException, BadRequestError, NotFoundError
from app.utils.mailer import SYSTEM_NOTE

logger = logging.getLogger("dxstore.email_rules")

RULES_SETTING_KEY = "notification_rules"
TEMPLATES_SETTING_KEY = "mail_templates"
REMINDERS_SETTING_KEY = "reminder_rules"

# The rule catalogue. `audience` says where the recipients come from: "custom"
# is chosen on the rule itself, the other two are kept on their own master
# screens. `env` names the .env flags (<env>_ENABLED / <env>_HOUR) of the daily
# mail thread a rule took over from.
RULES = (
    {"key": "reorder_daily", "title": "Reorder list to departments", "mail_type": "reorder",
     "audience": "departments_flagged", "label": "parts to reorder", "env": "REORDER_MAIL",
     "description": "Mails each department ticked for the reorder mail its parts at or below the reorder level."},
    {"key": "excess_list", "title": "Excess parts list", "mail_type": "excess_list",
     "audience": "departments_flagged", "label": "parts above maximum",
     "description": "Mails each department ticked for the reorder mail the list of its parts above their "
                    "maximum level as an Excel sheet, the dearest excess first."},
    {"key": "stock_report", "title": "Daily stock report", "mail_type": "stock_report",
     "audience": "custom", "label": "parts in the report",
     "description": "The Daily Stock Report as an attached Excel workbook — summary, every part, "
                    "critical & reorder, excess, by category — with one line of totals in the mail."},
    {"key": "tracker_digest", "title": "Action Tracker summary", "mail_type": "tracker_digest",
     "audience": "custom", "label": "open Action Tracker lines",
     "description": "The Action Tracker as a table: each open point, who has to act on it and by when."},
    {"key": "window_time_daily", "title": "Supplier window-time sheet", "mail_type": "window_time",
     "audience": "report_recipients", "label": "window-time sheet of the month", "env": "WINDOW_TIME_MAIL",
     "description": "Mails the current month's supplier window-time sheet to the Report Recipients."},
    # The store's request of 17 Oct 2026 — "short ki mail banani padegi agar kisi
    # supplier se short receive hua to mail jaayegi", "rejection ka bhi banana
    # padega": what suppliers sent short and what quality rejected, as the Short
    # & Rejection screen's own workbooks — one per kind, never mixed. Like every
    # rule it starts switched off, with no one in its audience: nothing is mailed
    # until the store says so (all mail on hold since 17 Oct 2026).
    {"key": "short_rejection", "title": "Short & Rejection list", "mail_type": "short_rejection",
     "audience": "custom", "label": "GRN lines short or rejected",
     "description": "The GRN lines of the last 90 days that a supplier sent short, and those with an SRV "
                    "rejection, supplier-wise and line by line with the days pending — two attached Excel "
                    "workbooks, never mixed — with one line of totals for each in the mail."},
)
_RULE = {spec["key"]: spec for spec in RULES}
RULE_FIELDS = ("enabled", "hour", "minute", "days", "department_ids", "emails")
AUDIENCE_FIELDS = ("department_ids", "emails")
MAX_ADDRESSES = 50

# Built-in wording per mail type. "reorder" and "window_time" keep the subject
# those two mails always had. The parts mails (reorder, excess, stock report)
# carry their list only as the attached Excel — no table in the body, the
# store's instruction of 14 Oct 2026 — so their opening points to it. Their
# closing is NOT the old
# "Regards, <name>" any more: every mail now ends with mailer.SYSTEM_NOTE
# (a dashed rule, then "Note: This is a system-generated mail.") — a deliberate
# change on the store's instruction, pinned by the tests; do not restore the
# old text.
TEMPLATES = (
    {"mail_type": "reorder", "title": "Reorder list",
     "placeholders": ("{department}", "{count}", "{date}", "{store}"),
     "subject": "Spare Reorder Alert — {department} — {count} part(s) [{date}]",
     "intro": "Dear Sir,\n\nPlease find attached the list of {count} spare part(s) for {department} "
              "that are at or below the reorder level and need a purchase order.",
     "footer": SYSTEM_NOTE},
    {"mail_type": "window_time", "title": "Window-time sheet",
     "placeholders": ("{date}", "{store}"),
     "subject": "SUPPLIER WINDOW TIME ON DATED {date}",
     "intro": "Dear Sir,\n\nPlease find attached supplier window time sheet.",
     "footer": SYSTEM_NOTE},
    {"mail_type": "excess_list", "title": "Excess parts list",
     "placeholders": ("{department}", "{count}", "{date}", "{store}"),
     "subject": "Excess Parts — {department} — {count} part(s) above maximum [{date}]",
     "intro": "Dear Sir,\n\nPlease find attached the list of {count} spare part(s) for {department} "
              "that are above their maximum level.",
     "footer": "Please stop ordering these parts and review their maximum level."},
    {"mail_type": "stock_report", "title": "Daily stock report",
     "placeholders": ("{count}", "{date}", "{store}"),
     "subject": "Daily Stock Report — {store} [{date}]",
     "intro": "Dear Sir,\n\nPlease find attached the daily stock report of {store}.",
     "footer": ""},
    {"mail_type": "tracker_digest", "title": "Action Tracker summary",
     "placeholders": ("{count}", "{date}", "{store}"),
     "subject": "Action Tracker — {count} open point(s) [{date}]",
     "intro": "Dear Sir,\n\nThe open points of {store}, with who has to act on each and by when:",
     "footer": "Please keep the owner and the target date of every open point up to date on the Action Tracker page."},
    {"mail_type": "tracker_reminder", "title": "Reminder",
     "placeholders": ("{problem}", "{count}", "{date}", "{store}"),
     "subject": "Reminder — {problem} [{date}]",
     "intro": "Dear Sir,\n\nThis open point of {store} is due for action:",
     "footer": "Please complete the action, or set a new target date on the Action Tracker page."},
    {"mail_type": "tracker_escalation", "title": "Escalation",
     "placeholders": ("{problem}", "{count}", "{date}", "{store}"),
     "subject": "Escalation — {problem} is overdue [{date}]",
     "intro": "Dear Sir,\n\nThis open point of {store} is past its target date and still open:",
     "footer": "Please follow up with the owners so that it is closed."},
    # No closing lines of its own: the mail ends with the shared signature (the
    # dashed line and the system note), as the stock report does.
    {"mail_type": "short_rejection", "title": "Short & Rejection list",
     "placeholders": ("{count}", "{date}", "{store}"),
     "subject": "Short & Rejection — {count} GRN line(s) [{date}]",
     "intro": "Dear Sir,\n\nPlease find attached the GRN lines of {store} of the last 90 days that a supplier "
              "sent short or quality rejected, supplier-wise and line by line with the days pending.",
     "footer": ""},
)
_TEMPLATE = {spec["mail_type"]: spec for spec in TEMPLATES}
TEMPLATE_LIMITS = {"subject": 200, "intro": 2000, "footer": 2000}
IDENTITY_DEFAULTS = {"signature": SYSTEM_NOTE, "reply_to": None}
SIGNATURE_MAX = 200
_PLACEHOLDER = re.compile(r"\{([a-z_]+)\}")

REMINDER_DEFAULTS = {"enabled": False, "hour": 9, "minute": 0, "remind_before_days": 2,
                     "repeat_every_days": 1, "escalate_after_days": 3, "escalate_to": [], "owners": {}}
REMINDER_RANGES = {"hour": (0, 23), "minute": (0, 59), "remind_before_days": (0, 365),
                   "repeat_every_days": (1, 365), "escalate_after_days": (0, 365)}
# notification_state keys: one row per tracker line, and one for the day the
# scheduled reminder run last happened.
STATE_PREFIX = f"tracker:{STORE_CODE}:"
RUN_MARKER = f"reminders:{STORE_CODE}:last_run"

ALERT_FIELDS = ("subject", "message", "department_ids", "emails", "include")
ALERT_INCLUDES = ("none", "critical", "tracker")
ALERT_SUBJECT_MAX = 200
ALERT_MESSAGE_MAX = 5000

CRITICAL_STATUSES = ("Out of Stock", "Below Minimum")
TOP_PARTS = 50      # rows in the critical parts table; the totals line counts them all
CRITICAL_HEADERS = ("Part No", "Description", "Status", "Stock", "Min", "Max", "Location", "Section")
EXCESS_COLUMNS = ("Section", "Category", "Part No", "Description", "Supplier", "Location", "UOM", "In Stock",
                  "Max", "Excess Qty", "Rate", "Excess Value")
# The excess sheet's colours, the store's (14 Oct 2026: "excess wali me karen"
# — he chose "In Stock yellow + Excess Value ₹ ke hisaab se"). Every In Stock
# cell in the yellow of the Daily Stock Report's above-max stock (stock_mis_report
# LEVEL_BANDS "high"); the Excess Value by the money it ties up — solid dark
# amber from EXCESS_HIGH_RUPEES, yellow from EXCESS_WATCH_RUPEES, no colour
# below that or with no rate. The thresholds are whole rupees: change them here,
# the legend follows. Colours as (fill, text). The Reports page's Excess Parts
# download is coloured by the same code (excess_paint).
EXCESS_HIGH_RUPEES = 100_000
EXCESS_WATCH_RUPEES = 25_000
EXCESS_YELLOW = LEVEL_BANDS["high"]
EXCESS_DARK_AMBER = ("D97706", WHITE)
EXCESS_LEGEND = (f"In Stock: yellow = above max · Excess Value: dark amber = ₹{_grouped(EXCESS_HIGH_RUPEES)} "
                 f"or more · yellow = ₹{_grouped(EXCESS_WATCH_RUPEES)} to ₹{_grouped(EXCESS_HIGH_RUPEES)}")
TRACKER_HEADERS = ("Problem", "Count", "₹ at stake", "Action needed", "Action by", "Target date", "Status")
_STATUS_RANK = {"OPEN": 0, "UNKNOWN": 1, "CLEAR": 2}

# The Short & Rejection rule's own reasons: an empty list, and a list that
# could not be read (tried again on the next tick, like the tracker).
NOTHING_SHORT = "nothing_short_or_rejected"
SHORT_UNREADABLE = "short_rejection_unavailable"
# Why a run sends nothing, in words — for a rule's "last run", the preview and
# the body of the SKIPPED row. The row's last_error keeps the code.
REASON_WORDS = {
    NOTHING_SHORT: "nothing short or rejected",
    SHORT_UNREADABLE: "the Short & Rejection list could not be read",
    "nothing_to_report": "nothing to report",
    "nothing_to_reorder": "no part to reorder",
    "no_recipient": "no one to mail",
    "no_recipient_email": "no one to mail",
    "no_department_flagged": "no department is ticked for the reorder mail",
    "smtp_not_configured": "the mail server is not configured",
    "already_sent_today": "today's mail has already gone out",
    "tracker_unavailable": "the Action Tracker could not be read",
    "report_build_failed": "the window-time sheet could not be built",
    BUILD_FAILED: "a department's list could not be built",
}
# Why a scheduled run could not happen at this moment. That is not the day's
# answer: the run is raised instead of recorded, so it shows on the engine's
# health and the next tick tries again.
RETRY_REASONS = ("tracker_unavailable", "report_build_failed", SHORT_UNREADABLE)
# A preview of these says "0" items rather than "not known".
EMPTY_REASONS = ("nothing_to_report", NOTHING_SHORT)

# Inline styles only: a mail client drops <style> blocks and loads nothing external.
_BODY = "margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937;"
_P = "margin:0 0 12px 0;"
_SIGN = "margin:20px 0 0 0;font-size:12px;color:#6b7280;"
# A parts table repeats its cell style a thousand times, and Gmail clips a mail
# past about 102 KB. So the font, the colour and the alignment are said once —
# on the table (Outlook does not reliably hand the body's font down into one)
# and on each row — and a cell keeps only its border and its padding.
_TABLE = ("border-collapse:collapse;margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:13px;"
          "color:#1f2937;text-align:left;")
_ROW = '<tr valign="top">'
_CELL = "border:1px solid #d1d5db;padding:5px 8px"
_HEAD = _CELL + ";background:#f3f4f6;font-weight:bold;text-align:left"


def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _plant(now):
    """`now` (naive UTC) on the plant clock."""
    return now + _local_offset()


def _dict(value):
    return value if isinstance(value, dict) else {}


def _saved(setting_key):
    return _dict(AppSetting.get_value(setting_key))


# ---- request validation ----

def _is_int(value):
    return isinstance(value, int) and not isinstance(value, bool)


def _fields(data, allowed):
    """The request body, checked: a JSON object with at least one field, every
    one of them known — a typo is refused whole, never half-applied."""
    if not isinstance(data, dict) or not data:
        raise BadRequestError(f"Send at least one of: {', '.join(allowed)}")
    unknown = sorted(set(data) - set(allowed))
    if unknown:
        raise BadRequestError(f"Unknown field: {', '.join(unknown)}")
    return data


def _flag(value, name):
    if not isinstance(value, bool):
        raise BadRequestError(f"'{name}' must be true or false")
    return value


def _whole(value, name, low, high):
    if not _is_int(value) or not low <= value <= high:
        raise BadRequestError(f"'{name}' must be a whole number from {low} to {high}")
    return value


def _days(value):
    if not isinstance(value, list) or any(not _is_int(d) or not 0 <= d <= 6 for d in value):
        raise BadRequestError("'days' must be a list of day numbers, 0 (Monday) to 6 (Sunday)")
    return sorted(set(value))


def _typed(value, name, limit):
    """A typed text field: text, its line ends made uniform, the blank space
    around it dropped, and within its length."""
    if not isinstance(value, str):
        raise BadRequestError(f"'{name}' must be text")
    text = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    if len(text) > limit:
        raise BadRequestError(f"'{name}' can be at most {limit} characters")
    return text


def _one_line(value, name, limit):
    """A subject: a line break in a mail header is refused by the mailer (it
    is how a header is forged), so it is refused here, where it can be fixed."""
    text = _typed(value, name, limit)
    if "\n" in text:
        raise BadRequestError(f"'{name}' must be a single line")
    return text


def _department_ids(value, name="department_ids"):
    if not isinstance(value, list) or any(not _is_int(i) for i in value):
        raise BadRequestError(f"'{name}' must be a list of department ids")
    repo, ids = DepartmentRepository(), []
    for dept_id in value:
        if repo.get_by_id(dept_id) is None:
            raise BadRequestError(f"Department {dept_id} does not exist")
        if dept_id not in ids:
            ids.append(dept_id)
    return ids


def _addresses(value, name):
    """Typed extra addresses as [{"email", "role"}]: every address in a valid
    format (the rule the mail engine itself sends by), every role one of To /
    Cc / Bcc — To when none is given — and each address once."""
    if not isinstance(value, list) or len(value) > MAX_ADDRESSES:
        raise BadRequestError(f"'{name}' must be a list of at most {MAX_ADDRESSES} addresses")
    out, seen = [], set()
    for entry in value:
        if not isinstance(entry, dict):
            raise BadRequestError(f"Each entry of '{name}' needs an 'email' and a 'role'")
        email = _valid_address(entry.get("email"))
        if email is None:
            raise BadRequestError(f"'{str(entry.get('email'))[:80]}' is not a valid e-mail address")
        role = str(entry.get("role") or "TO").strip().upper()
        if role not in ROLES:
            raise BadRequestError(f"The role of {email} must be TO, CC or BCC")
        if email.lower() not in seen:
            seen.add(email.lower())
            out.append({"email": email, "role": role})
    return out


def _saved_addresses(value):
    """Extra addresses as they were saved, minus anything a hand-edited row got wrong."""
    out = []
    for entry in value if isinstance(value, list) else []:
        email = _valid_address(entry.get("email")) if isinstance(entry, dict) else None
        if email and str(entry.get("role") or "TO").upper() in ROLES:
            out.append({"email": email, "role": str(entry.get("role") or "TO").upper()})
    return out


def _saved_ids(value):
    return [i for i in value if _is_int(i)] if isinstance(value, list) else []


# ---- recipients ----

def _audience(department_ids, emails):
    """(to, cc, bcc) of a free audience: the active people with an address of
    every chosen department, each in the role the Department Emails master
    gives them, plus the extra addresses. A department that no longer exists
    adds no one. Cleaned the way the engine sends: each address once, and with
    a Cc but no To the first Cc becomes the To."""
    buckets = {role: [] for role in ROLES}
    repo = DepartmentRepository()
    for dept_id in department_ids:
        dept = repo.get_by_id(dept_id)
        if dept is not None:
            for role, found in zip(ROLES, ReorderMailService._recipients(dept)):
                buckets[role] += found
    for entry in emails:
        buckets[entry["role"]].append(entry["email"])
    return normalise_recipients(*(buckets[role] for role in ROLES))


def _rule_recipients(spec, settings):
    """Who a run of the rule would mail right now, as (to, cc, bcc)."""
    if spec["audience"] == "custom":
        return _audience(settings["department_ids"], settings["emails"])
    if spec["audience"] == "report_recipients":
        to, cc = ReportRecipientRepository().recipients_for(REPORT_KEY)
        # The sheet is not sent without a To address — then no one gets it.
        return normalise_recipients(to, cc) if to else ([], [], [])
    buckets = [[], [], []]
    for dept in DepartmentRepository().list_all(active_only=True):
        if dept.notify_reorder:
            for bucket, found in zip(buckets, ReorderMailService._recipients(dept)):
                bucket += found
    return normalise_recipients(*buckets)


# ---- templates and the shared identity (app_settings key "mail_templates") ----

def _template_spec(mail_type):
    spec = _TEMPLATE.get(mail_type)
    if spec is None:
        raise NotFoundError(f"There is no template for the mail type '{mail_type}'")
    return spec


def template(mail_type):
    """One mail type's wording: what was saved over the built-in text."""
    spec = _template_spec(mail_type)
    saved = _dict(_dict(_saved(TEMPLATES_SETTING_KEY).get("templates")).get(mail_type))
    defaults = {field: spec[field] for field in TEMPLATE_LIMITS}
    text = {field: saved[field] if isinstance(saved.get(field), str) and saved[field].strip() else defaults[field]
            for field in TEMPLATE_LIMITS}
    return {"mail_type": mail_type, "title": spec["title"], **text, "defaults": defaults,
            "is_default": text == defaults, "placeholders": list(spec["placeholders"])}


def identity():
    """The signature under every mail built here, and the Reply-To address."""
    saved = _dict(_saved(TEMPLATES_SETTING_KEY).get("identity"))
    signature = saved.get("signature")
    return {"signature": signature.strip() if isinstance(signature, str) and signature.strip()
            else IDENTITY_DEFAULTS["signature"],
            "reply_to": _valid_address(saved.get("reply_to"))}


def list_templates():
    return {"identity": identity(), "templates": [template(spec["mail_type"]) for spec in TEMPLATES]}


def save_template(mail_type, data, user=None):
    """Save any of subject / intro / footer. An empty field — or the built-in
    text typed back in — drops what was saved, so the mail type reads as
    "default" again and a mail never goes out with a blank subject."""
    spec = _template_spec(mail_type)
    data = _fields(data, tuple(TEMPLATE_LIMITS))
    saved = _saved(TEMPLATES_SETTING_KEY)
    templates = dict(_dict(saved.get("templates")))
    mine = dict(_dict(templates.get(mail_type)))
    for field, limit in TEMPLATE_LIMITS.items():
        if field not in data:
            continue
        text = _one_line(data[field], field, limit) if field == "subject" else _typed(data[field], field, limit)
        if text and text != spec[field]:
            mine[field] = text
        else:
            mine.pop(field, None)
    templates[mail_type] = mine
    AppSetting.set_value(TEMPLATES_SETTING_KEY, {**saved, "templates": templates}, user)
    return template(mail_type)


def save_identity(data, user=None):
    data = _fields(data, tuple(IDENTITY_DEFAULTS))
    saved = _saved(TEMPLATES_SETTING_KEY)
    mine = dict(_dict(saved.get("identity")))
    if "signature" in data:
        mine["signature"] = _typed(data["signature"], "signature", SIGNATURE_MAX)
    if "reply_to" in data:
        address = None
        if data["reply_to"] not in (None, ""):
            address = _valid_address(data["reply_to"])
            if address is None:
                raise BadRequestError("'reply_to' must be an e-mail address, or empty")
        mine["reply_to"] = address
    AppSetting.set_value(TEMPLATES_SETTING_KEY, {**saved, "identity": mine}, user)
    return identity()


def _store_name():
    store = Store.query.filter_by(code=STORE_CODE).first()
    return store.name if store else STORE_CODE


def _fill(text, values):
    """Put the values in place of their {placeholders}. One pass over the typed
    text, so a value (a department's name, say) is never read as a placeholder
    itself; a placeholder this mail has no value for stays as typed."""
    return _PLACEHOLDER.sub(lambda found: values.get(found.group(1), found.group(0)), text)


def mail_wording(mail_type, **facts):
    """{"subject", "intro", "footer"} of a mail type with its placeholders
    filled in. `facts` are this mail's own values (count, date, department,
    problem); the store's name is always there. A date reads DD.MM.YYYY and a
    whole number in Indian digit grouping (1,242), as in the mail's own lines."""
    wording = template(mail_type)
    values = {"store": _store_name()}
    for name, value in facts.items():
        values[name] = (value.strftime("%d.%m.%Y") if isinstance(value, date)
                        else _grouped(value) if isinstance(value, int) and not isinstance(value, bool)
                        else str(value))
    return {field: _fill(wording[field], values) for field in TEMPLATE_LIMITS}


# ---- the HTML mails ----

def _paragraphs(text, style=_P):
    """Typed text as HTML: escaped first, then a blank line starts a new
    paragraph and a line break stays a line break."""
    blocks = [block.strip() for block in re.split(r"\n\s*\n", text or "") if block.strip()]
    return "".join(f'<p style="{style}">{escape(block).replace(chr(10), "<br>")}</p>' for block in blocks)


def _table(headers, rows):
    head = "".join(f'<th style="{_HEAD}">{escape(cell)}</th>' for cell in headers)
    body = "".join(_ROW + "".join(f'<td style="{_CELL}">{escape(cell)}</td>' for cell in row) + "</tr>"
                   for row in rows)
    return f'<table cellpadding="0" cellspacing="0" style="{_TABLE}">{_ROW}{head}</tr>{body}</table>'


def _layout(opening, blocks, closing, signed=True):
    """(text, html) of one mail: the opening lines, each block — a totals line,
    a table, a note, whichever it has — the closing lines and the shared
    signature (`signed=False` for a mail whose own closing lines end it). Both
    bodies carry the same facts. Everything that was typed or comes from the
    data is escaped on its way into the HTML; the only markup is what is
    written in this module."""
    signature = identity()["signature"] if signed else ""
    # A closing that already ends with the signature (the system note typed
    # into a footer on Email Templates) does not get it a second time.
    if signature and (closing or "").strip().endswith(signature.strip()):
        signature = ""
    text, parts = [opening], [_paragraphs(opening)]
    for block in blocks:
        if block.get("line"):
            text.append(block["line"])
            parts.append(f'<p style="{_P}"><strong>{escape(block["line"])}</strong></p>')
        if block.get("rows"):
            text.append("\n".join(" | ".join(row) for row in (block["headers"], *block["rows"])))
            parts.append(_table(block["headers"], block["rows"]))
        if block.get("note"):
            text.append(block["note"])
            parts.append(_paragraphs(block["note"]))
    text += [closing, signature]
    parts += [_paragraphs(closing), _paragraphs(signature, _SIGN)]
    html = f'<!DOCTYPE html><html><body style="{_BODY}">{"".join(parts)}</body></html>'
    return "\n\n".join(part for part in text if part), html


def _digest(mail_type, count, blocks, now, files=None, **facts):
    """One rule mail. `files` builds its attachments; it is called only when
    the mail is really sent, so a preview never pays for an Excel sheet."""
    words = mail_wording(mail_type, count=count, date=_plant(now).date(), **facts)
    text, html = _layout(words["intro"], blocks, words["footer"])
    return {"subject": words["subject"], "text": text, "html": html, "count": count, "files": files}


def _rupees(value):
    """An amount in Indian digit grouping (₹ 38,96,674), as the Daily Stock
    Report and the screens show it."""
    return f"₹ {_grouped(value)}"


# ---- content: critical parts (the list a manual alert can carry) ----

def _critical_rows():
    """The store's zero-stock and below-minimum parts, worst first: no stock at
    all, then the largest gap under the minimum. A new list every time — the
    stock list's row dicts are shared with its cache and are only read here."""
    rows = [r for r in SpareStockService().list_stock(STORE_CODE, None) if r.get("status") in CRITICAL_STATUSES]
    rows.sort(key=lambda r: (r["status"] != "Out of Stock",
                             (r.get("qty_on_hand") or 0) - (r.get("min_stock_level") or 0),
                             r.get("part_no") or ""))
    return rows


def _critical_block():
    """(block, count): the totals line over every critical part and a table of
    the worst TOP_PARTS of them."""
    rows = _critical_rows()
    zero = sum(1 for r in rows if r["status"] == "Out of Stock")
    sections = SpareDashboardService._section_names(STORE_CODE) if rows else {}
    block = {
        "line": (f"{_grouped(len(rows))} critical parts · {_grouped(zero)} zero stock · "
                 f"{_grouped(len(rows) - zero)} below minimum"),
        "headers": CRITICAL_HEADERS,
        "rows": [[r.get("part_no") or "", r.get("part_name") or "", r["status"], _n(r.get("qty_on_hand")),
                  _n(r.get("min_stock_level")), _n(r.get("max_stock_level")), r.get("location") or "-",
                  sections.get(r.get("section_id")) or "-"] for r in rows[:TOP_PARTS]],
    }
    if len(rows) > TOP_PARTS:
        block["note"] = f"Only the {TOP_PARTS} worst parts are listed. The Store Stock screen has all {len(rows)}."
    return block, len(rows)


# ---- content: excess parts ----

def _excess_rows():
    """The store's parts above their maximum as (stock row, excess qty, excess
    value), dearest excess first; a part with no rate has no value and comes
    after the rated ones, largest quantity first — the order of the Critical ·
    Reorder · Excess screen. The stock list's rows are only read."""
    def dearest_first(entry):
        row, qty, value = entry
        return value is None, -(value or 0), -qty, row.get("part_no") or ""

    found = []
    for r in SpareStockService().list_stock(STORE_CODE, None):
        if r.get("status") == "Above Maximum" and r.get("max_stock_level"):
            qty, rate = round(r["qty_on_hand"] - r["max_stock_level"], 2), r.get("unit_price")
            found.append((r, qty, round(qty * rate, 2) if rate else None))
    return sorted(found, key=dearest_first)


def _excess_departments():
    """([(department, its excess parts, to, cc, bcc)], why not): the mails a
    run of the excess rule would send right now. The list is routed like the
    reorder mail, by the reorder mail's own functions: every active department
    ticked for the reorder mail, mailed to its own people, with the parts above
    maximum of the sections it covers. A department with no such part, or with
    no one to mail, is left out; when that leaves no mail at all, the reason
    says why. One read of the stock list serves every department."""
    svc = ReorderMailService()
    flagged = [dept for dept in svc.dept_repo.list_all(active_only=True) if dept.notify_reorder]
    if not flagged:
        return [], "no_department_flagged"
    sections, groups = svc._scopes()
    found = _excess_rows()
    mails, reason = [], "nothing_to_report"
    for dept in flagged:
        scope = svc._section_ids_for(dept.name, sections, groups)
        mine = [entry for entry in found if scope is None or entry[0].get("section_id") in scope]
        if not mine:
            continue
        to, cc, bcc = normalise_recipients(*svc._recipients(dept))
        if to or cc or bcc:
            mails.append((dept, mine, to, cc, bcc))
        else:
            reason = "no_recipient"
    return mails, None if mails else reason


def _excess_block(found):
    """The totals over all of a department's excess parts — the parts
    themselves are in the attached sheet. The money is that of the parts with
    a rate, so the line says how many have none."""
    unrated = sum(1 for _, _, value in found if value is None)
    line = (f"{_grouped(len(found))} parts above maximum · "
            f"{_rupees(sum(value for _, _, value in found if value is not None))} tied up")
    if unrated:
        line += f" · {_grouped(unrated)} without a rate, not valued"
    return {"line": line}


def _excess_mail(department, found, now, lead=""):
    """(subject, text, html) of one department's excess mail. `lead` is what a
    preview says above the opening lines."""
    words = mail_wording("excess_list", department=department, count=len(found), date=_plant(now).date())
    text, html = _layout(lead + words["intro"], [_excess_block(found)], words["footer"])
    return words["subject"], text, html


def _excess_value_colour(value):
    """(fill, text) of an Excess Value cell, or None for no colour: dark amber
    from EXCESS_HIGH_RUPEES, yellow from EXCESS_WATCH_RUPEES — AT a threshold
    counts — and none below it or with no value (a part with no rate)."""
    if value is None:
        return None
    if value >= EXCESS_HIGH_RUPEES:
        return EXCESS_DARK_AMBER
    return EXCESS_YELLOW if value >= EXCESS_WATCH_RUPEES else None


def excess_paint(columns):
    """The `paint` of an excess list laid out in `columns`: In Stock yellow on
    every row, Excess Value by _excess_value_colour. The cells are found by
    their heading, so one rule colours every sheet of the list, whatever its
    column order — this rule's attachment and the Reports page's Excess Parts
    download, which the store expects in the same colours (15 Oct 2026)."""
    column = {heading: number for number, heading in enumerate(columns, start=1)}

    def paint(ws, number, row):
        mark_cell(ws.cell(row=number, column=column["In Stock"]), *EXCESS_YELLOW)
        colour = _excess_value_colour(row.get("Excess Value"))
        if colour:
            mark_cell(ws.cell(row=number, column=column["Excess Value"]), *colour)
    return paint


_paint_excess_row = excess_paint(EXCESS_COLUMNS)


def _excess_sheet(department, found, day, sections, suppliers):
    """All of a department's excess parts as an Excel sheet, in the mail's
    order, coloured by _paint_excess_row with the legend under the table."""
    return xlsx_attachment(sheet_name("Excess Parts", department, day), EXCESS_COLUMNS, [
        {**part_cells(r, sections, suppliers), "Excess Qty": qty, "Excess Value": value}
        for r, qty, value in found], paint=_paint_excess_row, legend=EXCESS_LEGEND)


# ---- content: the stock report ----

def _stock_value(rows):
    return sum(r.get("stock_value") or 0 for r in rows)


def _stock_report_mail(now):
    """One line of totals, with the Daily Stock Report attached — the
    formatted workbook the Reports page also downloads, which holds every
    figure; the mail carries no table of its own."""
    rows = SpareStockService().list_stock(STORE_CODE, None)
    if not rows:
        return None, "nothing_to_report"
    counted = [r for r in rows if r.get("qty_on_hand") is not None]
    blocks = [{"line": f"{_grouped(len(rows))} parts · {_grouped(len(counted))} counted · "
                       f"stock value {_rupees(_stock_value(rows))}"}]

    return _digest("stock_report", len(rows), blocks, now, lambda: [daily_stock_report(STORE_CODE, now)]), None


# ---- content: short & rejection ----

def _short_rejection():
    """The Short & Rejection service, imported on first use: a problem there
    must cost this rule its mail only — not every rule in this module."""
    from app.services import short_rejection_service
    return short_rejection_service


# The kinds this mail carries, each as its own totals line and its own
# workbook — never one mixed list ("rejection and short mix nhi rhega na" — the
# store, 17 Oct 2026, when the screen was split into its Short and Rejection
# tabs). Line Rejection is not readable yet (short_rejection_service.
# erp_line_rejections), so it is not in the mail. The rule itself stays as the
# store left it — off, no one to mail ("ye mail wale kaam baad me kar dena").
SHORT_REJECTION_KINDS = ("short", "srv")


def _short_rejection_report(now):
    """(the service module, its reports — one per SHORT_REJECTION_KINDS) over
    the screen's default window: the 90 days to the plant day of `now`."""
    sr = _short_rejection()
    service, today = sr.ShortRejectionService(), _plant(now).date()
    return sr, [service.report(STORE_CODE, kind, today=today) for kind in SHORT_REJECTION_KINDS]


def _short_rejection_count(outs):
    return sum(out["totals"]["lines"] for out in outs)


def _short_rejection_blocks(outs):
    """One totals line per kind — its lines are in that kind's attached
    workbook — then how current the ERP data is and how each kind's days
    pending are counted. The money is that of the parts with a rate, so a line
    says how many have none."""
    blocks = []
    for out in outs:
        t = out["totals"]
        if not t["lines"]:
            blocks.append({"line": f"{out['label']}: none"})
            continue
        line = " · ".join([
            f"{out['label']}: {_grouped(t['lines'])} GRN line{'' if t['lines'] == 1 else 's'}",
            f"{_n(t['qty'])} qty" + (f" ({_rupees(t['value'])})" if t["value"] else ""),
            f"{_grouped(t['suppliers'])} supplier{'' if t['suppliers'] == 1 else 's'}",
            f"oldest {_grouped(t['oldest_days'] or 0)} days pending"])
        if t["unrated_lines"]:
            line += f" · {_grouped(t['unrated_lines'])} without a rate, not valued"
        blocks.append({"line": line})
    as_of = outs[0]["data_as_of"]
    known = (f"ERP data up to {date.fromisoformat(as_of['synced_day']):%d.%m.%Y}." if as_of["synced_day"]
             else "No ERP GRN data has been read yet.")
    blocks[-1]["note"] = " ".join([known, *(f"{out['label']}: {out['basis']['days']}" for out in outs)])
    return blocks


def _short_rejection_mail(now):
    """A totals line per kind and how the days are counted, with each kind's
    workbook attached — the one the screen's tab downloads, for the last 90
    days; a kind with nothing in it has no file. Nothing short or rejected at
    all: no mail."""
    try:
        sr, outs = _short_rejection_report(now)
    except Exception:  # noqa: BLE001 — the caller says "could not be read"; it never 500s a mail run
        db.session.rollback()
        logger.exception("the short & rejection list could not be read")
        return None, SHORT_UNREADABLE
    count = _short_rejection_count(outs)
    if not count:
        return None, NOTHING_SHORT
    return _digest("short_rejection", count, _short_rejection_blocks(outs), now,
                   lambda: [sr.attachment(out) for out in outs if out["totals"]["lines"]]), None


# ---- content: the action tracker ----

def _management():
    """The management service, imported on first use: it pulls in the ERP
    services, and a problem there must cost the tracker mails only — not every
    rule in this module."""
    from app.services import spare_management_service
    return spare_management_service


def _tracker():
    """The store's Action Tracker ({"items", "summary", …}), or None when it
    cannot be read right now."""
    try:
        return _management().SpareManagementService().management(STORE_CODE)["tracker"]
    except Exception:  # noqa: BLE001 — the caller says "tracker unavailable"; it never 500s a mail run
        db.session.rollback()
        logger.exception("the action tracker could not be read")
        return None


def _open_lines(items):
    return sum(1 for item in items if item.get("status") == "OPEN")


def _due_words(days):
    if days < 0:
        return f"Overdue by {-days} day{'' if days == -1 else 's'}"
    return "Due today" if days == 0 else f"Due in {days} day{'' if days == 1 else 's'}"


def _tracker_row(item, today):
    target = _as_date(item.get("target_date"))
    late = item.get("status") == "OPEN" and target is not None and target < today
    value = item.get("value")
    money = "-" if value is None else " ".join(filter(None, [_rupees(value), item.get("value_label")]))
    return [item.get("label") or item["key"], _n(item.get("count")), money, item.get("action") or "-",
            item.get("owner") or "-", target.strftime("%d.%m.%Y") if target else "-",
            "OVERDUE" if late else item.get("status") or "-"]


def _tracker_block(items, today):
    """The tracker as a table, open lines first (the tracker's own order within
    each status), under a line of totals."""
    rows = [_tracker_row(item, today)
            for item in sorted(items, key=lambda item: _STATUS_RANK.get(item.get("status"), 1))]
    statuses = [row[-1] for row in rows]
    return {"line": f"{_open_lines(items)} open · {statuses.count('OVERDUE')} overdue · "
                    f"{statuses.count('CLEAR')} clear",
            "headers": TRACKER_HEADERS, "rows": rows}


def _tracker_mail(now):
    tracker = _tracker()
    if tracker is None:
        return None, "tracker_unavailable"
    count = _open_lines(tracker["items"])
    if not count:
        return None, "nothing_to_report"
    return _digest("tracker_digest", count, [_tracker_block(tracker["items"], _plant(now).date())], now), None


# What each free-audience rule mails: now -> (mail, None) or (None, why not).
_BUILDERS = {"stock_report": _stock_report_mail, "tracker_digest": _tracker_mail,
             "short_rejection": _short_rejection_mail}


# ---- rules: settings (app_settings key "notification_rules") ----

def _spec(key):
    spec = _RULE.get(key)
    if spec is None:
        raise NotFoundError(f"There is no notification rule '{key}'")
    return spec


def _rule_defaults(spec):
    """A rule nobody has saved yet: off, 08:00, Monday to Saturday, no audience.
    The two rules that took over the old daily mail threads start from what
    those threads were told in .env — on or off, and the hour — and run every
    day, as the threads did."""
    out = {"enabled": False, "hour": 8, "minute": 0, "days": [0, 1, 2, 3, 4, 5],
           "department_ids": [], "emails": []}
    env = spec.get("env")
    if env:
        out["enabled"] = bool(current_app.config.get(f"{env}_ENABLED"))
        hour = current_app.config.get(f"{env}_HOUR")
        if _is_int(hour) and 0 <= hour <= 23:
            out["hour"] = hour
        out["days"] = list(range(7))
    return out


def rule_settings(key):
    """(settings, is_default) of a rule. Saved values are checked again on the
    way out, so a hand-edited row cannot schedule a rule at hour 99."""
    spec = _spec(key)
    out = _rule_defaults(spec)
    saved = _saved(RULES_SETTING_KEY).get(key)
    if not isinstance(saved, dict):
        return out, True
    if isinstance(saved.get("enabled"), bool):
        out["enabled"] = saved["enabled"]
    for name, top in (("hour", 23), ("minute", 59)):
        if _is_int(saved.get(name)) and 0 <= saved[name] <= top:
            out[name] = saved[name]
    if isinstance(saved.get("days"), list):
        out["days"] = sorted({d for d in saved["days"] if _is_int(d) and 0 <= d <= 6})
    if spec["audience"] == "custom":
        out["department_ids"] = _saved_ids(saved.get("department_ids"))
        out["emails"] = _saved_addresses(saved.get("emails"))
    return out, False


def save_rule(key, data, user=None, now=None):
    """Save the given settings of a rule over its current ones and return the
    Rule. From the first save on, the .env flags no longer decide anything for
    it: what the admin saw on screen is what was saved."""
    spec = _spec(key)
    data = _fields(data, RULE_FIELDS)
    if spec["audience"] != "custom" and any(field in data for field in AUDIENCE_FIELDS):
        raise BadRequestError(f"The audience of '{spec['title']}' is fixed and cannot be changed here")
    settings, _ = rule_settings(key)
    if "enabled" in data:
        settings["enabled"] = _flag(data["enabled"], "enabled")
    if "hour" in data:
        settings["hour"] = _whole(data["hour"], "hour", 0, 23)
    if "minute" in data:
        settings["minute"] = _whole(data["minute"], "minute", 0, 59)
    if "days" in data:
        settings["days"] = _days(data["days"])
    if "department_ids" in data:
        settings["department_ids"] = _department_ids(data["department_ids"])
    if "emails" in data:
        settings["emails"] = _addresses(data["emails"], "emails")
    AppSetting.set_value(RULES_SETTING_KEY, {**_saved(RULES_SETTING_KEY), key: settings}, user)
    return describe_rule(key, now)


# ---- rules: the schedule ----

def _day_key(key, day):
    """The reservation of a rule's scheduled run for one plant day."""
    return f"{key}:{day.isoformat()}"


def _run_marker(key):
    """The notification_state key that holds when a rule's scheduled run last
    went through."""
    return f"rule:{key}:last_run"


def _mark_run(marker_key, now, count=0):
    """Stamp a "last ran" marker with `now`, and commit."""
    marker = NotificationState.query.filter_by(key=marker_key).first()
    if marker is None:
        marker = NotificationState(key=marker_key, level=0)
        db.session.add(marker)
    marker.last_notified_at, marker.last_count = now, count
    db.session.commit()


def _marked_day(marker_key, offset):
    """The plant day a "last ran" marker was stamped on, or None."""
    marker = NotificationState.query.filter_by(key=marker_key).first()
    if marker is None or marker.last_notified_at is None:
        return None
    return (_utc_naive(marker.last_notified_at) + offset).date()


def _ran_today(spec, day, offset):
    """Has the rule's scheduled run for the plant day `day` happened? Its
    reservation — a mail, or the SKIPPED row of a run that sent nothing — says
    so. A rule with a fixed audience makes its mails under other keys (one per
    department, or the old sender's own for the reported day), so its run is
    marked done on its own — and only once it went through: a run that broke
    half way is taken up again on the next tick."""
    if db.session.query(EmailMessage.id).filter_by(dedup_key=_day_key(spec["key"], day)).first():
        return True
    return spec["audience"] != "custom" and _marked_day(_run_marker(spec["key"]), offset) == day


def rule_is_due(key, now=None):
    """Enabled, one of its days, at or past its time on the plant clock, and
    not run yet today — so a server that was down at the minute still catches
    up later the same day, and never runs a rule twice."""
    spec = _spec(key)
    settings, _ = rule_settings(key)
    offset = _local_offset()
    local = (now or _now()) + offset
    return (settings["enabled"] and local.weekday() in settings["days"]
            and local.time() >= time(settings["hour"], settings["minute"])
            and not _ran_today(spec, local.date(), offset))


def _rule_moment(key, now):
    """The moment of a rule's scheduled run on the plant day of `now`, on the
    plant clock."""
    settings, _ = rule_settings(key)
    return datetime.combine(_plant(now).date(), time(settings["hour"], settings["minute"]))


def _next_run(spec, settings, now, offset):
    """When the rule runs next (naive UTC), or None while it is off or has no
    day. Today's time counts until today's run has happened, even once it has
    passed: the rule is then simply due."""
    if not settings["enabled"] or not settings["days"]:
        return None
    today = (now + offset).date()
    for ahead in range(8):
        day = today + timedelta(days=ahead)
        if day.weekday() in settings["days"] and not (ahead == 0 and _ran_today(spec, day, offset)):
            return datetime.combine(day, time(settings["hour"], settings["minute"])) - offset
    return None


# ---- rules: running one ----

def _record_skip(spec, reason, trigger, dedup_key=None):
    """Put a run that sent nothing on record as one SKIPPED mail, so the log
    answers "why was there no mail today" — and, for a scheduled run, so the
    day is taken and the rule is not tried again on every tick."""
    msg = EmailMessage(
        mail_type=spec["mail_type"], rule_key=spec["key"], store_code=STORE_CODE,
        subject=f"{spec['title']} — not sent",
        body_text=f"Nothing was sent: {REASON_WORDS.get(reason, reason)}.",
        status=STATUS_SKIPPED, last_error=reason, trigger=trigger,
        triggered_by=EmailEngine._actor(), dedup_key=dedup_key)
    db.session.add(msg)
    try:
        db.session.commit()
    except IntegrityError:
        # Two runs raced for the day and this one lost: the other's row stands.
        db.session.rollback()
        existing = EmailMessage.query.filter_by(dedup_key=dedup_key).first() if dedup_key else None
        if existing is None:
            raise
        return existing.to_dict()
    return msg.to_dict()


def _outcome(messages, reason=None, sent=False):
    """The result of one run: "sent" (went out inline), "queued" (the worker
    sends it), or "skipped" with the reason."""
    if sent:
        return {"status": "sent", "reason": None, "messages": messages}
    if any(m["status"] in (STATUS_QUEUED, STATUS_SENDING) for m in messages):
        return {"status": "queued", "reason": None, "messages": messages}
    return {"status": "skipped", "messages": messages,
            "reason": reason or next((m["last_error"] for m in messages if m["last_error"]), None)}


def _run_digest(engine, spec, now, scheduled):
    """Build a free-audience rule's mail and queue it. A scheduled run reserves
    its day through the mail's dedup key, so a second trigger for the same day
    finds it and sends nothing; a run from the button has no key and always
    goes. A scheduled run whose content could not be read is raised, not
    recorded: the day stays free for the next tick."""
    settings, _ = rule_settings(spec["key"])
    day_key = _day_key(spec["key"], _plant(now).date()) if scheduled else None
    trigger = TRIGGER_RULE if scheduled else TRIGGER_MANUAL
    mail, reason = _BUILDERS[spec["key"]](now)
    if mail is None:
        if scheduled and reason in RETRY_REASONS:
            raise RuntimeError(REASON_WORDS[reason])
        return _outcome([_record_skip(spec, reason, trigger, day_key)])
    to, cc, bcc = _audience(settings["department_ids"], settings["emails"])
    # With no one to mail the engine records the run as skipped; no sheet is built for that.
    files = mail["files"]() if mail["files"] and (to or cc or bcc) else None
    return _outcome([engine.submit(
        mail_type=spec["mail_type"], subject=mail["subject"], body=mail["text"], html=mail["html"],
        attachments=files, to=to, cc=cc, bcc=bcc, trigger=trigger, rule_key=spec["key"],
        store_code=STORE_CODE, dedup_key=day_key)])


def _run_excess(engine, spec, now, scheduled):
    """Queue the excess list, one mail per department. A scheduled run
    reserves each department's mail of the day through its dedup key
    ("excess_list:<department id>:<day>"): a run that broke between two
    departments is taken up again on the next tick without mailing the first
    one twice, and of two ticks that race only one gets each mail out. It is
    marked done for the day once it went through, and only then. A run from
    the button mails every department, whatever went out earlier today — and
    when a department's mail of the day has not gone yet, the button's mail
    takes that key, so the scheduled run later the same day does not mail the
    department a second time. A run that made no mail at all leaves one
    SKIPPED row with the reason. A sheet is built only for a mail that is
    going out.

    A department whose list cannot be built does not hold up the ones after
    it: they are mailed, and a scheduled run is then raised instead of marked
    done, so the next tick tries that department again."""
    day = _plant(now).date()
    trigger = TRIGGER_RULE if scheduled else TRIGGER_MANUAL
    mails, reason = _excess_departments()
    sections = SpareDashboardService._section_names(STORE_CODE) if mails else {}
    suppliers = supplier_names() if mails else {}
    messages, unbuilt = [], []
    for dept, found, to, cc, bcc in mails:
        key = _day_key(f"{spec['key']}:{dept.id}", day)
        if db.session.query(EmailMessage.id).filter_by(dedup_key=key).first():
            if scheduled:
                continue    # on record from the part of today's run that got through, or from the button
            key = None      # the button mails again; the day's mail is already on record
        try:
            subject, text, html = _excess_mail(dept.name, found, now)
            sheet = _excess_sheet(dept.name, found, day, sections, suppliers)
        except Exception:  # noqa: BLE001 — one department's list must not cost the others theirs
            db.session.rollback()
            logger.exception("the excess list of %s could not be built", dept.name)
            unbuilt.append(dept.name)
            continue
        message = engine.submit(
            mail_type=spec["mail_type"], subject=subject, body=text, html=html, attachments=[sheet],
            to=to, cc=cc, bcc=bcc, trigger=trigger, rule_key=spec["key"], store_code=STORE_CODE, dedup_key=key)
        if not message.get("duplicate"):
            messages.append(message)
    if scheduled and unbuilt:
        raise RuntimeError(f"the excess list of {', '.join(unbuilt)} could not be built")
    if not mails:
        messages = [_record_skip(spec, reason, trigger, _day_key(spec["key"], day) if scheduled else None)]
    elif not messages:
        # An earlier part of today's run made every mail there is — or, from
        # the button, no department's list could be built.
        reason = BUILD_FAILED if unbuilt else "already_sent_today"
    if scheduled:
        _mark_run(_run_marker(spec["key"]), now)
    return _outcome(messages, reason)


def _reorder_outcome(result):
    """(anything sent, why not) out of ReorderMailService.send_now's
    per-department summary."""
    if result.get("total_sent"):
        return True, None
    reasons = [d.get("reason") for d in result.get("departments", []) if d.get("status") == "skipped"]
    return False, result.get("reason") or (reasons[0] if reasons else "no_department_flagged")


def _run_report(spec, now, scheduled):
    """Hand over to the sender that has always built this mail. Scheduled, it
    is asked without force and keeps its own once-a-day guard; from the button
    it is forced, like its own "send now". A run that produced no mail at all
    leaves one SKIPPED row with the sender's reason.

    A scheduled run is marked done for the day once it went through, and only
    then. If it broke half way — or a department's reorder list could not be
    built, which the sender reports once the other departments have theirs —
    it is raised and the next tick finishes it: safe, because every mail of it
    is reserved by the sender's own key. With no mail server set up it is
    neither marked nor recorded: the rule stays due and its mail goes out when
    there is one."""
    last_id = db.session.query(func.max(EmailMessage.id)).scalar() or 0
    if spec["key"] == "reorder_daily":
        result = ReorderMailService().send_now(force=not scheduled)
        unbuilt = [d["department"] for d in result.get("departments", []) if d.get("reason") == BUILD_FAILED]
        if scheduled and unbuilt:
            raise RuntimeError(f"the reorder list of {', '.join(unbuilt)} could not be built")
        sent, reason = _reorder_outcome(result)
    else:
        # A scheduled sheet is dated as of the rule's own time, however late
        # the run is; from the button, as of now.
        at = _rule_moment(spec["key"], now) if scheduled else None
        result = WindowTimeMailService().send_current_month(force=not scheduled, at=at)
        sent, reason = result.get("status") == "sent", result.get("reason")
    messages = [m.to_dict() for m in EmailMessage.query
                .filter(EmailMessage.id > last_id, EmailMessage.mail_type == spec["mail_type"])
                .order_by(EmailMessage.id.asc()).all()]
    if scheduled and not messages:
        if reason in RETRY_REASONS:
            raise RuntimeError(REASON_WORDS[reason])
        if reason == "smtp_not_configured":
            return _outcome([], reason)
    if not messages:
        messages = [_record_skip(spec, reason or "nothing_to_report",
                                 TRIGGER_SCHEDULED if scheduled else TRIGGER_MANUAL,
                                 _day_key(spec["key"], _plant(now).date()) if scheduled else None)]
    if scheduled:
        _mark_run(_run_marker(spec["key"]), now)
    return _outcome(messages, reason, sent)


def _run(engine, spec, now, scheduled):
    if spec["key"] != "excess_list" and spec["audience"] != "custom":
        return _run_report(spec, now, scheduled)
    if scheduled and not mailer.smtp_is_configured():
        # Like the two old senders' rules: neither marked nor recorded, so the
        # rule stays due and mails once when there is a mail server. Queued, it
        # would leave a mail behind every day and send them all together then.
        return _outcome([], "smtp_not_configured")
    if spec["key"] == "excess_list":
        return _run_excess(engine, spec, now, scheduled)
    return _run_digest(engine, spec, now, scheduled)


def run_due_rules(engine, now=None):
    """The worker's first step: run every rule whose time has come. One rule
    failing does not stop the others; the failure is raised once they have all
    had their turn, so it shows on the engine's health and the rule is tried
    again on the next tick."""
    now = now or _now()
    results, failures = [], []
    for spec in RULES:
        try:
            if rule_is_due(spec["key"], now):
                results.append({"key": spec["key"], **_run(engine, spec, now, scheduled=True)})
        except Exception as exc:  # noqa: BLE001 — the other rules still run
            db.session.rollback()
            logger.exception("rule %s failed", spec["key"])
            failures.append(f"{spec['key']}: {type(exc).__name__}: {exc}")
    if failures:
        raise RuntimeError("; ".join(failures))
    return results


def run_rule(engine, key, now=None):
    """Run a rule now, whatever its schedule says and whether or not it is
    switched on — but not past the engine's kill-switch."""
    spec = _spec(key)
    if not engine.settings()["enabled"]:
        return {"status": "skipped", "reason": ENGINE_OFF, "messages": []}
    return _run(engine, spec, now or _now(), scheduled=False)


# ---- rules: what the screens read ----

def _ticked_scope(svc):
    """(is any department ticked, the section ids the ticked ones cover between
    them — None when one of them is sent the whole store)."""
    sections, groups = svc._scopes()
    scopes = [svc._section_ids_for(dept.name, sections, groups)
              for dept in svc.dept_repo.list_all(active_only=True) if dept.notify_reorder]
    return bool(scopes), None if None in scopes else set().union(*scopes)


def _reorder_count():
    """Parts at or below the reorder level that some ticked department's mail
    would list — each part once, however many departments cover it."""
    svc = ReorderMailService()
    ticked, scope = _ticked_scope(svc)
    return len(svc._reorder_rows(scope)) if ticked else 0


def _excess_count():
    """The same for the excess list: the parts above their maximum that some
    ticked department's mail would list, each once — not the whole store's."""
    ticked, scope = _ticked_scope(ReorderMailService())
    if not ticked:
        return 0
    return sum(1 for row, _, _ in _excess_rows() if scope is None or row.get("section_id") in scope)


def _tracker_count():
    tracker = _tracker()
    return None if tracker is None else _open_lines(tracker["items"])


# How many items a rule's mail would carry right now. The window-time sheet has
# no such number.
_COUNTERS = {"reorder_daily": _reorder_count, "excess_list": _excess_count,
             "short_rejection": lambda: _short_rejection_count(_short_rejection_report(_now())[1]),
             "stock_report": lambda: len(SpareStockService().list_stock(STORE_CODE, None)),
             "tracker_digest": _tracker_count}


def _content_count(spec):
    counter = _COUNTERS.get(spec["key"])
    try:
        return counter() if counter else None
    except Exception:  # noqa: BLE001 — a count that cannot be read is "not known", never a broken screen
        db.session.rollback()
        logger.exception("could not count the content of rule %s", spec["key"])
        return None


def _last_run(spec):
    """The rule's newest mail. For a rule with a fixed audience that is the
    newest mail of its type, whoever asked for it — the two old senders also
    mail from their own "send now"."""
    mine = EmailMessage.rule_key == spec["key"]
    if spec["audience"] != "custom":
        mine = or_(mine, EmailMessage.mail_type == spec["mail_type"])
    msg = EmailMessage.query.filter(mine).order_by(EmailMessage.id.desc()).first()
    if msg is None:
        return None
    data = msg.to_dict()
    if msg.status == STATUS_SKIPPED:
        detail = f"Nothing sent — {REASON_WORDS.get(msg.last_error, msg.last_error)}"
    else:
        detail = msg.last_error or msg.subject
    return {"at": data["sent_at"] or data["created_at"], "status": msg.status, "detail": detail}


def describe_rule(key, now=None):
    """The Rule of the API: the catalogue entry, its settings, and the live
    reading of who it would mail, what it would carry and when it runs next."""
    spec = _spec(key)
    settings, is_default = rule_settings(key)
    to, cc, bcc = _rule_recipients(spec, settings)
    next_run = _next_run(spec, settings, now or _now(), _local_offset())
    return {
        "key": key, "title": spec["title"], "description": spec["description"],
        "mail_type": spec["mail_type"], "audience": spec["audience"],
        **settings,
        "recipients": {"to": to, "cc": cc, "bcc": bcc},
        "content": {"count": _content_count(spec), "label": spec["label"]},
        "last_run": _last_run(spec),
        "next_run_at": next_run.isoformat() if next_run else None,
        "is_default": is_default,
    }


def list_rules(now=None):
    return [describe_rule(spec["key"], now) for spec in RULES]


def rules_summary(now=None):
    """The "rules" block of the engine's status: how many are on and which one
    runs next. Read on every refresh of the Control Center, so it only looks at
    the settings and the day's reservations — no content is built here."""
    now, offset = now or _now(), _local_offset()
    enabled, upcoming = 0, []
    for spec in RULES:
        settings, _ = rule_settings(spec["key"])
        if settings["enabled"]:
            enabled += 1
            at = _next_run(spec, settings, now, offset)
            if at is not None:
                upcoming.append((at, spec))
    first = min(upcoming, key=lambda pair: pair[0], default=None)
    return {"enabled": enabled, "total": len(RULES),
            "next": {"key": first[1]["key"], "title": first[1]["title"], "at": first[0].isoformat()}
            if first else None}


# ---- rules: preview ----

def _no_mail(reason, to=(), cc=(), bcc=(), count=None):
    return {"subject": "", "text": f"No mail would go out right now: {REASON_WORDS.get(reason, reason)}.",
            "html": None, "to": list(to), "cc": list(cc), "bcc": list(bcc), "count": count}


def _several_note(total, name):
    """What a preview says above the first mail of a run that sends one per
    department — nothing when that one is all there is."""
    if total < 2:
        return ""
    return f"[One mail per department — {total} would go out now. This is the one for {name}.]\n\n"


def _reorder_preview(now):
    """The reorder rule sends one mail per department; the preview shows the
    first one a run would send and says how many there are."""
    svc = ReorderMailService()
    sections, groups = svc._scopes()
    mails, reasons = [], []
    for dept in svc.dept_repo.list_all(active_only=True):
        if not dept.notify_reorder:
            continue
        to, cc, bcc = normalise_recipients(*svc._recipients(dept))
        if not (to or cc or bcc):
            reasons.append("no_recipient")
            continue
        rows = svc._reorder_rows(svc._section_ids_for(dept.name, sections, groups))
        if not rows:
            reasons.append("nothing_to_reorder")
            continue
        mails.append((dept.name, rows, to, cc, bcc))
    if not mails:
        return _no_mail(reasons[0] if reasons else "no_department_flagged", count=0)
    name, rows, to, cc, bcc = mails[0]
    words = svc._wording(name, len(rows), _plant(now).date())
    text, html = svc._body(rows, _several_note(len(mails), name) + words["intro"], words["footer"])
    return {"subject": words["subject"], "text": text, "html": html,
            "to": to, "cc": cc, "bcc": bcc, "count": len(rows)}


def _excess_preview(now):
    """The excess rule sends one mail per department too: the first one a run
    would send, with that department's own people and count."""
    mails, reason = _excess_departments()
    if not mails:
        return _no_mail(reason, count=0)
    dept, found, to, cc, bcc = mails[0]
    subject, text, html = _excess_mail(dept.name, found, now, lead=_several_note(len(mails), dept.name))
    return {"subject": subject, "text": text, "html": html, "to": to, "cc": cc, "bcc": bcc, "count": len(found)}


def preview_rule(key, now=None):
    """The mail a run of the rule would send right now, built from live data.
    Nothing is stored and nothing is sent — no attachment is even built, not
    the window-time sheet and not the Excel lists."""
    spec = _spec(key)
    now = now or _now()
    settings, _ = rule_settings(key)
    if key == "reorder_daily":
        return _reorder_preview(now)
    if key == "excess_list":
        return _excess_preview(now)
    to, cc, bcc = _rule_recipients(spec, settings)
    if key == "window_time_daily":
        subject, text = WindowTimeMailService._wording(WindowTimeMailService._reported_date())
        return {"subject": subject, "text": text, "html": None, "to": to, "cc": cc, "bcc": bcc, "count": None}
    mail, reason = _BUILDERS[key](now)
    if mail is None:
        return _no_mail(reason, to, cc, bcc, count=0 if reason in EMPTY_REASONS else None)
    return {"subject": mail["subject"], "text": mail["text"], "html": mail["html"],
            "to": to, "cc": cc, "bcc": bcc, "count": mail["count"]}


# ---- the manual alert ----

def send_alert(engine, data, now=None):
    """Queue a one-off alert an admin typed: subject, message, the chosen
    people, and — if asked for — the critical parts list or the Action Tracker
    table under the message. Returns the queued Message."""
    if not isinstance(data, dict):
        raise BadRequestError("The request body must be a JSON object")
    unknown = sorted(set(data) - set(ALERT_FIELDS))
    if unknown:
        raise BadRequestError(f"Unknown field: {', '.join(unknown)}")
    subject = _one_line(data.get("subject"), "subject", ALERT_SUBJECT_MAX)
    message = _typed(data.get("message"), "message", ALERT_MESSAGE_MAX)
    if not subject or not message:
        raise BadRequestError("An alert needs a subject and a message")
    include = data.get("include") or "none"
    if include not in ALERT_INCLUDES:
        raise BadRequestError(f"'include' must be one of: {', '.join(ALERT_INCLUDES)}")
    to, cc, bcc = _audience(_department_ids(data.get("department_ids") or []),
                            _addresses(data.get("emails") or [], "emails"))
    if not (to or cc or bcc):
        raise BadRequestError("There is no one to send to — pick a department that has people with an "
                              "e-mail address, or add an address")
    blocks = []
    if include == "critical":
        block, count = _critical_block()
        blocks = [block if count else {"line": "No part is out of stock or below its minimum right now."}]
    elif include == "tracker":
        tracker = _tracker()
        if tracker is None:
            raise AppException("The Action Tracker could not be read right now, so it cannot be included. "
                               "Send the alert without it, or try again in a moment.", status_code=503)
        blocks = [_tracker_block(tracker["items"], _plant(now or _now()).date())]
    text, html = _layout(message, blocks, "")
    return engine.submit(mail_type="manual_alert", subject=subject, body=text, html=html,
                         to=to, cc=cc, bcc=bcc, trigger=TRIGGER_MANUAL, store_code=STORE_CODE)


# ---- reminders and escalation (app_settings key "reminder_rules") ----

def reminder_settings():
    saved = _saved(REMINDERS_SETTING_KEY)
    out = {**REMINDER_DEFAULTS, "escalate_to": _saved_addresses(saved.get("escalate_to")), "owners": {}}
    if isinstance(saved.get("enabled"), bool):
        out["enabled"] = saved["enabled"]
    for name, (low, high) in REMINDER_RANGES.items():
        if _is_int(saved.get(name)) and low <= saved[name] <= high:
            out[name] = saved[name]
    for key, owners in _dict(saved.get("owners")).items():
        if isinstance(owners, dict):
            out["owners"][key] = {"department_ids": _saved_ids(owners.get("department_ids")),
                                  "emails": _saved_addresses(owners.get("emails"))}
    return out


def _owners(value, current):
    """The owners map with the lines that were sent replaced; a line sent with
    no department and no address is cleared. A line that was not sent keeps
    what it had, so two admins editing different lines do not undo each other."""
    if not isinstance(value, dict):
        raise BadRequestError("'owners' must be an object keyed by Action Tracker line")
    known = {spec["key"] for spec in _management().TRACKER_ITEMS}
    # A line taken off the tracker (the kiosk requests line, 17 Oct 2026) may
    # still have owners saved, and the screen sends the whole map back: such a
    # line is dropped here instead of refusing every later save.
    merged = {key: line for key, line in current.items() if key in known}
    for key, entry in value.items():
        if key not in known and key in current:
            continue
        if key not in known:
            raise BadRequestError(f"'{key}' is not an Action Tracker line")
        if not isinstance(entry, dict):
            raise BadRequestError(f"The owners of '{key}' need 'department_ids' and 'emails'")
        line = {"department_ids": _department_ids(entry.get("department_ids") or [], f"owners.{key}.department_ids"),
                "emails": _addresses(entry.get("emails") or [], f"owners.{key}.emails")}
        if line["department_ids"] or line["emails"]:
            merged[key] = line
        else:
            merged.pop(key, None)
    return merged


def save_reminders(data, user=None, now=None):
    data = _fields(data, tuple(REMINDER_DEFAULTS))
    settings = reminder_settings()
    if "enabled" in data:
        settings["enabled"] = _flag(data["enabled"], "enabled")
    for name, (low, high) in REMINDER_RANGES.items():
        if name in data:
            settings[name] = _whole(data[name], name, low, high)
    if "escalate_to" in data:
        settings["escalate_to"] = _addresses(data["escalate_to"], "escalate_to")
    if "owners" in data:
        settings["owners"] = _owners(data["owners"], settings["owners"])
    AppSetting.set_value(REMINDERS_SETTING_KEY, settings, user)
    return reminders_view(now)


def _decide(status, days, settings, has_owners, has_escalation, last_day, today):
    """(next action, why) for one tracker line: "remind", "escalate" or "none".
    `days` is the days left to the target date (negative once it has passed),
    `last_day` the plant day the line was last mailed about."""
    if status == "CLEAR":
        return "none", "Clear — nothing to chase"
    if status != "OPEN":
        return "none", "Could not be read right now"
    if days is None:
        return "none", "No target date set"
    due = _due_words(days)
    if days > settings["remind_before_days"]:
        before = settings["remind_before_days"]
        return "none", f"{due} — reminders start {before} day{'' if before == 1 else 's'} before the target date"
    overdue_enough = days < 0 and -days >= settings["escalate_after_days"]
    # With no escalation address the owners go on being reminded: an overdue
    # line must not fall silent because one list is empty.
    action = "escalate" if overdue_enough and has_escalation else "remind"
    if action == "remind" and not has_owners:
        return "none", "No one to mail"
    if last_day is not None and (today - last_day).days < settings["repeat_every_days"]:
        again = last_day + timedelta(days=settings["repeat_every_days"])
        return "none", f"{due} — mailed on {last_day:%d.%m.%Y}, next mail on {again:%d.%m.%Y}"
    if overdue_enough and action == "remind":
        return action, f"{due} — no escalation address is set, so the owners are reminded"
    return action, due


def _reminder_lines(items, settings, now):
    """Every tracker line with what the reminder run would do about it right
    now: its saved state, its owners' addresses, the days left and the
    decision. The view and the run both read this, so they cannot disagree."""
    offset = _local_offset()
    today = (now + offset).date()
    states = {state.key: state for state in
              NotificationState.query.filter(NotificationState.key.like(f"{STATE_PREFIX}%")).all()}
    lines = []
    for item in items:
        state = states.get(STATE_PREFIX + item["key"])
        owners = settings["owners"].get(item["key"]) or {"department_ids": [], "emails": []}
        people = _audience(owners["department_ids"], owners["emails"])
        target = _as_date(item.get("target_date"))
        days = (target - today).days if target else None
        last_day = ((_utc_naive(state.last_notified_at) + offset).date()
                    if state is not None and state.last_notified_at else None)
        action, note = _decide(item.get("status"), days, settings, any(people),
                               bool(settings["escalate_to"]), last_day, today)
        lines.append({"item": item, "state": state, "people": people, "days": days,
                      "action": action, "note": note})
    return lines


def _line_view(line):
    item, state = line["item"], line["state"]
    # A line that went clear has nothing against it any more; its row is
    # dropped by the next run, and is not shown in the meantime.
    chased = state is not None and item.get("status") != "CLEAR"
    notified = state.last_notified_at if chased else None
    return {
        "key": item["key"], "label": item.get("label"), "owner": item.get("owner"),
        "status": item.get("status"), "target_date": item.get("target_date"),
        "overdue": item.get("status") == "OPEN" and line["days"] is not None and line["days"] < 0,
        "days_to_target": line["days"],
        "to": [address for bucket in line["people"] for address in bucket],
        "level": state.level if chased else 0,
        "last_notified_at": _utc_naive(notified).isoformat() if notified else None,
        "next_action": line["action"], "note": line["note"],
    }


def reminders_view(now=None):
    """The Reminders of the API: the settings and every Action Tracker line
    with what the next run would do about it and why. With the tracker
    unreadable the settings still come back, with no lines."""
    settings = reminder_settings()
    tracker = _tracker()
    lines = _reminder_lines(tracker["items"], settings, now or _now()) if tracker else []
    return {**settings, "lines": [_line_view(line) for line in lines]}


def _reminder_recipients(line, settings, escalation):
    """A reminder goes to the line's owners. An escalation goes to the
    escalation list, with the owners in Cc."""
    to, cc, bcc = line["people"]
    if not escalation:
        return to, cc, bcc
    chosen = {role: [entry["email"] for entry in settings["escalate_to"] if entry["role"] == role]
              for role in ROLES}
    return normalise_recipients(chosen["TO"], chosen["CC"] + to + cc, chosen["BCC"] + bcc)


def _reminder_mail(line, escalation, today):
    item = line["item"]
    words = mail_wording("tracker_escalation" if escalation else "tracker_reminder",
                         problem=item.get("label") or item["key"], count=_n(item.get("count")), date=today)
    block = {"line": _due_words(line["days"]), "headers": TRACKER_HEADERS, "rows": [_tracker_row(item, today)]}
    if item.get("remarks"):
        block["note"] = f"Remarks: {item['remarks']}"
    text, html = _layout(words["intro"], [block], words["footer"])
    return words["subject"], text, html


def run_reminders(engine, now=None, scheduled=False):
    """Check every tracker line now and mail whoever is due. Returns
    {"reminded", "escalated", "messages"}. Not past the engine's kill-switch.
    A line that went clear loses its state; a line is mailed about at most
    once per plant day whatever the settings say (its dedup key), on top of
    the repeat interval."""
    now = now or _now()
    out = {"reminded": 0, "escalated": 0, "messages": []}
    if not engine.settings()["enabled"]:
        return out
    tracker = _tracker()
    if tracker is None:
        raise AppException("The Action Tracker could not be read right now, so no reminder was checked. "
                           "Try again in a moment.", status_code=503)
    settings = reminder_settings()
    today = _plant(now).date()
    for line in _reminder_lines(tracker["items"], settings, now):
        item, state = line["item"], line["state"]
        if item.get("status") != "OPEN":
            if item.get("status") == "CLEAR" and state is not None:
                db.session.delete(state)
            continue
        if state is None:
            state = NotificationState(key=STATE_PREFIX + item["key"], first_seen_at=now, level=0)
            db.session.add(state)
        state.last_count = item.get("count") or 0
        if line["days"] is None or line["days"] > settings["remind_before_days"]:
            state.level = 0     # the date was moved out or removed: the chase starts over
        if line["action"] == "none":
            continue
        escalation = line["action"] == "escalate"
        to, cc, bcc = _reminder_recipients(line, settings, escalation)
        subject, text, html = _reminder_mail(line, escalation, today)
        message = engine.submit(
            mail_type="tracker_escalation" if escalation else "tracker_reminder",
            subject=subject, body=text, html=html, to=to, cc=cc, bcc=bcc,
            trigger=TRIGGER_RULE if scheduled else TRIGGER_MANUAL, store_code=STORE_CODE,
            dedup_key=f"{STATE_PREFIX}{item['key']}:{today.isoformat()}")
        if message.get("duplicate") or message["status"] == STATUS_SKIPPED:
            continue
        state.level, state.last_notified_at = (2 if escalation else 1), now
        out["escalated" if escalation else "reminded"] += 1
        out["messages"].append(message)
    db.session.commit()
    return out


def reminders_are_due(now=None):
    """Switched on, at or past the check time on the plant clock, and not
    checked yet today."""
    settings = reminder_settings()
    offset = _local_offset()
    local = (now or _now()) + offset
    if not settings["enabled"] or local.time() < time(settings["hour"], settings["minute"]):
        return False
    return _marked_day(RUN_MARKER, offset) != local.date()


def run_due_reminders(engine, now=None):
    """The worker's second step: the day's reminder run, once it is due. The
    day is marked only after the run went through, so a tracker that could not
    be read is tried again on the next tick."""
    now = now or _now()
    if not reminders_are_due(now):
        return None
    result = run_reminders(engine, now, scheduled=True)
    _mark_run(RUN_MARKER, now, result["reminded"] + result["escalated"])
    return result
