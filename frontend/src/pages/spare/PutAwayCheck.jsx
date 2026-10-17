import React, { useState } from "react";
import toast from "react-hot-toast";
import { CheckCircle2, XCircle, Package, MapPin, PackageSearch, ScanLine, CheckCheck, Lock } from "lucide-react";
import BarcodeScanInput from "../../components/BarcodeScanInput.jsx";
import { useCan } from "../../components/Can.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { spareStockService } from "../../services/spareStockService.js";
import { matchBinScan, partBins } from "../../utils/binLocation.js";

// Put-away check — scan the part (its lot tag), then scan the bin's location QR.
// The app says Right Location / Wrong Location so a part is never shelved in the
// wrong bin and bins don't get mixed. A part with a rework location has TWO
// bins — fresh (new material) and rework (back from rework) — and either one is
// Right; the result says which. (A lot tag does not say whether the material is
// back from rework, so the screen does not guess — it accepts either bin.)
//   • Right Location  → the match details + a "Confirm Put Away" button, which
//     leads to a "Put Away Successful" acknowledgement and "New Scan".
//   • Wrong Location → the details (scanned in red, assigned in green) + the
//     correct bin to use + a "Scan Again" button.
// The location check READS the part's recorded location; "Confirm Put Away"
// then WRITES a put_away_log row (part, scanned location, lot qty, who, when)
// via spareStockService.putAwayRecord — it records the placement in D-SMS but
// moves no stock (the ERP update is a later step).

// A lot-tag QR carries "GateEntryNo PartNo"; a bin-sheet / part QR carries just
// the Part No. Resolve by trying the whole scan and each whitespace token, so a
// lot tag and a plain part QR both identify the part.
async function resolvePart(storeCode, code) {
  const tries = [code, ...String(code).trim().split(/\s+/)].filter((v, i, a) => v && a.indexOf(v) === i);
  for (const t of tries) {
    try {
      // silent: these are PROBE scans — the whole string and the gate-entry-no
      // token are expected to miss before the part-no token hits, so their 404s
      // must not pop a toast. A genuine "nothing matched" is handled by onScan.
      const row = await spareStockService.scan(storeCode, t, { silent: true }).then((r) => r.data.data);
      if (row) return row;
    } catch { /* not this token — try the next */ }
  }
  return null;
}

// What goes in which bin on a two-bin part (the store's rule).
const BIN_USE = { fresh: "new material", rework: "back from rework" };
const GREEN = "text-emerald-700 dark:text-emerald-300";

const fmtNum = (v) => (v == null || v === "" ? "—" : Number(v).toLocaleString("en-IN"));
const fmtStock = (p) => (p.qty_on_hand == null ? "Not loaded" : `${fmtNum(p.qty_on_hand)}${p.uom ? ` ${p.uom}` : ""}`);
const fmtDateTime = (d) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} `
  + `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

