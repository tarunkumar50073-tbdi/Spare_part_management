"""Packets & QR Labels REST API (/api/v1/spare-packets) — receipt batches,
physical verification, packets / individual units with their own QR codes,
FIFO, label print audit and the whole-packet issue (SparePacketService).

Right "spare_packets": view to read · create to verify a receipt, make an
opening batch, make packets and print their labels · update to reprint ·
delete to cancel a packet made by mistake. Issuing a packet is an issue, so it
needs Scan Part's create right, as every issue does. Every call is held to the
caller's store access.

GET    /receipts                   store_code, status (PENDING | TO_PACK | PACKED), q, page, page_size
POST   /receipts/opening           store_code, part_id, qty, remarks — a batch of stock already on the shelf
POST   /receipts/<id>/verify       counted_qty, remarks
POST   /receipts/<id>/plan         kind, packet_qty, count, last_smaller — what would be made (nothing written)
POST   /receipts/<id>/pack         kind, packet_qty, count, last_smaller
GET    /parts                      store_code, q — parts with their loose quantity (for an opening batch)
GET    /parts/<part_id>/fifo       the part's available packets in issue order
GET    /packets                    store_code, status, q, page, page_size
GET    /issued                     store_code, from, to, q, page, page_size — the packet issue history
GET    /packets/<code>             one packet (with its FIFO standing)
POST   /print                      codes, reprint, reason — the labels came out of the printer
POST   /packets/<code>/cancel      reason
POST   /packets/<code>/issue       department, employee_id / issued_to_mobile / issued_to, remarks,
                                   override_reason, scan_source
"""
from flask import Blueprint, request

from app.extensions import db
from app.models.part import Part
from app.models.spare_packet import SpareBatch, SparePacket
from app.services.spare_packet_service import SparePacketService, normalize_code
from app.utils.authz import current_user, permission_required, require_store_access
from app.utils.event_bus import publish
from app.utils.exceptions import BadRequestError, ForbiddenError, NotFoundError
from app.utils.response import success_response

bp = Blueprint("spare_packets", __name__, url_prefix="/api/v1/spare-packets")
service = SparePacketService()
RIGHT = "spare_packets"


def _who():
    u = current_user()
    return getattr(u, "username", None)


def _body():
    data = request.get_json(silent=True)
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise BadRequestError("The request body must be a JSON object")
    return data


def _store(value=None):
    code = (value if value is not None else request.args.get("store_code") or "").strip()
    if not code:
        raise BadRequestError("store_code is required")
    require_store_access(code)
    return code


def _receipt(receipt_id):
    r = db.session.get(SpareBatch, receipt_id)
    if r is None:
        raise NotFoundError(f"Receipt {receipt_id} not found")
    require_store_access(r.store_code)
    return r


def _packet(code):
    p = SparePacket.query.filter_by(code=normalize_code(code)).first()
    if p is None:
        raise NotFoundError(f"No packet {normalize_code(code)}")
    require_store_access(p.part.store_code)
    return p


def _page():
    return request.args.get("page", 1, type=int), request.args.get("page_size", 25, type=int)


@bp.route("/receipts", methods=["GET"])
@permission_required(RIGHT, "view")
def receipts():
    page, size = _page()
    return success_response(service.receipts(_store(), status=request.args.get("status"),
                                             q=request.args.get("q"), page=page, page_size=size))


@bp.route("/receipts/opening", methods=["POST"])
@permission_required(RIGHT, "create")
def opening():
    data = _body()
    store = _store(data.get("store_code") or "")
    part = db.session.get(Part, data.get("part_id") or 0)
    if part is None or part.store_code != store:
        raise NotFoundError("Part not found in this store")
    out = service.opening_receipt(part.id, data.get("qty"), user=_who(), remarks=data.get("remarks"))
    return success_response(out, "Batch made from the stock on the shelf", status_code=201)


@bp.route("/receipts/<int:receipt_id>/verify", methods=["POST"])
@permission_required(RIGHT, "create")
def verify(receipt_id):
    _receipt(receipt_id)
    data = _body()
    out = service.verify(receipt_id, data.get("counted_qty"), user=_who(), remarks=data.get("remarks"))
    return success_response(out, "Receipt verified" if out["verify_status"] == "VERIFIED" else "Mismatch recorded")


def _plan_args(data):
    return dict(kind=(data.get("kind") or "").upper(), packet_qty=data.get("packet_qty"),
                count=data.get("count"), last_smaller=bool(data.get("last_smaller")))


