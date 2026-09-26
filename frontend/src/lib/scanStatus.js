// Shared vocabulary of the QR traceability flow (backend: models/spare_flow.py,
// services/scan_result_service.py). One place for labels / badge tones / icons
// so the Scan Part workstation, the Work Queue, the part timeline and the
// drawer all say the same thing. Badge classes are the app's existing ones.

// Headline status of a scanned part (scan_result.primary_status.key) and the
// per-bucket chips (scan_result.statuses[].key). The QR is PART-level: several
// can be true at once, so the screen shows one headline + a chip per bucket.
export const SCAN_STATUS = {
  STOCK_AVAILABLE: { label: "Stock Available", badge: "badge-success", dot: "bg-emerald-500" },
  QUALITY_PENDING: { label: "Quality Pending", badge: "badge-warning", dot: "bg-amber-500" },
  ISSUED: { label: "Issued", badge: "badge-warning", dot: "bg-amber-500" },
  RETURN_INSPECTION: { label: "Returned – Inspection", badge: "badge-warning", dot: "bg-amber-500" },
  RETURN_HOLD: { label: "Return Hold", badge: "badge-warning", dot: "bg-amber-500" },
  WITH_SUPPLIER: { label: "With Supplier – Rework", badge: "badge-warning", dot: "bg-orange-500" },
  RGP_GRN_PENDING: { label: "Supplier Returned – RGP GRN Pending", badge: "badge-info", dot: "bg-sky-500" },
  DAMAGED: { label: "Damaged", badge: "badge-danger", dot: "bg-red-500" },
  OUT_OF_STOCK: { label: "Out of Stock", badge: "badge-danger", dot: "bg-red-500" },
  NOT_COUNTED: { label: "Not Counted", badge: "badge-neutral", dot: "bg-slate-400" },
};

export const statusMeta = (key) =>
  SCAN_STATUS[key] || { label: key ? key.replace(/_/g, " ").toLowerCase() : "—", badge: "badge-neutral", dot: "bg-slate-400" };

// scan_result.buckets keys, in display order.
export const BUCKETS = [
  { key: "available", label: "Available", status: "STOCK_AVAILABLE" },
  { key: "quality_pending", label: "Quality pending", status: "QUALITY_PENDING" },
  { key: "issued_out", label: "Issued / on line", status: "ISSUED" },
  { key: "return_pending", label: "Return – to inspect", status: "RETURN_INSPECTION" },
  { key: "return_hold", label: "Return hold", status: "RETURN_HOLD" },
  { key: "damaged", label: "Damaged", status: "DAMAGED" },
  { key: "with_supplier", label: "With supplier (rework)", status: "WITH_SUPPLIER" },
  { key: "rgp_grn_pending", label: "RGP GRN pending", status: "RGP_GRN_PENDING" },
];

// scan_result.actions[].key -> how the button looks. Order = display order.
// The backend decides WHICH are enabled for the part's current state (spec 27);
// this map only dresses them.
export const ACTIONS = {
  RGP_GRN: { label: "Receive / RGP GRN", icon: "PackageCheck", tone: "primary" },
  RGP_RETURN: { label: "RGP Return", icon: "Undo2", tone: "primary" },
  QUALITY_CLEARANCE: { label: "Quality Clearance", icon: "ShieldCheck", tone: "primary" },
  RECORD_GRN: { label: "Record GRN", icon: "FileCheck2", tone: "primary" },
  INSPECT: { label: "Inspection", icon: "ClipboardCheck", tone: "primary" },
  ISSUE: { label: "Issue", icon: "ArrowUpFromLine", tone: "primary" },
  RETURN: { label: "Return", icon: "ArrowDownToLine", tone: "secondary" },
  UPDATE_INSTALLATION: { label: "Update Line / Machine", icon: "Wrench", tone: "secondary" },
  RGP_OUT: { label: "RGP (Rework)", icon: "Truck", tone: "secondary" },
  RECEIVE: { label: "Receive", icon: "PackagePlus", tone: "secondary" },
  PRINT_LABEL: { label: "Print Label", icon: "Printer", tone: "secondary" },
  REPRINT_LABEL: { label: "Reprint Label", icon: "Printer", tone: "secondary" },
  UPDATE_LOCATION: { label: "Location", icon: "MapPin", tone: "ghost" },
  HISTORY: { label: "View History", icon: "History", tone: "ghost" },
};

// Receipt statuses (spare_receipts.status).
export const RECEIPT_STATUS = {
  RECEIVED: { label: "Received – GRN pending", badge: "badge-warning" },
  QUALITY_PENDING: { label: "GRN created – Quality pending", badge: "badge-warning" },
  STOCK_AVAILABLE: { label: "Quality cleared – In stock", badge: "badge-success" },
  REJECTED: { label: "Rejected by quality", badge: "badge-danger" },
  CANCELLED: { label: "Cancelled", badge: "badge-neutral" },
};

