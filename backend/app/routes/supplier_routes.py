"""Supplier Master REST API (/api/v1/suppliers)."""
from flask import Blueprint, request, send_file
from app.services.supplier_service import SupplierService
from app.schemas.supplier_schema import SupplierCreateSchema, SupplierUpdateSchema
from app.utils.validators import validate_payload
from app.utils.pagination import get_pagination_params, paginate_query
from app.utils.response import success_response, paginated_response
from app.utils.exceptions import BadRequestError
from app.utils.authz import admin_required

bp = Blueprint("suppliers", __name__, url_prefix="/api/v1/suppliers")
service = SupplierService()


@bp.route("", methods=["GET"])
def list_suppliers():
    keyword = request.args.get("keyword")
    status = request.args.get("status")
    vehicle_tracking = request.args.get("vehicle_tracking")
    if vehicle_tracking is not None:
        vehicle_tracking = vehicle_tracking.lower() in ("1", "true", "yes")
    query = service.list_suppliers(keyword=keyword, status=status, vehicle_tracking=vehicle_tracking)
    page, per_page = get_pagination_params()
    items, pagination = paginate_query(query, page, per_page)
    return paginated_response([s.to_dict() for s in items], pagination)


@bp.route("/<int:supplier_id>", methods=["GET"])
def get_supplier(supplier_id):
    supplier = service.get(supplier_id)
    return success_response(supplier.to_dict())


@bp.route("", methods=["POST"])
@admin_required
def create_supplier():
    data = validate_payload(SupplierCreateSchema(), request.get_json(force=True) or {})
    supplier = service.create(data)
    return success_response(supplier.to_dict(), "Supplier created", 201)


@bp.route("/<int:supplier_id>", methods=["PUT"])
@admin_required
def update_supplier(supplier_id):
    data = validate_payload(SupplierUpdateSchema(), request.get_json(force=True) or {})
    supplier = service.update(supplier_id, data)
    return success_response(supplier.to_dict(), "Supplier updated")


@bp.route("/<int:supplier_id>", methods=["DELETE"])
@admin_required
def delete_supplier(supplier_id):
    service.delete(supplier_id)
    return success_response(None, "Supplier deleted")


@bp.route("/template", methods=["GET"])
def download_template():
    buf = service.build_template()
    return send_file(buf, as_attachment=True, download_name="supplier_master_template.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/export", methods=["GET"])
def export_suppliers():
    buf = service.export_all()
    return send_file(buf, as_attachment=True, download_name="supplier_master_export.xlsx",
                      mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


@bp.route("/import", methods=["POST"])
@admin_required
def import_suppliers():
    file = request.files.get("file")
    if not file or file.filename == "":
        raise BadRequestError("No file uploaded")
    report = service.bulk_import_excel(file.stream)
    return success_response(report, f"{report['created']} of {report['total_rows']} suppliers imported", 201)
