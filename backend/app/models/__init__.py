"""Expose all models so db.create_all() can discover every table."""
from app.models.supplier import Supplier
from app.models.part import Part
from app.models.part_supplier import PartSupplier
from app.models.rack_bin import RackBin
from app.models.srv import SRV
from app.models.srv_scan_event import SRVScanEvent
from app.models.store_stock import PartStock, StockLedger
from app.models.spare_stock import SpareStock, SpareStockLedger
from app.models.erp_stock import ERPStock
from app.models.holding_entry import HoldingEntry
from app.models.notification import Notification
from app.models.audit_log import AuditLog
from app.models.finished_good import FinishedGood
from app.models.bom import BOM
from app.models.forecast import CustomerForecast
from app.models.stock_count import DailyStockCount
from app.models.physical_stock import PhysicalStock
from app.models.quarterly_inventory import QuarterlyInventory
from app.models.dashboard_snapshot import DashboardSnapshot
from app.models.supplier_vehicle_window import SupplierVehicleWindow
from app.models.supplier_window_schedule import SupplierWindowSchedule
from app.models.milkrun_group import MilkrunGroup, SupplierMilkrunMapping
from app.models.user import User, UserStoreAccess
from app.models.store import Store, Section
from app.models.department import Department
from app.models.rgp import RGP
from app.models.receiving_register import ReceivingRegister
from app.models.gate_entry import GateEntry
from app.models.gate_exit import GateExit

__all__ = [
    "Supplier", "Part", "PartSupplier", "RackBin", "SRV", "SRVScanEvent", "PartStock", "StockLedger", "ERPStock",
    "HoldingEntry", "Notification", "AuditLog",
    "FinishedGood", "BOM", "CustomerForecast", "DailyStockCount", "PhysicalStock", "QuarterlyInventory", "DashboardSnapshot",
    "SupplierVehicleWindow", "SupplierWindowSchedule", "MilkrunGroup", "SupplierMilkrunMapping",
    "User", "UserStoreAccess", "Store", "Section", "Department", "RGP",
    "ReceivingRegister", "GateEntry", "GateExit",
]
