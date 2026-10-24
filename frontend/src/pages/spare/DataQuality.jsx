import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import {
  ArrowDownToLine, ArrowLeftRight, ArrowUpToLine, Barcode, Check, ClipboardList, Copy, IndianRupee,
  MapPin, Pencil, Printer, RefreshCw, RotateCcw, Ruler, ShieldCheck, TriangleAlert, Truck, X,
} from "lucide-react";
import Table from "../../components/Table.jsx";
import CardHead from "../../components/CardHead.jsx";
import { useCan } from "../../components/Can.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { usePartDrawer } from "../../context/PartDrawerContext.jsx";
import { invalidateStock } from "../../lib/stockQueries.js";
import { fmtDate, money, num, parseServerTime } from "../../lib/format.js";
import { dataQualityService } from "../../services/dataQualityService.js";
import { partService } from "../../services/partService.js";

// Under "stock", so a part-master edit anywhere (the server's SSE "stock" push)
// or a fix made here refreshes the counts and the open list together.
const dqKeys = {
  summary: (code) => ["stock", "data-quality", code],
  parts: (code, check) => ["stock", "data-quality", code, check],
};

const ICONS = {
  missing_max: ArrowUpToLine,
  missing_min: ArrowDownToLine,
  missing_reorder: RotateCcw,
  zero_reorder: RotateCcw,
  missing_rate: IndianRupee,
  zero_rate: IndianRupee,
  missing_location: MapPin,
  never_counted: ClipboardList,
  reorder_outside_min_max: ArrowLeftRight,
  min_greater_than_max: TriangleAlert,
  missing_barcode: Barcode,
  no_label_printed: Printer,
  no_gate_supplier: Truck,
  uom_variants: Ruler,
  duplicate_names: Copy,
};

const FIELD_LABEL = {
  max_stock_level: "Max", min_stock_level: "Min", reorder_level: "Reorder",
  unit_price: "Rate", location: "Location", uom: "UOM",
};
const NUMERIC = new Set(["max_stock_level", "min_stock_level", "reorder_level", "unit_price"]);
const MAX_LEN = { location: 40, uom: 10 };

const GROUPS = [
  { severity: "warning", title: "Affects stock decisions", hint: "Status, value, order quantity or where to find the part" },
  { severity: "info", title: "Housekeeping", hint: "Labels, suppliers and consistent naming" },
];

// One decimal hides a few parts out of thousands: never print 0% beside a
// non-zero count, or 100% while something is still missing.
function fmtShare(pct, part, whole) {
  if (pct == null) return "—";
  if (part > 0 && pct === 0) return "<0.1%";
  if (part < whole && pct === 100) return ">99.9%";
  return `${pct}%`;
}

// Green only when nearly all of it is there; red when most of it is missing.
// Toned and sized on the exact share, and never drawn full while anything is
// missing, so a bar can't look complete beside "2 missing".
function barFill(part, whole) {
  if (!whole) return { width: 0, tone: "bg-slate-300 dark:bg-navy-700" };
  const exact = (part / whole) * 100;
  const tone = exact >= 90 ? "bg-emerald-500" : exact >= 60 ? "bg-amber-500" : "bg-toyotared";
  return { width: part < whole ? Math.min(exact, 99) : 100, tone };
}

// generated_at is a server UTC stamp (sent with +00:00 today); parseServerTime
// also keeps it right should the zone ever be dropped.
const fmtTime = (iso) => {
  const d = iso ? parseServerTime(iso) : null;
  return d ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : null;
};

/** A value typed into a list cell, checked against the part's other limits by
 *  the same rules the checks above use, so a fix can't land the part on another
 *  list. The one conflict a max can't avoid — a reorder level already below the
 *  minimum, only checked once a maximum exists — is saved with a note saying
 *  where the part now shows. Returns { value, error, note }. */
