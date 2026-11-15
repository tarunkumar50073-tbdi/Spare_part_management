"""Quarterly physical inventory of a store section (15 Nov 2026 spec "DX STORE –
QUARTERLY INVENTORY MODULE"). Replaces the old one-table Excel upload
(quarterly_inventory, empty, removed the same day).

One set of tables for every store — a row carries its store_code — so the
Child Parts store can use it later without tables of its own ("abhi sirf
spare k liye").

  inventory_sessions        one count of one section for one FY + quarter
  inventory_snapshot_lines  ERP stock of the section's parts at the start — never changed after
  inventory_counts          what was counted on the shelf (a recount / revision is a new row)
  inventory_results         the reconciliation frozen at final approval (a revision adds a set)
  inventory_audit           the log: plan / start / submit / approve / reject / recount OK /
                            revision, and every count, edit and recount (old qty -> new qty)

The three sources are never mixed: ERP qty comes only from the snapshot, the
physical qty only from inventory_counts, and the app's own stock (the ledger)
is not read or changed by any of this.
"""
from app.extensions import db
from app.models.base import BaseModel

QUARTERS = ("Q1", "Q2", "Q3", "Q4")
# PLANNED -> IN_PROGRESS (ERP snapshot taken, counting) -> RECON_PENDING
# (counting closed, waiting for the manager) -> COMPLETED (approved, locked).
SESSION_STATUSES = ("PLANNED", "IN_PROGRESS", "RECON_PENDING", "COMPLETED")
RESULT_STATUSES = ("MATCH", "SHORT", "EXCESS", "NOT_COUNTED")


class InventorySession(BaseModel):
    __tablename__ = "inventory_sessions"

    store_code = db.Column(db.String(30), db.ForeignKey("stores.code"), nullable=False, index=True)
    fiscal_year = db.Column(db.String(10), nullable=False)          # "2026-27"
    quarter = db.Column(db.String(2), nullable=False)               # Q1..Q4
    section_id = db.Column(db.Integer, db.ForeignKey("sections.id"), nullable=False, index=True)
    # A second session of the same section + FY + quarter only with a reason
    # (spec 3: "unless explicitly authorized"); the first is attempt 1.
    attempt = db.Column(db.Integer, nullable=False, default=1)
    duplicate_reason = db.Column(db.String(255), nullable=True)
    start_date = db.Column(db.Date, nullable=False)
    close_date = db.Column(db.Date, nullable=False)
    status = db.Column(db.String(20), nullable=False, default="PLANNED", index=True)
    remarks = db.Column(db.String(255), nullable=True)
    planned_by = db.Column(db.String(60), nullable=True)
    # The ERP snapshot: when it was taken, ERP's own "as of" time, and from where.
    snapshot_at = db.Column(db.DateTime(timezone=True), nullable=True)
    snapshot_erp_as_of = db.Column(db.DateTime(timezone=True), nullable=True)
    snapshot_source = db.Column(db.String(20), nullable=True)       # ERP_DB | EXCEL
    snapshot_file = db.Column(db.String(150), nullable=True)
    snapshot_by = db.Column(db.String(60), nullable=True)
    submitted_at = db.Column(db.DateTime(timezone=True), nullable=True)
    submitted_by = db.Column(db.String(60), nullable=True)
    approved_at = db.Column(db.DateTime(timezone=True), nullable=True)
    approved_by = db.Column(db.String(60), nullable=True)
    # 0 = the result approved first; each correction after the lock adds one.
    revision = db.Column(db.Integer, nullable=False, default=0)

    section = db.relationship("Section")

    __table_args__ = (
        db.UniqueConstraint("store_code", "fiscal_year", "quarter", "section_id", "attempt",
                            name="uq_inventory_session"),
        db.CheckConstraint("quarter IN ('Q1','Q2','Q3','Q4')", name="ck_inventory_session_quarter"),
        db.CheckConstraint("status IN ('PLANNED','IN_PROGRESS','RECON_PENDING','COMPLETED')",
                           name="ck_inventory_session_status"),
        db.CheckConstraint("close_date >= start_date", name="ck_inventory_session_dates"),
    )


class InventorySnapshotLine(BaseModel):
    """ERP stock of one part when the session started. Written once."""
    __tablename__ = "inventory_snapshot_lines"

    session_id = db.Column(db.Integer, db.ForeignKey("inventory_sessions.id", ondelete="CASCADE"),
                           nullable=False, index=True)
    part_id = db.Column(db.Integer, db.ForeignKey("part_master.id"), nullable=False, index=True)
    # The part as it was that day (the Part Master may change later).
    part_no = db.Column(db.String(50), nullable=False)
    item_description = db.Column(db.String(150), nullable=True)
    uom = db.Column(db.String(10), nullable=True)
    section_name = db.Column(db.String(60), nullable=True)
    category = db.Column(db.String(50), nullable=True)
    location = db.Column(db.String(60), nullable=True)
    erp_qty = db.Column(db.Numeric(14, 3), nullable=True)            # NULL = ERP had no figure
    rate = db.Column(db.Numeric(12, 2), nullable=True)

    __table_args__ = (db.UniqueConstraint("session_id", "part_id", name="uq_inventory_snapshot_part"),)


