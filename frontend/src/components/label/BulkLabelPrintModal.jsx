import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheckBig, CircleX, LoaderCircle, Printer, TriangleAlert } from "lucide-react";
import Modal from "../Modal";
import BarcodeLabel from "../BarcodeLabel";
import QtyStepper from "../QtyStepper";
import PrintSteps from "./PrintSteps";
import { PrinterPicker } from "./PrinterStatus";
import { usePrinterStatus } from "./usePrinterStatus";
import { useLabelConfig } from "./useLabelConfig";
import { useBoxWidth } from "./useBoxWidth";
import { barcodeService } from "../../services/barcodeService";
import { buildLabelsHtml, printLabels } from "../../utils/barcodeRender";

// Labels for many parts in one print job (Store Stock's bulk action), with the
// same honesty rule as a single label: the browser cannot tell whether the
// labels came out, so after the print dialog the operator is asked, and ONLY a
// Yes records them (source STORE_STOCK).
//
// The server records a part that already has a label only with a reprint
// reason. Printing such a part without one would put a label on the shelf that
// the history never shows — so before printing, each part's print history is
// checked and an already-labelled part goes into the job only when a reason is
// given. A part whose history could not be read is treated as labelled.
//
//   <BulkLabelPrintModal parts={[{ part_id, part_no, part_name, location }]}
//                        config? onClose onRecorded? />

const MAX_COPIES = 10;          // per part — the bulk endpoint's limit
const REASON_MAX = 255;
const CHECK_CONCURRENCY = 6;
const STEPS = ["Labels", "Print", "Done"];
const STEP_INDEX = { check: 0, setup: 0, verify: 1, done: 2, notPrinted: 2 };

const plural = (n, word) => `${n.toLocaleString("en-IN")} ${word}${n === 1 ? "" : "s"}`;