function parseDraft(field, draft, row) {
  if (NUMERIC.has(field)) {
    const n = Number(draft);
    if (String(draft).trim() === "" || Number.isNaN(n)) return { error: "Enter a number" };
    // 0 is how a blank max or min is stored, and a 0 reorder level or rate is
    // a check of its own, so a 0 fixes nothing in any of these lists.
    if (n <= 0) return { error: `Enter a ${FIELD_LABEL[field]} above 0` };
    const mn = row.min_stock_level || 0;
    const mx = row.max_stock_level || 0;
    const ro = row.reorder_level;   // null = not set
    if (field === "max_stock_level") {
      if (n < mn) return { error: `Max can't be below the minimum (${num(mn)})` };
      if (ro != null && n < ro) return { error: `Max can't be below the reorder level (${num(ro)})` };
      if (ro != null && ro < mn) {
        return {
          value: n,
          note: `Its reorder level (${num(ro)}) is below the minimum (${num(mn)}), so it is listed under "Reorder outside min–max" — fix it there.`,
        };
      }
    }
    // Reorder is only checked against min where a maximum is set.
    if (field === "min_stock_level" && mx > 0) {
      if (n > mx) return { error: `Min can't be above the maximum (${num(mx)})` };
      if (ro != null && n > ro) return { error: `Min can't be above the reorder level (${num(ro)})` };
    }
    if (field === "reorder_level") {
      if (mx > 0 && mn > mx) {
        return { error: `Fix Min/Max first — the minimum (${num(mn)}) is above the maximum (${num(mx)}). Set a new max under "Minimum above maximum".` };
      }
      if (n < mn || (mx > 0 && n > mx)) {
        return { error: mx > 0 ? `Reorder must sit between min ${num(mn)} and max ${num(mx)}` : `Reorder can't be below the minimum (${num(mn)})` };
      }
    }
    return { value: n };
  }
  const text = String(draft).trim();
  if (!text) return { error: `Enter a ${FIELD_LABEL[field].toLowerCase()}` };
  if (MAX_LEN[field] && text.length > MAX_LEN[field]) return { error: `${FIELD_LABEL[field]} is at most ${MAX_LEN[field]} characters` };
  return { value: text };
}

