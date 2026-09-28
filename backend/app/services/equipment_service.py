"""Line / Machine / Die master: list for the install dropdowns, keep it editable,
and seed it from the values already on the ledger.

Validation lives here so the counter's quick-add (an operator typing a machine
that isn't on the master yet) and the master screen follow the same rules. Like
the Employee master, an item is deactivated rather than deleted, and uniqueness
is on (kind, name) case-insensitively so "Press-07" and "press 07" don't both
land in the Machine list.
"""
from sqlalchemy import func, or_
from sqlalchemy.exc import IntegrityError

from app.extensions import db
from app.models.equipment import Equipment, KINDS, normalise_code, normalise_name
from app.utils.excel_io import build_export, build_template, bulk_import, to_text
from app.utils.exceptions import BadRequestError, ConflictError, NotFoundError

EDITABLE = ("kind", "code", "name", "is_active")

IMPORT_ALIASES = {
    "kind": ("kind", "type", "category"),
    "name": ("name", "label", "linename", "machinename", "diename", "description"),
    "code": ("code", "no", "number", "lineno", "machineno", "dieno", "id"),
}
TEMPLATE_COLUMNS = ["Kind (LINE/MACHINE/DIE)", "Name", "Code"]
EXPORT_COLUMNS = [("Kind", "kind"), ("Name", "name"), ("Code", "code"), ("Active", "active")]


def _meaningful(name):
    """A real line/machine/die name has at least one letter or digit. Historical
    free text includes placeholders like '-' or '.'; the seed skips those so they
    don't clutter the dropdowns (a user can still add such a value by hand)."""
    return bool(name) and any(ch.isalnum() for ch in name)