export default function BulkLabelPrintModal({ parts, config: configProp, onClose, onRecorded }) {
  const qc = useQueryClient();
  const [step, setStep] = useState("check");
  const [checked, setChecked] = useState(0);
  const [labelled, setLabelled] = useState(() => new Set());   // part_ids needing a reason
  const [unknown, setUnknown] = useState(0);                   // of those, history unreadable
  const [copies, setCopies] = useState(1);
  const [reason, setReason] = useState("");
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState(null);
  const [result, setResult] = useState(null);
  // The exact job that went to the printer — what a Yes records.
  const [job, setJob] = useState(null);
  const [previewRef, previewW] = useBoxWidth();
  // Each step starts at the top of the dialog, not where the last one was scrolled to.
  const bodyRef = useRef(null);
  useEffect(() => { bodyRef.current?.closest("[role=dialog]")?.scrollTo?.({ top: 0 }); }, [step]);

  const { config, ready: configReady } = useLabelConfig({ config: configProp });
  const printerQ = usePrinterStatus();
  const printerName = printerQ.data?.name || null;

  // Which selected parts already carry a label (a few requests at a time).
  useEffect(() => {
    let cancelled = false;
    const ids = parts.map((p) => p.part_id);
    const found = new Set();
    let unreadable = 0;
    let next = 0;
    setChecked(0);
    const worker = async () => {
      while (!cancelled && next < ids.length) {
        const id = ids[next];
        next += 1;
        try {
          const r = await barcodeService.printHistory(id, 1, { silent: true });
          if ((r.data.data || []).length > 0) found.add(id);
        } catch {
          found.add(id);      // unknown -> treated as labelled (needs a reason)
          unreadable += 1;
        }
        if (!cancelled) setChecked((c) => c + 1);
      }
    };
    Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, ids.length) }, worker)).then(() => {
      if (cancelled) return;
      setLabelled(found);
      setUnknown(unreadable);
      setStep("setup");
    });
    return () => { cancelled = true; };
  }, [parts]);

  const onCloseRef = useRef(onClose);
  const recordingRef = useRef(false);
  useEffect(() => { onCloseRef.current = onClose; recordingRef.current = recording; });
  const close = useCallback(() => { if (!recordingRef.current) onCloseRef.current?.(); }, []);

  const withReason = reason.trim().length > 0;
  const fresh = useMemo(() => parts.filter((p) => !labelled.has(p.part_id)), [parts, labelled]);
  const toPrint = withReason ? parts : fresh;
  const held = parts.length - fresh.length;
  const perPart = Math.min(MAX_COPIES, Math.max(1, Math.round(Number(copies)) || 1));
  const totalLabels = toPrint.length * perPart;

  const doPrint = () => {
    if (!toPrint.length || !configReady) return;
    const labels = toPrint.map((p) => ({
      barcode_value: p.part_no, part_no: p.part_no, part_name: p.part_name,
      location: p.location, copies: perPart,
      min_stock_level: p.min_stock_level, max_stock_level: p.max_stock_level,
    }));
    printLabels(buildLabelsHtml(labels, config, "location"));
    setJob({
      ids: toPrint.map((p) => p.part_id), copies: perPart,
      reason: withReason ? reason.trim() : undefined, printerName,
    });
    setRecordError(null);
    setStep("verify");
  };

  const recordPrinted = async () => {
    if (!job) return;
    setRecording(true);
    setRecordError(null);
    try {
      const res = await barcodeService.printBulk(job.ids, {
        copies: job.copies, reason: job.reason, source: "STORE_STOCK", printerName: job.printerName,
      }, { silent: true });
      const d = res.data.data || { printed: [], skipped: [] };
      const n = (d.printed || []).length;
      qc.invalidateQueries({ queryKey: ["stock"] });
      onRecorded?.(d);
      const labelsN = n * job.copies;
      if ((d.skipped || []).length) {
        setResult(d);
        setStep("done");
      } else {
        toast.success(`${plural(labelsN, "label")} printed · recorded in print history`);
        onCloseRef.current?.();
      }
    } catch (e) {
      setRecordError(e?.response?.data?.message || e?.message || "Could not record the print");
    } finally {
      setRecording(false);
    }
  };

  let footer;
  if (step === "check" || step === "setup") {
    footer = (
      <>
        <button type="button" className="btn-secondary" onClick={close}>Cancel</button>
        <button type="button" className="btn-primary" onClick={doPrint}
          disabled={step === "check" || !toPrint.length || !configReady}>
          <Printer size={16} aria-hidden="true" /> Print {plural(totalLabels, "label")}
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
            : <><CircleCheckBig size={16} aria-hidden="true" /> {recordError ? "Yes, all printed — try again" : "Yes, all printed"}</>}
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

  const first = toPrint[0] || parts[0];
  const jobLabels = job ? job.ids.length * job.copies : totalLabels;

  return (
    <Modal open onClose={close} title={`Print labels — ${plural(parts.length, "part")}`} footer={footer}>
      <div ref={bodyRef} className="space-y-4">
        <PrintSteps steps={STEPS} current={STEP_INDEX[step]} />

        {step === "check" && (
          <div className="flex items-center gap-2 py-6 text-sm text-slate-500 dark:text-slate-400">
            <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
            Checking which parts already have a label… {checked.toLocaleString("en-IN")} / {parts.length.toLocaleString("en-IN")}
          </div>
        )}

        {step === "setup" && (
          <>
            {first && (
              <div ref={previewRef} className="flex flex-col items-center gap-1.5 rounded-lg bg-slate-50 p-4 dark:bg-navy-800">
                <BarcodeLabel value={first.part_no} partNo={first.part_no} description={first.part_name}
                  location={first.location} config={config} kind="location"
                  minLevel={first.min_stock_level} maxLevel={first.max_stock_level}
                  maxWidth={Math.min(300, previewW || 300)} maxHeight={150} />
                <span className="text-[11px] text-slate-400">First tag of the job · each QR carries only its Part No., with Min / Max.</span>
              </div>
            )}

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-lg border border-slate-200 px-2 py-2 dark:border-navy-800">
                <p className="kpi-label">Selected</p>
                <p className="text-lg font-bold tabular text-slate-800 dark:text-white">{parts.length}</p>
              </div>
              <div className="rounded-lg border border-slate-200 px-2 py-2 dark:border-navy-800">
                <p className="kpi-label">No label yet</p>
                <p className="text-lg font-bold tabular text-emerald-600 dark:text-emerald-400">{fresh.length}</p>
              </div>
              <div className="rounded-lg border border-slate-200 px-2 py-2 dark:border-navy-800">
                <p className="kpi-label">Already labelled</p>
                <p className="text-lg font-bold tabular text-amber-600 dark:text-amber-400">{held}</p>
              </div>
            </div>

            {held > 0 && (
              <div className="space-y-1.5">
                <label htmlFor="bulk-reason" className="kpi-label block">Reprint reason (for the {held} already labelled)</label>
                <textarea id="bulk-reason" rows={2} maxLength={REASON_MAX} value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. labels faded after rack cleaning — leave empty to print only the new ones"
                  className="input-field resize-none" />
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  {withReason
                    ? `All ${parts.length} parts will print; the ${held} already labelled are recorded as reprints with this reason.`
                    : `Without a reason only the ${fresh.length} part${fresh.length === 1 ? "" : "s"} with no label yet will print.`}
                  {unknown > 0 && ` ${unknown} of the ${held} could not be checked and ${unknown === 1 ? "is" : "are"} treated as labelled.`}
                </p>
              </div>
            )}

            {toPrint.some((p) => !p.location) && config?.show_location !== false && (
              <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>
                  {plural(toPrint.filter((p) => !p.location).length, "part")} in this job
                  {toPrint.filter((p) => !p.location).length === 1 ? " has" : " have"} no location — the label
                  will print <b>Location: —</b>.
                </span>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="bulk-copies" className="kpi-label block">Labels per part</label>
                <QtyStepper id="bulk-copies" label="Labels per part" value={copies} onChange={setCopies}
                  min={1} max={MAX_COPIES} />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="bulk-printer" className="kpi-label block">Printer</label>
                <PrinterPicker id="bulk-printer" />
              </div>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              The labels go through the browser's print dialog — choose {printerName ? <b>{printerName}</b> : "the label printer"} there.
              Printing adds no stock and completes no GRN or quality step.
            </p>
          </>
        )}

        {step === "verify" && (
          <div className="space-y-3 py-2 text-center">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-slate-100 text-slate-600 dark:bg-navy-800 dark:text-slate-300">
              <Printer size={22} aria-hidden="true" />
            </span>
            <p className="text-base font-semibold text-slate-800 dark:text-white">
              Did {plural(jobLabels, "label")} print?
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Only a confirmed print is recorded in the print history. If only some came out, choose
              No and print again.
            </p>
            {recordError && (
              <div className="rounded-lg bg-rose-50 px-3 py-2 text-left text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                <b>Not recorded yet:</b> {String(recordError).replace(/\.\s*$/, "")}. The labels are
                printed — try recording them again.
              </div>
            )}
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

        {step === "done" && result && (
          <div className="space-y-3">
            <div className="flex items-start gap-3 rounded-lg bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
              <CircleCheckBig size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>
                <b>{plural((result.printed || []).length * (job?.copies || 1), "label")} printed</b> · recorded in print history
              </span>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
              <p className="mb-1.5 font-semibold">
                {plural(result.skipped.length, "part")} not recorded by the server — printed in this job but
                not in the print history:
              </p>
              <ul className="max-h-40 space-y-0.5 overflow-y-auto">
                {result.skipped.map((s) => (
                  <li key={s.part_id}><b>{s.part_no || `#${s.part_id}`}</b> — {s.why || "refused"}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