export default function DataQuality() {
  const { activeCode, activeStore, loading: storesLoading } = useStores();
  // PUT /parts/<id> takes the Part Master or the Data Quality edit right.
  const canEditMaster = useCan("part_master", "update");
  const canEditQuality = useCan("data_quality", "update");
  const canEdit = canEditMaster || canEditQuality;
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const check = params.get("check") || "";
  const listRef = useRef(null);
  const scrollOnOpen = useRef(false);

  const summaryQ = useQuery({
    queryKey: dqKeys.summary(activeCode),
    queryFn: () => dataQualityService.summary({ store_code: activeCode }).then((r) => r.data.data),
    enabled: Boolean(activeCode),
  });
  const summary = summaryQ.data;
  // A stale or hand-typed ?check= that isn't a real check simply opens nothing.
  const meta = summary?.checks?.find((c) => c.key === check) || null;

  // The selected check lives in the URL, so a link can open a list directly
  // and the back button closes it.
  const openCheck = (key) => {
    scrollOnOpen.current = Boolean(key && key !== check);
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (key && key !== check) next.set("check", key); else next.delete("check");
      return next;
    });
  };

  useEffect(() => {
    if (meta && scrollOnOpen.current) {
      scrollOnOpen.current = false;
      listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [meta]);

  const refresh = () => qc.invalidateQueries({ queryKey: ["stock", "data-quality", activeCode] });

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 className="text-lg font-bold text-slate-800 dark:text-white">Data Quality</h2>
        <p className="text-xs text-slate-400 mt-0.5">
          How complete and consistent {activeStore?.name ? `the ${activeStore.name}` : "this store"}&apos;s part
          master is. Every figure is a count of parts as stored — nothing is estimated.
        </p>
      </div>
      {summary && (
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-400">Checked {fmtTime(summary.generated_at)}</span>
          <button type="button" className="btn-secondary py-1.5 text-[13px]" onClick={refresh}
            disabled={summaryQ.isFetching}>
            <RefreshCw size={14} className={summaryQ.isFetching ? "animate-spin" : ""} aria-hidden="true" /> Refresh
          </button>
        </div>
      )}
    </div>
  );

  if (!activeCode) {
    return (
      <div className="space-y-6">
        {header}
        {storesLoading ? <SummarySkeleton /> : (
          <div className="card text-sm text-slate-500 dark:text-slate-400">
            No store is selected. Pick a store from the sidebar to check its part master.
          </div>
        )}
      </div>
    );
  }

  if (summaryQ.isPending) {
    return <div className="space-y-6">{header}<SummarySkeleton /></div>;
  }

  if (summaryQ.isError || !summary) {
    return (
      <div className="space-y-6">
        {header}
        <div className="card text-center text-sm text-slate-500 dark:text-slate-400 py-10">
          Couldn&apos;t load the data-quality checks.{" "}
          <button type="button" onClick={() => summaryQ.refetch()} className="font-medium text-toyotared hover:underline">
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (!summary.parts) {
    return (
      <div className="space-y-6">
        {header}
        <div className="card text-center text-sm text-slate-500 dark:text-slate-400 py-10">
          This store has no active parts yet, so there is nothing to check.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {header}

      <CompletenessCard summary={summary} activeCheck={check} onPick={openCheck} />

      {GROUPS.map((g) => {
        const items = summary.checks.filter((c) => (g.severity === "warning" ? c.severity === "warning" : c.severity !== "warning"));
        if (!items.length) return null;
        return (
          <section key={g.severity} aria-label={g.title}>
            <div className="mb-2 flex items-baseline gap-2">
              <h3 className="kpi-label">{g.title}</h3>
              <span className="text-[11px] text-slate-400">{g.hint}</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {items.map((c) => (
                <CheckCard key={c.key} c={c} parts={summary.parts} active={c.key === check} canEdit={canEdit}
                  onClick={() => openCheck(c.key)} />
              ))}
            </div>
          </section>
        );
      })}

      {meta && (
        <div ref={listRef} className="scroll-mt-4">
          <CheckList key={meta.key} meta={meta} code={activeCode} summary={summary} canEdit={canEdit}
            onClose={() => openCheck("")} />
        </div>
      )}

      <p className="text-[11px] text-slate-400 leading-relaxed">
        Not checked: lead time, safety stock, bin capacity and count frequency — the part master has
        no field for them yet, so there is nothing to measure. Part Master edits, deletions and imports — including
        fixes made here — are logged in the Audit Trail under entity PART.
      </p>
    </div>
  );
}

function SummarySkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="card space-y-3">
        <div className="skeleton h-3 w-40" />
        <div className="skeleton h-8 w-24" />
        <div className="skeleton h-2.5 w-full" />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => <div key={i} className="skeleton h-14" />)}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => <div key={i} className="skeleton h-32 rounded-xl" />)}
      </div>
    </div>
  );
}

