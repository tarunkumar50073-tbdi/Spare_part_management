import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, ChevronRight, CircleCheckBig, CircleX, LoaderCircle, PackageOpen, Printer, RotateCcw, Search,
  TriangleAlert, Truck, X,
} from "lucide-react";
import Modal from "../Modal";
import PrintSteps from "./PrintSteps";
import PrinterStatus from "./PrinterStatus";
import { usePrinterStatus } from "./usePrinterStatus";
import { useLabelConfig } from "./useLabelConfig";
import ErpAsOf from "../scan/ErpAsOf.jsx";
import { barcodeService } from "../../services/barcodeService";
import { buildLotTagsHtml, labelSymbology, printLabels } from "../../utils/barcodeRender";
import { PRINT_SOURCE, gatePrintMeta, normGateNo } from "../../lib/scanStatus";
import { fmtDate, num } from "../../lib/format";

// QR labels for material that arrived at the gate — the primary way of Scan
// Part's Receive & Label mode (the user's ask: "gate entry se label print").
//
// The ERP gate entries (a read-only mirror, with its freshness said) that
// carry Spare Parts Store items are listed newest first. Opening one lists its
// items with the gate qty as each part's label count (editable, 1..100); the
// chosen parts' labels then go out as ONE print job:
//
//   [Print N labels] -> Confirm (items + copies, total, printer + its honest
//   status, source "Gate Entry <no>", a reprint reason when a chosen part has
//   labels recorded for this gate entry already) -> [Confirm & Print] -> the
//   browser print dialog -> "Did the labels print correctly?" -> ONLY a Yes
//   records them (POST /gate-labels/print) -> "N labels printed" and the list
//   refreshes. A No records nothing.
//
// The label itself is the part's usual one (QR = Part No. only + Part No. +
// description + location). Printing adds no stock and completes no GRN or
// quality step (spec 9).
//
//   <GateEntryLabels storeCode canPrint openRequest? onEntries? onRelease? />
//
// canPrint     may print + record labels (edit on Scan Part, Store Stock or
//              Part Master — the server's rule)
// openRequest  { no } — open that gate entry (a gun scan of its no., the
//              ?gate= link); a new object asks again. One that is not in the
//              list is looked for over the last 90 days.
// onEntries    (entries) => void — the entries now listed, so the page can
//              tell a scanned gate entry no. from a part's code
// onRelease    hands the caret back to the scanner gun after a click here

const DAY_WINDOWS = [7, 30, 90];
const DEFAULT_DAYS = 30;
const WIDEST_DAYS = DAY_WINDOWS[DAY_WINDOWS.length - 1];
const LIST_LIMIT = 100;         // entries the server returns at most
const MAX_TOTAL = 500;          // tags in one print job (the server's limit)
const REASON_MAX = 255;
const SEARCH_DELAY_MS = 300;
// Answers where the server looked at the print and said no. Sending the same
// record again gets the same answer, so the operator is not told a retry helps.
const REFUSED_STATUSES = new Set([400, 403, 404, 409, 422]);
const STEPS = ["Tags", "Confirm", "Print", "Done"];
const STEP_INDEX = { confirm: 1, verify: 2, done: 3, notPrinted: 3 };

const plural = (n, word) => `${Number(n).toLocaleString("en-IN")} ${word}${Number(n) === 1 ? "" : "s"}`;
// The gate time is the plant's own clock as ERP wrote it — shown as given,
// never converted.
const when = (e) => [e?.gate_entry_dt ? fmtDate(e.gate_entry_dt) : null, e?.gate_entry_time || null]
  .filter(Boolean).join(" · ") || "Date not recorded";
const vendorOf = (e) => [e?.ven_name, e?.ven_cd].filter(Boolean).join(" · ") || "Vendor not recorded";

