import React, { useState } from "react";
import toast from "react-hot-toast";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle, Package, MapPin, PackageSearch, ScanLine, CheckCheck, Lock, Truck } from "lucide-react";
import BarcodeScanInput from "../../components/BarcodeScanInput.jsx";
import PartSearch from "../../components/scan/PartSearch.jsx";
import ScanFailurePanel from "../../components/scan/ScanFailurePanel.jsx";
import { useCan } from "../../components/Can.jsx";
import { useStores } from "../../context/StoreContext.jsx";
import { useAuth } from "../../context/AuthContext.jsx";
import { spareStockService } from "../../services/spareStockService.js";
import { barcodeService } from "../../services/barcodeService.js";
import { matchBinScan, partBins } from "../../utils/binLocation.js";

// Put-away check — (1) type / search the part no., (2) scan the bin's location
// QR. The app says Right Location / Wrong Location so a part is never shelved in
// the wrong bin and bins don't get mixed. A part with a rework location has TWO
// bins — fresh (new material) and rework (back from rework) — and either one is
// Right; the result says which. (The screen cannot tell whether the material is
// back from rework, so it does not guess — it accepts either bin.)
//   • Right Location  → the match details, the Lot Qty and a "Confirm Put Away"
//     button, which leads to a "Put Away Successful" acknowledgement.
//   • Wrong Location → the details (scanned in red, assigned in green) + the
//     correct bin to use; the next bin scan checks again ("Scan Again" clears it).
//
// Step 1 used to be a scan of the part's lot tag (QR = gate entry no. + Part No.),
// which also carried the lot qty. Management said the lot tags waste paper and
// the store had them taken out on 17 Oct 2026 ("lot tag bhi kah rhe h ki paper
// wastage h use hta do"). So the part is typed / searched (the Scan Part search,
// components/scan/PartSearch), and Lot Qty is filled from the part's LATEST ERP
// gate entry — its no. and date shown beside it. The storeman may correct the
// qty, or leave it empty (a part ERP has no gate entry for). A bin sheet QR or an
// old lot tag read into the search box still identifies the part (the server
// reads the Part No. in it).
//
// The latest gate entry is a guess at the delivery the material came on, so it
// is recorded only where the guess holds: NOT on a put-away into the REWORK bin
// — that bin holds material back from rework (store rule, 14 Oct 2026), and the
// latest gate entry may well be new material — unless the storeman says the
// material came on it ("Use this gate entry"); and not when he empties Lot Qty
// (the gate entry goes with its qty). Such a row records no gate entry, as a
// put-away without a lot tag did before.
//
// The location check READS the part's recorded location; "Confirm Put Away"
// then WRITES a put_away_log row (part, scanned location, lot qty + the gate
// entry no. it came from, who, when) via spareStockService.putAwayRecord — it
// records the placement in D-SMS but moves no stock (the ERP update is later).

// A gun read typed into the search box: a SUPPLIER's barcode / QR mapped to the
// part (the store, 22 Oct 2026: "supplier k bar tag and qr tag bhi aaten h to
// unko bhi map karenge"), a bin-sheet QR "PartNo Location" (the description
// after " | " is already cut off), an old lot tag "GateEntryNo PartNo", or a
// bare Part No. It goes through the one resolver Scan Part uses
// (BarcodeService.resolve: active mappings first, then the Part No. and each
// word of the read) and is audited like any scan. Only text that listed no
// part in the search comes here — in practice a gun read, which ends in Enter —
// so it is recorded as a scanner read. Resolves { part } or { failure } (what
// the failure panel shows: UNKNOWN_BARCODE offers Map to Part).
async function resolvePart(storeCode, code) {
  try {
    const r = await barcodeService.resolve(storeCode, code, { scanSource: "USB_SCANNER", scanMode: "LOOKUP" });
    return { part: r.data.data || null };
  } catch (err) {
    const resp = err?.response;
    if (!resp) return { failure: { code, result: "NETWORK", message: null } };
    const errors = resp.data?.errors;
    return { failure: { code: errors?.code || code, result: errors?.result || "NOT_FOUND", message: resp.data?.message || null } };
  }
}

// What goes in which bin on a two-bin part (the store's rule).
const BIN_USE = { fresh: "new material", rework: "back from rework" };
const GREEN = "text-emerald-700 dark:text-emerald-300";
// The most a Lot Qty may be (the server's limit too).
const LOT_QTY_MAX = 1_000_000_000;