@bp.route("/receipts/<int:receipt_id>/plan", methods=["POST"])
@permission_required(RIGHT, "view")
def plan(receipt_id):
    r = _receipt(receipt_id)
    p = service.plan(r, **_plan_args(_body()))
    sizes = [float(s) for s in p["sizes"]]
    return success_response({
        "packable": p["packable"], "count": len(sizes), "packet_qty": sizes[0],
        "last_qty": sizes[-1] if len(sizes) > 1 and sizes[-1] != sizes[0] else None,
        "total": round(sum(sizes), 2), "loose_after": p["loose_after"],
    })


@bp.route("/receipts/<int:receipt_id>/pack", methods=["POST"])
@permission_required(RIGHT, "create")
def pack(receipt_id):
    r = _receipt(receipt_id)
    out = service.pack(receipt_id, user=_who(), **_plan_args(_body()))
    n = len(out["packets"])
    word = "label" if out["packets"] and out["packets"][0]["kind"] == "UNIT" else "packet"
    publish("stock", {"part_id": r.part_id, "action": "pack"})
    return success_response(out, f"{n} {word}{'s' if n != 1 else ''} made — print their QR labels", status_code=201)


@bp.route("/parts", methods=["GET"])
@permission_required(RIGHT, "view")
def parts():
    return success_response(service.parts(_store(), request.args.get("q")))


@bp.route("/parts/<int:part_id>/fifo", methods=["GET"])
@permission_required(RIGHT, "view")
def fifo(part_id):
    part = db.session.get(Part, part_id)
    if part is None:
        raise NotFoundError(f"Part {part_id} not found")
    require_store_access(part.store_code)
    return success_response(service.fifo(part_id))


@bp.route("/packets", methods=["GET"])
@permission_required(RIGHT, "view")
def packets():
    page, size = _page()
    return success_response(service.packets(_store(), status=request.args.get("status"),
                                            q=request.args.get("q"), page=page, page_size=size))


@bp.route("/issued", methods=["GET"])
@permission_required(RIGHT, "view")
def issued():
    page, size = _page()
    return success_response(service.packets(_store(), q=request.args.get("q"), page=page, page_size=size,
                                            issued=True, date_from=request.args.get("from") or None,
                                            date_to=request.args.get("to") or None))


@bp.route("/packets/<code>", methods=["GET"])
@permission_required(RIGHT, "view")
def packet(code):
    _packet(code)
    return success_response(service.get(code))


@bp.route("/print", methods=["POST"])
@permission_required(RIGHT, "create")
def record_print():
    data = _body()
    reprint = bool(data.get("reprint"))
    user = current_user()
    if reprint and user is not None and not user.can(RIGHT, "update"):
        raise ForbiddenError("Reprinting a label needs the Packets & QR Labels edit right")
    for code in data.get("codes") or []:
        _packet(code)
    out = service.record_print(data.get("codes"), reprint=reprint, reason=data.get("reason"), user=_who())
    return success_response(out, f"{out['recorded']} label{'s' if out['recorded'] != 1 else ''} recorded")


@bp.route("/packets/<code>/cancel", methods=["POST"])
@permission_required(RIGHT, "delete")
def cancel(code):
    p = _packet(code)
    out = service.cancel(code, _body().get("reason"), user=_who())
    publish("stock", {"part_id": p.part_id, "action": "pack"})
    return success_response(out, f"Packet {out['code']} cancelled — its quantity is loose again")


@bp.route("/packets/<code>/issue", methods=["POST"])
@permission_required("scan_part", "create")
def issue(code):
    p = _packet(code)
    data = _body()
    if not (data.get("department") or "").strip():
        raise BadRequestError("Choose the department")
    out = service.issue(
        code, data.get("department"), user=_who(), employee_id=data.get("employee_id"),
        issued_to_mobile=data.get("issued_to_mobile"), issued_to=data.get("issued_to"),
        remarks=data.get("remarks"), override_reason=data.get("override_reason"),
        scan_source=data.get("scan_source"),
    )
    publish("stock", {"part_id": p.part_id, "action": "issue"})
    who = out["issue"].get("issued_to")
    return success_response(out, f"Packet {out['packet']['code']} issued — {out['packet']['qty']:g} "
                                 f"{out['packet']['uom'] or ''} to {data.get('department')}{(' · ' + who) if who else ''}")
