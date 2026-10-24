import React, { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, CircleCheckBig, Eye, Printer, Search, TriangleAlert, X } from "lucide-react";
import Modal from "../Modal";
import BinSheetPrintModal from "./BinSheetPrintModal";
import { useLabelConfig } from "./useLabelConfig";
import { buildBinSheetsHtml, groupIntoBins } from "../../utils/barcodeRender";
import { splitLocation } from "../../lib/inventory.js";
import { countSheets, printBinSheetsHtml, sheetsWord } from "./binSheetPrint.js";

// Bin location sheets for the bins the store PICKS — one bin, a few, or every
// bin of a rack. The store asked (17 Oct 2026) for bin-wise tags — "location qr
// me bin wise bhi tag nikalne ka option add kar de": a new bin, or a torn /
// faded sheet, needs just its own tag — and then said how to pick one: "rack k
// ander se bin chunna h jaise R4 me B5" — the RACK first, then the BIN inside
// it. So: Section ▼ -> Rack ▼ -> Bins ▼ (tick one or more, or "All bins of this
// rack"). What is chosen collects as chips below, so bins of another rack or
// another section can be added too; Preview shows exactly those sheets, Print
// sends them.
//
// The bins are the store's stock list grouped exactly the way the sheets are
// printed (groupIntoBins): a bin is SECTION + base location — the same rack
// number is a different physical rack in another section — and partitions
// "R4-S1-B5(1)", "(2)" are one bin, one sheet. A part with a New and a Rework
// location sits in both its bins. A part with no location has no bin, so it
// is not listed, only counted.
//
//   <BinPickerModal parts={[ the whole store, same shape as BinSheetPrintModal's parts ]}
//                   initialSection? initialRack? config? onClose />

const NO_LOCATION = "(no location)";            // groupIntoBins' bin for parts without one
// R2 before R10, B5 before B12. One shared collator: localeCompare with options
// builds a new one per call, and sorting ~1,300 bins that way took seconds.
const collator = new Intl.Collator(undefined, { numeric: true });
const byText = (a, b) => collator.compare(String(a ?? ""), String(b ?? ""));
const exact = (a, b) => (a < b ? -1 : a > b ? 1 : 0);   // tie-break: plain code-unit order
const norm = (s) => String(s || "").toUpperCase().replace(/\s+/g, "");
const fmt = (n) => Number(n || 0).toLocaleString("en-IN");
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

// Where a bin sits: "R4-S1-B5" -> rack "R4", shelf "S1", bin "B5". After the
// rack the location is split at its shelf ("S1", a bare "S", a doubled dash
// "R12--S7" as typed); the rest is the bin ("B5", "B6 & 7", "B5-29&30"). A rack
// place with no bin ("R9-S12") is listed by its shelf. Free text ("OLD STORE",
// "TEMP", "ABS PIPE  RACK" — about 700 parts on 17 Oct 2026) is an area of its
// own: a "rack" whose one bin is that text.
function rackPlace(base) {
  const { rack, bin: rest } = splitLocation(base);
  if (!rack || !/^R\d+$/i.test(rack)) return { rack: base, numbered: false, shelf: null, binNo: base };
  const name = rack.toUpperCase();
  if (rest == null) return { rack: name, numbered: true, shelf: null, binNo: base };
  const m = rest.match(/^[-\s]*(S\s*\d*)\s*-+\s*(.+)$/i);
  if (m) return { rack: name, numbered: true, shelf: m[1].replace(/\s+/g, "").toUpperCase(), binNo: m[2].trim() };
  return { rack: name, numbered: true, shelf: null, binNo: rest.replace(/^[-\s]+/, "") || base };
}

// A bin's name in its rack: "B5" — or "B5 · S1", "B5 · S4"… when the rack has a
// bin B5 on more than one shelf (R1 has B5 on eight shelves; 21 such cases on 17
// Oct 2026), each its own sheet. Two places that still read alike (a typed
// "R12--S7-B43" beside "R12-S7-B43") show their full location.
function labelBins(list) {
  const tally = (keyOf) => {
    const m = new Map();
    list.forEach((b) => m.set(keyOf(b), (m.get(keyOf(b)) || 0) + 1));
    return m;
  };
  const byNo = tally((b) => norm(b.binNo));
  // A bin typed without its number ("R1-S11-B(4)") reads "B · S11", not a bare "B".
  const withShelf = (b) => byNo.get(norm(b.binNo)) > 1 || (b.shelf && !/\d/.test(b.binNo));
  list.forEach((b) => { b.label = withShelf(b) ? `${b.binNo} · ${b.shelf || "no shelf"}` : b.binNo; });
  const byLabel = tally((b) => norm(b.label));
  list.forEach((b) => { if (byLabel.get(norm(b.label)) > 1) b.label = b.base; });
}

