"""BOM master REST API (/api/v1/bom)."""
from flask import Blueprint, request, send_file
from app.services.bom_service import BOMService
from app.schemas.bom_schema import BOMCreateSchema, BOMUpdateSchema
from app.utils.validators import validate_payload
from app.utils.response import success_response
from app.utils.exceptions import BadRequestError
from app.utils.authz import admin_required

bp = Blueprint("bom", __name__, url_prefix="/api/v1/bom")
service = BOMService()


@bp.route("", methods=["GET"])
def list_bom():
    return success_response(service.list_all())


@bp.route("", methods=["POST"])
@admin_required
def create_bom():
    data = validate_payload(BOMCreateSchema(), request.get_json(force=True) or {})
    bom = service.create(data)
    return success_response(bom, "BOM line created", 201)


@bp.route("/<int:bom_id>", methods=["PUT"])
@admin_required
def update_bom(bom_id):
    data = validate_payload(BOMUpdateSchema(), request.get_json(force=True) or {})
    bom = service.update(bom_id, data)
    return success_response(bom, "BOM line updated")


@bp.route("/<int:bom_id>", methods=["DELETE"])
@admin_required
def delete_bom(bom_id):
    service.delete(bom_id)
    return success_response(None, "BOM line deleted")


@bp.route("/template", methods=["GET"])
def download_template():
    buf = service.build_template()
    return send_file(buf, as_attachment=True, download_name="bom_master_template.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/export", methods=["GET"])
def export_bom():
    buf = service.export_all()
    return send_file(buf, as_attachment=True, download_name="bom_master_export.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/import", methods=["POST"])
@admin_required
def import_bom():
    file = request.files.get("file")
    if not file or file.filename == "":
        raise BadRequestError("No file uploaded")
    report = service.bulk_import_excel(file.stream)
    return success_response(report, f"{report['created']} of {report['total_rows']} BOM lines imported", 201)
