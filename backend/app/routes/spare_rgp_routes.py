"""Spare supplier rework (RGP) REST API - spec 15-19.

Prefix /api/v1/spare-flow. An RGP is created ONLY from a return the store
inspection held or found damaged (POST /returns/<id>/rgp-out): there is no
route that makes one from a part or from available stock — no direct RGP.
Every id is resolved to its own store before anything is read or written
(audit finding AUTHZ-1); writes need Scan Part edit rights and nudge the live
screens with a "stock" event.
"""
from flask import Blueprint, request

from app.extensions import db
from app.models.spare_flow import SpareReturn, SpareRgp
from app.routes._spare_common import require_doc_store, require_part_store, store_code_arg, username
from app.schemas.spare_rgp_schema import (
    SpareRgpCancelSchema, SpareRgpGrnSchema, SpareRgpOutSchema, SpareRgpSupplierReturnSchema,
)
from app.services.spare_rgp_service import SpareRgpService
from app.utils.authz import permission_required
from app.utils.event_bus import publish
from app.utils.response import success_response
from app.utils.validators import validate_payload

bp = Blueprint("spare_rgps", __name__, url_prefix="/api/v1/spare-flow")
service = SpareRgpService()


def _body():
    return request.get_json(force=True, silent=True) or {}


def _rgp(rgp_id):
    return require_doc_store(db.session.get(SpareRgp, rgp_id), "RGP")


@bp.route("/returns/<int:return_id>/rgp-out", methods=["POST"])
@permission_required("scan_part", "edit")
def rgp_out(return_id):
    """RGP OUT - REWORK (spec 16): held / damaged returned material to a supplier."""
    ret = require_doc_store(db.session.get(SpareReturn, return_id), "Return")
    data = validate_payload(SpareRgpOutSchema(), _body())
    rgp = service.rgp_out(
        ret.id, float(data["qty"]), user=username(),
        from_bucket=data.get("from_bucket"), supplier_id=data.get("supplier_id"),
        ven_cd=data.get("ven_cd"), ven_name=data.get("ven_name"),
        supplier_source=data["supplier_source"], rework_reason=data["rework_reason"],
        remarks=data.get("remarks"), rgp_date=data.get("rgp_date"),
        expected_return_date=data.get("expected_return_date"),
        erp_challan_no=data.get("erp_challan_no"),
        scanned_code=data.get("scanned_code"), scan_source=data.get("scan_source"),
    )
    publish("stock", {"part_id": rgp["part_id"], "rgp_id": rgp["id"], "action": "rgp_out"})
    return success_response(
        rgp, f"{rgp['rgp_no']} created · {rgp['qty_out']:g} with {rgp['ven_name']} for rework", 201)


@bp.route("/rgps/<int:rgp_id>/supplier-return", methods=["POST"])
@permission_required("scan_part", "edit")
def supplier_return(rgp_id):
    """RGP RETURN (spec 18): the supplier brought it back — RGP GRN pending."""
    _rgp(rgp_id)
    data = validate_payload(SpareRgpSupplierReturnSchema(), _body())
    rgp = service.supplier_return(
        rgp_id, float(data["qty"]), remarks=data.get("remarks"), user=username(),
        scanned_code=data.get("scanned_code"), scan_source=data.get("scan_source"),
    )
    publish("stock", {"part_id": rgp["part_id"], "rgp_id": rgp_id, "action": "rgp_return"})
    return success_response(
        rgp, f"Supplier return recorded on {rgp['rgp_no']} · RGP GRN pending", 201)


@bp.route("/rgps/<int:rgp_id>/grn", methods=["POST"])
@permission_required("scan_part", "edit")
def rgp_grn(rgp_id):
    """RGP GRN (spec 18/19): the supervisor's ERP GRN no. puts it back in stock."""
    _rgp(rgp_id)
    data = validate_payload(SpareRgpGrnSchema(), _body())
    qty = float(data["qty"])
    rgp = service.rgp_grn(
        rgp_id, qty, data["grn_no"], grn_date=data.get("grn_date"),
        remarks=data.get("remarks"), user=username(),
        scanned_code=data.get("scanned_code"), scan_source=data.get("scan_source"),
    )
    publish("stock", {"part_id": rgp["part_id"], "rgp_id": rgp_id, "action": "rgp_grn"})
    return success_response(
        rgp, f"RGP GRN {rgp['grn_no']} recorded · {qty:g} added to store stock", 201)


@bp.route("/rgps/<int:rgp_id>/cancel", methods=["POST"])
@permission_required("scan_part", "edit")
def cancel_rgp(rgp_id):
    """Cancel an RGP raised by mistake (only before any supplier return)."""
    _rgp(rgp_id)
    data = validate_payload(SpareRgpCancelSchema(), _body())
    rgp = service.cancel(rgp_id, data["reason"], user=username())
    publish("stock", {"part_id": rgp["part_id"], "rgp_id": rgp_id, "action": "rgp_cancel"})
    return success_response(rgp, f"{rgp['rgp_no']} cancelled · quantity back on its return", 201)


@bp.route("/rgps", methods=["GET"])
def list_rgps():
    """A store's RGPs (?status=OPEN | WITH_SUPPLIER | RGP_GRN_PENDING | CLOSED | CANCELLED)."""
    return success_response(service.list(
        store_code_arg(), status=request.args.get("status") or None,
        limit=request.args.get("limit", type=int)))


@bp.route("/parts/<int:part_id>/supplier-options", methods=["GET"])
def supplier_options(part_id):
    """ERP vendors this part came from (gate / GRN), then the supplier master."""
    require_part_store(part_id)
    return success_response(service.supplier_options(part_id))
