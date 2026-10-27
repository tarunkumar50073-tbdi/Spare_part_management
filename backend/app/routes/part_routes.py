"""Part Master REST API (/api/v1/parts)."""
from flask import Blueprint, request, send_file
from app.services.part_service import PartService
from app.services.part_image_service import PartImageService
from app.schemas.part_schema import PartCreateSchema, PartUpdateSchema
from app.utils.validators import validate_payload
from app.utils.pagination import get_pagination_params, paginate_query
from app.utils.response import success_response, paginated_response
from app.utils.exceptions import BadRequestError
from app.utils.authz import current_user, permission_required, require_store_access, scoped_store
from app.utils.event_bus import publish
from app.services.spare_stock_service import invalidate_stock_cache


def _parts_changed(**data):
    """A part's name, limits, rate or location are part of every stock row, so a
    part-master write refreshes the stock screens the same way a movement does:
    drop the cached rows first, then push the "stock" event."""
    invalidate_stock_cache()
    publish("stock", {"action": "parts", **data})

bp = Blueprint("parts", __name__, url_prefix="/api/v1/parts")
service = PartService()
images = PartImageService()


def _own_part(part_id):
    """The part, if it belongs to one of the caller's stores. A part edit or
    delete by id used to reach any store's part (security audit, 24 Oct 2026)."""
    part = service.get(part_id)
    require_store_access(part.store_code)
    return part


@bp.route("", methods=["GET"])
def list_parts():
    keyword = request.args.get("keyword")
    is_active = request.args.get("is_active")
    is_active = {"true": True, "false": False}.get((is_active or "").lower())
    query = service.list_parts(
        keyword=keyword, is_active=is_active,
        store_code=scoped_store(request.args.get("store_code")),
        section_id=request.args.get("section_id", type=int),
        # "max" / "rate" / "location" — the fields a keeper still has to fill
        # in. Anything else is ignored rather than rejected, so a stale
        # bookmark degrades to the unfiltered list.
        missing=request.args.get("missing"),
        # The Part Master's filters (21 Oct 2026): rack (from the location),
        # category and sub category, as /filter-options lists them.
        category=request.args.get("category") or None,
        sub_category=request.args.get("sub_category") or None,
        rack=request.args.get("rack") or None,
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
        store_code=scoped_store(request.args.get("store_code")),
        is_active={"true": True, "false": False}.get((is_active or "").lower()),
    ))


@bp.route("/filter-options", methods=["GET"])
def filter_options():
    """Racks, categories and sub categories of the store (and section), each
    with its part count — what the Part Master's filter dropdowns offer.
    ?is_active=true counts active parts only (the Photo Mode's list)."""
    is_active = request.args.get("is_active")
    return success_response(service.repo.filter_options(
        store_code=scoped_store(request.args.get("store_code")),
        section_id=request.args.get("section_id", type=int),
        is_active={"true": True, "false": False}.get((is_active or "").lower())))


@bp.route("/<int:part_id>/image", methods=["GET"])
def part_image(part_id):
    """The part's photo (?n=1 / 2 for its other angles, ?size=thumb for the
    small copy). The URL carries the file name (?v=...), which changes with
    every new photo, so it may be cached."""
    path = images.path(part_id, thumb=request.args.get("size") == "thumb",
                       n=request.args.get("n", default=0, type=int))
    return send_file(path, mimetype="image/jpeg", max_age=30 * 24 * 3600)


@bp.route("/<int:part_id>/image", methods=["POST"])
@permission_required("part_master", "update")
def upload_part_image(part_id):
    """New photos for the part — one to three multipart "file" fields, the
    first the main one — replacing what it had."""
    files = [f for f in request.files.getlist("file") if f and f.filename]
    if not files:
        raise BadRequestError("No photo uploaded")
    _own_part(part_id)
    part = images.save_set(part_id, [f.stream for f in files], user=current_user())
    return success_response(part.to_dict(), "Photo saved" if len(files) == 1 else f"{len(files)} photos saved")


@bp.route("/<int:part_id>/image", methods=["DELETE"])
@permission_required("part_master", "update")
def delete_part_image(part_id):
    """?n=… removes that one photo (the next takes its place); without it, all."""
    _own_part(part_id)
    part = images.delete(part_id, user=current_user(), n=request.args.get("n", type=int))
    return success_response(part.to_dict(), "Photo removed")


