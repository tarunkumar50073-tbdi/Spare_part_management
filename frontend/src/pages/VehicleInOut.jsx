import React, { useEffect, useState } from "react";
import { Truck, LogIn, LogOut } from "lucide-react";
import Table from "../components/Table.jsx";
import { gateService } from "../services/gateService.js";

// Vehicle In / Out — the gate register from the ERP mirror: material/vehicles in
// (Gate Entry) and out (Gate Exit). Read-only. Shows the most recent RECENT_LIMIT
// rows; use the search box to find a vendor / vehicle / item / challan.
const RECENT_LIMIT = 1000;
const fmtNum = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString());
const dash = (v) => v || "—";

const IN_COLS = [
  { key: "gate_entry_dt", label: "Date", sortable: true, render: (r) => dash(r.gate_entry_dt) },
  { key: "gate_entry_time", label: "Time" },
  { key: "gate_entry_no", label: "Gate Entry No", sortable: true },
  { key: "ven_cd", label: "Vendor", render: (r) => `${dash(r.ven_cd)}${r.ven_name ? ` · ${r.ven_name}` : ""}`, searchValue: (r) => `${r.ven_cd} ${r.ven_name}` },
  { key: "item_code", label: "Item", render: (r) => `${dash(r.item_code)}${r.item_desc ? ` · ${r.item_desc}` : ""}`, searchValue: (r) => `${r.item_code} ${r.item_desc}` },
  { key: "qty", label: "Qty", align: "right", sortable: true, render: (r) => fmtNum(r.qty) },
];

const OUT_COLS = [
  { key: "gate_exit_date", label: "Date", sortable: true, render: (r) => dash(r.gate_exit_date) },
  { key: "gate_exit_time", label: "Time" },
  { key: "gate_exit_number", label: "Gate Exit No", sortable: true },
  { key: "party_code", label: "Party", render: (r) => `${dash(r.party_code)}${r.party_name ? ` · ${r.party_name}` : ""}`, searchValue: (r) => `${r.party_code} ${r.party_name}` },
  { key: "vehicle_number", label: "Vehicle No", sortable: true },
  { key: "challan_number", label: "Challan" },
];

export default function VehicleInOut() {
  const [tab, setTab] = useState("in");
  const [entries, setEntries] = useState([]);
  const [exits, setExits] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const [en, ex] = await Promise.all([
          gateService.entries({ limit: RECENT_LIMIT }).then((r) => r.data.data).catch(() => []),
          gateService.exits({ limit: RECENT_LIMIT }).then((r) => r.data.data).catch(() => []),
        ]);
        if (!alive) return;
        setEntries(en || []);
        setExits(ex || []);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const tabs = [
    { key: "in", label: "Vehicle In", icon: LogIn, count: entries.length },
    { key: "out", label: "Vehicle Out", icon: LogOut, count: exits.length },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
          <Truck size={18} className="text-toyotared" /> Vehicle In / Out
        </h2>
        <p className="text-xs text-slate-400 mt-0.5 max-w-3xl">
          The gate register from the ERP mirror — vehicles/material in (Gate Entry) and out (Gate Exit). Read-only,
          most recent {RECENT_LIMIT.toLocaleString()} rows; search to find a vendor, vehicle, item or challan.
        </p>
      </div>

      <div className="flex gap-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key
                ? "bg-toyotared text-white"
                : "bg-slate-100 dark:bg-navy-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-navy-700"
            }`}
          >
            <t.icon size={15} /> {t.label}
            <span className="text-[11px] opacity-80">({loading ? "…" : t.count.toLocaleString()})</span>
          </button>
        ))}
      </div>

      <div className="card">
        {tab === "in" ? (
          <Table
            columns={IN_COLS}
            rows={entries}
            loading={loading}
            searchable="Search vendor / item / gate no…"
            pageSize={20}
            exportName="vehicle_in"
            emptyMessage="No gate entries yet — run ERP sync"
          />
        ) : (
          <Table
            columns={OUT_COLS}
            rows={exits}
            loading={loading}
            searchable="Search party / vehicle / challan…"
            pageSize={20}
            exportName="vehicle_out"
            emptyMessage="No gate exits — the ERP Gate Exit source is not available yet"
          />
        )}
      </div>
    </div>
  );
}