// Sections -> racks (R1, R2 … R14 in number order, then the named areas) ->
// bins (B1, B2 … in number order), plus the flat list of every bin in that
// order — the order the chosen sheets print in.
function buildModel(parts) {
  const secs = new Map();
  let noLocation = 0;
  groupIntoBins(parts).forEach((b) => {
    if (b.base === NO_LOCATION) { noLocation += b.rows.length; return; }
    const sec = b.section_id == null ? "none" : String(b.section_id);
    const secName = b.section_name || (b.section_id == null ? "No section" : `Section ${b.section_id}`);
    const place = rackPlace(b.base);
    if (!secs.has(sec)) secs.set(sec, { value: sec, name: secName, binCount: 0, rackMap: new Map() });
    const s = secs.get(sec);
    s.binCount += 1;
    const rackKey = `${sec}||${place.rack}`;
    if (!s.rackMap.has(place.rack)) {
      s.rackMap.set(place.rack, { key: rackKey, sec, secName, name: place.rack, numbered: place.numbered, bins: [] });
    }
    s.rackMap.get(place.rack).bins.push({
      ...b, key: `${b.section_id ?? ""}||${b.base}`, sec, secName, rackKey,
      rack: place.rack, numbered: place.numbered, shelf: place.shelf, binNo: place.binNo, label: place.binNo,
    });
  });
  const racksByKey = new Map();
  const bins = [];
  const sections = Array.from(secs.values())
    .sort((a, b) => byText(a.name, b.name) || exact(a.value, b.value))
    .map(({ rackMap, ...s }) => {
      const racks = Array.from(rackMap.values()).sort((a, b) =>
        (a.numbered === b.numbered ? 0 : a.numbered ? -1 : 1) || byText(a.name, b.name) || exact(a.name, b.name));
      racks.forEach((r) => {
        r.bins.sort((a, b) => byText(a.binNo, b.binNo) || byText(a.shelf, b.shelf) || exact(a.base, b.base));
        labelBins(r.bins);
        r.parts = r.bins.reduce((n, b) => n + b.rows.length, 0);
        racksByKey.set(r.key, r);
        bins.push(...r.bins);
      });
      return { ...s, racks };
    });
  return { sections, racksByKey, bins, noLocation };
}

// The section to start in: the page's own section filter if it has bins, else
// the one holding the page's rack filter, else the biggest.
function startSection(model, initialSection, initialRack) {
  if (model.sections.some((s) => s.value === initialSection)) return initialSection;
  const biggest = [...model.sections].sort((a, b) => b.binCount - a.binCount);
  const withRack = initialRack && biggest.find((s) => model.racksByKey.has(`${s.value}||${initialRack}`));
  return (withRack || biggest[0])?.value || "";
}

// A chosen bin as the store reads it: "R4 · B5", "R1 · B5 · S4", "OLD STORE".
const binName = (b) => (!b.numbered || b.label === b.base ? b.base : `${b.rack} · ${b.label}`);