function CompletenessCard({ summary, activeCheck, onPick }) {
  const pct = summary.completeness_pct;
  const slots = summary.parts * summary.fields.length;
  const filled = summary.fields.reduce((s, f) => s + f.filled, 0);
  const bar = barFill(filled, slots);
  return (
    <section className="card" aria-label="Master data completeness">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="kpi-label flex items-center gap-1.5">
            <ShieldCheck size={13} aria-hidden="true" /> Master data complete
          </p>
          <p className="mt-1 text-3xl font-bold tabular text-slate-900 dark:text-white">
            {fmtShare(pct, filled, slots)}
          </p>
        </div>
        <p className="max-w-md text-xs text-slate-500 dark:text-slate-400">
          Share of Max, Min, Reorder, Rate and Location filled in across{" "}
          <b className="font-semibold text-slate-700 dark:text-slate-200">{num(summary.parts)}</b> active parts — the
          same figure the store dashboard shows. As there, a 0 counts as blank for Max and Min but as filled for
          Reorder and Rate; those zeros have checks of their own below.
        </p>
      </div>
      <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-slate-100 dark:bg-navy-800"
        role="progressbar" aria-label="Master data complete" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? 0}>
        <div className={`h-full rounded-full transition-all ${bar.tone}`} style={{ width: `${bar.width}%` }} />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {summary.fields.map((f) => {
          const missing = summary.parts - f.filled;
          const fb = barFill(f.filled, summary.parts);
          const zeroNote = f.zero
            ? ` ${num(f.zero)} more have ${f.label.toLowerCase()} 0, which counts as filled here — see "${
              summary.checks.find((c) => c.key === f.zero_check)?.label || "the 0 check"}".`
            : "";
          return (
            <button key={f.field} type="button" onClick={() => onPick(f.check)} aria-pressed={activeCheck === f.check}
              title={`Show the ${num(missing)} parts with no ${f.label.toLowerCase()}.${zeroNote}`}
              className={`rounded-lg border px-3 py-2 text-left transition-colors hover:border-toyotared
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/40
                ${activeCheck === f.check ? "border-toyotared" : "border-slate-200 dark:border-navy-700"}`}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{f.label}</span>
                <span className="text-xs font-semibold tabular text-slate-800 dark:text-white">
                  {fmtShare(f.pct, f.filled, summary.parts)}
                </span>
              </div>
              <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-navy-800">
                <div className={`h-full ${fb.tone}`} style={{ width: `${fb.width}%` }} />
              </div>
              <p className="mt-1 text-[11px] tabular text-slate-400">
                {missing ? `${num(missing)} missing` : "All filled"}
                {f.zero ? <span className="text-amber-600 dark:text-amber-400"> · {num(f.zero)} at 0</span> : null}
              </p>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function CheckCard({ c, parts, active, canEdit, onClick }) {
  const Icon = ICONS[c.key] || ShieldCheck;
  const clear = c.count === 0;
  const chip = clear
    ? "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300"
    : c.severity === "warning"
      ? "bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300"
      : "bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300";
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={`card card-interactive !p-4 text-left ${active ? "!border-toyotared ring-2 ring-toyotared/30" : ""} ${clear ? "opacity-80" : ""}`}>
      {/* The label gets the full row and may wrap: the severity chip sits by
          the count, so a long name is never cut short. */}
      <div className="flex items-start gap-2">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${chip}`}>
          <Icon size={15} aria-hidden="true" />
        </span>
        <span className="line-clamp-2 min-w-0 pt-1 text-sm font-semibold leading-snug text-slate-800 dark:text-white"
          title={c.label}>
          {c.label}
        </span>
      </div>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular text-slate-900 dark:text-white">{num(c.count)}</span>
        <span className="min-w-0 flex-1 text-xs text-slate-400">
          {c.pct != null ? `${fmtShare(c.pct, c.count, parts)} of parts` : ""}
          {c.groups ? ` · ${num(c.groups)} group${c.groups === 1 ? "" : "s"}` : ""}
        </span>
        <span className={`badge shrink-0 self-center ${clear ? "badge-success" : c.severity === "warning" ? "badge-warning" : "badge-info"}`}>
          {clear ? "Clear" : c.severity === "warning" ? "Warning" : "Info"}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-slate-500 dark:text-slate-400">{c.hint}</p>
      {!clear && c.fixable_field && canEdit && (
        <p className="mt-2 flex items-center gap-1 text-[11px] font-medium text-toyotared">
          <Pencil size={11} aria-hidden="true" /> Fixable in the list
        </p>
      )}
    </button>
  );
}

function EditCell({ row, field, shown, active, draft, saving, onDraft, onStart, onSave, onCancel }) {
  const numeric = NUMERIC.has(field);
  if (active) {
    return (
      // Clicks and keys stay in the cell: the row itself opens the part drawer
      // on click and on Enter.
      <div className={`flex items-center gap-1 ${numeric ? "justify-end" : ""}`}
        onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          type={numeric ? "number" : "text"}
          min={numeric ? "0" : undefined}
          step={numeric ? "any" : undefined}
          maxLength={MAX_LEN[field]}
          value={draft}
          disabled={saving}
          onChange={(e) => onDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSave(row);
            if (e.key === "Escape") onCancel();
          }}
          aria-label={`${FIELD_LABEL[field]} for ${row.part_no}`}
          className={`${numeric ? "w-20 text-right" : "w-28"} rounded border border-toyotared bg-white px-1.5 py-0.5 text-xs
            focus:outline-none dark:bg-navy-900`}
        />
        <button type="button" onClick={() => onSave(row)} disabled={saving} title="Save" aria-label="Save"
          className="text-emerald-600 hover:text-emerald-700 disabled:opacity-40">
          <Check size={14} />
        </button>
        <button type="button" onClick={onCancel} disabled={saving} title="Cancel" aria-label="Cancel"
          className="text-slate-400 hover:text-slate-600 disabled:opacity-40">
          <X size={14} />
        </button>
      </div>
    );
  }
  return (
    <button type="button" title={`Set ${FIELD_LABEL[field]}`}
      onClick={(e) => { e.stopPropagation(); onStart(row); }}
      onKeyDown={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-1 rounded border border-dashed border-slate-300 px-1.5 py-0.5 text-xs
        hover:border-toyotared hover:text-toyotared dark:border-navy-600">
      {shown}
      <Pencil size={11} className="opacity-60" aria-hidden="true" />
    </button>
  );
}

function CheckList({ meta, code, summary, canEdit, onClose }) {
  const qc = useQueryClient();
  const { openPart } = usePartDrawer();
  const [editing, setEditing] = useState(null);   // part_id of the row being fixed
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const q = useQuery({
    queryKey: dqKeys.parts(code, meta.key),
    queryFn: () => dataQualityService.parts({ store_code: code, check: meta.key }).then((r) => r.data.data),
  });
  const rows = q.data?.rows;
  const field = meta.fixable_field;
  const editable = canEdit && Boolean(field);

  const cancel = () => { setEditing(null); setDraft(""); };
  const start = (row) => {
    setEditing(row.part_id);
    // A UOM fix starts from the most used spelling; a number from what is
    // stored, unless that is the blank or 0 being fixed.
    const current = row[field];
    if (field === "uom" && row.uom_most_used) setDraft(row.uom_most_used);
    else if (NUMERIC.has(field)) setDraft(current ? String(current) : "");
    else setDraft(current || "");
  };
  const save = async (row) => {
    const { value, error, note } = parseDraft(field, draft, row);
    if (error) {
      toast.error(error);
      return;
    }
    setSaving(true);
    try {
      await partService.update(row.part_id, { [field]: value });
      toast.success(`${row.part_no}: ${FIELD_LABEL[field]} set to ${value}`);
      if (note) toast(`${row.part_no}: ${note}`, { duration: 8000 });
      cancel();
      // Refreshes this list and the counts above (both under "stock"), and
      // every stock screen that shows the part.
      invalidateStock(qc);
    } catch {
      /* the api interceptor toasts the server's message */
    } finally {
      setSaving(false);
    }
  };

  const columns = useMemo(() => {
    const cell = (r, key, shown) => (editable && key === field ? (
      <EditCell row={r} field={key} shown={shown} active={editing === r.part_id} draft={draft} saving={saving}
        onDraft={setDraft} onStart={start} onSave={save} onCancel={cancel} />
    ) : shown);
    const blank = <span className="text-slate-400">—</span>;
    const numCol = (key, label, fmt = num) => ({
      key, label, align: "right", sortable: true,
      render: (r) => cell(r, key, r[key] == null ? blank : fmt(r[key])),
    });

    const cols = [
      {
        key: "part_no", label: "Part No", sortable: true,
        render: (r) => <span className="font-mono text-xs font-semibold text-slate-800 dark:text-slate-100">{r.part_no}</span>,
      },
      {
        key: "part_name", label: "Description", sortable: true,
        render: (r) => <span className="block max-w-[280px] truncate" title={r.part_name}>{r.part_name}</span>,
      },
    ];
    if (meta.key === "duplicate_names") {
      cols.push({
        key: "name_group_size", label: "Same description", align: "right", sortable: true,
        render: (r) => `${num(r.name_group_size)} parts`,
      });
    }
    cols.push(
      { key: "section", label: "Section", sortable: true, render: (r) => r.section || blank },
      { key: "type", label: "Type", sortable: true, render: (r) => r.type || blank },
      { key: "uom", label: "UOM", sortable: true, render: (r) => cell(r, "uom", r.uom || blank) },
    );
    if (meta.key === "uom_variants") {
      cols.push({ key: "uom_most_used", label: "Most used spelling", sortable: true });
    }
    cols.push(
      numCol("min_stock_level", "Min"),
      numCol("reorder_level", "Reorder"),
      numCol("max_stock_level", "Max"),
      numCol("unit_price", "Rate", money),
      { key: "location", label: "Location", sortable: true, render: (r) => cell(r, "location", r.location || blank) },
      {
        key: "barcode", label: "Barcode", sortable: true,
        render: (r) => (r.barcode ? <span className="font-mono text-xs">{r.barcode}</span> : blank),
      },
      {
        key: "qty_on_hand", label: "In Stock", align: "right", sortable: true,
        render: (r) => (r.qty_on_hand == null
          ? <span className="text-[11px] italic text-slate-400">Not counted</span>
          : num(r.qty_on_hand)),
      },
    );
    return cols;
    // start/save/cancel close over editing/draft/saving, which are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.key, editable, field, editing, draft, saving]);

  const Icon = ICONS[meta.key] || ShieldCheck;
  const gate = meta.gate_window || summary.gate_window;

  return (
    <section className="card" aria-label={`${meta.label} — parts`}>
      {/* The count leads the hint, which wraps, rather than trailing the
          title, which truncates on a narrow screen. */}
      <CardHead icon={Icon} tone={meta.severity === "warning" ? "amber" : "blue"}
        title={<span title={meta.label}>{meta.label}</span>}
        hint={(
          <>
            <b className="font-semibold text-slate-600 dark:text-slate-300">
              {num(meta.count)} part{meta.count === 1 ? "" : "s"}
            </b>{" "}· {meta.hint}
          </>
        )}
        action={(
          <button type="button" className="btn-secondary py-1.5 text-[13px]" onClick={onClose}>
            <X size={14} aria-hidden="true" /> Close
          </button>
        )} />

      {meta.key === "no_gate_supplier" && gate && (
        <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
          {gate.rows
            ? <>Gate data held: {fmtDate(gate.from)} to {fmtDate(gate.to)} · {num(gate.rows)} gate rows (all stores). A part
              listed here may still have arrived outside that window, or only on gate rows that name no supplier.</>
            : "No gate entries have been received yet, so every part is listed."}
        </p>
      )}

      {meta.key === "uom_variants" && summary.uom_variants?.length > 0 && (
        <ul className="mb-3 flex flex-wrap gap-2" aria-label="Unit spellings">
          {summary.uom_variants.map((g) => (
            <li key={g.unit} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600
              dark:border-navy-700 dark:text-slate-300">
              {g.spellings.map((s, i) => (
                <span key={s.uom}>
                  {i > 0 && <span className="text-slate-300 dark:text-slate-600"> / </span>}
                  <span className={s.uom === g.most_used ? "font-semibold text-slate-800 dark:text-white" : ""}>
                    {`"${s.uom}"`}
                  </span>{" "}
                  <span className="tabular text-slate-400">{num(s.count)}</span>
                </span>
              ))}
            </li>
          ))}
        </ul>
      )}

      {field && (
        <p className="mb-3 text-[11px] text-slate-400">
          {editable
            ? `Click a ${FIELD_LABEL[field]} cell to fix it. It saves to the part master, is logged in the Audit Trail, and the part leaves this list once it passes.`
            : `View only: fixing ${FIELD_LABEL[field]} here needs Part Master edit rights.`}
        </p>
      )}

      {q.isError ? (
        <div className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
          Couldn&apos;t load these parts.{" "}
          <button type="button" onClick={() => q.refetch()} className="font-medium text-toyotared hover:underline">
            Retry
          </button>
        </div>
      ) : (
        <Table
          columns={columns}
          rows={rows}
          loading={q.isPending}
          searchable="Search part no, description, location…"
          exportName={`data_quality_${meta.key}`}
          maxHeight="65vh"
          virtualize={(rows?.length || 0) > 300}
          onRowClick={(r) => openPart(r.part_id)}
          emptyMessage={meta.count === 0 ? "No part fails this check." : "No parts to show."}
        />
      )}
    </section>
  );
}
