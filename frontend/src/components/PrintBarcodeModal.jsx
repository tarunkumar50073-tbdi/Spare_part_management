import React, { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheckBig, CircleX, Eye, EyeOff, History, LoaderCircle, Printer, RefreshCw, TriangleAlert,
} from "lucide-react";
import Modal from "./Modal";
import BarcodeLabel from "./BarcodeLabel";
import QtyStepper from "./QtyStepper";
import PrintSteps from "./label/PrintSteps";
import PrinterStatus, { PrinterPicker } from "./label/PrinterStatus";
import { usePrinterStatus } from "./label/usePrinterStatus";
import { useLabelConfig } from "./label/useLabelConfig";
import { useBoxWidth } from "./label/useBoxWidth";
import { barcodeService } from "../services/barcodeService";
import { buildLabelHtml, labelSymbology, printLabels } from "../utils/barcodeRender";
import { PRINT_SOURCE } from "../lib/scanStatus";
import { fmtStamp } from "../lib/format";

// Internal QR label — generate, confirm, print, and record (spec 3 / 7 / 8 / 29).
//
//   <PrintBarcodeModal part={{ id | part_id, part_no, part_name, location, is_active? }}
//                      source? onClose onPrinted? open? config? />
//
// 1 "Generate Internal QR": label preview, Label Quantity, Printer + honest
//   status, [Preview] (large) and [Print Label].
// 2 "Confirm Label Printing": what will print, the source, the printer; a
//   REPRINT needs a reason. [Cancel] [Confirm & Print] opens the browser print.
// 3 "Did the label print correctly?" — the browser cannot tell the page, so
//   the operator says. ONLY a Yes records the print (POST /barcode/print), so
//   the history holds what really came out, not what was attempted.
// 4 "Label printed successfully" (or, on No, "Nothing recorded").
//
// `source` is a PRINT_SOURCE key — how the part was identified. A caller-given
// source wins; without one it is REPRINT when the part was printed before,
// else PART_MASTER. The QR carries only the Part No. Printing adds no stock and
// completes no GRN or quality step (spec 9).
// `open` defaults to true so a caller may simply mount / unmount the dialog;
// `config` (label template) is fetched when not given.
//
// An inactive part gets no label. The server refuses to record one, and since
// the label is printed BEFORE it is recorded, letting it print would put a
// label on the shelf that the print history never shows. So a part the caller
// knows is inactive (`is_active` false) is stopped here, before anything
// prints. A caller that does not pass `is_active` is not blocked; the server
// still refuses the record.

const MAX_COPIES = 100;
const REASON_MAX = 255;
// Answers where the server looked at the print and said no (inactive part,
// reprint reason now required, no right, part gone). Sending the same record
// again gets the same answer, so the operator is not told a retry will help.
const REFUSED_STATUSES = new Set([400, 403, 404, 409, 422]);
// "New material just identified" — its label is a first label for that
// material even when the part number was labelled before: no reprint reason.
const NEW_MATERIAL = new Set(["SUPPLIER_BARCODE", "ERP_SEARCH", "MANUAL_ENTRY", "QR_SCAN"]);
const STEPS = ["Label", "Confirm", "Print", "Done"];
const STEP_INDEX = { setup: 0, confirm: 1, verify: 2, done: 3, notPrinted: 3 };

const wholeCopies = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(MAX_COPIES, Math.max(1, n)) : 1;
};

function Field({ label, children, htmlFor }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="kpi-label block">{label}</label>
      {children}
    </div>
  );
}

function Detail({ label, children }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 text-sm">
      <dt className="shrink-0 text-slate-500 dark:text-slate-400">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-slate-800 dark:text-slate-100">{children}</dd>
    </div>
  );
}