function Detail({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <dt className="shrink-0 text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-slate-800 dark:text-slate-100">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm -> print -> "did it print?" -> record. `items` is frozen when the
// dialog opens: a background refresh of the list never changes what the
// operator confirmed.
function GatePrintDialog({ storeCode, entry, items, config, onClose, onRecorded }) {
  const qc = useQueryClient();
  const [step, setStep] = useState("confirm");
  const [reason, setReason] = useState("");
  const [reasonTried, setReasonTried] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState(null);
  const [result, setResult] = useState(null);
  // What went to the printer, frozen at Confirm & Print: a Yes records exactly this.
  const [job, setJob] = useState(null);
  // Each step starts at the top of the dialog, not where the last one was scrolled to.
  const bodyRef = useRef(null);
  useEffect(() => { bodyRef.current?.closest("[role=dialog]")?.scrollTo?.({ top: 0 }); }, [step]);

  const printerQ = usePrinterStatus();
  const printerName = printerQ.data?.name || null;

  // Stable close (Modal re-runs its focus effect when onClose changes); no
  // closing while a print is being recorded.
  const onCloseRef = useRef(onClose);
  const recordingRef = useRef(false);
  useEffect(() => { onCloseRef.current = onClose; recordingRef.current = recording; });
  const close = useCallback(() => { if (!recordingRef.current) onCloseRef.current?.(); }, []);

  const reprints = items.filter((it) => Number(it.printed_copies) > 0);
  const needsReason = reprints.length > 0;
  const reasonMissing = needsReason && !reason.trim();
  // One lot tag (the QC receiving form) per part; the lot qty is a field on the
  // form, not a copy count.
  const total = items.length;
  const sourceLabel = `${PRINT_SOURCE.GATE_ENTRY} ${entry.gate_entry_no}`;

  const confirmAndPrint = () => {
    if (reasonMissing) { setReasonTried(true); return; }
    printLabels(buildLotTagsHtml(items.map((it) => ({
      part_no: it.part_no, part_name: it.part_name, lot_qty: it.qty, uom: it.uom,
      location: it.location, supplier: entry.ven_name, specification: it.specification,
      gate_no: entry.gate_entry_no, gate_date: entry.gate_entry_dt,
    })), config));
    setJob({
      items: items.map((it) => ({ part_id: it.part_id, copies: 1 })),
      total, printerName, reason: needsReason ? reason.trim() : undefined,
    });
    setRecordError(null);
    setStep("verify");
  };

  const recordPrinted = async () => {
    if (!job) return;
    setRecording(true);
    setRecordError(null);
    try {
      const res = await barcodeService.printGateLabels({
        store_code: storeCode,
        gate_entry_no: entry.gate_entry_no,
        items: job.items,
        printer_name: job.printerName || undefined,
        reason: job.reason,
      }, { silent: true });
      const d = res.data.data || {};
      const printed = d.printed || [];
      const done = {
        ...d,
        labels: printed.reduce((s, p) => s + (Number(p.copies) || 0), 0),
        parts: printed.length,
        reprinted: printed.filter((p) => p.is_reprint).length,
      };
      setResult(done);
      setStep("done");
      // The list's printed counts, the parts' label records — all "stock".
      qc.invalidateQueries({ queryKey: ["stock"] });
      onRecorded?.(done);
    } catch (e) {
      setRecordError({
        message: e?.response?.data?.message || e?.message || "Could not record the print",
        refused: REFUSED_STATUSES.has(e?.response?.status),
      });
    } finally {
      setRecording(false);
    }
  };

  let footer;
  if (step === "confirm") {
    footer = (
      <>
        <button type="button" className="btn-secondary" onClick={close}>Cancel</button>
        <button type="button" className="btn-primary" onClick={confirmAndPrint}>
          <Printer size={16} aria-hidden="true" /> Confirm &amp; Print
        </button>
      </>
    );
  } else if (step === "verify") {
    footer = (
      <>
        <button type="button" className="btn-secondary" onClick={() => setStep("notPrinted")} disabled={recording}>
          <CircleX size={16} aria-hidden="true" /> No, not printed
        </button>
        <button type="button" className="btn-primary" onClick={recordPrinted} disabled={recording}>
          {recording
            ? <><LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> Recording…</>
            : <><CircleCheckBig size={16} aria-hidden="true" /> {recordError ? "Yes, printed — try again" : "Yes, printed"}</>}
        </button>
      </>
    );
  } else if (step === "notPrinted") {
    footer = (
      <>
        <button type="button" className="btn-secondary" onClick={close}>Close</button>
        <button type="button" className="btn-primary" onClick={() => setStep("confirm")}>
          <Printer size={16} aria-hidden="true" /> Print again
        </button>
      </>
    );
  } else {
    footer = <button type="button" className="btn-primary" onClick={close}>Done</button>;
  }

  const title = step === "confirm"
    ? `Confirm Lot Tag Printing — Gate Entry ${entry.gate_entry_no}`
    : `Lot Tag Printing — Gate Entry ${entry.gate_entry_no}`;

  return (
    <Modal open onClose={close} title={title} footer={footer}>
      <div ref={bodyRef} className="space-y-4">
        <PrintSteps steps={STEPS} current={STEP_INDEX[step]} />

        {step === "confirm" && (
          <>
            <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-navy-800">
              <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto dark:divide-navy-800" aria-label="Tags to print">
                {items.map((it) => (
                  <li key={it.part_id} className="flex items-start justify-between gap-3 px-3 py-2">
                    <span className="min-w-0">
                      <span className="block break-all font-mono text-sm font-semibold text-slate-800 dark:text-white">{it.part_no}</span>
                      <span className="block truncate text-[11px] text-slate-500 dark:text-slate-400">{it.part_name || "No description"}</span>
                      {Number(it.printed_copies) > 0 && (
                        <span className="block text-[11px] text-amber-700 dark:text-amber-300">A tag was printed before for this gate entry</span>
                      )}
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-base font-bold tabular text-slate-800 dark:text-white">
                        {num(it.qty)}{it.uom ? <span className="text-xs font-normal text-slate-500 dark:text-slate-400"> {it.uom}</span> : null}
                      </span>
                      <span className="block text-[10px] uppercase tracking-wide text-slate-400">lot qty · 1 tag</span>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-navy-800 dark:bg-navy-800/60">
                <span className="text-slate-600 dark:text-slate-300">Total — {plural(items.length, "part")}</span>
                <b className="tabular text-slate-800 dark:text-white">{plural(total, "tag")}</b>
              </div>
            </div>

            <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200 px-3 dark:divide-navy-800 dark:border-navy-800">
              <Detail label="Gate entry">
                <span className="font-mono">{entry.gate_entry_no}</span>
                <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">{when(entry)}</span>
              </Detail>
              <Detail label="Vendor">{vendorOf(entry)}</Detail>
              <Detail label="Source">{sourceLabel}</Detail>
              <Detail label="Printer">
                <span className="flex flex-col items-end gap-1">
                  <span>{printerName || "Browser print dialog"}</span>
                  <PrinterStatus />
                </span>
              </Detail>
            </dl>

            {needsReason && (
              <div className="space-y-1.5">
                <label htmlFor="gate-reprint-reason" className="kpi-label block">
                  Reprint reason <span className="text-toyotared">*</span>
                </label>
                <textarea
                  id="gate-reprint-reason"
                  rows={2}
                  maxLength={REASON_MAX}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why these tags are printed again — e.g. tags torn, faded, lost"
                  className={`input-field resize-none ${reasonTried && reasonMissing ? "border-rose-400 focus:ring-rose-300" : ""}`}
                  aria-invalid={reasonTried && reasonMissing}
                  aria-describedby="gate-reprint-why"
                  autoFocus
                />
                <div className="flex justify-between gap-3 text-[11px]">
                  <span id="gate-reprint-why" className={reasonTried && reasonMissing ? "text-rose-600 dark:text-rose-400" : "text-slate-500 dark:text-slate-400"}>
                    {reasonTried && reasonMissing
                      ? "A reprint reason is required"
                      : `${plural(reprints.length, "part")} already ${reprints.length === 1 ? "has" : "have"} a tag recorded for this gate entry — printing ${reprints.length === 1 ? "it" : "them"} again is a reprint.`}
                  </span>
                  <span className="shrink-0 tabular text-slate-400">{reason.length} / {REASON_MAX}</span>
                </div>
              </div>
            )}

            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              All {plural(total, "tag")} go out as one print job through the browser's print dialog — choose{" "}
              {printerName ? <b>{printerName}</b> : "the label printer"} there. Printing adds no stock and completes no
              GRN or quality step.
            </p>
          </>
        )}

        {step === "verify" && (
          <div className="space-y-3 py-2 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300">
              <Printer size={22} aria-hidden="true" />
            </span>
            <p className="text-base font-semibold text-slate-800 dark:text-white">Did the tags print correctly?</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Check all {plural(job?.total ?? total, "tag")} for {plural(items.length, "part")} came out and the{" "}
              {labelSymbology(config) === "QR" ? "QRs are" : "barcodes are"} sharp. Only a confirmed print is recorded in the print history — if some did not come out, choose No:
              nothing is recorded and you can print again.
            </p>
            {recordError && (
              <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-left text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                <b>Not recorded{recordError.refused ? "" : " yet"}:</b>{" "}
                {String(recordError.message).replace(/\.\s*$/, "")}.{" "}
                {recordError.refused
                  ? "The tags did print, but the server refused to record them, so they are not in the print history. Trying again will not help until that is fixed — tell the store admin."
                  : "The tags are printed — try recording them again."}
              </div>
            )}
          </div>
        )}

        {step === "done" && result && (
          <div className="space-y-2 py-2 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
              <CircleCheckBig size={24} aria-hidden="true" />
            </span>
            <p className="text-base font-semibold text-emerald-700 dark:text-emerald-300">{plural(result.labels, "tag")} printed</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Recorded in print history — Gate Entry {result.gate_entry_no || entry.gate_entry_no} ·{" "}
              {plural(result.parts, "part")}
              {result.reprinted > 0 ? ` (${result.reprinted} reprinted)` : ""}
              {job?.printerName ? ` · ${job.printerName}` : ""}
            </p>
            <p className="text-[11px] text-slate-400">No stock was added — the GRN and quality clearance happen in ERP.</p>
          </div>
        )}

        {step === "notPrinted" && (
          <div className="space-y-2 py-2 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-slate-100 text-slate-500 dark:bg-navy-800 dark:text-slate-300">
              <CircleX size={24} aria-hidden="true" />
            </span>
            <p className="text-base font-semibold text-slate-800 dark:text-white">Nothing recorded — you can print again</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Check the printer is on, has labels loaded and was the one picked in the print dialog.
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// One gate entry, opened: its spare items with the label count per part.

function ItemRow({ row, canPrint, onPick }) {
  const id = `gate-item-${row.part_id}`;
  const off = !canPrint || !row.active;
  return (
    <li className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 px-4 py-3 ${
      row.chosen ? "" : "bg-slate-50/60 dark:bg-navy-800/30"}`}>
      <input id={id} type="checkbox" className="mt-1 h-4 w-4 cursor-pointer accent-toyotared disabled:cursor-not-allowed"
        checked={row.chosen} disabled={off} onChange={(e) => onPick(row.part_id, e.target.checked)} />
      <label htmlFor={id} className={`min-w-0 ${off ? "" : "cursor-pointer"}`}>
        <span className="block break-all font-mono text-sm font-semibold text-slate-800 dark:text-white">{row.part_no}</span>
        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{row.part_name || "No description"}</span>
        {!row.active && (
          <span className="mt-1 block"><span className="badge badge-danger">Inactive part — no tag</span></span>
        )}
      </label>
      {/* One lot tag per part — the lot qty (the gate qty) is printed on the
          tag, so there is no per-part copy count. */}
      <div className="text-right text-xs">
        <p className="kpi-label">Lot qty</p>
        <p className="text-base font-bold tabular text-slate-800 dark:text-white">
          {num(row.qty)}{row.uom ? <span className="text-xs font-normal text-slate-500 dark:text-slate-400"> {row.uom}</span> : null}
        </p>
        <p className={`text-[11px] ${row.printed ? "text-emerald-700 dark:text-emerald-300" : "text-slate-400"}`}>
          {row.printed ? "tag printed" : "1 tag"}
        </p>
      </div>
    </li>
  );
}

function EntryDetail({ entry, canPrint, configReady, picked, lastPrinted, onPick, onPickAll, onPrint, onBack, onRelease }) {
  const rows = useMemo(() => (entry.items || []).map((it) => {
    const active = it.is_active !== false;
    const printed = Number(it.printed_copies) > 0;
    return {
      ...it, active, printed,
      // Ticked by default only while the part has no tag for this gate entry.
      chosen: active && (picked[it.part_id] ?? !printed),
    };
  }), [entry, picked]);
  const selectable = rows.filter((r) => r.active);
  const chosen = rows.filter((r) => r.chosen);
  // One tag per chosen part — the lot qty is printed on the tag.
  const total = chosen.length;
  const allChosen = selectable.length > 0 && selectable.every((r) => r.chosen);
  const someChosen = chosen.length > 0;
  const allRef = useRef(null);
  useEffect(() => { if (allRef.current) allRef.current.indeterminate = someChosen && !allChosen; });
  const tooMany = total > MAX_TOTAL;
  const canStart = canPrint && chosen.length > 0 && !tooMany && configReady;
  const meta = gatePrintMeta(entry.printed_state);

  return (
    <div>
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2 dark:border-navy-800">
        <button type="button" onClick={onBack}
          className="inline-flex items-center gap-1 rounded text-xs font-semibold text-slate-500 hover:text-toyotared focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/40 dark:text-slate-400">
          <ArrowLeft size={14} aria-hidden="true" /> All gate entries
        </button>
        <span className={`badge ${meta.badge}`}>{meta.label}</span>
      </div>

      <div className="border-b border-slate-100 px-4 py-3 dark:border-navy-800">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="kpi-label">Gate entry</span>
          <span className="break-all font-mono text-base font-bold text-slate-800 dark:text-white">{entry.gate_entry_no}</span>
          <span className="text-xs text-slate-500 dark:text-slate-400">{when(entry)}</span>
        </p>
        <p className="mt-0.5 truncate text-sm text-slate-600 dark:text-slate-300">{vendorOf(entry)}</p>
        <p className="text-[11px] text-slate-400">
          Bill {entry.bill_no || "—"} · PO {entry.po_no || "—"} · {plural(entry.spare_items ?? rows.length, "spare item")}
        </p>
      </div>

      {lastPrinted && (
        <div role="status" className="flex items-start gap-2 border-b border-emerald-100 bg-emerald-50 px-4 py-2 text-xs text-emerald-800 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200">
          <CircleCheckBig size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            <b>{plural(lastPrinted.labels, "tag")} printed</b> for {plural(lastPrinted.parts, "part")} — recorded in print history.
            {lastPrinted.parts < rows.length ? " Tick any other part to print its tag too." : ""}
          </span>
        </div>
      )}

      {!canPrint && (
        <p className="border-b border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-navy-800 dark:text-slate-400">
          Printing labels needs edit rights on Scan Part, Store Stock or Part Master — you can look, not print.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-slate-400">No Spare Parts Store item on this gate entry.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2 dark:border-navy-800">
            <label className={`inline-flex items-center gap-2 text-xs font-semibold text-slate-600 dark:text-slate-300 ${
              canPrint && selectable.length ? "cursor-pointer" : ""}`}>
              <input ref={allRef} type="checkbox" className="h-4 w-4 cursor-pointer accent-toyotared disabled:cursor-not-allowed"
                checked={allChosen} disabled={!canPrint || !selectable.length}
                onChange={() => onPickAll(selectable.map((r) => r.part_id), !allChosen)} />
              Select all
            </label>
            <span className="text-[11px] text-slate-400">One tag per part — the lot qty prints on the tag</span>
          </div>
          <ul className="max-h-[26rem] divide-y divide-slate-100 overflow-y-auto dark:divide-navy-800" aria-label={`Items of gate entry ${entry.gate_entry_no}`}>
            {rows.map((r) => (
              <ItemRow key={r.part_id} row={r} canPrint={canPrint} onPick={onPick} />
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 dark:border-navy-800">
            <div className="min-w-0 text-sm text-slate-600 dark:text-slate-300">
              <b className="tabular text-slate-800 dark:text-white">{chosen.length}</b> of {plural(rows.length, "part")} ·{" "}
              <b className="tabular text-slate-800 dark:text-white">{plural(total, "tag")}</b>
              {tooMany && (
                <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">
                  At most {MAX_TOTAL} tags in one print — untick some parts and print them next.
                </p>
              )}
            </div>
            <button type="button" className="btn-primary" disabled={!canStart}
              onClick={() => onPrint(entry, chosen)}>
              <Printer size={16} aria-hidden="true" /> Print {plural(total, "lot tag")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function EntryRow({ entry, onOpen }) {
  const meta = gatePrintMeta(entry.printed_state);
  return (
    <li>
      <button type="button" onClick={() => onOpen(entry)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none dark:hover:bg-navy-800/60 dark:focus-visible:bg-navy-800/60">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300">
          <Truck size={16} aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="break-all font-mono text-sm font-bold text-slate-800 dark:text-white">{entry.gate_entry_no}</span>
            <span className="text-[11px] text-slate-400">{when(entry)}</span>
          </span>
          <span className="block truncate text-xs text-slate-600 dark:text-slate-300">{vendorOf(entry)}</span>
          <span className="block text-[11px] text-slate-500 dark:text-slate-400">
            <b className="tabular font-semibold">{num(entry.spare_items)}</b> spare item{Number(entry.spare_items) === 1 ? "" : "s"} ·{" "}
            <b className="tabular font-semibold">{num(entry.spare_items)}</b> tag{Number(entry.spare_items) === 1 ? "" : "s"}
          </span>
        </span>
        <span className={`badge ${meta.badge} shrink-0`}>{meta.label}</span>
        <ChevronRight size={16} className="shrink-0 text-slate-400" aria-hidden="true" />
      </button>
    </li>
  );
}

export default function GateEntryLabels({ storeCode, canPrint = false, openRequest = null, onEntries, onRelease }) {
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [text, setText] = useState("");           // the search box as typed
  const [q, setQ] = useState("");                 // what is searched (after a short pause)
  const [openNo, setOpenNo] = useState(null);     // the open entry (normalised no.)
  // { no, raw, notify, searched } — a gate entry to open once the list for it is in.
  const [pending, setPending] = useState(null);
  const [notFound, setNotFound] = useState(null);
  const [picked, setPicked] = useState({});       // part_id -> ticked (overrides the default)
  const [printing, setPrinting] = useState(null); // { entry, items } — frozen for the dialog
  const [lastPrinted, setLastPrinted] = useState(null); // { no, labels, parts }
  // This panel owns the scanner gun now (Receive & Label has no separate gun
  // box): keep the search box focused whenever the list is showing, so a gate
  // entry no. scanned with the gun lands here.
  const searchRef = useRef(null);
  useEffect(() => { if (!openNo && !printing) searchRef.current?.focus(); }, [openNo, printing]);

  useEffect(() => {
    const t = text.trim();
    if (t === q) return undefined;
    const id = setTimeout(() => setQ(t), SEARCH_DELAY_MS);
    return () => clearTimeout(id);
  }, [text, q]);

  // Under "stock": a print here or on another terminal refreshes the counts.
  const listQ = useQuery({
    queryKey: ["stock", "gate-labels", storeCode, days, q],
    queryFn: () => barcodeService.gateLabels(storeCode, { days, q }, { silent: true }).then((r) => r.data.data),
    enabled: Boolean(storeCode),
    placeholderData: keepPreviousData,
  });
  const { config, ready: configReady } = useLabelConfig();
  const data = listQ.data;
  const entries = useMemo(() => data?.entries || [], [data]);
  // The list is the answer for the current window and search (not the
  // previous one kept on screen while it loads).
  const settled = listQ.isSuccess && !listQ.isPlaceholderData && !listQ.isFetching;

  const onEntriesRef = useRef(onEntries);
  useEffect(() => { onEntriesRef.current = onEntries; });
  useEffect(() => { onEntriesRef.current?.(entries); }, [entries]);

  const findEntry = useCallback(
    (no) => entries.find((e) => normGateNo(e.gate_entry_no) === no) || null, [entries]);

  const openEntry = useCallback((no) => {
    setOpenNo(no);
    setPicked({});
    setNotFound(null);
  }, []);

  // A gun scan / link naming a gate entry.
  useEffect(() => {
    const raw = String(openRequest?.no ?? "").trim();
    if (!raw) return;
    setNotFound(null);
    setPending({ no: normGateNo(raw), raw, notify: true, searched: false });
  }, [openRequest]);

  // Open the wanted entry once the list is in: straight away when listed; if
  // not, it is searched for by its no. over the widest window, and said so when
  // it is not there either.
  useEffect(() => {
    if (!pending || !settled) return;
    if (findEntry(pending.no)) {
      setPending(null);
      openEntry(pending.no);
      return;
    }
    if (!pending.searched) {
      setPending({ ...pending, searched: true });
      setOpenNo(null);
      setText(pending.raw);
      setQ(pending.raw);
      setDays(WIDEST_DAYS);
      return;
    }
    setPending(null);
    if (pending.notify) setNotFound(pending.raw);
  }, [pending, settled, findEntry, openEntry]);

  const pickEntry = (e) => {
    openEntry(normGateNo(e.gate_entry_no));
    onRelease?.();
  };
  const back = () => {
    setOpenNo(null);
    onRelease?.();
  };
  const setWindow = (d) => {
    setDays(d);
    onRelease?.();
  };
  // Enter in the search box (typed, or a gun read landing there): search now,
  // and open the entry whose no. it is.
  const onSearchKey = (e) => {
    if (e.key === "Escape") { setText(""); return; }
    if (e.key !== "Enter") return;
    e.preventDefault();
    const raw = text.trim();
    if (!raw) return;
    setQ(raw);
    setPending({ no: normGateNo(raw), raw, notify: false, searched: true });
  };

  // A tick hands the caret back to the gun so the next read is a scan.
  const onPick = useCallback((partId, on) => {
    setPicked((p) => ({ ...p, [partId]: on }));
    onRelease?.();
  }, [onRelease]);
  const onPickAll = useCallback((ids, on) => {
    setPicked((p) => ({ ...p, ...Object.fromEntries(ids.map((id) => [id, on])) }));
    onRelease?.();
  }, [onRelease]);
  // The clear-search and dismiss buttons take themselves off the page, and
  // Retry is disabled while it loads — the focus they had would drop to the
  // page and the next gun read with it.
  const clearSearch = () => {
    setText("");
    setQ("");
    onRelease?.();
  };
  const dismissNotFound = () => {
    setNotFound(null);
    onRelease?.();
  };
  const retry = () => {
    listQ.refetch();
    onRelease?.();
  };

  const startPrint = (entry, rows) => {
    setPrinting({
      entry: {
        gate_entry_no: entry.gate_entry_no, gate_entry_dt: entry.gate_entry_dt, gate_entry_time: entry.gate_entry_time,
        ven_name: entry.ven_name, ven_cd: entry.ven_cd, bill_no: entry.bill_no,
      },
      items: rows.map((r) => ({
        part_id: r.part_id, part_no: r.part_no, part_name: r.part_name, location: r.location,
        qty: r.qty, uom: r.uom, printed_copies: r.printed_copies,
      })),
    });
  };
  const closePrint = useCallback(() => {
    setPrinting(null);
    onRelease?.();
  }, [onRelease]);
  // Recorded: the choices start again from the fresh counts (what was printed
  // is no longer ticked by default).
  const onRecorded = useCallback((done) => {
    setPicked({});
    setLastPrinted({ no: normGateNo(done.gate_entry_no || printing?.entry.gate_entry_no), labels: done.labels, parts: done.parts });
  }, [printing]);

  const entry = openNo ? findEntry(openNo) : null;
  const failed = listQ.isError && !data;

  let body;
  if (openNo && entry) {
    body = (
      <EntryDetail entry={entry} canPrint={canPrint} configReady={configReady} picked={picked}
        lastPrinted={lastPrinted?.no === openNo ? lastPrinted : null}
        onPick={onPick} onPickAll={onPickAll} onPrint={startPrint} onBack={back} onRelease={onRelease} />
    );
  } else if (openNo && (listQ.isFetching || listQ.isPending)) {
    body = (
      <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading the gate entry">
        <div className="skeleton h-14 w-full" />
        <div className="skeleton h-20 w-full" />
      </div>
    );
  } else if (openNo) {
    body = (
      <div className="px-4 py-8 text-center">
        <p className="text-sm text-slate-500 dark:text-slate-400">This gate entry is not in the list any more.</p>
        <button type="button" onClick={back} className="btn-secondary mt-3">
          <ArrowLeft size={15} aria-hidden="true" /> All gate entries
        </button>
      </div>
    );
  } else {
    body = (
      <>
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3 dark:border-navy-800">
          <div className="relative min-w-[12rem] flex-1">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              ref={searchRef}
              type="text"
              value={text}
              onChange={(e) => { setText(e.target.value); setNotFound(null); }}
              onKeyDown={onSearchKey}
              placeholder="Gate entry no., vendor or Part No."
              aria-label="Search gate entries by gate entry no., vendor or Part No."
              autoComplete="off"
              spellCheck={false}
              className="input-field pl-9 pr-9"
            />
            {text && (
              <button type="button" onClick={clearSearch} aria-label="Clear the search"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </div>
          <div role="group" aria-label="Gate entries of the last"
            className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-navy-700 dark:bg-navy-900">
            {DAY_WINDOWS.map((d) => (
              <button key={d} type="button" aria-pressed={days === d} onClick={() => setWindow(d)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${days === d
                  ? "bg-toyotared text-white"
                  : "text-slate-600 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-navy-800"}`}>
                {d} days
              </button>
            ))}
          </div>
        </div>

        {notFound && (
          <div role="alert" className="flex items-start gap-2 border-b border-amber-100 bg-amber-50 px-4 py-2 text-xs text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              Gate entry <b className="font-mono">{notFound}</b> has no Spare Parts Store item in the last {WIDEST_DAYS} days
              of the ERP copy — it may be for another store, older, or not synced from ERP yet.
            </span>
            <button type="button" onClick={dismissNotFound} aria-label="Dismiss"
              className="shrink-0 rounded p-0.5 hover:bg-amber-100 dark:hover:bg-amber-500/10">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
        )}

        {listQ.isPending ? (
          <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading gate entries">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-14 w-full" />)}
          </div>
        ) : failed ? (
          <div role="alert" className="px-4 py-6 text-center text-sm text-rose-600 dark:text-rose-400">
            <p className="font-semibold">Couldn&apos;t load the gate entries.</p>
            {listQ.error?.response?.data?.message && <p className="mt-0.5 text-xs">{listQ.error.response.data.message}</p>}
            <button type="button" className="btn-secondary mt-3" onClick={retry} disabled={listQ.isFetching}>
              <RotateCcw size={15} aria-hidden="true" />{listQ.isFetching ? "Retrying…" : "Retry"}
            </button>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center px-4 py-8 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-slate-100 text-slate-400 dark:bg-navy-800">
              <PackageOpen size={22} aria-hidden="true" />
            </span>
            <p className="mt-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
              No gate entry with Spare Parts Store items{q ? ` matching “${q}”` : ""}
            </p>
            <p className="mt-0.5 max-w-sm text-xs text-slate-500 dark:text-slate-400">
              In the last {days} days of the ERP copy. {days < WIDEST_DAYS ? "Try a longer window, or " : ""}use{" "}
              “Or one part” to label a single part.
            </p>
          </div>
        ) : (
          <>
            <ul className={`max-h-[28rem] divide-y divide-slate-100 overflow-y-auto transition-opacity dark:divide-navy-800 ${
              listQ.isPlaceholderData ? "opacity-60" : ""}`} aria-label="Gate entries with Spare Parts Store items">
              {entries.map((e, i) => <EntryRow key={e.gate_entry_no ?? `row-${i}`} entry={e} onOpen={pickEntry} />)}
            </ul>
            <p className="border-t border-slate-100 px-4 py-2 text-[11px] text-slate-400 dark:border-navy-800">
              {entries.length >= LIST_LIMIT
                ? `Showing the newest ${num(entries.length)} — narrow it down with the search.`
                : `${num(entries.length)} gate ${entries.length === 1 ? "entry" : "entries"} in the last ${days} days`}
            </p>
          </>
        )}
      </>
    );
  }

  return (
    <section className="card overflow-hidden p-0" aria-labelledby="gate-labels-title">
      <header className="border-b border-slate-100 px-4 py-3 dark:border-navy-800">
        <div className="flex items-start gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-toyotared/10 text-toyotared">
            <Truck size={16} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="gate-labels-title" className="text-sm font-semibold text-slate-800 dark:text-white">
              Gate Entry (ERP) — lot tags for material that arrived
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Open a gate entry — or scan its no. with the gun — and print one lot tag per Spare Parts Store part.
              Each tag shows the lot qty that arrived on the gate entry.
            </p>
            {data?.erp && <ErpAsOf erp={data.erp} className="mt-1.5" />}
          </div>
          {listQ.isFetching && !listQ.isPending && (
            <LoaderCircle size={15} className="mt-1 shrink-0 animate-spin text-slate-400" aria-label="Updating" />
          )}
        </div>
      </header>

      {body}

      {printing && (
        <GatePrintDialog storeCode={storeCode} entry={printing.entry} items={printing.items} config={config}
          onClose={closePrint} onRecorded={onRecorded} />
      )}
    </section>
  );
}
