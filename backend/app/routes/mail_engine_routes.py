"""Notification Engine API (/api/v1/mail-engine) — the mail queue and log, the
engine's health and settings, the recipient list the pickers read, and what
the engine sends by itself: the rules, the templates, the reminders, plus the
manual alert.

ADMIN-only. Reads accept what `admin_required` accepts. Anything that CHANGES
something or SENDS something (the settings, a drain of the queue, a retry, a
cancel, saving a rule / template / reminder setting, running one, an alert)
also needs a signed-in administrator: `admin_required` on its own lets the
machine (X-API-Key) caller through, and that shared key must not be able to
reconfigure mail or push mail out. No response here carries a secret — the SMTP
block of the status has only the `password_in_env` yes/no.
"""
from flask import Blueprint, current_app, request

from app.services import email_rules
from app.services.department_service import DepartmentService
from app.services.email_engine import EmailEngine
from app.utils.authz import admin_required, current_user, signed_in_admin_required
from app.utils.exceptions import BadRequestError
from app.utils.rate_limit import over_limit
from app.utils.response import error_response, success_response

bp = Blueprint("mail_engine", __name__, url_prefix="/api/v1/mail-engine")
engine = EmailEngine()

# "Process now" opens SMTP connections; a held-down button must not hammer the
# mail server. Per signed-in admin.
PROCESS_RATE_MAX = 6
PROCESS_RATE_WINDOW = 60
# An alert goes to whole departments; a held-down Send must not mail them over
# and over. Per signed-in admin.
ALERT_RATE_MAX = 5
ALERT_RATE_WINDOW = 60


def _int_arg(name, default):
    raw = request.args.get(name)
    if raw in (None, ""):
        return default
    try:
        return int(raw)
    except ValueError:
        raise BadRequestError(f"'{name}' must be a whole number") from None


@bp.route("/status", methods=["GET"])
@admin_required
def status():
    return success_response(engine.status())


@bp.route("/settings", methods=["PUT"])
@admin_required
@signed_in_admin_required
def save_settings():
    data = request.get_json(silent=True)
    saved = engine.save_settings(data, current_user().username)
    if engine.forced_off():
        return success_response(saved, "Saved — but mail is forced off on this server (MAIL_ENGINE_FORCE_OFF), "
                                       "so nothing is sent")
    return success_response(saved, "Mail engine settings saved")


@bp.route("/process", methods=["POST"])
@admin_required
@signed_in_admin_required
def process_now():
    """Drain the queue now instead of waiting for the worker's next tick."""
    if current_app.config.get("RATE_LIMIT_ENABLED", True) and over_limit(
            f"mail-process:{current_user().id}", PROCESS_RATE_MAX, PROCESS_RATE_WINDOW):
        return error_response("The queue was processed a moment ago. Please wait a minute and try again.", 429)
    result = engine.process_due()
    if not engine.settings()["enabled"]:
        return success_response(result, "The mail engine is switched off — nothing was sent")
    return success_response(result, f"{result['sent']} sent, {result['failed']} failed, {result['deferred']} still waiting")


@bp.route("/messages", methods=["GET"])
@admin_required
def list_messages():
    statuses = [s.strip().upper() for s in (request.args.get("status") or "").split(",") if s.strip()]
    return success_response(engine.list_messages(
        statuses=statuses,
        mail_type=(request.args.get("mail_type") or "").strip() or None,
        q=(request.args.get("q") or "").strip() or None,
        page=_int_arg("page", 1), per_page=_int_arg("per_page", 50)))


@bp.route("/messages/<int:message_id>", methods=["GET"])
@admin_required
def get_message(message_id):
    return success_response(engine.get_message(message_id))


@bp.route("/messages/<int:message_id>/retry", methods=["POST"])
@admin_required
@signed_in_admin_required
def retry_message(message_id):
    return success_response(engine.retry(message_id), "Mail put back in the queue")


@bp.route("/messages/<int:message_id>/cancel", methods=["POST"])
@admin_required
@signed_in_admin_required
def cancel_message(message_id):
    return success_response(engine.cancel(message_id), "Mail cancelled")


@bp.route("/recipients", methods=["GET"])
@admin_required
def recipients():
    """The Department Emails master, for the recipient pickers: every
    department (an inactive one is flagged, not hidden) with its active people
    who have an address — the ones a mail could actually reach."""
    return success_response([
        {"id": d["id"], "name": d["name"], "is_active": d["is_active"],
         "notify_reorder": d["notify_reorder"],
         "recipients": [{"id": r["id"], "name": r["name"], "email": r["email"].strip(), "role": r["role"]}
                        for r in d["recipients"] if (r["email"] or "").strip()]}
        for d in DepartmentService().list_departments()])


# ---- rules ----

@bp.route("/rules", methods=["GET"])
@admin_required
def list_rules():
    return success_response(email_rules.list_rules())


@bp.route("/rules/<key>", methods=["PUT"])
@admin_required
@signed_in_admin_required
def save_rule(key):
    data = request.get_json(silent=True)
    return success_response(email_rules.save_rule(key, data, current_user().username), "Rule saved")


@bp.route("/rules/<key>/run", methods=["POST"])
@admin_required
@signed_in_admin_required
def run_rule(key):
    """Run a rule now, whatever its schedule says."""
    result = email_rules.run_rule(engine, key)
    if result["status"] == "skipped":
        return success_response(result, "Nothing was sent")
    return success_response(result, "Mail sent" if result["status"] == "sent" else "Mail queued")


@bp.route("/rules/<key>/preview", methods=["GET"])
@admin_required
def preview_rule(key):
    return success_response(email_rules.preview_rule(key))


# ---- templates ----

@bp.route("/templates", methods=["GET"])
@admin_required
def list_templates():
    return success_response(email_rules.list_templates())


@bp.route("/templates/<mail_type>", methods=["PUT"])
@admin_required
@signed_in_admin_required
def save_template(mail_type):
    data = request.get_json(silent=True)
    return success_response(email_rules.save_template(mail_type, data, current_user().username), "Template saved")


@bp.route("/templates-identity", methods=["PUT"])
@admin_required
@signed_in_admin_required
def save_identity():
    data = request.get_json(silent=True)
    return success_response(email_rules.save_identity(data, current_user().username), "Sender identity saved")


# ---- manual alert ----

@bp.route("/send-alert", methods=["POST"])
@admin_required
@signed_in_admin_required
def send_alert():
    if current_app.config.get("RATE_LIMIT_ENABLED", True) and over_limit(
            f"mail-alert:{current_user().id}", ALERT_RATE_MAX, ALERT_RATE_WINDOW):
        return error_response("Several alerts were sent in the last minute. Please wait a minute and try again.", 429)
    return success_response(email_rules.send_alert(engine, request.get_json(silent=True)), "Alert queued")


# ---- reminders and escalation ----

@bp.route("/reminders", methods=["GET"])
@admin_required
def reminders():
    return success_response(email_rules.reminders_view())


@bp.route("/reminders", methods=["PUT"])
@admin_required
@signed_in_admin_required
def save_reminders():
    data = request.get_json(silent=True)
    return success_response(email_rules.save_reminders(data, current_user().username), "Reminder settings saved")


@bp.route("/reminders/run", methods=["POST"])
@admin_required
@signed_in_admin_required
def run_reminders():
    """Check every Action Tracker line now instead of waiting for the check time."""
    result = email_rules.run_reminders(engine)
    if not engine.settings()["enabled"]:
        return success_response(result, "The mail engine is switched off — nothing was sent")
    return success_response(result, f"{result['reminded']} reminded, {result['escalated']} escalated")
