"""Standard API response envelope used across all endpoints."""
from flask import jsonify


def success_response(data=None, message="Success", status_code=200, meta=None):
    payload = {"success": True, "message": message, "data": data}
    if meta is not None:
        payload["meta"] = meta
    return jsonify(payload), status_code


def error_response(message="An error occurred", status_code=400, errors=None):
    payload = {"success": False, "message": message, "errors": errors}
    return jsonify(payload), status_code


def paginated_response(items, pagination, message="Success"):
    meta = {
        "page": pagination["page"],
        "per_page": pagination["per_page"],
        "total": pagination["total"],
        "total_pages": pagination["total_pages"],
        "has_next": pagination["has_next"],
        "has_prev": pagination["has_prev"],
    }
    return success_response(data=items, message=message, meta=meta)
