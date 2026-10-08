import React, { useEffect, useState } from "react";
import { Bookmark, BookmarkPlus, FileDown, LayoutGrid, X } from "lucide-react";
import { GAP_FILTERS } from "../../lib/inventory.js";

// Filters beside the status chips, saved views, and the bar that appears when
// rows are selected. All state lives in the page (and the URL); these only draw.

const select = "input-field py-1.5 text-[13px] w-auto min-w-[9rem] max-w-[14rem]";

export function InventoryFilters({ sections, types, section, type, gap, onChange, onClear, active }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label="Section" className={select} value={section}
        onChange={(e) => onChange("section", e.target.value)}>
        <option value="">All sections</option>
        {sections.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
      </select>
      <select aria-label="Part type" className={select} value={type}
        onChange={(e) => onChange("type", e.target.value)}>
        <option value="">All part types</option>
        {types.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.count})</option>)}
      </select>
      <select aria-label="Master-data gap" className={select} value={gap}
        onChange={(e) => onChange("gap", e.target.value)}>
        {GAP_FILTERS.map((g) => <option key={g.key || "any"} value={g.key}>{g.label}</option>)}
      </select>
      {active && (
        <button type="button" onClick={onClear}
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-toyotared">
          <X size={13} aria-hidden="true" /> Clear filters
        </button>
      )}
    </div>
  );
}

// Named filter sets, kept in this browser (a per-person convenience, not
// shared data). A view is just the URL's filter params.
const VIEWS_KEY = "dx_stock_views_v1";
const readViews = () => {
  try { return JSON.parse(localStorage.getItem(VIEWS_KEY) || "[]"); } catch { return []; }
};

export function SavedViews({ current, onApply, canSave }) {
  const [views, setViews] = useState(readViews);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  useEffect(() => {
    try { localStorage.setItem(VIEWS_KEY, JSON.stringify(views)); } catch { /* private mode */ }
  }, [views]);

  const save = () => {
    const n = name.trim();
    if (!n) return;
    setViews((vs) => [...vs.filter((v) => v.name !== n), { name: n, filters: current }]);
    setName(""); setNaming(false);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {views.length > 0 && <Bookmark size={13} className="text-slate-400" aria-hidden="true" />}
      {views.map((v) => (
        <span key={v.name} className="inline-flex items-center rounded-md border border-slate-200 text-xs dark:border-navy-700">
          <button type="button" onClick={() => onApply(v.filters)}
            className="px-2 py-1 text-slate-600 hover:text-toyotared dark:text-slate-300" title="Apply this saved view">
            {v.name}
          </button>
          <button type="button" aria-label={`Delete view ${v.name}`}
            onClick={() => setViews((vs) => vs.filter((x) => x.name !== v.name))}
            className="border-l border-slate-200 px-1.5 py-1 text-slate-400 hover:text-toyotared dark:border-navy-700">
            <X size={11} />
          </button>
        </span>
      ))}
      {canSave && (naming ? (
        <span className="inline-flex items-center gap-1">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="View name"
            onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setNaming(false); }}
            className="input-field w-36 py-1 text-xs" aria-label="Name for this view" />
          <button type="button" onClick={save} className="text-xs font-semibold text-toyotared">Save</button>
        </span>
      ) : (
        <button type="button" onClick={() => setNaming(true)}
          className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-toyotared">
          <BookmarkPlus size={13} aria-hidden="true" /> Save view
        </button>
      ))}
    </div>
  );
}

export function BulkBar({ count, onExport, onPrintBins, printing, canPrint, onClear }) {
  if (!count) return null;
  return (
    <div role="region" aria-label="Selected parts"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-toyotared/30 bg-toyotared/[0.05] px-3 py-2 text-sm">
      <span className="font-semibold text-slate-800 dark:text-white">{count.toLocaleString("en-IN")} selected</span>
      <button type="button" onClick={onExport} className="btn-secondary py-1 text-[13px]">
        <FileDown size={14} aria-hidden="true" /> Export selected
      </button>
      {canPrint && onPrintBins && (
        <button type="button" onClick={onPrintBins} disabled={printing || count > 300}
          title={count > 300 ? "Up to 300 parts per print job" : "Print one laminated QR sheet per bin — selected parts grouped by rack location"}
          className="btn-secondary py-1 text-[13px] disabled:opacity-40">
          <LayoutGrid size={14} aria-hidden="true" /> Bin sheets
        </button>
      )}
      <button type="button" onClick={onClear} className="ml-auto text-xs font-medium text-slate-500 hover:text-toyotared">
        Clear selection
      </button>
    </div>
  );
}
