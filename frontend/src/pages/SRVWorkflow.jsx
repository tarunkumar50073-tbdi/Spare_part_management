import React, { useEffect, useState } from "react";
import { Search, ClipboardList } from "lucide-react";
import Table from "../components/Table.jsx";
import Badge from "../components/Badge.jsx";
import Pagination from "../components/Pagination.jsx";
import { srvService } from "../services/srvService.js";

const STATUS_OPTIONS = [
  "", "PENDING_UNLOAD", "UNLOADED", "VERIFIED", "SRV_CREATED", "RQC_FORWARDED",
  "INSPECTION_PENDING", "STORED", "RETURNED_TO_SUPPLIER", "FORWARDED_TOOL_ROOM",
  "TRANSFERRED", "SUPPLIED", "CONSUMED",
];

// No manual actions anywhere on this page — the entire receiving pipeline
// (unload/verify/SRV creation) is ERP-inbound, and Transfer to Part Store
// is chained automatically the instant material reaches STORED (pure
// ledger bookkeeping, not a physical action — see
// SRVService._receive_into_store). This page is a pure status view: every
// row either shows what it's waiting on, or nothing at all.
const AWAITING_ERP_LABEL = {
  PENDING_UNLOAD: "Awaiting ERP Unload",
  UNLOADED: "Awaiting ERP Verification",
  VERIFIED: "Awaiting ERP SRV Creation",
  INSPECTION_PENDING: "Awaiting RQC clearance (ERP)",
  FORWARDED_TOOL_ROOM: "Awaiting Tool Room clearance (ERP)",
  TRANSFERRED: "Awaiting ERP Production Punch",
};

export default function SRVWorkflow() {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [keyword, setKeyword] = useState("");
  const [page, setPage] = useState(1);

  const load = async (p = page, st = status, kw = keyword) => {
    setLoading(true);
    try {
      const res = await srvService.list({ page: p, per_page: 10, status: st || undefined, keyword: kw || undefined });
      setRows(res.data.data);
      setMeta(res.data.meta);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(1, status, keyword);
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, keyword]);

  const columns = [
    { key: "srv_no", label: "SRV No", render: (r) => r.srv_no || <span className="text-slate-400">—</span> },
    { key: "vendor_code", label: "Vendor" },
    { key: "part_no", label: "Part" },
    { key: "part_name", label: "Part Name" },
    { key: "qty_invoiced", label: "Invoiced" },
    { key: "qty_received", label: "Received", render: (r) => r.qty_received ?? "—" },
    {
      key: "is_short", label: "Short",
      render: (r) =>
        r.is_short ? (
          <div className="flex flex-col gap-0.5">
            <Badge status="Short" />
            {r.short_note_no && <span className="text-[10px] text-slate-400">{r.short_note_no}</span>}
          </div>
        ) : (
          <span className="text-slate-300 dark:text-slate-600">—</span>
        ),
    },
    {
      key: "qc_required", label: "QC Required",
      render: (r) => <span className={r.qc_required ? "text-amber-600 dark:text-amber-400 text-xs" : "text-emerald-600 dark:text-emerald-400 text-xs"}>{r.qc_required ? "Yes" : "No"}</span>,
    },
    { key: "status", label: "Status", render: (r) => <Badge status={r.status} /> },
    {
      key: "waiting_on",
      label: "Waiting On",
      render: (r) => {
        const awaiting = AWAITING_ERP_LABEL[r.status];
        return awaiting
          ? <span className="text-amber-600 dark:text-amber-400 text-xs italic">{awaiting}</span>
          : <span className="text-slate-300 dark:text-slate-600 text-xs">—</span>;
      },
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
          <ClipboardList size={18} className="text-toyotared" /> SRV Workflow
        </h2>
        <div className="flex flex-col sm:flex-row gap-2 w-full sm:w-auto">
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-2.5 text-slate-400" size={16} />
            <input
              className="input-field pl-9"
              placeholder="Search SRV, part, invoice..."
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </div>
          <select className="input-field w-full sm:w-56" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {STATUS_OPTIONS.filter(Boolean).map((s) => (
              <option key={s} value={s}>{s.replaceAll("_", " ")}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="card">
        <Table columns={columns} rows={rows} loading={loading} emptyMessage="No SRVs found" />
        <Pagination meta={meta} onPageChange={(p) => { setPage(p); load(p, status, keyword); }} />
      </div>
    </div>
  );
}
