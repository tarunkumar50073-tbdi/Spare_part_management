"""Spare receiving REST API — receiving is read from ERP now.

Prefix /api/v1/spare-flow. Receiving, the GRN and the Maintenance / Tool Room
quality clearance are done in ERP; the app reads them from the ERP GRN register
(ErpGrnPostingService, /api/v1/erp-grn). So every manual receiving write here
answers 410 Gone with one plain sentence saying where the step went. The list of
receipts recorded in the app before that change stays readable for its history.
"""
from flask import Blueprint, request

from app.routes._spare_common import store_code_arg
from app.services.spare_receipt_service import ReceivingInErpError, SpareReceiptService
from app.utils.response import success_response

bp = Blueprint("spare_receipts", __name__, url_prefix="/api/v1/spare-flow")
service = SpareReceiptService()

# A receipts list is a work list, not an archive export.
_LIST_MAX = 1000


@bp.route("/receipts", methods=["POST"])
@bp.route("/receipts/<int:receipt_id>/grn", methods=["POST"])
@bp.route("/receipts/<int:receipt_id>/quality", methods=["POST"])
@bp.route("/receipts/<int:receipt_id>/cancel", methods=["POST"])
def receiving_in_erp(receipt_id=None):
    """Receive / record GRN / quality clearance / cancel — all done in ERP now."""
    raise ReceivingInErpError()


@bp.route("/receipts", methods=["GET"])
def list_receipts():
    """A store's in-app receipts (recorded before receiving moved to ERP),
    newest first. ?status= one status, a comma list, or OPEN (received +
    quality pending); ?limit= caps the list."""
    code = store_code_arg()
    limit = request.args.get("limit", type=int)
    limit = min(limit, _LIST_MAX) if limit and limit > 0 else _LIST_MAX
    return success_response(service.list(code, status=request.args.get("status"), limit=limit))