@bp.route("/<int:part_id>", methods=["GET"])
def get_part(part_id):
    return success_response(_own_part(part_id).to_dict())


@bp.route("", methods=["POST"])
@permission_required("part_master", "create")
def create_part():
    data = validate_payload(PartCreateSchema(), request.get_json(force=True) or {})
    scoped_store(data.get("store_code"))
    part = service.create(data)
    _parts_changed(part_id=part.id)
    return success_response(part.to_dict(), "Part created", 201)


@bp.route("/<int:part_id>", methods=["PUT"])
@permission_required(("part_master", "data_quality"), "update")
def update_part(part_id):
    data = validate_payload(PartUpdateSchema(), request.get_json(force=True) or {})
    current = _own_part(part_id)
    if data.get("store_code") and data["store_code"] != current.store_code:
        require_store_access(data["store_code"])        # moved: the new store must be the caller's too
    part = service.update(part_id, data)
    _parts_changed(part_id=part.id)
    return success_response(part.to_dict(), "Part updated")


@bp.route("/<int:part_id>", methods=["DELETE"])
@permission_required("part_master", "delete")
def delete_part(part_id):
    _own_part(part_id)
    service.delete(part_id)
    _parts_changed(part_id=part_id)
    return success_response(None, "Part deleted")


@bp.route("/template", methods=["GET"])
def download_template():
    buf = service.build_template(store_code=scoped_store(request.args.get("store_code")))
    return send_file(buf, as_attachment=True, download_name="part_master_template.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/export", methods=["GET"])
def export_parts():
    buf = service.export_all(store_code=scoped_store(request.args.get("store_code")))
    return send_file(buf, as_attachment=True, download_name="part_master_export.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/import/preview", methods=["POST"])
@permission_required("part_master", ("create", "update"))
def preview_import_parts():
    """Dry-run before committing: per-row INSERT/UPDATE/ERROR + counts."""
    file = request.files.get("file")
    if not file or file.filename == "":
        raise BadRequestError("No file uploaded")
    report = service.preview_import(file.stream, sheet_name=request.form.get("sheet_name") or None,
                                    store_code=scoped_store(request.form.get("store_code")))
    return success_response(report, "Preview ready")


@bp.route("/import", methods=["POST"])
@permission_required("part_master", ("create", "update"))
def import_parts():
    file = request.files.get("file")
    if not file or file.filename == "":
        raise BadRequestError("No file uploaded")
    u = current_user()
    # Sent as form fields alongside the file: a multipart upload has no JSON
    # body to validate, and these only decide where NEW rows land.
    report = service.bulk_import_excel(
        file.stream,
        store_code=scoped_store(request.form.get("store_code")),
        section_id=request.form.get("section_id", type=int),
        user=(u.username if u else None),
        filename=file.filename,
        sheet_name=request.form.get("sheet_name") or None,
    )
    if report.get("inserted") or report.get("updated"):
        _parts_changed(import_rows=report.get("inserted", 0) + report.get("updated", 0))
    return success_response(
        report,
        f"{report.get('inserted', 0)} added, {report.get('updated', 0)} updated, "
        f"{report.get('failed', 0)} failed of {report['total_rows']}",
        201,
    )


@bp.route("/import/history", methods=["GET"])
@permission_required("part_master", "view")
def import_history():
    return success_response(service.import_history(
        limit=request.args.get("limit", default=50, type=int)))


@bp.route("/derive-categories", methods=["POST"])
@permission_required("part_master", "update")
def derive_categories():
    """Auto-fill parts' component type (sub_category) from their description.
    Pass {"dry_run": true} to preview counts without writing."""
    data = request.get_json(silent=True) or {}
    store_code = data.get("store_code") or request.args.get("store_code")
    if not store_code:
        raise BadRequestError("store_code is required")
    require_store_access(store_code)
    dry_run = bool(data.get("dry_run"))
    result = service.derive_component_types(store_code, dry_run=dry_run)
    if not dry_run:
        _parts_changed(store_code=store_code)
    return success_response(result)
