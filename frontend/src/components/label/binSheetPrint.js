import toast from "react-hot-toast";
import { printLabels } from "../../utils/barcodeRender";

// One rule for "how many bin sheets" — shared by the rack / bin picker
// (BinPickerModal) and its preview (BinSheetPrintModal), so the summary line,
// the Sheets tile, the Print button and the toast can never disagree again (the
// first picker showed "Print 43 bins" while the toast said "65 sheets").
//
// A sheet is a PAGE that comes out of the printer. A crowded bin runs onto more
// than one page — "R1-S1-B5 (1/2)", "(2/2)" — and each of those pages counts.
// The figure is read off the print document itself (buildBinSheetsHtml), never
// worked out separately, so it is always what the printer gets.

const fmt = (n) => Number(n || 0).toLocaleString("en-IN");

// Pages in a bin-sheet print document: one ".bsheet" per page.
export const countSheets = (html) => (String(html || "").match(/class="bsheet"/g) || []).length;

// "5 sheets" — and "6 sheets", "Print 6 sheets"; the bins only when they differ.
export const sheetsWord = (n) => `${fmt(n)} ${n === 1 ? "sheet" : "sheets"}`;

// "6 sheets (5 bins)" when a crowded bin runs onto a second page, else "5 sheets".
export function sheetsText(sheets, bins) {
  return sheets === bins ? sheetsWord(sheets) : `${sheetsWord(sheets)} (${fmt(bins)} ${bins === 1 ? "bin" : "bins"})`;
}

// Prints a bin-sheet document that is already built (the same one the preview
// shows) and toasts the pages it holds. Returns that page count.
export function printBinSheetsHtml(html, binCount) {
  printLabels(html);
  const n = countSheets(html);
  toast.success(`${sheetsText(n, binCount)} sent to the printer`);
  return n;
}
