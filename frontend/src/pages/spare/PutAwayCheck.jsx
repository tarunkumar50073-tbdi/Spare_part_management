import React, { useState } from "react";
import toast from "react-hot-toast";
import { CheckCircle2, XCircle, Package, MapPin, PackageSearch, RotateCcw } from "lucide-react";
import BarcodeScanInput from "../../components/BarcodeScanInput.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { spareStockService } from "../../services/spareStockService.js";
import { binBaseLocation } from "../../utils/barcodeRender.js";

// Put-away check — scan the part (its lot tag), then scan the bin's location QR.
// The app says Right Location / Wrong Location so a part is never shelved in the
// wrong bin and bins don't get mixed. Read-only: it only reads the part's
// recorded location (the one printed on the lot tag); nothing is written.

// A lot-tag QR carries "GateEntryNo PartNo"; a bin-sheet / part QR carries just
// the Part No. Resolve by trying the whole scan and each whitespace token, so a
// lot tag and a plain part QR both identify the part.
async function resolvePart(storeCode, code) {
  const tries = [code, ...String(code).trim().split(/\s+/)].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const t of tries) {
    try {
      const row = await spareStockService.scan(storeCode, t).then((r) => r.data.data);
      if (row) return row;
    } catch { /* not this token — try the next */ }
  }
  return null;
}

export default function PutAwayCheck() {
  const { activeCode } = useStores();
  const storeCode = activeCode || "MAINTENANCE";
  const [part, setPart] = useState(null);     // resolved part — a bin scan is expected next
  const [result, setResult] = useState(null); // { ok, scanned }
  const [busy, setBusy] = useState(false);

  const reset = () => { setPart(null); setResult(null); };

  const onScan = async (raw) => {
    const code = String(raw || "").trim();
    if (!code || busy) return;
    // Step 1 (no part yet, or starting over after a result): identify the part.
    if (result != null || part == null) {
      setBusy(true); setResult(null); setPart(null);
      const row = await resolvePart(storeCode, code);
      setBusy(false);
      if (!row) { toast.error("Ye part nahi mila — part / lot tag ka QR scan karo"); return; }
      if (!binBaseLocation(row.location)) {
        toast.error(`${row.part_no}: iski location set nahi hai, pehle location daalo`);
        return;
      }
      setPart(row);
      return;
    }
    // Step 2: the part is known — this scan is the bin's location QR.
    const expected = binBaseLocation(part.location);
    const scanned = binBaseLocation(code);
    setResult({ ok: Boolean(scanned) && expected.toUpperCase() === scanned.toUpperCase(), scanned });
  };

  const expectedLoc = part ? (part.location || binBaseLocation(part.location)) : "";

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-4">
        <h2 className="text-lg font-bold text-slate-800 dark:text-white">Put-away check</h2>
        <p className="mt-0.5 text-xs text-slate-400">
          Part (ya lot tag) ka QR scan karo, phir us bin ka QR — app batayega Right / Wrong Location.
          Kuch badalta nahi, sirf check hota hai.
        </p>
      </div>

      <div className="card p-4">
        <BarcodeScanInput onScan={onScan} disabled={busy}
          placeholder={part ? "Ab is part ka BIN (location) QR scan karo…" : "Part / lot tag ka QR scan karo…"} />

        {/* Result — the loud Right / Wrong banner */}
        {result ? (
          <div className={`mt-4 rounded-xl2 p-4 text-center ${result.ok
            ? "bg-emerald-50 dark:bg-emerald-500/10"
            : "bg-rose-50 dark:bg-rose-500/10"}`}>
            {result.ok ? (
              <>
                <CheckCircle2 className="mx-auto text-emerald-600 dark:text-emerald-400" size={44} aria-hidden="true" />
                <p className="mt-1 text-2xl font-extrabold text-emerald-700 dark:text-emerald-300">Right Location</p>
                <p className="mt-1 text-sm text-emerald-800 dark:text-emerald-200">
                  {part.part_no} — {binBaseLocation(part.location)} me hi rakho. ✅
                </p>
              </>
            ) : (
              <>
                <XCircle className="mx-auto text-rose-600 dark:text-rose-400" size={44} aria-hidden="true" />
                <p className="mt-1 text-2xl font-extrabold text-rose-700 dark:text-rose-300">Wrong Location</p>
                <p className="mt-2 text-sm text-rose-800 dark:text-rose-200">
                  Lot tag ke hisaab se <b>{part.part_no}</b> yahan jaana hai:
                </p>
                <p className="mt-1 inline-flex items-center gap-1 rounded-lg bg-white/70 px-3 py-1 text-lg font-bold text-rose-800 dark:bg-rose-500/20 dark:text-rose-100">
                  <MapPin size={16} aria-hidden="true" /> {expectedLoc}
                </p>
                <p className="mt-2 text-xs text-rose-700/80 dark:text-rose-300/80">
                  Aapne scan kiya: {result.scanned || "—"}
                </p>
              </>
            )}
            <button type="button" onClick={reset}
              className="btn-secondary mt-4 inline-flex items-center gap-1.5 !py-1.5 text-xs">
              <RotateCcw size={14} aria-hidden="true" /> Agla part
            </button>
          </div>
        ) : part ? (
          /* Part identified — waiting for the bin scan */
          <div className="mt-4 rounded-xl2 border border-slate-200 bg-slate-50 p-4 dark:border-navy-700 dark:bg-navy-800/50">
            <div className="flex items-center gap-2">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-toyotared/10 text-toyotared">
                <Package size={18} aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="truncate font-semibold text-slate-800 dark:text-slate-100">{part.part_no}</p>
                <p className="truncate text-xs text-slate-500 dark:text-slate-400">{part.part_name}</p>
              </div>
            </div>
            <div className="mt-3 flex items-center gap-1.5 text-sm">
              <MapPin size={15} className="text-slate-400" aria-hidden="true" />
              <span className="text-slate-500 dark:text-slate-400">Isko yahan rakhna hai:</span>
              <b className="text-slate-800 dark:text-slate-100">{expectedLoc}</b>
            </div>
            <p className="mt-3 text-xs font-medium text-toyotared">👉 Ab us bin ka QR scan karo.</p>
            <button type="button" onClick={reset} className="btn-secondary mt-3 !py-1 text-[11px]">Reset</button>
          </div>
        ) : (
          <div className="mt-4 flex flex-col items-center gap-2 py-6 text-center">
            <PackageSearch size={28} className="text-slate-300 dark:text-slate-600" aria-hidden="true" />
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {busy ? "Dekh raha hoon…" : "Part ya lot tag ka QR scan karo."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
