"""Line and machine are required on an issue (17 Nov 2026: "aage se jab bhi koi stock
issue kare to required saare input fill ke baad submit ho" - Line + Machine with
Person, Department and Qty). The one way round it: the plant machine list could
not be read at all (maintenance_db / tool_room_db unreachable), which the screen
says and sends as place_unavailable, so an issue is never blocked by that."""
from app.utils.exceptions import BadRequestError


def require_place(data):
    # Remarks too (17 Nov 2026: "remarks bhi zaroori kar de").
    if not str(data.get("remarks") or "").strip():
        raise BadRequestError("Write the remarks for this issue")
    if data.get("place_unavailable"):
        return
    if not str(data.get("line_name") or "").strip():
        raise BadRequestError("Choose the line the part goes to")
    if not str(data.get("machine") or "").strip() and not data.get("line_has_no_machine"):
        raise BadRequestError("Choose the machine the part goes to")
