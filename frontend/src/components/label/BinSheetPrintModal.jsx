import React, { useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { CircleCheckBig, LayoutGrid, Printer, TriangleAlert } from "lucide-react";
import Modal from "../Modal";
import { useLabelConfig } from "./useLabelConfig";
import { useBoxWidth } from "./useBoxWidth";
import { buildBinSheetsHtml, groupIntoBins, printLabels } from "../../utils/barcodeRender";

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

const PX_PER_MM = 96 / 25.4;      // CSS px per mm at 96 dpi — for the preview scale

export default function BinSheetPrintModal({ parts, config: configProp, onClose }) {
  const { config, ready: configReady } = useLabelConfig({ config: configProp });
  const [previewRef, previewW] = useBoxWidth();
  const [printed, setPrinted] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const bins = useMemo(() => groupIntoBins(parts), [parts]);
  const first = bins[0] || null;
  const firstHtml = useMemo(
    () => (configReady && first ? buildBinSheetsHtml([first], config) : ""),
    [first, config, configReady],
  );

  const binW = Number(config?.bin_width_mm) || 130;
  const binH = Number(config?.bin_height_mm) || 90;
  const noLocation = bins.find((b) => b.base === "(no location)");
  const noLocationCount = noLocation ? noLocation.rows.length : 0;

  const sheetPxW = binW * PX_PER_MM;
  const sheetPxH = binH * PX_PER_MM;
  const boxW = Math.min(360, previewW || 360);
  const scale = Math.min(boxW / sheetPxW, 1);

  const doPrint = () => {
    if (!configReady || !bins.length) return;
    // Built on demand (not on open) so a whole section's hundreds of bins don't
    // freeze the dialog just to show the preview.
    printLabels(buildBinSheetsHtml(bins, config));
    setPrinted(true);
    toast.success(`${bins.length} bin ${bins.length === 1 ? "sheet" : "sheets"} sent to the printer`);
  };

  const footer = (
    <>
      <button type="button" className="btn-secondary" onClick={() => onCloseRef.current?.()}>
        {printed ? "Close" : "Cancel"}
      </button>
      <button type="button" className="btn-primary" onClick={doPrint} disabled={!configReady || !bins.length}>
        <Printer size={16} aria-hidden="true" /> {printed ? "Print again" : `Print ${bins.length} bin ${bins.length === 1 ? "sheet" : "sheets"}`}
      </button>
    </>
  );

  return (
    <Modal open onClose={() => onCloseRef.current?.()} title="Print bin location sheets" footer={footer}>
      <div className="space-y-4">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          The selected parts are grouped by rack location into bins. Each bin prints on one {binW} × {binH} mm sheet —
          QR, description, location and Min / Max per part — to laminate and fix on the bin face. These are rack
          fixtures, so they are not recorded in the label print history.
        </p>

        <div ref={previewRef} className="flex flex-col items-center gap-1.5 rounded-lg bg-slate-50 p-4 dark:bg-navy-800">
          {firstHtml ? (
            <div style={{ width: sheetPxW * scale, height: sheetPxH * scale }}
              className="overflow-hidden border border-slate-300 bg-white shadow-sm">
              <iframe title="Bin sheet preview" srcDoc={firstHtml} scrolling="no" tabIndex={-1} aria-hidden="true"
                style={{ width: sheetPxW, height: sheetPxH, border: 0, transform: `scale(${scale})`, transformOrigin: "top left" }} />
            </div>
          ) : (
            <div className="skeleton h-40 w-full" />
          )}
          <span className="text-[11px] text-slate-400">
            First bin of {bins.length} · {binW} × {binH} mm
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-center">
          <div className="rounded-lg border border-slate-200 px-2 py-2 dark:border-navy-800">
            <p className="kpi-label">Bins</p>
            <p className="text-lg font-bold tabular text-slate-800 dark:text-white">{bins.length}</p>
          </div>
          <div className="rounded-lg border border-slate-200 px-2 py-2 dark:border-navy-800">
            <p className="kpi-label">Parts</p>
            <p className="text-lg font-bold tabular text-slate-800 dark:text-white">{parts.length}</p>
          </div>
        </div>

        {bins.length > 0 && (
          <ul className="max-h-48 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200 dark:divide-navy-800 dark:border-navy-800"
            aria-label="Bins to print">
            {bins.map((b) => (
              <li key={b.base} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className={`min-w-0 truncate font-mono ${b.base === "(no location)" ? "text-amber-700 dark:text-amber-300" : "text-slate-700 dark:text-slate-200"}`}>
                  {b.base}
                </span>
                <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                  {b.rows.length} {b.rows.length === 1 ? "part" : "parts"}
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
