"""Line / Machine / Die master (equipment table)

A new reference table for the values recorded at installation — the production
Line, the Machine and the Die — told apart by ``kind``. Nothing existing changes:
the ledger keeps storing the chosen text as it always has, so this revision only
adds the ``equipment`` table (no columns on ledger / journal). A running app
creates the same table through ``db.create_all()`` at boot, so an existing SQLite
DB already matches this revision.

Revision ID: c4d2f1a9e6b3
Revises: ebb7f9b7afb4
Create Date: 2026-09-28
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'c4d2f1a9e6b3'
down_revision = 'ebb7f9b7afb4'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'equipment',
        sa.Column('kind', sa.String(length=10), nullable=False),
        sa.Column('code', sa.String(length=40), nullable=True),
        sa.Column('name', sa.String(length=80), nullable=False),
        sa.Column('is_active', sa.Boolean(), nullable=False),
        sa.Column('created_by', sa.String(length=60), nullable=True),
        sa.Column('updated_by', sa.String(length=60), nullable=True),
        sa.Column('id', sa.Integer(), autoincrement=True, nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('LINE','MACHINE','DIE')", name='ck_equipment_kind'),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('equipment', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_equipment_code'), ['code'], unique=False)
        batch_op.create_index(batch_op.f('ix_equipment_kind'), ['kind'], unique=False)
        # Case-insensitive backstop for the (kind, name) rule the service checks.
        batch_op.create_index('uq_equipment_kind_lower_name',
                              ['kind', sa.text('lower(name)')], unique=True)


def downgrade():
    with op.batch_alter_table('equipment', schema=None) as batch_op:
        batch_op.drop_index('uq_equipment_kind_lower_name')
        batch_op.drop_index(batch_op.f('ix_equipment_kind'))
        batch_op.drop_index(batch_op.f('ix_equipment_code'))
    op.drop_table('equipment')
