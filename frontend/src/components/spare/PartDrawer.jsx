import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import {
  CircleCheck, Database, History, Info, MapPin, Printer, Route, ScanBarcode, Siren, TriangleAlert, Truck,
} from "lucide-react";
import Modal from "../Modal.jsx";
import Badge from "../Badge.jsx";
import PrintBarcodeModal from "../PrintBarcodeModal.jsx";
import Traceability from "./Traceability.jsx";
import { useCan } from "../Can.jsx";
import { spareStockService } from "../../services/spareStockService.js";
import { invalidateStock } from "../../lib/stockQueries.js";
import { splitLocation } from "../../lib/inventory.js";
import { BUCKETS, statusMeta } from "../../lib/scanStatus.js";
import { fmtDate, fmtStamp, money, num, parseServerTime } from "../../lib/format.js";

// One spare, everything about it — the same drawer from the dashboard, the
// stock list, the part ledger and Ctrl+K. Read from one server call
// (/spare-stock/parts/<id>/overview) kept under the "stock" cache key, so an
// issue or count anywhere refreshes an open drawer live.

const SEV = {
  critical: { Icon: Siren, cls: "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200" },
  warning: { Icon: TriangleAlert, cls: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200" },
  info: { Icon: Info, cls: "border-slate-200 bg-slate-50 text-slate-700 dark:border-navy-700 dark:bg-navy-800 dark:text-slate-300" },
};
const TXN_TONE = {
  OPENING: "text-slate-500", RECEIPT: "text-emerald-600", ISSUE: "text-rose-600",
  RETURN: "text-amber-600", ADJUSTMENT: "text-blue-600",
};

function Section({ title, icon: Icon, children, aside }) {
  return (
    <section className="border-t border-slate-100 pt-4 first:border-0 first:pt-0 dark:border-navy-800">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-slate-400">
          {Icon && <Icon size={13} aria-hidden="true" />}{title}
        </h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

// Where the part's quantity sits right now (overview.buckets — the same split
// the Scan Part workstation shows). Only non-zero buckets; nothing at all when
// the server sent no split, so an older payload shows no invented zeros.
function Buckets({ buckets, primary }) {
  if (!buckets) return null;
  const shown = BUCKETS.filter((b) => Number(buckets[b.key]) > 0);
  if (!shown.length) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5" aria-label="Quantity by status">
      {primary?.key && (
        <span className={`badge ${statusMeta(primary.key).badge}`} title="The part's headline status">
          {primary.label || statusMeta(primary.key).label}
        </span>
      )}
      {shown.map((b) => (
        <span key={b.key}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-0.5 text-[11px] text-slate-600 dark:border-navy-700 dark:text-slate-300">
          <span className={`h-1.5 w-1.5 rounded-full ${statusMeta(b.status).dot}`} aria-hidden="true" />
          {b.label}
          <b className="font-semibold tabular text-slate-800 dark:text-white">{num(buckets[b.key])}</b>
        </span>
      ))}
    </div>
  );
}

function Tile({ label, value, tone = "", sub }) {
  return (
    <div className="rounded-lg border border-slate-200 px-3 py-2 dark:border-navy-700">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-lg font-bold tabular leading-tight text-slate-900 dark:text-white ${tone}`}>{value}</p>
      {sub && <p className="text-[10px] text-slate-400">{sub}</p>}
    </div>
  );
}

export default function PartDrawer({ partId, onClose }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canCount = useCan("store_stock", "edit");
  // Printing is gated like POST /barcode/print (any-of scan_part / store_stock /
  // part_master "edit"). The browser print runs BEFORE that call records it, so
  // a user who cannot record a print must not be able to start one — else a
  // label comes out with no print history behind it (spec 8). Each hook is
  // called on every render, never inside a short-circuit.
  const canPrintScan = useCan("scan_part", "edit");
  const canPrintStock = useCan("store_stock", "edit");
  const canPrintMaster = useCan("part_master", "edit");
  const canPrint = canPrintScan || canPrintStock || canPrintMaster;
  const [counting, setCounting] = useState(false);
  const [draft, setDraft] = useState("");
  const [printing, setPrinting] = useState(false);
  const [tracing, setTracing] = useState(false);

  const { data: ov, isPending, isError, refetch } = useQuery({
    queryKey: ["stock", "part-overview", partId],
    queryFn: () => spareStockService.partOverview(partId).then((r) => r.data.data),
    enabled: partId != null,
  });

  const go = (to) => { onClose(); navigate(to); };
  const saveCount = async () => {
    const qty = Number(draft);
    if (draft === "" || Number.isNaN(qty) || qty < 0) { toast.error("Enter a quantity of zero or more"); return; }
    try {
      await spareStockService.setQuantity(partId, {
        qty_on_hand: qty,
        txn_type: ov.stock.qty_on_hand == null ? "OPENING" : "ADJUSTMENT",
        remarks: ov.stock.qty_on_hand == null ? "Counted from the part drawer" : "Recount from the part drawer",
      });
      toast.success(`${ov.part.part_no} set to ${qty}`);
      setCounting(false);
      invalidateStock(qc);
    } catch { /* interceptor toasts */ }
  };

  const p = ov?.part;
  const st = ov?.stock;
  const loc = splitLocation(ov?.location?.location);
  return (
    <>
      <Modal open={partId != null} onClose={onClose} variant="drawer" size="xl"
        title={p ? `${p.part_no} — ${p.part_name || ""}` : "Part"}
        footer={p && (
          <>
            <button type="button" className="btn-secondary" onClick={() => go(`/spare-part-history?part_id=${partId}`)}>
              <History size={14} aria-hidden="true" /> Part Ledger
            </button>
            <button type="button" className="btn-secondary" onClick={() => setTracing(true)}>
              <Route size={14} aria-hidden="true" /> Trace
            </button>
            {canPrint && (
              <button type="button" className="btn-secondary" onClick={() => setPrinting(true)}>
                <Printer size={14} aria-hidden="true" /> Label
              </button>
            )}
            {/* Deep link: Scan Part opens on this very part (contract), so the
                operator lands on its status and actions without re-scanning. */}
            <button type="button" className="btn-primary" onClick={() => go(`/scan-part?part=${partId}`)}
              title="Issue, receive, return, inspect and RGP are done on the Scan Part workstation">
              <ScanBarcode size={14} aria-hidden="true" /> Open in Scan Part
            </button>
          </>
        )}>
        {isPending ? (
          <div className="space-y-3">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-12 w-full" />)}</div>
        ) : isError || !ov ? (
          <div className="py-10 text-center text-sm text-slate-500">
            Couldn&apos;t load this part.{" "}
            <button type="button" onClick={() => refetch()} className="font-medium text-toyotared hover:underline">Retry</button>
          </div>
        ) : (
          <div className="space-y-4">
            {/* identity */}
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              <Badge status={st.status} />
              {p.type && <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-navy-800">{p.type}</span>}
              {ov.location.section && <span className="rounded bg-slate-100 px-1.5 py-0.5 dark:bg-navy-800">{ov.location.section}</span>}
              <span>UoM {p.uom || "—"}</span>
              <span>Rate {money(p.unit_price)}</span>
              {p.old_part_no && <span>Ref {p.old_part_no}</span>}
              {!p.is_active && <span className="font-semibold text-rose-600">Inactive</span>}
            </div>

            {ov.alerts.length > 0 && (
              <ul className="space-y-1.5" aria-label="Alerts">
                {ov.alerts.map((a) => {
                  const s = SEV[a.severity] || SEV.info;
                  return (
                    <li key={a.label} className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs ${s.cls}`}>
                      <s.Icon size={14} className="mt-px shrink-0" aria-hidden="true" />
                      <span><b className="font-semibold">{a.label}</b> — {a.detail}</span>
                    </li>
                  );
                })}
              </ul>
            )}

            <Section title="Stock" icon={Database}
              aside={canCount && !counting && (
                <button type="button" onClick={() => { setCounting(true); setDraft(st.qty_on_hand == null ? "" : String(st.qty_on_hand)); }}
                  className="text-xs font-semibold text-toyotared hover:underline">Count</button>
              )}>
              {counting && (
                <div className="mb-3 flex items-center gap-2">
                  <input autoFocus type="number" min="0" step="any" value={draft} aria-label="Counted quantity"
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") saveCount(); if (e.key === "Escape") setCounting(false); }}
                    className="input-field w-32 py-1.5 text-right" />
                  <button type="button" className="btn-primary py-1.5" onClick={saveCount}>Save count</button>
                  <button type="button" className="text-xs text-slate-500" onClick={() => setCounting(false)}>Cancel</button>
                </div>
              )}
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                <Tile label="In stock" value={st.qty_on_hand == null ? "—" : num(st.qty_on_hand)}
                  sub={st.qty_on_hand == null ? "never counted" : p.uom} />
                <Tile label="Min" value={num(st.min)} />
                <Tile label="Reorder" value={st.reorder == null ? "—" : num(st.reorder)} />
                <Tile label="Max" value={st.max == null ? "—" : num(st.max)} />
                <Tile label="Value" value={st.stock_value == null ? "—" : money(st.stock_value)} />
              </div>
              <Buckets buckets={ov.buckets} primary={ov.primary_status} />
              <p className="mt-2 text-[11px] text-slate-400">
                {st.shortfall != null && <>Short of max by <b>{num(st.shortfall)}</b> · </>}
                {/* The opening upload loaded quantities without a count date, so a
                    counted part can have no date — say "not recorded", not "never". */}
                Last counted {st.last_counted_at ? fmtStamp(st.last_counted_at)
                  : st.qty_on_hand == null ? "never" : "— date not recorded"} · Reserved: {st.reserved_note.toLowerCase()}
              </p>
            </Section>

            <Section title="Location" icon={MapPin}>
              <div className="grid grid-cols-3 gap-2">
                <Tile label="Section" value={ov.location.section || "—"} tone="!text-sm" />
                <Tile label="Rack" value={loc.rack || "—"} tone="!text-sm" />
                <Tile label="Shelf · Bin" value={loc.bin || "—"} tone="!text-sm" />
              </div>
              {ov.location.rework_location && (
                <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">Rework location: {ov.location.rework_location}</p>
              )}
            </Section>

            <Section title="Consumption (issued)">
              <div className="grid grid-cols-4 gap-2">
                <Tile label="Today" value={num(ov.consumption.today)} tone="!text-base" />
                <Tile label="7 days" value={num(ov.consumption.week)} tone="!text-base" />
                <Tile label="This month" value={num(ov.consumption.month)} tone="!text-base" />
                <Tile label="Last month" value={num(ov.consumption.previous_month)} tone="!text-base" />
              </div>
              <div className="mt-2 h-24">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={ov.consumption.trend} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                    <XAxis dataKey="month" tick={{ fontSize: 9 }} tickFormatter={(m) => m.slice(5)} interval={0} />
                    <Tooltip formatter={(v) => [num(v), "issued"]} />
                    <Bar dataKey="qty" fill="#6366f1" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <p className="text-[11px] text-slate-400">
                {ov.consumption.issues ? `${ov.consumption.issues} issue(s); last ${fmtStamp(ov.consumption.last_issue_at)}.` : "No issue recorded."}
                {/* ledger_since is the first ledger row's UTC created_at — mark it UTC
                    so the plant-local day is shown, not the UTC one. */}
                {ov.consumption.ledger_since && ` The app's ledger starts ${fmtDate(parseServerTime(ov.consumption.ledger_since))} — earlier months are not in it.`}
              </p>
            </Section>

            <Section title="ERP vs physical" icon={Database}>
              {ov.erp.state === "NONE" ? (
                <p className="text-xs text-slate-500">ERP has not reported a quantity for this part.</p>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <Tile label="ERP qty" value={num(ov.erp.erp_qty)} tone="!text-base" />
                    <Tile label="Physical" value={ov.erp.physical_qty == null ? "—" : num(ov.erp.physical_qty)} tone="!text-base" />
                    <Tile label="Difference" value={ov.erp.difference == null ? "—" : num(ov.erp.difference)}
                      tone={`!text-base ${ov.erp.difference ? "!text-rose-600" : ""}`} />
                  </div>
                  <p className={`mt-1 text-[11px] ${ov.erp.state === "STALE" ? "text-amber-600" : "text-slate-400"}`}>
                    ERP snapshot {ov.erp.state}{ov.erp.synced_at ? ` · ${fmtStamp(ov.erp.synced_at)}` : ""}
                    {ov.erp.age_hours != null && ov.erp.age_hours >= 24 ? ` (${Math.floor(ov.erp.age_hours / 24)} d old)` : ""}
                  </p>
                </>
              )}
            </Section>

            <Section title="Suppliers (from gate entries)" icon={Truck}>
              {ov.suppliers.length === 0 ? (
                <p className="text-xs text-slate-500">Never seen at the gate — no supplier on record.</p>
              ) : (
                <ul className="space-y-1 text-xs">
                  {ov.suppliers.map((s) => (
                    <li key={`${s.ven_cd}-${s.ven_name}`} className="flex justify-between gap-2">
                      <span className="min-w-0 truncate text-slate-700 dark:text-slate-200">{s.ven_name} <span className="text-slate-400">{s.ven_cd}</span></span>
                      <span className="shrink-0 tabular text-slate-500">{s.arrivals}× · last {fmtDate(s.last_dt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title="Recent transactions" icon={History}
              aside={<button type="button" onClick={() => go(`/spare-part-history?part_id=${partId}`)} className="text-xs font-semibold text-toyotared hover:underline">Full ledger</button>}>
              {ov.transactions.length === 0 ? (
                <p className="text-xs text-slate-500">No movement recorded yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100 text-xs dark:divide-navy-800">
                  {ov.transactions.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-2 py-1.5">
                      <span className="w-28 shrink-0 tabular text-slate-500">{fmtStamp(t.at)}</span>
                      <span className={`w-20 shrink-0 font-semibold ${TXN_TONE[t.txn_type] || ""}`}>{t.txn_type}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-500">
                        {[t.department, t.issued_to, t.machine, t.die_no && `Die ${t.die_no}`, t.reference]
                          .filter(Boolean).join(" · ") || t.remarks || ""}
                      </span>
                      <span className="w-14 shrink-0 text-right font-semibold tabular">{t.qty_delta > 0 ? "+" : ""}{num(t.qty_delta)}</span>
                      <span className="w-12 shrink-0 text-right tabular text-slate-400">{num(t.balance_after)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <CircleCheck size={12} aria-hidden="true" />
              Label: {ov.label.labels_printed ? `${ov.label.labels_printed} print(s) recorded` : "none printed yet"}
              {ov.label.mapped_barcodes ? ` · ${ov.label.mapped_barcodes} supplier barcode(s) mapped` : ""}
            </p>
          </div>
        )}
      </Modal>
      {/* The label carries Part No + description + location (spec 3), so the
          location goes in with the part. No source: the modal picks Reprint
          when the part was printed before, else Part Master. Mounted only for
          a user who may record the print (see canPrint). */}
      {p && printing && canPrint && (
        <PrintBarcodeModal open
          part={{ id: p.id, part_no: p.part_no, part_name: p.part_name, is_active: p.is_active,
            location: ov.location?.location ?? p.location ?? null }}
          onClose={() => setPrinting(false)}
          onPrinted={() => invalidateStock(qc)} />
      )}
      {p && tracing && <Traceability part={{ id: p.id, part_no: p.part_no }} onClose={() => setTracing(false)} />}
    </>
  );
}