export default function PrintBarcodeModal({
  open = true, part, source: sourceProp, onClose, onPrinted, config: configProp,
}) {
  const qc = useQueryClient();
  const partId = part?.id ?? part?.part_id ?? null;
  const partNo = part?.part_no || "";
  const description = part?.part_name || "";
  const location = part?.location || null;

  const [step, setStep] = useState("setup");
  const [copies, setCopies] = useState(1);
  const [reason, setReason] = useState("");
  const [reasonTried, setReasonTried] = useState(false);
  const [big, setBig] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState(null);
  const [result, setResult] = useState(null);
  // What went to the printer, frozen at Confirm & Print: a Yes records exactly
  // this, even if the print history refreshes meanwhile (which would otherwise
  // turn a first print into a "reprint" under the operator's feet).
  const [job, setJob] = useState(null);
  const [previewRef, previewW] = useBoxWidth();
  // Each step starts at the top of the dialog, not where the last one was scrolled to.
  const bodyRef = useRef(null);
  useEffect(() => { bodyRef.current?.closest("[role=dialog]")?.scrollTo?.({ top: 0 }); }, [step]);

  // A fresh start every time the dialog opens (the part drawer keeps it mounted).
  useEffect(() => {
    if (!open) return;
    setStep("setup");
    setCopies(1);
    setReason("");
    setReasonTried(false);
    setBig(false);
    setRecording(false);
    setRecordError(null);
    setResult(null);
    setJob(null);
  }, [open, partId]);

  const on = Boolean(open && partId != null);
  const { config, ready: configReady } = useLabelConfig({ enabled: on, config: configProp });
  const printerQ = usePrinterStatus({ enabled: on });
  // Under "stock" so the same refresh that follows any print (here or on
  // another terminal) brings it up to date.
  const historyQ = useQuery({
    queryKey: ["stock", "label-history", partId],
    queryFn: () => barcodeService.printHistory(partId, 5, { silent: true }).then((r) => r.data.data || []),
    enabled: on,
    staleTime: 0,
  });

  // Modal re-runs its focus / Escape effect whenever onClose changes identity;
  // a close rebuilt on every keystroke would pull focus out of the inputs. So
  // close is stable and reads the latest props through refs. No closing while
  // a print is being recorded.
  const onCloseRef = useRef(onClose);
  const recordingRef = useRef(false);
  useEffect(() => { onCloseRef.current = onClose; recordingRef.current = recording; });
  const close = useCallback(() => { if (!recordingRef.current) onCloseRef.current?.(); }, []);

  if (!part) return null;

  const history = historyQ.data || [];
  const printedBefore = history.length > 0;
  const last = history[0];
  const source = sourceProp || (historyQ.isSuccess ? (printedBefore ? "REPRINT" : "PART_MASTER") : null);
  // Without a caller-given source we must know whether this is a reprint
  // before printing — a reprint needs its reason BEFORE the label comes out.
  const historyBlocking = !sourceProp && historyQ.isError;
  const needsReason = source === "REPRINT" || (printedBefore && source != null && !NEW_MATERIAL.has(source));
  const reasonMissing = needsReason && !reason.trim();
  const qty = wholeCopies(copies);
  const qr = labelSymbology(config) === "QR";
  const showLocation = config?.show_location !== false;
  const printerName = printerQ.data?.name || null;
  const sourceLabel = source ? PRINT_SOURCE[source] || source : "—";
  // Only a known "inactive" stops the print (false, or 0 from a raw row);
  // an absent flag is left to the server.
  const inactive = part.is_active != null && !part.is_active;
  const canStart = configReady && Boolean(source) && Boolean(partNo) && !inactive;

  const goConfirm = () => { if (canStart) setStep("confirm"); };

  const confirmAndPrint = () => {
    if (inactive) return;
    if (reasonMissing) { setReasonTried(true); return; }
    printLabels(buildLabelHtml({
      barcodeValue: partNo, partNo, description, location, config, copies: qty,
    }));
    setJob({
      source, copies: qty, printerName, reason: needsReason ? reason.trim() : undefined,
    });
    setRecordError(null);
    setStep("verify");
  };

  const recordPrinted = async () => {
    if (!job) return;
    setRecording(true);
    setRecordError(null);
    try {
      const res = await barcodeService.print({
        part_id: partId,
        copies: job.copies,
        source: job.source,
        printer_name: job.printerName,
        reason: job.reason,
      }, { silent: true });
      const d = res.data.data;
      setResult(d);
      setStep("done");
      // The scan result's label counts, the drawer, the history — all "stock".
      qc.invalidateQueries({ queryKey: ["stock"] });
      onPrinted?.(d);
    } catch (e) {
      setRecordError({
        message: e?.response?.data?.message || e?.message || "Could not record the print",
        refused: REFUSED_STATUSES.has(e?.response?.status),
      });
    } finally {
      setRecording(false);
    }
  };

  // ---- title + footer per step ----
  const what = qr ? "QR" : "Label";
  const title = {
    setup: `${source === "REPRINT" ? "Reprint" : "Generate"} Internal ${what} — ${partNo}`,
    confirm: "Confirm Label Printing",
    verify: "Label Printing",
    done: "Label Printing",
    notPrinted: "Label Printing",
  }[step];

  let footer = null;
  if (step === "setup") {
    footer = (
      <>
        <button type="button" className="btn-secondary" onClick={close}>Cancel</button>
        <button type="button" className="btn-secondary" onClick={() => setBig((b) => !b)} aria-pressed={big}>
          {big ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
          {big ? "Hide preview" : "Preview"}
        </button>
        <button type="button" className="btn-primary" onClick={goConfirm} disabled={!canStart}>
          <Printer size={16} aria-hidden="true" /> Print Label
        </button>
      </>
    );
  } else if (step === "confirm") {
    footer = (
      <>
        <button type="button" className="btn-secondary" onClick={() => setStep("setup")}>Cancel</button>
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
        <button type="button" className="btn-primary" onClick={() => setStep("setup")}>
          <Printer size={16} aria-hidden="true" /> Print again
        </button>
      </>
    );
  } else {
    footer = <button type="button" className="btn-primary" onClick={close}>Done</button>;
  }

  const noLocation = showLocation && !location && !inactive && (
    <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
      <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>
        This part has no location, so the label will print <b>Location: —</b>. If it has a rack
        place, set the location first and print after.
      </span>
    </div>
  );

  return (
    <Modal open={open} onClose={close} title={title} size={step === "setup" && big ? "xl" : "md"} footer={footer}>
      <div ref={bodyRef} className="space-y-4">
        <PrintSteps steps={STEPS} current={STEP_INDEX[step]} />

        {step === "setup" && (
          <>
            {inactive && (
              <div role="alert" className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>
                  <b>This part is inactive</b> — reactivate it in Part Master before printing a label.
                  An inactive part's label cannot be recorded in the print history.
                </span>
              </div>
            )}
            <div ref={previewRef} className="flex justify-center rounded-lg bg-slate-50 p-4 dark:bg-navy-800">
              <BarcodeLabel value={partNo} partNo={partNo} description={description} location={location}
                config={config} maxWidth={Math.min(big ? 660 : 300, previewW || 300)} maxHeight={big ? 330 : 150} />
            </div>
            <p className="text-center text-[11px] text-slate-500 dark:text-slate-400">
              Label {Number(config?.width_mm) || 100} × {Number(config?.height_mm) || 50} mm ·
              the {qr ? "QR" : "barcode"} carries only the Part No. — status and history are read
              from the store records on every scan
            </p>
            {noLocation}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Label Quantity" htmlFor="label-qty">
                <QtyStepper id="label-qty" label="Label quantity" value={copies} onChange={setCopies}
                  min={1} max={MAX_COPIES} />
              </Field>
              <Field label="Printer" htmlFor="label-printer">
                <PrinterPicker id="label-printer" enabled={on} />
              </Field>
            </div>

            <div className="rounded-lg border border-slate-200 px-3 py-2.5 text-xs dark:border-navy-800">
              {!sourceProp && historyQ.isPending ? (
                <span className="flex items-center gap-2 text-slate-500">
                  <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> Checking print history…
                </span>
              ) : historyBlocking ? (
                <span className="flex flex-wrap items-center gap-2 text-rose-600 dark:text-rose-400">
                  Could not check this part's print history, so it is not known whether this is a reprint.
                  <button type="button" onClick={() => historyQ.refetch()}
                    className="inline-flex items-center gap-1 font-semibold hover:underline">
                    <RefreshCw size={12} aria-hidden="true" /> Retry
                  </button>
                </span>
              ) : (
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-600 dark:text-slate-300">
                  <span>Source: <b>{sourceLabel}</b></span>
                  <span className="flex items-center gap-1 text-slate-500 dark:text-slate-400">
                    <History size={12} aria-hidden="true" />
                    {historyQ.isError ? "Print history unavailable"
                      : last ? `Last printed ${fmtStamp(last.printed_at)}${last.printed_by ? ` by ${last.printed_by}` : ""}`
                        : historyQ.isSuccess ? "Never printed before" : "…"}
                  </span>
                </span>
              )}
            </div>
          </>
        )}

        {step === "confirm" && (
          <>
            <dl className="divide-y divide-slate-100 rounded-lg border border-slate-200 px-3 dark:divide-navy-800 dark:border-navy-800">
              <Detail label="Part No.">{partNo}</Detail>
              <Detail label="Description">{description || "—"}</Detail>
              <Detail label="Location">
                {location || <span className="text-amber-600 dark:text-amber-400">— (not set)</span>}
              </Detail>
              <Detail label="Label Quantity"><span className="tabular">{qty}</span></Detail>
              <Detail label="Source">{sourceLabel}</Detail>
              <Detail label="Printer">
                <span className="flex flex-col items-end gap-1">
                  <span>{printerName || "Browser print dialog"}</span>
                  <PrinterStatus enabled={on} />
                </span>
              </Detail>
            </dl>
            {needsReason && (
              <div className="space-y-1.5">
                <label htmlFor="reprint-reason" className="kpi-label block">
                  Reprint reason <span className="text-toyotared">*</span>
                </label>
                <textarea
                  id="reprint-reason"
                  rows={2}
                  maxLength={REASON_MAX}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why a new label is needed — e.g. label torn, faded, lost"
                  className={`input-field resize-none ${reasonTried && reasonMissing ? "border-rose-400 focus:ring-rose-300" : ""}`}
                  aria-invalid={reasonTried && reasonMissing}
                  autoFocus
                />
                <div className="flex justify-between text-[11px]">
                  <span className="text-rose-600 dark:text-rose-400">
                    {reasonTried && reasonMissing ? "A reprint reason is required" : ""}
                  </span>
                  <span className="tabular text-slate-400">{reason.length} / {REASON_MAX}</span>
                </div>
              </div>
            )}
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              The label goes through the browser's print dialog — choose {printerName ? <b>{printerName}</b> : "the label printer"} there.
              Printing a label adds no stock and completes no GRN or quality step.
            </p>
          </>
        )}

        {step === "verify" && (
          <div className="space-y-3 py-2 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300">
              <Printer size={22} aria-hidden="true" />
            </span>
            <p className="text-base font-semibold text-slate-800 dark:text-white">Did the label print correctly?</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Check {job?.copies === 1 ? "the label" : `all ${job?.copies} labels`} came out and the {qr ? "QR" : "barcode"} is sharp.
              Only a confirmed print is recorded in the print history.
            </p>
            {recordError && (
              <div role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-left text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                <b>Not recorded{recordError.refused ? "" : " yet"}:</b>{" "}
                {String(recordError.message).replace(/\.\s*$/, "")}.{" "}
                {recordError.refused
                  ? "The label did print, but the server refused to record it, so it is not in the print history. Trying again will not help until that is fixed. Take the label off the part or tell the store admin."
                  : "The label is printed — try recording it again."}
              </div>
            )}
          </div>
        )}

        {step === "done" && job && (
          <div className="space-y-2 py-2 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300">
              <CircleCheckBig size={24} aria-hidden="true" />
            </span>
            <p className="text-base font-semibold text-emerald-700 dark:text-emerald-300">Label printed successfully</p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Recorded in print history — {result?.copies ?? job.copies} label{(result?.copies ?? job.copies) === 1 ? "" : "s"} ·{" "}
              {PRINT_SOURCE[job.source] || job.source}{job.printerName ? ` · ${job.printerName}` : ""}
              {result?.printed_at ? ` · ${fmtStamp(result.printed_at)}` : ""}
              {result?.printed_by ? ` by ${result.printed_by}` : ""}
            </p>
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
