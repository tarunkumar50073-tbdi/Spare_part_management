"""Part Master REST API (/api/v1/parts)."""
from flask import Blueprint, request, send_file
from app.services.part_service import PartService
from app.schemas.part_schema import PartCreateSchema, PartUpdateSchema
from app.utils.validators import validate_payload
from app.utils.pagination import get_pagination_params, paginate_query
from app.utils.response import success_response, paginated_response
from app.utils.exceptions import BadRequestError
from app.utils.authz import admin_required

bp = Blueprint("parts", __name__, url_prefix="/api/v1/parts")
service = PartService()


@bp.route("", methods=["GET"])
def list_parts():
    keyword = request.args.get("keyword")
    is_active = request.args.get("is_active")
    is_active = {"true": True, "false": False}.get((is_active or "").lower())
    query = service.list_parts(
        keyword=keyword, is_active=is_active,
        store_code=request.args.get("store_code"),
        section_id=request.args.get("section_id", type=int),
        # "max" / "rate" / "location" — the fields a keeper still has to fill
        # in. Anything else is ignored rather than rejected, so a stale
        # bookmark degrades to the unfiltered list.
        missing=request.args.get("missing"),
    )
    page, per_page = get_pagination_params()
    items, pagination = paginate_query(query, page, per_page)
    return paginated_response([p.to_dict() for p in items], pagination)


@bp.route("/missing-counts", methods=["GET"])
def missing_counts():
    """The three chip counts in one call, so the screen doesn't fetch three
    lists it will throw away just to read their totals."""
    is_active = request.args.get("is_active")
    return success_response(service.count_missing(
        store_code=request.args.get("store_code"),
        is_active={"true": True, "false": False}.get((is_active or "").lower()),
    ))


@bp.route("/<int:part_id>", methods=["GET"])
def get_part(part_id):
    part = service.get(part_id)
    return success_response(part.to_dict())


@bp.route("", methods=["POST"])
@admin_required
def create_part():
    data = validate_payload(PartCreateSchema(), request.get_json(force=True) or {})
    part = service.create(data)
    return success_response(part.to_dict(), "Part created", 201)


@bp.route("/<int:part_id>", methods=["PUT"])
@admin_required
def update_part(part_id):
    data = validate_payload(PartUpdateSchema(), request.get_json(force=True) or {})
    part = service.update(part_id, data)
    return success_response(part.to_dict(), "Part updated")


@bp.route("/<int:part_id>", methods=["DELETE"])
@admin_required
def delete_part(part_id):
    service.delete(part_id)
    return success_response(None, "Part deleted")


@bp.route("/template", methods=["GET"])
def download_template():
    buf = service.build_template()
    return send_file(buf, as_attachment=True, download_name="part_master_template.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/export", methods=["GET"])
def export_parts():
    buf = service.export_all(store_code=request.args.get("store_code"))
    return send_file(buf, as_attachment=True, download_name="part_master_export.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/import", methods=["POST"])
@admin_required
def import_parts():
    file = request.files.get("file")
    if not file or file.filename == "":
        raise BadRequestError("No file uploaded")
    # Sent as form fields alongside the file: a multipart upload has no JSON
    # body to validate, and these only decide where NEW rows land.
    report = service.bulk_import_excel(
        file.stream,
        store_code=request.form.get("store_code") or None,
        section_id=request.form.get("section_id", type=int),
    )
    return success_response(report, f"{report['created']} of {report['total_rows']} parts imported", 201)
