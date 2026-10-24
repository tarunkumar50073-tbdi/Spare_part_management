import React, { useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  ChevronRight, CircleCheck, CircleDashed, CircleDot, ClipboardCheck, Database, FileCheck2, FileText, Hourglass, Lock,
  PackageCheck, PackagePlus, RefreshCw, ShieldCheck, Truck, TriangleAlert, Workflow, X,
} from "lucide-react";
import CardHead from "../../components/CardHead.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import KpiCard from "../../components/KpiCard.jsx";
import Table from "../../components/Table.jsx";
import { useCan } from "../../components/Can.jsx";
import { useConfirm } from "../../components/ConfirmDialog.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { usePartDrawer } from "../../context/PartDrawerContext.jsx";
import { receivingMonitorService } from "../../services/receivingMonitorService.js";
import { erpFreshness, erpGrnService } from "../../services/erpGrnService.js";
import { erpLineMeta as lineState } from "../../lib/scanStatus.js";
import { fmtDate, fmtStamp, num, parseServerTime } from "../../lib/format.js";

const WINDOWS = [30, 90, 180];
// Spec 1: spare receiving is ONE flow — gate, GRN, quality, stock — and all of
// it happens in ERP. The app reads it: the "ERP GRN → Store stock" section on
// top lists every GRN line with what the app does with it; these tabs keep the
// raw sources (the GRN register, the ledger's stock-ins, the SRV register, gate
// arrivals) as references.
const TABS = [
  { key: "grn", label: "ERP GRN register" },
  { key: "receipts", label: "Added to stock" },
  { key: "srv", label: "ERP inbound register" },
  { key: "gate", label: "At gate, no GRN yet" },
];

// Ledger RECEIPT rows whose stock-in happened in ERP (ERP_ORIGIN_RECEIPT_STATUSES,
// models/spare_stock.py) — the app never pushes them, so "Not pushed" would be
// the wrong word. ERP_GRN rows are the ones the app adds from the ERP GRN
// register; the other two were recorded in the app before receiving moved to ERP.
const ERP_ORIGIN = {
  ERP_GRN: "Accepted in ERP — added from the ERP GRN",
  STOCK_AVAILABLE: "Quality cleared (recorded in the app)",
  RGP_GRN: "RGP GRN — back from rework",
};
const ERP_ORIGIN_NOTE = {
  ERP_GRN: "Read from ERP: quality accepted this qty on the ERP GRN (Reference = GRN no.), and the app added it to store stock once. Nothing for the app to push.",
  STOCK_AVAILABLE: "Recorded in the app before receiving moved to ERP: the stock came in through the ERP GRN the supervisor recorded (GRN no. under Reference). Nothing for the app to push.",
  RGP_GRN: "Reworked material back through its RGP GRN (RGP no. under Reference). Nothing for the app to push.",
};
const isErpOrigin = (r) => Boolean(r.erp_origin || ERP_ORIGIN[r.status]);

const count = (n, word) => `${num(n)} ${word}${n === 1 ? "" : "s"}`;

const LEDGER_WORDS = { OPENING: "opening count", ISSUE: "issue", RETURN: "return", ADJUSTMENT: "adjustment" };

const dash = <span className="text-slate-300 dark:text-slate-600">—</span>;

