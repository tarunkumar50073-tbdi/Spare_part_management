import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  Ban, CheckCircle2, ClipboardList, Clock3, FileCheck2, FileDown, FileWarning, Hourglass, Link2, Pencil, Plus,
  RefreshCw, Search, ShieldAlert, ShieldCheck, X, XCircle,
} from "lucide-react";
import KpiCard from "../../components/KpiCard.jsx";
import Modal from "../../components/Modal.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import { useCan } from "../../components/Can.jsx";
import SupplierPicker from "../../components/scan/forms/SupplierPicker.jsx";
import { NO_SUPPLIER, inputCls } from "../../components/scan/forms/flow.js";
import { useStores } from "../../context/StoreContext.jsx";
import { fmtDate, num } from "../../lib/format.js";
import { challanService, newRequestId } from "../../services/challanService.js";

// Urgent Challan Register — urgent spares that came in on a supplier's
// delivery challan before the PO was approved or the original invoice arrived
// (the store's spec, 21 Oct 2026: "Sometimes urgent spare parts are required
// before the Purchase Order (PO) has been approved ... the supplier sends the
// material against a delivery challan and provides the original invoice
// later"). It replaces the manual gate register for these challans.
//
// One screen: the tiles and the ageing of open challans, ONE filter bar, the
// register (paginated), and a challan's detail with its invoice / GRN links,
// its full history and the actions its state allows — Link Invoice to
// Challan, Link GRN, Edit, Cancel. "New urgent challan" is the Urgent Challan
// Entry form.
//
// A register only: saving a challan or linking an invoice never changes stock.
// Stock goes up only through the ERP GRN after quality, as before; a challan
// becomes GRN Completed when that GRN's quality has accepted it.

const STOCK_NOTE = "Registering a challan or linking an invoice never changes stock — stock comes only from the ERP GRN after quality.";
const STATUS_PILL = {
  "Pending Invoice": "badge-warning",
  "Invoice Received": "badge-info",
  "GRN Pending": "bg-violet-100 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300",
  "GRN Completed": "badge-success",
  Cancelled: "badge-neutral",
};
const QUALITY_PILL = { Pending: "badge-warning", OK: "badge-success", Rejected: "badge-danger" };
const PO_PILL = { "Pending Approval": "badge-warning", Approved: "badge-success", "Not Applicable": "badge-neutral" };
const ACTION_WORDS = {
  CREATED: "Challan registered", UPDATED: "Details changed", PO_UPDATED: "PO updated", INVOICE_LINKED: "Invoice linked",
  GRN_LINKED: "GRN linked", GRN_REFRESHED: "GRN read again from ERP", CANCELLED: "Cancelled",
};
// A status filter may be a comma list (the backend reads it so), so a tile opens
// exactly the lines it counts.
const OPEN = "Pending Invoice,Invoice Received,GRN Pending";
const AWAITING_GRN = "Invoice Received,GRN Pending";
const STATUS_GROUPS = [[OPEN, "All open"], [AWAITING_GRN, "Invoice received · GRN pending"]];
// The tiles; each sets the register's filter to what it counts.
const TILES = [
  { key: "total", label: "Total challans", icon: ClipboardList, tone: "navy", filter: {} },
  { key: "pending_invoice", label: "Pending invoice", icon: FileWarning, tone: "amber", filter: { status: "Pending Invoice" } },
  { key: "po_approval_pending", label: "PO approval pending", icon: Hourglass, tone: "amber", filter: { po_status: "Pending Approval", status: OPEN } },
  { key: "invoice_received_grn_pending", label: "Invoice in · GRN pending", icon: FileCheck2, tone: "blue", filter: { status: AWAITING_GRN } },
  { key: "quality_pending", label: "Quality pending", icon: ShieldAlert, tone: "violet", filter: { status: "GRN Pending", quality_status: "Pending" } },
  { key: "quality_rejected", label: "Quality rejected", icon: XCircle, tone: "red", filter: { quality_status: "Rejected", status: OPEN } },
  { key: "grn_completed", label: "GRN completed", icon: CheckCircle2, tone: "green", filter: { status: "GRN Completed" } },
  { key: "cancelled", label: "Cancelled", icon: Ban, tone: "navy", filter: { status: "Cancelled" } },
];
const FILTER_KEYS = ["from", "to", "supplier", "part", "po_status", "invoice_status", "status", "quality_status", "q"];
const PAGE_SIZE = 25;
const select = "input-field py-1.5 text-[13px]";

const errText = (e) => e?.response?.data?.message || e?.message || "Something went wrong";
const plural = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;
const Pill = ({ map, value }) => (value ? <span className={`badge ${map[value] || "badge-neutral"}`}>{value}</span> : <span className="text-slate-400">—</span>);

