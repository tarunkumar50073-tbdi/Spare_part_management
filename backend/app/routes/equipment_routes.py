"""Line / Machine / Die master API (/api/v1/equipment).

The install screen reads the lists to fill its dropdowns and may add a value
that is missing (scan_part edit); keeping the master itself — edits,
deactivation, Excel import, the one-click seed from past installations — needs
the Line/Machine/Die Master right (or admin).
"""
from flask import Blueprint, request, send_file

from app.routes._spare_common import username
from app.schemas.equipment_schema import EquipmentCreateSchema, EquipmentUpdateSchema
from app.services.equipment_service import EquipmentService
from app.utils.authz import permission_required
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response
from app.utils.validators import validate_payload

XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

bp = Blueprint("equipment", __name__, url_prefix="/api/v1/equipment")
service = EquipmentService()


@bp.route("", methods=["GET"])
# The master itself is the Part Master right's since 23 Oct 2026.
@permission_required(("scan_part", "part_master"), "view")
def list_equipment():
    """The install form loads its dropdowns from here (?kind=LINE/MACHINE/DIE)."""
    active = request.args.get("active")
    return success_response(service.list(
        kind=request.args.get("kind") or None,
        q=request.args.get("q"),
        active=None if active in (None, "", "all") else active in ("1", "true"),
        limit=request.args.get("limit", type=int),
    ))


@bp.route("", methods=["POST"])
@permission_required(("part_master", "scan_part"), "create")
def create_equipment():
    """Also the install form's quick-add for a line/machine/die not on the master."""
    data = validate_payload(EquipmentCreateSchema(), request.get_json(force=True) or {})
    return success_response(service.create(data, user=username()), "Added", 201)


@bp.route("/<int:eq_id>", methods=["PUT"])
@permission_required("part_master", "update")
def update_equipment(eq_id):
    data = validate_payload(EquipmentUpdateSchema(), request.get_json(force=True) or {})
    return success_response(service.update(eq_id, data, user=username()), "Updated")


@bp.route("/seed", methods=["POST"])
@permission_required("part_master", "create")
def seed_equipment():
    """Populate the master from the distinct line/machine/die values already
    recorded on past installations. Idempotent — safe to run again later."""
    return success_response(service.seed_from_ledger(user=username() or "seed"),
                            "Master seeded from past installations")


@bp.route("/template", methods=["GET"])
@permission_required("part_master", "view")
def template():
    return send_file(service.template(), mimetype=XLSX_MIME, as_attachment=True,
                     download_name="line_machine_die_template.xlsx")


@bp.route("/export", methods=["GET"])
@permission_required("part_master", "view")
def export():
    return send_file(service.export(), mimetype=XLSX_MIME, as_attachment=True,
                     download_name="line_machine_die_master.xlsx")


@bp.route("/import", methods=["POST"])
@permission_required("part_master", ("create", "update"))
def import_equipment():
    file = request.files.get("file")
    if not file:
        raise BadRequestError("Choose an Excel / CSV file to import")
    return success_response(service.import_file(file.stream, user=username()),
                            "Line / Machine / Die import finished")