class EquipmentService:
    # ---- reading ----

    @staticmethod
    def list(kind=None, q=None, active=None, limit=None):
        query = Equipment.query
        if kind:
            query = query.filter(Equipment.kind == str(kind).strip().upper())
        if active is not None:
            query = query.filter(Equipment.is_active.is_(bool(active)))
        if q:
            like = f"%{q.strip()}%"
            query = query.filter(or_(Equipment.name.ilike(like), Equipment.code.ilike(like)))
        query = query.order_by(
            Equipment.kind.asc(), Equipment.is_active.desc(), func.lower(Equipment.name).asc())
        if limit:
            query = query.limit(limit)
        return [e.to_dict() for e in query.all()]

    # ---- validation ----

    def _clean(self, data, current=None):
        out = {}
        if "kind" in data or current is None:
            kind = str(data.get("kind") or "").strip().upper()
            if kind not in KINDS:
                raise BadRequestError(f"Kind must be one of {', '.join(KINDS)}")
            out["kind"] = kind
        if "name" in data or current is None:
            name = normalise_name(data.get("name"))
            if not name:
                raise BadRequestError("Name is required")
            out["name"] = name[:80]
        if "code" in data:
            code = normalise_code(data.get("code"))
            out["code"] = code[:40] if code else None
        if "is_active" in data:
            out["is_active"] = bool(data["is_active"])

        # Uniqueness on (kind, name), case-insensitive, only when either changed.
        if "kind" in out or "name" in out:
            kind = out.get("kind") or (current.kind if current else None)
            name = out.get("name") or (current.name if current else None)
            if kind and name:
                clash = Equipment.query.filter(
                    Equipment.kind == kind, func.lower(Equipment.name) == name.lower())
                if current is not None:
                    clash = clash.filter(Equipment.id != current.id)
                if clash.first():
                    raise ConflictError(f"{kind.title()} '{name}' already exists")
        return out

    # ---- writing ----

    @staticmethod
    def _commit_or_conflict(kind, name):
        """Commit, turning the (kind, lower(name)) unique-index violation from a
        racing concurrent insert into the same friendly ConflictError the
        pre-check raises (instead of a 500)."""
        try:
            db.session.commit()
        except IntegrityError as exc:
            db.session.rollback()
            raise ConflictError(f"{str(kind).title()} '{name}' already exists") from exc

    def create(self, data, user=None):
        clean = self._clean({k: v for k, v in (data or {}).items() if k in EDITABLE})
        eq = Equipment(created_by=user, updated_by=user, **clean)
        db.session.add(eq)
        self._commit_or_conflict(clean.get("kind"), clean.get("name"))
        return eq.to_dict()

    def update(self, eq_id, data, user=None):
        eq = db.session.get(Equipment, eq_id)
        if eq is None:
            raise NotFoundError(f"Equipment {eq_id} not found")
        clean = self._clean({k: v for k, v in (data or {}).items() if k in EDITABLE}, current=eq)
        for k, v in clean.items():
            setattr(eq, k, v)
        eq.updated_by = user
        self._commit_or_conflict(eq.kind, eq.name)
        return eq.to_dict()

    # ---- Excel ----

    def import_file(self, file_stream, user=None):
        """Upsert by (kind, name): a known line/machine/die updates that row, a
        new one is added. Each row is checked like a form entry; a bad row is
        reported with its reason and the rest still import."""

        def process(raw):
            kind = to_text(raw.get("kind")).upper()
            if kind not in KINDS:
                raise ValueError(f"Kind '{to_text(raw.get('kind'))}' must be LINE, MACHINE or DIE")
            name = normalise_name(raw.get("name"))
            if not name:
                raise ValueError("Name is empty")
            code = normalise_code(raw.get("code"))
            with db.session.no_autoflush:
                eq = Equipment.query.filter(
                    Equipment.kind == kind, func.lower(Equipment.name) == name.lower()).first()
            if eq is None:
                eq = Equipment(kind=kind, name=name[:80], created_by=user)
                db.session.add(eq)
            eq.name = name[:80]
            if code:
                eq.code = code[:40]
            eq.updated_by = user
            db.session.flush()

        return bulk_import(file_stream, IMPORT_ALIASES, ["kind", "name"], process)

    @staticmethod
    def template():
        return build_template(TEMPLATE_COLUMNS)

    def export(self):
        rows = [dict(e, active="Yes" if e["is_active"] else "No") for e in self.list()]
        return build_export(EXPORT_COLUMNS, rows)

    # ---- one-time / repeatable seed from existing installations ----

    @staticmethod
    def seed_from_ledger(user="seed"):
        """Fill the master from the distinct line/machine/die text already on the
        ledger and the installation journal, so the dropdowns start populated.

        Idempotent: an existing (kind, name) is skipped, so it is safe to run
        again after more installations. Returns the number added per kind."""
        from app.models.spare_flow import SpareTransaction
        from app.models.spare_stock import SpareStockLedger

        sources = (SpareStockLedger, SpareTransaction)
        added = {"LINE": 0, "MACHINE": 0, "DIE": 0}

        def existing(kind):
            return {e.name.lower() for e in Equipment.query.filter_by(kind=kind).all()}

        # LINE carries two columns — keep the (name, no.) pairing.
        seen = existing("LINE")
        pairs = {}
        for model in sources:
            for ln, lno in db.session.query(model.line_name, model.line_no).distinct():
                name = normalise_name(ln)
                if _meaningful(name) and name.lower() not in seen and name.lower() not in pairs:
                    pairs[name.lower()] = (name, normalise_code(lno))
        for name, code in sorted(pairs.values(), key=lambda p: p[0].lower()):
            db.session.add(Equipment(
                kind="LINE", name=name[:80], code=(code[:40] if code else None), created_by=user))
            added["LINE"] += 1

        # MACHINE and DIE are single-column.
        for kind, col in (("MACHINE", "machine"), ("DIE", "die_no")):
            seen = existing(kind)
            names = {}
            for model in sources:
                for (value,) in db.session.query(getattr(model, col)).distinct():
                    name = normalise_name(value)
                    if _meaningful(name) and name.lower() not in seen and name.lower() not in names:
                        names[name.lower()] = name
            for name in sorted(names.values(), key=str.lower):
                db.session.add(Equipment(kind=kind, name=name[:80], created_by=user))
                added[kind] += 1

        db.session.commit()
        return added