export default function BinPickerModal({ parts, initialSection = "", initialRack = "", config: configProp, onClose }) {
  const { config, ready: configReady } = useLabelConfig({ config: configProp });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => onCloseRef.current?.(), []);

  const model = useMemo(() => buildModel(parts), [parts]);
  const { sections, racksByKey } = model;
  const [section, setSection] = useState(() => startSection(model, initialSection, initialRack));
  const [rackName, setRackName] = useState(initialRack || "");
  const [picked, setPicked] = useState(() => new Set());
  const [binsOpen, setBinsOpen] = useState(false);
  const [binQuery, setBinQuery] = useState("");
  const [printing, setPrinting] = useState(false);
  const [printed, setPrinted] = useState(null);       // { n, bins } — the last job sent from here

  const sec = sections.find((s) => s.value === section) || null;
  const rack = (sec && racksByKey.get(`${sec.value}||${rackName}`)) || null;

  const pickRef = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const focusPanel = useRef(false);
  const panelId = useId();

  const toggleBin = useCallback((key) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  }), []);
  // "All bins of this rack" — of THIS section's rack only.
  const setRackAll = useCallback((r, on) => setPicked((prev) => {
    const next = new Set(prev);
    r.bins.forEach((b) => (on ? next.add(b.key) : next.delete(b.key)));
    return next;
  }), []);

  const openBins = () => { focusPanel.current = true; setBinsOpen(true); };
  const closeBins = (refocus) => {
    setBinsOpen(false);
    if (refocus) triggerRef.current?.focus();
  };
  // Opened by the store (click / Enter): focus goes into the list. The list is
  // part of the dialog, so a click elsewhere in the dialog closes it like a
  // dropdown — on the CLICK, not the press: the list sits in the page, and
  // closing it on the press would move Preview / Print from under the finger
  // before the click lands. Escape closes the list, not the whole dialog.
  useEffect(() => {
    if (!binsOpen || !focusPanel.current) return;
    focusPanel.current = false;
    panelRef.current?.querySelector("input")?.focus();
  }, [binsOpen]);
  useEffect(() => {
    if (!binsOpen) return undefined;
    const onClick = (e) => {
      // A target the click itself re-drew away is not "elsewhere".
      if (e.target.isConnected && pickRef.current && !pickRef.current.contains(e.target)) setBinsOpen(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [binsOpen]);
  const onPickKeyDown = (e) => {
    if (e.key === "Escape" && binsOpen) {
      e.stopPropagation();
      closeBins(true);
    }
  };

  // Every chosen bin, in rack / bin order — the order the sheets print in.
  const chosen = useMemo(() => model.bins.filter((b) => picked.has(b.key)), [model, picked]);
  const partCount = useMemo(
    () => new Set(chosen.flatMap((b) => b.rows.map((r) => r.part_id ?? r.part_no))).size, [chosen]);

  // Sheets per bin key, for THIS label config (a new size is a new count), read
  // off each bin's own print document (countSheets) — a crowded bin's (1/2),
  // (2/2) are two. That draws every part's QR (~10 ms a bin), so it runs in the
  // background, a slice at a time, and only for the chosen bins. Each bin prints
  // the same on its own as in the whole job, so the sum is the job's page count.
  const counts = useMemo(() => ({ config, byBin: new Map() }), [config]);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!configReady) return undefined;
    const todo = chosen.filter((b) => !counts.byBin.has(b.key));
    if (!todo.length) return undefined;
    let i = 0;
    let timer = 0;
    let shownAt = performance.now();
    const run = () => {
      const until = performance.now() + 30;               // a slice, then let the screen breathe
      while (i < todo.length && performance.now() < until) {
        const b = todo[i++];
        if (!counts.byBin.has(b.key)) counts.byBin.set(b.key, countSheets(buildBinSheetsHtml([b], counts.config)) || 1);
      }
      if (i >= todo.length || performance.now() - shownAt > 250) {
        shownAt = performance.now();
        setTick((t) => t + 1);
      }
      if (i < todo.length) timer = setTimeout(run, 0);
    };
    timer = setTimeout(run, 0);
    return () => clearTimeout(timer);
  }, [chosen, configReady, counts]);

  let sheets = 0;
  let pending = 0;
  const crowded = [];
  chosen.forEach((b) => {
    const c = counts.byBin.get(b.key);
    if (c == null) { pending += 1; return; }
    sheets += c;
    if (c > 1) crowded.push({ bin: b, n: c });
  });
  const counted = chosen.length > 0 && !pending;

  // The chips: a fully chosen rack is ONE chip ("R4 · all 80 bins"), otherwise
  // one per bin. The section shows when the bins span more than one.
  const multiSection = new Set(chosen.map((b) => b.sec)).size > 1;
  const pickedByRack = new Map();
  chosen.forEach((b) => {
    if (!pickedByRack.has(b.rackKey)) pickedByRack.set(b.rackKey, []);
    pickedByRack.get(b.rackKey).push(b);
  });
  const chips = [];
  pickedByRack.forEach((list, rackKey) => {
    const r = racksByKey.get(rackKey);
    const secName = multiSection ? r.secName : "";
    if (r.bins.length > 1 && list.length === r.bins.length) {
      chips.push({ id: `rack:${rackKey}`, text: `${r.name} · all ${fmt(r.bins.length)} bins`, secName, rack: r });
    } else {
      list.forEach((b) => chips.push({ id: b.key, text: binName(b), secName, bin: b }));
    }
  });
  const removeChip = (c) => (c.rack ? setRackAll(c.rack, false) : toggleBin(c.bin.key));

  const printNow = () => {
    if (!chosen.length || !configReady) return;
    // The whole job, drawn now; its pages are what the toast reports.
    const n = printBinSheetsHtml(buildBinSheetsHtml(chosen, config), chosen.length);
    setPrinted({ n, bins: chosen });
  };

  if (printing) {
    return (
      <BinSheetPrintModal bins={chosen} sheetsByBin={counts.byBin} config={config} onClose={close}
        onBack={() => setPrinting(false)} />
    );
  }

  const rackPicked = rack ? rack.bins.filter((b) => picked.has(b.key)) : [];
  const rackState = !rack || !rackPicked.length ? "none" : rackPicked.length === rack.bins.length ? "all" : "some";
  const triggerText = !rack ? (sec ? "Choose a rack first" : "—")
    : !rackPicked.length ? `Choose bins (${fmt(rack.bins.length)})`
      : rackState === "all" && rack.bins.length > 1 ? `All ${fmt(rack.bins.length)} bins`
        : rackPicked.slice(0, 3).map((b) => b.label).join(", ") + (rackPicked.length > 3 ? ` +${rackPicked.length - 3}` : "");
  const q = norm(binQuery);
  const shownBins = rack ? rack.bins.filter((b) => !q || norm(b.label).includes(q) || norm(b.base).includes(q)) : [];
  const numberedRacks = sec ? sec.racks.filter((r) => r.numbered) : [];
  const namedAreas = sec ? sec.racks.filter((r) => !r.numbered) : [];
  const chosenIn = (r) => (pickedByRack.get(r.key) || []).length;
  const chosenInSec = (s) => chosen.reduce((n, b) => n + (b.sec === s.value ? 1 : 0), 0);

  const footer = (
    <>
      <span className="mr-auto self-center text-xs text-slate-600 dark:text-slate-300" aria-live="polite">
        {!chosen.length ? "No bin chosen yet" : (
          <>
            <b className="tabular">{counted ? sheetsWord(sheets) : "Counting sheets…"}</b>
            {" · "}
            <span className="tabular">{plural(partCount, "part", "parts")}</span>
            {counted && sheets !== chosen.length && (
              <span className="text-slate-400"> · {plural(chosen.length, "bin", "bins")}</span>
            )}
          </>
        )}
      </span>
      <button type="button" className="btn-secondary" onClick={close}>Cancel</button>
      <button type="button" className="btn-secondary disabled:cursor-not-allowed disabled:opacity-50"
        onClick={() => setPrinting(true)} disabled={!chosen.length}>
        <Eye size={16} aria-hidden="true" /> Preview
      </button>
      <button type="button" className="btn-primary disabled:cursor-not-allowed disabled:opacity-50"
        onClick={printNow} disabled={!counted || !configReady}>
        <Printer size={16} aria-hidden="true" /> {chosen.length && !counted ? "Counting…" : `Print ${counted ? sheetsWord(sheets) : ""}`.trim()}
      </button>
    </>
  );

  return (
    <Modal open size="xl" onClose={close} title="Print bin sheets — rack / bin" footer={footer}>
      <div className="space-y-4">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Choose the section, then the rack, then its bins — e.g. R4 → B5. Each bin prints one laminated sheet. Add
          bins from other racks or sections the same way; everything chosen is listed below until you print.
        </p>

        {sections.length ? (
          <div ref={pickRef} className="space-y-2" onKeyDown={onPickKeyDown}>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="block min-w-0">
                <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">1 · Section</span>
                <select value={sec ? sec.value : ""} className="input-field w-full py-1.5 text-[13px]"
                  onChange={(e) => { setSection(e.target.value); setRackName(""); setBinQuery(""); setBinsOpen(false); }}>
                  {sections.map((s) => {
                    const n = chosenInSec(s);
                    return (
                      <option key={s.value} value={s.value}>
                        {s.name}{n ? ` · ${fmt(n)} chosen` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
              <label className="block min-w-0">
                <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300">2 · Rack</span>
                <select value={rack ? rack.name : ""} className="input-field w-full py-1.5 text-[13px]"
                  onChange={(e) => { setRackName(e.target.value); setBinQuery(""); }}>
                  <option value="">Choose a rack…</option>
                  {numberedRacks.length > 0 && (
                    <optgroup label="Racks">
                      {numberedRacks.map((r) => (
                        <option key={r.key} value={r.name}>
                          {r.name} — {plural(r.bins.length, "bin", "bins")}{chosenIn(r) ? ` · ${fmt(chosenIn(r))} chosen` : ""}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {namedAreas.length > 0 && (
                    <optgroup label="Other areas (no rack number)">
                      {namedAreas.map((r) => (
                        <option key={r.key} value={r.name}>
                          {r.name} — {plural(r.parts, "part", "parts")}{chosenIn(r) ? " · chosen" : ""}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
              <div className="min-w-0">
                <span className="mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300" aria-hidden="true">3 · Bins</span>
                <button ref={triggerRef} type="button" disabled={!rack}
                  aria-expanded={binsOpen && Boolean(rack)} aria-controls={panelId}
                  aria-label={`Bins${rack ? ` of rack ${rack.name}` : ""}: ${triggerText}`}
                  onClick={() => (binsOpen ? closeBins(false) : openBins())}
                  className="input-field flex w-full items-center justify-between gap-2 py-1.5 text-left text-[13px] disabled:cursor-not-allowed disabled:opacity-50">
                  <span className={`min-w-0 truncate ${rackPicked.length ? "font-medium text-slate-800 dark:text-white" : "text-slate-500 dark:text-slate-400"}`}>
                    {triggerText}
                  </span>
                  <ChevronDown size={15} aria-hidden="true"
                    className={`shrink-0 text-slate-400 transition-transform ${binsOpen && rack ? "rotate-180" : ""}`} />
                </button>
              </div>
            </div>

            <AllBinsBox rack={rack} state={rackState} onChange={(on) => rack && setRackAll(rack, on)} />

            {binsOpen && rack && (
              <div id={panelId} ref={panelRef} role="group" aria-label={`Bins of rack ${rack.name}, ${rack.secName}`}
                className="rounded-lg border border-slate-200 bg-white p-2 shadow-sm dark:border-navy-700 dark:bg-navy-900">
                {rack.bins.length > 12 && (
                  <label className="relative mb-2 block">
                    <span className="sr-only">Find a bin</span>
                    <Search size={15} aria-hidden="true"
                      className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                    <input type="search" value={binQuery} onChange={(e) => setBinQuery(e.target.value)}
                      placeholder="Find a bin — B5, S3…" className="input-field py-1.5 pl-8 text-[13px]" />
                  </label>
                )}
                {shownBins.length ? (
                  <ul className="grid max-h-64 grid-cols-2 gap-1.5 overflow-y-auto overscroll-contain p-0.5 sm:grid-cols-3 md:grid-cols-4">
                    {shownBins.map((b) => (
                      <BinOption key={b.key} bin={b} checked={picked.has(b.key)} onToggle={toggleBin} />
                    ))}
                  </ul>
                ) : (
                  <p className="px-2 py-4 text-center text-sm text-slate-400">No bin of {rack.name} matches “{binQuery.trim()}”</p>
                )}
                <div className="mt-2 flex justify-end">
                  <button type="button" className="btn-secondary py-1 text-[13px]" onClick={() => closeBins(true)}>Done</button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="rounded-lg border border-slate-200 px-3 py-6 text-center text-sm text-slate-400 dark:border-navy-800">
            No part in this store has a rack location yet
          </p>
        )}

        <section aria-label="Chosen bins" className="rounded-lg border border-slate-200 p-3 dark:border-navy-800">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              Chosen · {plural(chosen.length, "bin", "bins")}
            </h4>
            {chosen.length > 0 && (
              <button type="button" onClick={() => setPicked(new Set())}
                className="text-xs font-medium text-slate-500 hover:text-toyotared">
                Clear all
              </button>
            )}
          </div>
          {chips.length ? (
            <ul className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
              {chips.map((c) => (
                <li key={c.id} className="inline-flex max-w-full items-center gap-1 rounded-full border border-toyotared/30 bg-toyotared/[0.06] py-0.5 pl-2.5 pr-1 text-xs text-slate-700 dark:text-slate-200">
                  <span className="min-w-0 truncate">
                    <b className="font-semibold">{c.text}</b>
                    {c.secName ? <span className="text-slate-500 dark:text-slate-400"> · {c.secName}</span> : null}
                  </span>
                  <button type="button" onClick={() => removeChip(c)}
                    aria-label={`Remove ${c.text}${c.secName ? ` (${c.secName})` : ""}`}
                    className="shrink-0 rounded-full p-0.5 text-slate-400 hover:bg-toyotared/10 hover:text-toyotared focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-toyotared/40">
                    <X size={13} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-slate-400">
              Nothing yet — pick a rack and tick its bins.
            </p>
          )}
          {counted && crowded.length > 0 && (
            <p className="mt-2 text-[11px] text-slate-500 dark:text-slate-400">
              {crowded.length === 1
                ? `${binName(crowded[0].bin)} holds ${plural(crowded[0].bin.rows.length, "part", "parts")}, so it prints on ${crowded[0].n} sheets — (1/${crowded[0].n})${crowded[0].n > 2 ? " … " : " and "}(${crowded[0].n}/${crowded[0].n}) — and each counts as a sheet.`
                : `${crowded.length} crowded bins run onto more than one sheet each — (1/2), (2/2)… — and each page counts as a sheet.`}
            </p>
          )}
        </section>

        {model.noLocation > 0 && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            <TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              {plural(model.noLocation, "part has", "parts have")} no rack location, so no bin sheet — they are not
              listed. Set their location first (Store Stock filter “No Location”).
            </span>
          </div>
        )}
        {chosen.length > 200 && (
          <p className="text-[11px] text-slate-400">
            A big job: the sheets are drawn when you press Print or Preview, so it takes a little while to open.
          </p>
        )}
        {printed && printed.bins === chosen && (
          <div className="flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
            <CircleCheckBig size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              {sheetsWord(printed.n)} sent to the print dialog. Check every sheet came out and the QRs are sharp
              before laminating.
            </span>
          </div>
        )}
      </div>
    </Modal>
  );
}

// "All bins of this rack" — ticks every bin of the chosen rack (in its section);
// half-ticked when only some are chosen; unticked again drops them all.
function AllBinsBox({ rack, state, onChange }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = state === "some"; }, [state]);
  return (
    <label className={`flex items-center gap-2 text-sm ${rack ? "cursor-pointer text-slate-700 dark:text-slate-200" : "cursor-not-allowed text-slate-400"}`}>
      <input ref={ref} type="checkbox" disabled={!rack} checked={state === "all"}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 shrink-0 cursor-pointer accent-toyotared disabled:cursor-not-allowed" />
      <span className="min-w-0">
        All bins of this rack
        {rack && (
          <span className="ml-1 text-xs text-slate-500 dark:text-slate-400">
            ({rack.name} · {plural(rack.bins.length, "bin", "bins")} · {rack.secName})
          </span>
        )}
      </span>
    </label>
  );
}

const BinOption = memo(function BinOption({ bin, checked, onToggle }) {
  return (
    <li className="min-w-0">
      <label title={`${bin.base} — ${plural(bin.rows.length, "part", "parts")}`}
        className={`flex h-full cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 ${checked
          ? "border-toyotared/50 bg-toyotared/[0.06]"
          : "border-slate-200 hover:border-slate-300 dark:border-navy-700 dark:hover:border-navy-600"}`}>
        <input type="checkbox" checked={checked} onChange={() => onToggle(bin.key)}
          className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-toyotared" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{bin.label}</span>
          <span className="block text-[11px] text-slate-500 dark:text-slate-400">{plural(bin.rows.length, "part", "parts")}</span>
        </span>
      </label>
    </li>
  );
});