// A compact label → value detail table (the panel under the Right / Wrong banner).
function DetailTable({ rows }) {
  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 bg-white text-sm dark:border-navy-700 dark:bg-navy-900/40">
      {rows.map(([label, value, tone]) => (
        <div key={label}
          className="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-1.5 last:border-b-0 dark:border-navy-800">
          <span className="shrink-0 text-slate-500 dark:text-slate-400">{label}</span>
          <span className={`min-w-0 break-words text-right font-semibold ${tone || "text-slate-800 dark:text-slate-100"}`}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

// `embedded`: shown inside Scan Part, whose header already names the mode.
export default function PutAwayCheck({ embedded = false }) {
  const { activeCode } = useStores();
  const { user } = useAuth();
  // Recording the put-away is a Store Stock edit (POST /put-away/record); a
  // view-only login — the Manager template (17 Oct 2026) — still sees Right /
  // Wrong Location, but is told it cannot confirm instead of meeting a refusal.
  const canRecord = useCan("store_stock", "edit");
  const storeCode = activeCode || "MAINTENANCE";
  const [part, setPart] = useState(null);     // resolved part — a bin scan is expected next
  const [result, setResult] = useState(null); // { ok, scanned, bin } (matchBinScan)
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false); // Confirm Put Away in flight
  const [lot, setLot] = useState(null);        // { gate_entry_no, qty } from the lot tag
  const [done, setDone] = useState(null);      // the saved put-away record after Confirm

  const reset = () => { setPart(null); setResult(null); setDone(null); setLot(null); };
  const rescanBin = () => setResult(null);     // keep the part, scan the bin again
  // The part's bin(s): its location, plus its rework location when it has one.
  const bins = part ? partBins(part.location, part.rework_location) : [];

  const onScan = async (raw) => {
    const code = String(raw || "").trim();
    if (!code || busy) return;
    // Step 1 (no part yet, after a result, or after a completed put-away): identify the part.
    if (done != null || result != null || part == null) {
      setBusy(true); setResult(null); setPart(null); setDone(null); setLot(null);
      const row = await resolvePart(storeCode, code);
      if (!row) { setBusy(false); toast.error("Part not found — scan the part / lot tag QR"); return; }
      if (!partBins(row.location, row.rework_location).length) {
        setBusy(false);
        toast.error(`${row.part_no}: no location set — set its location first`);
        return;
      }
      setPart(row);
      // If it was a LOT TAG ("GateEntryNo PartNo"), the gate-entry token is the
      // digits-and-slashes one (e.g. "2627/001/11416"). Pull the lot qty for it.
      const geTok = code.split(/\s+/).find((t) => t.includes("/") && /\d/.test(t) && !/[A-Za-z]/.test(t));
      if (geTok) {
        try {
          const q = await spareStockService.lotQty(storeCode, geTok, row.part_no).then((r) => r.data.data.qty);
          setLot({ gate_entry_no: geTok, qty: q });
        } catch { setLot(null); }
      }
      setBusy(false);
      return;
    }
    // Step 2: the part is known — this scan is the bin / partition QR, matched
    // against the part's bin(s): a slot "(n)" to the EXACT partition, so a part
    // can't go into the wrong slot of the right bin; a bare base QR at bin level.
    setResult(matchBinScan(code, bins));
  };

  // The bin(s) as detail rows — "Assigned Location" on a one-bin part, "Fresh /
  // Rework Location" on a two-bin one; `tone(bin)` colours each value.
  const binRows = (tone) => bins.map((b) => [b.label ? `${b.label} Location` : "Assigned Location", b.location, tone(b)]);
  const minMax = part ? `${fmtNum(part.min_stock_level)} / ${fmtNum(part.max_stock_level)}` : "—";
  // Lot Qty row — only when the scanned tag was a lot tag that resolved a qty.
  const lotRow = (lot && lot.qty != null)
    ? [["Lot Qty", `${fmtNum(lot.qty)}${part?.uom ? ` ${part.uom}` : ""}`]] : [];

  const confirmPutAway = async () => {
    if (saving || !part || !result?.ok) return;
    setSaving(true);
    try {
      const rec = await spareStockService.putAwayRecord({
        part_id: part.part_id,
        scanned_location: result.scanned,
        gate_entry_no: lot?.gate_entry_no || undefined,
      }).then((r) => r.data.data);
      setDone(rec);   // the saved record — the success screen shows it
    } catch {
      /* handled globally (e.g. location mismatch / no permission) */
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-4">
        {!embedded && <h2 className="mb-0.5 text-lg font-bold text-slate-800 dark:text-white">Put-away check</h2>}
        <p className="text-xs text-slate-400">
          Scan the part (or lot tag) QR, then the bin's QR — the app shows Right / Wrong Location.
          On Right, <b>Confirm Put Away</b>; on Wrong, it shows the correct bin — <b>Scan Again</b>.
        </p>
      </div>

      <div className="card p-4">
        {/* The scanner stays live except on the final success screen. */}
        {!done && (
          <BarcodeScanInput onScan={onScan} disabled={busy}
            placeholder={part && !result ? "Now scan this part's BIN (location) QR…" : "Scan the part / lot tag QR…"} />
        )}

        {/* ---- Step 6: Put Away Successful ---- */}
        {done ? (
          <div className="mt-2 rounded-xl2 bg-emerald-50 p-5 text-center dark:bg-emerald-500/10">
            <CheckCircle2 className="mx-auto text-emerald-600 dark:text-emerald-400" size={48} aria-hidden="true" />
            <p className="mt-1 text-2xl font-extrabold text-emerald-700 dark:text-emerald-300">Put Away Successful</p>
            <DetailTable rows={[
              ["Part No.", done.part_no || part.part_no],
              [done.location_kind === "rework" ? "Rework Location" : done.location_kind ? "New Location" : "Location",
                done.location, GREEN],
              ...(done.qty != null ? [["Lot Qty", `${fmtNum(done.qty)}${done.uom ? ` ${done.uom}` : ""}`]] : []),
              ["Date & Time", fmtDateTime(new Date(done.confirmed_at))],
              ["Put By", user?.full_name || user?.username || done.put_by || "—"],
            ]} />
            <p className="mt-2 text-[11px] text-emerald-700/70 dark:text-emerald-300/70">
              Recorded in D-SMS. (ERP update will follow later.)
            </p>
            <button type="button" onClick={reset}
              className="btn-primary mt-4 inline-flex w-full items-center justify-center gap-2">
              <ScanLine size={18} aria-hidden="true" /> New Scan
            </button>
          </div>
        ) : result ? (
          /* ---- Step 4 / 5: Right or Wrong Location, with details + action ---- */
          result.ok ? (
            <div className="mt-4 rounded-xl2 bg-emerald-50 p-4 dark:bg-emerald-500/10">
              <p className="flex items-center justify-center gap-2 text-2xl font-extrabold text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 size={28} aria-hidden="true" /> Right Location
                {result.bin?.label ? ` — ${result.bin.label} bin` : ""}
              </p>
              <DetailTable rows={[
                ["Part No.", part.part_no],
                ["Scanned Location", result.scanned || "—", GREEN],
                // The matched bin in green; on a two-bin part the other one plain.
                ...binRows((b) => (b.kind === result.bin?.kind ? GREEN : undefined)),
                ["Min / Max Qty", minMax],
                ["Current Stock", fmtStock(part)],
                ...lotRow,
              ]} />
              <p className="mt-2 text-center text-sm text-emerald-800 dark:text-emerald-200">
                {part.part_no} is in the right bin — confirm the put-away.
              </p>
              {canRecord ? (
                <button type="button" onClick={confirmPutAway} disabled={saving}
                  className="btn-primary mt-3 inline-flex w-full items-center justify-center gap-2 disabled:opacity-60">
                  <CheckCheck size={18} aria-hidden="true" /> {saving ? "Confirming…" : "Confirm Put Away"}
                </button>
              ) : (
                <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <Lock size={14} aria-hidden="true" />View only — confirming a put-away needs the Store Stock edit right
                </p>
              )}
            </div>
          ) : (
            <div className="mt-4 rounded-xl2 bg-rose-50 p-4 dark:bg-rose-500/10">
              <p className="flex items-center justify-center gap-2 text-2xl font-extrabold text-rose-700 dark:text-rose-300">
                <XCircle size={28} aria-hidden="true" /> Wrong Location
              </p>
              <DetailTable rows={[
                ["Part No.", part.part_no],
                ["Scanned Location", result.scanned || "—", "text-rose-700 dark:text-rose-300"],
                ...binRows(() => GREEN),
                ["Min / Max Qty", minMax],
                ["Current Stock", fmtStock(part)],
                ...lotRow,
              ]} />
              <div className="mt-3 flex items-start gap-2 rounded-lg bg-white/70 px-3 py-2 text-sm dark:bg-rose-500/15">
                <XCircle size={18} className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-300" aria-hidden="true" />
                <p className="text-rose-800 dark:text-rose-100">
                  <b>Wrong Location Scanned.</b> Put this material at:{" "}
                  {bins.map((b, i) => (
                    <React.Fragment key={b.kind}>
                      {i > 0 && " or "}
                      <span className="inline-flex items-center gap-1 font-bold">
                        <MapPin size={14} aria-hidden="true" /> {b.label ? `${b.label} bin ` : ""}{b.location}
                      </span>
                      {b.label && ` (${BIN_USE[b.kind]})`}
                    </React.Fragment>
                  ))}
                </p>
              </div>
              <button type="button" onClick={rescanBin}
                className="btn-primary mt-3 inline-flex w-full items-center justify-center gap-2">
                <ScanLine size={18} aria-hidden="true" /> Scan Again
              </button>
            </div>
          )
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
            {bins.map((b, i) => (
              <div key={b.kind} className={`${i ? "mt-1" : "mt-3"} flex flex-wrap items-center gap-1.5 text-sm`}>
                <MapPin size={15} className="text-slate-400" aria-hidden="true" />
                <span className="text-slate-500 dark:text-slate-400">
                  {b.label ? `${b.label} bin (${BIN_USE[b.kind]}):` : "It should go here:"}
                </span>
                <b className="text-slate-800 dark:text-slate-100">{b.location}</b>
              </div>
            ))}
            <p className="mt-3 text-xs font-medium text-toyotared">
              {bins.length > 1 ? "👉 Now scan the QR of the bin it goes in — new or rework." : "👉 Now scan that bin's QR."}
            </p>
            <button type="button" onClick={reset} className="btn-secondary mt-3 !py-1 text-[11px]">Reset</button>
          </div>
        ) : (
          <div className="mt-4 flex flex-col items-center gap-2 py-6 text-center">
            <PackageSearch size={28} className="text-slate-300 dark:text-slate-600" aria-hidden="true" />
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {busy ? "Looking up…" : "Scan the part or lot tag QR."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
