import React, { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  ArrowLeft, CalendarRange, CheckCircle2, ClipboardCheck, FileSpreadsheet, FileText, History, Lock, Play,
  Plus, RotateCcw, ScanLine, Send, Upload, XCircle,
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import Modal from "../../components/Modal.jsx";
import ErrorState from "../../components/ErrorState.jsx";
import { useCan } from "../../components/Can.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { fmtDate, fmtStamp, num } from "../../lib/format.js";
import useGunEnd from "../../hooks/useGunEnd.js";
import { storeService } from "../../services/storeService.js";
import { inventoryCountService as inv } from "../../services/inventoryCountService.js";

// Quarterly Inventory (15 Nov 2026 spec): plan a section's count for a
// financial year + quarter, take ERP's stock as a dated snapshot, count the
// shelf (scanner or typed), reconcile, supervisor submits, manager approves
// and locks; a later correction is a revision. ERP vs Physical here is the
// quarterly count — the daily ERP vs App comparison is a separate screen.
// The app's own stock is never changed by a count ("App stock mat chhuo").

const errText = (e) => e?.response?.data?.message || e?.message || "Something went wrong";
const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];
const STATUS_PILL = {
  PLANNED: "bg-slate-100 text-slate-700 dark:bg-navy-800 dark:text-slate-300",
  IN_PROGRESS: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200",
  RECON_PENDING: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",
  COMPLETED: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200",
};
const RESULT = {
  MATCH: ["Matched", "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200"],
  SHORT: ["Shortage", "bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-200"],
  EXCESS: ["Excess", "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200"],
  NOT_COUNTED: ["Not counted", "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300"],
};
const pct = (v) => (v == null ? "—" : `${v}%`);

function fyOptions(current) {
  const start = Number((current || "2026-27").slice(0, 4));
  return [start + 1, start, start - 1, start - 2].map((y) => `${y}-${String(y + 1).slice(-2)}`);
}

function Tile({ label, value, sub, tone = "navy" }) {
  const tones = {
    navy: "text-navy-900 dark:text-white", green: "text-emerald-600 dark:text-emerald-300",
    red: "text-rose-600 dark:text-rose-300", amber: "text-amber-600 dark:text-amber-300", sky: "text-sky-700 dark:text-sky-300",
  };
  return (
    <div className="card px-4 py-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-bold tabular-nums ${tones[tone]}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-400">{sub}</div>}
    </div>
  );
}

function SummaryTiles({ s, extra }) {
  if (!s) return null;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
      {extra}
      <Tile label="Completion" value={pct(s.completion_pct)} sub={`${num(s.counted_parts)} of ${num(s.total_parts)} parts counted`} tone="sky" />
      <Tile label="Accuracy" value={pct(s.accuracy_pct)} sub="matched ÷ counted parts" tone={s.accuracy_pct == null ? "navy" : s.accuracy_pct >= 95 ? "green" : s.accuracy_pct >= 85 ? "amber" : "red"} />
      <Tile label="ERP Qty" value={num(s.erp_qty)} sub="snapshot" />
      <Tile label="Physical Qty" value={num(s.physical_qty)} sub="counted parts" />
      <Tile label="Net Difference" value={num(s.net_difference_qty)} sub="physical − ERP, counted parts" tone={s.net_difference_qty < 0 ? "red" : s.net_difference_qty > 0 ? "amber" : "green"} />
      <Tile label="Shortage" value={num(s.shortage_qty)} sub={`${num(s.shortage_parts)} parts`} tone="red" />
      <Tile label="Excess" value={num(s.excess_qty)} sub={`${num(s.excess_parts)} parts`} tone="amber" />
      <Tile label="Variance Parts" value={num(s.variance_parts)} sub={`${num(s.not_counted_parts)} not counted`} />
    </div>
  );
}

