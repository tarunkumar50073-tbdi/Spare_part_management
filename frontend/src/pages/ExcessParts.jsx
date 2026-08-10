import React, { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { TrendingUp, Clock } from "lucide-react";
import Table from "../components/Table.jsx";
import { liveStockService } from "../services/liveStockService.js";

// Anchor the dashboard ticker's "N excess part(s)" chip links to, so that
// click lands on the full list rather than the Top 10 card above it.
const ALL_EXCESS_ANCHOR = "all-excess";

function daysInExcessBadge(days) {
  if (days == null) return <span className="text-slate-300 dark:text-slate-600">—</span>;
  let cls = "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"; // 1-7
  if (days > 15) cls = "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300";
  else if (days > 7) cls = "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-300";
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${cls}`}>{days} day(s)</span>;
}

// Parts that joined the list today — i.e. were not on yesterday's list —
// highlighted so they don't get lost among the ones sitting there for weeks.
// The server decides this off excess_since, which is cleared whenever a part
// drops out, so a part that was excess for a week, left, then came back today
// counts as added today rather than resuming its old run. Sky rather than the
// amber/orange/rose severity scale: "just added" is information, not a worse
// grade of excess.
const isNewlyExcess = (r) => r.added_today;
const NEW_ROW_CLASS = "bg-sky-50 dark:bg-sky-500/10";

const COLUMNS = [
  { key: "part_no", label: "Part No", sortable: true },
  { key: "part_name", label: "Part Name", sortable: true },
  { key: "category", label: "Category", sortable: true, render: (r) => r.category || "—" },
  { key: "sub_category", label: "Sub Category", sortable: true, render: (r) => r.sub_category || "—" },
  { key: "live_stock", label: "Live Stock", sortable: true, align: "right", render: (r) => r.live_stock ?? "—" },
  { key: "cov_days", label: "Coverage Day", sortable: true, align: "right", render: (r) => r.cov_days ?? "—" },
  {
    key: "excess_since", label: "Excess Since",
    sortable: true,
    exportValue: (r) => (r.excess_since ? new Date(r.excess_since).toLocaleString() : ""),
    render: (r) => (r.excess_since ? new Date(r.excess_since).toLocaleString() : "—"),
  },
  {
    key: "days_in_excess", label: "Days In Excess",
    sortable: true,
    exportValue: (r) => (r.days_in_excess == null ? "" : `${r.days_in_excess}${r.added_today ? " (new)" : ""}`),
    render: (r) => (
      <div className="flex items-center gap-1.5">
        {daysInExcessBadge(r.days_in_excess)}
        {isNewlyExcess(r) && (
          <span className="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">
            New
          </span>
        )}
      </div>
    ),
  },
];

export default function ExcessParts() {
  const [rows, setRows] = useState([]);
  const [topOldest, setTopOldest] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [res, top] = await Promise.all([
        liveStockService.excess(),
        liveStockService.topOldestExcess(),
      ]);
      setRows(res.data.data);
      setTopOldest(top.data.data);
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

  // Jump to the full list when arrived at via the anchor. Guarded by a ref
  // because the 30s auto-refresh flips `loading` again — without it the
  // page would yank itself back down every half minute.
  const { hash } = useLocation();
  const jumped = useRef(false);
  useEffect(() => {
    if (loading || jumped.current || hash !== `#${ALL_EXCESS_ANCHOR}`) return;
    jumped.current = true;
    document.getElementById(ALL_EXCESS_ANCHOR)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [loading, hash]);

  return (
    <div className="space-y-4">
      <h2 className="font-semibold text-slate-800 dark:text-white flex items-center gap-2">
        <TrendingUp size={18} className="text-amber-600" /> Excess Parts
      </h2>
      <p className="text-xs text-slate-400 -mt-2">
        Coverage Day above the excess threshold — sorted oldest-in-excess-first. Parts that joined the list today are
        highlighted; the rest show how many days they have been on it.
      </p>

      <div className="card border-l-4 border-amber-500">
        <div className="flex items-center gap-2 mb-3">
          <Clock size={16} className="text-amber-600" />
          <h3 className="font-semibold text-slate-800 dark:text-white">Top 10 Oldest Excess Parts</h3>
        </div>
        <Table
          columns={COLUMNS} rows={topOldest} loading={loading}
          rowClassName={(r) => (isNewlyExcess(r) ? NEW_ROW_CLASS : "")}
          emptyMessage="No excess parts right now"
        />
      </div>

      {/* scroll-mt clears the sticky 4rem Topbar when jumped to via the anchor */}
      <div id={ALL_EXCESS_ANCHOR} className="card scroll-mt-20">
        <h3 className="font-semibold text-slate-800 dark:text-white mb-3">All Excess Parts</h3>
        <Table
          columns={COLUMNS} rows={rows} loading={loading}
          rowClassName={(r) => (isNewlyExcess(r) ? NEW_ROW_CLASS : "")}
          searchable="Search part no or name…"
          exportName="excess_parts"
          pageSize={25}
          emptyMessage="No excess parts right now"
        />
      </div>
    </div>
  );
}
