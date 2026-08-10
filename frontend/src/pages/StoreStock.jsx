import React, { useEffect, useState } from "react";
import { Warehouse, ShieldAlert } from "lucide-react";
import Table from "../components/Table.jsx";
import { storeStockService } from "../services/storeStockService.js";

const COLUMNS = [
  { key: "part_no", label: "Part No" },
  { key: "part_name", label: "Part Name" },
  { key: "uom", label: "UOM" },
  { key: "qty_on_hand", label: "Qty On Hand" },
];

export default function StoreStock() {
  const [data, setData] = useState({ available: [], pending_rqc: [] });
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await storeStockService.summary();
      setData(res.data.data);
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

  const availableColumns = [...COLUMNS, {
    key: "source", label: "Source",
    render: (r) => (
      <span className={r.source === "ERP" ? "text-emerald-600 dark:text-emerald-400 text-xs font-medium" : "text-slate-400 text-xs"}>
        {r.source}
      </span>
    ),
  }];

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800 dark:text-white">Store Stock</h2>
      <p className="text-xs text-slate-400 -mt-2">
        Available Store Stock is the only stock that can be used/issued. Pending RQC is visibility-only — waiting on RQC's own ERP.
      </p>

      <div className="card">
        <h3 className="font-semibold text-slate-800 dark:text-white mb-1 flex items-center gap-2">
          <Warehouse size={16} className="text-emerald-600" /> Available Store Stock
        </h3>
        <p className="text-xs text-slate-400 mb-3">Source: ERP-synced where available, internal ledger otherwise.</p>
        <Table columns={availableColumns} rows={data.available} loading={loading} emptyMessage="No available stock" />
      </div>

      <div className="card">
        <h3 className="font-semibold text-slate-800 dark:text-white mb-1 flex items-center gap-2">
          <ShieldAlert size={16} className="text-amber-600" /> Pending RQC Stock
        </h3>
        <p className="text-xs text-slate-400 mb-3">Received, awaiting RQC's own ERP clearance — cannot be issued.</p>
        <Table columns={COLUMNS} rows={data.pending_rqc} loading={loading} emptyMessage="No stock pending RQC" />
      </div>
    </div>
  );
}