export default function QuarterlyInventory() {
  const { activeCode } = useStores();
  const [sessionId, setSessionId] = useState(null);
  const period = useQuery({ queryKey: ["inventory", "period"], queryFn: () => inv.period().then((r) => r.data.data) });
  const [fy, setFy] = useState("");
  const [qtr, setQtr] = useState("");
  useEffect(() => {
    if (period.data && !fy) { setFy(period.data.fiscal_year); setQtr(period.data.quarter); }
  }, [period.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [tab, setTab] = useState("quarter");

  if (sessionId) return <SessionView id={sessionId} storeCode={activeCode} onBack={() => setSessionId(null)} />;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-bold text-slate-800 dark:text-white">
            <CalendarRange size={20} aria-hidden="true" /> Quarterly Inventory
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Physical count of each section against ERP&apos;s stock snapshot — count, reconcile, approve, lock. The app&apos;s own stock is not changed.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select className="input-field py-1.5 text-sm" value={fy} onChange={(e) => setFy(e.target.value)} aria-label="Financial year">
            {fyOptions(period.data?.fiscal_year).map((y) => <option key={y} value={y}>FY {y}</option>)}
          </select>
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-navy-800 dark:bg-navy-900" role="group" aria-label="Quarter">
            {QUARTERS.map((q) => (
              <button key={q} type="button" onClick={() => setQtr(q)} aria-pressed={qtr === q}
                className={`rounded-md px-3 py-1 text-sm font-semibold ${qtr === q ? "bg-toyotared text-white" : "text-slate-600 dark:text-slate-300"}`}>{q}</button>
            ))}
          </div>
        </div>
      </div>
      <div role="tablist" className="inline-grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-navy-800 dark:bg-navy-900">
        {[["quarter", "This quarter", ClipboardCheck], ["history", "Quarterly history", History]].map(([k, label, Icon]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
            className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold ${tab === k ? "bg-toyotared text-white shadow-sm" : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-navy-800"}`}>
            <Icon size={15} aria-hidden="true" /> {label}
          </button>
        ))}
      </div>
      {tab === "quarter" && fy && qtr && <QuarterTab storeCode={activeCode} fy={fy} qtr={qtr} onOpen={setSessionId} />}
      {tab === "history" && <HistoryTab storeCode={activeCode} />}
    </div>
  );
}

// ---- one quarter: sections, totals, plan ----------------------------------------------------------------
function QuarterTab({ storeCode, fy, qtr, onOpen }) {
  const canPlan = useCan("inventory_review", "create");
  const [planning, setPlanning] = useState(false);
  const data = useQuery({
    queryKey: ["inventory", "quarter", storeCode, fy, qtr],
    queryFn: () => inv.quarter({ store_code: storeCode, fiscal_year: fy, quarter: qtr }).then((r) => r.data.data),
    enabled: Boolean(storeCode), placeholderData: keepPreviousData,
  });
  const sessions = useQuery({
    queryKey: ["inventory", "sessions", storeCode, fy, qtr],
    queryFn: () => inv.sessions({ store_code: storeCode, fiscal_year: fy, quarter: qtr }).then((r) => r.data.data),
    enabled: Boolean(storeCode),
  });
  if (data.isError) return <ErrorState title="Inventory did not load" message={errText(data.error)} onRetry={() => data.refetch()} />;
  const d = data.data;
  const older = (sessions.data || []).filter((s) => !(d?.by_section || []).some((b) => b.session_id === s.id));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-slate-600 dark:text-slate-300">
          <b>{qtr} · FY {fy}</b> — {d ? `${d.status}${d.sections > 1 ? ` · ${d.completed_sections} of ${d.sections} approved` : ""}` : "…"}
        </div>
        {canPlan && <button type="button" className="btn-primary inline-flex items-center gap-1.5" onClick={() => setPlanning(true)}><Plus size={15} /> Plan inventory</button>}
      </div>
      {(d?.sessions || []).length > 0 && (
        <div className="flex flex-wrap gap-2">
          {d.sessions.map((s) => (
            <button key={s.session_id} type="button" onClick={() => onOpen(s.session_id)}
              className="card inline-flex items-center gap-2 px-4 py-2.5 text-left hover:ring-1 hover:ring-toyotared/40">
              <ClipboardCheck size={16} className="text-toyotared" aria-hidden="true" />
              <span className="text-sm font-semibold text-slate-800 dark:text-white">{s.whole_store ? "Whole Spare Store" : s.name}</span>
              <span className={`badge ${STATUS_PILL[s.status]}`}>{s.status_label}</span>
              <span className="text-[12px] font-semibold text-toyotared">Open →</span>
            </button>
          ))}
        </div>
      )}
      {d && <SummaryTiles s={d.summary} />}
      {d && !d.by_section.length && <div className="card p-8 text-center text-sm text-slate-400">No inventory planned for {qtr} {fy} yet — plan one for the whole Spare Store.</div>}
      {d?.by_category?.length > 0 && <CategoryTable rows={d.by_category} />}
      {/* The store as one figure first (15 Nov 2026: "spare store me sabhi parts h
          total parts or unki inventory gap etc deptwise nhi"); sections only on asking. */}
      <details className="card p-0" hidden={!d?.by_section.length}>
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-slate-700 dark:text-slate-200">Section-wise breakdown</summary>
        <div className="overflow-x-auto border-t border-slate-100 dark:border-navy-800">
          <table className="w-full min-w-[820px] text-left text-[12.5px]">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
              <tr><th className="px-3 py-2">Section</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Parts</th><th className="px-3 py-2 text-right">Counted</th>
                <th className="px-3 py-2 text-right">Completion</th><th className="px-3 py-2 text-right">Accuracy</th><th className="px-3 py-2 text-right">Shortage Qty</th><th className="px-3 py-2 text-right">Excess Qty</th><th /></tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {(d?.by_section || []).map((s) => (
                <tr key={s.session_id} className="text-slate-700 dark:text-slate-200">
                  <td className="px-3 py-2.5 font-semibold">{s.name}</td>
                  <td className="px-3 py-2.5"><span className={`badge ${STATUS_PILL[s.status]}`}>{s.status_label}</span></td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{num(s.total_parts)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{num(s.counted_parts)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{pct(s.completion_pct)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{pct(s.accuracy_pct)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-rose-600">{num(s.shortage_qty)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-amber-600">{num(s.excess_qty)}</td>
                  <td className="px-3 py-2.5 text-right"><button type="button" className="font-semibold text-toyotared hover:underline" onClick={() => onOpen(s.session_id)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {older.length > 0 && (
        <p className="text-[12px] text-slate-500">Earlier attempts: {older.map((s) => (
          <button key={s.id} type="button" className="mr-2 font-semibold text-navy-800 underline dark:text-slate-200" onClick={() => onOpen(s.id)}>
            {s.section} #{s.attempt} ({s.status_label})
          </button>))}</p>
      )}
      {planning && <PlanDialog storeCode={storeCode} fy={fy} qtr={qtr} onClose={() => setPlanning(false)} onDone={(s) => { setPlanning(false); onOpen(s.id); }} />}
    </div>
  );
}

function CategoryTable({ rows }) {
  return (
    <div className="card p-0">
      <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700 dark:border-navy-800 dark:text-slate-200">By category</div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-[12.5px]">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
            <tr><th className="px-3 py-2">Category</th><th className="px-3 py-2 text-right">Parts</th><th className="px-3 py-2 text-right">Counted</th><th className="px-3 py-2 text-right">Matched</th>
              <th className="px-3 py-2 text-right">ERP Qty</th><th className="px-3 py-2 text-right">Physical Qty</th><th className="px-3 py-2 text-right">Shortage</th><th className="px-3 py-2 text-right">Excess</th><th className="px-3 py-2 text-right">Accuracy</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
            {rows.map((c) => (
              <tr key={c.name} className="text-slate-700 dark:text-slate-200">
                <td className="px-3 py-2 font-semibold">{c.name}</td>
                <td className="px-3 py-2 text-right tabular-nums">{num(c.total_parts)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{num(c.counted_parts)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{num(c.matched_parts)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{num(c.erp_qty)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{num(c.physical_qty)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-rose-600">{num(c.shortage_qty)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-amber-600">{num(c.excess_qty)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{pct(c.accuracy_pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlanDialog({ storeCode, fy, qtr, onClose, onDone }) {
  const qc = useQueryClient();
  const sections = useQuery({ queryKey: ["sections", storeCode], queryFn: () => storeService.sections(storeCode).then((r) => r.data.data) });
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ section_id: "", start_date: today, close_date: today, remarks: "", duplicate_reason: "" });
  const [needReason, setNeedReason] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await inv.plan({ store_code: storeCode, fiscal_year: fy, quarter: qtr, ...f, section_id: f.section_id ? Number(f.section_id) : null });
      toast.success("Inventory planned");
      qc.invalidateQueries({ queryKey: ["inventory"] });
      onDone(r.data.data);
    } catch (e) {
      if (/needs a reason/.test(errText(e))) setNeedReason(true);
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Plan inventory · ${qtr} FY ${fy}`}
      footer={<><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Plan"}</button></>}>
      <div className="space-y-3 text-sm">
        <label className="block">What to count
          <select className="input-field mt-1 w-full" value={f.section_id} onChange={(e) => setF({ ...f, section_id: e.target.value })}>
            <option value="">All sections — whole Spare Store</option>
            {(sections.data || []).filter((s) => s.is_active !== false).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">Start date<input type="date" className="input-field mt-1 w-full" value={f.start_date} onChange={(e) => setF({ ...f, start_date: e.target.value })} /></label>
          <label className="block">Closing date<input type="date" className="input-field mt-1 w-full" value={f.close_date} min={f.start_date} onChange={(e) => setF({ ...f, close_date: e.target.value })} /></label>
        </div>
        <label className="block">Remarks<input className="input-field mt-1 w-full" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} placeholder="Optional" /></label>
        {needReason && (
          <label className="block text-amber-700">This section already has an inventory this quarter — reason for a second one
            <input className="input-field mt-1 w-full" value={f.duplicate_reason} onChange={(e) => setF({ ...f, duplicate_reason: e.target.value })} />
          </label>
        )}
      </div>
    </Modal>
  );
}

// ---- one section's inventory ------------------------------------------------------------------------------
const VIEWS = [["count", "Count", ScanLine], ["parts", "Part-wise variance", FileSpreadsheet], ["category", "By category", FileText],
  ["uncounted", "Uncounted", XCircle], ["audit", "Audit history", History]];

function SessionView({ id, storeCode, onBack }) {
  const qc = useQueryClient();
  const [view, setView] = useState("count");
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const detail = useQuery({
    queryKey: ["inventory", "detail", id, view === "count" ? "parts" : view, status, q],
    queryFn: () => inv.detail(id, { store_code: storeCode, view: view === "count" ? "parts" : view, status: status || undefined, q: q || undefined })
      .then((r) => r.data.data),
    placeholderData: keepPreviousData,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ["inventory"] });
  if (detail.isError) return <ErrorState title="Inventory did not load" message={errText(detail.error)} onRetry={() => detail.refetch()} />;
  const s = detail.data?.session;
  const name = s ? `Inventory ${s.section} ${s.quarter} ${s.fiscal_year}` : "Inventory";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button type="button" onClick={onBack} className="mb-1 inline-flex items-center gap-1 text-[12px] font-semibold text-slate-500 hover:text-slate-800 dark:hover:text-white"><ArrowLeft size={14} /> All sections</button>
          <h2 className="flex flex-wrap items-center gap-2 text-lg font-bold text-slate-800 dark:text-white">
            {s?.section} · {s?.quarter} FY {s?.fiscal_year}{s?.attempt > 1 ? ` · attempt ${s.attempt}` : ""}
            {s && <span className={`badge ${STATUS_PILL[s.status]}`}>{s.locked && <Lock size={11} className="mr-1 inline" />}{s.status_label}{s.revision ? ` · rev ${s.revision}` : ""}</span>}
          </h2>
          {s && <p className="mt-0.5 text-xs text-slate-400">
            {fmtDate(s.start_date)} – {fmtDate(s.close_date)} · planned by {s.planned_by}
            {s.snapshot_at && ` · ERP snapshot ${fmtStamp(s.snapshot_at)} (${s.snapshot_source === "EXCEL" ? `Excel ${s.snapshot_file || ""}` : `ERP as of ${fmtStamp(s.snapshot_erp_as_of)}`})`}
            {s.approved_by && ` · approved by ${s.approved_by} ${fmtStamp(s.approved_at)}`}
          </p>}
        </div>
        {s && <Workflow s={s} storeCode={storeCode} onChange={refresh} />}
      </div>
      {detail.data && <SummaryTiles s={detail.data.summary} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-navy-800 dark:bg-navy-900">
          {VIEWS.map(([k, label, Icon]) => (
            <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => { setView(k); setStatus(""); }}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-semibold ${view === k ? "bg-toyotared text-white" : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-navy-800"}`}>
              <Icon size={14} aria-hidden="true" /> {label}
            </button>
          ))}
        </div>
        {view !== "count" && (
          <span className="flex items-center gap-1 text-[12px] text-slate-500">
            {["excel", "pdf"].map((fmt) => (
              <button key={fmt} type="button" className="btn-secondary px-2 py-1 text-[12px]"
                onClick={() => inv.exportFile(id, fmt, { store_code: storeCode, view, status: status || undefined, q: q || undefined },
                  `${name}${view === "audit" ? " Audit" : view === "category" ? " by Category" : ""}`).catch((e) => toast.error(errText(e)))}>
                {fmt === "pdf" ? "PDF" : "Excel"}
              </button>
            ))}
          </span>
        )}
      </div>
      {view === "count" && s && <CountPanel s={s} storeCode={storeCode} onChange={refresh} />}
      {view === "parts" && <PartsTable data={detail.data} status={status} setStatus={setStatus} q={q} setQ={setQ} s={s} storeCode={storeCode} onChange={refresh} />}
      {view === "uncounted" && <PartsTable data={detail.data} q={q} setQ={setQ} s={s} storeCode={storeCode} onChange={refresh} uncounted />}
      {view === "category" && detail.data && <CategoryTable rows={detail.data.rows} />}
      {view === "audit" && <AuditTable rows={detail.data?.rows || []} />}
    </div>
  );
}

function Workflow({ s, storeCode, onChange }) {
  const canReview = useCan("inventory_review", "update");
  const canRemove = useCan("inventory_review", "delete");
  const canApprove = useCan("inventory_approve", "update");
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(null);   // {title, label, run(text)}
  const fileRef = useRef(null);
  const run = async (fn, ok) => {
    setBusy(true);
    try { await fn(); toast.success(ok); onChange(); } catch (e) { toast.error(errText(e)); } finally { setBusy(false); }
  };
  const body = (extra) => ({ store_code: storeCode, ...extra });
  return (
    <div className="flex flex-wrap items-center gap-2">
      {s.status === "PLANNED" && canReview && <>
        <button type="button" disabled={busy} className="btn-primary inline-flex items-center gap-1.5" onClick={() => run(() => inv.start(s.id, storeCode), "Started — ERP snapshot taken")}><Play size={14} /> Start (ERP snapshot)</button>
        <button type="button" disabled={busy} className="btn-secondary inline-flex items-center gap-1.5" onClick={() => fileRef.current?.click()}><Upload size={14} /> Start with ERP Excel</button>
        <input ref={fileRef} type="file" accept=".xlsx" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) run(() => inv.startExcel(s.id, storeCode, f), "Started with ERP's Excel"); }} />
      </>}
      {s.status === "PLANNED" && canRemove && <button type="button" disabled={busy} className="btn-secondary" onClick={() => run(() => inv.remove(s.id, storeCode), "Plan removed")}>Remove plan</button>}
      {s.status === "IN_PROGRESS" && canReview && <button type="button" disabled={busy} className="btn-primary inline-flex items-center gap-1.5" onClick={() => run(() => inv.submit(s.id, body()), "Sent for final approval")}><Send size={14} /> Close counting · send for approval</button>}
      {s.status === "RECON_PENDING" && canApprove && <>
        <button type="button" disabled={busy} className="btn-primary inline-flex items-center gap-1.5" onClick={() => run(() => inv.approve(s.id, body()), "Approved and locked")}><CheckCircle2 size={14} /> Approve &amp; lock</button>
        <button type="button" disabled={busy} className="btn-secondary inline-flex items-center gap-1.5" onClick={() => setAsk({ title: "Send back for counting", label: "Reason", run: (t) => inv.reject(s.id, body({ reason: t })) })}><RotateCcw size={14} /> Send back</button>
      </>}
      {ask && <AskText {...ask} onClose={() => setAsk(null)} onDone={() => { setAsk(null); onChange(); }} />}
    </div>
  );
}

function AskText({ title, label, run, onClose, onDone, qty = false }) {
  const [text, setText] = useState("");
  const [n, setN] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await run(text, n); toast.success("Saved"); onDone(); } catch (e) { toast.error(errText(e)); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={title}
      footer={<><button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={busy || !text.trim() || (qty && n === "")} onClick={go}>{busy ? "Saving…" : "Save"}</button></>}>
      <div className="space-y-3 text-sm">
        {qty && <label className="block">Quantity<input type="number" min="0" step="any" className="input-field mt-1 w-full" value={n} onChange={(e) => setN(e.target.value)} /></label>}
        <label className="block">{label}<input autoFocus={!qty} className="input-field mt-1 w-full" value={text} onChange={(e) => setText(e.target.value)} /></label>
      </div>
    </Modal>
  );
}

// ---- counting -------------------------------------------------------------------------------------------
function CountPanel({ s, storeCode, onChange }) {
  const canCount = useCan("inventory_count", "create");
  const canRecount = useCan("inventory_review", "update");
  const [code, setCode] = useState("");
  const [line, setLine] = useState(null);
  const [qty, setQty] = useState("");
  const [loc, setLoc] = useState("");
  const [remarks, setRemarks] = useState("");
  const [busy, setBusy] = useState(false);
  const [ask, setAsk] = useState(null);
  const qtyRef = useRef(null);
  const codeRef = useRef(null);
  const sheetRef = useRef(null);
  const how = useRef("MANUAL");
  const lookup = async (text, by = "SCAN") => {
    const t = (text || "").trim();
    if (!t) return;
    how.current = by;
    try {
      const r = await inv.line(s.id, { store_code: storeCode, code: t });
      setLine(r.data.data); setQty(""); setLoc(r.data.data.location || ""); setRemarks("");
      setTimeout(() => qtyRef.current?.focus(), 50);
    } catch (e) {
      setLine(null); toast.error(errText(e));
    }
  };
  const gun = useGunEnd(() => lookup(code, "SCAN"));
  const reload = async () => {
    if (!line) return;
    const r = await inv.line(s.id, { store_code: storeCode, part_id: line.part_id });
    setLine(r.data.data);
  };
  const save = async () => {
    setBusy(true);
    try {
      await inv.count(s.id, { store_code: storeCode, part_id: line.part_id, qty, location: loc, remarks, source: how.current });
      toast.success(`${line.part_no}: ${qty} ${line.uom} counted`);
      setLine(null); setCode(""); setQty(""); onChange();
      setTimeout(() => codeRef.current?.focus(), 50);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  };
  if (s.status === "PLANNED") return <div className="card p-6 text-center text-sm text-slate-500">Start the inventory first — it takes ERP&apos;s stock snapshot, then counting opens.</div>;
  const open = s.status === "IN_PROGRESS";
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="card space-y-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="text-sm font-semibold text-slate-700 dark:text-slate-200">Scan the part&apos;s QR or type its Part No.</div>
          {open && canCount && <>
            <button type="button" className="btn-secondary inline-flex items-center gap-1 px-2 py-1 text-[12px]" onClick={() => sheetRef.current?.click()}><Upload size={13} /> Count sheet</button>
            <input ref={sheetRef} type="file" accept=".xlsx" hidden onChange={async (e) => {
              const f = e.target.files?.[0]; e.target.value = "";
              if (!f) return;
              try {
                const r = (await inv.countSheet(s.id, storeCode, f)).data.data;
                toast.success(`${r.counted} counted · ${r.skipped.length} already counted · ${r.errors.length} errors`);
                if (r.errors.length || r.skipped.length) setAsk({ list: [...r.skipped, ...r.errors] });
                onChange();
              } catch (err) { toast.error(errText(err)); }
            }} />
          </>}
        </div>
        {!open && <p className="rounded-lg bg-slate-50 px-3 py-2 text-[12px] text-slate-500 dark:bg-navy-950/40">Counting is closed ({s.status_label}).</p>}
        <input ref={codeRef} autoFocus disabled={!open} className="input-field w-full text-base" placeholder="Scan QR / type Part No and press Enter"
          value={code} onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { gun(e); if (e.key === "Enter") lookup(e.currentTarget.value, "MANUAL"); }} />
        {line && (
          <div className="space-y-3 rounded-xl border border-slate-200 p-3 dark:border-navy-700">
            <div>
              <div className="font-mono text-base font-bold text-slate-800 dark:text-white">{line.part_no}</div>
              <div className="text-sm text-slate-600 dark:text-slate-300">{line.item_description}</div>
              <div className="mt-1 text-[12px] text-slate-500">Location {line.location || "—"} · UOM {line.uom} · ERP qty <b>{line.erp_qty == null ? "—" : num(line.erp_qty)}</b> (reference only)</div>
              {!line.in_snapshot && <div className="mt-1 text-[12px] font-semibold text-amber-700">Not in this section&apos;s ERP snapshot{line.other_section ? " — it belongs to another section" : ""}; counting it records it as found on this shelf.</div>}
            </div>
            {line.count && (
              <div className="rounded-lg bg-slate-50 px-3 py-2 text-[12.5px] dark:bg-navy-950/40">
                Counted <b>{num(line.count.counted_qty)} {line.uom}</b> by {line.count.counted_by} · {fmtStamp(line.count.counted_at)}{line.count.seq > 1 ? ` (count ${line.count.seq})` : ""}
                {line.count.recount_ok_by ? <span className="ml-1 font-semibold text-sky-700">· recount allowed by {line.count.recount_ok_by}</span>
                  : open && canRecount && <button type="button" className="ml-2 font-semibold text-toyotared hover:underline"
                    onClick={() => setAsk({ title: `Allow a recount of ${line.part_no}`, label: "Reason", run: (t) => inv.recount(s.id, { store_code: storeCode, part_id: line.part_id, reason: t }), after: reload })}>Allow recount</button>}
                {open && <button type="button" className="ml-2 font-semibold text-navy-800 hover:underline dark:text-slate-200"
                  onClick={() => setAsk({ title: `Correct my count of ${line.part_no}`, label: "Reason", qty: true, run: (t, n) => inv.editCount(line.count.id, { store_code: storeCode, qty: n, reason: t }), after: reload })}>Correct my count</button>}
              </div>
            )}
            {line.can_count && canCount ? (
              <div className="grid gap-2 sm:grid-cols-3">
                <label className="text-[12px] font-semibold text-slate-600">Counted qty *
                  <input ref={qtyRef} type="number" min="0" step="any" inputMode="decimal" className="input-field mt-1 w-full text-lg font-bold" value={qty}
                    onChange={(e) => setQty(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && qty !== "") save(); }} />
                </label>
                <label className="text-[12px] font-semibold text-slate-600">Location<input className="input-field mt-1 w-full" value={loc} onChange={(e) => setLoc(e.target.value)} /></label>
                <label className="text-[12px] font-semibold text-slate-600">Remarks<input className="input-field mt-1 w-full" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></label>
                <div className="sm:col-span-3 flex justify-end gap-2">
                  <button type="button" className="btn-secondary" onClick={() => { setLine(null); setCode(""); }}>Cancel</button>
                  <button type="button" className="btn-primary" disabled={busy || qty === ""} onClick={save}>{busy ? "Saving…" : "Save count"}</button>
                </div>
              </div>
            ) : !line.count && <p className="text-[12px] text-slate-500">{canCount ? "Counting is closed." : "You do not have the Count right."}</p>}
          </div>
        )}
      </div>
      <RecentCounts s={s} storeCode={storeCode} />
      {ask?.list && (
        <Modal open onClose={() => setAsk(null)} title="Count sheet — rows not counted">
          <ul className="max-h-80 list-disc space-y-1 overflow-auto pl-5 text-[12.5px]">{ask.list.map((t) => <li key={t}>{t}</li>)}</ul>
        </Modal>
      )}
      {ask && !ask.list && <AskText {...ask} onClose={() => setAsk(null)} onDone={() => { const a = ask; setAsk(null); a.after?.(); onChange(); }} />}
    </div>
  );
}

function RecentCounts({ s, storeCode }) {
  const audit = useQuery({
    queryKey: ["inventory", "detail", s.id, "audit-recent"],
    queryFn: () => inv.detail(s.id, { store_code: storeCode, view: "audit" }).then((r) => r.data.data.rows),
    refetchInterval: 15000,
  });
  const counts = (audit.data || []).filter((a) => ["COUNT", "RECOUNT", "EDIT"].includes(a.action)).slice(0, 15);
  return (
    <div className="card p-0">
      <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700 dark:border-navy-800 dark:text-slate-200">Latest counts</div>
      <ul className="divide-y divide-slate-100 text-[12.5px] dark:divide-navy-800">
        {counts.map((a, i) => (
          <li key={`${a.at}-${i}`} className="flex items-center justify-between gap-2 px-4 py-2">
            <span className="min-w-0"><span className="font-mono font-semibold">{a.part_no}</span> <span className="text-slate-400">· {a.action.toLowerCase()} by {a.by}</span></span>
            <span className="whitespace-nowrap tabular-nums">{a.old_qty != null ? `${num(a.old_qty)} → ` : ""}<b>{num(a.new_qty)}</b> <span className="text-[11px] text-slate-400">{fmtStamp(a.at)}</span></span>
          </li>
        ))}
        {!counts.length && <li className="px-4 py-6 text-center text-slate-400">Nothing counted yet.</li>}
      </ul>
    </div>
  );
}

function PartsTable({ data, status, setStatus, q, setQ, s, storeCode, onChange, uncounted = false }) {
  const canRevise = useCan("inventory_approve", "update");
  const [ask, setAsk] = useState(null);
  const rows = data?.rows || [];
  return (
    <div className="card p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3 dark:border-navy-800">
        {!uncounted ? (
          <div className="flex flex-wrap gap-1">
            {[["", "All"], ["VARIANCE", "Variance"], ["SHORT", "Shortage"], ["EXCESS", "Excess"], ["MATCH", "Matched"], ["NOT_COUNTED", "Not counted"]].map(([k, label]) => (
              <button key={k} type="button" onClick={() => setStatus(k)} aria-pressed={status === k}
                className={`rounded-full px-3 py-1 text-[12px] font-semibold ${status === k ? "bg-navy-900 text-white dark:bg-white dark:text-navy-900" : "bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300"}`}>{label}</button>
            ))}
          </div>
        ) : <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Parts still to be counted: {num(rows.length)}</span>}
        <input className="input-field w-64 py-1.5 text-[13px]" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Part, description, location…" />
      </div>
      <div className="max-h-[60vh] overflow-auto">
        <table className="w-full min-w-[980px] text-left text-[12.5px]">
          <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950 dark:text-slate-400">
            <tr><th className="px-3 py-2">Part No</th><th className="px-3 py-2">Item Description</th><th className="px-3 py-2">Section</th><th className="px-3 py-2">Category</th><th className="px-3 py-2">Location</th>
              <th className="px-3 py-2 text-right">ERP Qty</th><th className="px-3 py-2 text-right">Physical Qty</th><th className="px-3 py-2 text-right">Difference</th><th className="px-3 py-2 text-right">Diff ₹</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Counted by</th><th /></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
            {rows.slice(0, 1000).map((r) => (
              <tr key={r.part_id} className="text-slate-700 dark:text-slate-200">
                <td className="px-3 py-2 font-mono font-semibold">{r.part_no}</td>
                <td className="max-w-[260px] truncate px-3 py-2" title={r.item_description}>{r.item_description}</td>
                <td className="px-3 py-2">{r.section || "—"}</td>
                <td className="px-3 py-2">{r.category || "—"}</td>
                <td className="px-3 py-2">{r.location || "—"}</td>
                <td className="px-3 py-2 text-right tabular-nums">{num(r.erp_qty)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{num(r.physical_qty)}</td>
                <td className={`px-3 py-2 text-right font-semibold tabular-nums ${r.variance_qty < 0 ? "text-rose-600" : r.variance_qty > 0 ? "text-amber-600" : ""}`}>{r.variance_qty == null ? "—" : r.variance_qty > 0 ? `+${num(r.variance_qty)}` : num(r.variance_qty)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{r.variance_value == null ? "—" : num(r.variance_value)}</td>
                <td className="px-3 py-2"><span className={`badge ${RESULT[r.status][1]}`}>{RESULT[r.status][0]}</span></td>
                <td className="px-3 py-2 text-[11.5px] text-slate-500">{r.counted_by || "—"}</td>
                <td className="px-3 py-2 text-right">{s?.locked && canRevise && (
                  <button type="button" className="text-[12px] font-semibold text-toyotared hover:underline"
                    onClick={() => setAsk({ title: `Revision of ${r.part_no} (after approval)`, label: "Reason", qty: true, run: (t, n) => inv.revise(s.id, { store_code: storeCode, part_id: r.part_id, qty: n, reason: t }) })}>Revise</button>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length > 1000 && <p className="px-4 py-2 text-[12px] text-slate-400">Showing 1,000 of {num(rows.length)} — narrow the search or download Excel for all.</p>}
        {!rows.length && <p className="px-4 py-8 text-center text-sm text-slate-400">Nothing here.</p>}
      </div>
      {ask && <AskText {...ask} onClose={() => setAsk(null)} onDone={() => { setAsk(null); onChange(); }} />}
    </div>
  );
}

const ACTION_WORD = { PLAN: "Planned", START: "Started (ERP snapshot)", SNAPSHOT: "Snapshot", COUNT: "Counted", RECOUNT: "Recount",
  EDIT: "Count corrected", RECOUNT_OK: "Recount allowed", SUBMIT: "Sent for approval", APPROVE: "Approved & locked",
  REJECT: "Sent back", REVISION: "Revision" };

function AuditTable({ rows }) {
  return (
    <div className="card max-h-[60vh] overflow-auto p-0">
      <table className="w-full min-w-[760px] text-left text-[12.5px]">
        <thead className="sticky top-0 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950 dark:text-slate-400">
          <tr><th className="px-3 py-2">When</th><th className="px-3 py-2">By</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Part No</th><th className="px-3 py-2 text-right">Previous</th><th className="px-3 py-2 text-right">Revised</th><th className="px-3 py-2">Remarks</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
          {rows.map((a, i) => (
            <tr key={`${a.at}-${i}`} className="text-slate-700 dark:text-slate-200">
              <td className="whitespace-nowrap px-3 py-2">{fmtStamp(a.at)}</td>
              <td className="px-3 py-2">{a.by}</td>
              <td className="px-3 py-2 font-semibold">{ACTION_WORD[a.action] || a.action}</td>
              <td className="px-3 py-2 font-mono">{a.part_no || "—"}</td>
              <td className="px-3 py-2 text-right tabular-nums">{num(a.old_qty)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{num(a.new_qty)}</td>
              <td className="max-w-[320px] truncate px-3 py-2" title={a.remarks || ""}>{a.remarks || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="px-4 py-8 text-center text-sm text-slate-400">No history yet.</p>}
    </div>
  );
}

// ---- quarterly history ----------------------------------------------------------------------------------
function HistoryTab({ storeCode }) {
  const hist = useQuery({ queryKey: ["inventory", "history", storeCode], queryFn: () => inv.history(storeCode).then((r) => r.data.data), enabled: Boolean(storeCode) });
  const done = useMemo(() => (hist.data || []).filter((h) => h.completed_sections).slice().reverse()
    .map((h) => ({ name: `${h.quarter} ${h.fiscal_year}`, accuracy: h.summary.accuracy_pct, shortage: h.summary.shortage_qty, excess: h.summary.excess_qty })), [hist.data]);
  const sections = useMemo(() => {
    const names = new Set();
    (hist.data || []).forEach((h) => h.by_section.forEach((s) => names.add(s.name)));
    return [...names].sort();
  }, [hist.data]);
  if (hist.isError) return <ErrorState title="History did not load" message={errText(hist.error)} onRetry={() => hist.refetch()} />;
  if (!hist.data) return <div className="card p-6 text-sm text-slate-400">Loading…</div>;
  if (!hist.data.length) return <div className="card p-8 text-center text-sm text-slate-400">No quarterly inventory yet. Only approved results appear here.</div>;
  return (
    <div className="space-y-4">
      {done.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="card p-4">
            <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Inventory accuracy % by quarter</div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={done}><CartesianGrid strokeDasharray="3 3" opacity={0.3} /><XAxis dataKey="name" fontSize={11} /><YAxis domain={[0, 100]} fontSize={11} /><Tooltip />
                <Line type="monotone" dataKey="accuracy" name="Accuracy %" stroke="#0f766e" strokeWidth={2} dot /></LineChart>
            </ResponsiveContainer>
          </div>
          <div className="card p-4">
            <div className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Shortage / excess qty by quarter</div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={done}><CartesianGrid strokeDasharray="3 3" opacity={0.3} /><XAxis dataKey="name" fontSize={11} /><YAxis fontSize={11} /><Tooltip /><Legend />
                <Bar dataKey="shortage" name="Shortage" fill="#e11d48" /><Bar dataKey="excess" name="Excess" fill="#d97706" /></BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : <div className="card p-4 text-sm text-slate-500">No quarter is approved yet — the trends appear once a section&apos;s inventory is approved.</div>}
      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[820px] text-left text-[12.5px]">
          <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
            <tr><th className="px-3 py-2">Quarter</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Approved sections</th><th className="px-3 py-2 text-right">Accuracy</th>
              <th className="px-3 py-2 text-right">vs previous</th><th className="px-3 py-2 text-right">Shortage Qty</th><th className="px-3 py-2 text-right">Excess Qty</th><th className="px-3 py-2 text-right">Variance Parts</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
            {hist.data.map((h, i) => {
              const prev = hist.data.slice(i + 1).find((x) => x.summary.accuracy_pct != null);
              const delta = h.summary.accuracy_pct != null && prev ? Math.round((h.summary.accuracy_pct - prev.summary.accuracy_pct) * 10) / 10 : null;
              return (
                <tr key={`${h.fiscal_year}${h.quarter}`} className="text-slate-700 dark:text-slate-200">
                  <td className="px-3 py-2 font-semibold">{h.quarter} FY {h.fiscal_year}</td>
                  <td className="px-3 py-2">{h.status}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{h.completed_sections} / {h.sections}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(h.summary.accuracy_pct)}</td>
                  <td className={`px-3 py-2 text-right tabular-nums ${delta > 0 ? "text-emerald-600" : delta < 0 ? "text-rose-600" : ""}`}>{delta == null ? "—" : `${delta > 0 ? "+" : ""}${delta} pts`}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(h.summary.shortage_qty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(h.summary.excess_qty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(h.summary.variance_parts)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sections.length > 0 && (
        <div className="card overflow-x-auto p-0">
          <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold text-slate-700 dark:border-navy-800 dark:text-slate-200">Section-wise accuracy (approved)</div>
          <table className="w-full text-left text-[12.5px]">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500 dark:bg-navy-950/40 dark:text-slate-400">
              <tr><th className="px-3 py-2">Section</th>{hist.data.map((h) => <th key={`${h.fiscal_year}${h.quarter}`} className="px-3 py-2 text-right">{h.quarter} {h.fiscal_year}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-navy-800">
              {sections.map((name) => (
                <tr key={name} className="text-slate-700 dark:text-slate-200">
                  <td className="px-3 py-2 font-semibold">{name}</td>
                  {hist.data.map((h) => { const s = h.by_section.find((x) => x.name === name); return <td key={`${h.fiscal_year}${h.quarter}`} className="px-3 py-2 text-right tabular-nums">{s && s.status === "COMPLETED" ? pct(s.accuracy_pct) : "—"}</td>; })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
