import React, { useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { ArrowLeft, CircleCheckBig, LayoutGrid, Printer, TriangleAlert } from "lucide-react";
import Modal from "../Modal";
import { useLabelConfig } from "./useLabelConfig";
import { useBoxWidth } from "./useBoxWidth";
import { buildBinSheetsHtml, groupIntoBins, printLabels } from "../../utils/barcodeRender";
import { countSheets, printBinSheetsHtml, sheetsWord } from "./binSheetPrint.js";

// Permanent rack tags: ONE laminated sheet per bin. The selected parts are
// grouped by base rack location (e.g. R13-S3-B16(1), (2)… -> bin R13-S3-B16)
// and each bin prints on its own page at the configured bin-face size (default
// 130 x 90 mm), one row per part — QR (Part No.) + description + location +
// Min / Max — the rows auto-fitting however many parts the bin holds.
//
// Unlike the stock labels this is a fixture on the rack, not a label on a piece
// of material, so it is printed but NOT recorded in the label print history.
//
//   <BinSheetPrintModal parts={[{ part_id, part_no, part_name, location,
//                                 min_stock_level, max_stock_level }]}
//                       config? onClose />
//
// Or the preview step of the rack / bin picker (BinPickerModal — the store, 17
// Oct 2026: "rack k ander se bin chunna h jaise R4 me B5"): the bins already
// chosen, as groupIntoBins returns them, a Back to the picker, and optionally
// the picker's sheets per bin key (to mark a crowded bin's extra pages):
//
//   <BinSheetPrintModal bins={[...]} sheetsByBin? onBack config? onClose />
//
// For chosen bins the preview is EVERY sheet that will print — the store checks
// exactly what goes on the racks — and the Sheets tile, the Print button and
// the toast are all read off that one document, which is also what is printed.

const PX_PER_MM = 96 / 25.4;      // CSS px per mm at 96 dpi — for the preview scale
const PREVIEW_GAP_PX = 10;        // grey gap between sheets in the all-sheets preview
// The all-sheets preview shows the print document on a grey page with a gap
// between sheets, so one sheet is told from the next. Preview only — the
// document that prints is untouched.
const PREVIEW_STYLE = `<style>html,body{background:#cbd5e1}.bsheet{margin:0 0 ${PREVIEW_GAP_PX}px}</style>`;

export default function BinSheetPrintModal({ parts, bins: binsProp = null, sheetsByBin = null, onBack = null, config: configProp, onClose }) {
  const { config, ready: configReady } = useLabelConfig({ config: configProp });
  const [previewRef, previewW] = useBoxWidth();
  const [printed, setPrinted] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const picked = Boolean(binsProp);

  // Picked bins print as they are; parts are grouped into their bins here. A
  // two-bin part (New + Rework) is in each of its bins but is one part.
  const bins = useMemo(() => binsProp || groupIntoBins(parts), [binsProp, parts]);
  const partCount = useMemo(
    () => (binsProp ? new Set(binsProp.flatMap((b) => b.rows.map((r) => r.part_id ?? r.part_no))).size : (parts || []).length),
    [binsProp, parts],
  );
  const first = bins[0] || null;
  const firstHtml = useMemo(
    () => (!picked && configReady && first ? buildBinSheetsHtml([first], config) : ""),
    [picked, first, config, configReady],
  );

  // Chosen bins: the whole print document, drawn once just after the dialog has
  // painted (a rack's worth of QRs takes a moment), then previewed, counted and
  // printed as it is.
  const [doc, setDoc] = useState({ bins: null, html: "" });
  useEffect(() => {
    if (!binsProp || !configReady) return undefined;
    const t = setTimeout(() => setDoc({ bins: binsProp, html: buildBinSheetsHtml(binsProp, config) }), 30);
    return () => clearTimeout(t);
  }, [binsProp, config, configReady]);
  const allHtml = picked && doc.bins === binsProp ? doc.html : "";
  const sheetN = allHtml ? countSheets(allHtml) : null;

  const binW = Number(config?.bin_width_mm) || 130;
  const binH = Number(config?.bin_height_mm) || 90;
  const noLocationCount = bins
    .filter((b) => b.base === "(no location)")
    .reduce((s, b) => s + b.rows.length, 0);

  const sheetPxW = binW * PX_PER_MM;
  const sheetPxH = binH * PX_PER_MM;
  const boxW = Math.min(360, previewW || 360);
  const scale = Math.min(boxW / sheetPxW, 1);

  // The all-sheets preview's height: estimated from the sheet count, then
  // measured off the drawn document (the auto-fit script may run after load).
  const [measured, setMeasured] = useState({ html: "", h: 0 });
  const estH = sheetN ? sheetN * (sheetPxH + PREVIEW_GAP_PX) : sheetPxH;
  const frameH = (measured.html === allHtml && measured.h) || estH;
  const measure = (e) => {
    const h = e.currentTarget.contentDocument?.documentElement?.scrollHeight;
    if (h) setMeasured({ html: allHtml, h });
  };
  const previewDoc = useMemo(
    () => (allHtml ? allHtml.replace("</head>", `${PREVIEW_STYLE}</head>`) : ""), [allHtml]);

  const doPrint = () => {
    if (!configReady || !bins.length) return;
    if (picked) {
      // Exactly the document on screen — so its page count is the toast's.
      if (!allHtml) return;
      printBinSheetsHtml(allHtml, bins.length);
      setPrinted(true);
      return;
    }
    // Built on demand (not on open) so a whole section's hundreds of bins don't
    // freeze the dialog just to show the preview.
    printLabels(buildBinSheetsHtml(bins, config));
    setPrinted(true);
    toast.success(`${bins.length} bin ${bins.length === 1 ? "sheet" : "sheets"} sent to the printer`);
  };

  const printLabel = printed ? "Print again"
    : !picked ? `Print ${bins.length} bin ${bins.length === 1 ? "sheet" : "sheets"}`
      : sheetN != null ? `Print ${sheetsWord(sheetN)}` : "Drawing sheets…";

  const footer = (
    <>
      {onBack && (
        <button type="button" className="btn-secondary mr-auto" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" /> Back to bins
        </button>
      )}
      <button type="button" className="btn-secondary" onClick={() => onCloseRef.current?.()}>
        {printed ? "Close" : "Cancel"}
      </button>
      <button type="button" className="btn-primary disabled:cursor-not-allowed disabled:opacity-50" onClick={doPrint}
        disabled={!configReady || !bins.length || (picked && !allHtml)}>
        <Printer size={16} aria-hidden="true" /> {printLabel}
      </button>
    </>
  );

  // Picked bins that run onto more than one page (when the picker counted them).
  const extraPages = (b) => (sheetsByBin && sheetsByBin.get(b.key)) || 1;

  return (
    <Modal open onClose={() => onCloseRef.current?.()} title="Print bin location sheets" footer={footer}>
      <div className="space-y-4">
        {picked ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Every sheet below prints, in this order — one {binW} × {binH} mm sheet per bin (a crowded bin runs onto
            more pages, and each page counts as a sheet) — to laminate and fix on the bin face. These are rack
            fixtures, so they are not recorded in the label print history.
          </p>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            The selected parts are grouped by rack location into bins. Each bin prints on one {binW} × {binH} mm sheet —
            QR, description, location and Min / Max per part — to laminate and fix on the bin face. These are rack
            fixtures, so they are not recorded in the label print history.
          </p>
        )}

        <div ref={previewRef} className="flex flex-col items-center gap-1.5 rounded-lg bg-slate-50 p-4 dark:bg-navy-800">
          {picked ? (
            allHtml ? (
              <div className="max-h-[50vh] w-full overflow-y-auto overscroll-contain rounded" tabIndex={0}
                role="region" aria-label={`Preview of all ${sheetsWord(sheetN)}`}>
                <div style={{ width: sheetPxW * scale, height: frameH * scale }} className="mx-auto overflow-hidden">
                  <iframe title="Bin sheets preview" srcDoc={previewDoc} scrolling="no" tabIndex={-1} aria-hidden="true"
                    onLoad={measure}
                    style={{ width: sheetPxW, height: frameH, border: 0, transform: `scale(${scale})`, transformOrigin: "top left" }} />
                </div>
              </div>
            ) : (
              <div className="skeleton h-40 w-full" aria-label="Drawing the sheets" />
            )
          ) : firstHtml ? (
            <div style={{ width: sheetPxW * scale, height: sheetPxH * scale }}
              className="overflow-hidden border border-slate-300 bg-white shadow-sm">
              <iframe title="Bin sheet preview" srcDoc={firstHtml} scrolling="no" tabIndex={-1} aria-hidden="true"
                style={{ width: sheetPxW, height: sheetPxH, border: 0, transform: `scale(${scale})`, transformOrigin: "top left" }} />
            </div>
          ) : (
            <div className="skeleton h-40 w-full" />
          )}
          <span className="text-[11px] text-slate-400">
            {picked
              ? (sheetN == null ? `Drawing ${bins.length} ${bins.length === 1 ? "bin" : "bins"}…`
                : sheetN === 1 ? `1 sheet · ${binW} × ${binH} mm`
                  : `All ${sheetsWord(sheetN)} · scroll to check each · ${binW} × ${binH} mm`)
              : `First bin of ${bins.length} · ${binW} × ${binH} mm`}
          </span>
        </div>

        <div className={`grid gap-2 text-center ${picked ? "grid-cols-3" : "grid-cols-2"}`}>
          <div className="rounded-lg border border-slate-200 px-2 py-2 dark:border-navy-800">
            <p className="kpi-label">Bins</p>
            <p className="text-lg font-bold tabular text-slate-800 dark:text-white">{bins.length}</p>
          </div>
          {picked && (
            <div className="rounded-lg border border-slate-200 px-2 py-2 dark:border-navy-800">
              <p className="kpi-label">Sheets</p>
              <p className="text-lg font-bold tabular text-slate-800 dark:text-white">{sheetN ?? "…"}</p>
            </div>
          )}
          <div className="rounded-lg border border-slate-200 px-2 py-2 dark:border-navy-800">
            <p className="kpi-label">Parts</p>
            <p className="text-lg font-bold tabular text-slate-800 dark:text-white">{partCount}</p>
          </div>
        </div>
        {picked && sheetN != null && sheetN > bins.length && (
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            {sheetsWord(sheetN)} for {bins.length} {bins.length === 1 ? "bin" : "bins"}: a crowded bin runs onto more
            than one sheet — (1/2), (2/2)… — and each sheet is a page.
          </p>
        )}

        {bins.length > 0 && (
          <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 dark:divide-navy-800 dark:border-navy-800"
            aria-label="Bins to print">
            {bins.map((b) => (
              <li key={`${b.section_id ?? ""}|${b.base}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className={`min-w-0 truncate ${b.base === "(no location)" ? "text-amber-700 dark:text-amber-300" : "text-slate-700 dark:text-slate-200"}`}>
                  <span className="font-mono">{b.base}</span>
                  {b.section_name ? <span className="ml-2 text-xs text-slate-400">· {b.section_name}</span> : null}
                </span>
                <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                  {b.rows.length} {b.rows.length === 1 ? "part" : "parts"}
                  {picked && extraPages(b) > 1 ? <b className="ml-1 font-semibold text-amber-700 dark:text-amber-300">· {extraPages(b)} sheets</b> : null}
                </span>
              </li>
            ))}
          </ul>
        )}

        {noLocationCount > 0 && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              {noLocationCount} selected {noLocationCount === 1 ? "part has" : "parts have"} no rack location — they
              print together on a <b>“(no location)”</b> sheet. Set their location first for a proper bin sheet.
            </span>
          </div>
        )}

        {printed && (
          <div className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
            <CircleCheckBig size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>Sent to the print dialog. Check every bin sheet came out and the QRs are sharp before laminating.</span>
          </div>
        )}

        <p className="flex items-center gap-1.5 text-[11px] text-slate-400">
          <LayoutGrid size={12} aria-hidden="true" /> Grouped by the rack location without its position suffix — R13-S3-B16(1) and R13-S3-B16(2) share bin R13-S3-B16.
        </p>
      </div>
    </Modal>
  );
}
