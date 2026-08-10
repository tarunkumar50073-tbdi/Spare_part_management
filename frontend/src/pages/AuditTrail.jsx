import React, { useEffect, useState } from "react";
import { History, Search } from "lucide-react";
import Table from "../components/Table.jsx";
import Pagination from "../components/Pagination.jsx";
import { auditLogService } from "../services/auditLogService.js";

const ENTITY_TYPES = ["", "SRV", "RACK_BIN", "HOLDING_ENTRY", "PART"];

export default function AuditTrail() {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [entityType, setEntityType] = useState("");
  const [page, setPage] = useState(1);

  const load = async (p = page, et = entityType) => {
    setLoading(true);
    try {
      const res = await auditLogService.list({ page: p, per_page: 15, entity_type: et || undefined });
      setRows(res.data.data);
      setMeta(res.data.meta);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(1, entityType);
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType]);

  const columns = [
    { key: "action", label: "Action" },
    { key: "entity_type", label: "Entity", render: (r) => `${r.entity_type}${r.entity_id ? ` #${r.entity_id}` : ""}` },
    { key: "user", label: "User" },
    { key: "old_location", label: "Old Location", render: (r) => r.old_location || "—" },
    { key: "new_location", label: "New Location", render: (r) => r.new_location || "—" },
    { key: "quantity", label: "Qty", render: (r) => r.quantity ?? "—" },
    { key: "remarks", label: "Remarks", render: (r) => r.remarks || "—" },
    { key: "created_at", label: "When", render: (r) => new Date(r.created_at).toLocaleString() },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
          <History size={18} className="text-toyotared" /> Audit Trail
        </h2>
        <div className="flex items-center gap-2">
          <Search size={16} className="text-slate-400" />
          <select className="input-field w-56" value={entityType} onChange={(e) => setEntityType(e.target.value)}>
            <option value="">All entity types</option>
            {ENTITY_TYPES.filter(Boolean).map((t) => (
              <option key={t} value={t}>{t.replaceAll("_", " ")}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="card">
        <Table columns={columns} rows={rows} loading={loading} emptyMessage="No audit log entries" />
        <Pagination meta={meta} onPageChange={(p) => { setPage(p); load(p, entityType); }} />
      </div>
    </div>
  );
}
