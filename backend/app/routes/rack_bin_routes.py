"""Rack/Bin master REST API (/api/v1/rack-bins)."""
from flask import Blueprint, request, send_file
from app.services.rack_bin_service import RackBinService
from app.schemas.rack_bin_schema import RackBinCreateSchema, RackBinUpdateSchema
from app.utils.validators import validate_payload
from app.utils.response import success_response
from app.utils.exceptions import BadRequestError

bp = Blueprint("rack_bins", __name__, url_prefix="/api/v1/rack-bins")
service = RackBinService()


@bp.route("", methods=["GET"])
def list_rack_bins():
    return success_response(service.list_all())


@bp.route("", methods=["POST"])
def create_rack_bin():
    data = validate_payload(RackBinCreateSchema(), request.get_json(force=True) or {})
    row = service.create(data)
    return success_response(row, "Rack/Bin entry created", 201)


@bp.route("/<int:rack_bin_id>", methods=["PUT"])
def update_rack_bin(rack_bin_id):
    data = validate_payload(RackBinUpdateSchema(), request.get_json(force=True) or {})
    row = service.update(rack_bin_id, data)
    return success_response(row, "Rack/Bin entry updated")


@bp.route("/<int:rack_bin_id>", methods=["DELETE"])
def delete_rack_bin(rack_bin_id):
    service.delete(rack_bin_id)
    return success_response(None, "Rack/Bin entry deleted")


@bp.route("/template", methods=["GET"])
def download_template():
    buf = service.build_template()
    return send_file(buf, as_attachment=True, download_name="rack_bin_master_template.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/export", methods=["GET"])
def export_rack_bins():
    buf = service.export_all()
    return send_file(buf, as_attachment=True, download_name="rack_bin_master_export.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/import", methods=["POST"])
def import_rack_bins():
    file = request.files.get("file")
    if not file or file.filename == "":
        raise BadRequestError("No file uploaded")
    report = service.bulk_import_excel(file.stream)
    return success_response(report, f"{report['created']} of {report['total_rows']} rack/bin entries imported", 201)
