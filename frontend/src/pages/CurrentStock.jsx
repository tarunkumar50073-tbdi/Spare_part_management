import React, { useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import Table from "../components/Table.jsx";
import { currentStockService } from "../services/currentStockService.js";

// Current Stock — ERP's real on-hand per item (closing + under-receiving +
// under-inspection). Read-only ERP mirror; populates once ERP exposes the
// Current Stock source table. This is the on-hand the ERP-vs-Physical gap
// reconciles against.
const fmtNum = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString());
const dash = (v) => v || "—";

const COLS = [
  { key: "group_cd", label: "Group", render: (r) => `${dash(r.group_cd)}${r.group_name ? ` · ${r.group_name}` : ""}`, searchValue: (r) => `${r.group_cd} ${r.group_name}` },
  { key: "item_cd", label: "Item", sortable: true },
  { key: "reference_code", label: "Reference" },
  { key: "item_desc", label: "Description", searchValue: (r) => r.item_desc },
  { key: "uom", label: "UOM" },
  { key: "closing_stock", label: "Closing", align: "right", sortable: true, render: (r) => fmtNum(r.closing_stock) },
  { key: "under_recv", label: "Under Recv", align: "right", sortable: true, render: (r) => fmtNum(r.under_recv) },
  { key: "under_insp", label: "Under Insp", align: "right", sortable: true, render: (r) => fmtNum(r.under_insp) },
  { key: "total", label: "Total", align: "right", sortable: true, render: (r) => fmtNum(r.total) },
];

export default function CurrentStock() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await currentStockService.list();
        if (alive) setRows(res.data.data || []);
      } catch {
        /* handled globally */
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
          <Boxes size={18} className="text-toyotared" /> Current Stock (ERP)
        </h2>
        <p className="text-xs text-slate-400 mt-0.5 max-w-3xl">
          ERP's real in-stock per item — closing stock plus what's under receiving and under inspection. Read-only;
          this populates once the ERP Current Stock source is connected.
        </p>
      </div>

      <div className="card">
        <Table
          columns={COLS}
          rows={rows}
          loading={loading}
          searchable="Search item / description / group…"
          pageSize={25}
          exportName="current_stock"
          emptyMessage="No current-stock rows yet — the ERP Current Stock source is not available yet"
        />
      </div>
    </div>
  );
}
