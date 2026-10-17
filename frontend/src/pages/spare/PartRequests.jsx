import React, { useMemo, useState } from "react";
import toast from "react-hot-toast";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Inbox, MapPin, Package, CheckCircle2, XCircle, ScanLine, CheckCheck, RefreshCw, History, Clock, User,
} from "lucide-react";
import Modal from "../../components/Modal.jsx";
import BarcodeScanInput from "../../components/BarcodeScanInput.jsx";
import QtyStepper from "../../components/QtyStepper.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { partRequestService, newIssueToken } from "../../services/partRequestService.js";
import { matchBinScan, partBins } from "../../utils/binLocation.js";
import { num } from "../../lib/format.js";

// Supervisor screen: the live queue of kiosk part-requests and the issuance
// flow. Open a request → SCAN the bin's location QR (Right/Wrong, Confirm is
// blocked until Right) → verify the part + the actual quantity → Confirm Issue.
// The real stock deduction is the existing issue flow; this screen only drives
// it per request and keeps the request status (Issued / Partially Issued).

const STATUS = {
  PENDING: { label: "Pending", cls: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300" },
  PROCESSING: { label: "Processing", cls: "bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-300" },
  PARTIALLY_ISSUED: { label: "Partially Issued", cls: "bg-violet-100 text-violet-800 dark:bg-violet-500/15 dark:text-violet-300" },
  ISSUED: { label: "Issued", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300" },
  CANCELLED: { label: "Cancelled", cls: "bg-slate-200 text-slate-600 dark:bg-navy-700 dark:text-slate-400" },
};
const StatusChip = ({ s }) => (
  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS[s]?.cls || STATUS.PENDING.cls}`}>
    {STATUS[s]?.label || s}
  </span>
);

function IssueModal({ requestId, storeCode, onClose, onDone }) {
  const qc = useQueryClient();
  const { data: req, isPending } = useQuery({
    queryKey: ["part-request", requestId],
    queryFn: () => partRequestService.get(requestId).then((r) => r.data.data),
    enabled: !!requestId,
  });
  const [result, setResult] = useState(null);   // { ok, scanned, bin } (matchBinScan)
  const [qty, setQty] = useState(1);
  const [saving, setSaving] = useState(false);
  const [qtyTouched, setQtyTouched] = useState(false);

  // One issue CLOSES the request: give whatever stock is available, up to the
  // requested quantity (no partial / keep-open). Default = that amount.
  const requested = req ? Number(req.requested_qty) : 0;
  const available = req ? req.available_qty : null;
  const cap = available == null ? requested : Math.max(Math.min(requested, available), 0);
  const issueQty = qtyTouched ? qty : Math.max(cap || 1, 1);
  const short = available != null && cap < requested;   // giving less than requested
  // The bins the part may be taken from: its fresh location and, when it has
  // one, its rework location — the scan is Right at either (matchBinScan).
  const bins = req ? partBins(req.assigned_location, req.rework_location) : [];

  const onScan = (raw) => {
    const code = String(raw || "").trim();
    if (!code || !req) return;
    setResult(matchBinScan(code, bins));
  };

  const canConfirm = result?.ok && available != null && available > 0 && issueQty > 0 && issueQty <= cap && !saving;

  const confirm = async () => {
    if (!canConfirm) return;
    setSaving(true);
    try {
      const row = await partRequestService.issue(requestId, {
        scanned_location: result.scanned, issued_qty: issueQty, token: newIssueToken(),
      }).then((r) => r.data.data);
      toast.success(Number(row.issued_qty) < Number(row.requested_qty)
        ? `Issued ${num(row.issued_qty)}/${num(row.requested_qty)} — ${row.reference_no} closed (short)`
        : `Issued ${num(row.issued_qty)} — ${row.reference_no} done`);
      qc.invalidateQueries({ queryKey: ["part-requests"] });
      onDone?.();
      onClose();
    } catch {
      /* handled globally (wrong location / stock / duplicate) */
    } finally {
      setSaving(false);
    }
  };

  const rows = req ? [
    ["Reference No.", req.reference_no],
    ["Part No.", req.part_no],
    ["Description", req.part_name],
    ["Requested by", `${req.requester_name || "—"}${req.requester_code ? ` (${req.requester_code})` : ""}`],
    ["Department", req.department || "—"],
    ...(bins.length ? bins.map((b) => [b.label ? `${b.label} Location` : "Assigned Location", b.location])
      : [["Assigned Location", "—"]]),
    ["Requested Qty", num(req.requested_qty)],
    ["Available Stock", available == null ? "Not loaded" : `${num(available)}${req.uom ? ` ${req.uom}` : ""}`],
  ] : [];

  return (
    <Modal open onClose={onClose} title={req ? `Issue — ${req.reference_no}` : "Issue"}>
      {isPending || !req ? (
        <div className="skeleton h-48 w-full" />
      ) : (
        <div className="space-y-4">
          <div className="overflow-hidden rounded-lg border border-slate-200 text-sm dark:border-navy-700">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-1.5 last:border-b-0 dark:border-navy-800">
                <span className="text-slate-500 dark:text-slate-400">{k}</span>
                <span className="min-w-0 break-words text-right font-semibold text-slate-800 dark:text-slate-100">{v}</span>
              </div>
            ))}
          </div>

          {available == null && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              Stock data for this part is not loaded — it can't be issued until the stock is loaded.
            </p>
          )}

          {/* Step: scan the bin location QR */}
          <div>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Scan the bin location QR</p>
            <BarcodeScanInput onScan={onScan} placeholder="Scan the rack / bin QR…" />
          </div>

          {result && (
            <div className={`rounded-xl2 p-3 text-center ${result.ok ? "bg-emerald-50 dark:bg-emerald-500/10" : "bg-rose-50 dark:bg-rose-500/10"}`}>
              {result.ok ? (
                <p className="flex items-center justify-center gap-2 text-lg font-extrabold text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 size={22} aria-hidden="true" /> RIGHT LOCATION
                  {result.bin?.label ? ` — ${result.bin.label.toUpperCase()} BIN` : ""}
                </p>
              ) : (
                <>
                  <p className="flex items-center justify-center gap-2 text-lg font-extrabold text-rose-700 dark:text-rose-300">
                    <XCircle size={22} aria-hidden="true" /> WRONG LOCATION
                  </p>
                  <p className="mt-1 text-sm text-rose-800 dark:text-rose-200">
                    Scanned: <b>{result.scanned || "—"}</b> · Correct location:{" "}
                    {bins.length ? bins.map((b, i) => (
                      <React.Fragment key={b.kind}>
                        {i > 0 && " or "}
                        <span className="inline-flex items-center gap-1 font-bold">
                          <MapPin size={13} aria-hidden="true" /> {b.label ? `${b.label} bin ` : ""}{b.location}
                        </span>
                      </React.Fragment>
                    )) : "—"}
                  </p>
                </>
              )}
            </div>
          )}

          {/* Verify + actual quantity (enabled after Right location) */}
          <div className={result?.ok ? "" : "pointer-events-none opacity-50"}>
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Actual issued quantity</p>
            <QtyStepper value={issueQty} onChange={(v) => { setQty(v); setQtyTouched(true); }}
              min={1} max={Math.max(cap, 1)} disabled={!result?.ok || available == null} size="lg" label="Issued quantity" />
            <p className="mt-1 text-xs text-slate-400">
              Requested {num(requested)}{available != null ? `, available ${num(available)}` : ""}. Issue whatever is available and Confirm — the request will <b>close</b>.
            </p>
          </div>

          {result?.ok && short && (
            <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              Stock is less than requested — <b>{num(cap)}</b> will be issued and the request will <b>close</b> (<b>{num(requested - cap)}</b> short).
            </p>
          )}

          <button type="button" onClick={confirm} disabled={!canConfirm}
            className="btn-primary inline-flex w-full items-center justify-center gap-2 !py-2.5 disabled:opacity-50">
            <CheckCheck size={18} aria-hidden="true" /> {saving ? "Issuing…" : "Confirm Issue"}
          </button>
          {!result?.ok && (
            <p className="text-center text-[11px] text-slate-400">Scan the correct location first to enable Confirm.</p>
          )}
        </div>
      )}
    </Modal>
  );
}

export default function PartRequests() {
  const { activeCode } = useStores();
  const storeCode = activeCode || "MAINTENANCE";
  const [tab, setTab] = useState("open");    // open | history
  const [openId, setOpenId] = useState(null);

  const { data: rows = [], isPending, refetch, isFetching } = useQuery({
    queryKey: ["part-requests", storeCode, tab],
    queryFn: () => partRequestService.list(storeCode, tab === "open" ? "open" : "all").then((r) => r.data.data),
    placeholderData: keepPreviousData,
    refetchInterval: tab === "open" ? 12000 : false,   // live queue auto-refreshes
  });

  const issuable = (s) => s === "PENDING" || s === "PROCESSING";
  const empty = !isPending && rows.length === 0;
  const title = useMemo(() => (tab === "open" ? "Pending requests" : "Request history"), [tab]);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800 dark:text-white">Part Requisition</h2>
          <p className="mt-0.5 text-xs text-slate-400">Requisitions from the kiosk — open one, scan the location and issue the part.</p>
        </div>
        <button type="button" onClick={() => refetch()} className="btn-secondary !py-1.5 text-xs">
          <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} aria-hidden="true" /> Refresh
        </button>
      </div>

      <div className="mb-3 inline-flex rounded-lg border border-slate-200 p-0.5 text-sm dark:border-navy-700">
        {[["open", "Open queue", Inbox], ["history", "History", History]].map(([k, label, Icon]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium transition ${tab === k ? "bg-toyotared text-white" : "text-slate-600 dark:text-slate-300"}`}>
            <Icon size={14} aria-hidden="true" /> {label}
          </button>
        ))}
      </div>

      <div className="card p-0">
        {isPending ? (
          <div className="space-y-2 p-4">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-16 w-full" />)}</div>
        ) : empty ? (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <Inbox size={30} className="text-slate-300 dark:text-slate-600" aria-hidden="true" />
            <p className="text-sm text-slate-500 dark:text-slate-400">{tab === "open" ? "No pending requests." : "No requests yet."}</p>
          </div>
        ) : (
          <ul className="divide-y divide-slate-100 dark:divide-navy-800" aria-label={title}>
            {rows.map((r) => {
              const act = issuable(r.status);
              const bins = partBins(r.assigned_location, r.rework_location);
              return (
                <li key={r.id}>
                  <button type="button" disabled={!act && tab === "open"} onClick={() => act && setOpenId(r.id)}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${act ? "hover:bg-slate-50 dark:hover:bg-navy-800/60" : "cursor-default"}`}>
                    <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-toyotared/10 text-toyotared">
                      <Package size={18} aria-hidden="true" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-semibold text-slate-800 dark:text-white">{r.part_no}</p>
                        <StatusChip s={r.status} />
                      </div>
                      <p className="truncate text-xs text-slate-500 dark:text-slate-400">{r.part_name}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-400">
                        <span className="font-mono">{r.reference_no}</span>
                        <span className="inline-flex items-center gap-1"><User size={11} aria-hidden="true" />{r.requester_name || "—"}{r.department ? ` · ${r.department}` : ""}</span>
                        {bins.length ? bins.map((b) => (
                          <span key={b.kind} className="inline-flex items-center gap-1">
                            <MapPin size={11} aria-hidden="true" />{b.label ? `${b.label} ` : ""}{b.location}
                          </span>
                        )) : <span className="inline-flex items-center gap-1"><MapPin size={11} aria-hidden="true" />—</span>}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-bold text-slate-800 dark:text-white">{num(r.requested_qty)}</p>
                      <p className="text-[11px] text-slate-400">requested</p>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {openId != null && (
        <IssueModal requestId={openId} storeCode={storeCode} onClose={() => setOpenId(null)} onDone={() => refetch()} />
      )}
    </div>
  );
}
