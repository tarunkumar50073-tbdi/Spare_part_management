"""Pagination helper applied consistently across list endpoints."""
from flask import request


def get_pagination_params():
    try:
        page = max(int(request.args.get("page", 1)), 1)
    except (TypeError, ValueError):
        page = 1
    try:
        per_page = int(request.args.get("per_page", 20))
    except (TypeError, ValueError):
        per_page = 20
    # Default list pages stay small; the cap is high enough that a screen which
    # genuinely needs the whole list (the store's part master, ~4.8k rows) can
    # ask for it in ONE request instead of paging 25 times. Only callers that
    # explicitly request a big per_page get one — the default is still 20.
    per_page = min(max(per_page, 1), 5000)
    return page, per_page


def paginate_query(query, page, per_page):
    total = query.count()
    items = query.offset((page - 1) * per_page).limit(per_page).all()
    total_pages = (total + per_page - 1) // per_page if per_page else 1
    pagination = {
        "page": page,
        "per_page": per_page,
        "total": total,
        "total_pages": total_pages,
        "has_next": page < total_pages,
        "has_prev": page > 1,
    }
    return items, pagination


def paginate_list(rows, page, per_page):
    """Same shape as paginate_query, for already-materialized Python lists
    (computed/joined data, e.g. Live Stock/Inventory Overview) rather than
    a SQLAlchemy query."""
    total = len(rows)
    start = (page - 1) * per_page
    items = rows[start:start + per_page]
    total_pages = (total + per_page - 1) // per_page if per_page else 1
    pagination = {
        "page": page,
        "per_page": per_page,
        "total": total,
        "total_pages": total_pages,
        "has_next": page < total_pages,
        "has_prev": page > 1,
    }
    return items, pagination
