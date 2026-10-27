"""Short & Rejection REST API (/api/v1/short-rejection).

Read-only and store-scoped: what suppliers sent short, and what was rejected,
on the ERP GRN lines of a store's parts, supplier-wise and line by line, with
the days each has been pending (ShortRejectionService; the store, 17 Oct 2026:
"taaki pta chale kis supplier ki rejection padi h kitne dino se and kis lot k
against me reject hui"). The right is the Receiving & GRN screen's own
(spare_store view): this is the same ERP GRN register, cut another way.

ONE kind per call, never mixed ("rejection and short mix nhi rhega na" — the
store, 17 Oct 2026): kind = short | srv (SRV Rejection) | line (Line
Rejection, not readable yet: available = false).

GET ""          {kind, label, available, summary, lines, totals, data_as_of,
                closures_known, basis, window, filters, title}
                store_code, kind, period (30d | 90d | month | last_month |
                this_fy | last_fy | custom, cut on the plant clock; default
                90d), from / to (custom: the GRN date, YYYY-MM-DD), supplier
                (code, or text in the code / name), part (text in the Part No /
                description) or part_id
GET /export     the same kind as ONE file: format=excel (sheets "Supplier-wise"
                and "Lines") | pdf
"""
from flask import Blueprint, request, send_file

from app.services.short_rejection_service import ShortRejectionService
from app.utils.authz import permission_required, require_store_access
from app.utils.exceptions import BadRequestError
from app.utils.response import success_response

bp = Blueprint("short_rejection", __name__, url_prefix="/api/v1/short-rejection")
service = ShortRejectionService()


def _store_code():
    code = request.args.get("store_code")
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return code


def _filters():
    return {
        "kind": request.args.get("kind"),
        "period": request.args.get("period"),
        "date_from": request.args.get("from"),
        "date_to": request.args.get("to"),
        "supplier": request.args.get("supplier"),
        "part": request.args.get("part"),
        "part_id": (request.args.get("part_id") or "").strip() or None,
    }


@bp.route("", methods=["GET"])
@permission_required("short_rejection", "view")
def report():
    return success_response(service.report(_store_code(), **_filters()))


@bp.route("/export", methods=["GET"])
@permission_required("short_rejection", "view")
def export():
    code = _store_code()
    buf, name, mimetype = service.export(code, request.args.get("format"), **_filters())
    return send_file(buf, as_attachment=True, download_name=name, mimetype=mimetype)


@bp.route("/line-rejections", methods=["GET"])
@permission_required("short_rejection", "view")
def line_rejections():
    """ERP's line rejection return slips (read from ERP with every ERP read,
    27 Oct 2026), newest first: this store's parts, or all=1 for every item.
    q matches slip no., item, description or party; from / to the slip date."""
    from datetime import date as _date
    from sqlalchemy import func, or_
    from app.extensions import db
    from app.models.erp_line_rejection import ErpLineRejection as L
    from app.models.part import Part
    store = (request.args.get("store_code") or "").strip()
    if not store:
        raise BadRequestError("store_code is required")
    require_store_access(store)
    query = L.query
    if request.args.get("all") not in ("1", "true"):
        mine = db.session.query(func.upper(func.trim(Part.part_no))).filter(Part.store_code == store)
        query = query.filter(func.upper(func.trim(L.item_cd)).in_(mine))
    text_ = (request.args.get("q") or "").strip()
    if text_:
        like = f"%{text_}%"
        query = query.filter(or_(L.return_slip_no.ilike(like), L.item_cd.ilike(like), L.item_desc.ilike(like),
                                 L.party_name.ilike(like)))
    for key, op in (("from", "__ge__"), ("to", "__le__")):
        v = request.args.get(key)
        if v:
            try:
                query = query.filter(getattr(L.return_slip_date, op)(_date.fromisoformat(v)))
            except ValueError:
                raise BadRequestError(f"{key} must be a date (YYYY-MM-DD)") from None
    rows = query.order_by(L.return_slip_date.desc(), L.erp_id.desc()).limit(1000).all()
    last = db.session.query(func.max(L.synced_at)).scalar()
    return success_response({
        "rows": [{"slip_no": r.return_slip_no, "date": r.return_slip_date.isoformat() if r.return_slip_date else None,
                  "time": r.return_slip_time, "item_cd": r.item_cd, "item_desc": r.item_desc, "uom": r.uom,
                  "qty": float(r.return_qty) if r.return_qty is not None else None, "from": r.return_from_name,
                  "party": r.party_name, "ref_doc_no": r.ref_doc_no} for r in rows],
        "total_in_erp": L.query.count(), "synced_at": last.isoformat() if last else None,
    })

