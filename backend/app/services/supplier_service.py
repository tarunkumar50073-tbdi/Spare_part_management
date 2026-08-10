"""Supplier master business logic."""
from app.extensions import db
from app.models.supplier import Supplier
from app.repositories.supplier_repository import SupplierRepository
from app.utils.exceptions import NotFoundError, ConflictError
from app.utils.excel_io import bulk_import, build_template, build_export, to_text

FIELD_ALIASES = {
    "vendor_code": {"vendorcode", "suppliercode", "code"},
    "supplier_name": {"suppliername", "vendorname", "name"},
    "status": {"status"},
}
REQUIRED_FIELDS = ["vendor_code", "supplier_name"]

TEMPLATE_COLUMNS = ["Vendor Code", "Supplier Name", "Status (Active/Inactive)"]

EXPORT_COLUMNS = [("Vendor Code", "vendor_code"), ("Supplier Name", "supplier_name"), ("Status", "status")]


class SupplierService:
    def __init__(self):
        self.repo = SupplierRepository()

    def list_suppliers(self, keyword=None, status=None, vehicle_tracking=None):
        return self.repo.search(keyword=keyword, status=status, vehicle_tracking=vehicle_tracking)

    def get(self, supplier_id):
        supplier = self.repo.get_by_id(supplier_id)
        if not supplier:
            raise NotFoundError(f"Supplier {supplier_id} not found")
        return supplier

    def create(self, data):
        if self.repo.get_by_vendor_code(data["vendor_code"]):
            raise ConflictError(f"Vendor code {data['vendor_code']} already exists")
        return self.repo.create(**data)

    def update(self, supplier_id, data):
        supplier = self.get(supplier_id)
        return self.repo.update(supplier, **data)

    def delete(self, supplier_id):
        supplier = self.get(supplier_id)
        self.repo.delete(supplier)

    def bulk_import_excel(self, file_stream):
        seen_codes = set()

        def row_processor(raw_row):
            vendor_code = to_text(raw_row.get("vendor_code"))
            if not vendor_code:
                raise ValueError("Vendor Code is required")
            if vendor_code in seen_codes:
                raise ValueError(f"Duplicate Vendor Code in file: {vendor_code}")
            seen_codes.add(vendor_code)
            if self.repo.get_by_vendor_code(vendor_code):
                raise ValueError(f"Vendor Code already exists: {vendor_code}")

            supplier_name = to_text(raw_row.get("supplier_name"))
            if not supplier_name:
                raise ValueError("Supplier Name is required")

            status = to_text(raw_row.get("status"), "Active")
            if status not in ("Active", "Inactive"):
                status = "Active"

            db.session.add(Supplier(vendor_code=vendor_code, supplier_name=supplier_name, status=status))

        return bulk_import(file_stream, FIELD_ALIASES, REQUIRED_FIELDS, row_processor)

    @staticmethod
    def build_template():
        return build_template(TEMPLATE_COLUMNS)

    def export_all(self):
        rows = [
            {"vendor_code": s.vendor_code, "supplier_name": s.supplier_name, "status": s.status}
            for s in self.repo.get_all().order_by(Supplier.vendor_code.asc()).all()
        ]
        return build_export(EXPORT_COLUMNS, rows)
