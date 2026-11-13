"""Base declarative model providing id, timestamps, and serialization helpers."""
from datetime import datetime, timezone
from sqlalchemy import inspect as sa_inspect
from app.extensions import db


def utcnow():
    return datetime.now(timezone.utc)


class BaseModel(db.Model):
    __abstract__ = True

    id = db.Column(db.Integer, primary_key=True, autoincrement=True)
    created_at = db.Column(db.DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at = db.Column(db.DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)

    def to_dict(self):
        # By the attribute name, not the database column's: Part.part_name is
        # stored in item_description and Part.specification in model_no (13 Nov
        # 2026), and the API keeps the attribute names.
        result = {}
        for attr in sa_inspect(self).mapper.column_attrs:
            value = getattr(self, attr.key)
            if isinstance(value, datetime):
                value = value.isoformat()
            elif hasattr(value, "isoformat") and not isinstance(value, str):
                value = value.isoformat()
            result[attr.key] = value
        return result