const fmtNum = (v) => (v == null || v === "" ? "—" : Number(v).toLocaleString("en-IN"));
const fmtStock = (p) => (p.qty_on_hand == null ? "Not loaded" : `${fmtNum(p.qty_on_hand)}${p.uom ? ` ${p.uom}` : ""}`);
const fmtDateTime = (d) =>
  `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()} `
  + `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
// A gate date "2026-10-15" as the store writes it, "15/10/2026".
const fmtGateDate = (iso) => {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || "");
};
// "Gate entry 2627/001/11416 · 15/10/2026" — where the lot qty came from.
const gateText = (lot) => [lot.gate_entry_no && `Gate entry ${lot.gate_entry_no}`, lot.gate_entry_dt && fmtGateDate(lot.gate_entry_dt)]
  .filter(Boolean).join(" · ");
const withUom = (qty, uom) => `${fmtNum(qty)}${uom ? ` ${uom}` : ""}`;
// A gate entry's qty as the field shows it (2 decimals at most, as stored).
const qtyFieldText = (q) => (q == null ? "" : String(Math.round(Number(q) * 100) / 100));

// The Lot Qty as typed: null when left empty, a number above 0 with at most 2
// decimals, or NaN for anything else (refused on Confirm). The server keeps 2
// decimals — it would round 12.345 to 12.34 and refuse 0.004 (0.00) — so more
// is refused here, in this screen's words, and what is saved is what was typed.
const QTY_TEXT = /^(\d+(\.\d{0,2})?|\.\d{1,2})$/;
function parseLotQty(text) {
  const t = String(text ?? "").trim().replace(/,/g, "");
  if (!t) return null;
  if (!QTY_TEXT.test(t)) return NaN;
  const n = Number(t);
  return n > 0 && n <= LOT_QTY_MAX ? n : NaN;
}

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

// Where the Lot Qty comes from, in one line: the gate entry, or why there is none.
// On the rework bin (`rework`) the latest gate entry is only offered — `taken`
// once the storeman says the material came on it; `onTake(bool)` switches that.
function LotSource({ lotQ, rework = false, taken = false, onTake }) {
  const lot = lotQ.data;
  const ge = lot?.gate_entry_no ? gateText(lot).replace(/^Gate/, "gate") : "";
  const offer = rework && Boolean(ge) && !lotQ.isPending && !lotQ.isError;
  const text = lotQ.isPending ? "Reading the part's latest gate entry…"
    : lotQ.isError ? "Couldn't read the gate entry — type the qty, or leave it empty."
      : !ge ? "No ERP gate entry for this part — the qty is optional."
        : !rework ? `Latest ${ge}`
          : taken ? `From the latest ${ge} — used for this rework put-away.`
            : `Rework bin — not filled from the latest ${ge}${lot.qty != null ? ` (${withUom(lot.qty, lot.uom)})` : ""}, `
              + "which may be new material.";
  return (
    <p className="flex flex-wrap items-start gap-x-1.5 text-[11px] text-slate-500 dark:text-slate-400">
      <Truck size={13} className="mt-px shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {text}
        {offer && onTake && (
          <button type="button" onClick={() => onTake(!taken)}
            className="ml-1 font-semibold text-toyotared underline underline-offset-2">
            {taken ? "Don't use it" : "Use this gate entry"}
          </button>
        )}
      </span>
    </p>
  );
}

// `embedded`: shown inside Scan Part, whose header already names the mode.
export default function PutAwayCheck({ embedded = false }) {
  const { activeCode } = useStores();
  const { user } = useAuth();
  // Recording the put-away is a Store Stock edit (POST /put-away/record); a
  // view-only login — the Manager template (17 Oct 2026) — still sees Right /
  // Wrong Location, but is told it cannot confirm instead of meeting a refusal.
  // POST /put-away/record takes the Store Stock or the Put-away Check edit right.
  const canRecordStock = useCan("store_stock", "edit");
  const canRecordPutAway = useCan("put_away_check", "edit");
  const canRecord = canRecordStock || canRecordPutAway;
  // Map an unknown supplier barcode to the part, as on Scan Part.
  const canMap = useCan("supplier_barcodes", "edit");
  const [failure, setFailure] = useState(null); // a code that named no part (ScanFailurePanel)
  const storeCode = activeCode || "MAINTENANCE";
  const [part, setPart] = useState(null);     // identified part — a bin scan is expected next
  const [result, setResult] = useState(null); // { ok, scanned, bin } (matchBinScan)
  const [busy, setBusy] = useState(false);    // identifying the part
  const [saving, setSaving] = useState(false); // Confirm Put Away in flight
  const [qtyText, setQtyText] = useState(null); // Lot Qty as typed; null = not touched (the gate entry's)
  const [lotOnRework, setLotOnRework] = useState(false); // the latest gate entry taken for a rework-bin put-away
  const [done, setDone] = useState(null);      // the saved put-away record after Confirm

  // The part's latest ERP gate entry and its lot qty (GET .../latest-lot).
  const lotQ = useQuery({
    queryKey: ["put-away-lot", part?.part_id],
    queryFn: () => spareStockService.latestLot(part.part_id).then((r) => r.data.data),
    enabled: Boolean(part?.part_id),
    staleTime: 0,
    retry: false,
  });
  const lot = lotQ.data || null;
  const uom = lot?.uom || part?.uom || "";
  // Right Location in the REWORK bin: material back from rework, so the latest
  // gate entry (maybe new material) is not filled in unless taken (see the top).
  const reworkBin = Boolean(result?.ok && result.bin?.kind === "rework");
  const lotOffered = Boolean(lot?.gate_entry_no) && (!reworkBin || lotOnRework);
  const qtyValue = qtyText ?? (lotOffered ? qtyFieldText(lot.qty) : "");
  // The gate entry to record with `qty`: the offered one while the field holds
  // its qty (as filled, or typed over for part of the lot) — none once the
  // storeman emptied the field. (Untouched with no qty: the gate entry had none.)
  const gateEntryFor = (qty) => (lotOffered && (qty != null || qtyText == null) ? lot.gate_entry_no : null);
  // Take / drop the latest gate entry on the rework bin; the field follows it.
  const takeLot = (take) => { setLotOnRework(take); setQtyText(null); };

  const reset = () => { setPart(null); setResult(null); setDone(null); setQtyText(null); setLotOnRework(false); };
  const rescanBin = () => setResult(null);     // keep the part, scan the bin again
  // The part's bin(s): its location, plus its rework location when it has one.
  const bins = part ? partBins(part.location, part.rework_location) : [];

  // Step 1 — the part, from a picked search row (read fresh by its id) or a gun
  // read / typed code the search lists nothing for (resolved like a scan).
  // Resolves false when nothing usable was found, so the search box keeps the text.
  const identify = async (load) => {
    if (busy) return false;
    setBusy(true); reset();
    let row = null;
    try { row = await load(); } catch { row = null; }
    setBusy(false);
    if (!row) { toast.error("Part not found — type or search the part no."); return false; }
    if (!partBins(row.location, row.rework_location).length) {
      toast.error(`${row.part_no}: no location set — set its location first`);
      return false;
    }
    setPart(row);
    return true;
  };
  const onPick = (row) => identify(() => spareStockService.forPart(row.part_id).then((r) => r.data.data));
  const onText = async (text) => {
    // A bin-sheet QR ends in " | description" since 17 Oct 2026 — only the text
    // before it is read, so a word in the description can't pick another part.
    // (A mapped supplier code is matched whole first, on the server.)
    const read = String(text || "").trim();
    if (!read || busy) return false;
    setFailure(null);
    const out = await resolvePart(storeCode, read);
    if (out.failure) {
      setFailure(out.failure);
      return false;
    }
    return identify(async () => out.part);
  };

  // Step 2: the part is known — this scan is the bin / partition QR, matched
  // against the part's bin(s): a slot "(n)" to the EXACT partition, so a part
  // can't go into the wrong slot of the right bin; a bare base QR at bin level.
  // After a Wrong Location the next scan simply checks again.
  const onBinScan = (raw) => {
    const code = String(raw || "").trim();
    if (!code || !part || done || result?.ok) return;
    setResult(matchBinScan(code, bins));
  };

  // The bin(s) as detail rows — "Assigned Location" on a one-bin part, "Fresh /
  // Rework Location" on a two-bin one; `tone(bin)` colours each value.
  const binRows = (tone) => bins.map((b) => [b.label ? `${b.label} Location` : "Assigned Location", b.location, tone(b)]);
  const minMax = part ? `${fmtNum(part.min_stock_level)} / ${fmtNum(part.max_stock_level)}` : "—";
  // Lot rows (read-only) — the qty as it stands now and the gate entry it is from.
  const lotRows = () => {
    const q = parseLotQty(qtyValue);
    const rows = [["Lot Qty", q == null || Number.isNaN(q) ? "—" : withUom(q, uom)]];
    if (lotOffered) rows.push(["Gate Entry", gateText(lot).replace(/^Gate entry /, "")]);
    else if (reworkBin && lot?.gate_entry_no) rows.push(["Gate Entry", "Not used — rework bin"]);
    return rows;
  };

  const confirmPutAway = async () => {
    if (saving || !part || !result?.ok) return;
    const qty = parseLotQty(qtyValue);
    if (Number.isNaN(qty)) {
      toast.error("Lot Qty must be a number above 0 with at most 2 decimals — or leave it empty.");
      return;
    }
    setSaving(true);
    try {
      const rec = await spareStockService.putAwayRecord({
        part_id: part.part_id,
        scanned_location: result.scanned,
        // The gate entry the lot came on (the part's latest) — kept when the qty
        // was typed over; none on the rework bin unless taken, or with no qty.
        gate_entry_no: gateEntryFor(qty),
        qty,
      }).then((r) => r.data.data);
      setDone(rec);   // the saved record — the success screen shows it
    } catch {
      /* handled globally (e.g. location mismatch / no permission) */
    } finally {
      setSaving(false);
    }
  };

  // Step 1 is the search box; steps 2 (bin scan) and Wrong Location take the gun.
  const searching = !part && !done;
  const scanningBin = part && !done && !result?.ok;

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-4">
        {!embedded && <h2 className="mb-0.5 text-lg font-bold text-slate-800 dark:text-white">Put-away check</h2>}
        <p className="text-xs text-slate-400">
          Type or search the part no., then scan the bin's QR — the app shows Right / Wrong Location.
          On Right, check the <b>Lot Qty</b> (from the part's latest gate entry) and <b>Confirm Put Away</b>;
          on Wrong, it shows the correct bin — scan again.
        </p>
      </div>

      <div className="card p-4">
        {/* Not disabled while the part is looked up, so the caret stays in the
            box for the next try when nothing is found (identify ignores a
            second Enter meanwhile). */}
        {searching && (
          <PartSearch storeCode={storeCode} onPick={(row) => { setFailure(null); return onPick(row); }} onSubmitText={onText}
            label="Search the part to put away" placeholder="Type or search the part no. — or scan the supplier's barcode / QR…" />
        )}
        {/* A code that named no part: an unknown supplier barcode can be mapped
            to its part right here (supplier_barcodes edit), then it is read again. */}
        {searching && failure && (
          <div className="mt-3">
            <ScanFailurePanel
              failure={failure}
              canMap={canMap}
              storeCode={storeCode}
              onSearch={() => setFailure(null)}
              onCancel={() => setFailure(null)}
              onRetry={() => onText(failure.code)}
              onMapped={() => onText(failure.code)}
            />
          </div>
        )}
        {scanningBin && (
          <BarcodeScanInput onScan={onBinScan} disabled={saving}
            placeholder={result ? "Scan the right bin's QR…" : "Now scan this part's BIN (location) QR…"} />
        )}

        {/* ---- Put Away Successful ---- */}
        {done ? (
          <div className="mt-2 rounded-xl2 bg-emerald-50 p-5 text-center dark:bg-emerald-500/10">
            <CheckCircle2 className="mx-auto text-emerald-600 dark:text-emerald-400" size={48} aria-hidden="true" />
            <p className="mt-1 text-2xl font-extrabold text-emerald-700 dark:text-emerald-300">Put Away Successful</p>
            <DetailTable rows={[
              ["Part No.", done.part_no || part.part_no],
              [done.location_kind === "rework" ? "Rework Location" : done.location_kind ? "New Location" : "Location",
                done.location, GREEN],
              ...(done.qty != null ? [["Lot Qty", withUom(done.qty, done.uom)]] : []),
              ...(done.gate_entry_no ? [["Gate Entry", done.gate_entry_no]] : []),
              ["Date & Time", fmtDateTime(new Date(done.confirmed_at))],
              ["Put By", user?.full_name || user?.username || done.put_by || "—"],
            ]} />
            <p className="mt-2 text-[11px] text-emerald-700/70 dark:text-emerald-300/70">
              Recorded in D-SMS. (ERP update will follow later.)
            </p>
            <button type="button" onClick={reset}
              className="btn-primary mt-4 inline-flex w-full items-center justify-center gap-2">
              <PackageSearch size={18} aria-hidden="true" /> Next Part
            </button>
          </div>
        ) : result ? (
          /* ---- Right or Wrong Location, with details + action ---- */
          result.ok ? (
            <div className="mt-2 rounded-xl2 bg-emerald-50 p-4 dark:bg-emerald-500/10">
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
                ...(canRecord ? [] : lotRows()),
              ]} />
              {canRecord ? (
                <>
                  {/* Lot Qty — the latest gate entry's, editable; empty is allowed. */}
                  <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-navy-700 dark:bg-navy-900/40">
                    <label htmlFor="put-away-lot-qty" className="flex items-center justify-between gap-3 text-sm">
                      <span className="shrink-0 text-slate-500 dark:text-slate-400">Lot Qty</span>
                      <span className="flex items-center gap-1.5">
                        <input id="put-away-lot-qty" type="text" inputMode="decimal" autoComplete="off"
                          value={qtyValue} onChange={(e) => setQtyText(e.target.value)}
                          placeholder={lotQ.isPending ? "…" : "Optional"} disabled={saving}
                          className="input-field h-9 w-28 text-right font-semibold tabular" />
                        {uom && <span className="text-xs text-slate-500 dark:text-slate-400">{uom}</span>}
                      </span>
                    </label>
                    <div className="mt-1">
                      <LotSource lotQ={lotQ} rework={reworkBin} taken={lotOnRework} onTake={saving ? undefined : takeLot} />
                    </div>
                  </div>
                  <p className="mt-2 text-center text-sm text-emerald-800 dark:text-emerald-200">
                    {part.part_no} is in the right bin — confirm the put-away.
                  </p>
                  <button type="button" onClick={confirmPutAway} disabled={saving || lotQ.isPending}
                    className="btn-primary mt-3 inline-flex w-full items-center justify-center gap-2 disabled:opacity-60">
                    <CheckCheck size={18} aria-hidden="true" />
                    {saving ? "Confirming…" : lotQ.isPending ? "Reading lot qty…" : "Confirm Put Away"}
                  </button>
                  <button type="button" onClick={reset} disabled={saving}
                    className="btn-secondary mt-2 w-full justify-center !py-1.5 text-xs">Cancel — another part</button>
                </>
              ) : (
                <>
                  <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                    <Lock size={14} aria-hidden="true" />View only — confirming a put-away needs the Store Stock edit right
                  </p>
                  <button type="button" onClick={reset}
                    className="btn-secondary mt-2 w-full justify-center !py-1.5 text-xs">Another part</button>
                </>
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
                ...lotRows(),
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
            {/* The lot qty the put-away will record (editable on Right Location) —
                on a two-bin part for the new bin; the rework bin asks first. */}
            <div className="mt-3 rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-navy-700 dark:bg-navy-900/40">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="text-slate-500 dark:text-slate-400">{bins.length > 1 ? "Lot Qty (new bin)" : "Lot Qty"}</span>
                <b className="text-slate-800 dark:text-slate-100">
                  {lotQ.isPending ? "…" : lot?.qty != null ? withUom(lot.qty, uom) : "—"}
                </b>
              </div>
              <div className="mt-1"><LotSource lotQ={lotQ} /></div>
            </div>
            <p className="mt-3 text-xs font-medium text-toyotared">
              {bins.length > 1 ? "👉 Now scan the QR of the bin it goes in — new or rework." : "👉 Now scan that bin's QR."}
            </p>
            <button type="button" onClick={reset} className="btn-secondary mt-3 !py-1 text-[11px]">Reset</button>
          </div>
        ) : (
          <div className="mt-4 flex flex-col items-center gap-2 py-6 text-center">
            <PackageSearch size={28} className="text-slate-300 dark:text-slate-600" aria-hidden="true" />
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {busy ? "Looking up…" : "Type or search the part no. to put away."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
