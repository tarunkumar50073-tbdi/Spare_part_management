import React, { useEffect, useState } from "react";
import { Truck, Radio } from "lucide-react";
import Table from "../components/Table.jsx";
import { srvService } from "../services/srvService.js";

export default function GateEntry() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await srvService.list({ status: "PENDING_UNLOAD", per_page: 50 });
      setRows(res.data.data);
    } catch (_) {
      /* handled globally */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, []);

  const columns = [
    { key: "vendor_code", label: "Vendor" },
    { key: "supplier_name", label: "Supplier" },
    { key: "invoice_no", label: "Invoice / Challan" },
    { key: "part_no", label: "Part No" },
    { key: "part_name", label: "Part Name" },
    { key: "qty_invoiced", label: "Qty Invoiced" },
    {
      key: "gate_entry_time",
      label: "Gate Entry Time",
      render: (r) => (r.gate_entry_time ? new Date(r.gate_entry_time).toLocaleString() : "—"),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
            <Truck size={18} className="text-toyotared" /> Gate Entries — Pending Unload
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Monitoring only. Gate entry, unloading and material verification all come from ERP's own API — there
            are no manual actions on this page.
          </p>
        </div>
        <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <Radio size={14} className="animate-pulse" /> Live from ERP API
        </span>
      </div>

      <div className="card">
        <Table columns={columns} rows={rows} loading={loading} emptyMessage="No pending gate entries" />
      </div>
    </div>
  );
}
