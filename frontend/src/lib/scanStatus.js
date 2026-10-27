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

// scan_result.buckets keys, in display order. quality_pending is read from the
// ERP GRN register (GRN created, accepted qty not yet entered in ERP).
export const BUCKETS = [
  { key: "available", label: "Available", status: "STOCK_AVAILABLE" },
  { key: "quality_pending", label: "Quality pending (ERP)", status: "QUALITY_PENDING" },
  { key: "issued_out", label: "Issued / on line", status: "ISSUED" },
  { key: "return_pending", label: "Return – to inspect", status: "RETURN_INSPECTION" },
  { key: "return_hold", label: "Return hold", status: "RETURN_HOLD" },
  { key: "damaged", label: "Damaged", status: "DAMAGED" },
  { key: "with_supplier", label: "With supplier (rework)", status: "WITH_SUPPLIER" },
  { key: "rgp_grn_pending", label: "RGP GRN pending", status: "RGP_GRN_PENDING" },
];

// scan_result.actions[].key -> how the button looks. Order = display order.
// The backend decides WHICH are enabled for the part's current state (spec 27);
// this map only dresses them. Scanning is mainly for issuance, so ISSUE leads.
// Receiving, the GRN and quality clearance are done in ERP and only READ by the
// app (ERP_LINE_STATE below) — they are not actions here.
export const ACTIONS = {
  ISSUE: { label: "Issue", icon: "ArrowUpFromLine", tone: "primary" },
  RGP_GRN: { label: "Receive / RGP GRN", icon: "PackageCheck", tone: "primary" },
  RGP_RETURN: { label: "RGP Return", icon: "Undo2", tone: "primary" },
  INSPECT: { label: "Inspection", icon: "ClipboardCheck", tone: "primary" },
  RETURN: { label: "Return", icon: "ArrowDownToLine", tone: "secondary" },
  RGP_OUT: { label: "RGP (Rework)", icon: "Truck", tone: "secondary" },
  PRINT_LABEL: { label: "Print Label", icon: "Printer", tone: "secondary" },
  REPRINT_LABEL: { label: "Reprint Label", icon: "Printer", tone: "secondary" },
  UPDATE_LOCATION: { label: "Location", icon: "MapPin", tone: "ghost" },
  HISTORY: { label: "View History", icon: "History", tone: "ghost" },
};

// What the app does with one ERP GRN line of a part (ErpGrnPostingService
// state: scan_result.erp_receiving.lines[].state, the Receiving & GRN page).
// The GRN and the quality clearance happen in ERP; the app reads them and adds
// the accepted quantity to store stock once.
export const ERP_LINE_STATE = {
  QUALITY_PENDING: { label: "Quality pending (ERP)", badge: "badge-warning", tone: "warning", dot: "bg-amber-500" },
  WILL_POST: { label: "Accepted — will be added", badge: "badge-info", tone: "info", dot: "bg-sky-500" },
  POSTED: { label: "Added to store stock", badge: "badge-success", tone: "success", dot: "bg-emerald-500" },
  CHECK: { label: "Check with ERP", badge: "badge-danger", tone: "danger", dot: "bg-red-500" },
  SKIPPED: { label: "Not added — see reason", badge: "badge-neutral", tone: "neutral", dot: "bg-slate-400" },
  REJECTED: { label: "Rejected by quality (ERP)", badge: "badge-danger", tone: "danger", dot: "bg-red-500" },
  OFF: { label: "Auto-add off", badge: "badge-neutral", tone: "neutral", dot: "bg-slate-400" },
};
export const erpLineMeta = (state) =>
  ERP_LINE_STATE[state] || { label: state ? state.replace(/_/g, " ").toLowerCase() : "—", badge: "badge-neutral", tone: "neutral", dot: "bg-slate-400" };

// Receipt statuses (spare_receipts.status) — the in-app receipts recorded
// before receiving moved to ERP; kept so their history still reads.
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

// Scan Part's ways of working (the switch at the top of the page shows when
// there is more than one). Issue: a scan opens the Issue form once the part is
// identified. Put-away Check was taken out on 27 Oct 2026 — it needed a QR at
// the rack, and the store puts no tag there.
// The Receive & Lot Tag mode (param "label") is gone: the store had the gate-entry
// lot tags taken out on 17 Oct 2026 — management said they waste paper ("lot tag
// bhi kah rhe h ki paper wastage h use hta do"). Scan Part opens Issue for it.
export const SCAN_MODE = {
  ISSUE: { label: "Issue", icon: "ArrowUpFromLine", param: "issue" },
};

// A part's barcodes (BarcodeService.list_part_barcodes source): its own QR —
// which carries only the Part No. — and supplier codes mapped to it.
export const BARCODE_SOURCE = {
  INTERNAL: { label: "Internal QR", icon: "QrCode" },
  SUPPLIER: { label: "Supplier code", icon: "Barcode" },
};

// Label print sources (spec 8) — LabelPrintAudit.source.
export const PRINT_SOURCE = {
  SUPPLIER_BARCODE: "Supplier Barcode",
  ERP_SEARCH: "ERP Search",
  MANUAL_ENTRY: "Manual Entry",
  QR_SCAN: "QR Scan",
  REPRINT: "Reprint",
  PART_MASTER: "Part Master",
  STORE_STOCK: "Store Stock",
  // The gate-entry lot tags, printed until 17 Oct 2026 — kept so their print
  // history still reads.
  GATE_ENTRY: "Gate Entry",
};

// Part timeline kinds (scan_result.timeline.rows[].kind) -> label + icon + tone.
// The receiving history is read from ERP (ERP_GATE, ERP_GRN, and the quality
// acceptance the app read from ERP as QUALITY_CLEARANCE); RECEIVE / GRN rows
// are in-app records from before that and stay in the history as they are.
export const TIMELINE_KIND = {
  ERP_GATE: { label: "Received at gate (ERP)", icon: "Truck", tone: "info" },
  ERP_GRN: { label: "GRN created in ERP", icon: "FileCheck2", tone: "info" },
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
};
export const timelineMeta = (kind) =>
  TIMELINE_KIND[kind] || { label: kind ? kind.replace(/_/g, " ").toLowerCase() : "Event", icon: "Circle", tone: "neutral" };