// Exports carry the same local time the table shows, with the year — never the
// raw UTC string the API sends.
const localStamp = (iso) => {
  const d = parseServerTime(iso);
  if (!d) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// Today as the date input wants it, on the plant clock.
const todayIso = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// Age past 3 days is worth a look, past 7 it is late — for a line still
// waiting. `muted` is for a finished event (a GRN, a stock-in, a closed
// inbound line): its age is history, not a delay.
function Age({ days, muted = false }) {
  if (days == null) return dash;
  const tone = muted
    ? "bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-slate-400"
    : days > 7
      ? "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300"
      : days > 3
        ? "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300"
        : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300";
  return (
    <span className={`inline-block min-w-[2.75rem] rounded-full px-2 py-0.5 text-center text-[11px] font-semibold tabular ${tone}`}>
      {days} d
    </span>
  );
}

const Chip = ({ tone = "neutral", children, title }) => {
  const tones = {
    neutral: "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300",
    green: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300",
    amber: "bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300",
    red: "bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300",
    blue: "bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300",
  };
  return (
    <span title={title} className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${tones[tone]}`}>
      {children}
    </span>
  );
};

const CHECK_TONE = { OK: "green", SHORT: "amber", EXCESS: "amber", DAMAGED: "red" };
const PIPELINE_TONE = {
  "Verification Pending": "amber", Created: "blue", "Engineer Pending": "amber",
  Approved: "green", Rejected: "red", "ERP Updated": "green",
};

const partCol = {
  key: "part_no", label: "Part", sortable: true,
  searchValue: (r) => `${r.part_no} ${r.part_name || ""}`,
  exportValue: (r) => `${r.part_no}${r.part_name ? ` ${r.part_name}` : ""}`,
  render: (r) => (
    <div className="min-w-0">
      <div className="font-medium text-slate-800 dark:text-white">{r.part_no}</div>
      <div className="max-w-[220px] truncate text-[11px] text-slate-400">{r.part_name}</div>
    </div>
  ),
};
const sectionCol = { key: "section", label: "Section", sortable: true, render: (r) => r.section || dash };
const qtyCol = (key, label) => ({
  key, label, align: "right", sortable: true, render: (r) => (r[key] == null ? dash : num(r[key])),
});
// ERP's accepted qty. It stays empty until the quality clearance is done in
// ERP, so an empty cell reads "not yet" (and exports empty) — the received qty
// never stands in for it. A line rejected with nothing accepted is not
// pending: it shows no accepted qty at all.
const acceptCol = {
  key: "accept_qty", label: "Accepted", align: "right", sortable: true,
  exportValue: (r) => r.accept_qty ?? "",
  render: (r) => (r.accept_qty != null
    ? <span className="font-semibold text-slate-800 dark:text-white">{num(r.accept_qty)}</span>
    : Number(r.reject_qty) > 0
      ? <span title="ERP shows no accepted qty — rejected by quality in ERP">{dash}</span>
      : <span className="text-[11px] text-slate-400" title="ERP has no accepted qty on this GRN yet — quality clearance pending in ERP">not yet</span>),
};

// ---- ERP GRN -> store stock (ErpGrnPostingService lines) --------------------

// The states of an ERP GRN line (one per part and GRN no.; labels and badges
// from lib/scanStatus.js ERP_LINE_STATE), in the order a line is read: waiting
// on ERP's quality, about to be added, needs a look, done, and the ones the
// app leaves alone.
const LINE_STATES = ["QUALITY_PENDING", "WILL_POST", "CHECK", "POSTED", "REJECTED", "SKIPPED", "OFF"];
const lineKey = (r) => `${r.part_id}|${r.grn_no}`;

// Every screen reading the ERP GRN lines shares one cached read under the
// "stock" key, so a posting (the SSE "stock" event) refreshes all of them.
const useErpGrnPreview = (code) => useQuery({
  queryKey: ["stock", "erp-grn", code],
  queryFn: () => erpGrnService.preview(code, { silent: true }).then((r) => r.data.data),
});

const LINE_COLUMNS = [
  partCol,
  {
    key: "grn_no", label: "GRN no · date", sortable: true,
    sortValue: (r) => `${r.grn_date || ""} ${r.grn_no || ""}`,
    searchValue: (r) => `${r.grn_no || ""} ${r.invoice_no || ""}`,
    exportValue: (r) => `${r.grn_no || ""}${r.grn_date ? ` (${r.grn_date})` : ""}`,
    render: (r) => (
      <div>
        <div className="font-mono text-[12px] font-semibold text-slate-800 dark:text-slate-100">{r.grn_no || "—"}</div>
        <div className="text-[11px] text-slate-400">{r.grn_date ? fmtDate(r.grn_date) : "no GRN date in ERP"}</div>
      </div>
    ),
  },
  {
    key: "ven_name", label: "Supplier", sortable: true,
    searchValue: (r) => `${r.ven_name || ""} ${r.ven_cd || ""}`,
    exportValue: (r) => [r.ven_name, r.ven_cd].filter(Boolean).join(" "),
    render: (r) => (r.ven_name || r.ven_cd ? (
      <div className="min-w-0">
        <div className="max-w-[200px] truncate text-slate-700 dark:text-slate-200">{r.ven_name || r.ven_cd}</div>
        {/* ERP's own vendor code — absent means ERP gave none. */}
        {r.ven_name && r.ven_cd && <div className="font-mono text-[11px] text-slate-400">{r.ven_cd}</div>}
      </div>
    ) : dash),
  },
  qtyCol("receipt_qty", "Received"),
  acceptCol,
  {
    key: "reject_qty", label: "Rejected", align: "right", sortable: true,
    exportValue: (r) => r.reject_qty ?? "",
    render: (r) => (r.reject_qty == null ? dash
      : Number(r.reject_qty) > 0
        ? <span className="font-semibold text-rose-600 dark:text-rose-400">{num(r.reject_qty)}</span>
        : num(r.reject_qty)),
  },
  {
    key: "posted_qty", label: "Added so far", align: "right", sortable: true,
    exportValue: (r) => r.posted_qty ?? 0,
    render: (r) => (
      <div>
        <div className={Number(r.posted_qty) > 0 ? "font-semibold text-emerald-600 dark:text-emerald-400" : "text-slate-400"}>
          {num(r.posted_qty ?? 0)}
        </div>
        {Number(r.to_post) > 0 && (
          <div className="whitespace-nowrap text-[11px] text-sky-600 dark:text-sky-400">
            {r.state === "OFF" ? `${num(r.to_post)} once auto-add is on` : `+${num(r.to_post)} to add`}
          </div>
        )}
      </div>
    ),
  },
  {
    key: "state", label: "State", sortable: true,
    sortValue: (r) => LINE_STATES.indexOf(r.state),
    searchValue: (r) => lineState(r.state).label,
    exportValue: (r) => lineState(r.state).label,
    render: (r) => <span className={`badge whitespace-nowrap ${lineState(r.state).badge}`}>{lineState(r.state).label}</span>,
  },
  {
    key: "reason", label: "Reason",
    render: (r) => (
      <span className="block max-w-[300px] text-[12px] leading-snug text-slate-500 dark:text-slate-400">{r.reason || "—"}</span>
    ),
  },
];

// A small on/off switch (the Settings page's look).
function Toggle({ on, onClick, disabled, label }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} role="switch" aria-checked={on} aria-label={label}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on
        ? "bg-emerald-500" : "bg-slate-300 dark:bg-navy-700"}`}>
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}

// The rules, said plainly — the same ones ErpGrnPostingService applies.
function PostingRules({ fromDate }) {
  const rules = [
    ["Only what quality accepted in ERP.", "A GRN line with no accepted qty yet is “Quality pending (ERP)” and is not stock. A rejected qty never becomes stock."],
    ["Counted parts only.", "A part that has never been physically counted is left alone — its first count will include what ERP received."],
    ["GRNs after the part's last count.", "A GRN dated on or before the part's last count (or its opening stock) is already in that count, so it is not added again."],
    [`GRNs dated from ${fromDate ? fmtDate(fromDate) : "the start date"}.`, "Older GRNs are part of the counts the store already did."],
    ["Once per GRN.", "Each part's GRN adds its accepted qty once. If ERP later accepts more on the same GRN only the difference is added; if ERP shows less than was added, the line reads “Check with ERP” — nothing is taken back silently."],
    ["ERP is never written.", "The app only reads ERP's GRN register. The stock-in appears in the part's history as “Receipt (ERP GRN)” with the GRN no."],
  ];
  return (
    <div className="min-w-0">
      <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">How an ERP GRN becomes store stock</h4>
      <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
        {rules.map(([head, body]) => (
          <li key={head} className="flex gap-2">
            <CircleCheck size={13} className="mt-0.5 shrink-0 text-emerald-500" aria-hidden="true" />
            <span><b className="font-semibold text-slate-800 dark:text-white">{head}</b> {body}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-slate-400">
        It runs by itself after every ERP sync while auto-add is on, and on demand with &ldquo;Add accepted GRNs to stock now&rdquo;.
      </p>
    </div>
  );
}

// Auto-add on/off and the "add GRNs dated from" date: an administrator edits
// them, everyone else reads them.
function PostingSettings({ settings }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = Boolean(user?.is_admin);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const cur = draft || { enabled: Boolean(settings?.enabled), from_date: settings?.from_date || "" };
  const changed = Boolean(draft)
    && (draft.enabled !== Boolean(settings?.enabled) || draft.from_date !== (settings?.from_date || ""));

  const save = async () => {
    if (!cur.from_date) { toast.error("Pick the date to add GRNs from"); return; }
    setSaving(true);
    try {
      await erpGrnService.saveSettings({ enabled: cur.enabled, from_date: cur.from_date });
      toast.success("ERP receiving settings saved");
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["stock"] });
    } catch { /* the interceptor toasts the server's message */ } finally {
      setSaving(false);
    }
  };

  return (
    <div className="min-w-0 rounded-lg border border-slate-200 p-3 dark:border-navy-700">
      <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Settings</h4>
      <div className="mt-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">Add ERP-accepted GRNs to store stock</p>
          <p className="text-[11px] text-slate-400">After every ERP sync, and with the button above. Off: nothing is added.</p>
        </div>
        {isAdmin ? (
          <Toggle on={cur.enabled} disabled={saving} label="Add ERP-accepted GRNs to store stock"
            onClick={() => setDraft({ ...cur, enabled: !cur.enabled })} />
        ) : (
          <span className={`badge ${settings?.enabled ? "badge-success" : "badge-neutral"}`}>{settings?.enabled ? "On" : "Off"}</span>
        )}
      </div>
      <div className="mt-3">
        <label htmlFor="erp-grn-from" className="text-sm font-medium text-slate-700 dark:text-slate-200">Add GRNs dated from</label>
        {isAdmin ? (
          <input id="erp-grn-from" type="date" className="input-field mt-1 w-full" max={todayIso()} value={cur.from_date}
            disabled={saving} onChange={(e) => setDraft({ ...cur, from_date: e.target.value })} />
        ) : (
          <p id="erp-grn-from" className="mt-0.5 text-sm tabular text-slate-800 dark:text-white">
            {settings?.from_date ? fmtDate(settings.from_date) : "—"}
          </p>
        )}
        <p className="mt-1 text-[11px] text-slate-400">A GRN dated before this is never added — the store&apos;s counts already hold it.</p>
      </div>
      {isAdmin ? (
        <div className="mt-3 flex justify-end gap-2">
          {changed && (
            <button type="button" className="btn-secondary !py-1.5 text-xs" disabled={saving} onClick={() => setDraft(null)}>Undo</button>
          )}
          <button type="button" className="btn-primary !py-1.5 text-xs" disabled={!changed || saving} onClick={save}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      ) : (
        <p className="mt-3 text-[11px] text-slate-400">Only an administrator can change these.</p>
      )}
    </div>
  );
}

// What the last "Add now" did — the server's own list, never a guess.
function PostResult({ result, onClose, onPart }) {
  const posted = result.posted || [];
  const total = posted.reduce((s, p) => s + (Number(p.qty) || 0), 0);
  const tone = posted.length
    ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
    : "border-slate-200 bg-slate-50 text-slate-700 dark:border-navy-700 dark:bg-navy-800 dark:text-slate-300";
  return (
    <div className={`mb-3 rounded-lg border px-3 py-2 text-xs ${tone}`} role="status">
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold">
          {result.skipped_off
            ? "Auto-add is switched off — nothing was added."
            : posted.length
              ? `Added ${count(posted.length, "GRN line")} to store stock · qty ${num(Math.round(total * 100) / 100)}`
              : "Nothing was added — no line was waiting to be added (already added, or it no longer qualifies)."}
        </p>
        <button type="button" onClick={onClose} aria-label="Dismiss" className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100">
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {posted.length > 0 && (
        <ul className="mt-1.5 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {posted.map((p) => (
            <li key={`${p.part_id}|${p.grn_no}`}>
              <button type="button" onClick={() => onPart(p.part_id)}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-white px-2 py-0.5 text-[11px] text-slate-700 hover:border-toyotared dark:border-emerald-500/30 dark:bg-navy-900 dark:text-slate-200">
                <b className="font-semibold">{p.part_no}</b>
                <span className="font-mono text-slate-400">GRN {p.grn_no}</span>
                <span className="font-semibold tabular text-emerald-700 dark:text-emerald-300">+{num(p.qty)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ERP GRN -> Store stock: every ERP GRN line of the store's parts, what state it
// is in and what the app did (or will do) with it, the "add now" button and the
// rules / settings. The page's first section.
function ErpGrnSection({ code, stateFilter, partFilter, onFilter, sectionRef }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { openPart } = usePartDrawer();
  // POST /erp-grn/post takes the Store Stock or the Receiving & GRN edit right.
  const canAddStock = useCan("store_stock", "create");
  const canAddReceiving = useCan("receiving", "create");
  const canAdd = canAddStock || canAddReceiving;
  const { data, isPending, isError, error, refetch, isFetching } = useErpGrnPreview(code);
  const [posting, setPosting] = useState(false);
  const [result, setResult] = useState(null);

  const all = useMemo(() => (Array.isArray(data?.rows) ? data.rows : []), [data]);
  const partRows = useMemo(() => (partFilter
    ? all.filter((r) => String(r.part_no || "").toUpperCase() === partFilter.toUpperCase())
    : all), [all, partFilter]);
  // Counted from the rows on screen, so a chip and the table under it always
  // agree (with a part picked, they are that part's lines).
  const counts = useMemo(() => partRows.reduce((m, r) => ({ ...m, [r.state]: (m[r.state] || 0) + 1 }), {}), [partRows]);
  const rows = stateFilter ? partRows.filter((r) => r.state === stateFilter) : partRows;
  const states = [...LINE_STATES, ...Object.keys(counts).filter((s) => !LINE_STATES.includes(s))];

  const fresh = erpFreshness(data?.erp);
  const enabled = Boolean(data?.settings?.enabled);
  const toAdd = (data?.counts?.WILL_POST ?? all.filter((r) => r.state === "WILL_POST").length) || 0;

  const addNow = async () => {
    const ok = await confirm({
      title: "Add accepted GRNs to store stock",
      message: `Adds the qty that quality accepted in ERP on ${count(toAdd, "GRN line")} to available store stock now — `
        + "each GRN once, counted parts only. ERP is not written.",
      confirmText: "Add to stock",
      danger: false,
    });
    if (!ok) return;
    setPosting(true);
    try {
      const res = await erpGrnService.post(code);
      const out = res.data?.data || { posted: [] };
      setResult(out);
      if (out.posted?.length) toast.success(res.data?.message || `${out.posted.length} GRN line(s) added to store stock`);
      qc.invalidateQueries({ queryKey: ["stock"] });
    } catch { /* the interceptor toasts the server's message */ } finally {
      setPosting(false);
    }
  };

  const addButton = canAdd ? (
    <button type="button" onClick={addNow} disabled={posting || isPending || !enabled || toAdd === 0}
      title={!enabled ? "Auto-add from ERP is switched off — an administrator can switch it on under Settings below"
        : toAdd === 0 ? "No accepted GRN line is waiting to be added" : undefined}
      className="btn-primary inline-flex items-center gap-1.5 !py-1.5 text-xs">
      <PackagePlus size={14} aria-hidden="true" />
      {posting ? "Adding…" : "Add accepted GRNs to stock now"}
      {toAdd > 0 && !posting && <span className="rounded-full bg-white/20 px-1.5 tabular">{num(toAdd)}</span>}
    </button>
  ) : (
    <span title="Adding to stock needs the Store Stock edit right. The ERP sync adds accepted GRNs by itself while auto-add is on."
      className="inline-flex items-center gap-1 rounded-md border border-dashed border-slate-200 px-2 py-1 text-[11px] text-slate-400 dark:border-navy-700">
      <Lock size={11} aria-hidden="true" /> Added by the ERP sync
    </span>
  );

  return (
    <section ref={sectionRef} className="card scroll-mt-4" aria-label="ERP GRN to store stock">
      <CardHead icon={PackageCheck} tone="blue" title="ERP GRN → Store stock"
        hint="Receiving, the GRN and the quality clearance are done in ERP. The app reads each GRN line and adds only the accepted qty to store stock, once."
        action={addButton} />

      {isPending ? (
        <div className="space-y-2" aria-busy="true">
          <div className="skeleton h-5 w-72" />
          <div className="skeleton h-8 w-full" />
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-10 w-full" />)}
        </div>
      ) : isError && !data ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          <span>Could not read the ERP GRN lines{error?.response?.data?.message ? ` — ${error.response.data.message}` : ""}.</span>
          <button type="button" onClick={() => refetch()} className="btn-secondary inline-flex items-center gap-1.5 !py-1 text-xs">
            <RefreshCw size={12} aria-hidden="true" /> Try again
          </button>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span className={`inline-flex items-center gap-1.5 ${fresh.stale
              ? "font-medium text-amber-700 dark:text-amber-300" : "text-slate-500 dark:text-slate-400"}`}>
              <Database size={13} aria-hidden="true" /> {fresh.text}
            </span>
            {isFetching && <span className="text-slate-400">Updating…</span>}
            {isError && <span className="text-amber-700 dark:text-amber-300">The last refresh failed — showing the lines as last read.</span>}
          </div>
          {fresh.stale && (
            <p className="mb-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden="true" />
              <span>
                {fresh.empty
                  ? "The ERP GRN mirror is empty, so no GRN line can be shown or added. It fills on the next successful ERP sync."
                  : `ERP data is ${fresh.staleText}`}
              </span>
            </p>
          )}

          {result && <PostResult result={result} onClose={() => setResult(null)} onPart={openPart} />}

          <div role="group" aria-label="Filter ERP GRN lines by state" className="mb-3 flex flex-wrap items-center gap-2">
            {[null, ...states].map((s) => {
              const on = (stateFilter || null) === s;
              const n = s ? counts[s] || 0 : partRows.length;
              return (
                <button key={s || "all"} type="button" aria-pressed={on} onClick={() => onFilter({ state: s })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${on
                    ? "border-toyotared bg-toyotared text-white"
                    : n
                      ? "border-slate-200 text-slate-700 hover:border-toyotared dark:border-navy-700 dark:text-slate-200"
                      : "border-slate-200 text-slate-400 hover:border-toyotared dark:border-navy-700 dark:text-slate-500"}`}>
                  {s ? lineState(s).label : "All lines"}
                  <span className={`rounded-full px-1.5 text-[11px] font-semibold tabular ${on ? "bg-white/20" : n
                    ? "bg-slate-100 text-slate-700 dark:bg-navy-800 dark:text-slate-200" : "text-slate-400"}`}>
                    {num(n)}
                  </span>
                </button>
              );
            })}
            {partFilter && (
              <button type="button" onClick={() => onFilter({ part: null })}
                className="inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:border-blue-400 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-300"
                title="Show every part's lines">
                Part {partFilter} <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>

          <Table
            key={`${stateFilter || "all"}|${partFilter || ""}`}
            columns={LINE_COLUMNS}
            rows={rows}
            rowKey={lineKey}
            searchable={rows.length > 8 ? "Search part, GRN no, supplier…" : false}
            exportName="erp_grn_to_store_stock"
            maxHeight="55vh"
            onRowClick={(r) => { if (r.part_id) openPart(r.part_id); }}
            emptyMessage={!all.length
              ? (fresh.empty
                ? "No ERP GRN data yet — the GRN mirror is empty."
                : "No GRN line in the ERP mirror for this store's parts.")
              : partFilter && !partRows.length
                ? `No ERP GRN line for part ${partFilter} in the mirror.`
                : `No line is in “${lineState(stateFilter).label}”.`}
          />

          <div className="mt-4 grid gap-4 border-t border-slate-100 pt-4 dark:border-navy-800 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
            <PostingRules fromDate={data?.settings?.from_date} />
            <PostingSettings settings={data?.settings} />
          </div>
        </>
      )}
    </section>
  );
}

// ---- the rest of the monitor ------------------------------------------------

const GRN_COLUMNS = [
  { key: "grn_date", label: "GRN date", sortable: true, render: (r) => fmtDate(r.grn_date) },
  { key: "grn_no", label: "GRN no", sortable: true, render: (r) => r.grn_no || dash },
  partCol,
  { key: "description", label: "Description (ERP)", render: (r) => <span className="block max-w-[240px] truncate">{r.description || "—"}</span> },
  // Not the payload's `qty`: that falls back to the receipt qty when ERP has
  // no accepted qty yet, which would show quality-pending material as accepted.
  qtyCol("receipt_qty", "Received"),
  acceptCol,
  {
    key: "reject_qty", label: "Rejected", align: "right", sortable: true,
    render: (r) => (r.reject_qty ? <span className="font-semibold text-rose-600 dark:text-rose-400">{num(r.reject_qty)}</span> : dash),
  },
  { key: "supplier", label: "Supplier", sortable: true, render: (r) => r.supplier || dash },
  { key: "invoice_no", label: "Invoice / challan", render: (r) => r.invoice_no || dash },
  sectionCol,
  { key: "age_days", label: "Days since GRN", align: "right", sortable: true, render: (r) => <Age days={r.age_days} muted /> },
];

const RECEIPT_COLUMNS = [
  {
    key: "received_at", label: "Added", sortable: true,
    exportValue: (r) => localStamp(r.received_at), render: (r) => fmtStamp(r.received_at),
  },
  partCol,
  qtyCol("qty", "Qty"),
  { key: "invoice_no", label: "Invoice", render: (r) => r.invoice_no || dash },
  {
    key: "check_result", label: "Physical check", sortable: true,
    render: (r) => (r.check_result ? <Chip tone={CHECK_TONE[r.check_result] || "neutral"}>{r.check_result}</Chip> : dash),
  },
  {
    key: "status_label", label: "Status (as recorded)", sortable: true,
    exportValue: (r) => ERP_ORIGIN[r.status] || r.status_label,
    render: (r) => ERP_ORIGIN[r.status] || r.status_label,
  },
  { key: "received_by", label: "Booked by", sortable: true, render: (r) => r.received_by || dash },
  { key: "supplier", label: "Supplier", render: (r) => r.supplier || dash },
  { key: "reference", label: "Reference", render: (r) => r.reference || dash },
  {
    key: "erp_pushed_at", label: "In ERP",
    exportValue: (r) => (isErpOrigin(r)
      ? "By ERP GRN (nothing for the app to push)"
      : r.erp_pushed_at ? `Pushed ${localStamp(r.erp_pushed_at)}` : "Not pushed"),
    render: (r) => (isErpOrigin(r)
      ? <Chip tone="blue" title={ERP_ORIGIN_NOTE[r.status] || ERP_ORIGIN_NOTE.ERP_GRN}>By ERP GRN</Chip>
      : r.erp_pushed_at ? <Chip tone="green" title={fmtStamp(r.erp_pushed_at)}>Pushed</Chip> : <Chip>Not pushed</Chip>),
  },
  sectionCol,
  { key: "age_days", label: "Days since added", align: "right", sortable: true, render: (r) => <Age days={r.age_days} muted /> },
];

const SRV_COLUMNS = [
  {
    key: "started_at", label: "Entered", sortable: true,
    exportValue: (r) => localStamp(r.started_at), render: (r) => fmtStamp(r.started_at),
  },
  { key: "srv_no", label: "Inbound no", sortable: true, render: (r) => r.srv_no || <span className="text-slate-400">not raised</span> },
  partCol,
  { key: "supplier", label: "Supplier", sortable: true, render: (r) => r.supplier || dash },
  qtyCol("qty_invoiced", "Invoiced"),
  qtyCol("qty_received", "Received"),
  {
    key: "pipeline_status", label: "Monitor status", sortable: true,
    exportValue: (r) => r.pipeline_status || `Unmapped (${r.status})`,
    render: (r) => (r.pipeline_status
      ? <Chip tone={PIPELINE_TONE[r.pipeline_status]} title={r.status_note}>{r.pipeline_status}</Chip>
      : <Chip title={r.status_note}>Unmapped</Chip>),
  },
  { key: "status", label: "Inbound status", sortable: true, render: (r) => <span className="font-mono text-[11px]">{r.status}</span> },
  sectionCol,
  {
    key: "age_days", label: "Age", align: "right", sortable: true,
    render: (r) => <Age days={r.age_days} muted={!r.open} />,
  },
];

const GATE_COLUMNS = [
  { key: "gate_entry_dt", label: "Gate date", sortable: true, render: (r) => fmtDate(r.gate_entry_dt) },
  { key: "gate_entry_no", label: "Gate entry", sortable: true, render: (r) => r.gate_entry_no || dash },
  partCol,
  { key: "description", label: "Description (ERP)", render: (r) => <span className="block max-w-[240px] truncate">{r.description || "—"}</span> },
  qtyCol("qty", "Qty"),
  { key: "supplier", label: "Supplier", sortable: true, render: (r) => r.supplier || dash },
  { key: "po_no", label: "PO", render: (r) => r.po_no || dash },
  { key: "last_grn_date", label: "Earlier GRN in window", sortable: true, render: (r) => (r.last_grn_date ? fmtDate(r.last_grn_date) : dash) },
  {
    key: "beyond_grn_data", label: "GRN data",
    exportValue: (r) => (r.beyond_grn_data
      ? "GRN mirror ends before this date"
      : "GRN mirror reaches this date — no GRN found"),
    render: (r) => (r.beyond_grn_data
      ? <Chip tone="blue" title="The ERP GRN mirror has no line dated on or after this arrival yet">Mirror not there yet</Chip>
      : <span className="text-[11px] text-slate-400" title="The GRN mirror holds lines up to or past this date, yet none for this part on or after the arrival">
        Mirror reaches this date
      </span>),
  },
  sectionCol,
  { key: "age_days", label: "Days at gate", align: "right", sortable: true, render: (r) => <Age days={r.age_days} /> },
];

const STATE = {
  tracked: { label: "Tracked", icon: CircleCheck, cls: "text-emerald-600 dark:text-emerald-400" },
  partial: { label: "Partial", icon: CircleDot, cls: "text-amber-600 dark:text-amber-400" },
  not_tracked: { label: "Not tracked yet", icon: CircleDashed, cls: "text-slate-400" },
};

// Spec 1: the spare store has ONE GRN step — no separate SRV step is named on
// screen, whatever older label the server still sends for it.
const STEP_LABEL = { srv_grn: "GRN" };

function Stepper({ steps }) {
  return (
    <div className="card">
      <CardHead icon={Workflow} tone="violet" title="Receiving workflow — what the app can see"
        hint="Each step says where its data comes from and how many rows it holds in this window" />
      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((s, i) => {
          const st = STATE[s.state] || STATE.not_tracked;
          const Icon = st.icon;
          const label = STEP_LABEL[s.key] || s.label;
          return (
            <li key={s.key} className="rounded-lg border border-slate-200 p-3 dark:border-navy-700">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Step {i + 1}</span>
                <span className={`inline-flex items-center gap-1 text-[11px] font-semibold ${st.cls}`}>
                  <Icon size={13} aria-hidden="true" /> {st.label}
                </span>
              </div>
              <p className="mt-1 text-sm font-semibold text-slate-800 dark:text-white">{label}</p>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{s.source}</p>
              <p className="mt-1 text-xs tabular text-slate-700 dark:text-slate-200">
                {s.count == null
                  ? <span className="text-slate-400">no source to count</span>
                  : s.count ? `${num(s.count)} in this window` : <span className="text-slate-400">nothing in this window</span>}
              </p>
              <p className="mt-1 text-[11px] leading-snug text-slate-400">{s.note}</p>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-[11px] text-slate-400">
        Tracked — a real source feeds the step · Partial — only part of the step is recorded · Not tracked yet — nothing in the app records it
      </p>
    </div>
  );
}

// The receiving flow as ERP records it (payload flow.steps, read from the ERP
// mirrors — the app records none of these steps by hand). Labels and notes come
// from the server; these are the icons and the fallback wording for each key.
const FLOW_STEP = {
  GATE: { label: "Arrived at gate", Icon: Truck, hint: "ERP gate entries of this store's parts" },
  GRN_CREATED: { label: "GRN created", Icon: FileCheck2, hint: "GRN raised in ERP — read from the ERP GRN register" },
  QUALITY_PENDING: { label: "Quality pending", Icon: Hourglass, hint: "ERP shows no accepted qty yet — Maintenance / Tool Room inspection is done in ERP" },
  QUALITY_CLEARED: { label: "Accepted by quality (ERP)", Icon: ShieldCheck, hint: "ERP shows an accepted qty on the GRN" },
  STOCK_ADDED: { label: "Added to store stock", Icon: PackageCheck, hint: "The accepted qty added to the app's store stock — once per GRN" },
};
const FLOW_ORDER = Object.keys(FLOW_STEP);

function FlowStepper({ flow, fresh }) {
  // The server's order when it sends one; any key it leaves out is shown as
  // "—" rather than as a zero it never measured.
  const byKey = Object.fromEntries((flow.steps || []).map((s) => [s.key, s]));
  const keys = [...FLOW_ORDER, ...(flow.steps || []).map((s) => s.key).filter((k) => !FLOW_STEP[k])];
  return (
    <div className="card">
      <CardHead icon={Workflow} tone="blue" title="Receiving flow (read from ERP)"
        hint={`Arrived at gate → GRN created → Quality pending → Accepted by quality (ERP) → Added to store stock · this window${fresh?.text ? ` · ${fresh.text}` : ""}`} />
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {keys.map((k, i) => {
          const meta = FLOW_STEP[k] || { label: k.replace(/_/g, " ").toLowerCase(), Icon: CircleDot };
          const step = byKey[k];
          const n = step?.count;
          // Sent only for a step a line can stop at; never invented here.
          const waiting = step?.waiting;
          const hint = step?.note || meta.hint;
          return (
            <li key={k} className="relative rounded-lg border border-slate-200 p-3 dark:border-navy-700">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Step {i + 1}</span>
                <meta.Icon size={15} className={n ? "text-toyotared" : "text-slate-300 dark:text-slate-600"} aria-hidden="true" />
              </div>
              <p className="mt-1 text-sm font-semibold text-slate-800 dark:text-white">{step?.label || meta.label}</p>
              <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 leading-tight">
                <span className={`text-xl font-bold tabular ${n ? "text-slate-900 dark:text-white" : "text-slate-300 dark:text-slate-600"}`}>
                  {n == null ? "—" : num(n)}
                </span>
                {n != null && (
                  <span className="text-[11px] text-slate-400"
                    title={k === "GATE" ? "Gate arrivals of these parts in this window"
                      : "ERP GRN lines that have reached this step, including those gone past it"}>
                    {k === "GATE" ? "arrivals" : "reached"}{step?.qty != null ? ` · qty ${num(step.qty)}` : ""}
                  </span>
                )}
              </p>
              {waiting != null && (
                <p className={`mt-0.5 text-[11px] font-semibold tabular ${waiting
                  ? "text-amber-600 dark:text-amber-400" : "text-slate-400"}`}>
                  {num(waiting)} waiting now
                </p>
              )}
              {hint && <p className="mt-1 text-[11px] leading-snug text-slate-400">{hint}</p>}
              {i < keys.length - 1 && (
                <ChevronRight size={14} aria-hidden="true"
                  className="absolute -right-2.5 top-1/2 hidden -translate-y-1/2 rounded-full bg-white text-slate-300 dark:bg-navy-900 dark:text-slate-600 lg:block" />
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
        Every step is read from ERP — the app records no receipt, GRN or quality clearance by hand. From
        &ldquo;GRN created&rdquo; on, each step counts the ERP GRN lines (one per part and GRN no.) dated in this window
        that reached it, so a line that has gone further is counted at every step it passed; &ldquo;waiting now&rdquo;
        is how many are stopped there. The gate step counts arrivals of these parts on their own: ERP GRN lines carry
        no gate entry no., so an arrival is never tied to a GRN here. Printing a QR label moves nothing along: it adds
        no stock.
      </p>
    </div>
  );
}

// `muted` for lists of finished events: how long ago a GRN was is not a delay.
function AgingStrip({ aging, basis, muted = false }) {
  const plain = "text-slate-700 dark:text-slate-200";
  const tone = {
    "0-3": plain,
    "4-7": muted ? plain : "text-amber-600 dark:text-amber-400",
    "8-15": muted ? plain : "text-rose-600 dark:text-rose-400",
    ">15": muted ? plain : "text-rose-700 dark:text-rose-400",
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {Object.entries(aging || {}).map(([label, n]) => (
        <div key={label} className="rounded-lg border border-slate-200 px-3 py-1.5 dark:border-navy-700">
          <span className="text-[11px] text-slate-400">{label} days</span>
          <span className={`ml-2 text-sm font-bold tabular ${n ? tone[label] : "text-slate-300 dark:text-slate-600"}`}>{num(n)}</span>
        </div>
      ))}
      {basis && <span className="text-[11px] text-slate-400">{basis}</span>}
    </div>
  );
}

function SourcesLine({ sources, window: win }) {
  const sync = sources.erp_sync;
  // A failed run leaves the last good time in place, so the failure has to be
  // said out loud or the mirrors would read fresher than they are.
  const lastGood = sync.last_sync_at
    ? `last successful run ${fmtStamp(sync.last_sync_at)}`
    : "no successful run since the server started";
  const syncItem = !sync.configured
    ? { text: "ERP DB sync not configured" }
    : sync.last_error
      ? { text: `Last ERP sync attempt failed: ${sync.last_error} — ${lastGood}`, warn: true }
      : sync.last_sync_at
        ? { text: `ERP sync last ran ${fmtStamp(sync.last_sync_at)} (since this server started)` }
        : { text: "ERP sync has not run since the server started (its status is kept in memory only)" };
  const items = [
    { text: `Window ${fmtDate(win.from)} – ${fmtDate(win.to)}` },
    { text: sources.grn_mirror.rows
      ? `GRN mirror: ${count(sources.grn_mirror.rows, "line")}, latest ${fmtDate(sources.grn_mirror.latest_date)}`
      : "GRN mirror is empty" },
    { text: sources.gate_mirror.rows
      ? `Gate mirror: latest arrival ${fmtDate(sources.gate_mirror.latest_date)}`
      : "Gate mirror is empty" },
    { text: sources.store_ledger.starts
      ? `App ledger starts ${fmtDate(parseServerTime(sources.store_ledger.starts))} · ${count(sources.store_ledger.receipts_ever, "stock-in row")} ever`
      : "App ledger has no rows yet" },
    syncItem,
  ];
  return (
    <div className="card flex flex-wrap items-start gap-x-4 gap-y-1.5 py-3">
      <Database size={16} className="mt-0.5 shrink-0 text-slate-400" aria-hidden="true" />
      {items.map(({ text, warn }) => (
        <span key={text} title={warn ? text : undefined}
          className={warn
            ? "max-w-full break-words text-[11px] font-medium text-rose-600 dark:text-rose-400"
            : "text-[11px] text-slate-500 dark:text-slate-400"}>
          {text}
        </span>
      ))}
    </div>
  );
}

function SrvPipeline({ data }) {
  const s = data.summary.srv_pipeline;
  // A monitor status no SRV line can rest in is "not recorded", not a measured
  // zero — unless a line really is there, which is then shown as counted.
  const notCountable = data.pipeline_not_countable || {};
  const unrecorded = data.pipeline_statuses.filter((p) => p in notCountable && !s.by_status[p]);
  return (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap gap-2">
        {data.pipeline_statuses.map((p) => (
          <div key={p} className="rounded-lg border border-slate-200 px-3 py-1.5 dark:border-navy-700"
            title={unrecorded.includes(p) ? notCountable[p] : undefined}>
            <span className="text-[11px] text-slate-400">{p}</span>
            <span className="ml-2 text-sm font-bold tabular text-slate-700 dark:text-slate-200">
              {unrecorded.includes(p)
                ? <span className="text-[11px] font-medium text-slate-400">not recorded</span>
                : num(s.by_status[p] || 0)}
            </span>
          </div>
        ))}
        {Object.entries(s.unmapped).map(([raw, n]) => (
          <div key={raw} className="rounded-lg border border-dashed border-slate-300 px-3 py-1.5 dark:border-navy-700">
            <span className="font-mono text-[11px] text-slate-400">{raw}</span>
            <span className="ml-2 text-sm font-bold tabular text-slate-700 dark:text-slate-200">{num(n)}</span>
          </div>
        ))}
      </div>
      {unrecorded.length > 0 && (
        <ul className="space-y-0.5 text-[11px] text-slate-400">
          {unrecorded.map((p) => <li key={p}><span className="font-medium">{p}</span> not recorded — {notCountable[p]}</li>)}
        </ul>
      )}
      <details className="text-[11px] text-slate-500 dark:text-slate-400">
        <summary className="cursor-pointer select-none font-medium text-slate-600 dark:text-slate-300">
          How inbound (SRV register) statuses map to the monitor
        </summary>
        <div className="mt-2 overflow-x-auto">
          <table className="min-w-full text-left">
            <tbody>
              {data.srv_status_map.map((m) => (
                <tr key={m.status} className="border-t border-slate-100 dark:border-navy-800">
                  <td className="py-1 pr-3 font-mono whitespace-nowrap">{m.status}</td>
                  <td className="py-1 pr-3 whitespace-nowrap">{m.maps_to || <span className="italic">Unmapped — shown as is</span>}</td>
                  <td className="py-1">
                    {m.note}
                    {m.rest_note && <span className="block italic text-slate-400">No line rests here: {m.rest_note}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

// Receiving & GRN monitor for the spare store. Receiving, the GRN and the
// quality clearance happen in ERP; this page reads them: first the ERP GRN
// lines and what the app did with each (added to store stock once, or why
// not), then the ERP receiving flow, what was added to stock, the ERP inbound
// (SRV) register and gate arrivals with no GRN yet — each from its real source,
// with the source's reach shown so an empty list can be read.
export default function ReceivingMonitor() {
  const { activeCode, activeStore } = useStores();
  const code = activeCode || "MAINTENANCE";
  const { openPart } = usePartDrawer();
  const [params, setParams] = useSearchParams();
  const erpRef = useRef(null);
  const days = WINDOWS.includes(Number(params.get("days"))) ? Number(params.get("days")) : 90;
  const setParam = (key, value) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    next.set(key, String(value));
    return next;
  }, { replace: true });
  // ?state= / ?part_no= filter the ERP GRN lines (the Work Queue links here with both).
  const stateFilter = params.get("state") || null;
  const partFilter = params.get("part_no") || null;
  const setErpFilter = ({ state, part }) => setParams((prev) => {
    const next = new URLSearchParams(prev);
    if (state !== undefined) { if (state) next.set("state", state); else next.delete("state"); }
    if (part !== undefined) { if (part) next.set("part_no", part); else next.delete("part_no"); }
    return next;
  }, { replace: true });

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["stock", "receiving", code, days],
    queryFn: () => receivingMonitorService.monitor(code, days).then((r) => r.data.data),
    placeholderData: keepPreviousData,
  });
  // The same cached read the ERP GRN section makes — for the KPI and the flow's freshness.
  const { data: preview } = useErpGrnPreview(code);
  const fresh = preview ? erpFreshness(preview.erp) : null;

  const lists = useMemo(() => ({
    grn: data?.grn || [],
    receipts: data?.store_receipts || [],
    srv: data?.srv_pipeline || [],
    gate: data?.gate_not_received || [],
  }), [data]);

  const onRowClick = (r) => { if (r.part_id) openPart(r.part_id); };

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold text-slate-800 dark:text-white">Receiving &amp; GRN</h2>
        <p className="text-xs text-slate-400 mt-0.5">
          What arrived for {activeStore?.name || "this store"}, read from ERP — each GRN line and its quality state,
          what was added to store stock, and gate arrivals with no GRN yet. Receiving, the GRN and the quality
          clearance are done in ERP; the app does not record them.
        </p>
      </div>
      <div className="flex items-center gap-2">
        {isFetching && !isLoading && <span className="text-[11px] text-slate-400">Updating…</span>}
        <div role="group" aria-label="Window"
          className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-navy-700 dark:bg-navy-900">
          {WINDOWS.map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setParam("days", d)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${days === d
                ? "bg-toyotared text-white"
                : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-navy-800"}`}>
              {d} days
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  // The ERP GRN section leads in every state of the monitor below it: it is
  // its own read and does not wait for (or fail with) the monitor.
  const erpSection = (
    <ErpGrnSection code={code} stateFilter={stateFilter} partFilter={partFilter}
      onFilter={setErpFilter} sectionRef={erpRef} />
  );

  if (isLoading) {
    return (
      <div className="space-y-6">
        {header}
        {erpSection}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => <KpiCard key={i} loading />)}
        </div>
        <div className="card space-y-2">
          {Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-10 w-full" />)}
        </div>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="space-y-6">
        {header}
        {erpSection}
        <div className="card">
          <ErrorState title="Could not load receiving data"
            message={error?.response?.data?.message || "The receiving monitor did not answer."}
            onRetry={() => refetch()} />
        </div>
      </div>
    );
  }

  const s = data.summary;
  const src = data.sources;
  const range = `${fmtDate(data.window.from)} – ${fmtDate(data.window.to)}`;

  // The ERP receiving flow block; an older payload without it shows none.
  const flow = data.flow && typeof data.flow === "object" && Array.isArray(data.flow.steps) ? data.flow : null;
  const asked = params.get("tab");
  const tab = TABS.some((t) => t.key === asked) ? asked : "grn";
  // Ledger stock-ins the app could push but has not — those that came in by an
  // ERP GRN are never pushed, so they are not "missing" from ERP.
  const notPushed = lists.receipts.filter((r) => !r.erp_pushed_at && !isErpOrigin(r)).length;
  const pc = preview?.counts || null;
  const showErpState = (state) => {
    setErpFilter({ state });
    erpRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // What the ledger does hold, from its own counts — e.g. "472 opening counts, 1 issue".
  const ledgerHolds = Object.entries(src.store_ledger.txn_counts || {})
    .filter(([t, n]) => t !== "RECEIPT" && n)
    .map(([t, n]) => count(n, LEDGER_WORDS[t] || t.toLowerCase()))
    .join(", ");

  const tabs = {
    grn: {
      columns: GRN_COLUMNS, aging: s.grn.aging, basis: s.grn.aging_basis, muted: true, exportName: "receiving_erp_grn",
      intro: "ERP's GRN register (mirror of srv_report) as ERP holds it — one row per register line whose item code is "
        + "a part in this store. Accepted is ERP's accepted qty — empty while quality is pending in ERP. "
        + "What the app does with each GRN is in “ERP GRN → Store stock” above.",
      empty: src.grn_mirror.rows
        ? `No GRN line for this store's parts between ${range}.`
        : "The GRN mirror is empty — no ERP sync has loaded it, so no GRN line can be shown.",
    },
    receipts: {
      columns: RECEIPT_COLUMNS, aging: s.store_receipts.aging, basis: s.store_receipts.aging_basis, muted: true,
      exportName: "receiving_added_to_stock",
      intro: "Every stock-in row of the app's ledger — each one raised the part's available stock: the accepted qty of "
        + "ERP GRNs (read from ERP), RGP GRNs of reworked material, and rows recorded in the app before receiving "
        + "moved to ERP (status as recorded).",
      empty: !src.store_ledger.receipts_ever
        ? `Nothing has been added to stock in the app yet${src.store_ledger.starts
          ? ` — the ledger starts ${fmtDate(parseServerTime(src.store_ledger.starts))}${ledgerHolds ? ` and holds ${ledgerHolds}` : ""}` : ""}.`
        : `Nothing added to stock between ${range}.`,
    },
    srv: {
      columns: SRV_COLUMNS, aging: s.srv_pipeline.aging, basis: s.srv_pipeline.aging_basis, exportName: "receiving_erp_inbound",
      intro: "Inbound lines ERP pushed into the app's SRV register for this store's parts, mapped onto the monitor's "
        + "statuses — an ERP reference list, not a separate step: spare receiving is read from the ERP GRN register. "
        + "An open line stays listed even when it entered before the window.",
      empty: src.srv.rows_ever
        ? "No inbound line in this window, and none still open."
        : "No inbound line has been pushed by ERP for this store's parts yet.",
    },
    gate: {
      columns: GATE_COLUMNS, aging: s.gate_not_received.aging, basis: s.gate_not_received.aging_basis,
      exportName: "receiving_at_gate_no_grn",
      intro: "Arrived at gate, no GRN yet: gate arrivals of this store's parts with no ERP GRN line and no stock-in on "
        + "or after the arrival date. ERP GRN lines carry no gate entry no., so this is matched by part and date only — "
        + "a likely pending, not a finding that material is lost.",
      empty: s.gate_not_received.gate_lines_in_window
        ? "Every gate arrival in this window has a GRN line or a stock-in on or after it."
        : `No gate arrival of this store's parts between ${range}.`,
    },
  };
  const active = tabs[tab];
  const counts = {
    grn: s.grn.lines, receipts: s.store_receipts.lines,
    srv: s.srv_pipeline.lines, gate: s.gate_not_received.lines,
  };
  const gate = s.gate_not_received;
  const qp = pc ? pc.QUALITY_PENDING || 0 : null;

  return (
    <div className="space-y-6">
      {header}

      {erpSection}

      <SourcesLine sources={src} window={data.window} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard featured tone="blue" label="ERP GRN lines" icon={ClipboardCheck} value={s.grn.lines}
          hint={s.grn.lines ? `${count(s.grn.parts, "part")} · ${num(s.grn.with_rejection)} with rejection` : `none in the last ${days} days`}
          onClick={() => setParam("tab", "grn")} />
        <KpiCard featured tone="navy" label="Added to stock" icon={PackageCheck} value={s.store_receipts.lines}
          hint={src.store_ledger.receipts_ever
            ? `${num(notPushed)} not pushed to ERP`
            : "nothing added in the app yet"}
          onClick={() => setParam("tab", "receipts")} />
        {/* Spec 1: the spare store's pending receiving is ERP's quality
            clearance — read from the ERP GRN lines (any GRN date), with the
            mirror's freshness, never from an app receipt. */}
        {pc ? (
          <KpiCard featured tone={qp ? "amber" : "navy"} label="GRN / Quality pending (ERP)" icon={ShieldCheck}
            value={qp}
            hint={`${num(pc.CHECK || 0)} to check · ${num(pc.WILL_POST || 0)} to add${fresh?.stale ? " · ERP data not current" : ""}`}
            onClick={() => showErpState("QUALITY_PENDING")} />
        ) : (
          <KpiCard featured tone={s.srv_pipeline.open ? "amber" : "navy"} label="ERP inbound open" icon={FileText}
            value={s.srv_pipeline.open}
            hint={src.srv.rows_ever ? `${count(s.srv_pipeline.lines, "inbound line")} listed` : "none pushed by ERP for these parts"}
            onClick={() => setParam("tab", "srv")} />
        )}
        <KpiCard featured tone={gate.over_7_days ? "red" : gate.lines ? "amber" : "navy"} label="At gate, no GRN yet"
          icon={Truck} value={gate.lines}
          hint={gate.lines
            ? `${count(gate.parts, "part")} · ${num(gate.over_7_days)} over 7 days`
            : `of ${count(gate.gate_lines_in_window, "gate arrival")}`}
          onClick={() => setParam("tab", "gate")} />
      </div>

      {flow && <FlowStepper flow={flow} fresh={flow.erp ? erpFreshness(flow.erp) : fresh} />}

      <Stepper steps={data.steps} />

      <div className="card">
        <div role="tablist" aria-label="Receiving lists" className="mb-3 flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
              onClick={() => setParam("tab", t.key)}
              className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${tab === t.key
                ? "border-toyotared bg-toyotared text-white"
                : "border-slate-200 text-slate-600 hover:border-toyotared dark:border-navy-700 dark:text-slate-300"}`}>
              {t.label}
              <span className="ml-1.5 opacity-70 tabular">{num(counts[t.key])}</span>
            </button>
          ))}
        </div>
        <p className="mb-3 text-xs leading-relaxed text-slate-500 dark:text-slate-400">{active.intro}</p>
        {tab === "srv" && <SrvPipeline data={data} />}
        {tab === "gate" && gate.beyond_grn_data > 0 && (
          <p className="mb-3 rounded-lg bg-blue-50 px-3 py-2 text-[11px] text-blue-700 dark:bg-blue-500/10 dark:text-blue-300">
            {num(gate.beyond_grn_data)} of these arrived after the latest GRN in the mirror
            ({fmtDate(src.grn_mirror.latest_date)}) — their GRN may exist in ERP but not be synced here yet.
          </p>
        )}
        <AgingStrip aging={active.aging} basis={active.basis} muted={active.muted} />
        <Table
          key={tab}
          columns={active.columns}
          rows={lists[tab]}
          searchable="Search part, supplier, document no…"
          exportName={active.exportName}
          maxHeight="60vh"
          onRowClick={onRowClick}
          emptyMessage={active.empty}
        />
      </div>
    </div>
  );
}
