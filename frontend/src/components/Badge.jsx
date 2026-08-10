import React from "react";

const MAP = {
  "Active": "badge-success",
  "Inactive": "badge-neutral",
  // Store / SRV workflow statuses
  "PENDING_UNLOAD": "badge-warning",
  "UNLOADED": "badge-neutral",
  "VERIFIED": "badge-neutral",
  "SRV_CREATED": "badge-neutral",
  "RQC_FORWARDED": "badge-warning",
  "INSPECTION_PENDING": "badge-warning",
  "INSPECTED_APPROVED": "badge-success",
  "INSPECTED_REJECTED": "badge-danger",
  "STORED": "badge-success",
  "RETURNED_TO_SUPPLIER": "badge-danger",
  "FORWARDED_TOOL_ROOM": "badge-neutral",
  "TRANSFERRED": "badge-success",
  "SUPPLIED": "badge-success",
  "CONSUMED": "badge-success",
  "Approved": "badge-success",
  "Rejected": "badge-danger",
  "Short": "badge-danger",
  "Excess": "badge-warning",
  "Normal": "badge-success",
  "OutOfStock": "badge-danger",
  "Healthy": "badge-success",
  "Unknown": "badge-neutral",
  "Dead Stock": "badge-neutral",
  // Supplier Vehicle Management arrival statuses, in order of severity.
  // Pending Arrival is amber, not neutral: "still awaited, window open" sits
  // between arrived and missed rather than being a non-answer. "Early" is
  // gone — a vehicle in before its window is On-Time as far as the store is
  // concerned. Not Arrived is the worst of the four, so it keeps the danger
  // styling and Late steps down to warning.
  "Pending Arrival": "badge-warning",
  "On-Time": "badge-success",
  "Late": "badge-warning",
  "Not Arrived": "badge-danger",
  "Unscheduled": "badge-neutral",
  // Quarterly Inventory + ERP-vs-Physical reconciliation statuses
  "MATCH": "badge-success",
  "SHORT": "badge-danger",
  "EXCESS": "badge-warning",
  "NOT_SYNCED": "badge-neutral",
  "NO_PHYSICAL": "badge-neutral",
  // Part routing types
  "DOL": "badge-success",
  "OTHER": "badge-warning",
  "TOOL_ROOM": "badge-neutral",
  // Holding Area / Rack status
  "PENDING": "badge-warning",
  "PARTIAL_TRANSFER": "badge-warning",
  "COMPLETED": "badge-success",
  "Empty": "badge-neutral",
  "Partial": "badge-warning",
  "Full": "badge-danger",
  "Blocked": "badge-danger",
};

export default function Badge({ status }) {
  if (!status) return <span className="badge badge-neutral">—</span>;
  return <span className={`badge ${MAP[status] || "badge-neutral"}`}>{status}</span>;
}
