"""Urgent Challan Register REST API (/api/v1/challans).

Material that came in against a supplier's delivery challan before its PO was
approved or its invoice arrived (ChallanRegisterService). A register only:
nothing here moves stock — the ERP GRN after quality stays the one way stock
goes up. Right: "challan_register" (view to read, edit to write); every call is
held to the caller's store access.

GET    ""                          the register, paginated: store_code, page,
                                   page_size, from / to (receipt date), supplier,
                                   part, po_status, invoice_status, status,
                                   quality_status, q (any no. / name)
GET    /dashboard                  tiles + ageing over store_code, from / to,
                                   supplier, part, q
GET    /export                     the filtered register as Excel
GET    /options                    the choice lists and today's plant date
GET    /parts                      store_code, q: the store's parts for the entry form
GET    /parts/<id>/supplier-options  ERP vendors of the part, then the supplier master
POST   ""                          register a challan (store_code in the body;
                                   request_id makes a repeat return the first)
GET    /<id>                       one line with its invoice / GRN links and history
PATCH  /<id>                       PO, urgency, gate entry no., remarks, receipt date,
                                   qty (before any invoice)
POST   /<id>/cancel                {reason}
POST   /<id>/invoices              link an original invoice {invoice_no, invoice_date,
                                   invoice_qty?, po_status?, po_reference?, request_id?}
GET    /<id>/grn-candidates        ERP GRN lines that may be this challan's
POST   /<id>/invoices/<link>/grn   link the GRN {receiving_register_id} or {grn_no, grn_date?}
POST   /refresh-grn                re-read the ERP GRN register for the open lines
"""
from flask import Blueprint, request, send_file

from app.extensions import db
from app.models.challan_register import ChallanRegister
from app.models.part import Part
from app.services.challan_register_service import ChallanRegisterService
from app.utils.authz import current_user, permission_required, require_store_access
from app.utils.exceptions import BadRequestError, NotFoundError
from app.utils.response import success_response

bp = Blueprint("challan_register", __name__, url_prefix="/api/v1/challans")
service = ChallanRegisterService()
RIGHT = "challan_register"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _store_code(value=None):
    code = (value if value is not None else request.args.get("store_code") or "").strip()
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return code


def _body():
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise BadRequestError("The request body must be a JSON object")
    return data


def _row(pk):
    """The line, once the caller may act on its store."""
    row = db.session.get(ChallanRegister, pk)
    if row is None:
        raise NotFoundError(f"Challan {pk} not found")
    require_store_access(row.store_code)
    return row


def _filters():
    a = request.args
    return {"date_from": a.get("from"), "date_to": a.get("to"), "supplier": a.get("supplier"),
            "part": a.get("part"), "po_status": a.get("po_status"), "invoice_status": a.get("invoice_status"),
            "status": a.get("status"), "quality_status": a.get("quality_status"), "q": a.get("q")}


@bp.route("", methods=["GET"])
@permission_required(RIGHT, "view")
def list_challans():
    return success_response(service.list(_store_code(), _filters(), page=request.args.get("page", 1, type=int),
                                         page_size=request.args.get("page_size", 25, type=int)))


@bp.route("/dashboard", methods=["GET"])
@permission_required(RIGHT, "view")
def dashboard():
    return success_response(service.dashboard(_store_code(), _filters()))


@bp.route("/export", methods=["GET"])
@permission_required(RIGHT, "view")
def export():
    buf, name = service.export(_store_code(), _filters())
    return send_file(buf, as_attachment=True, download_name=name, mimetype=XLSX)


@bp.route("/options", methods=["GET"])
@permission_required(RIGHT, "view")
def options():
    return success_response(service.options())


@bp.route("/parts", methods=["GET"])
@permission_required(RIGHT, "view")
def parts():
    return success_response(service.search_parts(_store_code(), request.args.get("q")))


@bp.route("/parts/<int:part_id>/supplier-options", methods=["GET"])
@permission_required(RIGHT, "view")
def supplier_options(part_id):
    from app.services.spare_rgp_service import SpareRgpService
    part = db.session.get(Part, part_id)
    if part is None:
        raise NotFoundError(f"Part {part_id} not found")
    require_store_access(part.store_code)
    return success_response(SpareRgpService().supplier_options(part_id))


@bp.route("", methods=["POST"])
@permission_required(RIGHT, "create")
def create():
    data = _body()
    out = service.create(_store_code(data.get("store_code") or ""), data, user=current_user())
    return success_response(out, message="Challan already registered" if out.get("replayed") else
                            "Challan registered", status_code=200 if out.get("replayed") else 201)


@bp.route("/refresh-grn", methods=["POST"])
@permission_required(RIGHT, "update")
def refresh_grn():
    data = _body()
    return success_response(service.refresh_from_erp(_store_code(data.get("store_code") or request.args.get(
        "store_code") or ""), user=current_user()))


@bp.route("/<int:pk>", methods=["GET"])
@permission_required(RIGHT, "view")
def detail(pk):
    return success_response(service.detail(_row(pk).id))


@bp.route("/<int:pk>", methods=["PATCH"])
@permission_required(RIGHT, "update")
def update(pk):
    return success_response(service.update(_row(pk).id, _body(), user=current_user()))


@bp.route("/<int:pk>/cancel", methods=["POST"])
@permission_required(RIGHT, "delete")
def cancel(pk):
    return success_response(service.cancel(_row(pk).id, _body(), user=current_user()))


@bp.route("/<int:pk>/invoices", methods=["POST"])
@permission_required(RIGHT, "update")
def link_invoice(pk):
    out = service.link_invoice(_row(pk).id, _body(), user=current_user())
    return success_response(out, message="Invoice already linked" if out.get("replayed") else "Invoice linked")


@bp.route("/<int:pk>/grn-candidates", methods=["GET"])
@permission_required(RIGHT, "view")
def grn_candidates(pk):
    return success_response(service.grn_candidates(_row(pk).id))


@bp.route("/<int:pk>/invoices/<int:link_id>/grn", methods=["POST"])
@permission_required(RIGHT, "update")
def link_grn(pk, link_id):
    return success_response(service.link_grn(_row(pk).id, link_id, _body(), user=current_user()))
