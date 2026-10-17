import React, { useMemo } from "react";
import { QrCode } from "lucide-react";
import { useStockList } from "../../lib/stockQueries.js";
import { useLabelConfig } from "../label/useLabelConfig";
import { useBoxWidth } from "../label/useBoxWidth";
import { binBaseLocation, buildBinSheetsHtml, groupIntoBins } from "../../utils/barcodeRender.js";

// What hangs at the part's rack location: its BIN SHEET — the laminated tag
// printed from Store Stock, one per bin, listing every part of that bin of the
// part's section (QR of the Part No., description, location, Min / Max). It is
// drawn by the same code that prints it, so the card shows the label exactly as
// it is on the rack. (The card used to show a part-by-part QR label, which the
// store no longer prints — it prints bin sheets and lot tags.)

const PX_PER_MM = 96 / 25.4;      // CSS px per mm at 96 dpi — the preview's scale

export function PartVisualPlaceholder() {
  return (
    <section className="card flex flex-col items-center p-6 text-center" aria-label="Part visual">
      <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-slate-100 text-slate-400 dark:bg-navy-800">
        <QrCode size={28} aria-hidden="true" />
      </span>
      <p className="mt-3 text-sm font-semibold text-slate-700 dark:text-slate-200">No part on screen</p>
      <p className="mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400">
        Scan a part — the bin label at its location, where it is and its history appear here.
      </p>
    </section>
  );
}

/**
 * part       scan.part (part_no, part_name, location, rework_location, section_id, section_name, min / max)
 * storeCode  the store whose cached stock list holds the bin's other parts
 */
export default function PartVisual({ part, storeCode }) {
  const { config, ready } = useLabelConfig();
  const [boxRef, boxW] = useBoxWidth();
  // A part may sit in two bins: new material in its own (fresh) location, and
  // what came back from rework in its rework location — one sheet for each.
  const freshBase = binBaseLocation(part.location);
  const reworkBase = binBaseLocation(part.rework_location);
  const bases = [
    freshBase && { base: freshBase, kind: part.rework_location ? "New" : null },
    reworkBase && reworkBase !== freshBase && { base: reworkBase, kind: "Rework" },
  ].filter(Boolean);
  // The section's cached stock list — the same copy the stock screens use.
  const stock = useStockList(storeCode, part.section_id ?? null, { enabled: bases.length > 0 });

  // A bin is keyed on section AND base location (rack numbers repeat across
  // sections). If the list cannot be read, a sheet shows this part alone.
  const bins = useMemo(() => {
    if (!bases.length || stock.isPending) return [];
    const section = part.section_id ?? null;
    return bases.map(({ base, kind }) => {
      const rows = (stock.data || []).filter((r) => (r.section_id ?? null) === section
        && (binBaseLocation(r.location) === base || binBaseLocation(r.rework_location) === base));
      const bin = groupIntoBins((rows.length ? rows : [part]).map((r) => ({ ...r, section_name: part.section_name || "" })))
        .find((b) => b.base === base);
      return bin && { ...bin, kind, html: ready ? buildBinSheetsHtml([bin], config) : "" };
    }).filter(Boolean);
    // `bases` is derived from the part on every render; the part is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part, stock.isPending, stock.data, ready, config]);

  const binW = Number(config?.bin_width_mm) || 130;
  const binH = Number(config?.bin_height_mm) || 90;
  const sheetW = binW * PX_PER_MM;
  const sheetH = binH * PX_PER_MM;
  const scale = Math.min((boxW || 360) / sheetW, 1);

  return (
    <section className="card p-4" aria-label="Bin label at the location">
      <h2 className="kpi-label mb-3">{bases.length > 1 ? "Bin labels at its two locations" : "Bin label at the location"}</h2>
      <div ref={boxRef} className="space-y-3">
        {!bases.length ? (
          <p className="rounded-lg bg-slate-50 px-3 py-4 text-center text-sm text-slate-500 dark:bg-navy-800 dark:text-slate-400">
            No rack location is set for this part, so there is no bin label for it.
          </p>
        ) : bins.length && bins.every((b) => b.html) ? bins.map((b) => (
          <div key={b.base}>
            {b.kind && (
              <p className={`mb-1 text-[11px] font-semibold uppercase tracking-wide ${b.kind === "Rework"
                ? "text-amber-700 dark:text-amber-300" : "text-emerald-700 dark:text-emerald-300"}`}>
                {b.kind === "Rework" ? "Rework location — parts back from rework" : "New location — new parts"}
              </p>
            )}
            {/* Always black on white, as the printed sheet is — a QR needs the contrast in dark mode too. */}
            <div style={{ width: sheetW * scale, height: sheetH * scale }}
              className="overflow-hidden rounded border border-slate-300 bg-white shadow-sm">
              <iframe title={`Bin label ${b.base}`} srcDoc={b.html} scrolling="no" tabIndex={-1} aria-hidden="true"
                style={{ width: sheetW, height: sheetH, border: 0, transform: `scale(${scale})`, transformOrigin: "top left" }} />
            </div>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              Bin <b className="font-mono text-slate-700 dark:text-slate-200">{b.base}</b>
              {part.section_name ? ` · ${part.section_name}` : ""} · {b.rows.length} {b.rows.length === 1 ? "part" : "parts"} ·
              {` ${binW} × ${binH} mm, as printed from Store Stock`}
            </p>
          </div>
        )) : (
          <div className="skeleton h-40 w-full" />
        )}
      </div>
      {bases.length > 0 && stock.isError && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
          The bins&apos; other parts could not be read — only this part is shown on the sheets.
        </p>
      )}
    </section>
  );
}
