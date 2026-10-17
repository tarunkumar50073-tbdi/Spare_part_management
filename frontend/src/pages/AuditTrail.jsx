import React, { useEffect, useState } from "react";
import { History, Search } from "lucide-react";
import Table from "../components/Table.jsx";
import Pagination from "../components/Pagination.jsx";
import { auditLogService } from "../services/auditLogService.js";
import { parseServerTime } from "../lib/format.js";

const ENTITY_TYPES = ["SRV", "RACK_BIN", "HOLDING_ENTRY", "PART", "user"];
const EMPTY = { entityType: "", q: "", dateFrom: "", dateTo: "" };

export default function AuditTrail() {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState(EMPTY);

  const load = async (p, f) => {
    setLoading(true);
    try {
      const res = await auditLogService.list({
        page: p,
        per_page: 15,
        entity_type: f.entityType || undefined,
        q: f.q.trim() || undefined,
        date_from: f.dateFrom || undefined,
        date_to: f.dateTo || undefined,
      });
      setRows(res.data.data);
      setMeta(res.data.meta);
    } catch {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  // Any filter change reloads from page 1, debounced so typing in the search
  // box costs one request at the end rather than one per keystroke.
  useEffect(() => {
    const id = setTimeout(() => load(1, filters), 300);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const set = (patch) => setFilters((f) => ({ ...f, ...patch }));
  const dirty = filters.entityType || filters.q || filters.dateFrom || filters.dateTo;

  const columns = [
    { key: "action", label: "Action" },
    { key: "entity_type", label: "Entity", render: (r) => `${r.entity_type}${r.entity_id ? ` #${r.entity_id}` : ""}` },
    { key: "user", label: "User" },
    { key: "old_location", label: "Old Location", render: (r) => r.old_location || "—" },
    { key: "new_location", label: "New Location", render: (r) => r.new_location || "—" },
    { key: "quantity", label: "Qty", render: (r) => r.quantity ?? "—" },
    { key: "remarks", label: "Remarks", render: (r) => r.remarks || "—" },
    { key: "created_at", label: "When", render: (r) => parseServerTime(r.created_at)?.toLocaleString() ?? "—" },
  ];

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
        <History size={18} className="text-toyotared" /> Audit Trail
      </h2>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            className="input-field w-64 pl-9"
            placeholder="Search action, remarks, user…"
            value={filters.q}
            onChange={(e) => set({ q: e.target.value })}
          />
        </div>
        <select className="input-field w-44" value={filters.entityType} onChange={(e) => set({ entityType: e.target.value })}>
          <option value="">All entity types</option>
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>{t.replaceAll("_", " ")}</option>
          ))}
        </select>
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">From</span>
        <input type="date" className="input-field !w-[150px]" value={filters.dateFrom} max={filters.dateTo || undefined} onChange={(e) => set({ dateFrom: e.target.value })} />
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">To</span>
        <input type="date" className="input-field !w-[150px]" value={filters.dateTo} min={filters.dateFrom || undefined} onChange={(e) => set({ dateTo: e.target.value })} />
        {dirty && <button className="btn-secondary" onClick={() => setFilters(EMPTY)}>Clear</button>}
      </div>

      <div className="card">
        <Table columns={columns} rows={rows} loading={loading} emptyMessage="No audit log entries match these filters" />
        <Pagination meta={meta} onPageChange={(p) => load(p, filters)} />
      </div>
    </div>
  );
}