export default function ChallanRegister() {
  const { activeCode } = useStores();
  const canCreate = useCan("challan_register", "create");   // C: a new challan
  const canEdit = useCan("challan_register", "update");     // E: edit, invoice / GRN links, ERP refresh
  const canCancel = useCan("challan_register", "delete");   // D: cancel a challan
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => Object.fromEntries(FILTER_KEYS.map((k) => [k, params.get(k) || ""])), [params]);
  const page = Math.max(1, Number(params.get("page")) || 1);
  const [openId, setOpenId] = useState(null);
  const [entryOpen, setEntryOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const setFilter = (patch) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    next.delete("page");
    setParams(next, { replace: true });
  };
  const clearFilters = () => setParams(new URLSearchParams(), { replace: true });
  const goPage = (p) => {
    const next = new URLSearchParams(params);
    if (p > 1) next.set("page", String(p)); else next.delete("page");
    setParams(next, { replace: true });
  };

  const opts = useQuery({
    queryKey: ["challans", "options"],
    queryFn: () => challanService.options({ silent: true }).then((r) => r.data.data),
    staleTime: 10 * 60_000,
  });
  const query = { store_code: activeCode, ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v)) };
  const dash = useQuery({
    queryKey: ["challans", "dashboard", activeCode, filters.from, filters.to, filters.supplier, filters.part, filters.q],
    queryFn: () => challanService.dashboard({
      store_code: activeCode, from: filters.from || undefined, to: filters.to || undefined,
      supplier: filters.supplier || undefined, part: filters.part || undefined, q: filters.q || undefined,
    }, { silent: true }).then((r) => r.data.data),
    enabled: Boolean(activeCode),
  });
  const list = useQuery({
    queryKey: ["challans", "list", activeCode, filters, page],
    queryFn: () => challanService.list({ ...query, page, page_size: PAGE_SIZE }, { silent: true }).then((r) => r.data.data),
    enabled: Boolean(activeCode),
    placeholderData: keepPreviousData,
  });
  const reload = () => qc.invalidateQueries({ queryKey: ["challans"] });

  const refreshErp = async () => {
    setRefreshing(true);
    try {
      const r = await challanService.refreshGrn(activeCode);
      const n = r.data.data?.changed || 0;
      toast.success(n ? `${plural(n, "challan")} updated from the ERP GRN register` : "Nothing new in the ERP GRN register");
      reload();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setRefreshing(false);
    }
  };
  const exportExcel = () => challanService.exportExcel(query, `Urgent Challan Register.xlsx`).catch((e) => toast.error(errText(e)));

  const tiles = dash.data?.tiles;
  const filtered = FILTER_KEYS.some((k) => filters[k]);
  const data = list.data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-slate-800 dark:text-white">Urgent Challan Register</h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Urgent spares received on a supplier challan before the PO / invoice — link the invoice and the GRN when they come.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {canCreate && (
            <button type="button" className="btn-primary" onClick={() => setEntryOpen(true)}>
              <Plus size={15} aria-hidden="true" /> New urgent challan
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={exportExcel}>
            <FileDown size={15} aria-hidden="true" /> Excel
          </button>
          {canEdit && (
            <button type="button" className="btn-secondary" onClick={refreshErp} disabled={refreshing}
              title="Read the ERP GRN register again for the open challans">
              <RefreshCw size={15} aria-hidden="true" className={refreshing ? "animate-spin" : ""} /> Refresh from ERP GRN
            </button>
          )}
        </div>
      </div>

      <p className="flex items-start gap-2 rounded-lg bg-blue-50 px-3 py-2 text-[12px] text-blue-800 dark:bg-blue-500/10 dark:text-blue-200">
        <ShieldCheck size={15} aria-hidden="true" className="mt-0.5 shrink-0" /> {STOCK_NOTE}
      </p>

      {dash.isError ? (
        <ErrorState title="The challan dashboard did not load" message={errText(dash.error)} onRetry={() => dash.refetch()} />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {TILES.map((t) => (
            <KpiCard key={t.key} label={t.label} icon={t.icon} tone={tiles && tiles[t.key] ? t.tone : "navy"}
              value={tiles ? tiles[t.key] : undefined} loading={!tiles}
              onClick={() => setFilter({ status: "", po_status: "", quality_status: "", invoice_status: "", ...t.filter })} />
          ))}
        </div>
      )}

      {dash.data && (
        <div className="card flex flex-wrap items-center gap-x-4 gap-y-2 p-3 text-[12px]">
          <span className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-200">
            <Clock3 size={14} aria-hidden="true" /> Open challans by age
          </span>
          {dash.data.ageing.map((a, i) => (
            <span key={a.label} className={`badge ${["badge-success", "badge-warning", "badge-warning", "badge-danger"][i]}`}
              title={a.challan_ids.join(", ")}>
              {a.label}: {num(a.count)}
            </span>
          ))}
          {dash.data.oldest_open && (
            <span className="text-slate-500 dark:text-slate-400">
              Oldest: <button type="button" className="font-mono font-semibold text-toyotared underline-offset-2 hover:underline"
                onClick={() => setFilter({ q: dash.data.oldest_open.challan_id })}>{dash.data.oldest_open.challan_id}</button>
              {" "}· {plural(dash.data.oldest_open.days, "day")} · {dash.data.oldest_open.supplier} · {dash.data.oldest_open.part_no}
            </span>
          )}
        </div>
      )}

      <div className="card p-3 sm:p-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <label className="col-span-2 sm:col-span-3 lg:col-span-2">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500 dark:text-slate-400">Search</span>
            <span className="relative block">
              <Search size={14} aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input className={`${select} w-full pl-8`} value={filters.q} placeholder="Challan ID / no., invoice, GRN, PO…"
                onChange={(e) => setFilter({ q: e.target.value })} />
            </span>
          </label>
          <label>
            <span className="mb-1 block text-[11px] font-semibold text-slate-500 dark:text-slate-400">Received from</span>
            <input type="date" className={`${select} w-full`} value={filters.from} onChange={(e) => setFilter({ from: e.target.value })} />
          </label>
          <label>
            <span className="mb-1 block text-[11px] font-semibold text-slate-500 dark:text-slate-400">Received to</span>
            <input type="date" className={`${select} w-full`} value={filters.to} onChange={(e) => setFilter({ to: e.target.value })} />
          </label>
          <label>
            <span className="mb-1 block text-[11px] font-semibold text-slate-500 dark:text-slate-400">Supplier</span>
            <input className={`${select} w-full`} value={filters.supplier} placeholder="Name or code"
              onChange={(e) => setFilter({ supplier: e.target.value })} />
          </label>
          <label>
            <span className="mb-1 block text-[11px] font-semibold text-slate-500 dark:text-slate-400">Part No.</span>
            <input className={`${select} w-full`} value={filters.part} placeholder="Part No. or description"
              onChange={(e) => setFilter({ part: e.target.value })} />
          </label>
          {[
            ["po_status", "PO status", opts.data?.po_statuses],
            ["invoice_status", "Invoice status", opts.data?.invoice_statuses],
            ["status", "GRN status", opts.data?.statuses],
            ["quality_status", "Quality", opts.data?.quality_statuses],
          ].map(([key, label, choices]) => (
            <label key={key}>
              <span className="mb-1 block text-[11px] font-semibold text-slate-500 dark:text-slate-400">{label}</span>
              <select className={`${select} w-full`} value={filters[key]} onChange={(e) => setFilter({ [key]: e.target.value })}>
                <option value="">All</option>
                {key === "status" && STATUS_GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                {(choices || []).map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          ))}
        </div>
        {filtered && (
          <button type="button" onClick={clearFilters}
            className="mt-2 inline-flex items-center gap-1 text-[12px] font-semibold text-slate-500 hover:text-toyotared">
            <X size={13} aria-hidden="true" /> Clear filters
          </button>
        )}
      </div>

      <div className="card p-0">
        {list.isError ? (
          <div className="p-4"><ErrorState title="The register did not load" message={errText(list.error)} onRetry={() => list.refetch()} /></div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-left text-[12.5px]">
                <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
                  <tr>
                    {["Challan ID", "Challan no. / date", "Received", "Supplier", "Part", "Qty", "PO", "Invoice", "GRN", "Quality", "Status", "Days open"]
                      .map((h) => <th key={h} className="whitespace-nowrap px-3 py-2.5 font-semibold">{h}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                  {(data?.rows || []).map((r) => (
                    <tr key={r.id} onClick={() => setOpenId(r.id)} tabIndex={0}
                      onKeyDown={(e) => e.key === "Enter" && setOpenId(r.id)}
                      className="cursor-pointer align-top text-slate-700 hover:bg-slate-50 focus:bg-slate-50 focus:outline-none dark:text-slate-200 dark:hover:bg-navy-800/60 dark:focus:bg-navy-800/60">
                      <td className="whitespace-nowrap px-3 py-2.5 font-mono font-semibold text-slate-900 dark:text-white">{r.challan_id}</td>
                      <td className="px-3 py-2.5"><div className="font-semibold">{r.challan_no}</div><div className="text-[11px] text-slate-400">{fmtDate(r.challan_date)}</div></td>
                      <td className="whitespace-nowrap px-3 py-2.5">{fmtDate(r.receipt_date)}</td>
                      <td className="px-3 py-2.5"><div className="max-w-[180px] truncate" title={r.supplier_name}>{r.supplier_name}</div>{r.ven_cd && <div className="font-mono text-[11px] text-slate-400">{r.ven_cd}</div>}</td>
                      <td className="px-3 py-2.5"><div className="font-mono font-semibold">{r.part_no}</div><div className="max-w-[220px] truncate text-[11px] text-slate-400" title={r.part_description}>{r.part_description}</div></td>
                      <td className="whitespace-nowrap px-3 py-2.5 tabular">{num(r.challan_qty)} {r.unit_of_measure}</td>
                      <td className="px-3 py-2.5"><Pill map={PO_PILL} value={r.po_status} />{r.po_reference && <div className="mt-0.5 font-mono text-[11px] text-slate-400">{r.po_reference}</div>}</td>
                      <td className="px-3 py-2.5"><div className="max-w-[140px] truncate" title={r.invoice_no || ""}>{r.invoice_no || "—"}</div><div className="text-[11px] text-slate-400">{r.invoice_status}{r.invoice_status === "Pending" && r.invoiced_qty > 0 ? ` · ${num(r.invoiced_qty)} of ${num(r.challan_qty)}` : ""}</div></td>
                      <td className="max-w-[140px] truncate px-3 py-2.5" title={r.grn_reference || ""}>{r.grn_reference || "—"}</td>
                      <td className="px-3 py-2.5"><Pill map={QUALITY_PILL} value={r.quality_status} /></td>
                      <td className="px-3 py-2.5"><Pill map={STATUS_PILL} value={r.status} /></td>
                      <td className={`whitespace-nowrap px-3 py-2.5 tabular ${r.days_open > 30 ? "font-semibold text-rose-600 dark:text-rose-400" : ""}`}>{r.days_open == null ? "—" : num(r.days_open)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data && data.total === 0 && (
              <p className="px-4 py-10 text-center text-sm text-slate-400">
                {filtered ? "No challan matches these filters." : "No urgent challan registered yet."}
              </p>
            )}
            {data && data.total > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-2.5 text-[12px] text-slate-500 dark:border-navy-800 dark:text-slate-400">
                <span>{plural(data.total, "challan")} · page {data.page} of {data.pages}</span>
                <span className="flex gap-1.5">
                  <button type="button" className="btn-secondary px-2.5 py-1" disabled={data.page <= 1} onClick={() => goPage(data.page - 1)}>Previous</button>
                  <button type="button" className="btn-secondary px-2.5 py-1" disabled={data.page >= data.pages} onClick={() => goPage(data.page + 1)}>Next</button>
                </span>
              </div>
            )}
          </>
        )}
      </div>

      {entryOpen && (
        <EntryModal storeCode={activeCode} today={opts.data?.today} options={opts.data} onClose={() => setEntryOpen(false)}
          onSaved={(row) => { setEntryOpen(false); reload(); setOpenId(row.id); }} />
      )}
      {openId != null && (
        <DetailDrawer id={openId} canEdit={canEdit} canCancel={canCancel} options={opts.data} onClose={() => setOpenId(null)} onChanged={reload} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ the entry form */

function Field({ label, required, children, hint, error }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-semibold text-slate-600 dark:text-slate-300">
        {label}{required && <span className="text-toyotared"> *</span>}
      </span>
      {children}
      {error ? <span className="mt-1 block text-[11px] text-rose-600 dark:text-rose-400">{error}</span>
        : hint ? <span className="mt-1 block text-[11px] text-slate-400">{hint}</span> : null}
    </label>
  );
}

function PartSearch({ storeCode, part, onPick, error }) {
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const found = useQuery({
    queryKey: ["challans", "parts", storeCode, debounced],
    queryFn: () => challanService.parts(storeCode, debounced, { silent: true }).then((r) => r.data.data || []),
    enabled: Boolean(storeCode) && debounced.length >= 2 && !part,
  });
  if (part) {
    return (
      <div className="flex items-start justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-navy-700 dark:bg-navy-950/40">
        <div className="min-w-0 text-[12.5px]">
          <div className="font-mono font-bold text-slate-900 dark:text-white">{part.part_no}</div>
          <div className="text-slate-600 dark:text-slate-300">{part.part_name}</div>
          <div className="text-[11px] text-slate-400">{[part.uom && `UOM ${part.uom}`, part.location && `Bin ${part.location}`].filter(Boolean).join(" · ")}</div>
        </div>
        <button type="button" className="text-[12px] font-semibold text-toyotared" onClick={() => { onPick(null); setText(""); }}>Change</button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input className={inputCls(error, "w-full")} value={text} autoComplete="off" placeholder="Type a Part No. or description…"
        onChange={(e) => setText(e.target.value)} aria-label="Part No." />
      {debounced.length >= 2 && (
        <div className="absolute inset-x-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-cardHover dark:border-navy-700 dark:bg-navy-900">
          {found.isPending && <p className="px-3 py-2 text-[12px] text-slate-400">Searching…</p>}
          {found.data && found.data.length === 0 && <p className="px-3 py-2 text-[12px] text-slate-400">No part found in this store.</p>}
          {(found.data || []).map((p) => (
            <button key={p.id} type="button" onClick={() => onPick(p)}
              className="block w-full px-3 py-2 text-left text-[12.5px] hover:bg-slate-50 dark:hover:bg-navy-800">
              <span className="font-mono font-semibold text-slate-900 dark:text-white">{p.part_no}</span>
              <span className="ml-2 text-slate-500 dark:text-slate-400">{p.part_name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EntryModal({ storeCode, today, options, onClose, onSaved }) {
  const [requestId] = useState(newRequestId);
  const [part, setPart] = useState(null);
  const [supplier, setSupplier] = useState(NO_SUPPLIER);
  const [f, setF] = useState({
    challan_no: "", challan_date: today || "", receipt_date: today || "", gate_entry_no: "", challan_qty: "",
    unit_of_measure: "", po_reference: "", po_status: "Pending Approval", urgency_reason: "Breakdown", remarks: "",
  });
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  useEffect(() => {
    if (today) setF((x) => ({ ...x, challan_date: x.challan_date || today, receipt_date: x.receipt_date || today }));
  }, [today]);
  const pickPart = (p) => {
    setPart(p);
    setSupplier(NO_SUPPLIER);
    setF((x) => ({ ...x, unit_of_measure: p?.uom || "" }));
  };

  const qty = Number(f.challan_qty);
  const errors = {
    challan_no: !f.challan_no.trim() ? "Challan No. is required" : null,
    challan_date: !f.challan_date ? "Challan date is required" : today && f.challan_date > today ? "Cannot be in the future" : null,
    receipt_date: !f.receipt_date ? "Receipt date is required" : today && f.receipt_date > today ? "Cannot be in the future"
      : f.challan_date && f.receipt_date < f.challan_date ? "Cannot be before the challan date" : null,
    part: !part ? "Pick the part" : null,
    supplier: !supplier.supplier_source ? "Select the supplier" : supplier.supplier_source === "NAME_ONLY" && !supplier.ven_name.trim() ? "Write the supplier name" : null,
    challan_qty: !(qty > 0) ? "Enter a quantity more than 0" : Math.round(qty * 100) !== qty * 100 ? "At most 2 decimals" : null,
    po_reference: f.po_status === "Approved" && !f.po_reference.trim() ? "PO reference is required when the PO is approved" : null,
    remarks: f.urgency_reason === "Other" && !f.remarks.trim() ? "Write the reason when the urgency is Other" : null,
  };
  const show = (k) => (tried ? errors[k] : null);

  const save = async () => {
    setTried(true);
    setServerError(null);
    if (Object.values(errors).some(Boolean) || saving) return;
    setSaving(true);
    try {
      const r = await challanService.create({
        store_code: storeCode, request_id: requestId, part_id: part.id, challan_no: f.challan_no.trim(),
        challan_date: f.challan_date, receipt_date: f.receipt_date, gate_entry_no: f.gate_entry_no.trim() || null,
        supplier_source: supplier.supplier_source, supplier_id: supplier.supplier_id, ven_cd: supplier.ven_cd,
        supplier_name: supplier.ven_name, challan_qty: f.challan_qty, unit_of_measure: f.unit_of_measure || null,
        po_reference: f.po_reference.trim() || null, po_status: f.po_status, urgency_reason: f.urgency_reason,
        remarks: f.remarks.trim() || null,
      });
      const row = r.data.data;
      toast.success(row.replayed ? `${row.challan_id} was already saved` : `${row.challan_id} registered`);
      onSaved(row);
    } catch (e) {
      setServerError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Urgent Challan Entry" size="xl"
      footer={(
        <div className="flex w-full flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-slate-400">{STOCK_NOTE}</span>
          <span className="flex gap-2">
            <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
            <button type="button" className="btn-primary" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save challan"}</button>
          </span>
        </div>
      )}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Challan No." required error={show("challan_no")}>
          <input className={inputCls(show("challan_no"), "w-full")} maxLength={60} value={f.challan_no} onChange={set("challan_no")} />
        </Field>
        <Field label="Challan date" required error={show("challan_date")}>
          <input type="date" className={inputCls(show("challan_date"), "w-full")} max={today} value={f.challan_date} onChange={set("challan_date")} />
        </Field>
        <Field label="Received on" required error={show("receipt_date")}>
          <input type="date" className={inputCls(show("receipt_date"), "w-full")} max={today} value={f.receipt_date} onChange={set("receipt_date")} />
        </Field>
        <Field label="Gate entry no." hint="The gate register entry, if it has one">
          <input className={inputCls(false, "w-full")} maxLength={60} value={f.gate_entry_no} onChange={set("gate_entry_no")} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Part No." required error={show("part")}>
            <PartSearch storeCode={storeCode} part={part} onPick={pickPart} error={show("part")} />
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label="Supplier" required error={show("supplier")}>
            {part ? (
              <SupplierPicker partId={part.id} value={supplier} onChange={setSupplier} error={show("supplier")}
                load={challanService.supplierOptions} scope="challan" />
            ) : <p className="text-[12px] text-slate-400">Pick the part first — its ERP vendors are listed first.</p>}
          </Field>
        </div>
        <Field label="Received quantity" required error={show("challan_qty")}>
          <input type="number" min="0" step="0.01" inputMode="decimal" className={inputCls(show("challan_qty"), "w-full")}
            value={f.challan_qty} onChange={set("challan_qty")} />
        </Field>
        <Field label="Unit">
          <input className={inputCls(false, "w-full")} maxLength={20} value={f.unit_of_measure} onChange={set("unit_of_measure")} />
        </Field>
        <Field label="PO status" required>
          <select className={inputCls(false, "w-full")} value={f.po_status} onChange={set("po_status")}>
            {(options?.po_statuses || ["Pending Approval", "Approved", "Not Applicable"]).map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="PO reference" required={f.po_status === "Approved"} error={show("po_reference")}>
          <input className={inputCls(show("po_reference"), "w-full")} maxLength={60} value={f.po_reference} onChange={set("po_reference")}
            placeholder={f.po_status === "Pending Approval" ? "PR / PO no., if known" : ""} />
        </Field>
        <Field label="Urgency reason" required>
          <select className={inputCls(false, "w-full")} value={f.urgency_reason} onChange={set("urgency_reason")}>
            {(options?.urgency_reasons || ["Production Critical", "Breakdown", "Other"]).map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Remarks" required={f.urgency_reason === "Other"} error={show("remarks")}>
          <input className={inputCls(show("remarks"), "w-full")} maxLength={255} value={f.remarks} onChange={set("remarks")} />
        </Field>
      </div>
      {serverError && (
        <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{serverError}</p>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------ one challan */

function Fact({ label, children }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-0.5 break-words text-[13px] text-slate-800 dark:text-slate-100">{children || "—"}</dd>
    </div>
  );
}

function DetailDrawer({ id, canEdit, canCancel, options, onClose, onChanged }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["challans", "one", id],
    queryFn: () => challanService.get(id, { silent: true }).then((r) => r.data.data),
  });
  const [dialog, setDialog] = useState(null);            // {kind, link?}
  const done = (row, message) => {
    if (message) toast.success(message);
    qc.setQueryData(["challans", "one", id], row);
    setDialog(null);
    onChanged();
  };
  const c = q.data;

  return (
    <Modal open onClose={onClose} variant="drawer" size="xl" title={c ? `${c.challan_id} · ${c.challan_no}` : "Challan"}>
      {q.isError && <ErrorState title="This challan did not load" message={errText(q.error)} onRetry={() => q.refetch()} />}
      {!c && !q.isError && <p className="text-sm text-slate-400">Loading…</p>}
      {c && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <Pill map={STATUS_PILL} value={c.status} />
            <span className="text-[12px] text-slate-500 dark:text-slate-400">Quality</span><Pill map={QUALITY_PILL} value={c.quality_status} />
            <span className="text-[12px] text-slate-500 dark:text-slate-400">PO</span><Pill map={PO_PILL} value={c.po_status} />
          </div>
          {(canEdit || canCancel) && (
            <div className="flex flex-wrap gap-2">
              {canEdit && c.can.link_invoice && (
                <button type="button" className="btn-primary" onClick={() => setDialog({ kind: "invoice" })}>
                  <Link2 size={15} aria-hidden="true" /> Link Invoice to Challan
                </button>
              )}
              {canEdit && c.can.edit && (
                <button type="button" className="btn-secondary" onClick={() => setDialog({ kind: "edit" })}>
                  <Pencil size={15} aria-hidden="true" /> Edit
                </button>
              )}
              {canCancel && c.can.cancel && (
                <button type="button" className="btn-danger" onClick={() => setDialog({ kind: "cancel" })}>
                  <Ban size={15} aria-hidden="true" /> Cancel challan
                </button>
              )}
            </div>
          )}
          <p className="text-[11px] text-slate-400">{STOCK_NOTE}</p>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
            <Fact label="Challan no.">{c.challan_no}</Fact>
            <Fact label="Challan date">{fmtDate(c.challan_date)}</Fact>
            <Fact label="Received on">{fmtDate(c.receipt_date)}</Fact>
            <Fact label="Supplier">{c.supplier_name}{c.ven_cd ? ` · ${c.ven_cd}` : ""}</Fact>
            <Fact label="Part">{c.part_no} — {c.part_description}</Fact>
            <Fact label="Quantity">{num(c.challan_qty)} {c.unit_of_measure}</Fact>
            <Fact label="Invoiced">{num(c.invoiced_qty)} of {num(c.challan_qty)}{c.remaining_to_invoice > 0 && c.status !== "Cancelled" ? ` · ${num(c.remaining_to_invoice)} left` : ""}</Fact>
            <Fact label="PO reference">{c.po_reference}</Fact>
            <Fact label="Urgency">{c.urgency_reason}</Fact>
            <Fact label="Gate entry no.">{c.gate_entry_no}</Fact>
            <Fact label="Days open">{c.days_open == null ? null : num(c.days_open)}</Fact>
            <Fact label="Registered by">{c.created_by}</Fact>
            {c.remarks && <div className="col-span-2 sm:col-span-3"><Fact label="Remarks">{c.remarks}</Fact></div>}
            {c.status === "Cancelled" && (
              <div className="col-span-2 sm:col-span-3"><Fact label="Cancelled">{c.cancel_reason} — {c.cancelled_by}, {fmtDate(c.cancelled_at)}</Fact></div>
            )}
          </dl>

          <section>
            <h3 className="mb-2 text-[13px] font-bold text-slate-800 dark:text-white">Invoices and GRNs</h3>
            {c.links.length === 0 ? (
              <p className="text-[12px] text-slate-400">No invoice linked yet.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-200 dark:border-navy-700">
                <table className="w-full min-w-[620px] text-left text-[12.5px]">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
                    <tr>{["Invoice", "Qty", "GRN", "Accepted / rejected", "Quality", ""].map((h) => <th key={h} className="px-3 py-2 font-semibold">{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
                    {c.links.map((l) => (
                      <tr key={l.id} className="align-top text-slate-700 dark:text-slate-200">
                        <td className="px-3 py-2"><div className="font-semibold">{l.invoice_no}</div><div className="text-[11px] text-slate-400">{fmtDate(l.invoice_date)} · {l.linked_by}</div></td>
                        <td className="px-3 py-2 tabular">{num(l.invoice_qty)}</td>
                        <td className="px-3 py-2">{l.grn_reference ? <><div className="font-semibold">{l.grn_reference}</div><div className="text-[11px] text-slate-400">{l.grn_date ? fmtDate(l.grn_date) : "date not given"} · {l.grn_from_erp ? "ERP GRN register" : "typed — waiting for ERP"}</div></> : "—"}</td>
                        <td className="px-3 py-2 tabular">{l.grn_reference ? `${l.grn_accepted_qty == null ? "—" : num(l.grn_accepted_qty)} / ${l.grn_rejected_qty == null ? "—" : num(l.grn_rejected_qty)}` : "—"}</td>
                        <td className="px-3 py-2">{l.grn_reference ? <Pill map={QUALITY_PILL} value={l.quality_status} /> : "—"}</td>
                        <td className="px-3 py-2 text-right">
                          {canEdit && c.status !== "Cancelled" && !l.grn_from_erp && (
                            <button type="button" className="text-[12px] font-semibold text-toyotared hover:underline"
                              onClick={() => setDialog({ kind: "grn", link: l })}>{l.grn_reference ? "Change GRN" : "Link GRN"}</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-[13px] font-bold text-slate-800 dark:text-white">History</h3>
            <ol className="space-y-2 border-l-2 border-slate-200 pl-4 dark:border-navy-700">
              {c.history.slice().reverse().map((h) => (
                <li key={h.id} className="relative text-[12.5px]">
                  <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-toyotared ring-2 ring-white dark:ring-navy-900" aria-hidden="true" />
                  <div className="font-semibold text-slate-800 dark:text-slate-100">
                    {ACTION_WORDS[h.action] || h.action}
                    {h.from_status && h.to_status && h.from_status !== h.to_status && (
                      <span className="ml-1.5 font-normal text-slate-500 dark:text-slate-400">· {h.from_status} → {h.to_status}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400">{h.by} · {h.at ? new Date(h.at).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : ""}</div>
                  {h.details && <HistoryDetails details={h.details} />}
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}

      {c && dialog?.kind === "invoice" && <InvoiceDialog c={c} options={options} onClose={() => setDialog(null)} onDone={done} />}
      {c && dialog?.kind === "grn" && <GrnDialog c={c} link={dialog.link} onClose={() => setDialog(null)} onDone={done} />}
      {c && dialog?.kind === "edit" && <EditDialog c={c} options={options} onClose={() => setDialog(null)} onDone={done} />}
      {c && dialog?.kind === "cancel" && <CancelDialog c={c} onClose={() => setDialog(null)} onDone={done} />}
    </Modal>
  );
}

function HistoryDetails({ details }) {
  const bits = Object.entries(details).filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length));
  if (!bits.length) return null;
  const show = (v) => (typeof v === "object" ? (Array.isArray(v) ? v.map((x) => (typeof x === "object" ? Object.values(x).join(" ") : x)).join(", ")
    : Object.entries(v).map(([k, x]) => `${k}: ${typeof x === "object" && x ? `${x.from ?? "—"} → ${x.to ?? "—"}` : x}`).join("; ")) : String(v));
  return (
    <div className="mt-0.5 text-[11.5px] text-slate-500 dark:text-slate-400">
      {bits.map(([k, v]) => <span key={k} className="mr-3"><span className="text-slate-400">{k.replace(/_/g, " ")}:</span> {show(v)}</span>)}
    </div>
  );
}

function Verify({ c }) {
  return (
    <div className="mb-3 grid grid-cols-2 gap-2 rounded-lg bg-slate-50 p-3 text-[12px] dark:bg-navy-950/40 sm:grid-cols-4">
      <Fact label="Supplier">{c.supplier_name}{c.ven_cd ? ` · ${c.ven_cd}` : ""}</Fact>
      <Fact label="Part">{c.part_no}</Fact>
      <Fact label="Challan qty">{num(c.challan_qty)} {c.unit_of_measure}</Fact>
      <Fact label="PO">{c.po_status}{c.po_reference ? ` · ${c.po_reference}` : ""}</Fact>
    </div>
  );
}

function useSubmit(onDone) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const run = async (call, message) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const r = await call();
      onDone(r.data.data, typeof message === "function" ? message(r.data.data) : message);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, run };
}

const ErrorLine = ({ error }) => (error ? (
  <p role="alert" className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-[12.5px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{error}</p>
) : null);

function DialogFooter({ onClose, onSave, saving, disabled = false, label }) {
  return (
    <div className="flex w-full justify-end gap-2">
      <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
      <button type="button" className="btn-primary" onClick={onSave} disabled={saving || disabled}>{saving ? "Saving…" : label}</button>
    </div>
  );
}

function InvoiceDialog({ c, options, onClose, onDone }) {
  const [requestId] = useState(newRequestId);
  const [f, setF] = useState({
    invoice_no: "", invoice_date: options?.today || "", invoice_qty: String(c.remaining_to_invoice ?? ""),
    // A supplier invoices only against a PO, so the invoice brings its PO no.
    // (the store, 21 Oct 2026) — the PO is never left Pending Approval here.
    po_status: c.po_status === "Pending Approval" ? "Approved" : c.po_status, po_reference: c.po_reference || "",
  });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const { saving, error, run } = useSubmit(onDone);
  const needsPo = f.po_status === "Approved" && !f.po_reference.trim();
  const save = () => run(() => challanService.linkInvoice(c.id, {
    invoice_no: f.invoice_no.trim(), invoice_date: f.invoice_date, invoice_qty: f.invoice_qty,
    po_status: f.po_status, po_reference: f.po_reference.trim() || null, request_id: requestId,
  }), (row) => (row.invoice_also_on?.length ? `Invoice linked — the same invoice is also on ${row.invoice_also_on.join(", ")}` : "Invoice linked"));
  return (
    <Modal open onClose={onClose} title={`Link Invoice to Challan · ${c.challan_id}`}
      footer={<DialogFooter onClose={onClose} onSave={save} saving={saving} disabled={!f.invoice_no.trim() || needsPo} label="Link invoice" />}>
      <p className="mb-2 text-[12px] text-slate-500 dark:text-slate-400">Check these against the original invoice before linking it:</p>
      <Verify c={c} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Invoice No." required><input className={inputCls(false, "w-full")} maxLength={60} value={f.invoice_no} onChange={set("invoice_no")} /></Field>
        <Field label="Invoice date" required><input type="date" className={inputCls(false, "w-full")} max={options?.today} value={f.invoice_date} onChange={set("invoice_date")} /></Field>
        <Field label="Quantity on this invoice" required hint={`${num(c.remaining_to_invoice)} ${c.unit_of_measure || ""} left to invoice — never more`}>
          <input type="number" min="0" step="0.01" className={inputCls(false, "w-full")} value={f.invoice_qty} onChange={set("invoice_qty")} />
        </Field>
        <Field label="PO status" hint="The supplier invoices only against a PO — so it cannot stay Pending Approval">
          <select className={inputCls(false, "w-full")} value={f.po_status} onChange={set("po_status")}>
            {(options?.po_statuses || ["Approved", "Not Applicable"]).filter((s) => s !== "Pending Approval")
              .map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="PO No. (as on the invoice)" required={f.po_status === "Approved"}>
          <input className={inputCls(false, "w-full")} maxLength={60} value={f.po_reference} onChange={set("po_reference")} />
        </Field>
      </div>
      <p className="mt-3 text-[11px] text-slate-400">The GRN and its quality stay as in ERP — link the GRN here once it is made. {STOCK_NOTE}</p>
      <ErrorLine error={error} />
    </Modal>
  );
}

function GrnDialog({ c, link, onClose, onDone }) {
  const cands = useQuery({
    queryKey: ["challans", "grn-candidates", c.id],
    queryFn: () => challanService.grnCandidates(c.id, { silent: true }).then((r) => r.data.data || []),
  });
  const [pick, setPick] = useState(null);
  const [typed, setTyped] = useState({ grn_no: "", grn_date: "" });
  const { saving, error, run } = useSubmit(onDone);
  const save = () => run(() => challanService.linkGrn(c.id, link.id, pick != null
    ? { receiving_register_id: pick }
    : { grn_no: typed.grn_no.trim(), grn_date: typed.grn_date || null }), "GRN linked");
  return (
    <Modal open onClose={onClose} size="xl" title={`Link GRN · invoice ${link.invoice_no}`}
      footer={<DialogFooter onClose={onClose} onSave={save} saving={saving} disabled={pick == null && !typed.grn_no.trim()} label="Link GRN" />}>
      <Verify c={c} />
      <h4 className="mb-1.5 text-[12.5px] font-bold text-slate-700 dark:text-slate-200">GRNs in the ERP GRN register for {c.part_no}</h4>
      {cands.isPending && <p className="text-[12px] text-slate-400">Loading…</p>}
      {cands.data && cands.data.length === 0 && (
        <p className="text-[12px] text-slate-400">None yet — ERP may not have it (or is not reachable). Type the GRN No. below; its quality is read when ERP has it.</p>
      )}
      {cands.data && cands.data.length > 0 && (
        <div className="max-h-64 space-y-1.5 overflow-y-auto">
          {cands.data.map((g) => (
            <label key={g.id} className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] ${g.linked_here ? "cursor-not-allowed opacity-60" : "cursor-pointer"} ${pick === g.id ? "border-toyotared bg-rose-50/60 dark:bg-toyotared/10" : "border-slate-200 dark:border-navy-700"}`}>
              <input type="radio" name="grn" className="mt-1" checked={pick === g.id} disabled={g.linked_here}
                onChange={() => { setPick(g.id); setTyped({ grn_no: "", grn_date: "" }); }} />
              <span className="min-w-0">
                <span className="font-semibold text-slate-900 dark:text-white">{g.grn_no}</span>
                <span className="ml-2 text-slate-500 dark:text-slate-400">{fmtDate(g.grn_date)} · {g.ven_name || g.ven_cd}</span>
                {g.matches_challan_no && <span className="badge badge-success ml-2">Names this challan</span>}
                {g.linked_here && <span className="badge badge-neutral ml-2">Already on this challan</span>}
                <span className="block text-[11px] text-slate-400">
                  Challan {g.challan_no || "—"} · received {num(g.receipt_qty)} · accepted {g.accept_qty == null ? "—" : num(g.accept_qty)} · rejected {g.reject_qty == null ? "—" : num(g.reject_qty)} · {g.quality}
                </span>
              </span>
            </label>
          ))}
        </div>
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Or type the GRN No." hint="While ERP is not reachable — quality stays pending until ERP has this GRN">
          <input className={inputCls(false, "w-full")} maxLength={60} value={typed.grn_no}
            onChange={(e) => { setTyped((x) => ({ ...x, grn_no: e.target.value })); setPick(null); }} />
        </Field>
        <Field label="GRN date">
          <input type="date" className={inputCls(false, "w-full")} value={typed.grn_date} onChange={(e) => setTyped((x) => ({ ...x, grn_date: e.target.value }))} />
        </Field>
      </div>
      <ErrorLine error={error} />
    </Modal>
  );
}

function EditDialog({ c, options, onClose, onDone }) {
  const [f, setF] = useState({
    po_status: c.po_status, po_reference: c.po_reference || "", urgency_reason: c.urgency_reason,
    gate_entry_no: c.gate_entry_no || "", remarks: c.remarks || "", challan_qty: String(c.challan_qty),
  });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const { saving, error, run } = useSubmit(onDone);
  const save = () => {
    const payload = {
      po_status: f.po_status, po_reference: f.po_reference.trim() || null, urgency_reason: f.urgency_reason,
      gate_entry_no: f.gate_entry_no.trim() || null, remarks: f.remarks.trim() || null,
    };
    if (!c.links.length && Number(f.challan_qty) !== c.challan_qty) payload.challan_qty = f.challan_qty;
    run(() => challanService.update(c.id, payload), "Challan updated");
  };
  return (
    <Modal open onClose={onClose} title={`Edit · ${c.challan_id}`}
      footer={<DialogFooter onClose={onClose} onSave={save} saving={saving} label="Save" />}>
      <p className="mb-3 text-[11px] text-slate-400">Supplier, part and challan no. stay as registered — if one is wrong, cancel this challan and enter it again. Every change is kept in the history.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="PO status" hint={c.links.length ? "Invoiced against a PO — cannot go back to Pending Approval" : undefined}>
          <select className={inputCls(false, "w-full")} value={f.po_status} onChange={set("po_status")}>
            {(options?.po_statuses || [c.po_status]).filter((s) => !(c.links.length && s === "Pending Approval"))
              .map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="PO reference" required={f.po_status === "Approved"}><input className={inputCls(false, "w-full")} maxLength={60} value={f.po_reference} onChange={set("po_reference")} /></Field>
        <Field label="Urgency reason">
          <select className={inputCls(false, "w-full")} value={f.urgency_reason} onChange={set("urgency_reason")}>
            {(options?.urgency_reasons || [c.urgency_reason]).map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Gate entry no."><input className={inputCls(false, "w-full")} maxLength={60} value={f.gate_entry_no} onChange={set("gate_entry_no")} /></Field>
        <Field label="Received quantity" hint={c.links.length ? "Fixed once an invoice is linked" : undefined}>
          <input type="number" min="0" step="0.01" className={inputCls(false, "w-full")} disabled={c.links.length > 0} value={f.challan_qty} onChange={set("challan_qty")} />
        </Field>
        <Field label="Remarks" required={f.urgency_reason === "Other"}><input className={inputCls(false, "w-full")} maxLength={255} value={f.remarks} onChange={set("remarks")} /></Field>
      </div>
      <ErrorLine error={error} />
    </Modal>
  );
}

function CancelDialog({ c, onClose, onDone }) {
  const [reason, setReason] = useState("");
  const { saving, error, run } = useSubmit(onDone);
  const save = () => run(() => challanService.cancel(c.id, reason.trim()), `${c.challan_id} cancelled`);
  return (
    <Modal open onClose={onClose} title={`Cancel ${c.challan_id}?`}
      footer={(
        <div className="flex w-full justify-end gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>Keep it</button>
          <button type="button" className="btn-danger" onClick={save} disabled={saving || !reason.trim()}>{saving ? "Cancelling…" : "Cancel challan"}</button>
        </div>
      )}>
      <p className="mb-3 text-[12.5px] text-slate-600 dark:text-slate-300">
        The challan stays in the register as Cancelled, with its history — nothing is deleted, and no stock changes.
        {c.links.some((l) => l.grn_reference) ? " Its GRN is freed, so the right challan can take it." : ""}
      </p>
      <Field label="Reason" required>
        <input className={inputCls(false, "w-full")} maxLength={255} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
      <ErrorLine error={error} />
    </Modal>
  );
}