// Return statuses (spare_returns.status) and inspection results.
export const RETURN_STATUS = {
  INSPECTION_PENDING: { label: "Returned – Inspection pending", badge: "badge-warning" },
  RETURN_HOLD: { label: "Return hold – Inspection required", badge: "badge-warning" },
  DAMAGED: { label: "Damaged", badge: "badge-danger" },
  CLOSED: { label: "Closed", badge: "badge-neutral" },
};
export const INSPECTION_RESULTS = [
  { key: "GOOD", label: "Good / Reusable", hint: "Back to store stock", badge: "badge-success", dot: "bg-emerald-500" },
  { key: "INSPECTION_REQUIRED", label: "Inspection Required", hint: "Kept in return hold", badge: "badge-warning", dot: "bg-amber-500" },
  { key: "DAMAGED", label: "Damaged", hint: "Damaged stock — can go for RGP rework or scrap", badge: "badge-danger", dot: "bg-red-500" },
  { key: "SCRAP", label: "Scrap", hint: "Scrap / disposal", badge: "badge-neutral", dot: "bg-slate-800 dark:bg-slate-300" },
];

// RGP statuses (spare_rgps.status).
export const RGP_STATUS = {
  WITH_SUPPLIER: { label: "With Supplier – Rework", badge: "badge-warning" },
  RGP_GRN_PENDING: { label: "Supplier Returned – RGP GRN Pending", badge: "badge-info" },
  CLOSED: { label: "RGP GRN done – In stock", badge: "badge-success" },
  CANCELLED: { label: "Cancelled", badge: "badge-neutral" },
};

// Spec 13 return reasons. Old wording in history is shown via LEGACY_REASON.
export const RETURN_REASONS = [
  "Fitment Issue", "Wrong Part", "Excess / Not Required", "Machine Change", "Trial / Testing", "Other",
];
export const LEGACY_REASON = {
  "Did not fit": "Fitment Issue",
  "Wrong part": "Wrong Part",
  "Excess — not required": "Excess / Not Required",
};
export const reasonLabel = (r) => (r ? LEGACY_REASON[r] || r : "—");

// Label print sources (spec 8) — LabelPrintAudit.source.
export const PRINT_SOURCE = {
  SUPPLIER_BARCODE: "Supplier Barcode",
  ERP_SEARCH: "ERP Search",
  MANUAL_ENTRY: "Manual Entry",
  QR_SCAN: "QR Scan",
  REPRINT: "Reprint",
  PART_MASTER: "Part Master",
  STORE_STOCK: "Store Stock",
};

// Part timeline kinds (scan_result.timeline.rows[].kind) -> label + icon + tone.
export const TIMELINE_KIND = {
  RECEIVE: { label: "Received from supplier", icon: "PackagePlus", tone: "info" },
  GRN: { label: "GRN created", icon: "FileCheck2", tone: "info" },
  QUALITY_CLEARANCE: { label: "Quality cleared", icon: "ShieldCheck", tone: "success" },
  QUALITY_REJECT: { label: "Rejected by quality", icon: "ShieldX", tone: "danger" },
  STOCK_AVAILABLE: { label: "Added to store stock", icon: "PackageCheck", tone: "success" },
  ISSUE: { label: "Issued", icon: "ArrowUpFromLine", tone: "warning" },
  INSTALLATION: { label: "Installed", icon: "Wrench", tone: "success" },
  RETURN_TO_STORE: { label: "Returned to store", icon: "ArrowDownToLine", tone: "warning" },
  RETURN_INSPECTION: { label: "Return inspected", icon: "ClipboardCheck", tone: "info" },
  RGP_OUT: { label: "Issued to supplier for rework", icon: "Truck", tone: "warning" },
  RGP_RETURN: { label: "Supplier returned", icon: "Undo2", tone: "info" },
  RGP_GRN: { label: "RGP GRN completed", icon: "PackageCheck", tone: "success" },
  OPENING: { label: "Opening stock", icon: "Boxes", tone: "neutral" },
  STOCK_ADJUSTMENT: { label: "Stock adjustment", icon: "Scale", tone: "neutral" },
  CANCEL: { label: "Cancelled", icon: "Ban", tone: "neutral" },
  LABEL_PRINT: { label: "Label printed", icon: "Printer", tone: "neutral" },
  LOCATION_MOVE: { label: "Location changed", icon: "MapPin", tone: "neutral" },
  ERP_GATE: { label: "Arrived at gate (ERP)", icon: "Truck", tone: "neutral" },
  ERP_GRN: { label: "GRN in ERP", icon: "FileCheck2", tone: "neutral" },
};
export const timelineMeta = (kind) =>
  TIMELINE_KIND[kind] || { label: kind ? kind.replace(/_/g, " ").toLowerCase() : "Event", icon: "Circle", tone: "neutral" };
