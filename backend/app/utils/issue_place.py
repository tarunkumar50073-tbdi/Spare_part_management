"""What an issue must carry besides Person, Department and Qty (17 Nov 2026:
"aage se jab bhi koi stock issue kare to required saare input fill ke baad
submit ho"): the remarks. Line and machine are NOT asked at the store any more
(18 Nov 2026: "m/c, line hta de wo maintenance tool room user khud bharenge")."""
from app.utils.exceptions import BadRequestError


def require_place(data):
    # Remarks (17 Nov 2026: "remarks bhi zaroori kar de").
    if not str(data.get("remarks") or "").strip():
        raise BadRequestError("Write the remarks for this issue")
