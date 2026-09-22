"""A tiny key/value store for admin-managed application settings.

The app had no settings table — config lived in env vars (backend/.env) and
Python constants. Env/secret values (SMTP password, ERP DB creds, API key) stay
there on purpose. This table is only for the handful of values an admin edits
from the Settings page and that must persist and take effect without a restart
— today just the barcode label template. One row per key; the value is JSON so
a setting can be a scalar or a small object.
"""
import json

from app.extensions import db
from app.models.base import BaseModel


class AppSetting(BaseModel):
    __tablename__ = "app_settings"

    key = db.Column(db.String(60), unique=True, nullable=False, index=True)
    value = db.Column(db.Text, nullable=True)  # JSON-encoded
    updated_by = db.Column(db.String(60), nullable=True)

    @classmethod
    def get_value(cls, key, default=None):
        row = cls.query.filter_by(key=key).first()
        if not row or row.value is None:
            return default
        try:
            return json.loads(row.value)
        except (ValueError, TypeError):
            return default

    @classmethod
    def set_value(cls, key, value, user=None):
        row = cls.query.filter_by(key=key).first()
        if row is None:
            row = cls(key=key)
            db.session.add(row)
        row.value = json.dumps(value)
        row.updated_by = user
        db.session.commit()
        return row