class InventoryCount(BaseModel):
    """One count of one part. The latest row (highest seq) is the part's count;
    a recount or a correction after the lock is a new row, never an edit of
    the old one's number without an audit line."""
    __tablename__ = "inventory_counts"

    session_id = db.Column(db.Integer, db.ForeignKey("inventory_sessions.id", ondelete="CASCADE"),
                           nullable=False, index=True)
    part_id = db.Column(db.Integer, db.ForeignKey("part_master.id"), nullable=False, index=True)
    seq = db.Column(db.Integer, nullable=False, default=1)           # 1 = first count, 2.. = recounts
    kind = db.Column(db.String(10), nullable=False, default="COUNT")  # COUNT | RECOUNT | REVISION
    counted_qty = db.Column(db.Numeric(14, 3), nullable=False)
    location = db.Column(db.String(60), nullable=True)
    counted_by = db.Column(db.String(60), nullable=False)
    counted_at = db.Column(db.DateTime(timezone=True), nullable=False)
    remarks = db.Column(db.String(255), nullable=True)
    source = db.Column(db.String(10), nullable=False, default="SCAN")  # SCAN | MANUAL | EXCEL
    # A supervisor opened this count for a recount: the next row may be written.
    recount_ok_by = db.Column(db.String(60), nullable=True)
    recount_ok_at = db.Column(db.DateTime(timezone=True), nullable=True)
    recount_reason = db.Column(db.String(255), nullable=True)

    __table_args__ = (
        db.UniqueConstraint("session_id", "part_id", "seq", name="uq_inventory_count_seq"),
        db.CheckConstraint("counted_qty >= 0", name="ck_inventory_count_qty"),
    )


class InventoryResult(BaseModel):
    """The reconciliation of one part as approved (revision 0) or as corrected
    later (revision 1, 2, ...). Never updated; a revision writes a new set."""
    __tablename__ = "inventory_results"

    session_id = db.Column(db.Integer, db.ForeignKey("inventory_sessions.id", ondelete="CASCADE"),
                           nullable=False, index=True)
    revision = db.Column(db.Integer, nullable=False, default=0)
    part_id = db.Column(db.Integer, db.ForeignKey("part_master.id"), nullable=False, index=True)
    part_no = db.Column(db.String(50), nullable=False)
    item_description = db.Column(db.String(150), nullable=True)
    uom = db.Column(db.String(10), nullable=True)
    category = db.Column(db.String(50), nullable=True)
    location = db.Column(db.String(60), nullable=True)
    erp_qty = db.Column(db.Numeric(14, 3), nullable=True)
    physical_qty = db.Column(db.Numeric(14, 3), nullable=True)       # NULL = not counted
    variance_qty = db.Column(db.Numeric(14, 3), nullable=True)
    rate = db.Column(db.Numeric(12, 2), nullable=True)
    status = db.Column(db.String(12), nullable=False)

    __table_args__ = (
        db.UniqueConstraint("session_id", "revision", "part_id", name="uq_inventory_result_part"),
        db.CheckConstraint("status IN ('MATCH','SHORT','EXCESS','NOT_COUNTED')", name="ck_inventory_result_status"),
    )


class InventoryAudit(BaseModel):
    __tablename__ = "inventory_audit"

    session_id = db.Column(db.Integer, db.ForeignKey("inventory_sessions.id", ondelete="CASCADE"),
                           nullable=False, index=True)
    part_id = db.Column(db.Integer, db.ForeignKey("part_master.id"), nullable=True, index=True)
    # One log for approvals and the audit (15 Nov 2026: "har k liye alag alag
    # table jaruri h kya" — kept to five tables). Workflow: PLAN, START, SUBMIT,
    # APPROVE, REJECT, RECOUNT_OK, REVISION; counts: COUNT, RECOUNT, EDIT, SNAPSHOT.
    action = db.Column(db.String(12), nullable=False)
    old_qty = db.Column(db.Numeric(14, 3), nullable=True)
    new_qty = db.Column(db.Numeric(14, 3), nullable=True)
    by = db.Column(db.String(60), nullable=False)
    at = db.Column(db.DateTime(timezone=True), nullable=False)
    revision = db.Column(db.Integer, nullable=False, default=0)
    remarks = db.Column(db.String(255), nullable=True)
